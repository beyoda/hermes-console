/**
 * Hermes 桌面控制台 — 目录身份（Profile Home）比较隔离测试
 *
 * 运行：node tests/home-identity.test.js
 *
 * ⚠️ 安全边界：**不启动、不停止、不接管任何真实网关**。
 *    · [A]/[C]/[D] 为纯逻辑与真实文件系统符号链接测试（在系统临时目录内自建、用后删除）；
 *    · [B] 在系统临时目录创建**真实的目录 junction**（Windows 上创建 junction 无需管理员），
 *      用于验证"符号链接与真实路径指向同一目录"确实能被识别 —— 不依赖任何字符串断言。
 *
 * 覆盖：
 *   [A] sameHome 判定规则（含"解析失败必须拒绝"与"不做缓存"的行为断言）
 *   [B] 真实 junction：同一目录可识别 / 不同目录必须拒绝 / realpath 失败必须拒绝
 *   [C] 与 ownership 的集成：verifyProfileIdentity、compareIdentity、migrateOwnershipRecord
 *   [D] 静态防回退：全仓不再存在纯字符串形式的 home 比较
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const own = require('../ownership')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
const skip = why => results.push(`  [SKIP] ${why}`)
const readCode = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// 同一目录的两种写法：符号链接写法 vs 真实路径（纯内存映射，不访问真实文件系统）
const HOME_DEFAULT_LINK = 'C:\\Users\\<you>\\AppData\\Local\\hermes'
const HOME_DEFAULT_REAL = 'D:\\hermes-home'
const HOME_EXTRA_LINK = 'C:\\Users\\<you>\\AppData\\Local\\hermes\\profiles\\extra'
const HOME_EXTRA_REAL = 'D:\\hermes-home\\profiles\\extra'

const keyOf = p => String(p).trim().replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase()
const FAKE_MAP = {
  [keyOf(HOME_DEFAULT_LINK)]: HOME_DEFAULT_REAL,
  [keyOf(HOME_DEFAULT_REAL)]: HOME_DEFAULT_REAL,
  [keyOf(HOME_EXTRA_LINK)]: HOME_EXTRA_REAL,
  [keyOf(HOME_EXTRA_REAL)]: HOME_EXTRA_REAL
}
/** 模拟 Windows realpath：已知路径返回真实路径，其余抛错（模拟解析失败） */
function fakeRealpath (p) {
  const k = keyOf(p)
  if (FAKE_MAP[k]) return FAKE_MAP[k]
  const e = new Error('ENOENT: no such file or directory')
  e.code = 'ENOENT'
  throw e
}
const boom = () => { throw new Error('realpath should not be called here') }

