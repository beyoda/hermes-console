'use strict'
/**
 * 模型认证 —— **纯逻辑**模块（无副作用、可单测）
 *
 * 职责边界（严格遵守本轮授权）：
 *   ✓ 把「官方 CLI 的只读输出」翻译成可展示的认证状态
 *   ✓ 构造**官方**认证命令（白名单，不接受 renderer 传入任意命令）
 *   ✗ 不读取、不解析、不返回任何凭据（token / cookie / 密码 / 密钥）
 *   ✗ 不实现账号密码输入、不模拟网页登录、不自动切换 Provider
 *   ✗ 不因认证"看起来失败"就断言模型不可用（认证 ≠ 可调用）
 *
 * 官方命令事实（2026-09-19 实测 `hermes auth --help` / `hermes portal --help`）：
 *   hermes auth status <provider>        —— 只读状态（本模块唯一依赖的状态来源）
 *   hermes auth add  <provider> --type oauth  —— 官方 OAuth 加凭证
 *   hermes portal login                  —— Nous Portal 一站式登录（= auth add nous --type oauth）
 *   hermes auth logout <provider>        —— 官方登出
 *   hermes login                         —— **已废弃**，不得使用（--help 明确标注 Deprecated）
 */

/** Provider → 官方认证方式（白名单）。未列出的 provider 一律「不支持自动构造」。 */
const PROVIDER_AUTH = {
  nous: {
    id: 'nous',
    label: 'Nous Portal',
    method: 'oauth',
    methodLabel: '浏览器 OAuth（PKCE）',
    add: ['auth', 'add', 'nous', '--type', 'oauth'],
    alias: 'hermes portal login',
    note: '官方一站式入口为 hermes portal login（等价于 hermes auth add nous --type oauth）。'
  },
  'openai-codex': {
    id: 'openai-codex',
    label: 'OpenAI Codex',
    method: 'oauth',
    methodLabel: 'OAuth 设备码 / 浏览器授权',
    add: ['auth', 'add', 'openai-codex', '--type', 'oauth'],
    alias: null,
    note: '官方通过设备码 OAuth 写入凭证；控制台不代你登录。'
  }
}

/** 只读状态查询命令（所有 provider 通用） */
function buildStatusInvocation(profileId, provider) {
  const argv = []
  if (profileId && profileId !== 'default') argv.push('--profile', String(profileId))
  argv.push('auth', 'status', String(provider))
  return { argv, display: displayArgv(argv) }
}

/**
 * 构造**官方**认证命令（交互式 OAuth，由用户在自己的终端完成）。
 * 返回 argv（供 spawn 用）与可直接展示/复制的字符串。
 * 未知 provider → ok:false（绝不放行任意命令）。
 */
function buildAuthInvocation(provider, profileId) {
  // 只接受字符串：避免对象等被 String() 强制转换后意外命中白名单
  if (typeof provider !== 'string') return { ok: false, reason: 'unsupported-provider' }
  const meta = PROVIDER_AUTH[provider]
  if (!meta) return { ok: false, reason: 'unsupported-provider' }
  const prefix = []
  if (profileId && profileId !== 'default') prefix.push('--profile', String(profileId))
  const argv = prefix.concat(meta.add)
  return {
    ok: true,
    provider: meta.id,
    argv,
    display: displayArgv(argv),
    alias: meta.alias,
    method: meta.method,
    methodLabel: meta.methodLabel,
    note: meta.note
  }
}

/** argv → 展示字符串（加引号仅用于展示，不用于执行） */
function displayArgv(argv) {
  return ['hermes'].concat((argv || []).map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a))).join(' ')
}

/**
 * 解析 `hermes auth status <provider>` 的只读输出。
 * 实测样例：
 *   "nous: logged out (No access token found for Nous Portal login.)"
 *   "openai-codex: logged in"
 * 返回 { state: 'logged-in'|'logged-out'|'unknown', reason }
 * **只提取状态语义与官方给的原因文本，不回传任何凭据值。**
 */
