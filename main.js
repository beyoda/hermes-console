/**
 * Hermes 桌面控制台 — Electron 主进程
 *
 * 设计原则：
 *  1. 复用官方能力：自身 spawn `hermes serve`，通过官方 HTTP API 拿真实数据；
 *     不解析 CLI 文本、不修改上游核心、不复制业务逻辑。
 *  2. 安全边界：renderer 无 Node 权限；所有网络与进程操作都在主进程，
 *     并且只允许访问白名单内的 API 路径（不存在任意 shell 执行通道）。
 *  3. 生命周期与所有权：本控制台只管理"自己拥有的"后端进程；
 *     网关默认按"共享服务"对待，是否在退出时停止由用户显式开关决定。
 */

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron')
const { spawn, execFile } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const own = require('./ownership')   // 纯逻辑模块：身份核验与授权门（可单测）
const probe = require('./process-probe')  // 操作系统进程核对（主进程与看门狗共用）
const auth = require('./auth')       // 纯逻辑模块：认证状态判定 + 官方命令构造（可单测）
const logsrc = require('./logsources') // 纯逻辑模块：多来源日志解析/折叠/脱敏（可单测）

// ---------------------------------------------------------------------------
// 路径解析（复用现有安装，不复制）
// ---------------------------------------------------------------------------
const APP_DIR = __dirname
const LOG_DIR = path.join(APP_DIR, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `console-${new Date().toISOString().slice(0, 10)}.log`)

/**
 * 日志脱敏 —— 纵深防御。
 * 本应用日志**绝不写入凭据值**（token / secret / 密码 / 密钥）。
 * 这里再加一层兜底：即使将来有人误加日志，值也会被过滤掉。
 * 保留对排查有用的信息：动作、时间、目标 PID、错误类型。
 *
 * 说明：用户名路径的脱敏放在**交付打包器**里做（那是"对外分享"的场景），
 * 本机日志保持路径可读，便于排障。
 */
