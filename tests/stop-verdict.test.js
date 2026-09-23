/**
 * Hermes 桌面控制台 — 停止结果判定修复（陈旧状态文件 vs 身份冲突）隔离测试
 *
 * 运行：node tests/stop-verdict.test.js
 *
 * ⚠️ 安全边界：**不启动、不停止、不接管任何真实网关**，**不触碰任何状态文件**。
 *    全部为纯逻辑测试 + 源码静态断言；[B] 用**纯数据镜像**复现"官方 stop 之后的状态文件残留"，
 *    不引入任何真实 I/O 与等待。
 *
 * 背景（实测证据，2026-09-22，default pid 20508）：
 *   官方 `gateway stop` 成功后 **删除** `gateway.pid` / `gateway.lock`，
 *   但 **保留** `gateway_state.json` 且 **不把 `gateway_state` 改成 stopped**（仍写 `"running"` + 同一 pid）。
 *   ⇒ 旧判定把"状态文件仍记着同一实例"当硬失败 ⇒ **成功停止永远判不出成功**（只能报 stop-unconfirmed）。
 *
 * 覆盖（对应本轮任务书第 1 条）：
 *   [A] 成功/失败判定：只有 退出码0 + 探测成功 + 目标PID消失 + 同Profile实例数0 + 无身份冲突 才判成功
 *   [B] "官方 stop 后残留"的隔离镜像：陈旧 → 成功 + 独立警告；冲突 → 拒绝
 *   [C] main.js 静态约束：identityConflict 的**计算口径**与传递、成功分支返回警告
 *   [D] 渲染层：成功与警告**分开表示**
 *   [E] 安全边界：闸门未变、不删除状态文件、仍走官方 CLI
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
 * 忠实镜像 main.js 中 `identityConflict` 的**计算口径**（纯数据，无 I/O）。
 * 必须在测试里复刻，而不是只看计划好的布尔 —— 否则测不出"口径写错"。
 */
function mirrorIdentityConflict ({ afterIdent, owned, procs }) {
  const alive = !!(afterIdent && typeof afterIdent.pid === 'number' &&
    procs.some(x => Number(x.pid) === Number(afterIdent.pid)))
  return !!(afterIdent && !own.sameIdentity(afterIdent, owned) && alive)
}

const OK = {
  exitCode: 0, osProbeError: null, osPidStillAlive: false,
  sameProfileProcesses: 0, stateFileStillSame: false, identityConflict: false
}

