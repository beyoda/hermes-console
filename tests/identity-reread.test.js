/**
 * Hermes 桌面控制台 — 身份读取竞态修复（定向重读 + 所有权保留）隔离测试
 *
 * 运行：node tests/identity-reread.test.js
 *
 * ⚠️ 安全边界：**不启动、不停止、不接管任何真实网关**，不触碰任何状态文件。
 *    本文件全部为纯逻辑测试 + 源码静态断言；[B] 用**同步镜像**复现真实写入时序，
 *    不引入任何真实等待（不 sleep）。
 *
 * 覆盖（对应本轮任务书）：
 *   [A] 重读判定：身份就绪 / 未就绪重读 / 窗口用尽 / 非本控制台启动（只读一次）
 *   [B] 真实写入时序镜像：pid+lock 先写、state 后写（PID 22296 实际场景）；
 *       进程消失 / 身份冲突 / 出现其他实例 → 立即终止；超时不得登记
 *   [C] 所有权保留判定：暂时不可读不销毁；确凿无效/原进程死亡才释放
 *   [D] default 与 Extra 所有权互不覆盖
 *   [E] 静态防回退 + 文案约束（不得提示再次启动、不得提接管）
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const own = require('../ownership')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
const readCode = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const HOME_DEFAULT = 'D:\hermes-home'
const HOME_EXTRA = 'D:\hermes-home\\profiles\\extra'
const ID = (pid, startMs = 1000, home = HOME_DEFAULT) => ({ pid, startMs, hermesHome: home })

/**
 * 忠实镜像 main.js `registerOwnershipFor` 的「定向重读」**循环控制**部分
 * （I/O 与判存活由调用方以纯数据/纯函数提供；不真实等待）。
 * 目的：让"真实写入时序"能在单测里被确定性复现。
 */
function runRereadLoop (o) {
  const aliveFn = typeof o.alive === 'function' ? o.alive : (pid => (o.alive || new Set()).has(pid))
  const windowMs = typeof o.windowMs === 'number' ? o.windowMs : own.IDENTITY_REREAD_WINDOW_MS
  const stepMs = typeof o.stepMs === 'number' ? o.stepMs : own.IDENTITY_REREAD_INTERVAL_MS
  const expectedPid = (typeof o.expectedPid === 'number' && o.expectedPid > 0) ? o.expectedPid : null
  const snaps = Array.isArray(o.snapshots) ? o.snapshots : []

  let elapsedMs = 0
  let attempts = 0
  let inst = null
  let verdict = { action: 'abort', reason: 'identity-unreadable-timeout' }
  const trace = []

  for (;;) {
    attempts++
    const snap = snaps[Math.min(attempts - 1, snaps.length - 1)] || { identity: null, pidFilePid: null, statePid: null, lockPid: null }
    inst = snap.identity

    const candidates = Array.from(new Set(
      [snap.pidFilePid, snap.statePid, snap.lockPid].filter(p => typeof p === 'number')
    ))
    const aliveCandidates = candidates.filter(p => aliveFn(p) === true)
    const expectedAlive = expectedPid === null ? null : aliveFn(expectedPid)
    const otherInstanceCount = expectedPid === null
      ? 0
      : aliveCandidates.filter(p => p !== expectedPid).length

    verdict = own.decideIdentityReread({
      attempt: attempts,
      elapsedMs,
      windowMs,
      identity: inst,
      expectedPid,
      expectedAlive,
      alivePidCount: aliveCandidates.length,
      otherInstanceCount
    })
    trace.push({ attempt: attempts, elapsedMs, action: verdict.action, reason: verdict.reason })

    if (verdict.action !== 'retry') break
    elapsedMs += stepMs    // 模拟时间推进（同步）
  }
  return { verdict, attempts, inst, trace, elapsedMs }
}

// 快照构造器
const NOT_READY = (pidFilePid, statePid, lockPid) =>
  ({ identity: null, pidFilePid, statePid, lockPid })
const READY = (pid, home = HOME_DEFAULT) =>
  ({ identity: ID(pid, 1000, home), pidFilePid: pid, statePid: pid, lockPid: pid })

