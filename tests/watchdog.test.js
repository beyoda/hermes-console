/**
 * Hermes 桌面控制台 — 看门狗 自动化测试
 *
 * 运行：node tests/watchdog.test.js
 * 用测试桩注入身份与进程核对结果，**不实际停止任何网关**。
 *
 * 覆盖（安全复审问题四要求）：
 *   · 控制台异常退出
 *   · PID 复用
 *   · 网关实例变化
 *   · 状态文件损坏
 *   · 停止失败和超时
 *   · 长时间运行及看门狗自行退出
 *   · 与主进程**规则一致性**（不得存在更宽松的独立副本）
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const wd = require('../watchdog')
const own = require('../ownership')

let pass = 0, fail = 0
const results = []

function test(name, fn) {
  try {
    fn()
    pass++
    results.push(`  [PASS] ${name}`)
  } catch (err) {
    fail++
    results.push(`  [FAIL] ${name}\n         ${err.message}`)
  }
}

const START_A = 178972155710
const msA = own.toStartMs(START_A)
const HOME_A = 'D:\hermes-home'
const ID = (pid, startMs = msA) => ({ pid, startMs, hermesHome: HOME_A })
const ctxFor = (id, over = {}) => ({
  instanceCount: 1,
  proc: { exists: true, startMs: id.startMs + 2 },
  ...over
})
const record = (consolePid, gw) => ({ consolePid, gateway: gw, acquiredAt: new Date().toISOString() })

const CONSOLE_PID = 40000

console.log('='.repeat(78))
console.log(' 看门狗 — 自动化测试（阶段 4.2.1）')
console.log('='.repeat(78))

console.log('\n[1] 异常退出（控制台进程消失）后的决策')
test('控制台仍存活 → 不动作（console-alive）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({ record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: true, current: id, ctx: ctxFor(id) })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'console-alive')
})
test('控制台异常退出 + 身份一致 + 【显式开启】自动停止 → 执行停止（verified）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id), allowStop: true
  })
  assert.strictEqual(d.act, true)
  assert.strictEqual(d.reason, 'verified')
})
test('★ 身份一致但未显式开启自动停止（默认）→ 绝不执行（auto-stop-disabled）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id)
  })
  assert.strictEqual(d.act, false, '默认必须不动作')
  assert.strictEqual(d.reason, 'auto-stop-disabled')
  assert.strictEqual(d.identityOk, true, '仍应如实回报"身份核验本会通过"供审计')
})
test('控制台异常退出但正常退出流程已清理记录 → 不动作（no-record）', () => {
  const d = wd.decideWatchdogStop({ record: null, consolePid: CONSOLE_PID, consoleAlive: false, current: ID(100), ctx: ctxFor(ID(100)) })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'no-record')
})
test('记录缺少 gateway 字段 → 不动作', () => {
  const d = wd.decideWatchdogStop({ record: { consolePid: CONSOLE_PID }, consolePid: CONSOLE_PID, consoleAlive: false, current: ID(100), ctx: ctxFor(ID(100)) })
  assert.strictEqual(d.reason, 'no-record')
})
test('★ 记录中的 consolePid 与本次监视目标不一致 → 拒绝（record-mismatch）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({ record: record(99999, id), consolePid: CONSOLE_PID, consoleAlive: false, current: id, ctx: ctxFor(id) })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'record-mismatch')
})

console.log('\n[2] PID 复用与实例变化（问题一在看门狗侧的一致性）')
test('★ PID 相同但启动时间不同（PID 复用）→ 拒绝（instance-changed）', () => {
  const rec = ID(100)
  const cur = ID(100, msA + 60000)
  const d = wd.decideWatchdogStop({ record: record(CONSOLE_PID, rec), consolePid: CONSOLE_PID, consoleAlive: false, current: cur, ctx: ctxFor(cur) })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'instance-changed')
})
test('★ gateway 实例变化（PID 不同）→ 拒绝', () => {
  const d = wd.decideWatchdogStop({ record: record(CONSOLE_PID, ID(100)), consolePid: CONSOLE_PID, consoleAlive: false, current: ID(200), ctx: ctxFor(ID(200)) })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'instance-changed')
})
test('★ 关键一致性：记录缺 startMs 时，看门狗必须与主进程一样拒绝（旧副本会放行）', () => {
  const rec = { pid: 100, hermesHome: HOME_A }          // 缺 startMs
  const cur = ID(100)
  const d = wd.decideWatchdogStop({ record: record(CONSOLE_PID, rec), consolePid: CONSOLE_PID, consoleAlive: false, current: cur, ctx: ctxFor(cur) })
  assert.strictEqual(d.act, false, '不得仅凭 PID 判定')
  assert.strictEqual(d.reason, 'identity-incomplete')
})
test('★ 关键一致性：当前身份缺 startMs → 同样拒绝', () => {
  const cur = { pid: 100, hermesHome: HOME_A }
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, ID(100)), consolePid: CONSOLE_PID, consoleAlive: false,
    current: cur, ctx: { instanceCount: 1, proc: { exists: true, startMs: msA } }
  })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'identity-incomplete')
})
test('★ OS 创建时间与状态文件不一致 → 拒绝（process-mismatch）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id, { proc: { exists: true, startMs: msA + 500000 } })
  })
  assert.strictEqual(d.reason, 'process-mismatch')
})
test('★ OS 中该 PID 已不存在 → 拒绝（process-absent）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id, { proc: { exists: false, startMs: null } })
  })
  assert.strictEqual(d.reason, 'process-absent')
})
test('★ 拿不到 OS 创建时间 → 拒绝（process-time-unavailable）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id, { proc: { exists: true, startMs: null } })
  })
  assert.strictEqual(d.reason, 'process-time-unavailable')
})

console.log('\n[3] 状态文件损坏 / 探测失败')
test('★ 状态文件损坏导致读不到身份（current=null）→ 拒绝（probe-failed）', () => {
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, ID(100)), consolePid: CONSOLE_PID, consoleAlive: false,
    current: null, ctx: { instanceCount: null, proc: null }
  })
  assert.strictEqual(d.act, false)
  assert.strictEqual(d.reason, 'probe-failed')
})
test('★ 进程探测整体失败（ctx 为空对象）→ 拒绝', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: {}
  })
  assert.strictEqual(d.act, false)
  assert.ok(['instance-count-unknown', 'process-probe-failed'].includes(d.reason), `实际 ${d.reason}`)
})
test('★ 同 profile 出现多个网关进程 → 拒绝（multiple-instances）', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id, { instanceCount: 2 })
  })
  assert.strictEqual(d.reason, 'multiple-instances')
})

console.log('\n[4] 停止失败与超时（结果归类）')
test('退出码 0 → 成功', () => {
  assert.deepStrictEqual(wd.classifyStopResult({ code: 0, note: 'ok' }), { ok: true, reason: 'exit-0' })
})
test('★ 超时（code=124）→ 明确报告 timeout，不是静默成功', () => {
  const r = wd.classifyStopResult({ code: 124, note: 'timeout (60s)' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'timeout')
})
test('spawn 失败（code=-1）→ spawn-failed', () => {
  assert.strictEqual(wd.classifyStopResult({ code: -1, note: 'spawn error' }).reason, 'spawn-failed')
})
test('非零退出 → nonzero-exit（保留退出码作为错误类型）', () => {
  const r = wd.classifyStopResult({ code: 3, note: 'boom' })
  assert.strictEqual(r.reason, 'nonzero-exit')
  assert.ok(r.detail.includes('3'))
})
test('无结果 → no-result', () => {
  assert.strictEqual(wd.classifyStopResult(null).reason, 'no-result')
})

console.log('\n[5] 停止后复查')
test('目标已不在 → stopped', () => {
  const v = wd.verifyStopped(null, 100)
  assert.strictEqual(v.stopped, true)
  assert.strictEqual(v.reason, 'no-identity-present')
})
test('目标仍存在同一 PID → 未停止', () => {
  const v = wd.verifyStopped(ID(100), 100)
  assert.strictEqual(v.stopped, false)
  assert.strictEqual(v.reason, 'target-still-present')
})
test('目标不在但出现了别的实例 → 视为已停止（并标明是另一个实例）', () => {
  const v = wd.verifyStopped(ID(200), 100)
  assert.strictEqual(v.stopped, true)
  assert.strictEqual(v.reason, 'target-gone-other-instance')
})

console.log('\n[6] 长时间运行：观察周期 + 交接（不得静默失效）')
test('★ 旧缺陷不得回归：不存在"到点静默退出"的 MAX_LIFETIME_MS', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(!/MAX_LIFETIME_MS/.test(src),
    'MAX_LIFETIME_MS 已废弃：12 小时静默退出会让保护无声失效')
  assert.ok(!/达到安全上限/.test(src), '不得保留"到上限即退出"的日志语义')
})
test('观察周期常量存在且有限（单进程生命期有界）', () => {
  assert.ok(Number.isFinite(wd.WATCH_CYCLE_MS) && wd.WATCH_CYCLE_MS > 0,
    '必须有有界的观察周期，避免单进程无界驻留')
  assert.ok(wd.WATCH_CYCLE_MS >= 60 * 1000, '周期不应短到造成进程反复派生')
})
test('周期未到 → 继续监视', () => {
  const d = wd.decideCycleAction({ cycleElapsedMs: 1000 })
  assert.strictEqual(d.action, 'watch')
})
test('★ 周期到点 → 交接（不是退出）', () => {
  const d = wd.decideCycleAction({ cycleElapsedMs: wd.WATCH_CYCLE_MS + 1 })
  assert.strictEqual(d.action, 'handoff', '到点必须走交接，绝不能直接退出')
})
test('★ 交接尝试未用尽 → 仍选择交接（保留恢复机会）', () => {
  const d = wd.decideCycleAction({
    cycleElapsedMs: wd.WATCH_CYCLE_MS + 1, handoffAttempts: 1, maxAttempts: 3
  })
  assert.strictEqual(d.action, 'handoff')
})
test('★ 交接尝试用尽 → 继续自行监视（give-up-handoff），不退出', () => {
  const d = wd.decideCycleAction({
    cycleElapsedMs: wd.WATCH_CYCLE_MS + 1, handoffAttempts: 3, maxAttempts: 3
  })
  assert.strictEqual(d.action, 'give-up-handoff')
  assert.notStrictEqual(d.action, 'exit', '任何情况下都不得因周期到点而退出')
})
test('★ 源码确认：周期到点调用 handoff，且失败分支为 continue（不是 return）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  const iHandoff = src.indexOf("if (cyc.action === 'handoff')")
  assert.ok(iHandoff > 0, '应存在 handoff 分支')
  const seg = src.slice(iHandoff, iHandoff + 1400)
  assert.ok(/await handoff\(/.test(seg), 'handoff 分支必须真正执行交接')
  assert.ok(/继续自行监视/.test(seg), '交接失败必须继续监视')
  assert.ok(/cycleStart = Date\.now\(\)/.test(seg), '交接失败应重置周期而不是退出')
  // 交接成功才允许 return
  const iOk = seg.indexOf('if (ok)')
  const iRet = seg.indexOf('return 0', iOk)
  assert.ok(iOk > 0 && iRet > iOk, '只有交接成功（ok）才允许 return 结束进程')
})
test('★ 源码确认：交接前先确认后继已接管（写锁），确认后才释放', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(/交接确认/.test(src), '应有交接确认日志')
  assert.ok(/l\.pid\) === child\.pid/.test(src), '必须核对锁中 pid 等于后继 pid')
  assert.ok(/Number\(l\.generation\) === nextGen/.test(src), '必须核对 generation 前进')
})
test('★ 源码确认：无界资源消耗防护（心跳 + 固定轮询 + 单槽锁）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(Number.isFinite(wd.POLL_MS) && wd.POLL_MS >= 500, '轮询间隔必须固定且有下界')
  assert.ok(Number.isFinite(wd.HEARTBEAT_MS) && wd.HEARTBEAT_MS >= wd.POLL_MS, '心跳间隔应大于轮询间隔')
  assert.ok(/lastBeatMs/.test(src), '锁文件应记录心跳时间戳（外部可观察）')
  assert.ok(/writeLock\(/.test(src), '应写单槽锁')
})
test('★ 源码确认：看门狗不做重试（失败即报告，不反复尝试停止）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  const stopCalls = (src.match(/await runStop\(/g) || []).length
  assert.strictEqual(stopCalls, 1, `runStop 应只被调用一次，实际 ${stopCalls} 次`)
})
test('★ 停止执行不按进程名批量杀进程', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(!/taskkill/i.test(src), '不得使用 taskkill')
  assert.ok(!/Stop-Process/i.test(src), '不得使用 Stop-Process')
  assert.ok(!/process\.kill\([^)]*,\s*['"]SIGKILL/.test(src), '不得强杀')
})
test('看门狗调用官方 gateway stop（而非自行实现停止）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(/\['gateway',\s*'stop'\]/.test(src))
})

console.log('\n[7] 自动停止开关（未通过真实验收 → 必须禁用）')
test('默认（不传 allowStop）→ 任何输入下都不动作', () => {
  const id = ID(100)
  const cases = [
    { consoleAlive: false, current: { ...id }, ctx: ctxFor(id) },        // 本会通过
    { consoleAlive: false, current: null, ctx: {} },                     // 本就不通过
    { consoleAlive: true, current: { ...id }, ctx: ctxFor(id) }
  ]
  for (const c of cases) {
    const d = wd.decideWatchdogStop({ record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, ...c })
    assert.strictEqual(d.act, false, '默认必须不动作')
  }
})
test('★ 自动停止禁用时的 reason 明确为 auto-stop-disabled，不是静默跳过', () => {
  const id = ID(100)
  const d = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id)
  })
  assert.strictEqual(d.reason, 'auto-stop-disabled')
  assert.ok(/禁用/.test(d.detail || ''), 'detail 应说明"自动停止被禁用"，便于审查')
})
test('★ 禁用时仍如实区分"本会通过"与"本就不通过"（审计信息不丢）', () => {
  const id = ID(100)
  const okCase = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, id), consolePid: CONSOLE_PID, consoleAlive: false,
    current: { ...id }, ctx: ctxFor(id)
  })
  const badCase = wd.decideWatchdogStop({
    record: record(CONSOLE_PID, { pid: 100, hermesHome: HOME_A }), consolePid: CONSOLE_PID,
    consoleAlive: false, current: { ...id }, ctx: ctxFor(id)
  })
  assert.strictEqual(okCase.identityOk, true)
  assert.strictEqual(okCase.reason, 'auto-stop-disabled', '身份本会通过 → 原因归于开关')
  assert.strictEqual(badCase.identityOk, false)
  assert.strictEqual(badCase.reason, 'identity-incomplete',
    '★ 身份不通过时必须回报精确原因，不能被 auto-stop-disabled 掩盖')
  assert.strictEqual(badCase.autoStopDisabled, true, '仍标注开关处于禁用状态')
})
test('★ 开关禁用不得掩盖任何身份类拒绝原因（逐项校验）', () => {
  const id = ID(100)
  const cases = [
    ['instance-changed', { record: record(CONSOLE_PID, ID(100, msA + 60000)), current: ID(100, msA) }],
    ['probe-failed', { record: record(CONSOLE_PID, id), current: null }]
  ]
  for (const [expect, c] of cases) {
    const d = wd.decideWatchdogStop({
      record: c.record, consolePid: CONSOLE_PID, consoleAlive: false,
      current: c.current, ctx: c.current ? ctxFor(c.current) : { instanceCount: null, proc: null }
    })
    assert.strictEqual(d.act, false)
    assert.strictEqual(d.reason, expect, `应回报 ${expect}，实际 ${d.reason}`)
  }
})
test('★ 源码确认：stop 调用被 allowStop 判定结果把守（不会无条件执行）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  const iDecide = src.indexOf('const d = decideWatchdogStop(')
  const iGuard = src.indexOf('if (!d.act)', iDecide)
  const iStop = src.indexOf('await runStop(', iDecide)
  assert.ok(iDecide > 0 && iGuard > 0 && iStop > 0, '三处都应存在')
  assert.ok(iGuard > iDecide && iGuard < iStop, '必须"先判定再停止"，且 !d.act 时提前返回')
})
test('★ 源码确认：allowStop 默认值为 false（fail-closed）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(/function decideWatchdogStop\(\{[^}]*allowStop = false/.test(src),
    'decideWatchdogStop 的 allowStop 默认必须是 false')
  assert.ok(/ALLOW_STOP = A\['allow-stop'\] === '1'/.test(src),
    '只有显式传入 --allow-stop 1 才允许（字符串严格比较，缺省即禁用）')
})

console.log('\n[8] 单槽锁（同一控制台只允许一个看门狗，防累积）')
test('无锁文件 → 允许启动', () => {
  assert.deepStrictEqual(wd.decideStart(null, CONSOLE_PID, 123, null), { ok: true, reason: 'no-lock' })
})
test('锁属于别的控制台 → 不影响本进程启动', () => {
  const d = wd.decideStart({ consolePid: 999, pid: 111111, generation: 5 }, CONSOLE_PID, 123, null)
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.reason, 'lock-for-other-console')
})
test('锁的持有者已不存在（陈旧锁）→ 允许启动（自动清理语义）', () => {
  const d = wd.decideStart({ consolePid: CONSOLE_PID, pid: 0, generation: 1 }, CONSOLE_PID, 123, null)
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.reason, 'stale-lock')
})
test('★ 已有存活的看门狗在监视同一控制台 → 拒绝启动（不得重复派生）', () => {
  const lock = { consolePid: CONSOLE_PID, pid: process.pid, generation: 1 }   // 本测试进程 = 存活
  const d = wd.decideStart(lock, CONSOLE_PID, 123, null)
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.reason, 'another-watchdog-alive')
})
test('★ 交接场景：前驱仍存活但正是本次交接来源 → 允许接管', () => {
  const lock = { consolePid: CONSOLE_PID, pid: process.pid, generation: 1 }
  const d = wd.decideStart(lock, CONSOLE_PID, 123, process.pid)
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.reason, 'handoff')
  assert.strictEqual(d.takeOver, true)
})
test('★ 锁里的 pid 就是自己 → 视为自己的锁（重启语义）', () => {
  const d = wd.decideStart({ consolePid: CONSOLE_PID, pid: 123, generation: 1 }, CONSOLE_PID, 123, null)
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.reason, 'own-lock')
})
test('★ 源码确认：释放锁前核对 pid（前驱不得抹掉后继刚写的条目）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  const iRel = src.indexOf('function releaseOwnLock')
  const seg = src.slice(iRel, iRel + 400)
  assert.ok(/Number\(cur\.pid\) === process\.pid/.test(seg), '只能删除属于自己的锁')
})

console.log('\n[9] 所有权记录被清理 / 控制台释放所有权')
test('控制台仍存活 → 不退出（无论探测失败多少次）', () => {
  const g = wd.decideRecordGone({ misses: 99, tolerance: 3, consoleAlive: true })
  assert.strictEqual(g.exit, false)
  assert.strictEqual(g.reason, 'console-alive')
})
test('★ 未达容忍次数 → 不退出（防杀软/时序抖动导致误退出）', () => {
  const g = wd.decideRecordGone({ misses: 1, tolerance: 3, consoleAlive: false })
  assert.strictEqual(g.exit, false)
  assert.strictEqual(g.reason, 'within-tolerance')
})
test('控制台已退出且记录连续多次缺失 → 判定已被清理，结束监视', () => {
  const g = wd.decideRecordGone({ misses: 3, tolerance: 3, consoleAlive: false })
  assert.strictEqual(g.exit, true)
  assert.strictEqual(g.reason, 'record-removed')
})
test('容忍次数是个有限小值（不是 0，也不是无界）', () => {
  assert.ok(wd.RECORD_MISS_TOLERANCE >= 1 && wd.RECORD_MISS_TOLERANCE <= 60,
    `RECORD_MISS_TOLERANCE=${wd.RECORD_MISS_TOLERANCE} 应落在合理区间`)
})

console.log('\n[10] 停止执行安全性（与阶段 4.2.1 保持一致）')
test('★ 停止执行不按进程名批量杀进程', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(!/taskkill/i.test(src), '不得使用 taskkill')
  assert.ok(!/Stop-Process/i.test(src), '不得使用 Stop-Process')
  assert.ok(!/process\.kill\([^)]*,\s*['"]SIGKILL/.test(src), '不得强杀')
})
test('看门狗调用官方 gateway stop（而非自行实现停止）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(/\['gateway',\s*'stop'\]/.test(src))
})
test('★ 危险操作前使用新鲜进程探测（force:true），不吃缓存', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8')
  assert.ok(/buildVerifyContext\(cur,\s*\{\s*force:\s*true\s*\}\)/.test(src),
    '看门狗判决前应强制新鲜探测，缩小检查-执行窗口')
})

console.log('\n[11] 主进程侧的自动停止开关（源码约束）')
test('★ main.js 的 ALLOW_AUTO_STOP 必须为 false（未通过真实验收前不得开启）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/const ALLOW_AUTO_STOP = false/.test(src),
    'ALLOW_AUTO_STOP 必须显式为 false')
})
test('★ main.js 退出时的 stop 调用必须被 ALLOW_AUTO_STOP 把守', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const iQuit = src.indexOf('app.on(\'before-quit\'')
  assert.ok(iQuit > 0, '应存在 before-quit')
  const seg = src.slice(iQuit, iQuit + 3000)
  const iGuard = seg.indexOf('if (ALLOW_AUTO_STOP) {')
  const iStop = seg.indexOf("'/api/gateway/stop'")
  assert.ok(iGuard > 0, 'before-quit 内应存在 ALLOW_AUTO_STOP 判定')
  assert.ok(iStop > 0, '应存在停止请求')
  assert.ok(iGuard < iStop, `开关判定(@${iGuard}) 必须早于停止请求(@${iStop})`)
})
test('★ main.js 派生看门狗时按开关传 --allow-stop（默认 0）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/'--allow-stop', ALLOW_AUTO_STOP \? '1' : '0'/.test(src))
  assert.ok(/'--lock', WATCHDOG_LOCK_FILE/.test(src), '应传单槽锁路径')
  assert.ok(/'--generation', '1'/.test(src), '首代 generation 应为 1')
})
test('★ main.js 不得声称"保证只停某个实例"（只允许否定式表述）', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  // 去注释（注释里会引用历史错误说法，不能算代码声称）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  // 任何"保证只停"的出现都必须带否定前缀
  const found = []
  const re = /(.{0,4})保证只停/g
  let m
  while ((m = re.exec(src)) !== null) {
    found.push(m[1])
    assert.ok(/无法|不能|不得|不构成|不保证/.test(m[1]),
      `出现肯定式声称：「${m[1]}保证只停」—— 必须改为否定式（无法保证只停…）`)
  }
  assert.ok(found.length > 0, '应当存在"无法保证只停目标实例"的否定式说明（能力边界如实暴露）')
  assert.ok(/无法保证只停目标实例/.test(src), '拒绝原因里应明确写出该限制')
})

test('★ main.js 暴露剩余风险标记 profile-level-stop-race（不隐藏限制）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/residualRisk: 'profile-level-stop-race'/.test(src), '应声明剩余风险')
  assert.ok(/residualRisk: 'profile-level-stop-race'/.test(
    fs.readFileSync(path.join(__dirname, '..', 'ownership.js'), 'utf8')),
    'ownership.js 的 verifyTarget 也应标记剩余风险')
})

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))

process.exit(fail === 0 ? 0 : 1)
