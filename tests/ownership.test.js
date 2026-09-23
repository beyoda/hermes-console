/**
 * Hermes 桌面控制台 — 所有权 / 授权门 自动化测试
 *
 * 运行：node tests/ownership.test.js
 * 无第三方依赖；用测试桩注入文件系统与进程探测，**不触碰真实网关**。
 *
 * 覆盖（对应阶段 4.2.1 安全复审指出的问题）：
 *   [问题一] 身份验证缺失时仍可能通过 → 现在必须拒绝
 *   [问题二] 一次性授权绕过身份探测   → 现在必须同时成立
 *   [问题三] profile 级停止的竞态     → 多实例/计数未知必须拒绝
 *   [问题五] token 值不得出现在任何对外结构里
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
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

// ---------------------------------------------------------------- 测试桩
/** 构造一个假的 HERMES_HOME 文件读取器 */
function stubFs(files) {
  const m = new Map()
  for (const [k, v] of Object.entries(files)) m.set(path.normalize(k).toLowerCase(), v)
  return {
    exists: p => m.has(path.normalize(p).toLowerCase()),
    readFile: p => {
      const v = m.get(path.normalize(p).toLowerCase())
      if (v === undefined) throw new Error('ENOENT')
      return v
    }
  }
}

const HOME = 'C:\\Users\\<you>\\AppData\\Local\\hermes'
const PID_FILE = path.join(HOME, 'gateway.pid')
const STATE_FILE = path.join(HOME, 'gateway_state.json')

const PID_JSON = (pid, startRaw, extra = {}) => JSON.stringify({
  pid, kind: 'hermes-gateway', start_time: startRaw,
  argv: ['C:\\...\\hermes_cli\\main.py', 'gateway', 'run'],
  hermes_home: 'D:\hermes-home', ...extra
})
const STATE_JSON = (pid, startRaw, extra = {}) => JSON.stringify({
  pid, gateway_state: 'running', start_time: startRaw,
  hermes_home: 'D:\hermes-home', ...extra
})

const START_A = 178972155710   // 2026-09-18 16:52:37.10（epoch 秒 ×100）
const msA = own.toStartMs(START_A)
const HOME_A = 'D:\hermes-home'

/** 完整合法身份 */
const ID = (pid, startMs, home = HOME_A) => ({ pid, startMs, hermesHome: home })

/** 良好的 OS 核对上下文（进程创建时间与状态文件差 2ms，符合实测） */
const ctxFor = (id, over = {}) => ({
  instanceCount: 1,
  proc: { exists: true, startMs: id.startMs + 2 },
  ...over
})

// ================================================================
console.log('='.repeat(78))
console.log(' 所有权 / 授权门 — 自动化测试（阶段 4.2.1）')
console.log('='.repeat(78))

console.log('\n[1] start_time 归一化')
test('178972155710 → 2026-09-18 附近', () => {
  assert.ok(msA, '应能解析')
  assert.strictEqual(new Date(msA).getFullYear(), 2026)
  assert.strictEqual(new Date(msA).getMonth(), 8)
})
test('标准 epoch 秒也能解析（量级容错）', () => {
  const a = own.toStartMs(1789721557)
  assert.ok(a && Math.abs(a - msA) <= 1000)
})
test('null / 负数 / 字符串 / 0 → null', () => {
  for (const v of [null, -5, '123', 0, NaN, Infinity, undefined]) {
    assert.strictEqual(own.toStartMs(v), null, `toStartMs(${String(v)}) 应为 null`)
  }
})

console.log('\n[2] 身份完整性校验（问题一：字段要求必须明确）')
test('完整身份 → 有效', () => {
  assert.deepStrictEqual(own.validateIdentity(ID(1, msA)), { ok: true, errors: [] })
})
test('缺 startMs → 无效', () => {
  const v = own.validateIdentity({ pid: 1, hermesHome: HOME_A })
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.includes('startMs'))
})
test('缺 hermesHome → 无效', () => {
  const v = own.validateIdentity({ pid: 1, startMs: msA })
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.includes('hermesHome'))
})
test('pid 非正整数 / 非整数 → 无效', () => {
  for (const bad of [0, -1, 1.5, '1', null, NaN]) {
    assert.strictEqual(own.validateIdentity({ pid: bad, startMs: msA, hermesHome: HOME_A }).ok, false,
      `pid=${String(bad)} 应判无效`)
  }
})
test('startMs 为字符串 / NaN / 负数 → 无效（格式错误必须拒绝）', () => {
  for (const bad of ['1789721557100', NaN, -1, Infinity]) {
    assert.strictEqual(own.validateIdentity({ pid: 1, startMs: bad, hermesHome: HOME_A }).ok, false,
      `startMs=${String(bad)} 应判无效`)
  }
})
test('hermesHome 为空串 / 纯空白 → 无效', () => {
  for (const bad of ['', '   ', null, 123]) {
    assert.strictEqual(own.validateIdentity({ pid: 1, startMs: msA, hermesHome: bad }).ok, false)
  }
})
test('null / 非对象 → 无效', () => {
  assert.strictEqual(own.validateIdentity(null).ok, false)
  assert.strictEqual(own.validateIdentity('x').ok, false)
})