const REDACT_RULES = [
  // 显式键值（token / secret / password / api_key …）
  [/(\b(?:token|secret|password|passwd|api[_-]?key|apikey|client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token|session[_-]?token|authorization)\b\s*[:=]\s*)(["']?)[A-Za-z0-9_\-\.\+\/=]{6,}\2/gi, '$1<redacted>'],
  // JWT 三段式
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}/g, '<redacted-jwt>'],
  // 常见前缀密钥
  [/\b(sk-[A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9\-]{8,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/g, '<redacted-key>']
]
function redact(s) {
  let t = String(s == null ? '' : s)
  for (const [rx, rep] of REDACT_RULES) t = t.replace(rx, rep)
  return t
}

function log(line) {
  const text = `[${new Date().toLocaleString('zh-CN')}] ${redact(line)}`
  try { fs.appendFileSync(LOG_FILE, text + os.EOL, 'utf8') } catch {}
  if (!app.isPackaged) console.log(text)
}

function resolveHermesHome() {
  if (process.env.HERMES_HOME && fs.existsSync(process.env.HERMES_HOME)) return process.env.HERMES_HOME
  const candidate = path.join(os.homedir(), 'AppData', 'Local', 'hermes')
  if (fs.existsSync(candidate)) return candidate
  return null
}

function resolveHermesExe(hermesHome) {
  const candidates = []
  if (hermesHome) {
    candidates.push(path.join(hermesHome, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'))
    candidates.push(path.join(hermesHome, 'bin', 'hermes.exe'))
  }
  for (const c of candidates) if (fs.existsSync(c)) return c
  return 'hermes' // 交给 PATH
}

const HERMES_HOME = resolveHermesHome()
const HERMES_EXE = resolveHermesExe(HERMES_HOME)

// ---------------------------------------------------------------------------
// 扩展能力目录（只读探测 + 「打开目录」入口）
//
//   可选外部工程目录（例如某个独立的音频处理工程）—— 它**不是** Hermes 的一部分，
//   控制台只做只读状态展示与目录入口，**不代其启动任何业务流水线**。
//   该目录**不写死**：由环境变量 HERMES_CONSOLE_EXTRA_DIR 显式指定，未设置即视为未安装。
//   额外 Profile（Hermes 的 profiles/ 子目录）会被自动发现，不做任何硬编码。
// 两者都只用于展示，任何启动/停止动作都不在控制台职责内。
// ---------------------------------------------------------------------------
const EXTERNAL_DIR = (process.env.HERMES_CONSOLE_EXTRA_DIR && fs.existsSync(process.env.HERMES_CONSOLE_EXTRA_DIR))
  ? process.env.HERMES_CONSOLE_EXTRA_DIR
  : null
// 外部工程的进程探测关键词同样来自环境变量；未设置即不做进程探测（状态显示为「未验证」）。
const EXTERNAL_PROC_HINT = process.env.HERMES_CONSOLE_EXTRA_PROC || null
const PROFILES_DIR = HERMES_HOME ? path.join(HERMES_HOME, 'profiles') : null

// 会话 token 仅存在于主进程内存，不写盘、不下发 renderer
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex')

// ---------------------------------------------------------------------------
// 运行时状态
//
// 所有权模型（严格区分 A / B / C）：
//   A 本控制台亲自启动、确认并持续持有的网关实例 → 退出时可自动停止
//   B 启动控制台前已存在的共享网关              → 永不自动停止
//   C 用户对共享服务的一次性明确授权            → 仅执行本次授权动作，不获得所有权
//
// 所有权不是布尔开关，而是「可核验的实例身份」：
//   { pid, startMs, hermesHome, argvHash, token }
// 危险操作前必须重新核验；核验不通过一律拒绝执行。
// ---------------------------------------------------------------------------
const state = {
  backend: null,          // hermes serve 子进程（本控制台拥有）
  port: null,
  backendState: 'idle',   // idle | starting | ready | failed | stopped
  backendError: null,
  startedAt: Date.now(),
  quitting: false,

  // B：启动控制台时观察到的既有网关身份（只记录，不据为己有）
  preExisting: null,
  // A：本控制台启动并持有的实例身份 —— **按 Profile 分槽**（各 Profile 互不覆盖）
  ownedByProfile: {},     // { [profileId]: identity }
  // C：一次性授权 { action, token, issuedAt, consumed }
  authorization: null,
  // 最近一次核验结果（供 UI 展示与审计）
  lastVerify: null,
  // 最近一次操作系统进程核对结果（真实值，非状态文件复述）
  lastProbe: null,
  // ★ 每个 Profile 最近一次**登记失败**的信息 { reason, message, at }（登记成功则清空）。
  //   用途：界面区分「本控制台启动但登记未成功」与「外部启动的共享实例（B 态）」。
  //   ⚠️ 必须在此初始化：getBootstrapInfo / gateway:status / getRuntimeServices 均会读取它。
  lastRegisterByProfile: {},
  // 看门狗进程（仅在有所有权时存在）
  watchdog: null
}

// 所有权/授权记录落盘路径（用于崩溃后恢复判定；不含任何凭据）
const OWNERSHIP_FILE = path.join(LOG_DIR, 'gateway-ownership.json')
// 看门狗单槽锁 + 心跳（同一控制台只允许一个看门狗；lastBeatMs 便于外部观察其存活）
const WATCHDOG_LOCK_FILE = path.join(LOG_DIR, 'watchdog.lock.json')

// ---------------------------------------------------------------------------
// ★ 自动停止开关 —— 当前**故意为 false**（安全复审第二轮 问题三）
//
// 官方 `hermes gateway stop` 是 **profile 级**操作，不接受 PID 参数
// （hermes_cli/gateway_windows.py:1584 附近的 stop 实现按 HERMES_HOME/profile 扫描并终止）。
// 因此「先核验身份 → 再执行 stop」之间存在**无法在本进程内消除的竞态**：
//   核验通过的那一刻到 stop 真正执行的短暂窗口内，若同 profile 新出现另一个网关实例，
//   官方 stop 会把它一并停掉 —— 我们**无法**阻止，也**无法**声称"只会停止目标实例"。
//
// 现有缓解（只能缩小窗口，不能消除）：
//   · 核验要求同 profile 实例数**恰好为 1**，数量未知或多于 1 一律拒绝
//   · 危险操作前强制**新鲜**进程探测（绕过 1.5s 缓存），把"检查→执行"窗口压到最小
//   · 不按进程名批量杀进程
//
// 由于上述保证不完整，且该自动停止路径**尚未通过真实端到端验收**
// （真实验收需中断飞书服务，需用户单独批准），故：
//   → 退出时自动停止、看门狗自动停止 **一律禁用**
//   → 保留完整核验与审计日志，但绝不调用 stop
//   → 只有用户在界面上显式确认（一次性授权）的手动操作才会真正执行
// ---------------------------------------------------------------------------
const ALLOW_AUTO_STOP = false

// ---------------------------------------------------------------------------
// ★ 统一危险操作闸门（最终完工轮 · 统一审计）
//
// 本轮**未授权**：停止 / 重启 / drain 真实 Gateway，接管（adopt）真实服务，强制 kill，
// 修改真实所有权记录，任何会中断飞书的真实端到端测试。
//
// 因此这里对**所有**危险入口（停止/重启/排空/接管，无论来自按钮、IPC 还是退出逻辑）
// 统一拒绝执行 —— 不是"只限制新开关"，而是从主进程入口一刀切。
// 执行路径仍保留在代码中（供未来通过真实端到端验收后开启），但当前恒为 false。
//
// 已安全实现、不属于危险操作的能力（保留可用）：
//   · 按 Profile 手动**启动** Gateway（gateway:startProfile，见下）
//   · 只读状态探测、日志、能力探测、目录入口
// ---------------------------------------------------------------------------
const ALLOW_DANGEROUS_EXEC = false

// ---------------------------------------------------------------------------
// ★ RC 轮新增：手动停止开关（用户 2026-09-21 明确授权的方案）
//
// 背景：上一轮关闭网关时暴露 —— 控制台无法手动停止网关，只能靠外部命令行。
// 经用户确认的放开范围：
//   · 仅放开「stop」；restart / drain / 接管仍在 ALLOW_DANGEROUS_EXEC=false 下拒绝；
//   · stop **仅限所有权 A 态**（本控制台亲自启动并持有的实例）；
//   · 共享实例（B 态）仍只读展示 + 说明原因，**不走一次性授权路径**；
//   · 身份核验复用授权门全套规则（fresh 探测 + 同 profile 单实例 + OS 进程核对），
//     看门狗与本入口使用同一套判定（ownership.js）。
//
// 剩余风险（如实声明）：官方 `hermes gateway stop` 为 profile 级、无 PID 参数，
// 授权门已把「检查时同 profile 多实例 / PID 复用」挡下，但检查与执行之间
// 仍存在无法彻底消除的竞态窗口（见 ownership.js::verifyTarget 的 residualRisk）。
// 执行层使用官方 CLI + 所有权记录反查 profile（**不接受渲染层指定目标**），
// 避免后端 /api/gateway/stop 只作用于 default home 而误停其它实例的问题。
// 该路径的真实端到端验收（真停一次控制台自启的网关）需用户在场批准后执行。
// ---------------------------------------------------------------------------
const ALLOW_OWNED_STOP = true

// ---------------------------------------------------------------------------
// 白名单：只允许这些 API 路径（防止 renderer 被利用为任意请求代理）
//
// 注意：网关的 start/stop/restart/drain **不在此处放行**。
// 它们是危险操作，必须经过主进程的授权门（authorizeDangerous）后才能调用，
// 不能由 renderer 直接 POST。
// ---------------------------------------------------------------------------
const ALLOWED_GET = [
  /^\/api\/status$/,
  /^\/api\/model\/info$/,
  /^\/api\/model\/options$/,
  /^\/api\/messaging\/platforms$/,
  /^\/api\/skills$/,
  /^\/api\/logs$/,
  /^\/api\/system\/stats$/,
  /^\/api\/providers\/oauth$/,
  /^\/api\/cron\/jobs$/,
  /^\/api\/ops\/doctor$/,
  /^\/api\/analytics\/usage$/
]
const ALLOWED_POST = [
  /^\/api\/skills\/toggle$/
]

// 危险操作：即使出现在白名单里也必须走授权门（这里是最后一道兜底）
const DANGEROUS_API = [
  /^\/api\/gateway\/(start|stop|restart|drain)$/
]

function isDangerousApi(apiPath) {
  return DANGEROUS_API.some(re => re.test(apiPath))
}

function isAllowed(method, apiPath) {
  // 危险接口永不由通用通道放行
  if (isDangerousApi(apiPath)) return false
  const list = method === 'POST' ? ALLOWED_POST : ALLOWED_GET
  return list.some(re => re.test(apiPath))
}

function apiUrl(apiPath, params) {
  const u = new URL(apiPath, `http://127.0.0.1:${state.port}`)
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
  }
  return u.toString()
}

async function callApi(method, apiPath, { params, body, timeoutMs = 30000, internal = false } = {}) {
  if (!state.port) throw new Error('后端尚未就绪')
  // internal=true 是【仅供主进程内部】的危险接口通道，调用前必须先通过
  // authorizeDangerous()。renderer 无法触达该参数。
  if (internal) {
    if (!isDangerousApi(apiPath)) throw new Error(`internal 通道仅用于危险接口: ${apiPath}`)
  } else if (!isAllowed(method, apiPath)) {
    throw new Error(`路径不在白名单内: ${method} ${apiPath}`)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(apiUrl(apiPath, params), {
      method,
      headers: {
        'X-Hermes-Session-Token': SESSION_TOKEN,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!res.ok) {
      const msg = (data && (data.detail || data.error || data.message)) || `HTTP ${res.status}`
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 网关实例身份与所有权核验
//
// 为什么需要身份而不仅是 PID：PID 会被操作系统复用。仅凭 PID 判定所有权，
// 在「网关退出 → PID 被别的进程复用」时会误判，进而误停无关进程。
// 因此身份 = PID + 启动时间(+ 轻量 argv 指纹 + HERMES_HOME)，并做双重校验。
// ---------------------------------------------------------------------------

function toStartMs(raw) { return own.toStartMs(raw) }

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    log(`读取 ${path.basename(p)} 失败: ${err.message}`)
    return null
  }
}

/**
 * 读取当前网关实例身份。
 * 判定逻辑位于 ownership.js（纯模块，可脱离 Electron 自动化测试）。
 * 读取失败（文件缺失 / 解析失败 / 两处 PID 不一致）返回 null
 * —— 调用方必须据此【拒绝】危险操作，而不是放行。
 */
function readGatewayIdentity() {
  const inst = own.readIdentity(HERMES_HOME)
  if (!inst) log('身份读取失败或不一致 → 视为不可信')
  return inst
}

/** 两个身份是否指同一实例（委托 ownership.js，便于单测） */
function sameInstance(a, b) { return own.sameIdentity(a, b) }

/**
 * 核验本控制台是否真的拥有当前运行的网关实例。
 *
 * 判定全部委托 ownership.js.preflightStop（主进程与看门狗共用同一套规则），
 * 本函数只负责两件事：
 *   1. 提供**操作系统层面**的核对上下文（进程是否存在 / 实际创建时间 / 同 profile 实例数）
 *      —— 不依赖可能陈旧的状态文件
 *   2. 在**确凿失权**时清理状态（暂时性探测失败不销毁所有权）
 *
 * 返回 { ok, reason, detail, instance, ctx }
 *
 * @param {{fresh?:boolean}} opts
 *   fresh=true → 强制新鲜进程探测（绕过缓存）。
 *   危险操作（stop/restart/drain）必须用 fresh=true，把"检查→执行"窗口压到最小。
 *   ⚠️ 即便如此也**不能消除**竞态：官方 stop 是 profile 级、无 PID 参数。
 */
// ---- 按 Profile 的所有权登记表（唯一真源）----
//  ⚠️ 各 Profile **各自独立**持有：启动/停止/释放都只作用于目标 Profile，
//     不会互相覆盖（旧实现是单槽 state.owned，启动另一个 Profile 会顶掉 default 的登记）。
function ownedOf (profileId) { return state.ownedByProfile[String(profileId)] || null }
function setOwned (profileId, inst) { state.ownedByProfile[String(profileId)] = inst }
function hasAnyOwned () { return Object.values(state.ownedByProfile).some(Boolean) }

/**
 * 带存活核验的所有权读取（同步、纯 OS 检查，不触发额外进程）。
 * 仅当「进程确凿存活 且 状态文件身份未漂移」才视为仍持有；否则释放该 Profile
 * 的所有权记录（实例已失效 → 持有无意义），返回 null。
 * 这保证了「网关被停止（无论由谁）后，控制台不会继续显示 A 态 / 启用停止按钮」。
 */
function liveOwnedOf (profileId) {
  const inst = ownedOf(profileId)
  if (!inst) return null
  const p = profileById(profileId)
  // 进程已确凿不存在（ESRCH）→ 失权并清除
  if (!pidAlive(inst.pid)) { releaseOwnership(profileId); return null }
  // 状态文件身份已漂移（PID 复用 / 实例被替换）→ 失权并清除
  const cur = p ? own.readIdentity(p.home) : null
  if (cur && !own.sameIdentity(cur, inst)) { releaseOwnership(profileId); return null }
  return inst
}

/**
 * 该 Profile 的**独立网关实例数**（按父子链归并后的链根数；null = 探测不可用）。
 *
 * ★ 为什么必须按 Profile 数：
 *   官方 `gateway stop` 是 **profile 级、无 PID 参数**，因此"是否会误停别的实例"
 *   的分母只能是**该 Profile 的实例数**。用全局计数会让另一个 Profile
 *   的网关把 default 的核验拖成"多实例/未确认"（方向虽保守，但口径是错的）。
 * ★ 为什么是"实例数"而不是"进程数"：
 *   真实的 `hermes.exe … gateway run` 是 uv trampoline 拉起的**多层进程链**
 *   （实测 3 层），按进程数计会凭空多出实例 → 误触 multiple-instances。
 */
function profileInstanceCount (ctx, profileId) {
  if (!ctx || ctx.probeError) return null
  if (!Array.isArray(ctx.instances)) return null
  return probe.countInstancesByProfile(ctx.instances, profileId)
}

/**
 * 核验某个 Profile 的所有权（主进程与看门狗共用同一套规则）。
 * @param {string} profileId
 * @param {{fresh?:boolean, forRegistration?:boolean}} opts
 */
async function verifyOwnership (profileId, opts = {}) {
  const p = profileById(profileId)
  if (!p) return { ok: false, reason: 'unknown-profile', instance: null, ctx: null }
  const owned = ownedOf(p.id)
  // 登记场景：候选身份就是"当前状态文件里的实例"（刚由本控制台启动）
  const cur = own.readIdentity(p.home)
  if (!owned) return { ok: false, reason: 'no-ownership', instance: cur, ctx: null, profile: p.id }

  const ctx = await probe.buildVerifyContext(cur, { force: !!opts.fresh })
  state.lastProbe = {
    at: new Date().toISOString(),
    profile: p.id,
    instanceCount: ctx.instanceCount,
    procs: ctx.all,
    probeError: ctx.probeError
  }
  // ★ 按 Profile 统计实例数：另一个 Profile 的网关不会被算进来；
  //   且计的是"归并后的实例数"（多层进程链算 1），不是进程数。
  const perProfileCount = profileInstanceCount(ctx, p.id)
  const check = own.verifyProfileIdentity({
    identity: owned,
    profileHome: p.home,
    procs: ctx.all || [],
    instanceCount: perProfileCount
  })
  const curReadable = !!cur
  // 所有权记录的实例必须与"当前状态文件里的实例"是同一个（防漂移）
  const unchanged = curReadable ? own.sameIdentity(cur, owned) : false

  if (check.ok && unchanged) return { ok: true, reason: check.reason, instance: owned, ctx, profile: p.id, perProfileCount }

  // ★ 2026-09-22：严格区分「身份暂时读不到」与「实例确实被换掉」
  //   · 暂时读不到（典型：官方正在写 gateway_state.json 的 ~1s 窗口）→ **保留**记录，
  //     但本次核验不通过（停止按钮禁用；停止操作由 preflightStop 的
  //     `current === null → probe-failed` 拦住，绝不会被放行）；
  //   · 确凿无效（实例变更 / 换 Profile / 进程不匹配 / 多实例 / 原进程已死）→ 释放。
  let reason
  let retention
  if (curReadable) {
    reason = !unchanged ? 'instance-changed' : check.reason
    retention = own.decideOwnershipRetention({ curReadable: true, unchanged, checkReason: check.reason })
  } else {
    // 用 OS 探测「记录里的进程是否还在」来区分"暂时读不到"与"确凿已死"
    const ownedPidAlive = ctx.probeError
      ? null
      : (ctx.all || []).some(x => Number(x.pid) === Number(owned.pid))
    retention = own.decideOwnershipRetention({
      curReadable: false,
      probeError: ctx.probeError || null,
      ownedPidAlive
    })
    reason = retention.reason
  }

  if (retention.release) {
    log(`所有权失效（profile=${p.id}）：记录 ${own.describeIdentity(owned)}；当前 ${own.describeIdentity(cur)}；原因=${reason}`)
    releaseOwnership(p.id)
    if (!hasAnyOwned()) stopWatchdog()
  } else {
    log(`所有权核验未通过（保留记录 profile=${p.id}）：原因=${reason}`)
  }
  return { ok: false, reason, instance: cur, ctx, profile: p.id, perProfileCount }
}

/** 两次重读之间的等待（只用于"启动后定向重读"，不做无条件长等待） */
function sleepMs (ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))) }

/**
 * 只读采集一次"身份就绪快照"（供启动后定向重读使用）。
 * 只做 I/O，不判定、不等待；存活判定交给调用方（pidAlive）。
 * 这里**静默**读取（不写日志）：窗口内状态文件可能正被写入，属预期现象，无需刷屏。
 */
function readJsonQuiet (p) {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return null }
}

function readIdentitySnapshot (prof) {
  const home = prof.home
  const pidOf = f => (f && typeof f.pid === 'number' && f.pid > 0) ? f.pid : null
  return {
    identity: own.readIdentity(home),
    pidFilePid: pidOf(readJsonQuiet(path.join(home, 'gateway.pid'))),
    statePid: pidOf(readJsonQuiet(path.join(home, 'gateway_state.json'))),
    lockPid: pidOf(readJsonQuiet(path.join(home, 'gateway.lock')))
  }
}

/**
 * 登记结束但**未取得所有权**时的用户可见文案。
 * 要求：说明实际原因 + 安全处理建议；不提示"再次启动已经在跑的网关"；
 *       不提"接管"（该入口受闸门禁用，不是补救路径）。
 */
const REGISTER_MESSAGES = {
  'identity-not-ready':
    '正在确认停止权限。状态文件尚未就绪，停止按钮暂不可用；请稍候片刻后刷新，或在日志页查看运行日志确认进程状态。',
  'identity-unreadable-timeout':
    '状态文件在限定窗口（约 2 秒）内仍未就绪，因此未能确认停止权限（停止按钮暂不可用）。请稍候后刷新再试，或在日志页查看运行日志确认进程状态；若长时间如此，请人工核实该 Gateway 进程与状态文件。',
  'process-gone':
    '登记前该 Gateway 进程已退出，因此未登记所有权。请在日志页查看运行日志确认退出原因。',
  'identity-conflict':
    '检测到该 Profile 的状态文件互相矛盾（存在多个不同的存活 PID）。为避免误停其他实例，已拒绝登记；请人工核实进程与状态文件后再处理。',
  'other-instance':
    '检测到该 Profile 还存在其他存活的 Gateway 实例。为避免误停，已拒绝登记；请先确认是否存在重复启动。',
  'probe-failed':
    '无法核对进程的操作系统真实身份（进程探测失败），因此未登记所有权 —— 无法确认时不取得停止权限。请查看运行日志。'
}

/**
 * 记录/清除"本控制台最近一次登记失败"（按 Profile）。
 *
 * ★ 为什么需要（2026-09-22）：界面过去把「运行中但未取得所有权」**一律**解释成
 *   「外部启动的共享实例（B 态）」。但当实例**本来就是本控制台启动**、只是登记没成功时，
 *   这个解释是**臆断**（PID 4780 实例即如此）。有了本记录，界面可以如实显示
 *   「网关运行中 · 停止权限未确认」+ 具体原因，而不是把它推给"启动方"。
 */
function noteRegisterFailure (profileId, reason, message) {
  state.lastRegisterByProfile[String(profileId)] = {
    reason: reason || 'unknown',
    message: message || null,
    at: new Date().toISOString()
  }
}
function clearRegisterFailure (profileId) {
  delete state.lastRegisterByProfile[String(profileId)]
}

/**
 * 启动成功后登记所有权：**先核验，再登记**。
 * 任何一项核验不过 → 不登记，并返回原因（界面如实显示，绝不谎称已取得所有权）。
 *
 * ★ 2026-09-22 新增「定向重读」：
 *   官方 `gateway run` **先写** gateway.pid + gateway.lock、**后写** gateway_state.json
 *   （实测相隔约 1 秒）。窗口内 readIdentity() 因两处 pid 不一致返回 null，
 *   导致"网关已启动、却报身份不可读"（PID 22296 实例）。
 *   因此**仅当** `opts.startedByUs === true`（该实例由本控制台刚刚启动）时，
 *   在有限窗口（`own.IDENTITY_REREAD_WINDOW_MS`，≤2 秒）内按条件重读：
 *     · 读到身份 → 继续走**完全不变**的完整核验（PID + 创建时间 + home + 单实例）；
 *     · 出现别的存活实例 / 状态文件互相矛盾 / 本次启动的进程已死 → **立即终止**；
 *     · 窗口用尽仍读不到 → 拒绝登记（绝不伪造所有权）。
 *   非本控制台启动的场景（startedByUs !== true）**只读一次、不重读** ——
 *   绝不自动接管已存在的外部 Gateway。
 *
 * @param {object} prof Profile
 * @param {{startedByUs?:boolean, expectedPid?:number|null}} opts
 */
async function registerOwnershipFor (prof, opts = {}) {
  try {
    const startedByUs = opts.startedByUs === true
    const expectedPid = (typeof opts.expectedPid === 'number' && opts.expectedPid > 0) ? opts.expectedPid : null
    const windowMs = startedByUs ? own.IDENTITY_REREAD_WINDOW_MS : 0
    const t0 = Date.now()
    let attempts = 0
    let inst = null
    let verdict = { action: 'abort', reason: 'identity-unreadable-timeout' }

    for (;;) {
      attempts++
      const snap = readIdentitySnapshot(prof)
      inst = snap.identity

      const candidates = Array.from(new Set(
        [snap.pidFilePid, snap.statePid, snap.lockPid].filter(p => typeof p === 'number')
      ))
      const aliveCandidates = candidates.filter(p => pidAlive(p) === true)
      const expectedAlive = expectedPid === null ? null : pidAlive(expectedPid)
      const otherInstanceCount = expectedPid === null
        ? 0
        : aliveCandidates.filter(p => p !== expectedPid).length

      verdict = own.decideIdentityReread({
        attempt: attempts,
        elapsedMs: Date.now() - t0,
        windowMs,
        identity: inst,
        expectedPid,
        expectedAlive,
        alivePidCount: aliveCandidates.length,
        otherInstanceCount
      })

      if (verdict.action !== 'retry') break
      await sleepMs(own.IDENTITY_REREAD_INTERVAL_MS)
    }

    if (verdict.action === 'abort') {
      const waitedMs = Date.now() - t0
      const msg = REGISTER_MESSAGES[verdict.reason] || `未登记所有权（${verdict.reason}）。`
      log(`登记未完成（profile=${prof.id}）：原因=${verdict.reason}（重读 ${attempts} 次 / ${waitedMs}ms / 窗口 ${windowMs}ms）`)
      noteRegisterFailure(prof.id, verdict.reason, msg)
      return {
        acquired: false,
        pending: own.REGISTER_PENDING_REASONS.includes(verdict.reason),
        reason: verdict.reason,
        attempts,
        waitedMs,
        message: msg
      }
    }

    // ---- 以下为完整核验：与既有规则完全一致（未放宽任何一项）----
    const ctx = await probe.buildVerifyContext(inst, { force: true })
    if (ctx.probeError) {
      log(`登记未完成（profile=${prof.id}）：进程探测失败 ${ctx.probeError}`)
      noteRegisterFailure(prof.id, 'probe-failed', REGISTER_MESSAGES['probe-failed'])
      return { acquired: false, pending: false, reason: 'probe-failed', message: REGISTER_MESSAGES['probe-failed'] }
    }
    const count = profileInstanceCount(ctx, prof.id)
    const check = own.verifyProfileIdentity({ identity: inst, profileHome: prof.home, procs: ctx.all || [], instanceCount: count })
    if (!check.ok) {
      const msg = `身份核验未通过（${check.reason}），未登记所有权 —— 网关在运行，但停止权限未确认。`
      noteRegisterFailure(prof.id, check.reason, msg)
      return { acquired: false, pending: false, reason: check.reason, message: msg }
    }
    setOwned(prof.id, inst)
    persistOwnership()
    clearRegisterFailure(prof.id)
    startWatchdog()
    log(`已登记所有权: profile=${prof.id} ${own.describeIdentity(inst)}（核验通过：PID + 创建时间 + home + 单实例；重读 ${attempts} 次 / ${Date.now() - t0}ms）`)
    return { acquired: true, reason: 'registered', instance: inst, profile: prof.id, attempts, waitedMs: Date.now() - t0 }
  } catch (err) {
    log(`登记所有权异常: profile=${prof.id} ${err.message}`)
    noteRegisterFailure(prof.id, 'register-failed', `登记所有权时出错（${err.message}），停止权限未确认。`)
    return { acquired: false, pending: false, reason: 'register-failed', message: `登记所有权时出错（${err.message}），停止权限未确认。` }
  }
}

/** 释放某个 Profile 的所有权（只影响该 Profile） */
function releaseOwnership (profileId) {
  if (!profileId) return
  delete state.ownedByProfile[String(profileId)]
  persistOwnership()
}

// ---- 所有权记录落盘（用于崩溃后恢复判定；不含任何凭据）----
function persistOwnership () {
  const gateways = {}
  for (const [id, inst] of Object.entries(state.ownedByProfile)) if (inst) gateways[id] = inst
  try {
    if (!Object.keys(gateways).length) {
      if (fs.existsSync(OWNERSHIP_FILE)) fs.unlinkSync(OWNERSHIP_FILE)
      return
    }
    fs.writeFileSync(OWNERSHIP_FILE, JSON.stringify({
      version: 2,
      consolePid: process.pid,
      gateways,
      acquiredAt: new Date().toISOString()
    }, null, 2), 'utf8')
  } catch (err) { log(`写入所有权记录失败: ${err.message}`) }
}

function readPersistedOwnership () {
  const j = readJsonIfExists(OWNERSHIP_FILE)
  if (!j) return null
  return j
}

function clearPersistedOwnership () {
  try { if (fs.existsSync(OWNERSHIP_FILE)) fs.unlinkSync(OWNERSHIP_FILE) } catch {}
}

// ---- 一次性授权（C）：不产生所有权，仅放行本次【指定动作 + 指定目标】----
/**
 * 签发一次性授权。
 *
 * 关键约束：**必须绑定目标实例身份**。
 * 无法确认目标身份时**拒绝签发** —— 否则会留下
 * 「先授权 → 目标漂移到别的实例 → 再执行」的绕过窗口。
 * （这正是安全复审指出的问题二。）
 */
function issueAuthorization(action) {
  const cur = readGatewayIdentity()
  const a = own.createAuthorization(action, cur || {})
  if (!a) {
    log(`拒绝签发一次性授权：action=${action} 原因=目标实例身份不可确认（${own.describeIdentity(cur)}）`)
    return null
  }
  state.authorization = a
  // 只记录动作、目标身份与不可反推的关联号；**不记录 token 值**
  log(`已签发一次性授权: action=${action} 目标=${own.describeIdentity(a.target)} ref=${a.tokenHash}`)
  return a
}

/**
 * 消费一次性授权。
 * 语义（明确约定）：**授权门判定通过的那一刻即消费**，
 * 之后无论实际操作成功、失败还是超时，该授权都不再可用，需要重新授权。
 * 这是 fail-closed 选择 —— 避免"操作失败后留下可复用的授权"。
 */
function consumeAuthorization(action) {
  const a = state.authorization
  if (!a || a.action !== action) return null
  const done = own.consumeAuthorization(a)
  state.authorization = null
  return done
}

/**
 * 危险操作授权门 —— 主进程内最后一道防线。
 * 任何 gateway stop / restart / drain 都必须经过这里。
 *
 * 放行条件（**必须同时成立**，二选一）：
 *   A) 所有权核验通过：身份完整一致 + OS 进程核对通过 + 同 profile 单实例
 *   C) 一次性授权：动作匹配、未消费、未过期，
 *      **且**当前目标身份可确认、与授权绑定的目标一致、
 *      **且**OS 进程核对通过、同 profile 单实例
 *
 * 注意：授权**不能**替代身份确认。
 * 旧实现在 current=null 时仍会因授权有效而放行 —— 那是绕过，已修复。
 */
const gate = own.createGate()

async function authorizeDangerous (action, targetProfileId) {
  // ★ 危险操作必须有明确的**目标 Profile**：所有权按 Profile 分槽，不隐含"默认目标"
  const target = profileById(targetProfileId)
  if (!target) {
    state.lastVerify = {
      action, at: new Date().toISOString(), ok: false, via: null,
      reason: 'unknown-profile', detail: `目标 Profile 未指定或未知（${String(targetProfileId)}）`, residualRisk: null
    }
    return { allowed: false, reason: 'unknown-profile', detail: '未指定有效的目标 Profile' }
  }
  // 先取快照：失权清理会清空该 Profile 的登记，之后读就拿不到原记录
  const ownedSnapshot = ownedOf(target.id)
  // fresh=true：这是危险操作的最后一道检查，必须用**当场的新鲜探测**，
  // 不能吃 1.5s 缓存（那只适用于界面展示用的只读核验）。
  const v = await verifyOwnership(target.id, { fresh: true })
  const cur = v.instance
  const ctx = v.ctx || {}
  const perProfileCount = v.perProfileCount

  // ★ 按 Profile 判定：owned 只认该 Profile 的登记；instanceCount 只数该 Profile 的实例
  const decision = gate.decide(action, ownedSnapshot, cur, state.authorization, {
    // ⚠️ 必须传 buildVerifyContext 构造的 { exists, startMs }，
    //    而不是 all 里的原始元素（后者没有 exists 字段）——否则 verifyTarget
    //    会一律判成 process-absent，A 态停止永远无法放行。
    proc: ctx.proc || null,
    instanceCount: perProfileCount
  })

  state.lastVerify = {
    action,
    profile: target.id,
    at: new Date().toISOString(),
    ok: decision.allowed,
    via: decision.via || null,
    reason: decision.reason,
    detail: decision.detail || null,
    perProfileCount,
    // 如实记录剩余风险：核验通过 ≠ 保证只停止目标实例（profile 级 stop 的固有竞态）
    residualRisk: decision.residualRisk || null
  }

  if (decision.allowed) {
    const risk = decision.residualRisk
      ? '（⚠️ 剩余风险：官方 stop 为 profile 级、无 PID 参数，检查与执行之间仍有无法消除的竞态）'
      : ''
    if (decision.via === 'one-shot') {
      consumeAuthorization(action)   // 通过即消费
      log(`授权通过（C 一次性授权）: action=${action} 目标=${own.describeIdentity(cur)}（授权已消费）${risk}`)
    } else {
      log(`授权通过（A 所有权核验）: action=${action} 目标=${own.describeIdentity(cur)}${risk}`)
    }
    return { allowed: true, via: decision.via, instance: cur, residualRisk: decision.residualRisk || null }
  }

  log(`授权拒绝: action=${action} 原因=${decision.reason}` +
      (decision.detail ? ` 细节=${decision.detail}` : ''))
  return { allowed: false, reason: decision.reason, detail: decision.detail, instance: cur }
}

// ---------------------------------------------------------------------------
// 启动官方后端（hermes serve）
// ---------------------------------------------------------------------------
function startBackend() {
  if (state.backendState === 'starting' || state.backendState === 'ready') return
  if (!HERMES_HOME) {
    state.backendState = 'failed'
    state.backendError = '未找到 Hermes 主目录（%LOCALAPPDATA%\\hermes 或 HERMES_HOME）'
    log(`后端启动失败: ${state.backendError}`)
    return
  }

  state.backendState = 'starting'
  state.backendError = null
  log(`启动后端: ${HERMES_EXE} serve --host 127.0.0.1 --port 0 (HERMES_HOME=${HERMES_HOME})`)

  let child
  try {
    child = spawn(HERMES_EXE, ['serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: HERMES_HOME,
      env: {
        ...process.env,
        HERMES_HOME,
        PYTHONIOENCODING: 'utf-8',
        HERMES_DASHBOARD_SESSION_TOKEN: SESSION_TOKEN
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    state.backendState = 'failed'
    state.backendError = `无法启动 hermes: ${err.message}`
    log(state.backendError)
    return
  }

  state.backend = child
  const readyRe = /HERMES_(?:BACKEND|DASHBOARD)_READY\s+port=(\d+)/

  child.stdout.on('data', buf => {
    const text = buf.toString('utf8')
    const m = text.match(readyRe)
    if (m && !state.port) {
      state.port = Number(m[1])
      state.backendState = 'ready'
      log(`后端就绪，端口 ${state.port}`)
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('backend:state', getBootstrapInfo()))
      probeGatewayPreExisted()
    }
  })
  child.stderr.on('data', buf => {
    const text = buf.toString('utf8').trim()
    if (text) log(`[stderr] ${text.slice(0, 400)}`)
  })
  child.on('exit', (code, signal) => {
    log(`后端进程退出 code=${code} signal=${signal}`)
    state.backend = null
    if (state.backendState !== 'ready') {
      state.backendState = 'failed'
      if (!state.backendError) state.backendError = `后端启动失败 (exit=${code})，请确认 hermes 可用`
    } else if (!state.quitting) {
      state.backendState = 'stopped'
      state.port = null
    }
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('backend:state', getBootstrapInfo()))
  })
  child.on('error', err => {
    state.backendState = 'failed'
    state.backendError = `后端进程错误: ${err.message}`
    log(state.backendError)
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('backend:state', getBootstrapInfo()))
  })
}

function stopBackend() {
  if (!state.backend) return
  log('停止本控制台拥有的后端进程')
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(state.backend.pid), '/t', '/f'], { windowsHide: true })
    else state.backend.kill('SIGTERM')
  } catch (err) { log(`停止后端失败: ${err.message}`) }
  state.backend = null
}