// ================================================================ [A] 判定规则
console.log('\n[A] sameHome 判定规则')
{
  const sh = own.sameHome

  test('[A] 归一化字符串严格相同 → 同一目录（**不应**触发 realpath）', () => {
    assert.strictEqual(sh(HOME_DEFAULT_LINK, 'c:/users/<you>/appdata/local/hermes/', { realpath: boom }), true)
    assert.strictEqual(sh(HOME_DEFAULT_REAL, 'D:\\hermes-home\\', { realpath: boom }), true)
  })

  test('[A] ★ 符号链接写法 vs 真实路径 → 同一目录（本次修复的核心）', () => {
    assert.strictEqual(sh(HOME_DEFAULT_LINK, HOME_DEFAULT_REAL, { realpath: fakeRealpath }), true)
    assert.strictEqual(sh(HOME_DEFAULT_REAL, HOME_DEFAULT_LINK, { realpath: fakeRealpath }), true)
  })

  test('[A] ★ default 与 Extra 绝不能混淆（两种写法交叉比较全部为 false）', () => {
    const pairs = [
      [HOME_DEFAULT_LINK, HOME_EXTRA_LINK],
      [HOME_DEFAULT_LINK, HOME_EXTRA_REAL],
      [HOME_DEFAULT_REAL, HOME_EXTRA_LINK],
      [HOME_DEFAULT_REAL, HOME_EXTRA_REAL]
    ]
    for (const [a, b] of pairs) {
      assert.strictEqual(sh(a, b, { realpath: fakeRealpath }), false, `${a} vs ${b}`)
    }
  })

  test('[A] 同一个 Extra 目录的两种写法 → 同一目录', () => {
    assert.strictEqual(sh(HOME_EXTRA_LINK, HOME_EXTRA_REAL, { realpath: fakeRealpath }), true)
  })

  test('[A] ★ 解析失败 → 判为不同（拒绝），绝不猜测相同', () => {
    assert.strictEqual(sh(HOME_DEFAULT_LINK, 'E:\\unknown\\hermes', { realpath: fakeRealpath }), false)
    assert.strictEqual(sh('E:\\unknown\\a', 'E:\\unknown\\b', { realpath: fakeRealpath }), false)
    assert.strictEqual(sh(HOME_DEFAULT_REAL, 'E:\\unknown\\hermes', { realpath: fakeRealpath }), false)
  })

  test('[A] 空值 / 非法值 → 一律 false（不抛错）', () => {
    for (const bad of [null, undefined, '', 0]) {
      assert.strictEqual(sh(bad, HOME_DEFAULT_REAL, { realpath: fakeRealpath }), false, String(bad))
      assert.strictEqual(sh(HOME_DEFAULT_REAL, bad, { realpath: fakeRealpath }), false, String(bad))
    }
  })

  test('[A] ★ 不做缓存：每次比较都当场 realpath（授权前核验不得吃缓存）', () => {
    let calls = 0
    const counting = p => { calls++; return fakeRealpath(p) }
    assert.strictEqual(sh(HOME_DEFAULT_LINK, HOME_DEFAULT_REAL, { realpath: counting }), true)
    const afterFirst = calls
    assert.strictEqual(sh(HOME_DEFAULT_LINK, HOME_DEFAULT_REAL, { realpath: counting }), true)
    const afterSecond = calls
    assert.ok(afterFirst >= 2, `首次比较应各解析一次，实际 ${afterFirst}`)
    assert.strictEqual(afterSecond, afterFirst * 2, '第二次比较必须重新解析（证明未缓存）')
  })

  test('[A] realpath 返回 null/空 视为解析失败', () => {
    assert.strictEqual(sh(HOME_DEFAULT_LINK, 'X:\\a', { realpath: () => null }), false)
    assert.strictEqual(sh(HOME_DEFAULT_LINK, 'X:\\a', { realpath: () => '' }), false)
  })
}

// ================================================================ [B] 真实 junction
console.log('\n[B] 真实符号链接（目录 junction）')
let BASE = null, REAL = null, LINK = null
{
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-identity-'))
  REAL = path.join(BASE, 'real-home')
  LINK = path.join(BASE, 'link-home')
  let linked = false
  try {
    fs.mkdirSync(REAL, { recursive: true })
    fs.symlinkSync(REAL, LINK, 'junction')
    linked = true
  } catch (e) {
    skip(`无法创建 junction（${e.code || e.message}）→ 跳过真实符号链接测试`)
  }

  if (linked) {
    test('[B] 真实 junction：homeRealpath(link) === homeRealpath(real)', () => {
      const a = own.homeRealpath(LINK)
      const b = own.homeRealpath(REAL)
      assert.ok(a !== null && b !== null, '应能解析出真实路径')
      assert.strictEqual(a, b, `link=${a} real=${b}`)
    })

    test('[B] ★ 真实 junction：sameHome(link, real) === true', () => {
      assert.strictEqual(own.sameHome(LINK, REAL), true)
      assert.strictEqual(own.sameHome(REAL, LINK), true)
    })

    test('[B] 真实 junction：与另一个真实目录必须为 false', () => {
      const other = path.join(BASE, 'other-home')
      fs.mkdirSync(other, { recursive: true })
      assert.strictEqual(own.sameHome(LINK, other), false)
      assert.strictEqual(own.sameHome(REAL, other), false)
    })

    test('[B] ★ 路径不存在（解析失败）→ false，绝不猜测相同', () => {
      assert.strictEqual(own.sameHome(LINK, path.join(BASE, 'does-not-exist')), false)
      assert.strictEqual(own.sameHome(path.join(BASE, 'no-a'), path.join(BASE, 'no-b')), false)
    })

    test('[B] 符号链接目标变化 → 识别为不同（不得沿用旧结论）', () => {
      // ⚠️ 必须用**独立的 junction**（LINK2），否则会把 LINK 改指，污染后续 [C]
      const LINK2 = path.join(BASE, 'link2-home')
      const moved = path.join(BASE, 'moved-home')
      fs.mkdirSync(moved, { recursive: true })
      fs.symlinkSync(REAL, LINK2, 'junction')
      const before = own.homeRealpath(LINK2)
      assert.strictEqual(own.sameHome(LINK2, REAL), true)

      // 重建 junction 指向新目标
      fs.rmdirSync(LINK2)
      fs.symlinkSync(moved, LINK2, 'junction')
      const after = own.homeRealpath(LINK2)
      assert.notStrictEqual(after, before, '目标变化后真实路径必须变化')
      assert.strictEqual(own.sameHome(LINK2, moved), true)
      assert.strictEqual(own.sameHome(LINK2, REAL), false, '目标已变，不得再判为同一目录')
      // LINK 未受影响，仍指向 REAL
      assert.strictEqual(own.sameHome(LINK, REAL), true)
    })
  }
}