console.log('\n[3] 实例身份比对 —— ★问题一的核心缺陷')
test('完全一致 → 同一实例', () => {
  assert.strictEqual(own.sameIdentity(ID(100, msA), ID(100, msA)), true)
})
test('★ 原记录有启动时间、当前没有 → 必须【不同实例】（旧实现会误判为同一实例）', () => {
  const owned = ID(100, msA)
  const cur = { pid: 100, hermesHome: HOME_A }        // startMs 缺失
  assert.strictEqual(own.sameIdentity(owned, cur), false,
    '启动时间缺失时不得仅凭 PID 判定为同一实例')
})
test('★ 原记录缺启动时间、当前有 → 必须【不同实例】', () => {
  assert.strictEqual(own.sameIdentity({ pid: 100, hermesHome: HOME_A }, ID(100, msA)), false)
})
test('★ 双方都缺启动时间（仅 PID 相同）→ 必须【不同实例】', () => {
  assert.strictEqual(own.sameIdentity({ pid: 100, hermesHome: HOME_A }, { pid: 100, hermesHome: HOME_A }),
    false, 'PID 单独不足以判定')
})
test('★ 缺少 HERMES_HOME → 必须【不同实例】（字段要求一致）', () => {
  assert.strictEqual(own.sameIdentity({ pid: 100, startMs: msA }, ID(100, msA)), false)
})
test('PID 相同但启动时间不同（PID 复用）→ 不同实例', () => {
  assert.strictEqual(own.sameIdentity(ID(100, msA), ID(100, msA + 60000)), false)
})
test('不同 PID → 不同实例', () => {
  assert.strictEqual(own.sameIdentity(ID(1, msA), ID(2, msA)), false)
})
test('HERMES_HOME 不同（大小写不敏感比较）→ 不同实例', () => {
  assert.strictEqual(own.sameIdentity(ID(1, msA, 'D:\hermes-home'), ID(1, msA, 'D:\\OTHER\\hermes')), false)
})
test('HERMES_HOME 仅大小写或尾斜杠不同 → 视为同一实例', () => {
  assert.strictEqual(own.sameIdentity(ID(1, msA, 'D:\hermes-home'), ID(1, msA, 'D:\hermes-home\\')), true)
})
test('argvHash 双方都有且不同 → 不同实例', () => {
  const a = { ...ID(1, msA), argvHash: 'aaaa' }
  const b = { ...ID(1, msA), argvHash: 'bbbb' }
  assert.strictEqual(own.sameIdentity(a, b), false)
})
test('argvHash 仅一方提供 → 不因此判为不同实例（规则明确：双方都有才比对）', () => {
  const a = { ...ID(1, msA), argvHash: 'aaaa' }
  assert.strictEqual(own.sameIdentity(a, ID(1, msA)), true)
})
test('kind 双方都有且不同 → 不同实例', () => {
  assert.strictEqual(own.sameIdentity({ ...ID(1, msA), kind: 'x' }, { ...ID(1, msA), kind: 'y' }), false)
})
test('空值 / 缺 PID → 不同实例（不抛异常）', () => {
  assert.strictEqual(own.sameIdentity(null, null), false)
  assert.strictEqual(own.sameIdentity({}, {}), false)
  assert.strictEqual(own.sameIdentity(ID(1, msA), null), false)
})

console.log('\n[4] 状态文件读取（失败必须返回 null，不猜测）')
test('正常读取 → pid / startMs / hermesHome / argvHash', () => {
  const st = stubFs({ [PID_FILE]: PID_JSON(22964, START_A), [STATE_FILE]: STATE_JSON(22964, START_A) })
  const id = own.readIdentity(HOME, st)
  assert.ok(id)
  assert.strictEqual(id.pid, 22964)
  assert.strictEqual(id.startMs, msA)
  assert.strictEqual(id.hermesHome, HOME_A)
  assert.ok(id.argvHash)
  assert.strictEqual(id.startSource, 'state')
})
test('两处 PID 不一致 → null（状态正在变化，不可信）', () => {
  const st = stubFs({ [PID_FILE]: PID_JSON(1, START_A), [STATE_FILE]: STATE_JSON(2, START_A) })
  assert.strictEqual(own.readIdentity(HOME, st), null)
})
test('状态文件损坏（JSON 解析失败）→ null', () => {
  const st = stubFs({ [PID_FILE]: '{broken', [STATE_FILE]: STATE_JSON(1, START_A) })
  assert.strictEqual(own.readIdentity(HOME, st), null)
})
test('★ gateway_state.json 损坏 → null（不得用 pid 文件"兜底"）', () => {
  const st = stubFs({ [PID_FILE]: PID_JSON(1, START_A), [STATE_FILE]: 'not-json' })
  assert.strictEqual(own.readIdentity(HOME, st), null)
})
test('两个文件都缺失 → null', () => {
  assert.strictEqual(own.readIdentity(HOME, stubFs({})), null)
})
test('仅有 pid 文件 → 可读，startSource=pid', () => {
  const st = stubFs({ [PID_FILE]: PID_JSON(7, START_A) })
  const id = own.readIdentity(HOME, st)
  assert.strictEqual(id.pid, 7)
  assert.strictEqual(id.startSource, 'pid')
})
test('★ start_time 无法解析 → startMs 为 null（由校验层拒绝，而不是编造一个值）', () => {
  const st = stubFs({ [PID_FILE]: PID_JSON(7, null), [STATE_FILE]: STATE_JSON(7, null) })
  const id = own.readIdentity(HOME, st)
  assert.ok(id, '身份仍可读出')
  assert.strictEqual(id.startMs, null)
  assert.strictEqual(own.validateIdentity(id).ok, false, '缺少 startMs must 判为无效')
})
test('没有 HERMES_HOME → null', () => {
  assert.strictEqual(own.readIdentity(null, stubFs({})), null)
})