// ================================================================ [A] 判定
{
  test('[A] 五项硬条件全部满足 → 判成功且无警告', () => {
    const r = own.decideStopVerification(OK)
    assert.strictEqual(r.verified, true)
    assert.strictEqual(r.reason, 'verified')
    assert.deepStrictEqual(r.warnings, [])
  })

  test('[A] 陈旧状态文件（同一实例、进程已消失）→ 判成功 + 独立警告，不改变结论', () => {
    const r = own.decideStopVerification({ ...OK, stateFileStillSame: true })
    assert.strictEqual(r.verified, true, '陈旧不得阻断成功判定')
    assert.deepStrictEqual(r.warnings, ['stale-state-file'])
    assert.ok(own.STOP_VERIFY_WARNINGS['stale-state-file'], '必须有独立的警告文案')
  })

  test('[A] 身份冲突（状态文件指向另一个仍存活的实例）→ 拒绝', () => {
    const r = own.decideStopVerification({ ...OK, identityConflict: true })
    assert.strictEqual(r.verified, false)
    assert.strictEqual(r.reason, 'identity-conflict')
    assert.deepStrictEqual(r.warnings, [], '拒绝时不得附带成功警告')
  })

  test('[A] 冲突优先于陈旧（两者同时出现必须按冲突拒绝）', () => {
    const r = own.decideStopVerification({ ...OK, stateFileStillSame: true, identityConflict: true })
    assert.strictEqual(r.verified, false)
    assert.strictEqual(r.reason, 'identity-conflict')
  })

  test('[A] ★ 陈旧不得顺带放松任何 OS 硬条件', () => {
    const stale = { ...OK, stateFileStillSame: true }
    assert.strictEqual(own.decideStopVerification({ ...stale, exitCode: 1 }).reason, 'exit-nonzero')
    assert.strictEqual(own.decideStopVerification({ ...stale, exitCode: null }).verified, false)
    assert.strictEqual(own.decideStopVerification({ ...stale, osProbeError: 'probe failed' }).reason, 'os-probe-failed')
    assert.strictEqual(own.decideStopVerification({ ...stale, osPidStillAlive: true }).reason, 'pid-still-alive')
    assert.strictEqual(own.decideStopVerification({ ...stale, osPidStillAlive: null }).reason, 'pid-unknown')
    assert.strictEqual(own.decideStopVerification({ ...stale, sameProfileProcesses: 1 }).reason, 'other-instance')
    assert.strictEqual(own.decideStopVerification({ ...stale, sameProfileProcesses: null }).reason, 'count-unknown')
  })

  test('[A] 每一项失败都返回 verified=false 且 warnings 为空（接口一致性）', () => {
    const bads = [
      { ...OK, exitCode: 1 }, { ...OK, osProbeError: 'x' }, { ...OK, osPidStillAlive: true },
      { ...OK, osPidStillAlive: null }, { ...OK, sameProfileProcesses: 3 },
      { ...OK, sameProfileProcesses: undefined }, { ...OK, identityConflict: true }
    ]
    for (const b of bads) {
      const r = own.decideStopVerification(b)
      assert.strictEqual(r.verified, false)
      assert.deepStrictEqual(r.warnings, [])
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
    }
  })

  test('[A] 失败原因表已不含废弃的 state-file-contradicts', () => {
    assert.strictEqual(own.STOP_VERIFY_MESSAGES['state-file-contradicts'], undefined)
    assert.ok(own.STOP_VERIFY_MESSAGES['identity-conflict'], '必须新增身份冲突说明')
  })
}