// ---------------------------------------------------------------------------
// 看门狗（覆盖「控制台异常崩溃」场景）
//
// 正常关闭由 before-quit 处理；但进程被强杀/崩溃时不会执行任何 JS。
// 因此仅在有【已验证的所有权】时，才派生一个独立看门狗：
//   等待控制台进程消失 → 重新核验网关身份是否仍与记录一致 → 一致才（按开关）停止。
//
// 长期运行：看门狗内部采用「观察周期 + 交接」，周期到点派生后继而非静默退出，
// 因此控制台连续开数天也不会出现"保护无声消失"的窗口（详见 watchdog.js 头注释）。
// 单槽锁（WATCHDOG_LOCK_FILE）保证同一控制台任意时刻只有一个看门狗。
//
// ★ 自动停止当前禁用：只有 ALLOW_AUTO_STOP 为 true 时才向看门狗传 --allow-stop 1。
//   默认为 false → 看门狗只观察、只记录审计信息，绝不调用 stop。
// ---------------------------------------------------------------------------
const WATCHDOG_PATH = path.join(APP_DIR, 'watchdog.js')

function startWatchdog() {
  if (state.watchdog) return
  if (!hasAnyOwned()) return                      // 任一 Profile 有所有权才派生看门狗
  if (!fs.existsSync(WATCHDOG_PATH)) { log('看门狗脚本缺失，跳过派生'); return }
  try {
    const child = spawn(process.execPath, [
      WATCHDOG_PATH,
      '--console-pid', String(process.pid),
      '--record', OWNERSHIP_FILE,
      '--hermes-home', HERMES_HOME || '',
      '--log', path.join(LOG_DIR, 'watchdog.log'),
      '--lock', WATCHDOG_LOCK_FILE,
      '--generation', '1',
      // 自动停止开关：未通过真实端到端验收前恒为 '0'
      '--allow-stop', ALLOW_AUTO_STOP ? '1' : '0'
    ], {
      // 以纯 Node 方式运行同一份 Electron 二进制，无需额外运行时
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.unref()
    state.watchdog = child
    log(`看门狗已派生 pid=${child.pid} 自动停止=${ALLOW_AUTO_STOP ? '已启用' : '已禁用（未通过真实验收）'}`)
  } catch (err) {
    log(`看门狗派生失败: ${err.message}`)
  }
}

function stopWatchdog() {
  if (!state.watchdog) return
  try { state.watchdog.kill() } catch {}
  state.watchdog = null
}

/**
 * 崩溃恢复提示：上次会话是否留下了未清理的所有权记录？
 *
 * ⚠️ 只返回信息，**任何情况下都不自动停止**。
 * 即使上次控制台崩溃、记录里的实例仍在运行，也不在启动时自动 stop ——
 * 自动停止依赖的 profile 级 stop 存在无法消除的竞态（见 ALLOW_AUTO_STOP 注释），
 * 且"崩溃后的遗留实例"本身就说明状态可能已漂移。
 * 提示由界面呈现，是否处理由用户显式决定。
 */
function detectStaleOwnership() {
  const rec = readPersistedOwnership()
  if (!rec) return null
  if (rec.consolePid === process.pid) return null
  let alive = false
  try { process.kill(rec.consolePid, 0); alive = true } catch { alive = false }
  if (alive) return null                    // 上次控制台还活着 → 不是残留
  const cur = readGatewayIdentity()
  if (!cur || !sameInstance(rec, cur)) {
    clearPersistedOwnership()
    return null                              // 实例已不是那个 → 记录作废
  }
  return { record: rec, instance: cur }
}

function getBootstrapInfo() {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    hermesHome: HERMES_HOME,
    hermesExe: HERMES_EXE,
    logFile: LOG_FILE,
    backendState: state.backendState,
    backendError: state.backendError,
    port: state.port,
    backendPid: state.backend ? state.backend.pid : null,
    // 所有权状态（不再是一个可以由界面直接设定的布尔值）
    ownership: {
      // ★ 按 Profile 的所有权：各 Profile 各自独立
      byProfile: PROFILES.reduce((acc, p) => {
        const inst = liveOwnedOf(p.id)        // ★ 带存活核验：失效实例会被释放（见 liveOwnedOf）
        acc[p.id] = {
          profile: p.id,
          label: p.label,
          owned: !!inst,
          instance: inst,                    // A：本控制台持有（仅身份，不含任何 token）
          mode: inst ? 'owned' : 'unknown',  // unknown = 未取得所有权（可能是 B 态或归属不明）
          // ★ 本控制台最近一次登记失败 { reason, message, at }｜null。
          //   用途：区分「本控制台启动但登记未成功」与「外部启动的共享实例（B 态）」，
          //   避免把前者也一律说成"非本控制台启动"（PID 4780 实例的既有问题）。
          registerFailure: state.lastRegisterByProfile[p.id] || null,
          verified: false                    // 由 console:ownership 的当场核验结果填充
        }
        return acc
      }, {}),
      ownedProfiles: Object.keys(state.ownedByProfile).filter(id => ownedOf(id)),
      preExisting: state.preExisting,     // B：启动前已存在
      authorization: state.authorization
        ? {
            action: state.authorization.action,
            issuedAt: state.authorization.issuedAt,
            consumed: state.authorization.consumed,
            target: { pid: state.authorization.target.pid, startMs: state.authorization.target.startMs }
          }
        : null,
      lastVerify: state.lastVerify,
      lastProbe: state.lastProbe,         // OS 进程核对结果（真实值）
      ownershipFile: OWNERSHIP_FILE,
      // 自动停止开关的真实取值（false = 只核验不停止）+ 竞态限制的如实说明
      autoStop: {
        enabled: ALLOW_AUTO_STOP,
        reason: ALLOW_AUTO_STOP
          ? '已开启（需另行真实验收）'
          : '已禁用：官方 stop 为 profile 级、无 PID 参数，检查与执行之间存在无法消除的竞态；该路径尚未通过真实端到端验收'
      },
      // 看门狗单槽锁 + 心跳（可观察，避免"保护无声失效"）
      watchdog: {
        spawnedPid: state.watchdog ? state.watchdog.pid : null,
        lockFile: WATCHDOG_LOCK_FILE,
        lock: readJsonIfExists(WATCHDOG_LOCK_FILE)
      },
      // 上次会话崩溃后遗留的所有权记录（仅提示，不自动停止）
      stale: state.staleOwnership || null
    },
    // ★ 网关运行状态：以 OS 进程核验为准（readProfileGateway 内部做 pidAlive 存活检查），
    //   **不**采用控制台自身 serve 后端 /api/status 的 gateway_running（该值在外部停止后会过期，
    //   正是此前「控制台仍显示运行中」的根因）。
    gateways: PROFILES.reduce((acc, p) => {
      const g = readProfileGateway(p)
      acc[p.id] = {
        profile: p.id,
        running: !!g.running,
        pid: g.pid || null,
        stale: !!g.stale,
        detail: g.detail || null,
        source: 'os-probe'
      }
      return acc
    }, {}),
    startedAt: state.startedAt
  }
}

// ---------------------------------------------------------------------------
// 窗口 · 退出提示（严格模式）
// ---------------------------------------------------------------------------
let mainWindow = null
let forceQuit = false          // true 时允许真正关闭窗口（用户已确认）
let exitPromptOpen = false     // 防止重复弹提示

/**
 * 退出决策（用户点 × 时触发）：
 *   · 相关服务**全部已停止**（真实核验）→ 直接正常退出，不留无意义的后台。
 *   · 有服务在运行 → 通知渲染进程显示退出提示；**绝不自动 stop、绝不杀进程**。
 *     严格模式为默认：提示用户先手动关闭；受限于"停止能力未验收"，
 *     同时提供明确标注的例外「仅退出控制台、后台服务继续运行」。
 */
async function askExitDecision() {
  if (exitPromptOpen) return
  let payload
  try {
    const rs = await getRuntimeServices()
    payload = {
      services: rs.services,
      anyRunning: rs.anyRunning,
      strict: true,
      note: '停止能力尚未通过真实端到端验收，本轮控制台不会自动停止任何服务，也不会终止任何进程。'
    }
  } catch (err) {
    payload = { services: [], anyRunning: false, strict: true, note: `状态读取失败：${err.message}` }
  }

  if (!payload.anyRunning) {
    log('退出：未检测到仍在运行的相关服务 → 直接正常退出')
    forceQuit = true
    app.quit()
    return
  }
  exitPromptOpen = true
  log('退出：检测到仍在运行的服务，向用户显示退出提示（不自动停止）')
  const w = mainWindow
  if (w && !w.isDestroyed()) w.webContents.send('ui:exit-request', payload)
}

ipcMain.handle('console:exitDecision', (_e, mode) => {
  exitPromptOpen = false
  if (mode === 'exit-only') {
    log('用户选择：仅退出控制台，后台服务继续运行（控制台不停止任何网关、不终止任何进程）')
    forceQuit = true
    app.quit()
    return { ok: true, mode: 'exit-only' }
  }
  log('用户取消退出，返回控制台')
  return { ok: true, cancelled: true }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0b1220',
    title: 'Hermes 控制台',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.loadFile(path.join(APP_DIR, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  // 关闭（×）拦截 —— 退出提示（严格模式）：
  //   有服务仍在运行时，不直接关窗、不杀任何进程；交给渲染进程显示提示，
  //   让用户选择「返回控制台」或「仅退出控制台（后台继续运行）」。
  mainWindow.on('close', e => {
    if (forceQuit) return
    e.preventDefault()
    askExitDecision()
  })

  // 把渲染进程的 console 输出与加载失败记入控制台日志，便于诊断（不改变用户可见行为）
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log(`[renderer:${level}] ${source}:${line} ${message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[renderer] 资源加载失败 ${code} ${desc} ${url}`)
  })

  // 自检截图（用于真实验收，不影响正常使用）：
  //   HERMES_CONSOLE_SHOT=<png>        只截首页
  //   HERMES_CONSOLE_SHOT_ALL=<dir>    逐页截图（总览/Agent/Skills/模型/飞书/日志/设置）
  const shotAll = process.env.HERMES_CONSOLE_SHOT_ALL
  const shotPath = process.env.HERMES_CONSOLE_SHOT
  if (shotAll || shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      const wait = ms => new Promise(r => setTimeout(r, ms))
      const run = async () => {
        await wait(Number(process.env.HERMES_CONSOLE_SHOT_DELAY || 14000))
        try {
          if (shotAll) {
            fs.mkdirSync(shotAll, { recursive: true })
            // 逐页截图时先收起认证弹窗（它有自己的专门截图），避免遮挡页面
            await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)
            const pages = ['overview', 'agent', 'skills', 'capabilities', 'model', 'feishu', 'logs', 'settings']
            for (const p of pages) {
              await mainWindow.webContents.executeJavaScript(`switchPage(${JSON.stringify(p)})`)
              // capabilities 页要等能力探测（含只读进程查询）完成；logs 页要等日志读取
              await wait(p === 'logs' ? 4000 : p === 'capabilities' ? 5000 : 1200)
              // 逐页截图前收起认证弹窗（它有自己的专门截图），避免遮挡页面内容
              await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)
              const img = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, `${p}.png`), img.toPNG())
              log(`已保存页面截图: ${p}.png`)
            }

            // 额外：日志页**真实内容**（走真实的「读取」路径）——三源各一张，证明来源未混淆
            try {
              await mainWindow.webContents.executeJavaScript(`switchPage('logs')`)
              await wait(1600)
              const combos = [
                ['default', 'errors', 'logs-content-default.png'],
                [extraProfileId(), 'agent', 'logs-content-extra.png'],
                ['external', 'pipeline', 'logs-content-external.png']
              ]
              for (const [src, file, name] of combos) {
                const okFlag = await mainWindow.webContents.executeJavaScript(`
                  (async () => {
                    document.getElementById('logSource').value = ${JSON.stringify(src)};
                    await loadLogSources(false);
                    document.getElementById('logFile').value = ${JSON.stringify(file)};
                    document.getElementById('logLevel').value = '';
                    document.getElementById('logSearch').value = '';
                    document.getElementById('logJobId').value = '';
                    document.getElementById('logSince').value = '';
                    document.getElementById('logUntil').value = '';
                    await loadLogs();
                    return !!(LOG_LAST && LOG_LAST.ok);
                  })()
                `)
                await wait(900)
                await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)
                // 把「日志内容」滚动到视口顶部，确保截图能看到真实的日志行与折叠组
                await mainWindow.webContents.executeJavaScript(`
                  (() => {
                    const m = document.getElementById('mainArea');
                    const v = document.getElementById('logView');
                    if (!m || !v) return false;
                    const card = v.closest('.card') || v;
                    const delta = card.getBoundingClientRect().top - m.getBoundingClientRect().top;
                    m.scrollTop = Math.max(0, m.scrollTop + delta - 8);
                    return true;
                  })()
                `)
                await wait(400)
                const imgL = await mainWindow.webContents.capturePage()
                fs.writeFileSync(path.join(shotAll, name), imgL.toPNG())
                // 同时落地「渲染后的可见文本」，便于核对原始行是否真的被展示（不依赖肉眼看图）
                try {
                  const vis = await mainWindow.webContents.executeJavaScript(
                    `document.getElementById('logView').innerText`
                  )
                  fs.writeFileSync(path.join(shotAll, `${name.replace('.png', '')}.txt`), String(vis || ''), 'utf8')
                } catch (e2) { log(`日志文本导出失败: ${e2.message}`) }
                log(`已保存日志内容截图: ${name}（source=${src} 读取成功=${okFlag}）`)
              }
            } catch (err) { log(`日志内容截图失败: ${err.message}`) }

            // 额外：日志页两项关键能力的真实截图 —— 重复折叠 / 关键词过滤
            try {
              await mainWindow.webContents.executeJavaScript(`switchPage('logs')`)
              await wait(1200)
              // (a) 折叠：default agent.log 里有大量重复的 Nous 认证心跳行
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logSource').value = 'default';
                  await loadLogSources(false);
                  document.getElementById('logFile').value = 'agent';
                  document.getElementById('logLevel').value = '';
                  document.getElementById('logSearch').value = 'Nous inference auth';
                  await loadLogs();
                  return true;
                })()
              `)
              await wait(900)
              await mainWindow.webContents.executeJavaScript(`
                (() => {
                  const m = document.getElementById('mainArea');
                  const v = document.getElementById('logView');
                  const c = v.closest('.card') || v;
                  m.scrollTop = Math.max(0, m.scrollTop + (c.getBoundingClientRect().top - m.getBoundingClientRect().top) - 8);
                  return true;
                })()
              `)
              await wait(400)
              const imgC = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-collapse-default.png'), imgC.toPNG())
              log('已保存日志折叠截图: logs-collapse-default.png')

              // (b) 关键词过滤：外部工程 流水线里只留 onnxruntime 相关行
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logSource').value = 'external';
                  await loadLogSources(false);
                  document.getElementById('logFile').value = 'pipeline';
                  document.getElementById('logLevel').value = '';
                  document.getElementById('logSearch').value = 'onnxruntime';
                  await loadLogs();
                  return true;
                })()
              `)
              await wait(900)
              await mainWindow.webContents.executeJavaScript(`
                (() => {
                  const m = document.getElementById('mainArea');
                  const v = document.getElementById('logView');
                  const c = v.closest('.card') || v;
                  m.scrollTop = Math.max(0, m.scrollTop + (c.getBoundingClientRect().top - m.getBoundingClientRect().top) - 8);
                  return true;
                })()
              `)
              await wait(400)
              const imgF = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-filter-external.png'), imgF.toPNG())
              log('已保存日志过滤截图: logs-filter-external.png')

              // (c) 离线三态：切到额外 Profile 后故意读取一个不存在的来源文件（gateway.log 若缺失即展示离线）
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logSource').value = 'profile';
                  await loadLogSources(false);
                  document.getElementById('logSearch').value = '';
                  // 用一个必然不存在的文件 id 触发「参数无效」态（渲染层不会崩溃）
                  await window.hermes.readLogs({ source: 'profile', file: '__nonexistent__' }).then(d => {
                    window.__offlineDemo = d;
                  });
                  return window.__offlineDemo && window.__offlineDemo.reason;
                })()
              `).then(r => log(`三态自检（不存在的文件）→ reason=${r}`)).catch(e => log(`三态自检失败: ${e.message}`))
            } catch (err) { log(`日志能力截图失败: ${err.message}`) }

            // 额外（本轮）：日志页新增能力的真实截图 ——
            //   默认最新在前 / 时间范围快捷筛选 / 只看问题 / 级别分布 / 投递与制作两条轴
            try {
              const scrollLogsToTop = async () => {
                await mainWindow.webContents.executeJavaScript(`
                  (() => {
                    const m = document.getElementById('mainArea');
                    const v = document.getElementById('logView');
                    if (!m || !v) return false;
                    const c = v.closest('.card') || v;
                    m.scrollTop = Math.max(0, m.scrollTop + (c.getBoundingClientRect().top - m.getBoundingClientRect().top) - 8);
                    return true;
                  })()
                `)
                await wait(350)
              }
              const dumpLogText = async (name) => {
                try {
                  const vis = await mainWindow.webContents.executeJavaScript(
                    `document.getElementById('logView').innerText`
                  )
                  fs.writeFileSync(path.join(shotAll, name.replace('.png', '.txt')), String(vis || ''), 'utf8')
                } catch (e2) { log(`新增日志文本导出失败: ${e2.message}`) }
              }
              await mainWindow.webContents.executeJavaScript(`switchPage('logs')`)
              await wait(1000)

              // (a) 默认视图：最新在前 + 时间范围按钮 + 级别分布 + 顺序说明
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logSource').value = 'default';
                  await loadLogSources(false);
                  document.getElementById('logFile').value = 'agent';
                  document.getElementById('logLevel').value = '';
                  document.getElementById('logSearch').value = '';
                  document.getElementById('logJobId').value = '';
                  document.getElementById('logSince').value = '';
                  document.getElementById('logUntil').value = '';
                  document.getElementById('logOrder').value = 'desc';
                  LOG_ORDER = 'desc'; LOG_RANGE = 'all'; renderRangeNote();
                  await loadLogs();
                  return true;
                })()
              `)
              await wait(900)
              await scrollLogsToTop()
              let im = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-new-default.png'), im.toPNG())
              await dumpLogText('logs-new-default.png')
              log('已保存: logs-new-default.png（默认最新在前 + 时间范围 + 级别分布）')

              // (b) 时间范围：最近 10 分钟（以日志最新时间为参考）
              await mainWindow.webContents.executeJavaScript(`
                (async () => { LOG_RANGE = '10m'; renderRangeNote(); await loadLogs(); return true })()
              `)
              await wait(800)
              await scrollLogsToTop()
              im = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-new-range-10m.png'), im.toPNG())
              await dumpLogText('logs-new-range-10m.png')
              log('已保存: logs-new-range-10m.png（最近 10 分钟）')

              // (c) 只看问题：WARNING 及以上 + 级别分布计数（ERROR/WARNING 不折叠）
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  LOG_RANGE = 'all'; renderRangeNote();
                  document.getElementById('logLevel').value = 'WARNING';
                  document.getElementById('logSearch').value = '';
                  await loadLogs();
                  return true;
                })()
              `)
              await wait(900)
              await scrollLogsToTop()
              im = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-new-issues.png'), im.toPNG())
              await dumpLogText('logs-new-issues.png')
              log('已保存: logs-new-issues.png（只看问题 = WARNING 及以上）')

              // (d) 警告的中文解释：真实 WARNING（event loop stalled）→ 未收录时必须显示「暂无解释」
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logSearch').value = 'event loop stalled';
                  await loadLogs();
                  return true;
                })()
              `)
              await wait(900)
              await scrollLogsToTop()
              im = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-new-warning-explain.png'), im.toPNG())
              await dumpLogText('logs-new-warning-explain.png')
              log('已保存: logs-new-warning-explain.png（WARNING 的中文解释）')

              // (e) 翻唱任务：制作轴 / 投递轴分开显示（completed ≠ 已送达）
              await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('logLevel').value = '';
                  document.getElementById('logSearch').value = '';
                  await loadLogs();
                  await loadExternalJobs();
                  return true;
                })()
              `)
              await wait(900)
              await mainWindow.webContents.executeJavaScript(`
                (() => {
                  const m = document.getElementById('mainArea');
                  const c = document.getElementById('logJobsCard');
                  if (!m || !c) return false;
                  m.scrollTop = Math.max(0, m.scrollTop + (c.getBoundingClientRect().top - m.getBoundingClientRect().top) - 8);
                  return true;
                })()
              `)
              await wait(400)
              im = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'logs-new-jobs-axes.png'), im.toPNG())
              try {
                const jobsText = await mainWindow.webContents.executeJavaScript(
                  `document.getElementById('logJobs').innerText`)
                fs.writeFileSync(path.join(shotAll, 'logs-new-jobs-axes.txt'), String(jobsText || ''), 'utf8')
              } catch (e3) { log(`任务文本导出失败: ${e3.message}`) }
              log('已保存: logs-new-jobs-axes.png（制作 / 投递两条轴）')
            } catch (err) { log(`新增日志能力截图失败: ${err.message}`) }

            // 额外：**真实**触发退出提示（走真实 close 拦截 → askExitDecision → ui:exit-request）
            try {
              await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)   // 先收起认证弹窗，避免遮挡
              await mainWindow.webContents.executeJavaScript(`window.hermes.windowControl('close')`)
              await wait(1500)
              const img1 = await mainWindow.webContents.capturePage()
              fs.writeFileSync(path.join(shotAll, 'exit-modal.png'), img1.toPNG())
              await mainWindow.webContents.executeJavaScript(`hideExitModal()`)
              log('已保存弹窗截图: exit-modal.png（真实退出提示路径）')
            } catch (err) { log(`退出弹窗截图失败: ${err.message}`) }

            // 额外：真实认证状态弹窗（仅当官方状态判定为失效时才出现；与运行期同一判定逻辑）
            try {
              // 强制重新拉取按 Profile 的认证状态，并清除去重标记后按真实判定决定是否弹窗
              await mainWindow.webContents.executeJavaScript(`loadAuth(true).then(() => { AUTH_SHOWN_SIG = null; checkAuth() })`)
              await wait(1500)
              const shown = await mainWindow.webContents.executeJavaScript(
                `!document.getElementById('authModal').classList.contains('hidden')`)
              if (shown) {
                const img2 = await mainWindow.webContents.capturePage()
                fs.writeFileSync(path.join(shotAll, 'auth-modal.png'), img2.toPNG())
                await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)
                log('已保存弹窗截图: auth-modal.png（真实认证状态）')
              } else {
                log('认证弹窗未出现（当前认证状态非失效）→ 不生成 auth-modal.png')
              }
              // 另一状态变体：显式打开额外 Profile 的认证弹窗（同一真实代码路径，非示意）
              const okShot = await mainWindow.webContents.executeJavaScript(`
                (() => { try { openAuthModal(${JSON.stringify(extraProfileId())}); return !document.getElementById('authModal').classList.contains('hidden') } catch (e) { return false } })()`)
              if (okShot) {
                await wait(600)
                const img3 = await mainWindow.webContents.capturePage()
                fs.writeFileSync(path.join(shotAll, 'auth-modal-extra.png'), img3.toPNG())
                await mainWindow.webContents.executeJavaScript(`hideAuthModal()`)
                log('已保存弹窗截图: auth-modal-extra.png（额外 Profile 真实认证状态）')
              } else {
                log('额外 Profile 认证弹窗未能打开 → 不生成 auth-modal-extra.png')
              }
            } catch (err) { log(`认证弹窗截图失败: ${err.message}`) }
          } else {
            const img = await mainWindow.webContents.capturePage()
            fs.writeFileSync(shotPath, img.toPNG())
            log(`已保存界面截图: ${shotPath}`)
          }
        } catch (err) {
          log(`截图失败: ${err.message}`)
        }
        const ownShot = await verifyOwnership('default', {})   // 自检路径：只核验 default
        log(`退出前所有权核验: ownedProfiles=${JSON.stringify(Object.keys(state.ownedByProfile).filter(id => ownedOf(id)))} ` +
            `ok=${ownShot.ok} reason=${ownShot.reason}`)
        stopBackend()
        app.exit(0)
      }
      run()
    })
  }

  // -------------------------------------------------------------------------
  // 安全自检模式（仅在设置 HERMES_CONSOLE_SELFTEST 时启用；正常使用绝不触发）
  // 目的：用【真实运行的应用】验证 renderer 无法绕过主进程权限。
  // 只做只读/应被拒绝的探测，不会启动或停止任何网关。
  // -------------------------------------------------------------------------
  const selftestOut = process.env.HERMES_CONSOLE_SELFTEST
  if (selftestOut) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms))
      await wait(Number(process.env.HERMES_CONSOLE_SELFTEST_DELAY || 16000))
      const results = []
      // 注意：这里命名为 check，避免遮蔽模块级的 probe（进程探测模块）
      const check = async (name, expr, expect) => {
        let value
        try { value = await mainWindow.webContents.executeJavaScript(expr) }
        catch (e) { value = `__THROW__ ${e && e.message}` }
        let pass = false
        try { pass = !!expect(value) } catch { pass = false }
        results.push({ name, expr, actual: value, pass })
        log(`[selftest] ${pass ? 'PASS' : 'FAIL'} ${name} -> ${JSON.stringify(value)}`)
      }

      await check(
        '渲染进程直接 POST 危险接口 → 必须被白名单拒绝',
        `window.hermes.post('/api/gateway/stop').then(()=> 'ALLOWED').catch(e=> 'REJECTED:' + e.message)`,
        v => typeof v === 'string' && v.startsWith('REJECTED'))

      // ★ RC 轮策略：stop 仅对所有权 A 态放开；自检环境无所有权（B/无）→ 必须被拒
      await check(
        '★ 停止入口：非本控制台持有的实例被拒绝（仅放开 A 态）',
        `window.hermes.gatewayStop()`,
        v => v && v.ok === false && (v.reason === 'no-ownership' || v.reason === 'dangerous-disabled' || v.reason === 'owned-only'))

      await check(
        '★ 重启入口被统一闸门拒绝',
        `window.hermes.gatewayRestart()`,
        v => v && v.ok === false && v.reason === 'dangerous-disabled')

      await check(
        '★ 排空入口被统一闸门拒绝',
        `window.hermes.gatewayDrain()`,
        v => v && v.ok === false && v.reason === 'dangerous-disabled')

      await check(
        '★ 接管入口被统一闸门拒绝',
        `window.hermes.gatewayAdopt()`,
        v => v && v.ok === false && v.reason === 'dangerous-disabled')

      await check(
        '不存在"直接设定所有权"的 API',
        `typeof window.hermes.setGatewayOwnership`,
        v => v === 'undefined')

      await check(
        'openPath 白名单外的路径 → 必须被拒绝',
        `window.hermes.openPath('C:\\\\Windows\\\\System32\\\\calc.exe')`,
        v => v && v.ok === false && v.reason === 'path-not-allowed')

      await check(
        '普通只读接口仍然可用（未被误伤）',
        `window.hermes.get('/api/status').then(r => r && r.ok === true)`,
        v => v === true)

      await check(
        'gatewayStatus() 能读到真实实例身份',
        `window.hermes.gatewayStatus().then(r => r && r.instance && typeof r.instance.pid === 'number')`,
        v => v === true)

      // ---- 阶段 4.2.1 新增：授权与身份核对 ----
      await check(
        '签发一次性授权 → 响应中不得出现任何 token 值',
        `window.hermes.gatewayAuthorizeOnce('drain').then(r => JSON.stringify(r))`,
        v => typeof v === 'string' && !/token/i.test(v) && JSON.parse(v).ok === true)

      await check(
        '一次性授权已绑定目标实例（pid 与当前实例一致）',
        `Promise.all([window.hermes.authorizationState(), window.hermes.gatewayStatus()])
           .then(([a, s]) => !!(a.pending && a.target && s.instance && a.target.pid === s.instance.pid))`,
        v => v === true)

      await check(
        'OS 进程核对可用：返回单实例且进程创建时间与状态文件一致',
        `window.hermes.gatewayStatus().then(r => !!(r.probe && r.probe.instanceCount === 1
           && r.probe.proc && r.probe.proc.exists === true
           && typeof r.probe.proc.startMs === 'number'
           && r.instance && Math.abs(r.probe.proc.startMs - r.instance.startMs) <= 3000))`,
        v => v === true)

      await check(
        '清理授权后不再有挂起的授权',
        `(async () => { await window.hermes.clearAuthorization();
            const a = await window.hermes.authorizationState(); return a.pending === false })()`,
        v => v === true)

      // ---- 阶段「控制台收尾」新增：能力探测 / 死 UI / OPEN-1 文案 ----
      await check(
        'capabilities() 返回外部工程与额外 Profile 的真实状态对象',
        `window.hermes.capabilities().then(c => !!(c && c.external && c.profile
           && typeof c.external.installed === 'boolean' && typeof c.profile.installed === 'boolean'))`,
        v => v === true)

      await check(
        'openCapability 只接受固定 id（非法 id 必须被拒绝）',
        `window.hermes.openCapability('../../windows/system32').then(r => !!(r && r.ok === false))`,
        v => v === true)

      await check(
        '「扩展能力」页真实存在且可切换',
        `(typeof switchPage === 'function') && !!document.getElementById('page-capabilities')
           && (switchPage('capabilities'), document.getElementById('page-capabilities').classList.contains('active'))`,
        v => v === true)

      await check(
        '★ Agent 页字段已由真实数据填充（不再永久 —）',
        `(async () => { switchPage('agent'); await refreshAll(); 
            return document.getElementById('agentActive').textContent !== '—' })()`,
        v => v === true)

      await check(
        '★ 网关说明不含"关闭控制台将/也会停止它"（自动停止已禁用）',
        `(async () => { switchPage('overview'); await refreshAll();
            const t = document.getElementById('gwNote').textContent;
            return !t.includes('关闭控制台将停止它') && !t.includes('关闭控制台也会停止它')
              && (t.includes('不会停止它') || t.includes('自动停止')) })()`,
        v => v === true)

      await check(
        '★ 扩展能力页不含占位文案「下一阶段接入」',
        `(async () => { switchPage('capabilities'); await loadCapabilities();
            return !document.body.innerText.includes('下一阶段接入') })()`,
        v => v === true)

      // ---- 最终完工轮：启动/退出/认证/危险操作闸门 ----
      await check(
        '★ 服务列表含各 Profile 独立网关（不串线）',
        `window.hermes.services().then(r => { const ids = (r.services || []).map(s => s.id);
           return ids.includes('gateway:default') && (!${JSON.stringify(extraProfileId())} || ids.includes('gateway:' + ${JSON.stringify(extraProfileId())})) && typeof r.anyRunning === 'boolean' })`,
        v => v === true)

      await check(
        '★ 未知 Profile 启动必须被拒绝（不伪造成功）',
        `window.hermes.startProfile('__nope__')`,
        v => v && v.ok === false && (v.reason === 'unknown-profile' || v.reason === 'profile-missing'))

      await check(
        '★ 已运行的 Gateway 不得被重复启动（未运行时跳过，绝不触发启动）',
        `window.hermes.services().then(r => { const d = (r.services || []).find(s => s.id === 'gateway:default');
           if (!d || !d.running) return 'skip';
           return window.hermes.startProfile('default').then(x => x.reason) })`,
        v => v === 'already-running' || v === 'skip')

      await check(
        '★ 退出决策 IPC 可用（取消返回 cancelled，不关闭窗口）',
        `window.hermes.exitDecision('cancel').then(r => !!(r && r.ok && r.cancelled))`,
        v => v === true)

      // 注意：断言按「凭据**形态**」判定，而不是禁词。
      // 官方原因文本会出现 "No access token found …" 这类**状态描述**（非凭据值），
      // 若按词禁用会造成误报并丢失必要诊断信息。参见既有安全扫描器的同类教训。
      await check(
        '★ 认证信息按 Profile 返回、含 provider/model、且不含任何凭据值',
        `window.hermes.authInfo().then(r => !!(r && Array.isArray(r.profiles) && r.profiles.length === 2
           && r.profiles.every(p => typeof p.id === 'string' && typeof p.state === 'string'
                && 'provider' in p && 'model' in p && 'callability' in p)
           && !/eyJ[A-Za-z0-9_-]{8,}\\.|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|(token|secret|password|bearer|cookie)\\s*[:=]\\s*\\S/i.test(JSON.stringify(r))))`,
        v => v === true)

      await check(
        '★ 认证信息读到各 Profile 的真实 Provider（不写死任何具体 Provider）',
        `window.hermes.authInfo().then(r => { const m = {}; (r.profiles || []).forEach(p => { m[p.id] = p.provider })
           return Object.keys(m).length >= 1 && Object.keys(m).every(k => typeof m[k] === 'string' && m[k].length > 0) })`,
        v => v === true)

      await check(
        '★ 认证命令预检（dry-run）不下发凭据、不改 Provider、不启动终端',
        `window.hermes.authStart(${JSON.stringify(extraProfileId())}, { dryRun: true }).then(r => !!(r && r.ok && r.dryRun
           && /hermes( --profile \S+)? auth add \S+ --type oauth/.test(r.display)
           && !/token|secret|password/i.test(JSON.stringify(r))))`,
        v => v === true)

      await check(
        '★ 未知 Provider / 未知 Profile 的认证请求被拒绝',
        `Promise.all([window.hermes.authStart('nope', { dryRun: true }),
                       window.hermes.authInfo('nope')]).then(([a, b]) =>
           a && a.ok === false && a.reason === 'unknown-profile' && b && b.profiles.length === 0)`,
        v => v === true)

      await check(
        '★ 退出提示与认证弹窗 DOM 真实存在（含开始认证/取消）',
        `!!document.getElementById('exitModal') && !!document.getElementById('authModal')
           && !!document.getElementById('btnExitOnly') && !!document.getElementById('btnStartDefault')
           && !!document.getElementById('btnAuthStart') && !!document.getElementById('btnAuthCancel')`,
        v => v === true)

      await check(
        '★ 停止/重启按钮已禁用（统一闸门在界面侧的提示）',
        `(async () => { switchPage('overview'); await refreshAll();
           const a = document.getElementById('btnGwStop').disabled;
           const b = document.getElementById('btnGwRestart').disabled; return a && b })()`,
        v => v === true)

      // ---- 最小复核轮：额外 Profile 陈旧状态不再阻止启动（dry-run 预检，不启动进程）----
      await check(
        '★ 额外 Profile 陈旧状态不再阻止启动（dry-run 预检通过，未实际启动）',
        `window.hermes.services().then(rs => {
           const eid = ${JSON.stringify(extraProfileId())}
           if (!eid) return 'skip'
           const c = (rs.services || []).find(s => s.id === 'gateway:' + eid)
           if (!c || c.running) return 'skip'
           return window.hermes.startProfile(eid, { dryRun: true }).then(r => r.allow)
         })`,
        v => v === true || v === 'skip')

      await check(
        '★ 已在运行的 Profile 预检必须拒绝（dry-run：already-running）',
        `window.hermes.startProfile('default', { dryRun: true })
           .then(r => r.allow === false && r.reason === 'already-running')`,
        v => v === true)

      const passCount = results.filter(r => r.pass).length
      try {
        fs.writeFileSync(selftestOut, JSON.stringify({
          at: new Date().toISOString(),
          pass: passCount,
          fail: results.length - passCount,
          results
        }, null, 2), 'utf8')
        log(`[selftest] 完成：${passCount}/${results.length} 通过 → ${selftestOut}`)
      } catch (err) { log(`[selftest] 写结果失败: ${err.message}`) }

      // 走【真实退出路径】：app.quit() 会触发 before-quit 中的所有权核验与决策日志，
      // 这样自检同时验证了「退出行为」而不只是安全边界。
      // 注：自检/截图属于无人值守模式，直接放行关闭（不进入交互式退出提示）。
      forceQuit = true
      app.quit()
    })
  }
}

// ---------------------------------------------------------------------------
// IPC（全部为具名白名单方法，renderer 无法发起任意请求）
// ---------------------------------------------------------------------------
ipcMain.handle('console:bootstrap', () => getBootstrapInfo())

ipcMain.handle('console:restartBackend', () => {
  stopBackend()
  state.port = null
  setTimeout(startBackend, 800)
  return getBootstrapInfo()
})

ipcMain.handle('hermes:get', async (_e, apiPath, params) => {
  const data = await callApi('GET', apiPath, { params })
  return { ok: true, data }
})

ipcMain.handle('hermes:post', async (_e, apiPath, body) => {
  const data = await callApi('POST', apiPath, { body })
  return { ok: true, data }
})

// ---- 网关危险操作（全部经过主进程授权门）-------------------------------

/** 只读：返回当前所有权（按 Profile）、核验状态与 OS 进程核对结果，供界面展示 */
ipcMain.handle('gateway:status', async () => {
  const byProfile = {}
  for (const p of PROFILES) {
    const inst = ownedOf(p.id)
    const cur = readProfileGateway(p)
    const v = await verifyOwnership(p.id)
    byProfile[p.id] = {
      profile: p.id,
      owned: !!inst,
      mode: inst ? 'owned' : 'unknown',
      instance: inst,
      // ★ 与 bootstrap 同源：本控制台最近一次登记失败（用于如实显示"停止权限未确认"，
      //   而不是把它一律说成"非本控制台启动"）
      registerFailure: state.lastRegisterByProfile[p.id] || null,
      verify: { ok: v.ok, reason: v.reason, detail: v.detail || null },
      gateway: cur ? { pid: cur.pid, running: cur.running, alive: cur.alive } : null
    }
  }
  const cur = readGatewayIdentity()
  const ctx = await probe.buildVerifyContext(cur)
  return {
    byProfile,
    instance: cur,
    ownership: {
      byProfile,
      ownedProfiles: Object.keys(state.ownedByProfile).filter(id => ownedOf(id)),
      preExisting: state.preExisting
    },
    // 如实暴露的能力边界与剩余风险（供界面/审查者读取，不做美化）
    capability: {
      autoStop: ALLOW_AUTO_STOP,
      autoStopReason: ALLOW_AUTO_STOP
        ? null
        : '官方 stop 为 profile 级、无 PID 参数，检查与执行之间存在无法消除的竞态；该路径尚未通过真实端到端验收，故自动停止已禁用',
      residualRisk: 'profile-level-stop-race',
      guarantee: '核验只能证明"此刻目标身份识别正确"，不能证明"执行时只会停止该实例"'
    },
    // OS 层面的真实核对结果（不是状态文件的复述）
    probe: {
      instanceCount: ctx.instanceCount,
      proc: ctx.proc,
      error: ctx.probeError
    },
    preExisting: state.preExisting,
    lastVerify: state.lastVerify,
    lastProbe: state.lastProbe,
    authorization: state.authorization
      ? { action: state.authorization.action, issuedAt: state.authorization.issuedAt, consumed: state.authorization.consumed }
      : null
  }
})

/** 清空挂起的一次性授权（用户取消操作、或界面关闭确认框时调用） */
ipcMain.handle('gateway:clearAuthorization', () => {
  if (state.authorization) {
    log(`清空挂起的一次性授权: action=${state.authorization.action}（未使用）`)
    state.authorization = null
  }
  return { ok: true }
})

/**
 * A：由本控制台启动网关并取得所有权。
 * 前置条件：当前没有运行中的网关。若已有网关在跑，拒绝 —— 不对共享实例动手。
 */
ipcMain.handle('gateway:adopt', async () => {
  if (!ALLOW_DANGEROUS_EXEC) {
    log('接管操作被闸门拒绝（ALLOW_DANGEROUS_EXEC=false）')
    return {
      ok: false,
      reason: 'dangerous-disabled',
      message: '「启动并接管（A）」本轮未授权：接管的实质是启动真实网关并取得其所有权，' +
        '需先通过真实端到端验收。请改用「扩展能力」页中的按 Profile 手动启动入口。'
    }
  }
  const before = readGatewayIdentity()
  if (before) {
    return { ok: false, reason: 'already-running', instance: before,
             message: '检测到已有网关在运行（共享实例）。本控制台不会接管它。' }
  }
  try {
    await callApi('POST', '/api/gateway/start', { internal: true, timeoutMs: 30000 })
  } catch (err) {
    return { ok: false, reason: 'start-failed', message: err.message }
  }
  // 等待新实例出现并读取其身份
  const deadline = Date.now() + 20000
  let inst = null
  while (Date.now() < deadline) {
    inst = readGatewayIdentity()
    if (inst && inst.pid) break
    await new Promise(r => setTimeout(r, 600))
  }
  if (!inst || !inst.pid) {
    return { ok: false, reason: 'identity-unavailable',
             message: '网关已请求启动，但无法读取到实例身份，因此【不取得所有权】（无法可靠确认则拒绝）。' }
  }
  // ★ 归属到身份所属的 Profile（home 决定），不再写进单一槽位
  const prof = PROFILES.find(p => p.home && own.sameHome(p.home, inst.hermesHome))
  if (!prof) {
    return { ok: false, reason: 'profile-unknown',
             message: '实例主目录不属于任何已知 Profile，因此【不取得所有权】。' }
  }
  const reg = await registerOwnershipFor(prof)   // 先核验再登记
  if (!reg.acquired) return { ok: false, reason: reg.reason, message: reg.message }
  log(`取得所有权（接管）: profile=${prof.id} ${own.describeIdentity(reg.instance)}`)
  return { ok: true, instance: reg.instance, profile: prof.id }
})

/** 释放所有权（不停止网关）：默认释放 default；可指定 profileId 只释放目标 Profile */
ipcMain.handle('gateway:release', (_e, profileId) => {
  const id = profileId || 'default'
  log(`释放所有权: profile=${id}`)
  releaseOwnership(id)
  state.authorization = null
  if (!hasAnyOwned()) stopWatchdog()
  return { ok: true, profile: id }
})

/** C：签发一次性授权（绑定当前目标实例；仅放行一次指定动作，不产生所有权） */
ipcMain.handle('gateway:authorizeOnce', (_e, action) => {
  if (!own.DANGEROUS_ACTIONS.includes(action)) {
    return { ok: false, reason: 'bad-action' }
  }
  const a = issueAuthorization(action)
  if (!a) {
    return {
      ok: false,
      reason: 'identity-incomplete',
      message: '当前无法确认网关实例身份，已拒绝签发授权（无法可靠确认则拒绝）。'
    }
  }
  // **不把 token 下发渲染进程** —— 渲染层无需持有它，也无法用它绕过授权门
  return {
    ok: true,
    action: a.action,
    issuedAt: a.issuedAt,
    expiresInMs: 5 * 60 * 1000,
    target: { pid: a.target.pid, startMs: a.target.startMs }
  }
})

/** 查询当前一次性授权状态（不含任何 token 值） */
ipcMain.handle('gateway:authorizationState', () => {
  const a = state.authorization
  if (!a) return { pending: false }
  return {
    pending: !a.consumed,
    action: a.action,
    issuedAt: a.issuedAt,
    ageMs: Date.now() - a.issuedAt,
    target: { pid: a.target.pid, startMs: a.target.startMs }
  }
})

/** 危险操作统一入口：先过授权门，再调用官方接口 */
const DENY_MESSAGES = {
  'no-ownership': '本控制台未持有该网关实例（共享服务），已拒绝自动停止。',
  'probe-failed': '无法可靠读取网关身份，出于安全考虑拒绝执行。',
  'identity-incomplete': '实例身份信息不完整（缺少有效启动时间或主目录），无法确认目标，已拒绝执行。',
  'instance-changed': '网关实例已变化（被重启或 PID 复用），所有权失效，已拒绝执行。',
  'process-absent': '操作系统中找不到该 PID 的进程（状态文件可能已陈旧），已拒绝执行。',
  'process-mismatch': '操作系统记录的进程创建时间与状态文件不一致（疑似 PID 复用），已拒绝执行。',
  'process-time-unavailable': '无法读取该进程的操作系统创建时间，无法排除 PID 复用，已拒绝执行。',
  'process-probe-failed': '无法核对该进程在操作系统中的真实身份，已拒绝执行。',
  'multiple-instances': '同 profile 检测到多个网关进程。官方 gateway stop 无法指定 PID（只能按 profile 停止），无法保证只停目标实例，已拒绝执行。',
  'instance-count-unknown': '无法确认同 profile 的网关进程数量，无法保证只停目标实例，已拒绝执行。',
  'instance-count-invalid': '网关进程计数异常，已拒绝执行。',
  'auth-expired': '一次性授权已过期（5 分钟有效），请重新确认操作。',
  'auth-consumed': '该一次性授权已被使用过，请重新确认操作。',
  'auth-action-mismatch': '该授权对应的是其它动作，已拒绝执行。',
  'auth-no-target': '该授权未绑定目标实例，已拒绝执行。',
  'auth-target-changed': '授权绑定的目标实例已变化，已拒绝执行（请重新确认）。',
  'unsupported-action': '不支持的动作，已拒绝执行。'
}

async function runDangerous(action, opts) {
  // ★ RC 轮：闸门释放判定（纯函数 ownership.decideStopRelease，与看门狗共用同一模块规则）
  //   · restart / drain / 接管：仍由 ALLOW_DANGEROUS_EXEC=false 一律拒绝；
  //   · stop：仅当 ALLOW_OWNED_STOP 且控制台持有所有权（A 态）时放行到授权门。
  const targetProfileId = opts && opts.profileId
  // ★ 按目标 Profile 判定：只有该 Profile 有登记时才可能放行（各 Profile 互不干扰）
  const release = own.decideStopRelease({
    action,
    allowDangerousExec: ALLOW_DANGEROUS_EXEC,
    allowOwnedStop: ALLOW_OWNED_STOP,
    hasOwned: !!ownedOf(targetProfileId)
  })
  if (!release.allow) {
    log(`危险操作被闸门拒绝: action=${action} profile=${String(targetProfileId)} reason=${release.reason}`)
    return {
      ok: false,
      reason: release.reason,
      profile: targetProfileId || null,
      message: release.reason === 'no-ownership'
        ? `停止能力仅对本控制台亲自启动并持有的网关实例（A 态）开放；` +
          `当前未持有 ${String(targetProfileId || '目标')} Profile 的网关（或归属不明），已拒绝。` +
          '共享网关请在其启动方（终端 / 会话）中停止，控制台不会代停。'
        : '重启 / 排空 Gateway 未开放：尚未通过真实端到端验收（官方 stop 为 profile 级，存在竞态）。'
    }
  }
  const g = await authorizeDangerous(action, targetProfileId)
  if (!g.allowed) {
    return {
      ok: false,
      reason: g.reason,
      profile: targetProfileId || null,
      detail: g.detail || null,
      message: DENY_MESSAGES[g.reason] || `授权被拒绝：${g.reason}`
    }
  }
  // ★ stop（新路径）：只接受所有权核验（via='ownership'）；
  //   即便未来误把一次性授权签发给 stop，也不允许经 C 路径停止（用户明确的边界）。
  if (action === 'stop' && !ALLOW_DANGEROUS_EXEC && g.via !== 'ownership') {
    log(`停止被拒: 授权方式=${g.via} 不属于所有权路径`)
    return {
      ok: false,
      reason: 'owned-only',
      message: '停止仅支持「本控制台启动并持有」的所有权路径（A 态），已拒绝其它授权方式。'
    }
  }
  if (action === 'stop' && !ALLOW_DANGEROUS_EXEC) {
    return execOwnedStopCli(targetProfileId, g)
  }
  try {
    const api = action === 'drain' ? '/api/gateway/drain'
      : action === 'restart' ? '/api/gateway/restart'
        : '/api/gateway/stop'
    const t0 = Date.now()
    await callApi('POST', api, { internal: true, timeoutMs: 30000 })
    log(`危险操作完成: action=${action} via=${g.via} 耗时=${Date.now() - t0}ms` +
        (g.residualRisk ? ` 剩余风险=${g.residualRisk}` : ''))
    return { ok: true, via: g.via, instance: g.instance, residualRisk: g.residualRisk || null }
  } catch (err) {
    // 失败/超时：授权已在判定通过时消费，不会留下可复用的授权
    log(`危险操作失败: action=${action} 错误类型=${err.name || 'Error'} 消息=${err.message}`)
    return { ok: false, reason: 'call-failed', message: `网关操作失败或超时：${err.message}（授权已作废，如需重试请重新确认）` }
  }
}

/**
 * RC 轮新增：以官方 CLI 停止「本控制台持有」的网关实例。
 *
 * 为什么不走后端 API /api/gateway/stop：
 *   后端 serve 绑定 default profile 的 HERMES_HOME，该端点只会停 default 网关；
 *   若持有的是非 default 实例，调它会**误停 default**——因此统一走官方 CLI，
 *   `--profile` 由所有权记录的 hermesHome 反查得出，**不接受渲染层传入**。
 *
 * 执行前后均复核：
 *   ① 目标 Profile 与所有权记录一致（`verifyStopTarget`），且状态文件里的实例没漂到别的 Profile；
 *   ② 活跃任务（`gateway_state.json.active_agents`）：>0 → 拒绝；**未知 → 一律拒绝并暂停真实验收**
 *      （**不允许**用界面上的"人工确认"强行继续）；
 *   ③ 执行前身份比对（`sameIdentity`）；
 *   ④ 执行后 **OS 级** 验证（`decideStopVerification`）：退出码 0 + 探测成功 +
 *      **目标 PID 已消失** + **同 Profile 剩余 Gateway 进程数为 0** + 状态文件未与 OS 结论矛盾；
 *      判定**只认最新 OS 进程数据**，不把状态文件当作"已停止"的依据。
 *
 * 失败语义（一律 fail-closed，不谎报成功）：
 *   · 命中 `PID file race lost` → `pid-file-race-lost` + 安全恢复指引，**不自动重试**；
 *   · 上述任一条件未知或不满足 → `stop-unverified`（附 `verifyReason` 与 `verifyAfter` 明细）。
 *
 * 审计日志只记动作 / 时间 / 目标身份 / 退出码 / 复核结果，不含任何 token。
 */
async function execOwnedStopCli(targetProfileId, auth) {
  const owned = ownedOf(targetProfileId)
  if (!owned) return { ok: false, reason: 'no-ownership', message: '所有权记录已失效，已拒绝执行。' }
  const prof = PROFILES.find(p => p.home && own.sameHome(p.home, owned.hermesHome))
  if (!prof) {
    log(`停止拒绝: 所有权记录的主目录不属于已知 Profile home=${owned.hermesHome}`)
    return { ok: false, reason: 'owned-profile-unknown', message: '所有权记录的主目录不属于本控制台已知的 Profile，已拒绝执行。' }
  }

  // 执行前最后一次身份 + 目标 Profile 复核（授权门刚做过 fresh 核验，这里是双保险）
  let cur = null
  try { cur = readProfileGateway(prof) } catch {}
  const curProf = (cur && cur.identity && cur.identity.hermesHome)
    ? PROFILES.find(p => p.home && own.sameHome(p.home, cur.identity.hermesHome))
    : null
  const tgt = own.verifyStopTarget({
    ownedProfileId: prof.id,
    targetProfileId: prof.id,                    // 由所有权记录反查得出，不接受渲染层传参
    currentProfileId: curProf ? curProf.id : null
  })
  if (!tgt.ok) {
    log(`停止拒绝: 目标 Profile 复核未通过 reason=${tgt.reason}`)
    return { ok: false, reason: tgt.reason, message: '停止目标 Profile 与所有权记录不一致（或实例已漂移），已拒绝执行。' }
  }
  if (cur && cur.identity && !own.sameIdentity(cur.identity, owned)) {
    log('停止拒绝: 执行前身份复核发现实例已变化')
    return { ok: false, reason: 'instance-changed', message: DENY_MESSAGES['instance-changed'] }
  }

  // ★ 活跃任务复核（保证"活跃任务不被无提示中断"）
  const statePath = path.join(prof.home, 'gateway_state.json')
  const activeTasks = own.summarizeActiveTasks(readJsonIfExists(statePath))
  // ★ 活跃任务未知 → 真实验收**暂停**：不提供任何"人工确认继续"的绕行
  const taskDecision = own.decideActiveTaskStop({
    known: activeTasks.known,
    activeAgents: activeTasks.activeAgents
  })
  if (!taskDecision.allow) {
    log(`停止拒绝: 活跃任务复核未通过 reason=${taskDecision.reason} profile=${prof.id}` +
        ` known=${activeTasks.known} active=${activeTasks.activeAgents}`)
    return {
      ok: false,
      reason: taskDecision.reason,
      activeTasks,
      message: taskDecision.reason === 'active-tasks'
        ? `该网关仍有 ${activeTasks.activeAgents} 个活跃 Agent 会话，已拒绝停止（不做强制覆盖）。` +
          `请等这些任务结束（或由你在终端自行处理）后重试。`
        : '无法从状态文件确认活跃任务数（字段缺失/不可读）—— 真实验收在此暂停，已拒绝停止。' +
          '界面确认不能替代这一判断；请先让该网关空闲并用官方命令复核活跃数后重试。'
    }
  }

  const args = ['--profile', prof.id, 'gateway', 'stop']
  log(`执行停止: profile=${prof.id} 目标=${own.describeIdentity(owned)} via=${auth && auth.via}` +
      ` 活跃复核=${taskDecision.reason}(active=${activeTasks.known ? activeTasks.activeAgents : '未知'})` +
      (auth && auth.residualRisk ? ` 剩余风险=${auth.residualRisk}` : ''))
  const t0 = Date.now()
  let exitCode = null
  let stdout = ''
  let stderr = ''
  let errMsg = null
  try {
    const r = await new Promise((resolve, reject) => {
      const child = spawn(HERMES_EXE, args, {
        cwd: APP_DIR,                    // 不在符号链接目录下执行（历史坑：静默失败）
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })
      let so = '', se = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        reject(new Error('超时（60s）'))
      }, 60000)
      child.stdout.on('data', d => { so += String(d) })
      child.stderr.on('data', d => { se += String(d) })
      child.on('error', err => { clearTimeout(timer); reject(err) })
      child.on('exit', code => { clearTimeout(timer); resolve({ code, so, se }) })
    })
    exitCode = r.code; stdout = r.so; stderr = r.se
  } catch (err) {
    errMsg = err.message
  }
  log(`停止命令返回: exit=${exitCode} 耗时=${Date.now() - t0}ms${errMsg ? ` 错误=${errMsg}` : ''}` +
      (stdout ? ` 输出=${stdout.trim().slice(0, 200)}` : '') +
      (stderr ? ` stderr=${stderr.trim().slice(0, 200)}` : ''))

  // 停止后复核（1/2）：状态文件（先看官方是否已经改写了它）
  let after = null
  try { after = readProfileGateway(prof) } catch {}
  const stillSame = !!(after && after.identity && own.sameIdentity(after.identity, owned))

  // 停止后复核（2/2）：**OS 级**验证 —— 目标 PID 是否真的在操作系统里消失
  let osProbeError = null
  let osPidStillAlive = null
  let sameProfileProcesses = null
  let allProcs = []
  try {
    const ctx = await probe.buildVerifyContext(null, { force: true })
    osProbeError = ctx.probeError || null
    if (!osProbeError) {
      allProcs = ctx.all || []
      osPidStillAlive = allProcs.some(x => Number(x.pid) === Number(owned.pid))
      // ★ 同 Profile 口径：官方 stop 是 profile 级，判定分母必须是"该 Profile 的实例数"，
      //   否则另一个 Profile 的网关会让 default 的停止被误判成"未确认"
      sameProfileProcesses = profileInstanceCount(ctx, prof.id)
    }
  } catch (err) {
    osProbeError = err.message
  }
  // ★ 身份冲突 vs 记录陈旧（2026-09-22 严格区分）：
  //   · 陈旧：状态文件仍记着**同一个、其进程已消失的实例** —— 官方 stop 不清理 gateway_state.json，
  //           实测（pid 20508）确证如此 ⇒ 只作**独立警告**，不影响成功判定；
  //   · 冲突：状态文件指向**另一个仍然存活的实例**（原实例已被替换）⇒ **拒绝**成功判定。
  const afterIdent = (after && after.identity) || null
  const afterIdentAlive = !!(afterIdent && typeof afterIdent.pid === 'number' &&
    allProcs.some(x => Number(x.pid) === Number(afterIdent.pid)))
  const identityConflict = !!(afterIdent && !own.sameIdentity(afterIdent, owned) && afterIdentAlive)
  const verifyAfter = {
    running: !!(after && after.running),
    identityGone: !(after && after.identity),
    stillSameInstance: stillSame,
    identityConflict,
    osPidStillAlive,
    sameProfileProcesses,
    osProbeError
  }
  const race = own.judgePidFileRace(stderr, stdout, errMsg)
  if (race.raceLost) {
    log(`停止失败：检测到 PID file race lost（不自动重试）profile=${prof.id}`)
    return { ok: false, reason: 'pid-file-race-lost', verifyAfter, message: race.guidance }
  }
  if (errMsg) {
    return { ok: false, reason: 'stop-command-failed', message: `停止命令未能执行：${errMsg}（请查看运行日志）`, verifyAfter }
  }
  // ★ 成功判定统一交给纯函数：必须以**最新 OS 进程数据**为准（不依赖状态文件）
  const verdict = own.decideStopVerification({
    exitCode,
    osProbeError,
    osPidStillAlive,
    sameProfileProcesses,
    stateFileStillSame: stillSame,
    identityConflict
  })
  if (!verdict.verified) {
    log(`停止未确认: profile=${prof.id} reason=${verdict.reason} ` +
        `verifyAfter=${JSON.stringify(verifyAfter)}`)
    return {
      ok: false,
      reason: 'stop-unverified',
      verifyReason: verdict.reason,
      message: own.STOP_VERIFY_MESSAGES[verdict.reason] ||
        '停止结果未确认 —— 不视为成功，请手动核实进程与日志。',
      verifyAfter
    }
  }
  // 目标已消失且同 Profile 无其它网关实例：所有权记录随之作废（实例不存在了，持有无意义）
  releaseOwnership(prof.id)
  // ★ 陈旧状态文件作为**独立警告**上报（不改变成功结论；控制台不改写、不删除该文件）
  const warnCodes = verdict.warnings || []
  const warnMessages = warnCodes.map(w => own.STOP_VERIFY_WARNINGS[w]).filter(Boolean)
  log(`停止完成并经 OS 级复核: profile=${prof.id} 目标 PID ${owned.pid} 已不存在；` +
      `同 profile 剩余网关实例数=${sameProfileProcesses}` +
      (warnCodes.length ? ` 警告=${warnCodes.join(',')}` : ''))
  return {
    ok: true,
    via: auth && auth.via,
    profile: prof.id,
    verifyReason: verdict.reason,
    verifyWarnings: warnCodes,
    warningMessages: warnMessages,
    residualRisk: (auth && auth.residualRisk) || null,
    verifyAfter
  }
}

// opts 目前不承载任何放行语义：**界面确认不构成授权，也不能绕过活跃任务未知时的暂停**。
// 权限判定只在授权门（authorizeDangerous + decideStopRelease），复核判定只在 decideStopVerification。
ipcMain.handle('gateway:stop', (_e, opts) => runDangerous('stop', opts))
ipcMain.handle('gateway:restart', () => runDangerous('restart'))
ipcMain.handle('gateway:drain', () => runDangerous('drain'))

/**
 * 读取网关元信息（PID / 启动时间）。仅读取本机状态文件，不涉及任何凭据。
 * gateway_state.json 的 start_time 形如 epoch_seconds*100，这里做兼容与合理性校验。
 */
ipcMain.handle('console:gatewayMeta', () => {
  try {
    const p = path.join(HERMES_HOME, 'gateway_state.json')
    if (!fs.existsSync(p)) return null
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    let startMs = null
    const raw = j.start_time
    if (typeof raw === 'number' && raw > 0) {
      // gateway_state.json 的 start_time 形如 epoch_seconds*100。不猜格式，
      // 依次尝试几种常见量级，取第一个落在合理年份区间的结果。
      for (const cand of [raw, raw / 100, raw / 1000, raw / 1e6]) {
        const d = new Date(cand * 1000)
        const y = d.getFullYear()
        if (y >= 2020 && y <= 2100) { startMs = d.getTime(); break }
      }
    }
    return {
      pid: typeof j.pid === 'number' ? j.pid : null,
      startMs,
      state: j.gateway_state ?? null,
      exitReason: j.exit_reason ?? null,
      platforms: j.platforms ?? null,
      hermesHome: j.hermes_home ?? null
    }
  } catch (err) {
    log(`读取 gateway_state.json 失败: ${err.message}`)
    return null
  }
})

ipcMain.handle('console:openLogsFolder', () => { shell.openPath(LOG_DIR); return true })

// ---------------------------------------------------------------------------
// 扩展能力探测（外部工程 / 额外 Profile）—— 只读
//
// 目标：如实回答「本地是否存在、是否就绪、是否在运行、配置在哪」，
//       并给出一个真实可用的目录入口。**绝不假设它们已在运行。**
// 安全：仅读取文件系统存在性与进程列表（只读查询），不启动、不停止、不读凭据。
// ---------------------------------------------------------------------------
let _capCache = { at: 0, value: null }
const CAP_CACHE_MS = 8000
const _capInflight = { p: null }

/** 运行一段 PowerShell（只读查询用）；失败返回 ok:false，由调用方标为「未验证」 */
function runPowerShell(script, timeoutMs = 15000) {
  return new Promise(resolve => {
    const root = process.env.SystemRoot || 'C:\\Windows'
    const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve({ ok: !err, out: String(stdout || ''), error: err ? err.message : null }))
    } catch (e) { resolve({ ok: false, out: '', error: e.message }) }
  })
}

/** 有界递归统计 SKILL.md 数量（避免全盘扫描） */
function countSkillFiles(root, maxDepth = 2) {
  let n = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && /^skill\.md$/i.test(e.name)) n++
      else if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return n
}

/** PID 是否真实存在（含 EPERM=存在但无权限） */
function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 按命令行子串探测进程（只读）。返回 {ok, count, pids, error}
 *
 * ⚠️ 必须排除「正在执行本次查询的 PowerShell 进程自身」：
 *    查询脚本的参数里含有被搜索的子串，若不排除，PowerShell 会匹配到自己的命令行，
 *    从而**永远返回"找到 1 个进程"** —— 这会伪造成"外部工程 正在运行"。
 *    （网关探测用双 token 正则恰好规避了此问题；此处用显式排除更稳妥。）
 */
async function probeProcessesByCmdline(substr) {
  const esc = String(substr).replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$p=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${esc}*' -and $_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh|conhost)' })`,
    "ConvertTo-Json -InputObject @{count=$p.Count;pids=@($p | ForEach-Object { $_.ProcessId })} -Compress -Depth 4"
  ].join(';')
  const r = await runPowerShell(script)
  if (!r.ok) return { ok: false, count: null, pids: [], error: r.error || '探测失败' }
  const txt = r.out.trim()
  if (!txt) return { ok: true, count: 0, pids: [] }
  try {
    const j = JSON.parse(txt)
    const pids = Array.isArray(j.pids) ? j.pids : (j.pids ? [j.pids] : [])
    return { ok: true, count: typeof j.count === 'number' ? j.count : pids.length, pids }
  } catch (e) { return { ok: false, count: null, pids: [], error: '输出解析失败' } }
}