// ================================================================ [C] 与 ownership 集成
console.log('\n[C] 与 ownership 集成（使用真实 junction 路径）')
{
  // ⚠️ "另一个 Profile 目录"必须是**独立目录** —— 不能拿 REAL/LINK，
  //    它们指向同一目录（那正是被测的等价关系）
  const OTHER = path.join(BASE, 'other-profile-home')
  const EXTRA = path.join(BASE, 'extra-home')
  try { fs.mkdirSync(OTHER, { recursive: true }); fs.mkdirSync(EXTRA, { recursive: true }) } catch (e) { /* ignore */ }
  const otherHome = OTHER
  const ident = p => ({ pid: 4780, startMs: 1790042091810, hermesHome: p })
  const procs = [{ pid: 4780, startMs: 1790042091810 }]

  test('[C] ★ verifyProfileIdentity：状态文件写真实路径 + Profile 用符号链接写法 → verified', () => {
    const r = own.verifyProfileIdentity({
      identity: ident(REAL), profileHome: LINK, procs, instanceCount: 1
    })
    assert.strictEqual(r.ok, true, `应通过，实际 ${r.reason}`)
    assert.strictEqual(r.reason, 'verified')
  })

  test('[C] verifyProfileIdentity：反向（identity 用链接写法、Profile 用真实路径）也通过', () => {
    const r = own.verifyProfileIdentity({
      identity: ident(LINK), profileHome: REAL, procs, instanceCount: 1
    })
    assert.strictEqual(r.ok, true, `应通过，实际 ${r.reason}`)
  })

  test('[C] ★ verifyProfileIdentity：不同 Profile 目录 → 仍必须 profile-mismatch', () => {
    const r = own.verifyProfileIdentity({
      identity: ident(otherHome), profileHome: LINK, procs, instanceCount: 1
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-mismatch')
  })

  test('[C] ★ verifyProfileIdentity：Profile 路径不存在（解析失败）→ 拒绝', () => {
    const r = own.verifyProfileIdentity({
      identity: ident(REAL), profileHome: path.join(BASE, 'nope'), procs, instanceCount: 1
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-mismatch')
  })

  test('[C] compareIdentity / sameIdentity：同一实例的两种写法视为同一实例', () => {
    assert.strictEqual(own.compareIdentity(ident(LINK), ident(REAL)), true)
    assert.strictEqual(own.sameIdentity(ident(REAL), ident(LINK)), true)
    // 不同目录仍必须不同
    assert.strictEqual(own.compareIdentity(ident(REAL), ident(otherHome)), false)
  })

  test('[C] migrateOwnershipRecord：等价路径的旧记录可正确归位到 Profile', () => {
    const profiles = [
      { id: 'default', home: LINK },
      { id: 'extra', home: EXTRA }
    ]
    const out = own.migrateOwnershipRecord(
      { gateway: { pid: 4780, startMs: 1790042091810, hermesHome: REAL } }, profiles)
    assert.ok(out.byProfile.default, '应按真实路径归位到 default')
    assert.strictEqual(out.byProfile.default.pid, 4780)
    assert.strictEqual(out.dropped.length, 0, `不应丢弃：${out.dropped.join(',')}`)
  })

  test('[C] migrateOwnershipRecord：未知目录仍必须被丢弃（不猜测）', () => {
    const profiles = [{ id: 'default', home: LINK }]
    const out = own.migrateOwnershipRecord(
      { gateway: { pid: 1, startMs: 2, hermesHome: path.join(BASE, 'ghost') } }, profiles)
    assert.strictEqual(out.byProfile.default, undefined)
    assert.ok(out.dropped.length > 0)
  })
}

// ================================================================ [D] 静态防回退
console.log('\n[D] 静态防回退（全仓不再有纯字符串 home 比较）')
{
  const ownJs = readCode('ownership.js')
  const mainJs = readCode('main.js')

  test('[D] ownership.js：不得再出现 normHome 形式的 home 比较', () => {
    assert.ok(!/normHome\(a\.hermesHome\)\s*!==\s*normHome\(b\.hermesHome\)/.test(ownJs), 'compareIdentity 仍是字符串比较')
    assert.ok(!/normHome\(identity\.hermesHome\)\s*!==\s*normHome\(profileHome\)/.test(ownJs), 'verifyProfileIdentity 仍是字符串比较')
    assert.ok(!/normHome\(inst\.hermesHome\)\s*!==\s*normHome\(p\.home\)/.test(ownJs), 'migrate 仍是字符串比较')
    assert.ok(!/normHome\(x\.home\)\s*===\s*normHome\(home\)/.test(ownJs), 'migrate resolve 仍是字符串比较')
  })

  test('[D] main.js：不得再用 own.normHome 做 Profile 归属比较', () => {
    assert.ok(!/own\.normHome\(/.test(mainJs), 'main.js 仍存在 own.normHome 调用')
  })

  test('[D] 必须存在统一实现并导出', () => {
    assert.ok(/function\s+sameHome\s*\(/.test(ownJs), '缺少 sameHome')
    assert.ok(/function\s+homeRealpath\s*\(/.test(ownJs), '缺少 homeRealpath')
    assert.ok(/\n  sameHome,/.test(ownJs), '未导出 sameHome')
    assert.ok(/\n  homeRealpath,/.test(ownJs), '未导出 homeRealpath')
  })

  test('[D] sameHome 不得引入缓存（授权前必须当场解析）', () => {
    const block = (ownJs.split('function sameHome')[1] || '').split('\n}')[0] || ''
    assert.ok(block.length > 0, '未找到 sameHome 实现')
    assert.ok(!/\bMap\b|\bcache\b|\bCache\b/.test(block), 'sameHome 实现中不得出现缓存结构')
  })

  test('[D] 身份里仍保存 hermesHome 原始值（不得被 realpath 改写）', () => {
    assert.ok(/hermesHome:\s*\(stFile && stFile\.hermes_home\)/.test(ownJs), 'readIdentity 必须保留原始 hermesHome')
    assert.ok(!/hermesHome:\s*normHome\(/.test(ownJs), '不得把归一化/realpath 结果写进身份')
  })
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))

// 清理自建临时目录（仅限本测试自己创建的目录）
try {
  if (BASE && BASE.startsWith(os.tmpdir()) && path.basename(BASE).startsWith('hermes-home-identity-')) {
    fs.rmSync(BASE, { recursive: true, force: true })
  }
} catch (e) { console.log('  [WARN] 清理临时目录失败:', e.message) }

process.exit(fail === 0 ? 0 : 1)