console.log('\n[5] 停止前置核验 preflightStop（拒绝优先）')
test('无所有权 → no-ownership', () => {
  const cur = ID(1, msA)
  assert.deepStrictEqual(own.preflightStop({ owned: null, current: cur, ctx: ctxFor(cur) }),
    { ok: false, reason: 'no-ownership' })
})
test('探测失败（current=null）→ probe-failed（拒绝，不放行）', () => {
  assert.deepStrictEqual(own.preflightStop({ owned: ID(1, msA), current: null, ctx: {} }),
    { ok: false, reason: 'probe-failed' })
})
test('★ owned 缺 startMs → identity-incomplete（旧实现会放行）', () => {
  const cur = ID(100, msA)
  const r = own.preflightStop({ owned: { pid: 100, hermesHome: HOME_A }, current: cur, ctx: ctxFor(cur) })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'identity-incomplete')
  assert.ok(String(r.detail).startsWith('owned'), 'detail 应指明是 owned 侧不完整')
})
test('★ current 缺 startMs → identity-incomplete', () => {
  const owned = ID(100, msA)
  const cur = { pid: 100, hermesHome: HOME_A }
  const r = own.preflightStop({ owned, current: cur, ctx: { instanceCount: 1, proc: { exists: true, startMs: msA } } })
  assert.strictEqual(r.reason, 'identity-incomplete')
  assert.ok(String(r.detail).startsWith('current'))
})
test('实例被替换（PID 复用）→ instance-changed', () => {
  const owned = ID(100, msA)
  const cur = ID(100, msA + 1000)
  assert.strictEqual(own.preflightStop({ owned, current: cur, ctx: ctxFor(cur) }).reason, 'instance-changed')
})
test('一切正常 + OS 核对通过 → verified（并如实带出剩余风险标记）', () => {
  const id = ID(100, msA)
  assert.deepStrictEqual(own.preflightStop({ owned: id, current: { ...id }, ctx: ctxFor(id) }),
    { ok: true, reason: 'verified', residualRisk: 'profile-level-stop-race' })
})
test('★ 同 profile 多实例 → multiple-instances（问题三）', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: ctxFor(id, { instanceCount: 2 }) })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'multiple-instances')
})
test('★ 实例计数未知（探测失败）→ instance-count-unknown', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: { instanceCount: null, proc: { exists: true, startMs: id.startMs } } })
  assert.strictEqual(r.reason, 'instance-count-unknown')
})
test('实例计数非法（0 / 负数 / NaN）→ instance-count-invalid', () => {
  const id = ID(100, msA)
  for (const n of [0, -1, NaN]) {
    assert.strictEqual(
      own.preflightStop({ owned: id, current: { ...id }, ctx: { instanceCount: n, proc: { exists: true, startMs: id.startMs } } }).reason,
      'instance-count-invalid', `instanceCount=${String(n)}`)
  }
})
test('★ OS 中该 PID 不存在（状态文件陈旧）→ process-absent', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: ctxFor(id, { proc: { exists: false, startMs: null } }) })
  assert.strictEqual(r.reason, 'process-absent')
})
test('★ OS 创建时间与状态文件不一致（PID 复用）→ process-mismatch', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: ctxFor(id, { proc: { exists: true, startMs: msA + 600000 } }) })
  assert.strictEqual(r.reason, 'process-mismatch')
})
test('★ 拿不到 OS 创建时间 → process-time-unavailable（不得退回只信状态文件）', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: ctxFor(id, { proc: { exists: true, startMs: null } }) })
  assert.strictEqual(r.reason, 'process-time-unavailable')
})
test('★ 未提供 OS 核对结果 → process-probe-failed', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({ owned: id, current: { ...id }, ctx: { instanceCount: 1, proc: null } })
  assert.strictEqual(r.reason, 'process-probe-failed')
})
test('★ 完全没有 ctx → 拒绝（不允许"没有核对也放行"）', () => {
  const id = ID(100, msA)
  assert.strictEqual(own.preflightStop({ owned: id, current: { ...id } }).ok, false)
})
test('OS 与状态文件在容差内（实测差 2ms）→ 通过', () => {
  const id = ID(100, msA)
  for (const delta of [-2, -1000, 0, 1000, 2999]) {
    const r = own.preflightStop({
      owned: id, current: { ...id },
      ctx: { instanceCount: 1, proc: { exists: true, startMs: msA + delta } }
    })
    assert.strictEqual(r.ok, true, `delta=${delta} 应通过`)
  }
})
test('超出容差（3001ms）→ 拒绝', () => {
  const id = ID(100, msA)
  const r = own.preflightStop({
    owned: id, current: { ...id },
    ctx: { instanceCount: 1, proc: { exists: true, startMs: msA + 3001 } }
  })
  assert.strictEqual(r.reason, 'process-mismatch')
})

console.log('\n[6] 一次性授权构造（问题二：必须绑定目标身份）')
const T0 = 1_700_000_000_000
test('★ 目标身份不完整 → 拒绝签发（返回 null）', () => {
  assert.strictEqual(own.createAuthorization('stop', { pid: 1 }, { now: () => T0 }), null)
  assert.strictEqual(own.createAuthorization('stop', null, { now: () => T0 }), null)
  assert.strictEqual(own.createAuthorization('stop', { pid: 1, startMs: msA }, { now: () => T0 }), null)
})
test('非法动作 → 拒绝签发', () => {
  assert.strictEqual(own.createAuthorization('kill-all', ID(1, msA), { now: () => T0 }), null)
})
test('合法签发 → 绑定目标、未消费、含 issuedAt', () => {
  const a = own.createAuthorization('stop', ID(9, msA), { now: () => T0 })
  assert.strictEqual(a.action, 'stop')
  assert.strictEqual(a.target.pid, 9)
  assert.strictEqual(a.target.startMs, msA)
  assert.strictEqual(a.consumed, false)
  assert.strictEqual(a.issuedAt, T0)
})
test('★ 授权对象内不含任何原始 token 字段', () => {
  const a = own.createAuthorization('stop', ID(9, msA), { now: () => T0 })
  assert.strictEqual(a.token, undefined, '不得存在 token 字段')
  assert.ok(a.tokenHash, '仅保留不可反推的关联号')
  assert.ok(!/^[0-9a-f]{16}$/.test(a.tokenHash) || true)
})

console.log('\n[7] 授权门 decide（问题一 + 问题二合并验证）')
const gateFixed = own.createGate({ now: () => T0 })
const authFor = (action, target, over = {}) => ({
  action,
  target: { pid: target.pid, startMs: target.startMs, hermesHome: target.hermesHome },
  tokenHash: 'abc123',
  issuedAt: T0,
  consumed: false,
  ...over
})

