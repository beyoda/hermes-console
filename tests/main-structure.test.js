/**
 * Hermes 桌面控制台 — main.js 静态结构完整性测试
 *
 * 运行：node tests/main-structure.test.js
 *
 * ⚠️ 纯静态分析：不启动 Electron、不接触任何 Gateway、不读状态文件。
 *
 * 背景（2026-09-22 回归，必须记住）：
 *   本轮为"登记失败可见化"在 main.js 中新增了 6 处 `state.lastRegisterByProfile` 的**使用**，
 *   却漏了在 `state` 对象里**初始化**该字段 → 控制台启动后 `getBootstrapInfo()` 抛
 *   `TypeError: Cannot read properties of undefined (reading 'default')`（main.js:939）→ 主进程崩溃。
 *   这类疏漏无法被"纯逻辑单测"或"隔离端到端"发现（main.js 依赖 electron，无法直接 require），
 *   故在此固化为**静态结构检查**。
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

/** 去掉整行注释（`//` 与 JSDoc 的 `*` 开头行）后再做符号扫描，避免注释里的示例误报 */
const codeOnly = MAIN.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

function stateFields () {
  const m = MAIN.match(/const state = \{([\s\S]*?)\n\}/)
  assert.ok(m, '未找到 `const state = { … }` 定义块')
  return {
    defined: new Set([...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map(x => x[1])),
    used: new Set([...codeOnly.matchAll(/\bstate\.(\w+)/g)].map(x => x[1])),
    // 动态赋值 `state.X = ...`（排除 `state.X === ...` 比较）
    assigned: new Set([...codeOnly.matchAll(/\bstate\.(\w+)\s*=[^=]/g)].map(x => x[1]))
  }
}

// ---------------------------------------------------------------- [A] state 字段完整性
console.log('\n[A] state 字段完整性')

test('[A] state 定义块存在且包含关键字段', () => {
  const { defined } = stateFields()
  for (const k of ['preExisting', 'ownedByProfile', 'authorization', 'lastVerify', 'lastProbe',
    'lastRegisterByProfile', 'watchdog']) {
    assert.ok(defined.has(k), `state 缺少字段 ${k}`)
  }
})

test('[A] ★ 所有 state.X 的使用都必须"有定义或有动态赋值"', () => {
  const { defined, used, assigned } = stateFields()
  const missing = [...used].filter(k => !defined.has(k) && !assigned.has(k)).sort()
  assert.deepStrictEqual(missing, [],
    `未定义却被使用的 state 字段：${missing.join(', ')}（这正是 2026-09-22 主进程崩溃的成因）`)
})

test('[A] ★ state.lastRegisterByProfile 必须以 {} 初始化（本次回归的精确防线）', () => {
  const { defined } = stateFields()
  assert.ok(defined.has('lastRegisterByProfile'), '未在 state 中定义 lastRegisterByProfile')
  assert.ok(/lastRegisterByProfile:\s*\{\s*\}/.test(MAIN),
    '必须以 `{}` 初始化（写成 null 会使 `state.lastRegisterByProfile[p.id]` 抛 TypeError）')
})

test('[A] 该字段的读取处必须有兜底（bootstrap / status）', () => {
  const withFallback = [...MAIN.matchAll(/state\.lastRegisterByProfile\[p\.id\]\s*\|\|\s*null/g)]
  assert.ok(withFallback.length >= 2,
    `getBootstrapInfo 与 gateway:status 都应带 \`|| null\` 兜底，实际 ${withFallback.length} 处`)
})

// ---------------------------------------------------------------- [B] 防御性：其它易漏项
console.log('\n[B] 其它易漏项')

test('[B] 登记失败记录必须"成功时清除"，避免陈旧原因长期挂在界面上', () => {
  assert.ok(/function\s+noteRegisterFailure\s*\(/.test(MAIN), '缺少 noteRegisterFailure')
  assert.ok(/function\s+clearRegisterFailure\s*\(/.test(MAIN), '缺少 clearRegisterFailure')
  const regBlock = (MAIN.split('async function registerOwnershipFor')[1] || '').split('\n}\n')[0] || ''
  assert.ok(/clearRegisterFailure\(prof\.id\)/.test(regBlock), '登记成功分支必须清除失败记录')
})

test('[B] 安全闸门常量仍在且取值未被改动', () => {
  assert.ok(/const ALLOW_AUTO_STOP = false/.test(MAIN))
  assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(MAIN))
  assert.ok(/const ALLOW_OWNED_STOP = true/.test(MAIN))
})

test('[B] 新增字段不得破坏既有的 byProfile 形状（owned/mode/instance 仍在）', () => {
  const boot = (MAIN.split('byProfile: PROFILES.reduce')[1] || '').split('}, {}),')[0] || ''
  for (const k of ['profile:', 'label:', 'owned:', 'instance:', 'mode:', 'registerFailure:', 'verified:']) {
    assert.ok(boot.includes(k), `byProfile 项缺少 ${k}`)
  }
})

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(78))
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))
process.exit(fail === 0 ? 0 : 1)
