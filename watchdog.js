/**
 * Hermes 桌面控制台 — 网关看门狗
 *
 * 仅由主进程在【已取得已验证所有权】时派生，且只在控制台进程消失后行动。
 * 用同一个 Electron 二进制以纯 Node 模式运行（ELECTRON_RUN_AS_NODE=1），
 * 不需要额外运行时。
 *
 * ─────────────────── 与主进程的规则一致性（安全复审问题四）───────────────────
 * 本文件**不再自带**身份读取/比较逻辑。旧实现复制了一份更宽松的副本
 * （readJson 把"文件损坏"与"文件缺失"混同、startMs 缺失时跳过校验），
 * 导致看门狗可能在主进程会拒绝的情况下放行停止。
 *
 * 现在统一 `require('./ownership')` 与 `require('./process-probe')`：
 *   · 身份读取      → own.readIdentity
 *   · 停止前置核验  → own.preflightStop（与主进程同一函数）
 *   · OS 进程核对   → probe.buildVerifyContext（存在性 + 实际创建时间 + 单实例）
 *
 * ─────────────────── 长期运行（安全复审第二轮 问题二）───────────────────
 * 旧实现在 12 小时处**静默 return 0** 直接退出。后果：
 *   控制台仍然开着（用户可能连续工作数天），但看门狗已消失 →
 *   此后若控制台崩溃，网关将无人收尾，而**没有任何提示** —— 保护无声失效。
 *
 * 新机制：观察周期 + 交接（handoff）
 *   1. 每个看门狗进程只负责**一个观察周期**（WATCH_CYCLE_MS，默认 6 小时）。
 *   2. 周期到点时**不退出**，而是派生一个后继看门狗，并**等待后继确认接管**
 *      （后继把自己的 pid 写入单槽锁文件）；确认后才释放锁并退出。
 *      → 保护在时间上连续，不存在断点。
 *   3. 交接失败（最多 HANDOFF_MAX_ATTEMPTS 次）→ **继续自行监视，绝不退出**。
 *      宁可多活一轮，也不留下无保护的窗口。
 *   4. 每次周期切换都写日志（"已交接给后继 pid=… generation=…"），
 *      并在锁文件里维护心跳 lastBeatMs —— 保护状态**可被外部观察**，不是隐式的。
 *
 * 资源上界（避免无界消耗）：
 *   · 同一时刻**只有一个**看门狗监视同一控制台 —— 单槽锁 (--lock) + 存活检查；
 *     只有携带 --handoff-from=<前驱 pid> 的后继才允许在前驱仍存活时接管。
 *   · 日志只在周期切换/交接/最终判决时写入（每周期 O(1) 行）。
 *   · 锁文件为单一小 JSON，心跳按 HEARTBEAT_MS（60 秒）覆写，不追加。
 *   · 轮询间隔 POLL_MS（2 秒）固定 —— 单进程常量级开销，不随时间增长。
 *   · 控制台一旦释放所有权（记录文件被删除），看门狗立即结束，不再空转。
 *
 * ─────────────────── 自动停止当前禁用（安全复审第二轮 问题三）───────────────────
 * 官方 `hermes gateway stop` 是 **profile 级**操作（无 PID 参数），
 * 检查与执行之间存在**无法消除的竞态**：核验通过的瞬间到命令真正执行之间，
 * 同 profile 可能新出现另一个实例，而 stop 会把它一并停掉。
 * 因此本看门狗**默认不执行停止**，只有显式传入 `--allow-stop 1` 才允许；
 * 主进程在自动停止通过真实端到端验收前不会传该参数。
 * 默认行为 = 只观察、只记录（含"身份核验会通过，但自动停止被禁用"的审计信息），
 * 绝不调用 stop。
 *
 * 安全：不按进程名批量杀进程；不读任何凭据；不记录任何 token。
 */

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const own = require('./ownership')
const probe = require('./process-probe')

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]
  }
  return out
}

/** 单个看门狗进程负责的观察周期（到点交接给后继，不静默退出） */
const WATCH_CYCLE_MS = 6 * 60 * 60 * 1000
/** 控制台存活检查间隔 */
const POLL_MS = 2000
/** 锁文件心跳写入间隔 */
const HEARTBEAT_MS = 60 * 1000
/** 交接确认最长等待 */
const HANDOFF_WAIT_MS = 30000
/** 单周期内最多尝试交接次数；用尽后继续自行监视（不退出） */
const HANDOFF_MAX_ATTEMPTS = 3
/** 记录文件连续多少次探测不到才判定"已被清理"（防杀软瞬时时序抖动导致误退出） */
const RECORD_MISS_TOLERANCE = 3

