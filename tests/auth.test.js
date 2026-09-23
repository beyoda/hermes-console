/**
 * Hermes 桌面控制台 — 模型认证（纯逻辑）自动化测试
 *
 * 运行：node tests/auth.test.js
 * 无第三方依赖、无副作用：**不启动任何终端、不执行任何 CLI、不触碰网关**。
 *
 * 覆盖本轮专项要求：
 *   [1] Provider → 官方命令映射（白名单）；未知 Provider 必须拒绝
 *   [2] 不得构造已废弃的 `hermes login`
 *   [3] `--profile` 定向正确（default 不加前缀）
 *   [4] 官方只读输出的状态解析（含脱敏）
 *   [5] 认证状态判定：可靠/不可靠、登录/登出/未验证、两处证据矛盾
 *   [6] 认证 ≠ 可调用（不得把"已登录"说成"可用"）
 *   [7] config.yaml 头部解析：只取 model/provider，绝不带出其它键
 *   [8] 源码级约束：auth.js 无网络/文件/进程调用；main.js 不用废弃命令
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('../auth')

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

function readCode(f) {
  return fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
}

// ---------------------------------------------------------------- 1. 命令白名单
test('1. 已支持的两家 Provider 均映射到官方 OAuth 命令', () => {
  const n = auth.buildAuthInvocation('nous', 'default')
  assert.ok(n.ok, 'nous 应可构造命令')
  assert.deepStrictEqual(n.argv, ['auth', 'add', 'nous', '--type', 'oauth'])
  assert.strictEqual(n.display, 'hermes auth add nous --type oauth')

  const c = auth.buildAuthInvocation('openai-codex', 'default')
  assert.ok(c.ok)
  assert.deepStrictEqual(c.argv, ['auth', 'add', 'openai-codex', '--type', 'oauth'])
})

test('2. 未知 Provider 必须被拒绝（不得放行任意命令）', () => {
  for (const p of ['', null, undefined, 'evil; rm -rf /', 'openai', 'anthropic', { toString: () => 'nous' }]) {
    const r = auth.buildAuthInvocation(p, 'default')
    assert.strictEqual(r.ok, false, `不应为 ${String(p)} 构造命令`)
    assert.strictEqual(r.reason, 'unsupported-provider')
    assert.strictEqual(r.argv, undefined, '被拒时不得返回 argv')
  }
})

test('3. 绝不构造已废弃的 hermes login（官方标注 Deprecated）', () => {
  for (const p of Object.keys(auth.PROVIDER_AUTH)) {
    const inv = auth.buildAuthInvocation(p, 'default')
    assert.ok(!/(^|\s)login(\s|$)/.test(inv.display), `${p} 命令中出现 login：${inv.display}`)
    assert.ok(!inv.argv.includes('login'), `${p} argv 中出现 login`)
  }
  assert.ok(!/(^|\s)login(\s|$)/.test(auth.buildStatusInvocation('default', 'nous').display))
})

test('4. --profile 定向：default 不加前缀；extra 必须加', () => {
  assert.deepStrictEqual(auth.buildAuthInvocation('nous', 'default').argv, ['auth', 'add', 'nous', '--type', 'oauth'])
  const c = auth.buildAuthInvocation('openai-codex', 'extra')
  assert.deepStrictEqual(c.argv, ['--profile', 'extra', 'auth', 'add', 'openai-codex', '--type', 'oauth'])
  assert.ok(c.display.includes('--profile extra'))

  assert.deepStrictEqual(auth.buildStatusInvocation('default', 'nous').argv, ['auth', 'status', 'nous'])
  assert.deepStrictEqual(
    auth.buildStatusInvocation('extra', 'openai-codex').argv,
    ['--profile', 'extra', 'auth', 'status', 'openai-codex'])
})

test('5. 两家 Provider 只声明 OAuth（控制台不提供 API Key 输入）', () => {
  for (const [id, meta] of Object.entries(auth.PROVIDER_AUTH)) {
    assert.strictEqual(meta.method, 'oauth', `${id} 应为 oauth`)
    assert.ok(meta.methodLabel && meta.methodLabel.length > 0, `${id} 缺少认证方式说明`)
    assert.ok(!/api[_-]?key/i.test(meta.methodLabel), `${id} 不应暗示收集 API Key`)
  }
})

// ---------------------------------------------------------------- 2. 官方输出解析
test('6. 解析官方 status 输出：logged in / logged out', () => {
  assert.deepStrictEqual(auth.parseAuthStatus('openai-codex: logged in').state, 'logged-in')
  const out = auth.parseAuthStatus('nous: logged out (No access token found for Nous Portal login.)')
  assert.strictEqual(out.state, 'logged-out')
  assert.ok(out.reason.includes('No access token found'), '应保留官方给出的原因')
})

test('7. 空输出 / 无法识别 → unknown（不得猜）', () => {
  for (const s of ['', '   ', null, undefined, 'Traceback (most recent call last):', 'usage: hermes auth status']) {
    assert.strictEqual(auth.parseAuthStatus(s).state, 'unknown', `"${String(s)}" 应判为 unknown`)
  }
})

test('8. 解析结果必须脱敏（JWT / sk- / 超长串一律替换）', () => {
  // 夹具**在运行时拼装**，避免源码里出现形如真实密钥的字面量
  // （交付打包器的出库闸门按"形态"扫描，字面量会误触发并中止打包）。
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcd'].join('.')
  const r1 = auth.parseAuthStatus(`nous: logged out (token ${jwt} invalid)`)
  assert.ok(!r1.reason.includes(jwt), 'JWT 未被脱敏')

  const fakeKey = 'sk-' + 'a'.repeat(24)
  const r2 = auth.sanitizeReason(`key = ${fakeKey}`)
  assert.ok(!r2.includes(fakeKey), 'sk- 未被脱敏')

  const longRun = 'x'.repeat(120)
  const r3 = auth.sanitizeReason(longRun)
  assert.ok(!r3.includes(longRun), '超长串未被脱敏')
  assert.ok(r3.length <= 300, '脱敏后长度应受限')
})

// ---------------------------------------------------------------- 3. 状态判定
test('9. 官方明确 logged in → valid 且 reliable', () => {
  const d = auth.decideAuthState({ cliState: 'logged-in', cliOk: true })
  assert.strictEqual(d.state, 'valid')
  assert.strictEqual(d.reliable, true)
  assert.strictEqual(d.expired, false)
})

test('10. 官方明确 logged out → expired 且 reliable（这才是可弹窗的依据）', () => {
  const d = auth.decideAuthState({ cliState: 'logged-out', cliOk: true, cliReason: 'No access token' })
  assert.strictEqual(d.state, 'expired')
  assert.strictEqual(d.reliable, true)
  assert.strictEqual(d.expired, true)
  assert.ok(d.reason.includes('No access token'))
})

test('11. 命令失败 / 无法识别 → unverified 且 reliable=false（不得误报失效）', () => {
  const a = auth.decideAuthState({ cliOk: false, cliReason: '退出码 1' })
  assert.strictEqual(a.state, 'unverified')
  assert.strictEqual(a.reliable, false)
  assert.strictEqual(a.expired, false)

  const b = auth.decideAuthState({ cliState: 'unknown', cliOk: true })
  assert.strictEqual(b.state, 'unverified')
  assert.strictEqual(b.reliable, false)
})

test('12. 两处证据矛盾（CLI 已登录 vs 网关 API 非 valid）→ unverified，不猜', () => {
  const d = auth.decideAuthState({ cliState: 'logged-in', cliOk: true, apiState: 'terminal' })
  assert.strictEqual(d.state, 'unverified')
  assert.strictEqual(d.reliable, false)
  assert.ok(/不一致/.test(d.reason), '应说明证据不一致')
})

test('13. 两处证据一致（CLI 已登录 + API valid）→ valid', () => {
  const d = auth.decideAuthState({ cliState: 'logged-in', cliOk: true, apiState: 'valid' })
  assert.strictEqual(d.state, 'valid')
  assert.strictEqual(d.reliable, true)
})

test('14. 认证 ≠ 可调用：任何状态都不得声称「可用」', () => {
  for (const s of ['valid', 'expired', 'unverified']) {
    const c = auth.callabilityNote(s)
    assert.notStrictEqual(c.state, '可用', `${s} 不应显示为可用`)
    assert.ok(c.detail && c.detail.length > 0, `${s} 缺少口径说明`)
  }
  assert.strictEqual(auth.callabilityNote('valid').ok, null, 'valid 也只能是待验证')
  assert.strictEqual(auth.callabilityNote('expired').ok, false)
})

// ---------------------------------------------------------------- 4. config 头部解析
test('15. 解析 default config 头部 → provider=nous / model=upstage/solar-pro4:free', () => {
  const r = auth.parseModelHead([
    'model:',
    '  default: upstage/solar-pro4:free',
    '  provider: nous',
    '  base_url: https://inference-api.nousresearch.com/v1',
    '  openai_runtime: codex_app_server',
    'agent:',
    '  foo: bar'
  ].join('\n'))
  assert.strictEqual(r.provider, 'nous')
  assert.strictEqual(r.model, 'upstage/solar-pro4:free')
})

test('16. 解析 extra config 头部 → provider=openai-codex / model=gpt-5.5', () => {
  const r = auth.parseModelHead([
    'model:',
    '  default: gpt-5.5',
    '  provider: openai-codex',
    '  base_url: https://chatgpt.com/backend-api/codex',
    'agent:'
  ].join('\n'))
  assert.strictEqual(r.provider, 'openai-codex')
  assert.strictEqual(r.model, 'gpt-5.5')
})

test('17. 只返回 model/provider 两个字段——其它键（可能含凭据）绝不出现在结果里', () => {
  const text = [
    'model:',
    '  default: gpt-5.5',
    '  provider: openai-codex',
    'platforms:',
    '  feishu:',
    '    app_secret: SUPER-SECRET-VALUE',
    '    api_key: another-secret',
    'agent:',
    '  provider: should-not-be-read'
  ].join('\n')
  const r = auth.parseModelHead(text)
  assert.deepStrictEqual(Object.keys(r).sort(), ['model', 'provider'])
  assert.strictEqual(r.provider, 'openai-codex', '不得读取后续 agent 段')
  assert.ok(!JSON.stringify(r).includes('SUPER-SECRET-VALUE'), '结果中混入凭据')
  assert.ok(!JSON.stringify(r).includes('another-secret'), '结果中混入凭据')
})

test('18. 缺字段 / 空文本 → null（不猜默认 Provider）', () => {
  assert.deepStrictEqual(auth.parseModelHead(''), { model: null, provider: null })
  assert.deepStrictEqual(auth.parseModelHead('model:\n  default: x\n').provider, null)
  const r = auth.parseModelHead('agent:\n  provider: nous\n')
  assert.strictEqual(r.provider, null, '非 model 段的 provider 不得被读取')
})

// ---------------------------------------------------------------- 5. 源码级约束
test('19. auth.js 不含网络 / 文件 / 进程 / 环境变量调用（纯逻辑）', () => {
  const src = readCode('auth.js')
  for (const bad of ['require(\'node:fs\')', 'require("node:fs")', 'require(\'fs\')', 'require(\'child_process\')',
    'http', 'fetch(', 'spawn(', 'execFile', 'process.env']) {
    assert.ok(!src.includes(bad), `auth.js 出现副作用调用：${bad}`)
  }
})

test('20. main.js 不使用已废弃的 hermes login；认证路径不删除任何文件', () => {
  const mainJs = readCode('main.js')
  assert.ok(!/['"]login['"]/.test(mainJs), 'main.js 出现 login 子命令')
  assert.ok(!/hermes login/.test(mainJs), 'main.js 出现 hermes login')
  // 认证相关路径不得包含删除/终止调用
  const seg = mainJs.split('console:authStart')[1] || ''
  const until = seg.split('console:openPath')[0] || seg
  assert.ok(!/\bunlink|rmSync|rmdir|taskkill|Stop-Process|kill\(/i.test(until), '认证路径出现删除/终止调用')
})

test('21. 认证命令由白名单构造，renderer 无法传入任意命令', () => {
  const mainJs = readCode('main.js')
  assert.ok(/auth\.buildAuthInvocation\(/.test(mainJs), '应通过 auth 模块构造命令')
  assert.ok(!/console:authStart[\s\S]{0,400}?\bcmd\b\s*=\s*_e/.test(mainJs), '不得直接采用 renderer 传入的命令')
  const preload = readCode('preload.js')
  assert.ok(!/shell|exec|spawn/.test(preload), 'preload 不得暴露 shell/exec')
})

test('22. 控制台不实现账号密码输入（无 password 输入控件）', () => {
  const html = readCode(path.join('renderer', 'index.html'))
  assert.ok(!/type\s*=\s*["']password["']/i.test(html), 'index.html 出现密码输入框')
  assert.ok(!/api[-_]?key\s*<\/?input/i.test(html), 'index.html 出现 API Key 输入框')
})

// ---------------------------------------------------------------- 汇总
console.log('='.repeat(78))
console.log('Hermes 桌面控制台 — 模型认证（纯逻辑）测试')
console.log('='.repeat(78))
console.log(results.join('\n'))
console.log('-'.repeat(78))
console.log(`通过 ${pass} 项，失败 ${fail} 项，共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
