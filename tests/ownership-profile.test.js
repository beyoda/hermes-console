/**
 * Hermes 桌面控制台 — 所有权「按 Profile 登记」隔离测试
 *
 * 运行：node tests/ownership-profile.test.js
 * 无第三方依赖；直接测试 ownership.js 的纯函数逻辑，并用一个 faithful 的
 * byProfile 内存模型镜像 main.js 的 registerOwnershipFor / releaseOwnership 语义。
 *
 * ⚠️ 不触碰真实网关、不启动 Electron、不调用任何外部进程。
 *
 * 覆盖本轮缺陷修复的关键保证：
 *   [A] 启动 default → 身份核验（PID + 创建时间 + home + 单实例）通过 → A 态登记
 *   [B] 启动 Extra 不会覆盖 default 的登记（两个 Profile 各自独立）
 *   [C] 外部启动的实例不得被自动认领（身份不可读 / 核验失败 → 不登记）
 *   [D] PID 复用 / Profile 不一致 / 登记失败 → 禁止停止（不谎称已取得所有权）
 *   [E] 释放所有权只影响目标 Profile
 *   [F] 旧版（v1 单槽）记录迁移 / 失效记录不得产生错误授权
 */

const assert = require('node:assert')
const own = require('../ownership')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}

// 两个 Profile 的 home（与 main.js PROFILES 一致；normHome 会统一成小写反斜杠）
const HOME_DEFAULT = 'D:\hermes-home'
const HOME_EXTRA = 'D:\hermes-home\\profiles\\extra'
const PROFILES = [
  { id: 'default', home: HOME_DEFAULT },
  { id: 'extra', home: HOME_EXTRA }
]

// 一个真实的进程探测结果（OS 里此刻活着的网关进程，含创建时间）
const proc = (pid, startMs) => ({ pid, startMs })

// ============================================================ [A] 身份核验 → 登记
console.log('\n[A] 身份核验 → A 态登记')
{
  const ident = { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT }
  const goodProcs = [proc(15332, 1000)]

  test('[A] 身份完整 + home 匹配 + 进程存在且创建时间一致 + 单实例 → verified（可登记）', () => {
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: goodProcs, instanceCount: 1 })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.reason, 'verified')
  })

  test('[A] 身份缺少字段（无 startMs）→ identity-incomplete，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: { pid: 15332, hermesHome: HOME_DEFAULT }, profileHome: HOME_DEFAULT, procs: goodProcs, instanceCount: 1 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'identity-incomplete')
  })

  test('[A] home 与 Profile 不一致（跨 Profile 串台）→ profile-mismatch，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: { pid: 15332, startMs: 1000, hermesHome: HOME_EXTRA }, profileHome: HOME_DEFAULT, procs: goodProcs, instanceCount: 1 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-mismatch')
  })

  test('[A] OS 里找不到该 PID → process-absent，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: [proc(9999, 1000)], instanceCount: 0 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'process-absent')
  })

  test('[A] 进程创建时间读不到（null）→ process-time-unavailable，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: [{ pid: 15332, startMs: null }], instanceCount: 1 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'process-time-unavailable')
  })

  test('[A] ★ PID 复用：同 PID 但创建时间不同 → process-mismatch，不得登记', () => {
    // 旧网关进程已死，新进程复用了 15332 这个 PID（startMs 完全不同）
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: [proc(15332, 999999)], instanceCount: 1 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'process-mismatch')
  })

  test('[A] 该 Profile 实例数 != 1（另有同名实例）→ multiple-instances，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: goodProcs, instanceCount: 2 })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'multiple-instances')
  })

  test('[A] 实例数未知（null）→ instance-count-unknown，不得登记', () => {
    const r = own.verifyProfileIdentity({ identity: ident, profileHome: HOME_DEFAULT, procs: goodProcs, instanceCount: null })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'instance-count-unknown')
  })
}