/**
 * 探测两个扩展能力的真实状态。
 * 结果带缓存（8s），且同一时刻只允许一个探测在飞（避免并发 PowerShell）。
 */
async function detectCapabilities() {
  const now = Date.now()
  if (_capCache.value && now - _capCache.at < CAP_CACHE_MS) return _capCache.value
  if (_capInflight.p) return _capInflight.p

  _capInflight.p = (async () => {
    // ---- EXTERNAL：外部工程 ----
    const acInstalled = fs.existsSync(EXTERNAL_DIR)
    const acModule = acInstalled && fs.existsSync(path.join(EXTERNAL_DIR, 'src'))
    const acVenv = acInstalled && fs.existsSync(path.join(EXTERNAL_DIR, '.venv', 'Scripts', 'python.exe'))
    const acLauncher = acInstalled && fs.existsSync(path.join(EXTERNAL_DIR, 'launcher.bat'))
    let acProc = { ok: false, count: null, pids: [], error: '未探测' }
    if (acInstalled && EXTERNAL_PROC_HINT) acProc = await probeProcessesByCmdline(EXTERNAL_PROC_HINT)

    // ---- 额外 Profile：Hermes Profile ----
    const cjDir = extraProfileHome()
    const cjInstalled = !!cjDir && fs.existsSync(cjDir)
    // 深度 3：Hermes 的技能布局为 skills/<分类>/<技能>/SKILL.md（部分为 分类/子类/技能/SKILL.md）
    const cjSkills = cjInstalled ? countSkillFiles(path.join(cjDir, 'skills'), 3) : 0
    const cjConfig = cjInstalled && fs.existsSync(path.join(cjDir, 'config.yaml'))
    let cjGw = null
    if (cjInstalled) {
      const st = readJsonIfExists(path.join(cjDir, 'gateway_state.json'))
      if (st && typeof st.pid === 'number') {
        const alive = pidAlive(st.pid)
        cjGw = { pid: st.pid, state: st.gateway_state || null, alive, stale: !alive, updatedAt: st.updated_at || null }
      } else {
        cjGw = { pid: null, state: null, alive: false, stale: true, updatedAt: null }
      }
    }

    const value = {
      at: new Date().toISOString(),
      external: {
        id: 'external',
        label: '外部工程（可选）',
        installed: !!(acInstalled && acModule),
        repo: EXTERNAL_DIR,
        moduleReady: acModule,
        venvReady: acVenv,
        launcherPresent: acLauncher,
        running: acProc.ok ? (acProc.count > 0) : null,   // null = 未验证
        runningPids: acProc.ok ? acProc.pids : [],
        probeError: acProc.ok ? null : (acProc.error || '未验证'),
        entryLabel: '打开项目目录'
      },
      profile: {
        id: 'profile',
        label: '额外 Profile',
        installed: cjInstalled,
        profileDir: cjDir,
        skillsCount: cjSkills,
        configPresent: cjConfig,
        gateway: cjGw,
        entryLabel: '打开 Profile 目录'
      }
    }
    _capCache = { at: Date.now(), value }
    return value
  })()

  try { return await _capInflight.p } finally { _capInflight.p = null }
}