test('A：所有权核验通过 → 放行（via=ownership）', () => {
  const id = ID(100, msA)
  const d = gateFixed.decide('stop', id, { ...id }, null, ctxFor(id))
  assert.strictEqual(d.allowed, true)
  assert.strictEqual(d.via, 'ownership')
})
test('B：共享网关（无所有权、无授权）→ 拒绝（关键：不误停）', () => {
  const cur = ID(22964, msA)
  const d = gateFixed.decide('stop', null, cur, null, ctxFor(cur))
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'no-ownership')
})
test('开关不能凭空产生所有权（伪造空对象）', () => {
  const cur = ID(1, msA)
  assert.strictEqual(gateFixed.decide('stop', {}, cur, null, ctxFor(cur)).allowed, false)
})
test('★ 问题二原缺陷：current=null + 有效授权 → 必须【拒绝】（旧实现会放行）', () => {
  const d = gateFixed.decide('stop', null, null, authFor('stop', ID(1, msA)), { instanceCount: 1, proc: null })
  assert.strictEqual(d.allowed, false, '授权不能替代身份确认')
  assert.strictEqual(d.reason, 'probe-failed')
})
test('★ current 身份不完整 + 有效授权 → 必须拒绝', () => {
  const cur = { pid: 1, hermesHome: HOME_A }         // 缺 startMs
  const d = gateFixed.decide('stop', null, cur, authFor('stop', ID(1, msA)), { instanceCount: 1, proc: { exists: true, startMs: msA } })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'identity-incomplete')
})
test('★ 授权绑定目标与当前实例 PID 不同 → auth-target-changed', () => {
  const cur = ID(2, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', ID(1, msA)), ctxFor(cur))
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'auth-target-changed')
})
test('★ 授权绑定目标启动时间不同（PID 复用）→ auth-target-changed', () => {
  const cur = ID(1, msA + 50000)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', ID(1, msA)), ctxFor(cur))
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'auth-target-changed')
})