// ============================================================ 模拟 byProfile 存储模型
// 忠实镜像 main.js 的语义：registerOwnershipFor 先核验再 setOwned；releaseOwnership 只删目标 Profile。
function makeStore () {
  const byProfile = {}
  return {
    byProfile,
    ownedOf (id) { return byProfile[String(id)] || null },
    async register (prof, identity, procs) {
      // 镜像 registerOwnershipFor：先核实身份再登记
      if (!identity) return { acquired: false, reason: 'identity-unreadable' }
      const count = own.countProfileInstances(procs, identity)
      const check = own.verifyProfileIdentity({ identity, profileHome: prof.home, procs: procs || [], instanceCount: count })
      if (!check.ok) return { acquired: false, reason: check.reason }
      byProfile[String(prof.id)] = identity
      return { acquired: true, reason: 'registered' }
    },
    release (id) { delete byProfile[String(id)] }
  }
}

// ============================================================ [B] Extra 不覆盖 default
console.log('\n[B] 启动 Extra 不会覆盖 default 登记')
{
  const store = makeStore()
  const coverIdent = { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT }
  const cjIdent = { pid: 17771, startMs: 2000, hermesHome: HOME_EXTRA }
  const defaultProfs = [proc(15332, 1000)]
  const cjProfs = [proc(17771, 2000)]

  test('[B] 启动 default 登记 default；再启动 Extra 登记 extra；两者并存', async () => {
    const a = await store.register(PROFILES[0], coverIdent, defaultProfs)
    assert.strictEqual(a.acquired, true)
    const b = await store.register(PROFILES[1], cjIdent, cjProfs)
    assert.strictEqual(b.acquired, true)
    assert.ok(store.ownedOf('default'), 'default 登记仍在')
    assert.ok(store.ownedOf('extra'), 'extra 登记已写入')
    assert.strictEqual(store.ownedOf('default').pid, 15332)
    assert.strictEqual(store.ownedOf('extra').pid, 17771)
  })

  test('[B] ★ 反向保证：另一个 Profile 的 PID 不被算进本 Profile 计数（互不干扰）', () => {
    // default 的身份是 15332；把 cj 的进程也放进 default 的 procs，计数仍只认 15332
    const mixedProcs = [proc(15332, 1000), proc(17771, 2000)]
    const count = own.countProfileInstances(mixedProcs, coverIdent)
    assert.strictEqual(count, 1, 'Extra 的进程不该被算进 default 的实例数')
  })

  test('[B] 进程探测不可用（null）→ count 返回 null，不误判、不登记', () => {
    assert.strictEqual(own.countProfileInstances(null, coverIdent), null)
  })
}

// ============================================================ [C] 外部启动不得被自动认领
console.log('\n[C] 外部启动的实例不得被自动认领')
{
  const store = makeStore()
  const defaultProfs = [proc(15332, 1000)]

  test('[C] 状态文件身份读不到（外部实例未被本控制台登记）→ 不登记', async () => {
    const r = await store.register(PROFILES[0], null, defaultProfs)
    assert.strictEqual(r.acquired, false)
    assert.strictEqual(r.reason, 'identity-unreadable')
    assert.strictEqual(store.ownedOf('default'), null, '不得自动认领')
  })

  test('[C] 身份读到但 OS 核验失败（进程不存在）→ 不登记', async () => {
    const ident = { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT }
    const r = await store.register(PROFILES[0], ident, [proc(9999, 1000)]) // 没有 15332
    assert.strictEqual(r.acquired, false)
    assert.strictEqual(r.reason, 'process-absent')
    assert.strictEqual(store.ownedOf('default'), null)
  })
}

// ============================================================ [D] 禁止停止（登记失败/串台）
console.log('\n[D] PID 复用 / Profile 不一致 / 登记失败 → 禁止停止')
{
  test('[D] 停止目标 Profile 与所有权不一致 → profile-mismatch（拒绝执行）', () => {
    const r = own.verifyStopTarget({ ownedProfileId: 'default', targetProfileId: 'extra', currentProfileId: 'extra' })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-mismatch')
  })

  test('[D] 实例已漂移到别的 Profile（current 不一致）→ profile-drift', () => {
    const r = own.verifyStopTarget({ ownedProfileId: 'default', targetProfileId: 'default', currentProfileId: 'extra' })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-drift')
  })

  test('[D] 无所有权记录 → no-ownership', () => {
    const r = own.verifyStopTarget({})
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'no-ownership')
  })

  test('[D] 一切一致 → profile-verified（放行，交由主进程执行前最后一道身份复核）', () => {
    const r = own.verifyStopTarget({ ownedProfileId: 'default', targetProfileId: 'default', currentProfileId: 'default' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.reason, 'profile-verified')
  })
}