ipcMain.handle('console:capabilities', () => detectCapabilities())

/** 打开扩展能力目录（固定目录，不接受 renderer 任意路径） */
ipcMain.handle('console:openCapability', (_e, id) => {
  const target = id === 'external'
    ? EXTERNAL_DIR
    : id === 'profile' ? extraProfileHome() : null
  if (!target || !fs.existsSync(target)) return { ok: false, reason: 'not-found' }
  shell.openPath(target)
  return { ok: true, path: target }
})

// ---------------------------------------------------------------------------
// Profile 注册表 · 运行态服务 · 按 Profile 手动启动
//
// 概念严格区分（不可混淆）：
//   Gateway —— 消息服务（profile 级，一个 Profile 一个常驻进程）
//   Profile —— 独立配置与运行环境（config / skills / memories）
//   Skill   —— Agent 使用的能力（不是"一个 Skill 一个 Gateway"）
//   外部工程 Worker/GUI —— 独立业务程序（非 Hermes 组件）
//
// 本控制台提供：Gateway 的「按 Profile 手动启动」+ 只读状态 +
// （RC 轮起）「本控制台启动并持有实例」的手动停止（ALLOW_OWNED_STOP，见文件头部说明）。
// 重启 / 排空 / 接管仍被 ALLOW_DANGEROUS_EXEC=false 闸门拒绝。
// ---------------------------------------------------------------------------
/**
 * Profile 注册表：**运行时发现**，不写死任何私有 Profile 名。
 *   - `default`  —— Hermes 主目录本身
 *   - 其余       —— `HERMES_HOME/profiles/<name>` 下的真实子目录（按名字排序）
 * 因此在一台只有默认 Profile 的机器上，列表里只有 `default`；
 * 任何额外的私有 Profile 名都不会出现在公开代码里。
 */