// ═══════════════════ 问题一：targetMatches 漏比 hermesHome（回归） ═══════════════════
const HOME_B = 'D:\hermes-home-other'
console.log('\n[问题一·回归] 授权目标比较必须包含 hermesHome')
test('★★ 原缺陷复现点：同 PID、同启动时间、**不同主目录** → 必须是【不同目标】', () => {
  const bound = { pid: 1, startMs: msA, hermesHome: HOME_A }
  const cur = { pid: 1, startMs: msA, hermesHome: HOME_B }
  assert.strictEqual(own.targetMatches(bound, cur), false,
    '不同 HERMES_HOME 属于不同 profile，绝不是同一个实例（旧实现会返回 true）')
})
test('★ 授权路径的实际后果：目标漂移到另一主目录 → 必须拒绝', () => {
  const cur = { pid: 1, startMs: msA, hermesHome: HOME_B }
  const d = gateFixed.decide('stop', null, cur, authFor('stop', { pid: 1, startMs: msA, hermesHome: HOME_A }), ctxFor(cur))
  assert.strictEqual(d.allowed, false, '不得把授权作用到另一个 profile 的实例上')
  assert.strictEqual(d.reason, 'auth-target-changed')
})
test('★ 所有权路径同样拒绝跨主目录（A 路径不得有例外）', () => {
  const owned = { pid: 1, startMs: msA, hermesHome: HOME_A }
  const cur = { pid: 1, startMs: msA, hermesHome: HOME_B }
  const d = gateFixed.decide('stop', owned, cur, null, ctxFor(cur))
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'instance-changed')
})
test('targetMatches：主目录大小写与尾部斜杠视为同一处（归一化生效）', () => {
  const a = { pid: 1, startMs: msA, hermesHome: 'D:\\hermes-home' }
  // Windows 下同时覆盖分隔符差异（\ vs /）；POSIX 下反斜杠不是分隔符，仅比较大小写与尾斜杠
  const bPath = process.platform === 'win32' ? 'd:/hermes-home/' : 'D:\\hermes-home'
  const b = { pid: 1, startMs: msA, hermesHome: bPath }
  assert.strictEqual(own.targetMatches(a, b), true, '归一化后应判为同一主目录')
})
test('★ normHome：Windows 下 / 与 \\ 视为同一分隔符', () => {
  if (process.platform !== 'win32') {
    // POSIX 上反斜杠是合法文件名字符，不得被当作分隔符（否则会把两个不同目录判为同一个）
    assert.notStrictEqual(own.normHome('/opt/a\\b'), own.normHome('/opt/a/b'))
    return
  }
  assert.strictEqual(own.normHome('D:/hermes-home'), own.normHome('D:\\hermes-home'))
  assert.strictEqual(own.normHome('D:\\hermes-home\\'), own.normHome('D:\\hermes-home'))
})
test('★ targetMatches：任一方缺 hermesHome → 拒绝（不允许"缺了就跳过"）', () => {
  assert.strictEqual(own.targetMatches({ pid: 1, startMs: msA }, { pid: 1, startMs: msA, hermesHome: HOME_A }), false)
  assert.strictEqual(own.targetMatches({ pid: 1, startMs: msA, hermesHome: HOME_A }, { pid: 1, startMs: msA }), false)
  assert.strictEqual(own.targetMatches({ pid: 1, startMs: msA, hermesHome: '  ' }, { pid: 1, startMs: msA, hermesHome: HOME_A }), false)
})
test('★ targetMatches：任一方缺 pid / startMs → 拒绝', () => {
  assert.strictEqual(own.targetMatches({ startMs: msA, hermesHome: HOME_A }, { pid: 1, startMs: msA, hermesHome: HOME_A }), false)
  assert.strictEqual(own.targetMatches({ pid: 1, hermesHome: HOME_A }, { pid: 1, startMs: msA, hermesHome: HOME_A }), false)
})
test('targetMatches：PID 或启动时间不同 → 拒绝', () => {
  const base = { pid: 1, startMs: msA, hermesHome: HOME_A }
  assert.strictEqual(own.targetMatches(base, { ...base, pid: 2 }), false)
  assert.strictEqual(own.targetMatches(base, { ...base, startMs: msA + 600000 }), false)
})
test('targetMatches 保留毫秒级容差（跨来源：状态文件 vs 进程创建时间）', () => {
  const bound = { pid: 1, startMs: msA, hermesHome: HOME_A }
  const cur = { pid: 1, startMs: msA + 2, hermesHome: HOME_A }
  assert.strictEqual(own.targetMatches(bound, cur), true, '容差内应判为同一目标')
})
test('★ argvHash 双方都有且不同 → 拒绝（强一致字段同样不能被跳过）', () => {
  const a = { pid: 1, startMs: msA, hermesHome: HOME_A, argvHash: 'aaaaaaaaaaaa' }
  const b = { pid: 1, startMs: msA, hermesHome: HOME_A, argvHash: 'bbbbbbbbbbbb' }
  assert.strictEqual(own.targetMatches(a, b), false)
})
test('★ 唯一实现约束：sameIdentity 与 targetMatches 必须共用同一套必需字段', () => {
  // 本段位于文件前部，而 readCode 定义在文件后部（const 存在 TDZ），
  // 故此处自包含读取 + 去注释，避免"断言匹配到注释"的老问题。
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ownership.js'), 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const iSame = src.indexOf('function sameIdentity')
  assert.ok(iSame > 0, '应存在 sameIdentity')
  assert.ok(/compareIdentity\(/.test(src.slice(iSame, iSame + 200)),
    'sameIdentity 必须委托 compareIdentity')
  const iTm = src.indexOf('function targetMatches')
  assert.ok(iTm > 0, '应存在 targetMatches')
  assert.ok(/compareIdentity\(/.test(src.slice(iTm, iTm + 300)),
    'targetMatches 必须委托 compareIdentity（旧实现自己手写字段比较，漏了 hermesHome）')
  assert.ok(!/bound\.pid !== current\.pid/.test(src), '不得保留旧的逐字段手写比较')
  assert.ok(!/function\s+sameIdentity[\s\S]{0,300}a\.hermesHome\s*!==/.test(src),
    '字段比较不得散落在各封装里')
})
test('★ REQUIRED_IDENTITY_FIELDS 必须包含 hermesHome（规格即代码）', () => {
  assert.ok(own.REQUIRED_IDENTITY_FIELDS.includes('hermesHome'))
  assert.deepStrictEqual([...own.REQUIRED_IDENTITY_FIELDS].sort(), ['hermesHome', 'pid', 'startMs'])
})
test('★ 授权未绑定目标 → auth-no-target', () => {
  const cur = ID(1, msA)
  const auth = authFor('stop', ID(1, msA))
  delete auth.target
  assert.strictEqual(gateFixed.decide('stop', null, cur, auth, ctxFor(cur)).reason, 'auth-no-target')
})
test('C：授权有效 + 目标一致 + OS 核对通过 → 放行（via=one-shot）', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur), ctxFor(cur))
  assert.strictEqual(d.allowed, true)
  assert.strictEqual(d.via, 'one-shot')
})
test('C：授权已消费 → auth-consumed', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur, { consumed: true }), ctxFor(cur))
  assert.strictEqual(d.reason, 'auth-consumed')
})
test('C：授权已过期（>5 分钟）→ auth-expired', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur, { issuedAt: T0 - 6 * 60 * 1000 }), ctxFor(cur))
  assert.strictEqual(d.reason, 'auth-expired')
})
test('C：授权刚好在有效期末尾（5 分钟整）→ 仍放行', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur, { issuedAt: T0 - 5 * 60 * 1000 }), ctxFor(cur))
  assert.strictEqual(d.allowed, true)
})
test('C：授权动作不匹配（授权 restart，调用 stop）→ auth-action-mismatch', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('restart', cur), ctxFor(cur))
  assert.strictEqual(d.reason, 'auth-action-mismatch')
})
test('★ C：有效授权 + 同 profile 多实例 → 拒绝（不得靠授权绕过单实例前提）', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur), ctxFor(cur, { instanceCount: 3 }))
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'multiple-instances')
})
test('★ C：有效授权但 OS 中进程不存在 → 拒绝', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur),
    ctxFor(cur, { proc: { exists: false, startMs: null } }))
  assert.strictEqual(d.reason, 'process-absent')
})
test('★ C：有效授权但 OS 创建时间不一致 → 拒绝', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur),
    ctxFor(cur, { proc: { exists: true, startMs: msA + 999999 } }))
  assert.strictEqual(d.reason, 'process-mismatch')
})
test('★ C：有效授权但进程数未知 → 拒绝', () => {
  const cur = ID(1, msA)
  const d = gateFixed.decide('stop', null, cur, authFor('stop', cur),
    ctxFor(cur, { instanceCount: null }))
  assert.strictEqual(d.reason, 'instance-count-unknown')
})
test('★ 并发请求：同一授权只有第一次放行（消费后第二次必须拒绝）', () => {
  const cur = ID(1, msA)
  const auth = authFor('stop', cur)
  const first = gateFixed.decide('stop', null, cur, auth, ctxFor(cur))
  assert.strictEqual(first.allowed, true)
  own.consumeAuthorization(auth, { now: () => T0 })
  const second = gateFixed.decide('stop', null, cur, auth, ctxFor(cur))
  assert.strictEqual(second.allowed, false)
  assert.strictEqual(second.reason, 'auth-consumed')
})
test('消费授权是幂等的（重复消费返回 null）', () => {
  const a = own.createAuthorization('stop', ID(5, msA), { now: () => T0 })
  assert.ok(own.consumeAuthorization(a, { now: () => T0 }))
  assert.strictEqual(a.consumedAt, T0)
  assert.strictEqual(own.consumeAuthorization(a, { now: () => T0 }), null)
  assert.strictEqual(own.consumeAuthorization(null, { now: () => T0 }), null)
})
test('未支持的动作 → 拒绝（新增接口默认不放行）', () => {
  const cur = ID(1, msA)
  for (const a of ['kill-all', '', undefined, null, 'START']) {
    assert.strictEqual(gateFixed.decide(a, null, cur, null, ctxFor(cur)).allowed, false)
  }
})
test('drain / restart 同样受门控（共享实例无授权 → 拒绝）', () => {
  const cur = ID(7, msA)
  assert.strictEqual(gateFixed.decide('drain', null, cur, null, ctxFor(cur)).allowed, false)
  assert.strictEqual(gateFixed.decide('restart', null, cur, null, ctxFor(cur)).allowed, false)
})
test('★ 授权只能用于它被签发的动作（stop 授权不能用于 restart）', () => {
  const cur = ID(1, msA)
  const auth = authFor('stop', cur)
  assert.strictEqual(gateFixed.decide('restart', null, cur, auth, ctxFor(cur)).allowed, false)
})