// ============================================================ [E] 释放只影响目标 Profile
console.log('\n[E] 释放所有权只影响目标 Profile')
{
  const store = makeStore()
  test('[E] 同时持有 default + extra，释放 extra 后 default 仍持有', async () => {
    await store.register(PROFILES[0], { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT }, [proc(15332, 1000)])
    await store.register(PROFILES[1], { pid: 17771, startMs: 2000, hermesHome: HOME_EXTRA }, [proc(17771, 2000)])
    assert.ok(store.ownedOf('default') && store.ownedOf('extra'))
    store.release('extra')
    assert.strictEqual(store.ownedOf('extra'), null, 'extra 已释放')
    assert.ok(store.ownedOf('default'), 'default 不受影响')
    assert.strictEqual(store.ownedOf('default').pid, 15332)
  })
}

// ============================================================ [F] 旧版记录迁移 / 失效不产错误授权
console.log('\n[F] 旧版（v1 单槽）记录迁移 / 失效记录不得产生错误授权')
{
  test('[F] v1 合法单槽记录 → 迁到对应 Profile（byProfile），legacy=true', () => {
    const out = own.migrateOwnershipRecord({ gateway: { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT } }, PROFILES)
    assert.strictEqual(out.version, 2)
    assert.strictEqual(out.legacy, true)
    assert.ok(out.byProfile.default, '迁到 default')
    assert.deepStrictEqual(out.dropped, [])
  })

  test('[F] v1 身份不完整 → 丢弃，不落到任何 Profile', () => {
    const out = own.migrateOwnershipRecord({ gateway: { pid: 15332, hermesHome: HOME_DEFAULT } }, PROFILES)
    assert.strictEqual(Object.keys(out.byProfile).length, 0)
    assert.ok(out.dropped.length >= 1)
  })

  test('[F] v1 home 无法解析到已知 Profile → 丢弃', () => {
    const out = own.migrateOwnershipRecord({ gateway: { pid: 15332, startMs: 1000, hermesHome: 'D:\\unknown' } }, PROFILES)
    assert.strictEqual(Object.keys(out.byProfile).length, 0)
    assert.ok(out.dropped.length >= 1)
  })

  test('[F] v2 双 Profile 合法 → 各自归位', () => {
    const out = own.migrateOwnershipRecord({
      gateways: {
        default: { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT },
        extra: { pid: 17771, startMs: 2000, hermesHome: HOME_EXTRA }
      }
    }, PROFILES)
    assert.ok(out.byProfile.default && out.byProfile.extra)
    assert.deepStrictEqual(out.dropped, [])
  })

  test('[F] v2 含未知 Profile / home 不一致 → 该条丢弃，其余保留', () => {
    const out = own.migrateOwnershipRecord({
      gateways: {
        default: { pid: 15332, startMs: 1000, hermesHome: HOME_DEFAULT },
        ghost: { pid: 1, startMs: 1, hermesHome: HOME_DEFAULT },          // 未知 Profile
        extra: { pid: 17771, startMs: 2000, hermesHome: HOME_DEFAULT }  // home 不一致
      }
    }, PROFILES)
    assert.ok(out.byProfile.default, '合法的 default 保留')
    assert.strictEqual(out.byProfile.extra, undefined, 'home 不一致的 extra 被丢弃')
    assert.ok(out.dropped.some(d => d.includes('ghost')), '未知 Profile 被丢弃')
  })

  test('[F] 空/非对象输入 → 安全返回空结构，不抛错、不落权', () => {
    for (const bad of [null, undefined, 123, 'x', {}]) {
      const out = own.migrateOwnershipRecord(bad, PROFILES)
      assert.strictEqual(out.version, 2)
      assert.deepStrictEqual(out.byProfile, {})
    }
  })
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))
process.exit(fail === 0 ? 0 : 1)