function discoverProfiles() {
  const list = []
  if (HERMES_HOME) {
    list.push({ id: 'default', label: 'default', home: HERMES_HOME, desc: 'Hermes 默认 Profile' })
  }
  if (PROFILES_DIR) {
    try {
      const names = fs.readdirSync(PROFILES_DIR).filter(n => n !== 'default').sort()
      for (const name of names) {
        const home = path.join(PROFILES_DIR, name)
        try { if (!fs.statSync(home).isDirectory()) continue } catch { continue }
        list.push({ id: name, label: name, home, desc: `profiles/${name}` })
      }
    } catch { /* profiles 目录不可读 → 只保留 default */ }
  }
  return list
}

const PROFILES = discoverProfiles()

/** 第一个「非 default」Profile（没有则 null） */
function extraProfile() { return PROFILES.find(p => p.id !== 'default') || null }
function extraProfileHome() { const p = extraProfile(); return p ? p.home : null }
function extraProfileId() { const p = extraProfile(); return p ? p.id : null }

function profileById(id) { return PROFILES.find(p => p.id === String(id)) || null }

// ---------------------------------------------------------------------------
// 模型认证（只读展示 + 官方命令构造）
//
//  原则（本轮授权范围）：
//   1. Provider / 模型 一律**从各 Profile 的 config.yaml 实际读取**，不沿用任何历史结论。
//      只读文件**头部**若干字节（`model:` 块在最前面），避免把后面的凭据段载入内存。
//   2. 认证状态只来自**官方只读命令** `hermes [--profile X] auth status <provider>`。
//   3. 控制台**不读取、不打印、不复制、不收集**任何 Token / Cookie / 密码 / 密钥；
//      官方输出的原因文本也会再过一遍脱敏兜底。
//   4. 控制台**不代跑** OAuth：只打开独立终端，把**官方命令**交给用户本人执行。
// ---------------------------------------------------------------------------
const CONFIG_HEAD_BYTES = 8192