let LOG_PATH = null
function logLine(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] [watchdog pid=${process.pid}] ${msg}`
  try {
    if (LOG_PATH) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
      fs.appendFileSync(LOG_PATH, line + '\n', 'utf8')
    }
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function isAlive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function readJsonFile(p) {
  try {
    if (!p || !fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) { logLine(`读取 ${p} 失败: ${err.message}`); return null }
}

function resolveHermesExe(home) {
  const c = [
    path.join(home, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    path.join(home, 'bin', 'hermes.exe')
  ]
  for (const p of c) { try { if (fs.existsSync(p)) return p } catch {} }
  return 'hermes'
}

// ---------------------------------------------------------------- 纯判定（可单测）

/**
 * 是否允许本进程启动（单槽锁：同一控制台只允许一个看门狗）。
 *
 * @param {object|null} lock        锁文件内容 { consolePid, pid, generation, ... }
 * @param {number} consolePid       本进程要监视的控制台 pid
 * @param {number} myPid            本进程 pid
 * @param {number|null} handoffFrom 前驱看门狗 pid（交接场景），无则 null
 * @returns {{ok:boolean, reason:string, takeOver?:boolean}}
 */
function decideStart(lock, consolePid, myPid, handoffFrom) {
  if (!lock) return { ok: true, reason: 'no-lock' }
  const lockPid = Number(lock.pid)
  // 锁属于别的控制台 → 与本进程无关（不同控制台各自一个看门狗）
  if (Number(lock.consolePid) !== Number(consolePid)) {
    return { ok: true, reason: 'lock-for-other-console' }
  }
  if (!lockPid || !isAlive(lockPid)) {
    // 自己的锁不算"陈旧"：重启语义下应先认出自己（顺序在存活检查之前）
    if (lockPid === myPid) return { ok: true, reason: 'own-lock' }
    return { ok: true, reason: 'stale-lock' }
  }
  if (lockPid === myPid) return { ok: true, reason: 'own-lock' }
  // 前驱仍存活：只有它是本次交接的来源时才允许接管
  if (handoffFrom && lockPid === Number(handoffFrom)) {
    return { ok: true, reason: 'handoff', takeOver: true }
  }
  return { ok: false, reason: 'another-watchdog-alive' }
}

/**
 * 周期到点后应当做什么。
 * @returns {{action:'watch'|'handoff'|'give-up-handoff', reason:string}}
 */
function decideCycleAction({ cycleElapsedMs, cycleMs = WATCH_CYCLE_MS, handoffAttempts = 0,
                             maxAttempts = HANDOFF_MAX_ATTEMPTS }) {
  if (cycleElapsedMs < cycleMs) return { action: 'watch', reason: 'cycle-not-elapsed' }
  if (handoffAttempts >= maxAttempts) {
    // 交接反复失败 → 继续自行监视（绝不退出，避免保护出现断点）
    return { action: 'give-up-handoff', reason: 'handoff-attempts-exhausted' }
  }
  return { action: 'handoff', reason: 'cycle-elapsed' }
}

/**
 * 所有权记录是否已可判定为"被清理"。
 * 只在控制台仍存活时才据此退出（控制台已死 → 走停止判决流程）。
 * @returns {{exit:boolean, reason:string}}
 */
function decideRecordGone({ misses, tolerance = RECORD_MISS_TOLERANCE, consoleAlive }) {
  if (consoleAlive) return { exit: false, reason: 'console-alive' }
  if (misses < tolerance) return { exit: false, reason: 'within-tolerance' }
  return { exit: true, reason: 'record-removed' }
}

/**
 * 看门狗是否应当执行停止。
 * 判定完全委托 ownership.preflightStop —— 与主进程**同一套规则**。
 *
 * 注意 allowStop：默认 false。此时本函数**永不**返回 act:true，
 * 但仍会完成身份核验并回报 identityOk，供审计（"本会通过，但自动停止被禁用"）。
 *
 * @returns {{act:boolean, reason:string, detail?:string, identityOk?:boolean}}
 */
function decideWatchdogStop({ record, consolePid, consoleAlive, current, ctx, allowStop = false }) {
  if (consoleAlive) return { act: false, reason: 'console-alive' }
  if (!record || !record.gateway) return { act: false, reason: 'no-record' }
  if (Number(record.consolePid) !== Number(consolePid)) {
    return { act: false, reason: 'record-mismatch' }
  }
  const pre = own.preflightStop({ owned: record.gateway, current, ctx })

  // 顺序很重要：**先回报精确的身份判决原因**，只有在"身份核验本会通过"时
  // 才把原因归结为开关禁用。否则 instance-changed / process-mismatch 等
  // 具体原因会被 auto-stop-disabled 掩盖，日志失去审计价值。
  if (!pre.ok) {
    return {
      act: false, reason: pre.reason, detail: pre.detail,
      identityOk: false, autoStopDisabled: !allowStop
    }
  }
  if (!allowStop) {
    return {
      act: false,
      reason: 'auto-stop-disabled',
      identityOk: true,
      autoStopDisabled: true,
      detail: '身份核验会通过，但自动停止能力当前被禁用（尚未通过真实端到端验收）'
    }
  }
  return { act: true, reason: 'verified', identityOk: true, autoStopDisabled: false }
}

/** 归类 gateway stop 的执行结果 */
function classifyStopResult(r) {
  if (!r) return { ok: false, reason: 'no-result' }
  if (r.code === 0) return { ok: true, reason: 'exit-0' }
  if (r.code === 124) return { ok: false, reason: 'timeout', detail: r.note }
  if (r.code === -1) return { ok: false, reason: 'spawn-failed', detail: r.note }
  return { ok: false, reason: 'nonzero-exit', detail: `code=${r.code} ${r.note || ''}`.trim() }
}

/** 停止后复查：是否确实已停（区分"目标已不在"与"换了别的实例"） */
function verifyStopped(after, expectedPid) {
  if (!after) return { stopped: true, reason: 'no-identity-present' }
  if (expectedPid != null && after.pid !== expectedPid) {
    return { stopped: true, reason: 'target-gone-other-instance', after }
  }
  return { stopped: false, reason: 'target-still-present', after }
}

// ---------------------------------------------------------------- 停止执行

function runStop(exe, home) {
  return new Promise(resolve => {
    let done = false
    const finish = (code, note) => { if (!done) { done = true; resolve({ code, note }) } }
    try {
      // 注意：不要把 cwd 设为 HERMES_HOME（它是目录符号链接，
      // 在重解析点下启动子进程在 Windows 上会静默失败）
      const child = spawn(exe, ['gateway', 'stop'], {
        env: { ...process.env, HERMES_HOME: home, PYTHONIOENCODING: 'utf-8', NODE_OPTIONS: '' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = '', err = ''
      child.stdout.on('data', b => { out += b.toString('utf8') })
      child.stderr.on('data', b => { err += b.toString('utf8') })
      child.on('error', e => finish(-1, `spawn error: ${e.message}`))
      child.on('close', code => finish(code, (out + err).trim().slice(0, 500)))
      setTimeout(() => {
        try { child.kill() } catch {}
        finish(124, 'timeout (60s)')
      }, 60000)
    } catch (e) {
      finish(-1, `exception: ${e.message}`)
    }
  })
}

// ---------------------------------------------------------------- 单槽锁（防看门狗累积）

let LOCK_PATH = null

function readLock() { return readJsonFile(LOCK_PATH) }

function writeLock(fields) {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true })
    fs.writeFileSync(LOCK_PATH, JSON.stringify(fields, null, 2), 'utf8')
    return true
  } catch (err) { logLine(`写入锁文件失败: ${err.message}`); return false }
}

/** 只释放属于自己的锁 —— 前驱退出时绝不能抹掉后继刚写下的条目 */
function releaseOwnLock() {
  try {
    const cur = readLock()
    if (cur && Number(cur.pid) === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch {}
}

// ---------------------------------------------------------------- 交接

/**
 * 派生后继看门狗并**等待其确认接管**。
 * 后继会把自身 pid 与 generation+1 写入锁文件；只有看到该条目才算成功。
 */
async function handoff({ exe, home, recordPath, consolePid, logPath, generation, cycleMs }) {
  const nextGen = generation + 1
  let child = null
  try {
    const args = [
      __filename,
      '--console-pid', String(consolePid),
      '--record', recordPath,
      '--hermes-home', home || '',
      '--log', logPath || '',
      '--lock', LOCK_PATH || '',
      '--generation', String(nextGen),
      '--handoff-from', String(process.pid),
      '--allow-stop', ALLOW_STOP ? '1' : '0'
    ]
    // 继承测试用周期覆盖（生产路径无该参数，走默认 WATCH_CYCLE_MS）
    if (cycleMs && cycleMs !== WATCH_CYCLE_MS) args.push('--cycle-ms', String(cycleMs))
    child = spawn(exe, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.unref()
  } catch (err) {
    logLine(`交接失败：后继派生异常 ${err.message}`)
    return false
  }

  const deadline = Date.now() + HANDOFF_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(500)
    const l = readLock()
    if (l && Number(l.pid) === child.pid && Number(l.generation) === nextGen) {
      logLine(`交接确认：后继 pid=${child.pid} generation=${nextGen} 已接管`)
      return true
    }
    if (!isAlive(child.pid)) {
      logLine(`交接失败：后继 pid=${child.pid} 已提前退出`)
      return false
    }
  }
  logLine(`交接失败：等待后继接管超时（${HANDOFF_WAIT_MS}ms），尝试结束后继 pid=${child.pid}`)
  try { child.kill() } catch {}
  return false
}

// ---------------------------------------------------------------- 主流程

let ALLOW_STOP = false

async function main() {
  const A = parseArgs(process.argv.slice(2))
  const CONSOLE_PID = Number(A['console-pid'])
  const RECORD_PATH = A['record']
  const HERMES_HOME = A['hermes-home']
  LOG_PATH = A['log']
  LOCK_PATH = A['lock'] || (LOG_PATH ? path.join(path.dirname(LOG_PATH), 'watchdog.lock.json') : null)
  const GENERATION = Number(A['generation'] || 1)
  const HANDOFF_FROM = A['handoff-from'] ? Number(A['handoff-from']) : null
  ALLOW_STOP = A['allow-stop'] === '1'

  // 观察周期可由 --cycle-ms 覆盖，**仅供自动化测试**（真实验收需要在秒级复现交接）。
  // 主进程不传该参数，生产路径始终是 WATCH_CYCLE_MS。
  const cycleMs = Number.isFinite(Number(A['cycle-ms'])) && Number(A['cycle-ms']) > 0
    ? Number(A['cycle-ms'])
    : WATCH_CYCLE_MS

  logLine(`启动 generation=${GENERATION} 监视控制台 pid=${CONSOLE_PID} record=${RECORD_PATH}` +
          ` 自动停止=${ALLOW_STOP ? '已启用' : '已禁用'} 观察周期=${Math.round(cycleMs / 60000)}分钟`)

  // ---- 单槽锁：同一控制台只允许一个看门狗 ----
  if (LOCK_PATH) {
    const d = decideStart(readLock(), CONSOLE_PID, process.pid, HANDOFF_FROM)
    if (!d.ok) {
      logLine(`拒绝启动：${d.reason}（已有看门狗在监视同一控制台，本进程退出，不重复派生）`)
      return 0
    }
    writeLock({
      consolePid: CONSOLE_PID, pid: process.pid, generation: GENERATION,
      startedAt: new Date().toISOString(), lastBeatMs: Date.now()
    })
  }

  // 后继看门狗用同一份可执行文件（纯 Node 模式）；真正的 hermes.exe 只在 runStop 时解析
  const watchExe = process.execPath

  let cycleStart = Date.now()
  let handoffAttempts = 0
  let recordMisses = 0
  let lastBeat = Date.now()

  for (;;) {
    const consoleAlive = isAlive(CONSOLE_PID)

    // ---- 心跳（可被外部观察，避免"隐式失效"）----
    if (LOCK_PATH && Date.now() - lastBeat > HEARTBEAT_MS) {
      const l = readLock()
      if (l && Number(l.pid) === process.pid) {
        l.lastBeatMs = Date.now()
        writeLock(l)
      }
      lastBeat = Date.now()
    }

    // ---- 控制台仍存活：检查记录是否已被清理（释放所有权 → 无需继续监视）----
    if (consoleAlive) {
      const hasRecord = !!(RECORD_PATH && fs.existsSync(RECORD_PATH))
      recordMisses = hasRecord ? 0 : recordMisses + 1
      const g = decideRecordGone({ misses: recordMisses, consoleAlive })
      if (g.exit) {
        logLine('所有权记录已被清理（控制台已释放所有权）→ 结束监视，不做任何停止')
        releaseOwnLock()
        return 0
      }
    }

    // ---- 周期到点：交接，而不是退出 ----
    const cyc = decideCycleAction({
      cycleElapsedMs: Date.now() - cycleStart,
      cycleMs,
      handoffAttempts,
      maxAttempts: HANDOFF_MAX_ATTEMPTS
    })

    if (cyc.action === 'handoff') {
      handoffAttempts += 1
      logLine(`观察周期已到（第 ${handoffAttempts} 次尝试交接）`)
      const ok = await handoff({
        exe: watchExe, home: HERMES_HOME, recordPath: RECORD_PATH,
        consolePid: CONSOLE_PID, logPath: LOG_PATH, generation: GENERATION, cycleMs
      })
      if (ok) {
        releaseOwnLock()
        logLine('本进程结束（保护已无缝移交后继）')
        return 0
      }
      logLine('交接未成功 → 继续自行监视（不退出，避免出现无保护窗口）')
      cycleStart = Date.now()
      continue
    }

    if (cyc.action === 'give-up-handoff') {
      logLine(`交接尝试已达上限（${HANDOFF_MAX_ATTEMPTS} 次）→ 继续自行监视，不退出`)
      handoffAttempts = 0
      cycleStart = Date.now()
      continue
    }

    if (!consoleAlive) break
    await sleep(POLL_MS)
  }

  logLine('控制台进程已退出，开始核验')

  // 给正常退出流程一点时间（它会自行停止并清理记录）
  await sleep(1500)

  const record = readJsonFile(RECORD_PATH)
  const cur = own.readIdentity(HERMES_HOME)
  let ctx = { instanceCount: null, proc: null }
  try {
    ctx = await probe.buildVerifyContext(cur, { force: true })
  } catch (err) {
    logLine(`进程核对异常: ${err.message}`)
    ctx = { instanceCount: null, proc: null }
  }
  logLine(`当前身份: ${own.describeIdentity(cur)}；OS 核对: 实例数=${ctx.instanceCount} ` +
          `进程=${JSON.stringify(ctx.proc)}`)

  const d = decideWatchdogStop({
    record, consolePid: CONSOLE_PID, consoleAlive: false, current: cur, ctx, allowStop: ALLOW_STOP
  })

  if (!d.act) {
    logLine(`拒绝执行停止：原因=${d.reason}` + (d.detail ? ` 细节=${d.detail}` : ''))
    logLine('看门狗结束（未执行任何停止操作）')
    releaseOwnLock()
    return 0
  }

  logLine(`身份核验通过 ${own.describeIdentity(cur)} → 执行 hermes gateway stop`)
  const hermesExe = resolveHermesExe(HERMES_HOME)
  const r = await runStop(hermesExe, HERMES_HOME)
  const cls = classifyStopResult(r)
  logLine(`gateway stop 结果=${cls.reason}` + (cls.detail ? ` 细节=${cls.detail}` : ''))

  // 复查（单次，不重试 —— 失败即如实报告，不由看门狗反复尝试）
  await sleep(2500)
  const after = own.readIdentity(HERMES_HOME)
  const v = verifyStopped(after, cur && cur.pid)
  if (v.stopped) {
    logLine(`核验：目标实例已不在（${v.reason}）`)
  } else {
    logLine(`核验：目标仍存在 pid=${v.after.pid} —— 停止失败或超时，已如实报告，不重试`)
  }
  logLine('看门狗结束')
  releaseOwnLock()
  return cls.ok ? 0 : 1
}

module.exports = {
  // 纯判定（单测入口）
  decideWatchdogStop,
  decideCycleAction,
  decideRecordGone,
  decideStart,
  classifyStopResult,
  verifyStopped,
  main,
  // 常量
  WATCH_CYCLE_MS,
  POLL_MS,
  HEARTBEAT_MS,
  HANDOFF_WAIT_MS,
  HANDOFF_MAX_ATTEMPTS,
  RECORD_MISS_TOLERANCE
}

if (require.main === module) {
  main()
    .then(code => process.exit(code || 0))
    .catch(e => {
      logLine(`未捕获异常: ${e && e.message}`)
      process.exit(1)
    })
}