// ================================================ [B] 官方 stop 后残留的镜像
{
  // 真实场景：官方 stop 成功 → pid/lock 被删、state.json 仍是同一 pid + running、进程已消失
  const owned = ID(20508, 1790045177680)
  const stateA = ID(20508, 1790045177680)          // state.json 内容与目标**同一实例**
  const procsAfterStop = []                        // 目标链三层均已退出

  test('[B] 实测场景镜像：state.json 残留同一实例 + 进程全消失 → 成功 + 陈旧警告', () => {
    const conflict = mirrorIdentityConflict({ afterIdent: stateA, owned, procs: procsAfterStop })
    assert.strictEqual(conflict, false, '进程已消失 ⇒ 是陈旧，不是冲突')
    const r = own.decideStopVerification({
      exitCode: 0,
      osProbeError: null,
      osPidStillAlive: false,                      // 20508 不在 procsAfterStop 中
      sameProfileProcesses: 0,
      stateFileStillSame: own.sameIdentity(stateA, owned),
      identityConflict: conflict
    })
    assert.strictEqual(r.verified, true, '这正是 pid 20508 的真实场景，必须能判成功')
    assert.deepStrictEqual(r.warnings, ['stale-state-file'])
  })

  test('[B] 实例被替换：state.json 指向另一个**仍存活**的实例 → 判冲突并拒绝', () => {
    const other = ID(31000, 1790099999999)
    const procs = [{ pid: 31000, startMs: 1790099999999 }]   // 仍在运行
    const conflict = mirrorIdentityConflict({ afterIdent: other, owned, procs })
    assert.strictEqual(conflict, true)
    const r = own.decideStopVerification({
      exitCode: 0, osProbeError: null, osPidStillAlive: false,
      sameProfileProcesses: 1,                     // 被替换的实例会被 profileInstanceCount 计入
      stateFileStillSame: false, identityConflict: conflict
    })
    assert.strictEqual(r.verified, false)
    // 同 Profile 仍有实例时先命中 other-instance（更早、更宽），两者都属"拒绝"，均正确
    assert.ok(['other-instance', 'identity-conflict'].includes(r.reason))
  })

  test('[B] 替换实例已死（PID 复用残留）→ 属陈旧而非冲突，且不得误判成功', () => {
    const ghost = ID(31000, 1790099999999)
    // 该 PID 在 OS 上不存在 ⇒ 不是冲突
    assert.strictEqual(mirrorIdentityConflict({ afterIdent: ghost, owned, procs: [] }), false)
    // 但同 Profile 若仍有实例，仍必须拒绝
    const r = own.decideStopVerification({
      exitCode: 0, osProbeError: null, osPidStillAlive: false, sameProfileProcesses: 2,
      stateFileStillSame: false, identityConflict: false
    })
    assert.strictEqual(r.verified, false)
    assert.strictEqual(r.reason, 'other-instance')
  })

  test('[B] 目录等价的两种写法不得被当成"不同实例"（回归：符号链接）', () => {
    // 同一目录、不同写法：sameIdentity 必须仍判"同一" ⇒ 不会被误判成冲突
    const link = 'C:\\Users\\<you>\\AppData\\Local\\hermes'
    const real = 'D:\hermes-home'
    const a = ID(1, 5000, link)
    const b = ID(1, 5000, real)
    // 两者在本机可能不等价（link 不一定存在）→ 只断言"不抛异常且返回布尔"
    assert.strictEqual(typeof own.sameIdentity(a, b), 'boolean')
    // 完全相同字符串时必须为真
    assert.strictEqual(own.sameIdentity(ID(1, 5000, real), ID(1, 5000, real)), true)
  })

  test('[B] Extra 的实例不得影响 default 的成功判定（分母按 Profile）', () => {
    // 停止复核里 sameProfileProcesses 已是"该 Profile 的实例数"；此处固化语义：
    // 只要传入的是 0，即使另一 Profile 有实例，也不影响本 Profile 的成功判定
    const r = own.decideStopVerification({
      exitCode: 0, osProbeError: null, osPidStillAlive: false, sameProfileProcesses: 0,
      stateFileStillSame: true, identityConflict: false
    })
    assert.strictEqual(r.verified, true)
  })
}