function parseAuthStatus(stdout) {
  const text = String(stdout == null ? '' : stdout)
  if (!text.trim()) return { state: 'unknown', reason: '官方 status 无输出' }
  const m = text.match(/:\s*logged\s+(in|out)\s*(\(([^)]*)\))?/i)
  if (m) {
    const reason = (m[3] || '').trim()
    return {
      state: m[1].toLowerCase() === 'in' ? 'logged-in' : 'logged-out',
      reason: sanitizeReason(reason)
    }
  }
  return { state: 'unknown', reason: sanitizeReason(text.trim().split(/\r?\n/)[0] || '无法识别官方输出') }
}

/**
 * 从 config.yaml 的**头部文本**里只提取 `model:` 块中的 default（模型名）与 provider。
 * 设计为「只读小块、只返回两个字段」——即使调用方传入整份配置，
 * 本函数也不会把任何其它键（可能含凭据）带出去。
 * 未识别返回 null（不猜）。
 */
function parseModelHead(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  let inModel = false
  let model = null
  let provider = null
  let started = false
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.match(/^\s*/)[0].length
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    if (indent === 0) {
      if (m[1] === 'model') { inModel = true; started = true; continue }
      inModel = false
      if (started) break   // model 块已结束
      continue
    }
    if (!inModel) continue
    const key = m[1]
    const val = m[2].trim().replace(/^["']|["']$/g, '')
    if (!val) continue
    if (key === 'default') model = val
    else if (key === 'provider') provider = val
  }
  return { model, provider }
}

/** 兜底：原因文本里若混入疑似长凭据，一律替换（纵深防御，绝不外泄） */
function sanitizeReason(s) {
  return String(s || '')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<redacted>')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,})\b/g, '<redacted>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')
    .slice(0, 300)
}

/**
 * 汇总为界面状态。
 *   cliState: parseAuthStatus 的结果（每个 Profile 独立查询）
 *   apiState: 官方 /api/status 的 nous_session_valid（**仅 default Profile 有**，
 *             用于交叉核对；两者矛盾时降级为「未验证」，不做猜测）
 *
 * 语义（区分「认证」与「可调用」）：
 *   valid       —— 官方明确 logged in
 *   expired     —— 官方明确 logged out
 *   unverified  —— 拿不到可靠证据（命令失败 / 输出无法识别 / 两处矛盾）
 *
 * reliable=false 时界面**不得**弹出「认证失效」，只能显示「认证状态未验证」。
 */
function decideAuthState({ cliState, cliReason, cliOk, apiState }) {
  if (cliOk === false) {
    return { state: 'unverified', reliable: false, expired: false, reason: cliReason || '官方状态查询未成功' }
  }
  if (cliState === 'logged-in') {
    // 交叉核对：default Profile 还有 /api/status 一路证据
    if (apiState && apiState !== 'valid') {
      return {
        state: 'unverified', reliable: false, expired: false,
        reason: `官方 CLI 判定已登录，但网关 API 报告会话状态为「${apiState}」——两处证据不一致，不做猜测。`
      }
    }
    return { state: 'valid', reliable: true, expired: false, reason: cliReason || '官方 CLI 判定已登录' }
  }
  if (cliState === 'logged-out') {
    return {
      state: 'expired', reliable: true, expired: true,
      reason: cliReason || '官方 CLI 判定未登录（缺少访问令牌）'
    }
  }
  return {
    state: 'unverified', reliable: false, expired: false,
    reason: cliReason || '无法从官方输出识别认证状态'
  }
}

/**
 * 认证状态 ≠ 模型可调用。
 * 返回值固定用于「模型可调用性」一栏，避免把"已登录"吹成"可用"。
 */
function callabilityNote(authState) {
  if (authState === 'valid') return { state: '待验证', ok: null, detail: '认证有效，但未执行真实推理请求，故不声明可用' }
  if (authState === 'expired') return { state: '不可用', ok: false, detail: '认证失效：机器人能收到消息，但无法产出模型回答' }
  return { state: '未验证', ok: null, detail: '认证状态未验证，无法判断模型是否可调用' }
}

module.exports = {
  PROVIDER_AUTH,
  providerAuth: p => (typeof p === 'string' ? (PROVIDER_AUTH[p] || null) : null),
  buildStatusInvocation,
  buildAuthInvocation,
  parseAuthStatus,
  parseModelHead,
  sanitizeReason,
  decideAuthState,
  callabilityNote,
  displayArgv
}