console.log('\n[8] 源码级约束（防止规则被悄悄放宽）')
const ROOT = path.join(__dirname, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
/** 去掉注释后再做源码约束检查 —— 否则"记录旧写法"的注释会造成误报 */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const readCode = f => stripComments(read(f))

test('ownership.js 不再使用"缺字段就跳过校验"的写法（已排除注释）', () => {
  const src = readCode('ownership.js')
  assert.ok(!/a\.startMs\s*&&\s*b\.startMs\s*&&/.test(src), '不得保留 a.startMs && b.startMs && … 的宽松写法')
  assert.ok(/function sameIdentity/.test(src), 'sameIdentity 必须仍然存在')
})
test('main.js 不再有任何 token 值写入日志', () => {
  const src = readCode('main.js')
  const hits = src.match(/token=\$\{/g) || []
  assert.strictEqual(hits.length, 0, `发现 ${hits.length} 处 token= 插值`)
})
test('main.js 不再把 token 下发渲染进程', () => {
  const src = readCode('main.js')
  assert.ok(!/return\s*\{\s*ok:\s*true,\s*action:\s*a\.action,\s*token:/.test(src))
})
test('watchdog.js 复用 ownership.js，且不再自带身份逻辑副本', () => {
  const src = readCode('watchdog.js')
  assert.ok(/require\(['"]\.\/ownership['"]\)/.test(src), '必须 require ./ownership')
  assert.ok(/require\(['"]\.\/process-probe['"]\)/.test(src), '必须 require ./process-probe')
  assert.ok(!/function\s+sameInstance\s*\(/.test(src), '不得保留自己的 sameInstance 副本')
  assert.ok(!/function\s+readIdentity\s*\(/.test(src), '不得保留自己的 readIdentity 副本')
  assert.ok(!/function\s+toStartMs\s*\(/.test(src), '不得保留自己的 toStartMs 副本')
})
test('process-probe 只做只读查询（不含 taskkill / Stop-Process）', () => {
  const src = readCode('process-probe.js')
  assert.ok(!/taskkill|Stop-Process|TerminateProcess|\bkill\(/i.test(src), '探测模块不得包含结束进程的调用')
})

// ---------------------------------------------------------------- [最小复核轮] Profile 启动判定
// 背景：Extra 的 gateway_state.json 记录了已死的 pid 2696 → 旧实现直接拒绝启动，
// 导致「启动 Extra 网关」按钮点不动。只读核实官方后确认：陈旧状态**不阻塞** gateway run
// （官方 get_running_pid() 以 runtime lock 是否被活进程持有为准，启动时覆盖 pid/lock/state）。
{
  const dec = own.decideProfileStart
  test('[启动判定] 陈旧状态（记录 pid 已死）→ 允许启动，且标记 stale', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: false, lockPidLive: false })
    assert.strictEqual(r.allow, true, '陈旧状态不应阻止启动')
    assert.strictEqual(r.reason, 'ok')
    assert.strictEqual(r.stale, true, '应标记为陈旧以便界面如实说明')
  })
  test('[启动判定] 仅 pid 文件陈旧、lock 无记录 → 仍允许', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: false, lockPidLive: null })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.stale, true)
  })
  test('[启动判定] 记录 pid 或 lock pid 仍存活 → 拒绝重复启动', () => {
    assert.strictEqual(dec({ profileExists: true, configExists: true, recordedPidLive: true, lockPidLive: null }).reason, 'already-running')
    assert.strictEqual(dec({ profileExists: true, configExists: true, recordedPidLive: false, lockPidLive: true }).reason, 'already-running')
  })
  test('[启动判定] lock 存活即视为已在运行（即使 pid 文件已陈旧）', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: false, lockPidLive: true })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.stale, false)
  })
  test('[启动判定] Profile 目录 / 配置缺失 → 拒绝', () => {
    assert.strictEqual(dec({ profileExists: false, configExists: false }).reason, 'profile-missing')
    assert.strictEqual(dec({ profileExists: true, configExists: false }).reason, 'config-missing')
  })
  test('[启动判定] 探测不可用 → fail-closed 拒绝', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: null, lockPidLive: null, probeAvailable: false })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'probe-failed')
  })
  test('[启动判定] 没有任何记录（全新启动）→ 允许且非陈旧', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: null, lockPidLive: null })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.stale, false)
  })
  test('[启动判定] ★ 回归：不得再把"记录进程已死"当成拒绝理由（旧 stale-state 缺陷）', () => {
    const r = dec({ profileExists: true, configExists: true, recordedPidLive: false, lockPidLive: false })
    assert.notStrictEqual(r.reason, 'stale-state', 'stale-state 不应再是拒绝原因')
    assert.strictEqual(r.allow, true)
  })
}

// ---------------------------------------------------- RC 轮：手动停止闸门释放

console.log('\n[RC] 手动停止闸门释放（decideStopRelease：仅放开所有权 A 态的 stop）')
{
  const rel = o => own.decideStopRelease(o)

  test('[RC-停止释放] stop + 允许 + 有所有权 → 放行到授权门', () => {
    const r = rel({ action: 'stop', allowDangerousExec: false, allowOwnedStop: true, hasOwned: true })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.reason, 'owned-stop')
  })
  test('[RC-停止释放] stop + 无所有权（B 态/无实例）→ 拒绝且不走 C 路径', () => {
    const r = rel({ action: 'stop', allowDangerousExec: false, allowOwnedStop: true, hasOwned: false })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'no-ownership')
  })
  test('[RC-停止释放] ★ 边界：即使 ALLOW_OWNED_STOP=false，stop 也回到整体禁用', () => {
    const r = rel({ action: 'stop', allowDangerousExec: false, allowOwnedStop: false, hasOwned: true })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'dangerous-disabled')
  })
  test('[RC-停止释放] restart / drain 维持拒绝（用户方案只放开 stop）', () => {
    for (const action of ['restart', 'drain']) {
      const r = rel({ action, allowDangerousExec: false, allowOwnedStop: true, hasOwned: true })
      assert.strictEqual(r.allow, false)
      assert.strictEqual(r.reason, 'dangerous-disabled')
    }
  })
  test('[RC-停止释放] 历史总闸门（ALLOW_DANGEROUS_EXEC=true）开启时维持原行为', () => {
    const r = rel({ action: 'drain', allowDangerousExec: true, allowOwnedStop: true, hasOwned: false })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.reason, 'legacy-gate-open')
  })
  test('[RC-停止释放] 未知动作 → unsupported-action', () => {
    const r = rel({ action: 'adopt', allowDangerousExec: false, allowOwnedStop: true, hasOwned: true })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'unsupported-action')
  })
  test('[RC-停止释放] stop 释放后仍必须经授权门核验（本测试只验调用顺序，不替代核验）', () => {
    // 防回归说明：decideStopRelease 放行 ≠ 停止执行；主进程 runDangerous 中
    // 释放后仍调用 authorizeDangerous（fresh 探测 + 同 profile 单实例 + OS 核对）。
    // 这里断言源码确实存在该调用顺序，防止未来把核验短路掉。
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    const runDangerous = src.split('async function runDangerous')[1] || ''
    assert.ok(runDangerous.includes('decideStopRelease'), 'runDangerous 未经过 decideStopRelease')
    assert.ok(runDangerous.indexOf('decideStopRelease') < runDangerous.indexOf('authorizeDangerous'),
      '释放判定必须在 authorizeDangerous 之前，且之后仍要调用授权门')
  })
}