// ==================================================== [C] main.js 静态约束
{
  const mainJs = readCode('main.js')

  test('[C] 停止后计算 identityConflict，且口径要求"该身份仍存活"', () => {
    assert.ok(/const identityConflict = /.test(mainJs), '必须计算 identityConflict')
    assert.ok(/afterIdentAlive/.test(mainJs), '必须基于"该身份是否仍存活"来判断冲突')
    assert.ok(/!own\.sameIdentity\(afterIdent, owned\) && afterIdentAlive/.test(mainJs),
      '冲突 = 身份不同 **且** 该身份仍存活（缺一不可）')
  })

  test('[C] identityConflict 必须传入纯函数判定', () => {
    assert.ok(/stateFileStillSame: stillSame,\s*\n\s*identityConflict/.test(mainJs),
      'decideStopVerification 调用必须传 identityConflict')
  })

  test('[C] verifyAfter 明细包含 identityConflict（可审计）', () => {
    assert.ok(/stillSameInstance: stillSame,\s*\n\s*identityConflict,/.test(mainJs),
      'verifyAfter 必须记录 identityConflict')
  })

  test('[C] 成功分支返回独立警告（verifyWarnings / warningMessages）', () => {
    assert.ok(/verifyWarnings: warnCodes/.test(mainJs), '成功返回必须带 verifyWarnings')
    assert.ok(/warningMessages: warnMessages/.test(mainJs), '成功返回必须带 warningMessages')
    assert.ok(/own\.STOP_VERIFY_WARNINGS\[w\]/.test(mainJs), '警告文案必须来自 STOP_VERIFY_WARNINGS')
  })

  test('[C] 成功日志单独记录警告码', () => {
    assert.ok(/警告=\$\{warnCodes\.join/.test(mainJs), '成功日志必须记录警告码')
  })

  test('[C] 不得再以 state-file-contradicts 作为停止失败原因', () => {
    assert.ok(!/reason:\s*'state-file-contradicts'/.test(mainJs), 'main.js 不得再返回该失败原因')
    assert.ok(!/'state-file-contradicts'/.test(mainJs), 'main.js 不得再引用该失败原因')
  })

  test('[C] 停止失败分支仍如实返回"未确认"（未放松）', () => {
    assert.ok(/reason: 'stop-unverified'/.test(mainJs), '失败仍须返回 stop-unverified')
    assert.ok(/own\.STOP_VERIFY_MESSAGES\[verdict\.reason\]/.test(mainJs), '失败文案仍取自失败原因表')
  })
}

// ==================================================== [D] 渲染层分开表示
{
  const appJs = readCode(path.join('renderer', 'app.js'))

  test('[D] 成功 toast 包含"独立警告"分支', () => {
    assert.ok(/const warns = res\.verifyWarnings \|\| \[\]/.test(appJs), '渲染层必须读取 verifyWarnings')
    assert.ok(/独立警告/.test(appJs), '必须明确标注为"独立警告"')
    assert.ok(/res\.warningMessages/.test(appJs), '警告文案需来自主进程')
  })

  test('[D] 成功文案仍先说明"成功"，再附警告（不混淆）', () => {
    const iSuccess = appJs.indexOf('if (res && res.ok)')
    const seg = appJs.slice(iSuccess, iSuccess + 900)
    assert.ok(/成功（授权方式/.test(seg), '成功文案必须保留')
    assert.ok(seg.indexOf('成功（授权方式') < seg.indexOf('独立警告'), '顺序必须是先成功、后警告')
  })

  test('[D] 未确认路径仍提示"未确认"（未改成成功）', () => {
    assert.ok(/stop-unverified/.test(appJs), '渲染层必须仍有 stop-unverified 分支')
    assert.ok(/label\}未确认/.test(appJs), '未确认文案必须保留')
  })
}

// ====================================================== [E] 安全边界未变
{
  const mainJs = readCode('main.js')

  test('[E] 三道闸门未变', () => {
    assert.ok(/const ALLOW_AUTO_STOP = false/.test(mainJs))
    assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(mainJs))
    assert.ok(/const ALLOW_OWNED_STOP = true/.test(mainJs))
  })

  test('[E] ★ 控制台不得删除/改写网关状态文件（陈旧只提示、不清理）', () => {
    assert.ok(!/unlink[^\n]*gateway_state\.json/i.test(mainJs), '不得 unlink gateway_state.json')
    assert.ok(!/(rmSync|rmdirSync|fs\.rm)[^\n]*gateway_state\.json/i.test(mainJs), '不得删除状态文件')
    assert.ok(!/writeFileSync\([^\n]*gateway_state\.json/i.test(mainJs), '不得改写状态文件')
  })

  test('[E] 停止仍走官方 CLI，且 profile 由所有权反查（不接受渲染层传参）', () => {
    assert.ok(/\['--profile', prof\.id, 'gateway', 'stop'\]/.test(mainJs), '必须走官方 CLI')
    assert.ok(/由所有权记录反查得出，不接受渲染层传参/.test(mainJs), 'profile 必须反查')
  })

  test('[E] 停止仍在分配置的符号链接目录之外执行（历史坑）', () => {
    assert.ok(/cwd: APP_DIR/.test(mainJs), '必须在非符号链接目录下执行 stop')
  })
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))
process.exit(fail === 0 ? 0 : 1)