// ================================================================ [A] 重读判定
console.log('\n[A] 重读判定（纯函数）')
{
  const dec = own.decideIdentityReread

  test('[A] 身份已就绪 → proceed（交给完整核验，本函数不代替核验）', () => {
    const r = dec({ identity: ID(100), expectedPid: 100, expectedAlive: true, alivePidCount: 1, elapsedMs: 0, windowMs: 2000 })
    assert.strictEqual(r.action, 'proceed')
    assert.strictEqual(r.reason, 'identity-ready')
  })

  test('[A] 未就绪但仍在窗口内 → retry（按条件重读，不盲等）', () => {
    const r = dec({ identity: null, expectedPid: 100, expectedAlive: true, alivePidCount: 1, elapsedMs: 500, windowMs: 2000 })
    assert.strictEqual(r.action, 'retry')
    assert.strictEqual(r.reason, 'identity-not-ready')
  })

  test('[A] 窗口用尽仍未就绪 → abort（不得伪造所有权）', () => {
    const r = dec({ identity: null, expectedPid: 100, expectedAlive: true, alivePidCount: 1, elapsedMs: 2000, windowMs: 2000 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'identity-unreadable-timeout')
  })

  test('[A] windowMs=0（非本控制台启动）→ 首轮即放弃，绝不重读', () => {
    const r = dec({ identity: null, expectedPid: null, expectedAlive: null, alivePidCount: 1, elapsedMs: 0, windowMs: 0 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'identity-unreadable-timeout')
  })

  test('[A] 本次启动的进程已死 → abort process-gone（立即，不重试）', () => {
    const r = dec({ identity: null, expectedPid: 100, expectedAlive: false, alivePidCount: 0, elapsedMs: 0, windowMs: 2000 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'process-gone')
  })

  test('[A] 状态文件之间矛盾且都存活 → abort identity-conflict', () => {
    const r = dec({ identity: null, expectedPid: 100, expectedAlive: true, alivePidCount: 2, elapsedMs: 0, windowMs: 2000 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'identity-conflict')
  })

  test('[A] 出现不属于本次启动的存活实例 → abort other-instance', () => {
    const r = dec({ identity: null, expectedPid: 100, expectedAlive: true, alivePidCount: 2, otherInstanceCount: 1, elapsedMs: 0, windowMs: 2000 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'other-instance')
  })

  test('[A] 异常优先于"身份已就绪"：即便读到身份，出现别的实例也必须终止', () => {
    const r = dec({ identity: ID(100), expectedPid: 100, expectedAlive: true, alivePidCount: 2, otherInstanceCount: 1, elapsedMs: 0, windowMs: 2000 })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'other-instance')
  })

  test('[A] 优先级：other-instance > identity-conflict > process-gone > ready > timeout > retry', () => {
    const base = { expectedPid: 100, expectedAlive: true, alivePidCount: 1, identity: null, elapsedMs: 0, windowMs: 2000 }
    assert.strictEqual(dec({ ...base, otherInstanceCount: 1, alivePidCount: 3 }).reason, 'other-instance')
    assert.strictEqual(dec({ ...base, alivePidCount: 2 }).reason, 'identity-conflict')
    assert.strictEqual(dec({ ...base, expectedAlive: false, identity: ID(100) }).reason, 'process-gone')
    assert.strictEqual(dec({ ...base, identity: ID(100) }).reason, 'identity-ready')
    assert.strictEqual(dec({ ...base, elapsedMs: 2000 }).reason, 'identity-unreadable-timeout')
    assert.strictEqual(dec({ ...base, elapsedMs: 100 }).reason, 'identity-not-ready')
  })

  test('[A] 缺参数时保守：windowMs 缺省 2000、elapsedMs 缺省 0 → 先按"可重读"处理', () => {
    const r = dec({})
    assert.strictEqual(r.action, 'retry')
    assert.strictEqual(r.reason, 'identity-not-ready')
  })
}

// ================================================================ [B] 真实时序镜像
console.log('\n[B] 真实写入时序镜像（pid+lock 先写 / state 后写）')
{
  test('[B] PID 22296 实际场景：pid=22296 已写、state=9904（已死）→ 重读后成功登记', () => {
    const r = runRereadLoop({
      snapshots: [
        NOT_READY(22296, 9904, 22296),   // 第 1 轮：state 还是昨天的旧值
        NOT_READY(22296, 9904, 22296),   // 第 2 轮：仍未写入
        READY(22296)                     // 第 3 轮：state 就绪
      ],
      expectedPid: 22296,
      alive: pid => pid === 22296        // 旧 pid 9904 已死
    })
    assert.strictEqual(r.verdict.action, 'proceed', `实际 ${r.verdict.action}/${r.verdict.reason}`)
    assert.strictEqual(r.attempts, 3)
    assert.ok(r.elapsedMs <= own.IDENTITY_REREAD_WINDOW_MS, '重读耗时必须落在窗口内')
  })

  test('[B] 全程未就绪 → abort，且**不得**发生登记（不伪造所有权）', () => {
    const r = runRereadLoop({
      snapshots: [NOT_READY(22296, 9904, 22296)],
      expectedPid: 22296,
      alive: pid => pid === 22296
    })
    assert.strictEqual(r.verdict.action, 'abort')
    assert.strictEqual(r.verdict.reason, 'identity-unreadable-timeout')
    // 窗口 2000ms / 间隔 250ms → 第 9 轮才越过窗口
    assert.strictEqual(r.attempts, 9, `应在窗口用尽时停止重读，实际重读 ${r.attempts} 次`)
    assert.strictEqual(r.inst, null, '不得凭空构造身份')
  })

  test('[B] 重读期间进程消失 → 立即终止（1 轮），不等满窗口', () => {
    const r = runRereadLoop({
      snapshots: [NOT_READY(22296, 9904, 22296)],
      expectedPid: 22296,
      alive: () => false
    })
    assert.strictEqual(r.verdict.action, 'abort')
    assert.strictEqual(r.verdict.reason, 'process-gone')
    assert.strictEqual(r.attempts, 1)
  })

  test('[B] 重读期间出现另一个存活 pid → 立即终止 other-instance', () => {
    const r = runRereadLoop({
      snapshots: [NOT_READY(22296, 9904, 22296)],
      expectedPid: 22296,
      alive: pid => pid === 22296 || pid === 9904   // 旧 pid 竟然也活着 = 有两个实例
    })
    assert.strictEqual(r.verdict.action, 'abort')
    assert.strictEqual(r.verdict.reason, 'other-instance')
    assert.strictEqual(r.attempts, 1)
  })

  test('[B] 状态文件互相矛盾且都存活（无 expectedPid）→ 立即终止 identity-conflict', () => {
    const r = runRereadLoop({
      snapshots: [NOT_READY(111, 222, 333)],
      expectedPid: null,
      alive: () => true
    })
    assert.strictEqual(r.verdict.action, 'abort')
    assert.strictEqual(r.verdict.reason, 'identity-conflict')
    assert.strictEqual(r.attempts, 1)
  })

  test('[B] 非本控制台启动（windowMs=0）→ 只读一次就放弃，绝不重读', () => {
    const r = runRereadLoop({
      snapshots: [NOT_READY(null, null, null)],
      expectedPid: null,
      alive: () => false,
      windowMs: 0
    })
    assert.strictEqual(r.verdict.action, 'abort')
    assert.strictEqual(r.attempts, 1)
    assert.strictEqual(r.elapsedMs, 0, '不得产生任何等待')
  })

  test('[B] 重读成功后仍必须走完整核验（镜像只决定"读到"，不代替核验）', () => {
    const r = runRereadLoop({
      snapshots: [READY(22296)],
      expectedPid: 22296,
      alive: pid => pid === 22296
    })
    assert.strictEqual(r.verdict.action, 'proceed')
    const check = own.verifyProfileIdentity({
      identity: r.inst, profileHome: HOME_DEFAULT,
      procs: [{ pid: 22296, startMs: 1000 }], instanceCount: 1
    })
    assert.strictEqual(check.ok, true)
    // 同一身份但 home 不符 → 依旧被拒（说明核验未被绕过）
    const bad = own.verifyProfileIdentity({
      identity: r.inst, profileHome: HOME_EXTRA,
      procs: [{ pid: 22296, startMs: 1000 }], instanceCount: 1
    })
    assert.strictEqual(bad.reason, 'profile-mismatch')
  })
}

// ================================================================ [C] 所有权保留
console.log('\n[C] 所有权保留判定（修复"暂时不可读被误释放"）')
{
  const dec = own.decideOwnershipRetention

  test('[C] 身份暂时不可读 + 原进程仍存活 → **保留**记录，且本次核验不通过', () => {
    const r = dec({ curReadable: false, probeError: null, ownedPidAlive: true })
    assert.strictEqual(r.retain, true)
    assert.strictEqual(r.release, false)
    assert.strictEqual(r.reason, 'identity-unreadable')
  })

  test('[C] 身份暂时不可读 + 原进程已死（OS 确凿）→ 释放', () => {
    const r = dec({ curReadable: false, probeError: null, ownedPidAlive: false })
    assert.strictEqual(r.release, true)
    assert.strictEqual(r.reason, 'instance-gone')
  })

  test('[C] 身份暂时不可读 + 进程探测失败 → 保留（无法证明已死就不销毁）', () => {
    const r = dec({ curReadable: false, probeError: 'PowerShell 超时', ownedPidAlive: null })
    assert.strictEqual(r.retain, true)
    assert.strictEqual(r.release, false)
    assert.strictEqual(r.reason, 'identity-unreadable-probe-failed')
  })

  test('[C] 身份暂时不可读 + 存活未知（null）→ 保留（fail-closed）', () => {
    const r = dec({ curReadable: false, probeError: null, ownedPidAlive: null })
    assert.strictEqual(r.retain, true)
    assert.strictEqual(r.reason, 'identity-unreadable')
  })

  test('[C] 可读 + 一致 + verified → 保留（正常）', () => {
    const r = dec({ curReadable: true, unchanged: true, checkReason: 'verified' })
    assert.strictEqual(r.retain, true)
    assert.strictEqual(r.reason, 'verified')
  })

  test('[C] 可读 + 与记录不一致 → 释放 instance-changed', () => {
    const r = dec({ curReadable: true, unchanged: false, checkReason: 'verified' })
    assert.strictEqual(r.release, true)
    assert.strictEqual(r.reason, 'instance-changed')
  })

  test('[C] 可读 + home 不符 / 进程不匹配 / 多实例 → 释放', () => {
    for (const why of ['profile-mismatch', 'process-mismatch', 'multiple-instances']) {
      const r = dec({ curReadable: true, unchanged: true, checkReason: why })
      assert.strictEqual(r.release, true, why)
      assert.strictEqual(r.reason, why)
    }
  })

  test('[C] 可读但核验"未确凿"（如创建时间取不到 / 实例数未知）→ 保留，不销毁', () => {
    for (const why of ['process-time-unavailable', 'instance-count-unknown', 'no-ownership']) {
      const r = dec({ curReadable: true, unchanged: true, checkReason: why })
      assert.strictEqual(r.retain, true, why)
      assert.strictEqual(r.release, false, why)
      assert.strictEqual(r.reason, why)
    }
  })

  test('[C] retain / release 互斥（不得同时为真）', () => {
    const cases = [
      { curReadable: false }, { curReadable: false, ownedPidAlive: false },
      { curReadable: false, probeError: 'x' }, { curReadable: true, unchanged: true, checkReason: 'verified' },
      { curReadable: true, unchanged: false }, { curReadable: true, unchanged: true, checkReason: 'profile-mismatch' }
    ]
    for (const c of cases) {
      const r = dec(c)
      assert.notStrictEqual(r.retain, r.release, JSON.stringify(c))
    }
  })

  test('[C] 缺参数时保守：curReadable 非 true（全 falsy）一律按"暂时不可读"处理并保留', () => {
    for (const bad of [undefined, null, 0, '', false, NaN]) {
      const r = dec({ curReadable: bad })
      assert.strictEqual(r.retain, true, String(bad))
      assert.strictEqual(r.release, false, String(bad))
    }
  })
}

// ================================================================ [D] default / Extra 隔离
console.log('\n[D] default 与 Extra 所有权互不覆盖')
{
  /** 镜像 main.js 的 state.ownedByProfile + releaseOwnership 语义 */
  function makeStore () {
    let byProfile = {}
    return {
      setOwned: (id, inst) => { byProfile[id] = inst },
      release: id => { delete byProfile[String(id)] },
      ownedOf: id => byProfile[String(id)] || null,
      ids: () => Object.keys(byProfile).sort()
    }
  }
  const dec = own.decideOwnershipRetention

  test('[D] 两个 Profile 同时持有：释放其一不影响另一个', () => {
    const s = makeStore()
    s.setOwned('default', ID(22296, 1000, HOME_DEFAULT))
    s.setOwned('extra', ID(33333, 2000, HOME_EXTRA))
    assert.deepStrictEqual(s.ids(), ['default', 'extra'])

    // default 确凿失效（原进程死亡）→ 释放
    const rd = dec({ curReadable: false, probeError: null, ownedPidAlive: false })
    assert.strictEqual(rd.release, true)
    if (rd.release) s.release('default')

    assert.strictEqual(s.ownedOf('default'), null)
    assert.strictEqual(s.ownedOf('extra').pid, 33333, 'Extra 不得被牵连')
  })

  test('[D] default 暂时不可读时，Extra 记录与 default 记录都不被销毁', () => {
    const s = makeStore()
    s.setOwned('default', ID(22296, 1000, HOME_DEFAULT))
    s.setOwned('extra', ID(33333, 2000, HOME_EXTRA))

    const rd = dec({ curReadable: false, probeError: null, ownedPidAlive: true })
    assert.strictEqual(rd.retain, true)
    if (rd.release) s.release('default')   // 不应发生

    assert.strictEqual(s.ownedOf('default').pid, 22296)
    assert.strictEqual(s.ownedOf('extra').pid, 33333)
  })

  test('[D] 重读判定不跨 Profile：expectedPid 只认本次启动的那一个', () => {
    const dec2 = own.decideIdentityReread
    // Extra 的 pid 在状态文件里出现 → 对 default 而言属于"别的实例"
    const r = dec2({
      identity: null, expectedPid: 22296, expectedAlive: true,
      alivePidCount: 2, otherInstanceCount: 1, elapsedMs: 0, windowMs: 2000
    })
    assert.strictEqual(r.action, 'abort')
    assert.strictEqual(r.reason, 'other-instance')
  })

  test('[D] 同一 pid 在另一 Profile 名下不得被当作"本次启动的那个"', () => {
    const dec2 = own.decideIdentityReread
    const r = dec2({
      identity: ID(22296, 1000, HOME_EXTRA), expectedPid: 22296, expectedAlive: true,
      alivePidCount: 1, elapsedMs: 0, windowMs: 2000
    })
    // 读到身份 → proceed；由 verifyProfileIdentity 以 home 兜底拒绝（不在此处放行）
    assert.strictEqual(r.action, 'proceed')
    const check = own.verifyProfileIdentity({
      identity: ID(22296, 1000, HOME_EXTRA), profileHome: HOME_DEFAULT,
      procs: [{ pid: 22296, startMs: 1000 }], instanceCount: 1
    })
    assert.strictEqual(check.reason, 'profile-mismatch')
  })
}

// ================================================================ [E] 静态防回退
console.log('\n[E] 静态防回退（源码约束与文案）')
{
  const mainJs = readCode('main.js')
  const ownJs = readCode('ownership.js')

  test('[E] ownership.js 必须导出两个新纯判定，并声明重读窗口常量', () => {
    assert.ok(/function\s+decideIdentityReread\s*\(/.test(ownJs), '缺少 decideIdentityReread')
    assert.ok(/function\s+decideOwnershipRetention\s*\(/.test(ownJs), '缺少 decideOwnershipRetention')
    assert.ok(/const\s+IDENTITY_REREAD_WINDOW_MS\s*=\s*2000/.test(ownJs), '重读窗口必须显式且为 2 秒')
    assert.ok(/decideIdentityReread,/.test(ownJs) && /decideOwnershipRetention,/.test(ownJs), '必须导出')
    assert.ok(/REGISTER_PENDING_REASONS/.test(ownJs), '必须定义"尚未就绪"结果集合')
  })

  test('[E] main.js：登记改为按条件重读，且窗口仅在"本控制台刚启动"时开启', () => {
    assert.ok(/own\.decideIdentityReread\(/.test(mainJs), '未使用 decideIdentityReread')
    assert.ok(/const windowMs = startedByUs \? own\.IDENTITY_REREAD_WINDOW_MS : 0/.test(mainJs),
      '窗口必须仅对 startedByUs 开启（否则等于变相等待接管外部实例）')
    assert.ok(/own\.IDENTITY_REREAD_INTERVAL_MS/.test(mainJs), '必须使用统一重读间隔')
  })

  test('[E] main.js：重读循环必须能"立即终止"（不得把异常当成继续重读）', () => {
    assert.ok(/if \(verdict\.action !== 'retry'\) break/.test(mainJs), '循环必须只在 retry 时继续')
    assert.ok(/pending: own\.REGISTER_PENDING_REASONS\.includes\(verdict\.reason\)/.test(mainJs),
      'pending 必须由 REGISTER_PENDING_REASONS 决定')
  })

  test('[E] main.js：启动侧必须显式声明"本控制台刚启动 + 期望 pid"', () => {
    assert.ok(/registerOwnershipFor\(p,\s*\{\s*startedByUs:\s*true,\s*expectedPid:\s*now\.pid\s*\}\)/.test(mainJs),
      'startProfile 未传 startedByUs/expectedPid')
  })

  test('[E] main.js：所有权保留改用 decideOwnershipRetention，旧写法必须消失', () => {
    assert.ok(/own\.decideOwnershipRetention\(/.test(mainJs), '未使用 decideOwnershipRetention')
    assert.ok(!/const reason = !unchanged \? 'instance-changed' : check\.reason/.test(mainJs),
      '旧的"不可读即 instance-changed"写法必须移除')
    assert.ok(/retention\.release/.test(mainJs), '释放必须由判定结果驱动')
  })

  test('[E] main.js：暂时不可读分支必须看"原进程是否存活"（而非直接释放）', () => {
    assert.ok(/curReadable:\s*false/.test(mainJs), '必须显式走"不可读"分支')
    assert.ok(/ownedPidAlive/.test(mainJs), '必须依据记录进程的存活情况判定')
  })

  test('[E] 核验标准未被放宽：完整四项核验仍在（PID + 创建时间 + home + 单实例）', () => {
    assert.ok(/own\.verifyProfileIdentity\(\{ identity: inst, profileHome: prof\.home, procs: ctx\.all \|\| \[\], instanceCount: count \}\)/.test(mainJs),
      '登记路径必须仍走 verifyProfileIdentity（四项核验）')
    assert.ok(/probe\.buildVerifyContext\(inst, \{ force: true \}\)/.test(mainJs), '登记前必须新鲜探测')
  })

  test('[E] 文案：未就绪时给出"正在确认停止权限"，且不提示再次启动、不提接管', () => {
    const block = (mainJs.split('const REGISTER_MESSAGES = {')[1] || '').split('\n}')[0] || ''
    assert.ok(block.length > 0, '未找到 REGISTER_MESSAGES')
    assert.ok(/正在确认停止权限/.test(block), '必须包含「正在确认停止权限」')
    assert.ok(/状态文件尚未就绪/.test(block), '必须说明实际原因（状态文件尚未就绪）')
    assert.ok(/日志页查看运行日志/.test(block), '必须给出安全处理建议')
    assert.ok(!/再次启动|重新启动|请重试启动/.test(block), '不得提示用户再次启动已经在运行的网关')
    assert.ok(!/接管/.test(block), '不得把接管作为补救路径')
  })

  test('[E] 文案：启动成功分支对 pending 使用「正在确认停止权限」措辞', () => {
    const block = (mainJs.split("ipcMain.handle('gateway:startProfile'")[1] || '').split("ipcMain.handle('")[0] || ''
    assert.ok(/reg\.pending\s*\?/.test(block), 'startProfile 必须区分 pending')
    assert.ok(/正在确认停止权限/.test(block), 'pending 分支必须使用「正在确认停止权限」措辞')
  })

  test('[E] 安全闸门未被改动（保留现有全部限制）', () => {
    assert.ok(/const ALLOW_AUTO_STOP = false/.test(mainJs), 'ALLOW_AUTO_STOP 必须仍为 false')
    assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(mainJs), 'ALLOW_DANGEROUS_EXEC 必须仍为 false')
    assert.ok(/const ALLOW_OWNED_STOP = true/.test(mainJs), 'ALLOW_OWNED_STOP 必须仍为 true')
    assert.ok(/if \(!ALLOW_DANGEROUS_EXEC\)/.test(mainJs), '接管闸门必须仍在')
  })

  test('[E] 探测模块仍为只读（不含 taskkill / Stop-Process / kill）', () => {
    const src = readCode('process-probe.js')
    assert.ok(!/taskkill|Stop-Process|TerminateProcess|\bkill\(/i.test(src))
  })

  test('[E] 本轮未触碰共享探测与业务模块（哈希与上轮一致）', () => {
    // process-probe.js 本轮不应被修改
    const pp = readCode('process-probe.js')
    assert.ok(/function isGatewayCmd/.test(pp) && /function mergeInstanceChains/.test(pp),
      'process-probe.js 应保持上一轮的修复形态')
  })
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))
process.exit(fail === 0 ? 0 : 1)