/** 读取某 Profile 的 provider / model（只读头部；不载入凭据段） */
function readProfileModel(profile) {
  const empty = { provider: null, model: null, configPresent: false }
  if (!profile || !profile.home) return empty
  const cfg = path.join(profile.home, 'config.yaml')
  let fd = null
  try {
    if (!fs.existsSync(cfg)) return empty
    fd = fs.openSync(cfg, 'r')
    const buf = Buffer.alloc(CONFIG_HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, CONFIG_HEAD_BYTES, 0)
    const parsed = auth.parseModelHead(buf.slice(0, n).toString('utf8'))
    return { provider: parsed.provider, model: parsed.model, configPresent: true }
  } catch (err) {
    log(`读取 ${profile.id} 的模型配置失败：${err.message}`)
    return { ...empty, configPresent: true }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

/** 执行 Hermes CLI 并捕获输出（只读用途；不写任何凭据） */
function execHermesCapture(argv, profileHome, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now()
    try {
      execFile(HERMES_EXE, argv, {
        cwd: profileHome || undefined,
        timeout: timeoutMs || 20000,
        windowsHide: true,
        maxBuffer: 1 << 20,
        env: { ...process.env, HERMES_HOME: profileHome || HERMES_HOME || '', PYTHONIOENCODING: 'utf-8' }
      }, (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : (err ? -1 : 0)
        resolve({
          ok: !err, code,
          stdout: String(stdout || ''), stderr: String(stderr || ''),
          ms: Date.now() - started
        })
      })
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((err && err.message) || ''), ms: Date.now() - started })
    }
  })
}

/** Profile 的认证状态缓存（避免频繁拉起 Python 子进程） */
const AUTH_CACHE_MS = 12000
const _authCache = new Map()   // profileId -> { at, value }

/** 汇总单个 Profile 的认证信息（只读；可作为「重新检测」） */
async function collectAuthInfo(profile, force) {
  const cached = _authCache.get(profile.id)
  if (!force && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.value

  const cfg = readProfileModel(profile)
  const provider = cfg.provider
  const meta = auth.providerAuth(provider)

  let cliState = 'unknown', cliReason = '', cliOk = null, ms = null
  if (provider) {
    const inv = auth.buildStatusInvocation(profile.id, provider)
    const r = await execHermesCapture(inv.argv, profile.home, 20000)
    ms = r.ms
    // 只在主进程内做**状态语义**解析；绝不把原始输出下发给 renderer，也绝不写日志
    const parsed = auth.parseAuthStatus(r.ok ? r.stdout : '')
    cliOk = r.ok && parsed.state !== 'unknown'
    cliState = parsed.state
    cliReason = r.ok ? parsed.reason : `官方状态查询失败（退出码 ${r.code}）`
  }

  // 交叉核对：仅 default Profile 有网关 API 的会话证据
  let apiState = null
  if (profile.id === 'default') {
    try {
      const st = await callApi('GET', '/api/status', { timeoutMs: 6000 })
      apiState = (st && st.nous_session_valid) ? st.nous_session_valid : null
    } catch { apiState = null }
  }

  const d = auth.decideAuthState({ cliState, cliReason, cliOk, apiState })
  const inv = provider ? auth.buildAuthInvocation(provider, profile.id) : { ok: false }

  const value = {
    id: profile.id,
    label: profile.label,
    home: profile.home,
    configPresent: cfg.configPresent,
    provider,
    providerLabel: meta ? meta.label : (provider || '未识别'),
    model: cfg.model,
    state: d.state,             // valid | expired | unverified
    reliable: d.reliable,
    expired: d.expired,
    reason: auth.sanitizeReason(d.reason),
    methodLabel: meta ? meta.methodLabel : null,
    officialCommand: inv.ok ? inv.display : null,
    alias: inv.ok ? inv.alias : null,
    note: inv.ok ? inv.note : '暂不支持为该 Provider 自动构造官方认证命令（可复制命令到终端手动执行）。',
    apiState,
    callability: auth.callabilityNote(d.state),
    queryMs: ms,
    checkedAt: Date.now()
  }
  _authCache.set(profile.id, { at: Date.now(), value })
  return value
}

/**
 * 读取某 Profile 网关的运行态：状态文件（`gateway.pid` / `gateway_state.json` / `gateway.lock`）
 * + **操作系统进程实际存在性**（不只信状态文件）。
 *
 * 只读官方实现后的关键事实（决定"陈旧是否算障碍"）：
 *   官方 `gateway/status.py::get_running_pid()` 以 **runtime lock 是否被活进程持有** 为准；
 *   锁文件存在但可被重新获取（记录进程已死）→ 判定未运行 → 官方守卫放行，
 *   启动时覆盖陈旧的 pid/lock/state。故这里把「陈旧」作为**信息**（stale），而非**拒绝理由**。
 */
function readProfileGateway(profile) {
  const base = { id: profile.id, label: profile.label, home: profile.home, exists: fs.existsSync(profile.home) }
  if (!base.exists) return { ...base, running: false, stale: false, probeOk: true, detail: 'Profile 目录不存在' }

  const inst = own.readIdentity(profile.home)                          // gateway.pid + gateway_state.json（两处 pid 一致才可信）
  const lock = readJsonIfExists(path.join(profile.home, 'gateway.lock'))

  const recordedPid = inst && typeof inst.pid === 'number' ? inst.pid : null
  const lockPid = lock && typeof lock.pid === 'number' ? lock.pid : null
  // 身份读取失败（损坏/不一致）**不代表**一定在运行，也不代表一定没运行 → 用 lock 兜底、并标 stale
  const recordedPidLive = recordedPid === null ? null : pidAlive(recordedPid)
  const lockPidLive = lockPid === null ? null : pidAlive(lockPid)

  const running = recordedPidLive === true || lockPidLive === true
  const hasRecord = recordedPid !== null || lockPid !== null
  const stale = !running && hasRecord && (recordedPidLive === false || lockPidLive === false)
  const showPid = recordedPid !== null ? recordedPid : lockPid

  return {
    ...base,
    running,
    stale,
    probeOk: true,
    pid: showPid,
    recordedPid,
    lockPid,
    recordedPidLive,
    lockPidLive,
    startMs: inst ? inst.startMs : null,
    state: running ? (inst && inst.kind ? inst.kind : 'running') : (stale ? 'stale' : 'stopped'),
    identity: inst,
    detail: running
      ? `pid ${recordedPidLive === true ? recordedPid : lockPid}`
      : (stale
          ? `状态文件记录 pid ${showPid}，但该进程已不存在（记录已过期；能否启动以启动时的实测结果为准）`
          : '未记录运行中的网关（视为未运行）')
  }
}

/** 汇总"仍在运行的相关服务"，供退出提示与能力页展示（只读） */
async function getRuntimeServices() {
  // RC 轮：stoppable = 该 profile 的网关正在运行 **且** 本控制台持有其所有权（A 态，按 Profile 分槽）
  // ⚠️ 用 sameHome 比较"是否指向同一真实目录"：符号链接 / junction 与真实路径属同一目录
  const ownedHomes = Object.values(state.ownedByProfile)
    .filter(Boolean)
    .map(i => i.hermesHome)
  const services = []
  for (const p of PROFILES) {
    const g = readProfileGateway(p)
    const isOwned = !!(ownedHomes.length && p.home && ownedHomes.some(h => own.sameHome(h, p.home)))
    services.push({
      id: 'gateway:' + p.id, kind: 'gateway', profile: p.id, label: p.label + ' · Gateway',
      running: !!g.running, detail: g.detail,
      stoppable: !!(ALLOW_OWNED_STOP && g.running && isOwned),
      stoppableReason: !g.running ? null
        : isOwned ? null
          : (state.lastRegisterByProfile[p.id]
              ? '网关运行中 · 停止权限未确认（本控制台启动但登记未成功：' +
                (state.lastRegisterByProfile[p.id].reason || '原因未知') + '）—— 控制台不停止该实例'
              : '非本控制台启动的实例（共享，B 态）—— 控制台不停止共享网关，请在其启动方停止')
    })
  }
  try {
    const caps = await detectCapabilities()
    const ac = caps.external || {}
    services.push({
      id: 'worker:external', kind: 'worker', profile: null, label: '外部工程（可选）',
      running: ac.running === true,
      detail: ac.running === true ? `检测到运行中的进程（pid ${(ac.runningPids || []).join(', ') || '未知'}）`
        : ac.running === false ? '未检测到运行中的进程' : '运行状态未验证',
      stoppable: false,
      stoppableReason: '独立业务程序，控制台不终止其进程'
    })
  } catch { /* 能力探测失败不阻塞退出提示 */ }
  return { services, anyRunning: services.some(s => s.running), at: new Date().toISOString() }
}

ipcMain.handle('console:services', () => getRuntimeServices())

/**
 * 按 Profile 手动启动 Gateway（本轮唯一保留的写操作）。
 *
 * 前置校验（全部通过才启动，否则拒绝并说明原因）：
 *   1. Profile 必须存在且已注册   2. Profile 目录与 config.yaml 必须存在
 *   3. 必须**未运行**（gateway.pid / gateway.lock / OS 进程三重核对）—— 已运行返回 already-running，
 *      **绝不** --replace / 强杀 / 隐式重启
 *   4. 状态文件记录了**已死**的 PID（记录已过期）→ **本函数不据此拒绝**，
 *      但**不承诺**启动一定成功：结果为"以真实探测为准"。
 *      ⚠️ 不得使用「陈旧状态一定不影响启动 / 官方会自动覆盖」这类绝对表述：
 *      官方是否成功重建 pid/lock/state 取决于它自己的锁判定，且可能报 `PID file race lost`。
 *      控制台不手工删除状态文件、不强杀进程；命中 race lost 时只给**安全恢复指引**，**不自动重试**。
 * 启动方式：以 `hermes --profile <id> gateway run` **分离**运行（detached + unref），
 *   与官方服务启动器一致地设置 HERMES_GATEWAY_DETACHED=1 —— 进程不依赖控制台存活。
 *   子进程 stdout/stderr 写入控制台日志目录，便于在失败时判定真实原因（例如 race lost）。
 * 复核：轮询真实进程与状态文件，只有两者都确认才返回成功。
 */
ipcMain.handle('gateway:startProfile', async (_e, id, opts) => {
  const p = profileById(id)
  if (!p) return { ok: false, reason: 'unknown-profile', message: '未知的 Profile。' }

  const profileExists = fs.existsSync(p.home)
  const configExists = profileExists && fs.existsSync(path.join(p.home, 'config.yaml'))
  const cur = profileExists ? readProfileGateway(p) : { recordedPidLive: null, lockPidLive: null }

  // 用与单测共用的同一套纯判定：记录进程已死不阻止启动；已运行 / 探测不可用才拒绝
  const d = own.decideProfileStart({
    profileExists,
    configExists,
    recordedPidLive: cur.recordedPidLive,
    lockPidLive: cur.lockPidLive,
    probeAvailable: true
  })
  // 启动前实测事实（界面须逐项如实展示，不得简化为"不影响启动"）
  const precheck = {
    profileExists,
    configExists,
    recordedPid: cur.recordedPid != null ? cur.recordedPid : null,
    recordedPidLive: cur.recordedPidLive === undefined ? null : cur.recordedPidLive,
    lockPid: cur.lockPid != null ? cur.lockPid : null,
    lockPidLive: cur.lockPidLive === undefined ? null : cur.lockPidLive,
    staleRecord: !!d.stale
  }
  // dry-run：只跑前置校验并回报判定，**不启动任何进程**（供自检/人工预检使用）
  if (opts && opts.dryRun) {
    log(`启动预检（dry-run）: profile=${p.id} allow=${d.allow} reason=${d.reason} stale=${d.stale}`)
    return {
      dryRun: true, profile: p.id, allow: d.allow, reason: d.reason, stale: d.stale, precheck,
      message: d.allow
        ? `预检通过：Profile 存在 ✓ / 配置文件存在 ✓ / ` +
          `记录 PID ${precheck.recordedPid ?? '无'}（${precheck.recordedPidLive === false ? '已不存在 ✓' : precheck.recordedPidLive === true ? '⚠ 仍存活' : '无记录'}）/ ` +
          `锁 PID ${precheck.lockPid ?? '无'}（${precheck.lockPidLive === false ? '已不存在 ✓' : precheck.lockPidLive === true ? '⚠ 仍被持有' : '无记录'}）。` +
          `${d.stale ? '存在已过期的记录 —— 它本身不是拒绝理由，但**能否启动以实际结果为准**。' : ''}未实际启动。`
        : `预检拒绝：${d.reason}`
    }
  }
  if (!d.allow) {
    const MSG = {
      'profile-missing': `Profile 目录不存在：${p.home}`,
      'config-missing': `未找到配置文件：${path.join(p.home, 'config.yaml')}（拒绝启动）。`,
      'already-running': `${p.label} 的 Gateway 已在运行（pid ${cur.pid}），未重复启动。`,
      'probe-failed': `无法可靠判定 ${p.label} 是否已在运行，出于安全考虑拒绝启动。`
    }
    return { ok: false, reason: d.reason, message: MSG[d.reason] || `拒绝启动：${d.reason}`, precheck }
  }
  if (d.stale) {
    log(`检测到 ${p.id} 的过期记录（记录进程已死）：recordedPid=${precheck.recordedPid} ` +
        `lockPid=${precheck.lockPid} → 允许尝试启动；能否成功以真实探测为准，` +
        `控制台不删除状态文件、不强杀进程`)
  }

  log(`手动启动请求：profile=${p.id} home=${p.home} stale=${d.stale}`)
  // 打开一个日志文件承接子进程输出（不依赖 stdio:'ignore'，以便失败时判定真实原因）
  let outFd = null
  const startLog = path.join(LOG_DIR, 'gateway-start-stdio.log')
  try { outFd = fs.openSync(startLog, 'a') } catch (err) { log(`启动日志文件打开失败（改为忽略子进程输出）: ${err.message}`) }
  let child
  try {
    child = spawn(HERMES_EXE, ['--profile', p.id, 'gateway', 'run'], {
      cwd: p.home,
      env: {
        ...process.env,
        HERMES_HOME: p.home,
        PYTHONIOENCODING: 'utf-8',
        HERMES_GATEWAY_DETACHED: '1'   // 与官方服务启动器一致的分离标记
      },
      detached: true,
      windowsHide: true,
      stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd]
    })
    child.unref()
  } catch (err) {
    log(`手动启动失败（spawn 异常）: ${err.message}`)
    return { ok: false, reason: 'spawn-failed', message: `无法启动：${err.message}`, precheck }
  } finally {
    // 父进程不再持有该 fd（子进程已继承）
    if (outFd !== null) { try { fs.closeSync(outFd) } catch {} }
  }

  // 复核：真实进程 + 状态文件，两者都确认才算成功（不看命令退出码）
  // ⚠️ 这里是**单次等待**，不做自动重试（命中 race lost 时按安全恢复指引交用户处理）
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 800))
    const now = readProfileGateway(p)
    if (now.running && now.pid) {
      log(`手动启动成功：profile=${p.id} pid=${now.pid}`)
      // ★ 登记所有权：先核验身份（PID + 创建时间 + home + 单实例），再登记；
      //   核验不过 → 不谎称已取得所有权，界面显示"运行中，停止权限未确认"。
      const reg = await registerOwnershipFor(p, { startedByUs: true, expectedPid: now.pid })
      return {
        ok: true, profile: p.id, pid: now.pid, precheck, ownership: reg,
        message: reg.acquired
          ? `${p.label} 的 Gateway 已启动（pid ${now.pid}），并已确认本控制台持有（A 态，停止按钮已可用）。`
          : (reg.pending
              ? `${p.label} 的 Gateway 已启动（pid ${now.pid}），正在确认停止权限：${reg.message}`
              : `${p.label} 的 Gateway 已启动（pid ${now.pid}），但停止权限未确认：${reg.message || '请稍后刷新或查看日志'}`)
      }
    }
  }
  // 未观测到运行中的网关 → 读子进程输出判定真实原因（不重试、不清理任何文件/进程）
  let tail = ''
  try { tail = fs.readFileSync(startLog, 'utf8').slice(-4000) } catch {}
  const race = own.judgePidFileRace(tail)
  if (race.raceLost) {
    log(`手动启动失败：检测到 PID file race lost（不自动重试，不删除状态文件，不强杀进程）profile=${p.id}`)
    return {
      ok: false, reason: 'pid-file-race-lost', precheck,
      message: `${p.label} 的启动失败：${race.guidance}`
    }
  }
  log(`手动启动未确认：profile=${p.id}（25s 内未观测到运行中的进程）`)
  return {
    ok: false, reason: 'verify-timeout', precheck,
    message: `${p.label} 的启动请求已发出，但 25 秒内未观测到运行中的网关进程。` +
      `未确认成功 —— 请查看该 Profile 的日志或用官方命令核对（详见 logs/gateway-start-stdio.log）。`
  }
})

/**
 * 模型认证信息（**按 Profile** 只读）。
 *   - provider / model：从该 Profile 的 config.yaml 实读（不吃历史结论）
 *   - 认证状态：官方只读命令 `hermes [--profile X] auth status <provider>`
 *   - 不下发任何原始 CLI 输出，不下发任何凭据
 * 入参：可选 profileId；不传则返回全部 Profile（供页面一次渲染）。
 */
ipcMain.handle('console:authInfo', async (_e, profileId, opts) => {
  const force = !!(opts && opts.force)
  const list = profileId ? [profileById(profileId)].filter(Boolean) : PROFILES
  const out = []
  for (const p of list) {
    try { out.push(await collectAuthInfo(p, force)) }
    catch (err) {
      log(`读取 ${p.id} 的认证信息失败：${err.message}`)
      out.push({
        id: p.id, label: p.label, home: p.home, provider: null, providerLabel: '未识别', model: null,
        state: 'unverified', reliable: false, expired: false,
        reason: `读取失败：${err.message}`, officialCommand: null, alias: null,
        note: '无法读取该 Profile 的认证信息。', callability: auth.callabilityNote('unverified')
      })
    }
  }
  return { profiles: out, guidance: '认证由**官方 CLI** 完成：控制台只打开独立终端并展示官方命令，不会收集密码 / 令牌，不会展示任何凭据，也不会自动切换 Provider。' }
})

/**
 * 「开始认证」—— 打开**独立终端**执行官方 OAuth（交互式，由用户本人完成）。
 *
 * 安全约束：
 *   1. 命令来自白名单（auth.buildAuthInvocation），**不接受 renderer 传入任意命令**；
 *   2. 控制台**不参与** OAuth：不收集任何输入、不模拟网页登录、不读取回调结果；
 *   3. 不停止/重启任何网关，不修改 Provider 选择，不碰其它 Profile 的认证配置；
 *   4. 支持 dryRun（供自检/人工预检），dryRun 不启动任何进程。
 */