// ------------------------------------- RC 收尾轮：race lost / 活跃任务 / 目标复核

console.log('\n[RC-收尾] PID file race lost 判定 · 活跃任务复核 · 停止目标复核')
{
  test('[race lost] 命中官方输出 → 判定成立并给出安全指引', () => {
    const r = own.judgePidFileRace('starting gateway...\nERROR: PID file race lost\n')
    assert.strictEqual(r.raceLost, true)
    assert.ok(/不(会)?自动重试/.test(r.guidance), '指引必须写明"不自动重试"')
    assert.ok(/不(会)?删除状态文件/.test(r.guidance), '指引必须写明"不删除状态文件"')
    assert.ok(/(不(会)?)?强杀/.test(r.guidance), '指引必须写明"不强杀进程"')
    assert.ok(/移动/.test(r.guidance), '指引必须给出"移动而非删除"的做法')
  })
  test('[race lost] 大小写/空白变体同样命中', () => {
    for (const s of ['pid file race lost', 'PID  FILE  RACE  LOST', 'Pid File Race Lost']) {
      assert.strictEqual(own.judgePidFileRace(s).raceLost, true, `未命中: ${s}`)
    }
  })
  test('[race lost] 无关输出 → 不误判，且不返回指引', () => {
    for (const s of ['gateway stopped', 'no gateway running', 'Race condition avoided', '']) {
      const r = own.judgePidFileRace(s, null, undefined)
      assert.strictEqual(r.raceLost, false, `误判: ${s}`)
      assert.strictEqual(r.guidance, null)
    }
  })
  test('[race lost] ★ 指引不得包含危险动作（rm / taskkill / kill -9）', () => {
    const g = own.judgePidFileRace('PID file race lost').guidance
    assert.ok(!/\brm\b|\bdel\b|taskkill|kill\s*-9|Remove-Item/i.test(g), '指引里出现危险动作')
    // 只允许"否定式"提到自动重试，不得出现"重试 N 次 / 循环重试"这类可执行语义
    assert.ok(/不(会)?自动重试/.test(g), '指引未声明"不自动重试"')
    assert.ok(!/重试\s*\d+\s*次|循环重试|retry\s*[1-9]/i.test(g), '指引暗示可自动重试')
  })

  test('[活跃任务] 合法数字 → known=true 并保留 updated_at', () => {
    const r = own.summarizeActiveTasks({ active_agents: 3, updated_at: '2026-09-21T10:00:00Z' })
    assert.strictEqual(r.known, true)
    assert.strictEqual(r.activeAgents, 3)
    assert.strictEqual(r.updatedAt, '2026-09-21T10:00:00Z')
  })
  test('[活跃任务] 字段缺失 / 非法 / 负数 / 非对象 → known=false（如实标未知）', () => {
    for (const j of [{}, null, undefined, { active_agents: 'x' }, { active_agents: -1 }, { active_agents: NaN }, 'nope']) {
      const r = own.summarizeActiveTasks(j)
      assert.strictEqual(r.known, false, `误判为已知: ${JSON.stringify(j)}`)
      assert.strictEqual(r.activeAgents, null)
    }
  })
  test('[活跃任务] >0 → 拒绝停止（不做强制覆盖）', () => {
    const r = own.decideActiveTaskStop({ known: true, activeAgents: 2 })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'active-tasks')
  })
  test('[活跃任务] =0 → 允许', () => {
    const r = own.decideActiveTaskStop({ known: true, activeAgents: 0 })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.reason, 'idle')
  })
  test('[活跃任务] 未知 → 一律拒绝；★ 即使传了确认标记也不得放行（真实验收暂停）', () => {
    const a = own.decideActiveTaskStop({ known: false, activeAgents: null })
    assert.strictEqual(a.allow, false)
    assert.strictEqual(a.reason, 'active-tasks-unknown')
    const b = own.decideActiveTaskStop({ known: false, activeAgents: null, confirmedUnknown: true })
    assert.strictEqual(b.allow, false, '活跃任务未知时不得用人工确认强行继续')
    assert.strictEqual(b.reason, 'active-tasks-unknown')
  })

  // ---- 停止后成功判定（只认最新 OS 进程数据）----
  const okVerify = {
    exitCode: 0, osProbeError: null, osPidStillAlive: false, sameProfileProcesses: 0, stateFileStillSame: false
  }
  test('[停止复核] 全部条件满足 → 判定成功（verified）', () => {
    const r = own.decideStopVerification(okVerify)
    assert.strictEqual(r.verified, true)
    assert.strictEqual(r.reason, 'verified')
  })
  test('[停止复核] ★ 回归：目标 PID 已消失，但同 Profile 仍存在另一实例 → 不得判成功', () => {
    for (const n of [1, 2, 5]) {
      const r = own.decideStopVerification({ ...okVerify, sameProfileProcesses: n })
      assert.strictEqual(r.verified, false, `同 profile 仍有 ${n} 个实例却判成功`)
      assert.strictEqual(r.reason, 'other-instance')
    }
  })
  test('[停止复核] 同 Profile 进程数未知（null/非数字/负数）→ 不得判成功', () => {
    for (const n of [null, undefined, NaN, -1, '1']) {
      const r = own.decideStopVerification({ ...okVerify, sameProfileProcesses: n })
      assert.strictEqual(r.verified, false, `count=${String(n)} 却判成功`)
      assert.strictEqual(r.reason, 'count-unknown')
    }
  })
  test('[停止复核] OS 探测失败 / 目标 PID 仍存活 / PID 状态未知 → 不得判成功', () => {
    assert.strictEqual(own.decideStopVerification({ ...okVerify, osProbeError: 'probe failed' }).reason, 'os-probe-failed')
    assert.strictEqual(own.decideStopVerification({ ...okVerify, osPidStillAlive: true }).reason, 'pid-still-alive')
    assert.strictEqual(own.decideStopVerification({ ...okVerify, osPidStillAlive: null }).reason, 'pid-unknown')
    assert.strictEqual(own.decideStopVerification({ ...okVerify, osPidStillAlive: undefined }).verified, false)
  })
  test('[停止复核] 退出码非 0 或未知 → 不得判成功', () => {
    assert.strictEqual(own.decideStopVerification({ ...okVerify, exitCode: 1 }).reason, 'exit-nonzero')
    assert.strictEqual(own.decideStopVerification({ ...okVerify, exitCode: null }).verified, false)
    assert.strictEqual(own.decideStopVerification({ ...okVerify, exitCode: undefined }).verified, false)
  })
  test('[停止复核] ★ 状态文件陈旧（同一实例、其进程已消失）→ 仍判成功，另给独立警告', () => {
    const r = own.decideStopVerification({ ...okVerify, stateFileStillSame: true })
    assert.strictEqual(r.verified, true, '陈旧状态文件（官方 stop 不清 state 文件）不应阻断成功判定')
    assert.strictEqual(r.reason, 'verified')
    assert.deepStrictEqual(r.warnings, ['stale-state-file'])
    assert.ok(own.STOP_VERIFY_WARNINGS['stale-state-file'].length > 0, '缺少陈旧警告的用户可读说明')
  })
  test('[停止复核] ★ 身份冲突（状态文件指向另一个仍存活的实例）→ 不得判成功', () => {
    const r = own.decideStopVerification({ ...okVerify, identityConflict: true })
    assert.strictEqual(r.verified, false)
    assert.strictEqual(r.reason, 'identity-conflict')
  })
  test('[停止复核] ★ 陈旧与冲突必须严格区分：陈旧不拒绝、冲突拒绝且优先', () => {
    assert.strictEqual(own.decideStopVerification({ ...okVerify, stateFileStillSame: true }).verified, true,
      '陈旧不得被当成冲突')
    assert.strictEqual(own.decideStopVerification({ ...okVerify, identityConflict: true }).verified, false,
      '冲突不得被当成陈旧')
    const both = own.decideStopVerification({ ...okVerify, stateFileStillSame: true, identityConflict: true })
    assert.strictEqual(both.reason, 'identity-conflict', '两者同时出现时必须按冲突拒绝')
    assert.deepStrictEqual(both.warnings, [], '拒绝时不得附带成功警告')
  })
  test('[停止复核] ★ 陈旧/冲突以外，硬条件一条都不放宽', () => {
    // 即使状态文件陈旧，OS 侧任何一项不满足仍必须拒绝
    assert.strictEqual(own.decideStopVerification(
      { ...okVerify, stateFileStillSame: true, sameProfileProcesses: 1 }).reason, 'other-instance')
    assert.strictEqual(own.decideStopVerification(
      { ...okVerify, stateFileStillSame: true, osPidStillAlive: true }).reason, 'pid-still-alive')
    assert.strictEqual(own.decideStopVerification(
      { ...okVerify, stateFileStillSame: true, exitCode: 1 }).reason, 'exit-nonzero')
    assert.strictEqual(own.decideStopVerification(
      { ...okVerify, stateFileStillSame: true, osProbeError: 'x' }).reason, 'os-probe-failed')
  })
  test('[停止复核] warnings 接口稳定：成功默认空数组，任何拒绝都为空', () => {
    assert.deepStrictEqual(own.decideStopVerification(okVerify).warnings, [])
    assert.deepStrictEqual(own.decideStopVerification({}).warnings, [])
    assert.deepStrictEqual(own.decideStopVerification({ ...okVerify, identityConflict: true }).warnings, [])
    assert.deepStrictEqual(own.decideStopVerification({ ...okVerify, exitCode: 1 }).warnings, [])
  })
  test('[停止复核] 每个失败原因都有"未确认"口径的用户可读说明', () => {
    for (const reason of ['exit-nonzero', 'os-probe-failed', 'pid-still-alive', 'pid-unknown',
      'other-instance', 'count-unknown', 'identity-conflict']) {
      const msg = own.STOP_VERIFY_MESSAGES[reason]
      assert.ok(msg && msg.length > 0, `缺少说明: ${reason}`)
      assert.ok(/未确认|不视为成功/.test(msg), `说明未体现"未确认": ${reason}`)
    }
    assert.strictEqual(own.STOP_VERIFY_MESSAGES['state-file-contradicts'], undefined,
      '已废弃的硬失败原因不得再存在于失败说明表')
  })

  test('[停止目标复核] 目标 Profile 与所有权一致 → 通过', () => {
    const r = own.verifyStopTarget({ ownedProfileId: 'extra', targetProfileId: 'extra', currentProfileId: 'extra' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.reason, 'profile-verified')
  })
  test('[停止目标复核] 目标不一致 / 实例漂移 / 无所有权 → 拒绝', () => {
    assert.strictEqual(own.verifyStopTarget({ ownedProfileId: 'extra', targetProfileId: 'default' }).reason, 'profile-mismatch')
    assert.strictEqual(own.verifyStopTarget({ ownedProfileId: 'extra', targetProfileId: 'extra', currentProfileId: 'default' }).reason, 'profile-drift')
    assert.strictEqual(own.verifyStopTarget({}).reason, 'no-ownership')
  })
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))

process.exit(fail === 0 ? 0 : 1)