const _authLaunch = { at: 0 }   // 重复点击保护：短时间内只允许打开一次终端

ipcMain.handle('console:authStart', async (_e, profileId, opts) => {
  const p = profileById(profileId)
  if (!p) return { ok: false, reason: 'unknown-profile', message: '未知的 Profile。' }
  if (!fs.existsSync(p.home)) {
    return { ok: false, reason: 'profile-missing', message: `Profile 目录不存在：${p.home}` }
  }

  const cfg = readProfileModel(p)
  const inv = auth.buildAuthInvocation(cfg.provider, p.id)
  if (!inv.ok || !cfg.provider) {
    return {
      ok: false, reason: 'unsupported-provider',
      provider: cfg.provider || null,
      message: `暂不支持为 ${cfg.provider || '未识别的 Provider'} 自动构造官方认证命令。` +
        `请用官方方式手动认证（hermes auth --help）。`
    }
  }

  if (opts && opts.dryRun) {
    log(`认证命令预检（dry-run）: profile=${p.id} provider=${inv.provider} cmd="${inv.display}"（未启动终端）`)
    return {
      dryRun: true, ok: true, profile: p.id, provider: inv.provider,
      display: inv.display, argv: inv.argv, methodLabel: inv.methodLabel,
      message: `预检通过：将在独立终端执行 ${inv.display}（dry-run 未启动）。`
    }
  }

  if (Date.now() - _authLaunch.at < 3000) {
    return { ok: false, reason: 'too-frequent', message: '刚刚已打开过认证终端，请先在终端中完成或关闭它。' }
  }
  _authLaunch.at = Date.now()

  // 打开独立终端（`start` 后第一个参数是窗口标题，故留空），把官方命令交给用户执行。
  // 终端保持打开（/k），便于用户看清官方输出与后续提示。
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', inv.display], {
      cwd: p.home,
      env: { ...process.env, HERMES_HOME: p.home, PYTHONIOENCODING: 'utf-8' },
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    })
    child.unref()
  } catch (err) {
    log(`打开认证终端失败: profile=${p.id} provider=${inv.provider} err=${err.message}`)
    return { ok: false, reason: 'spawn-failed', message: `无法打开终端：${err.message}` }
  }

  log(`已打开官方认证终端: profile=${p.id} provider=${inv.provider} cmd="${inv.display}"`)
  return {
    ok: true, profile: p.id, provider: inv.provider, display: inv.display,
    methodLabel: inv.methodLabel,
    message: `已打开独立终端并载入官方命令：${inv.display}。请在该终端中完成官方 OAuth 授权；` +
      `完成后回到本窗口点「重新检测」。控制台不参与认证过程，也不会收集任何凭据。`
  }
})

// ---------------------------------------------------------------------------
// 多来源日志读取（**只读**）
//
// 严格区分四类来源，绝不把 default 的日志冒充其它 Profile：
//   default —— Hermes 默认 Profile 的 logs/
//   profile —— 第一个非 default Profile 的 logs/（与 default 完全独立）
//   external —— 外部工程 的流水线日志（**不是 Hermes 组件**）
//   console —— 本控制台自身的运行日志
//
// 安全约束：
//   1. 路径**只能**由「来源 id + 文件 id」在固定白名单里解析，不接受 renderer 传任意路径
//   2. 仅读取（readFileSync），**绝不**写入、截断、清空或删除日志
//   3. 只读文件尾部有限字节，避免超大日志拖垮界面
// ---------------------------------------------------------------------------
const LOG_SOURCE_ROOTS = {
  default: HERMES_HOME ? path.join(HERMES_HOME, 'logs') : null,
  profile: extraProfileHome() ? path.join(extraProfileHome(), 'logs') : null,
  external: EXTERNAL_DIR ? path.join(EXTERNAL_DIR, 'logs') : null,
  console: LOG_DIR
}
// 少数不在 logs/ 下的文件单独登记（外部工程 的 commands.log 在工程根）
const LOG_FILE_OVERRIDES = {
  'external:commands': EXTERNAL_DIR ? path.join(EXTERNAL_DIR, 'commands.log') : null
}
const LOG_MAX_BYTES = 2 * 1024 * 1024 // 尾部最多读 2MB

/** 由「来源 + 文件」解析出绝对路径；不在白名单则返回 null（不兜底、不拼接用户输入） */
function resolveLogPath(sourceId, fileId) {
  const src = logsrc.sourceById(sourceId)
  if (!src) return null
  if (!src.files.some(f => f.id === String(fileId))) return null
  const override = LOG_FILE_OVERRIDES[`${src.id}:${fileId}`]
  if (override) return override
  const root = LOG_SOURCE_ROOTS[src.id]
  if (!root) return null
  if (src.id === 'console') {
    // 控制台日志按日期命名，取当天；不存在则由调用方按“无数据”处理
    return path.join(root, `console-${new Date().toISOString().slice(0, 10)}.log`)
  }
  return path.join(root, `${fileId}.log`)
}

/** 只读文件尾部（含单行过长保护）；返回 {ok, text, size, mtime, truncated, error} */
function readLogTail(filePath, maxBytes = LOG_MAX_BYTES) {
  const out = { ok: false, text: '', size: 0, mtime: null, truncated: false, error: null, path: filePath }
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) { out.error = 'not-a-file'; return out }
    out.size = st.size
    out.mtime = st.mtime.toISOString()
    const start = st.size > maxBytes ? st.size - maxBytes : 0
    out.truncated = start > 0
    const fd = fs.openSync(filePath, 'r')
    try {
      const len = st.size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      out.text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    // 截断过的首行可能不完整 → 丢掉首行，避免展示半行
    if (out.truncated) {
      const nl = out.text.indexOf('\n')
      if (nl >= 0) out.text = out.text.slice(nl + 1)
    }
    out.ok = true
  } catch (err) {
    out.error = err.code || err.message
  }
  return out
}

/** 来源/文件清单 + 每个文件的真实状态（用于三态显示：离线 / 读取失败 / 无数据） */
ipcMain.handle('console:logSources', () => {
  const sources = logsrc.LOG_SOURCES.map(s => ({
    id: s.id,
    label: s.label,
    note: s.note,
    root: LOG_SOURCE_ROOTS[s.id] || null,
    files: s.files.map(f => {
      const p = resolveLogPath(s.id, f.id)
      const meta = { id: f.id, label: f.label, path: p, exists: false, size: 0, mtime: null, readable: false }
      if (p) {
        try {
          const st = fs.statSync(p)
          meta.exists = st.isFile()
          meta.size = st.size
          meta.mtime = st.mtime.toISOString()
          fs.accessSync(p, fs.constants.R_OK)
          meta.readable = true
        } catch (err) {
          meta.error = err.code || err.message
        }
      } else {
        meta.error = 'path-unresolved'
      }
      return meta
    })
  }))
  return { sources, maxBytes: LOG_MAX_BYTES }
})

/** 读取 + 解析 + 过滤 + 折叠（纯读取，无副作用） */
ipcMain.handle('console:readLogs', (_e, opts) => {
  const o = opts || {}
  const src = logsrc.sourceById(o.source)
  if (!src) return { ok: false, reason: 'unknown-source', message: '未知的日志来源。' }
  const fileMeta = src.files.find(f => f.id === String(o.file))
  if (!fileMeta) return { ok: false, reason: 'unknown-file', message: '该来源下没有这个日志文件。' }

  const target = resolveLogPath(src.id, o.file)
  if (!target) return { ok: false, reason: 'path-unresolved', message: '无法解析该日志路径（路径未登记）。' }

  const read = readLogTail(target, Math.min(Number(o.maxBytes) || LOG_MAX_BYTES, LOG_MAX_BYTES))
  if (!read.ok) {
    return {
      ok: false,
      reason: read.error === 'ENOENT' ? 'offline' : 'read-failed',
      message: read.error === 'ENOENT' ? '日志文件不存在（该来源可能尚未运行过）。' : `读取失败：${read.error}`,
      path: target,
      sourceLabel: src.label,
      fileLabel: fileMeta.label
    }
  }

  const all = logsrc.parseLog(read.text)
  const filtered = logsrc.filterRecords(all, {
    minLevel: o.minLevel,
    search: o.search,
    since: o.since,
    until: o.until,
    jobId: o.jobId,
    withinMinutes: o.withinMinutes ? Number(o.withinMinutes) : null
  })
  const lines = Math.max(1, Math.min(Number(o.lines) || 500, 5000))
  // 排序在「取窗口」之前：默认最新在前，才能保证看到的是最近的 N 行
  const order = String(o.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
  const ordered = logsrc.sortRecords(filtered, order)
  const sliced = ordered.slice(0, lines)
  const groups = logsrc.collapseRepeats(sliced, { minRepeat: Number(o.minRepeat) || 3 })
    // 解释与级别标签统一在主进程算好（renderer 不保留第二份解释表，避免两处漂移）
    .map(g => ({
      ...g,
      levelZh: logsrc.levelZh(g.level),
      explain: logsrc.levelRank(g.level) >= logsrc.LEVEL_RANK.WARNING
        ? logsrc.explainMessage(g.message, g.level)
        : null
    }))

  return {
    ok: true,
    source: src.id,
    sourceLabel: src.label,
    file: fileMeta.id,
    fileLabel: fileMeta.label,
    path: target,
    total: all.length,
    matched: filtered.length,
    shown: sliced.length,
    order,
    groups,
    stages: logsrc.stageSummary(sliced),
    levelCounts: logsrc.levelCounts(sliced),
    latestTs: logsrc.latestTsMs(all),
    fileSize: read.size,
    fileMtime: read.mtime,
    truncated: read.truncated,
    updatedAt: new Date().toISOString()
  }
})

/** 外部工程 作业登记（只读 jobs 目录下的作业 JSON）→ 供按 job_id 关联与时间线展示 */
ipcMain.handle('console:coverJobs', (_e, opts) => {
  const o = opts || {}
  const limit = Math.max(1, Math.min(Number(o.limit) || 50, 200))
  const jobsRoot = EXTERNAL_DIR ? path.join(EXTERNAL_DIR, 'jobs') : null
  if (!jobsRoot || !fs.existsSync(jobsRoot)) {
    return { ok: false, reason: 'offline', message: '未找到 外部工程 作业目录。', jobs: [] }
  }
  const jobs = []
  for (const stateDir of logsrc.JOB_STATES) {
    const dir = path.join(jobsRoot, stateDir)
    let names = []
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')) } catch { continue }
    for (const n of names) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
        const s = logsrc.summarizeJob(obj, stateDir)
        if (s) jobs.push(s)
      } catch { /* 单个作业读取失败不影响其余 */ }
    }
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  const view = jobs.slice(0, limit).map(j => ({
    ...j,
    axes: logsrc.jobStateView(j),
    timeline: logsrc.jobTimeline(j)
  }))
  return { ok: true, jobs: view, total: jobs.length, updatedAt: new Date().toISOString() }
})

/** 脱敏后复制到剪贴板（复制前强制脱敏，绝不外传明文凭据） */
ipcMain.handle('console:copyRedacted', (_e, text) => {
  try {
    const safe = logsrc.redactText(String(text == null ? '' : text))
    clipboard.writeText(safe)
    return { ok: true, redacted: true, length: safe.length }
  } catch (e) {
    return { ok: false, message: e.message }
  }
})

/**
 * 受限的 openPath：只允许打开白名单目录内的路径。
 * 不再允许 renderer 传入任意路径（避免被用作任意文件/程序启动器）。
 */
// 白名单目录：控制台日志、应用目录、Hermes 主目录，以及两个只读的扩展能力目录
const OPENABLE_ROOTS = [LOG_DIR, APP_DIR, HERMES_HOME, EXTERNAL_DIR, PROFILES_DIR]
  .filter(Boolean).map(p => path.resolve(p))
ipcMain.handle('console:openPath', (_e, p) => {
  const target = path.resolve(String(p || ''))
  const inside = OPENABLE_ROOTS.some(root => target === root || target.startsWith(root + path.sep))
  if (!inside) {
    log(`openPath 被拒绝（不在白名单目录内）: ${target}`)
    return { ok: false, reason: 'path-not-allowed' }
  }
  shell.openPath(target)
  return { ok: true }
})
ipcMain.handle('console:openExternal', (_e, url) => {
  const s = String(url || '')
  if (/^https?:\/\//i.test(s)) shell.openExternal(s)
  return true
})

/** 复制文本到剪贴板（仅用于把官方命令交给用户，不涉及任何凭据） */
ipcMain.handle('console:copy', (_e, text) => {
  try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true } }
  catch (e) { return { ok: false, message: e.message } }
})

ipcMain.handle('window:control', (_e, action) => {
  const w = BrowserWindow.getFocusedWindow() || mainWindow
  if (!w) return false
  if (action === 'minimize') w.minimize()
  else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize()
  else if (action === 'close') w.close()
  return w.isMaximized()
})

/**
 * 探测"启动本控制台时网关是否已在运行"。
 * 必须在后端就绪之后再调用 —— 过早调用会因后端未起而失败，
 * 导致所有权说明错误地显示为"尚未确认"。
 * 只探测一次（gatewayPreExisted 一旦有值即返回）。
 */
async function probeGatewayPreExisted() {
  if (state.preExisting !== null) return
  try {
    // ★ 改用 OS 核验的网关状态判定"启动前是否已存在"，而非 serve /api/status
    //   （避免控制台自身 serve 与真实 Gateway 耦合，正是此前状态不一致的诱因之一）
    const def = profileById('default')
    const g = def ? readProfileGateway(def) : { running: false }
    if (g.running) {
      // B：记录既有共享实例的身份（只记录，不据为己有）
      state.preExisting = readGatewayIdentity()
      log(`启动时网关已存在（共享实例，不取得所有权）: pid=${st.gateway_pid || '-'} ` +
          `start=${state.preExisting ? state.preExisting.startMs : '未记录'}`)
    } else {
      state.preExisting = false
      log('启动时网关未运行（此刻若由本控制台启动，可取得所有权）')
    }
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('backend:state', getBootstrapInfo()))
  } catch (err) {
    log(`探测初始网关状态失败（稍后重试）: ${err.message}`)
    if (state.retryPreExisted === undefined) state.retryPreExisted = 0
    if (state.retryPreExisted < 5 && state.backendState === 'ready') {
      state.retryPreExisted += 1
      setTimeout(probeGatewayPreExisted, 2500)
    }
  }
}

// ---------------------------------------------------------------------------
// 启动 / 退出
// ---------------------------------------------------------------------------
const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  app.whenReady().then(async () => {
    log('=== Hermes 控制台启动 ===')
    state.staleOwnership = detectStaleOwnership()
    if (state.staleOwnership) {
      log(`检测到上次会话遗留的所有权记录（控制台 pid=${state.staleOwnership.record.consolePid} 已不在），` +
          `对应网关 pid=${state.staleOwnership.instance.pid}。仅提示，不自动停止。`)
    }
    startBackend()
    createWindow()

    // 「启动时网关是否已存在」的判定改由 probeGatewayPreExisted() 在后端就绪后执行
    // （过早探测会因 hermes serve 尚未起而失败，导致所有权说明不可信）

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', async event => {
    if (state.quitting) return
    event.preventDefault()
    state.quitting = true
    log('开始退出流程')

    // 1) 退出时的归属判定。分两种情况：
    //
    //    (a) ALLOW_AUTO_STOP = false（**当前默认**）：
    //        只做核验并写审计日志，**绝不调用 stop**。原因是自动停止依赖的
    //        profile 级 stop 存在无法消除的竞态（见 ALLOW_AUTO_STOP 注释），
    //        且该路径尚未通过真实端到端验收。
    //    (b) ALLOW_AUTO_STOP = true（需显式开启并另行验收）：核验通过才停止。
    //
    //    两种情况下的核验内容相同：实例身份完整且一致 + 操作系统进程核对通过
    //    + 同 profile 实例数恰好为 1。任一不满足即不停止。
    //
    //    ⚠️ 即使核验通过，也**只是"目标识别正确"**，不构成
    //       "只会停止该实例"的保证 —— 官方 stop 无 PID 参数，检查与执行之间存在
    //       本进程无法消除的竞态。同 profile 出现多实例时我们直接拒绝。
    // 1) 退出时的归属判定（按 Profile 逐一核验；当前 ALLOW_AUTO_STOP=false 只记录不停止）
    const ownedIds = Object.keys(state.ownedByProfile).filter(id => ownedOf(id))
    for (const id of ownedIds) {
      const v = await verifyOwnership(id, { fresh: true })
      if (ALLOW_AUTO_STOP) {
        if (v.ok) {
          try {
            log(`退出：所有权核验通过 ${own.describeIdentity(v.instance)}，请求停止网关 profile=${id}`)
            await callApi('POST', '/api/gateway/stop', { internal: true, timeoutMs: 25000 })
            log('退出：网关停止请求已完成')
            releaseOwnership(id)
          } catch (err) {
            // 停止失败/超时：保留所有权记录，供下次启动提示人工处理
            log(`退出：停止网关失败或超时 —— 错误类型=${err.name || 'Error'} 消息=${err.message}`)
            log('退出：已保留所有权记录，下次启动会提示，不自动重试停止')
          }
        } else {
          log(`退出：所有权核验未通过（原因=${v.reason}` +
              (v.detail ? ` 细节=${v.detail}` : '') + `），拒绝停止网关 profile=${id}`)
        }
      } else {
        // 自动停止被禁用：完整记录核验结果，但一个 stop 请求都不发
        const verdict = v.ok
          ? '核验会通过，但自动停止当前被禁用（未通过真实端到端验收）'
          : `核验不通过（原因=${v.reason}${v.detail ? ' 细节=' + v.detail : ''}）`
        log(`退出：不停止网关（profile=${id}）—— ${verdict}`)
      }
    }
    if (!ownedIds.length) {
      log('退出：本控制台未持有任何网关所有权（共享/授权模式），不停止网关')
    }
    log('退出：自动停止开关 ALLOW_AUTO_STOP=false（profile 级 stop 存在无法消除的竞态，' +
        '且该路径尚未通过真实验收）；网关保持运行，未发送任何 stop 请求')

    // 2) 结束看门狗，避免残留进程
    stopWatchdog()

    // 3) 关闭本控制台自己 spawn 的后端进程（这是控制台自己的进程，可安全回收）
    stopBackend()
    setTimeout(() => app.exit(0), 300)
  })
}
