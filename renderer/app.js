/**
 * Hermes 桌面控制台 — 渲染进程
 *
 * 数据来源全部是官方 API 的真实返回：
 *   /api/status             网关 / 飞书 / 组件健康 / 认证会话
 *   /api/model/info         当前模型与 Provider
 *   /api/messaging/platforms 平台配置与连接
 *   /api/skills             技能列表
 *   /api/logs               运行日志
 * 无数据时显示空状态，绝不伪造运行状态。
 */

const $ = id => document.getElementById(id)

let BOOT = null
let REFRESH_TIMER = null
let STATUS_CACHE = null
/** 最近一次 /api/skills 结果（**default Profile** 口径）——仅供"范围明细"分区展示使用 */
let SKILLS_CACHE = []

// ---------------------------------------------------------------- 工具
function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  const msg = document.createElement('div')
  msg.className = 'tmsg'
  msg.textContent = message
  el.appendChild(msg)
  $('toasts').appendChild(el)
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 260) }, ms)
}

async function withBusy(btn, fn) {
  if (!btn) return fn()
  if (btn.disabled) return
  const prev = btn.disabled
  btn.disabled = true
  btn.classList.add('busy')
  try { return await fn() }
  finally { btn.disabled = prev; btn.classList.remove('busy') }
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分 ${s % 60} 秒`
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '—' }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function apiGet(path, params) {
  const res = await window.hermes.get(path, params)
  return res && res.data
}

// ---------------------------------------------------------------- 时钟
function tickClock() {
  const now = new Date()
  $('clock').textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  $('clockDate').textContent =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}　周${week}`
  const h = now.getHours()
  const greet = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  $('greeting').textContent = `${greet}，Commander`
}

/**
 * 所有权展示与按钮提示（按 Profile）。
 * 注意：按钮的启用/禁用只是 UI 提示；真正的权限判定在主进程 authorizeDangerous()。
 * 即使有人绕过 UI 直接调用 IPC，未通过核验的操作依然会被拒绝。
 */
function ownershipOf(profileId) {
  const byP = (BOOT && BOOT.ownership && BOOT.ownership.byProfile) || {}
  return byP[String(profileId)] || null
}
/** 返回某 Profile 的所有权模式：'owned'(A 持有) | 'shared'(B 共享/在运行但非本控制台持有) | 'none' */
function ownershipModeOf(profileId, running) {
  const e = ownershipOf(profileId)
  if (e && e.owned) return 'owned'
  if (running) return 'shared'
  return 'none'
}
/** 历史别名：首页 hero 卡只展示 default 网关，沿用单参形式 */
function ownershipMode() { return ownershipModeOf('default') }

/**
 * 「额外 Profile」= 第一个非 default 的 Profile（由主进程运行时发现）。
 * 公开版本不写死任何具体 Profile 名；没有额外 Profile 时返回 null，
 * 调用方需按 null 处理（显示「未发现/未验证」，不臆造）。
 */
function extraProfileId() {
  const g = (BOOT && BOOT.gateways) || {}
  const k = Object.keys(g).find(x => x !== 'default')
  return k || null
}

/** 网关真实运行态：来自主进程 bootstrap.gateways（OS 进程核验，不依赖 serve 的 /api/status） */
function gwRunning(id) {
  if (!id) return false
  const g = (BOOT && BOOT.gateways && BOOT.gateways[String(id)]) || null
  return !!(g && g.running)
}
function gwRunningDefault() { return gwRunning('default') }

/**
 * 自动停止能力的真实开关（来自主进程 bootstrap）。
 * 关键事实：当前 ALLOW_AUTO_STOP=false → **关闭控制台不会停止任何网关**。
 * 所有涉及"关闭控制台会不会停止网关"的文案都必须以此为准，不得写死成"会停止"。
 */
function autoStopInfo() {
  const o = (BOOT && BOOT.ownership) || {}
  const a = o.autoStop || {}
  return { enabled: !!a.enabled, reason: a.reason || '' }
}
function autoStopEnabled() { return autoStopInfo().enabled }

function updateGatewayControls(running) {
  const mode = ownershipModeOf('default', running)
  const owned = mode === 'owned'
  // ★ RC 轮策略：停止仅对本控制台启动并持有的实例（A 态）开放；
  //   重启仍一律禁用（未通过真实端到端验收）。
  //   按钮禁用只是提示；真正的拒绝在主进程（授权门 + decideStopRelease），
  //   即使绕过界面直接调用 IPC，非持有实例也会被拒绝。
  const stopTip = owned
    ? '本控制台持有该网关实例（A）：点击停止。主进程会在执行前重新核验身份' +
      '（同 profile 单实例 + OS 进程核对），身份已变化则拒绝执行。' +
      (autoStopEnabled() ? '关闭控制台时会重新核验身份后停止它。'
        : '⚠ 自动停止当前已禁用 —— 关闭控制台不会停止它。')
    : '停止仅对本控制台亲自启动并持有的实例（A 态）开放；当前实例不是控制台启动的，已禁用。' +
      '共享网关请在其启动方（终端 / 会话）中停止。'
  const restartTip = '重启未开放：尚未通过真实端到端验收（官方 stop 为 profile 级，存在竞态）。'
  const stopBtn = $('btnGwStop')
  if (stopBtn) { stopBtn.disabled = !owned; stopBtn.title = stopTip }
  const restartBtn = $('btnGwRestart')
  if (restartBtn) { restartBtn.disabled = true; restartBtn.title = restartTip }
}

/** 危险操作统一入口：stop 走所有权路径；其余动作被拒时走「一次性授权」流程（C，当前均禁用） */
async function doGatewayAction(action, label, opts) {
  const call = action === 'stop' ? window.hermes.gatewayStop
    : action === 'restart' ? window.hermes.gatewayRestart
      : window.hermes.gatewayDrain
  let res = await call(opts)
  if (res && res.ok) {
    const va = res.verifyAfter || {}
    const warns = res.verifyWarnings || []
    let msg = `${label}成功（授权方式：${res.via === 'one-shot' ? '一次性授权' : '所有权核验'}）` +
      `　OS 级复核：目标 PID 已消失 · 同 Profile 剩余网关实例 ${va.sameProfileProcesses ?? '未知'}`
    // ★ 与"停止成功"**分开表示**：状态文件陈旧只作独立警告，不改变成功结论
    if (warns.length) {
      msg += `　⚠️ 独立警告：${(res.warningMessages || []).join(' ')}`
    }
    toast(msg, 'ok', warns.length ? 16000 : 9000)
    return true
  }
  // ★ 停止复核未通过（任一条件未知或不满足）→ 一律不算成功，不显示"停止成功"
  if (res && res.reason === 'stop-unverified') {
    toast(`${label}未确认：${res.message || '停止结果未确认'}`, 'warn', 12000)
    return false
  }
  // ★ 活跃任务：>0 直接拒绝；未知一律暂停真实验收，**不提供人工确认继续**
  if (res && res.reason === 'active-tasks') {
    toast(`${label}被拒绝：${res.message || '该网关仍有活跃任务'}`, 'warn', 11000)
    return false
  }
  if (res && res.reason === 'active-tasks-unknown') {
    toast(`${label}已暂停：${res.message || '无法确认活跃任务数，真实验收暂停'}`, 'warn', 12000)
    return false
  }
  // ★ PID file race lost：给出安全恢复指引，不自动重试
  if (res && res.reason === 'pid-file-race-lost') {
    toast(res.message || '检测到 PID file race lost，请按安全恢复步骤处理', 'warn', 20000)
    return false
  }
  if (res && res.reason === 'no-ownership') {
    if (action === 'stop') {
      // ★ RC 轮边界：stop 不提供一次性授权兜底 —— 用户明确的方案是"外部启动的网关仍只读"
      toast(`${label}被拒绝：停止仅对本控制台启动并持有的实例（A 态）开放；` +
        `共享网关请在其启动方停止。`, 'warn', 8000)
      return false
    }
    const ok = confirm(
      `${label}：该网关不是本控制台启动的（共享服务）。\n\n` +
      `本次操作需要你的明确授权，且【只对本次生效】：\n` +
      `· 不会让控制台获得所有权\n` +
      `· 不会改变关闭控制台时的行为\n` +
      `· 授权 5 分钟内有效、仅可使用一次\n\n` +
      `确认授权本次「${label}」吗？`)
    if (!ok) { toast('已取消（未授权）', 'info'); return false }
    const a = await window.hermes.gatewayAuthorizeOnce(action)
    if (!a || !a.ok) {
      toast(`无法签发授权：${(a && a.message) || '目标实例身份不可确认'}`, 'warn', 8000)
      return false
    }
    // 授权已绑定到当前目标实例；若此刻目标发生变化，主进程会拒绝执行
    res = await call()
    if (res && res.ok) { toast(`${label}成功（一次性授权已消费）`, 'ok'); return true }
    toast(`${label}失败：${(res && res.message) || '未知原因'}`, 'bad', 7000)
    return false
  }
  toast(`${label}被拒绝：${(res && res.message) || (res && res.reason) || '未知原因'}`, 'warn', 8000)
  return false
}

// ---------------------------------------------------------------- 渲染：网关
function renderGateway(status, meta) {
  const running = gwRunningDefault()   // ★ 真实运行态：OS 进程核验，不取 serve 的 gateway_running
  const pill = $('gwPill'), val = $('gwValue')

  if (running) {
    pill.className = 'pill ok'; pill.textContent = '运行中'
    val.className = 'hero-value ok'; val.textContent = '运行中'
  } else {
    pill.className = 'pill bad'; pill.textContent = '未运行'
    val.className = 'hero-value bad'; val.textContent = '已停止'
  }

  const g = (BOOT && BOOT.gateways && BOOT.gateways.default) || null
  const pid = (g && g.pid) || (meta && meta.pid) || (status && status.gateway_pid) || null
  $('gwPid').textContent = pid ? String(pid) + ((g && g.stale) ? '（已不存在）' : '') : '—'
  const started = (g && g.pid) ? (meta && meta.startMs) : null
  $('gwUptime').textContent = (running && started) ? fmtUptime(Date.now() - started) : '—'

  const mode = ownershipMode()
  const ownNote = {
    owned: autoStopEnabled()
      ? '本控制台持有该实例（A）：关闭控制台时会重新核验身份后停止它。'
      : '本控制台持有该实例（A）：关闭控制台不会停止它（自动停止已禁用）；可用上方「停止」按钮手动停止（执行前会重新核验身份）。',
    shared: '该实例在本控制台启动前已存在（B）：关闭控制台不会停止它；停止仅对本控制台启动并持有的实例（A 态）开放，' +
      '共享实例请在其启动方（终端 / 会话）停止。',
    none: '当前没有运行中的网关。'
  }[mode]
  const gateNote = mode === 'owned'
    ? '　⚠ 停止前主进程会重新核验身份（同 profile 单实例 + OS 进程核对）；重启 / 排空 / 接管仍未开放。'
    : '　⚠ 停止仅对 A 态开放；重启 / 排空 / 接管本轮仍未开放。'
  $('gwNote').textContent = `运行状态以 OS 进程核验为准（实时）；控制台自身 serve 后端仅用于飞书 / 认证等附属信息，不作为网关是否运行的依据。${ownNote}${gateNote}`
  updateGatewayControls(running)
}

// ---------------------------------------------------------------- 渲染：飞书
function renderFeishu(status, platforms) {
  const fs = (status.gateway_platforms || {}).feishu
  const pill = $('fsPill'), val = $('fsValue')
  if ($('fsHome')) $('fsHome').textContent = (BOOT && BOOT.hermesHome) || '—'

  if (!fs) {
    pill.className = 'pill muted'; pill.textContent = '未接入'
    val.className = 'hero-value dim'; val.textContent = '未配置'
    $('fsChannel').textContent = '—'
    $('fsUpdated').textContent = '—'
    $('fsNote').textContent = '网关状态中未发现飞书平台记录。'
    return
  }

  const connected = fs.state === 'connected'
  pill.className = connected ? 'pill ok' : 'pill bad'
  pill.textContent = connected ? '已连接' : String(fs.state || '未知')
  val.className = connected ? 'hero-value ok' : 'hero-value bad'
  val.textContent = connected ? '已连接' : '未连接'
  $('fsChannel').textContent = 'WebSocket'
  $('fsUpdated').textContent = fmtTime(fs.updated_at)

  if (fs.error_message) {
    $('fsNote').textContent = `错误：${fs.error_message}`
  } else if (connected) {
    $('fsNote').textContent = '飞书通道已连接；连接正常不代表模型可回答，请以「模型与认证」页为准。'
  } else {
    $('fsNote').textContent = '飞书未连接，请在「飞书连接」页查看配置。'
  }
}

// ---------------------------------------------------------------- 渲染：模型与认证
// ---------------------------------------------------------------- 渲染：模型与认证（按 Profile）
/**
 * 认证口径（本轮专项）：
 *   - provider / model：主进程**实读**各 Profile 的 config.yaml（不沿用任何历史结论）
 *   - 认证状态：官方只读命令 `hermes [--profile X] auth status <provider>`
 *   - 「网关在线 ≠ 飞书连接 ≠ 认证有效 ≠ 模型可调用」四项分开呈现
 *   - 主进程只回传状态语义与官方给出的原因文本，**不含任何凭据**
 */
let AUTH_PROFILES = null        // 主进程返回的按 Profile 认证信息
let AUTH_GUIDANCE = ''
let AUTH_LOADING = false
let AUTH_MODAL_PROFILE = null   // 当前弹窗对应的 Profile id

const AUTH_STATE_TEXT = { valid: '认证有效', expired: '认证失效', unverified: '未验证' }
const AUTH_STATE_PILL = { valid: 'pill ok', expired: 'pill bad', unverified: 'pill muted' }
function authText(s) { return AUTH_STATE_TEXT[s] || '未验证' }
function authPillCls(s) { return AUTH_STATE_PILL[s] || 'pill muted' }
function authDot(s) { return s === 'valid' ? 'ok' : s === 'expired' ? 'bad' : 'unk' }

/** 拉取认证信息（force=true 时忽略主进程的短缓存，用于「重新检测」） */
async function loadAuth(force) {
  if (AUTH_LOADING) return AUTH_PROFILES
  AUTH_LOADING = true
  try {
    const r = await window.hermes.authInfo(null, force ? { force: true } : undefined)
    AUTH_PROFILES = (r && Array.isArray(r.profiles)) ? r.profiles : []
    AUTH_GUIDANCE = (r && r.guidance) || AUTH_GUIDANCE
  } catch (err) {
    console.warn('[debug] 认证信息读取失败: ' + err.message)
    AUTH_PROFILES = AUTH_PROFILES || []
  } finally { AUTH_LOADING = false }
  renderAuth()
  updateProblemBadge()
  renderScopeTable()      // 认证结果异步到达 → 刷新「范围明细」里的认证列
  checkAuth(false)
  return AUTH_PROFILES
}

function authCardHtml(p) {
  const call = p.callability || {}
  const cmd = p.officialCommand || 'hermes auth --help'
  return `
  <article class="card glass auth-card">
    <header class="card-head">
      <div class="card-title"><span class="card-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#i-key"/></svg></span>${esc(p.label)}</div>
      <span class="${authPillCls(p.state)}">${esc(authText(p.state))}</span>
    </header>
    <div class="kv-grid wide">
      <div class="kv"><span>Provider</span><b>${esc(p.providerLabel || p.provider || '未识别')}</b></div>
      <div class="kv"><span>模型</span><b class="mono">${esc(p.model || '未识别')}</b></div>
      <div class="kv"><span>认证方式</span><b>${esc(p.methodLabel || '—')}</b></div>
      <div class="kv"><span>模型可调用性</span><b title="${esc(call.detail || '')}">${esc(call.state || '未验证')}</b></div>
    </div>
    <div class="card-note${p.expired ? ' warn' : ''}">${esc(p.reason || '—')}</div>
    <div class="cmd-row">
      <code class="cmd-box mono">${esc(cmd)}</code>
      <button class="btn sm" data-auth-copy="${esc(cmd)}">复制</button>
    </div>
    <div class="card-actions">
      <button class="btn primary" data-auth-open="${esc(p.id)}">重新认证…</button>
      <button class="btn" data-auth-recheck="${esc(p.id)}">重新检测</button>
    </div>
    <div class="card-note">「重新认证」只打开独立终端并载入<b>官方命令</b>；控制台不参与授权、不收集任何凭据、不自动切换 Provider。</div>
  </article>`
}

/** 渲染概览模型卡 + 「模型与认证」页的按 Profile 认证卡 */
function renderAuth() {
  const list = AUTH_PROFILES

  const pill = $('mdPill')
  if (pill) {
    if (!list) { pill.className = 'pill muted'; pill.textContent = '读取中' }
    else if (!list.length) { pill.className = 'pill muted'; pill.textContent = '不可用' }
    else {
      const okN = list.filter(p => p.state === 'valid').length
      pill.className = okN === list.length ? 'pill ok' : (list.some(p => p.expired) ? 'pill bad' : 'pill muted')
      pill.textContent = `${okN}/${list.length} 认证有效`
    }
  }

  const rowsEl = $('providerRows')
  if (rowsEl) {
    rowsEl.innerHTML = (!list || !list.length)
      ? '<div class="provider-row"><span class="provider-state unk">认证信息读取中或不可用</span></div>'
      : list.map(p => `
        <div class="provider-row">
          <div class="provider-name">
            <span class="provider-dot ${authDot(p.state)}"></span>
            <span title="${esc(p.reason || '')}">${esc(p.label)} · ${esc(p.provider || '未识别')}</span>
          </div>
          <span class="provider-state ${authDot(p.state)}">${esc(authText(p.state))}</span>
        </div>`).join('')
  }

  if ($('mdNote')) {
    const bad = (list || []).filter(p => p.expired).map(p => p.label)
    $('mdNote').textContent = !list
      ? '正在读取各 Profile 的认证状态…'
      : bad.length
        ? `${bad.join('、')} 的 Provider 认证失效：机器人能收到消息，但无法产出模型回答。`
        : (list.length
          ? '认证状态按 Profile 分别展示；认证有效 ≠ 模型可调用（尚未执行真实推理验证）。'
          : '未能读取认证信息，请点「重新检测」。')
  }

  const cards = $('authProfileCards')
  if (cards) {
    cards.innerHTML = !list
      ? '<div class="empty">正在读取各 Profile 的模型配置与认证状态…</div>'
      : (list.length
        ? list.map(authCardHtml).join('')
        : '<div class="empty">未能读取认证信息，请稍后点右上角「重新检测」。</div>')
  }
}

// ---------------------------------------------------------------- 渲染：Agent
/**
 * Agent 页数据全部来自官方 /api/status 的真实字段：
 *   active_agents / active_sessions / gateway_busy / gateway_drainable /
 *   profiles / gateway_mode
 * 缺失时显示「—」，绝不编造。
 */
function renderAgent(status) {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v }
  const running = gwRunningDefault()   // ★ 真实运行态：OS 进程核验，不取 serve 的 gateway_running
  if ($('agentPill')) {
    $('agentPill').className = running ? 'pill ok' : 'pill muted'
    $('agentPill').textContent = running ? '运行中' : '未运行'
  }
  const num = v => (typeof v === 'number' ? String(v) : '—')
  const bool = v => (typeof v === 'boolean' ? (v ? '是' : '否') : '—')
  set('agentActive', num(status.active_agents))
  set('agentSessions', num(status.active_sessions))
  set('agentBusy', bool(status.gateway_busy))
  set('agentDrainable', bool(status.gateway_drainable))
  set('agentProfiles', Array.isArray(status.profiles) && status.profiles.length ? status.profiles.join('、') : '—')
  set('agentMode', status.gateway_mode || '—')
}

// ---------------------------------------------------------------- 渲染：扩展能力
function renderCapabilities(caps) {
  if (!caps) return
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v }
  const ac = caps.external || {}
  const cj = caps.profile || {}

  // ---- 外部工程 ----
  if ($('acPill')) {
    $('acPill').className = 'pill ' + (ac.installed ? 'ok' : 'bad')
    $('acPill').textContent = ac.installed ? '已安装' : '未安装'
  }
  set('acRepo', ac.repo || '—')
  const acRun = $('acRunning')
  if (acRun) {
    acRun.textContent = ac.running === true
      ? `运行中${(ac.runningPids || []).length ? '（pid ' + ac.runningPids.join(', ') + '）' : ''}`
      : ac.running === false ? '未运行' : '未验证'
    acRun.className = ac.running === true ? 'ok-text' : ac.running === false ? '' : 'unk-text'
  }
  set('acVenv', ac.venvReady ? '已就绪' : '缺失')
  set('acModule', ac.moduleReady ? '存在' : '缺失')
  set('acLauncher', ac.launcherPresent ? '存在' : '缺失')
  if ($('acNote')) {
    $('acNote').textContent = !ac.installed
      ? '未在本机检测到 外部工程 工程目录，故标记为「未安装」。控制台不会伪造已接入。'
      : ac.running === null
        ? `已安装，但进程运行状态探测失败（${ac.probeError || '未验证'}）—— 不做“正在运行”的假设。启动器：${ac.repo}\\外部工程.bat`
        : `已安装${ac.running ? '，且检测到运行中的进程' : '，当前未检测到运行中的进程'}。控制台不代其启动翻唱流水线；如需使用请通过项目目录中的启动器。`
  }

  // ---- 额外 Profile ----
  if ($('cjPill')) {
    $('cjPill').className = 'pill ' + (cj.installed ? 'ok' : 'bad')
    $('cjPill').textContent = cj.installed ? 'Profile 已安装' : '未安装'
  }
  set('cjDir', cj.profileDir || '—')
  set('cjSkills', cj.installed ? `${cj.skillsCount} 个技能` : '—')
  set('cjConfig', cj.configPresent ? '存在' : '缺失')
  const gw = cj.gateway
  const gwEl = $('cjGateway')
  if (gwEl) {
    if (!gw) gwEl.textContent = '—'
    else if (gw.alive) gwEl.textContent = `运行中（${gw.state || 'running'}）`
    else gwEl.textContent = gw.pid ? '未运行（记录已过期，启动前会实测核实）' : '未运行'
  }
  set('cjPid', gw && gw.pid ? `${gw.pid}${gw.alive ? '' : '（已不存在）'}` : '—')
  if ($('cjNote')) {
    $('cjNote').textContent = !cj.installed
      ? '未检测到额外 Profile 目录，标记为「未安装」。'
      : `Profile 已安装，含 ${cj.skillsCount} 个技能、配置文件${cj.configPresent ? '存在' : '缺失'}；网关${gw && gw.alive ? '运行中' : '当前未运行'}。` +
        (gw && gw.pid && !gw.alive
          ? '状态文件仍记录着一个已不存在的 PID（记录已过期）—— 该记录本身不构成拒绝理由，' +
            '但能否启动以启动时的实测结果为准（控制台会在启动前核实真实进程 / Profile / 锁状态；' +
            '若官方报 PID file race lost，会给出安全恢复提示且不自动重试）。'
          : '') +
        '控制台可手动「启动」该 Profile 的网关；停止仅对本控制台启动并持有的实例开放，且不会自动启动。'
  }

  // ---- 独立功能开关：本轮不可用（明确原因，绝不使用假开关）----
  const disableReason = 'Hermes 当前没有可被可靠调用的「按能力停收消息 / 独立禁用」接口；' +
    '关闭整个 Gateway 或终止业务进程都不是"关闭该功能"，故本开关不可用（已列为待实现项）。'
  if ($('acSwitchReason')) {
    $('acSwitchReason').textContent = ac.installed
      ? `${disableReason} 外部工程 是独立业务程序（非 Hermes 组件）：如需停止请在其自身界面或系统进程管理器中操作。`
      : '外部工程 未安装，无可开关的功能。'
  }
  if ($('cjSwitchReason')) {
    $('cjSwitchReason').textContent = cj.installed
      ? `${disableReason} 额外 Profile 是独立 Profile：使其"不再接收任务"= 停止其 Gateway，而停止仅对本控制台启动并持有的实例开放（共享实例仍不可停）。`
      : '额外 Profile 未安装，无可开关的功能。'
  }
  if ($('switchSupportPill')) {
    $('switchSupportPill').className = 'pill warn'
    $('switchSupportPill').textContent = '独立开关：暂不支持'
  }
}

/** 用真实运行态驱动"手动启动"按钮（禁用的按钮才是真的不可点，状态不靠前端开关自嗨） */
function renderServiceButtons(rs) {
  if (!rs) return
  const gw = id => (rs.services || []).find(s => s.id === 'gateway:' + id) || null
  const setBtn = (btn, svc, label) => {
    if (!btn || !svc) return
    btn.disabled = !!svc.running
    btn.textContent = svc.running ? `${label} 运行中` : `启动 ${label}`
    btn.title = svc.running
      ? `已在运行（${svc.detail}），不会重复启动`
      : `手动启动 ${label} 的 Gateway（启动前校验 Profile / 配置 / 进程 / 冲突；不使用 --replace 或强杀）`
  }
  setBtn($('btnStartDefault'), gw('default'), 'default 网关')
  setBtn($('btnStartProfile2'), gw(extraProfileId()), '额外 Profile 网关')
}

/** 按 Profile 展示所有权状态（default / 额外 Profile 分别）+ A 态停止按钮可用性。
 *  注意：按钮禁用只是提示；真正的权限判定在主进程 authorizeDangerous()。 */
function renderProfileOwnership() {
  if (!BOOT) return
  const byP = (BOOT.ownership && BOOT.ownership.byProfile) || {}
  const apply = (id, noteId, btnId, running) => {
    const e = byP[id] || null
    const owned = !!(e && e.owned)
    const note = $(noteId)
    const btn = $(btnId)
    const rf = (e && e.registerFailure) || null
    if (note) {
      if (owned) note.textContent = 'A 态：本控制台已确认持有（停止按钮可用）。'
      else if (running && rf) {
        // ★ 不臆断启动方（2026-09-22）：本控制台启动过、但登记未成功时，
        //   过去会被一律显示成"非本控制台启动（共享实例）"，那是错的。此处如实说明。
        note.textContent = '网关运行中 · 停止权限未确认：' +
          (rf.message || ('登记未成功（' + (rf.reason || '原因未知') + '）')) +
          ' 停止按钮已禁用；主进程在身份未确认时一律拒绝执行停止。'
      } else if (running) {
        note.textContent = 'B 态：该 Profile 网关正在运行，但非本控制台启动（共享实例）—— 停止按钮已禁用，请在其启动方停止。'
      } else {
        note.textContent = '未持有：该 Profile 网关未运行 —— 停止按钮已禁用。'
      }
    }
    if (btn) {
      btn.disabled = !owned
      btn.title = owned
        ? '本控制台持有该实例（A）：点击停止。主进程执行前会重新核验身份（同 profile 单实例 + OS 进程核对）。'
        : (rf
            ? '停止仅对本控制台启动且身份已确认的实例（A 态）开放；当前实例运行中但停止权限未确认，已禁用。'
            : '停止仅对本控制台启动并持有的实例（A 态）开放；当前实例不是控制台启动的，已禁用。')
    }
  }
  const cj = (CAPS_CACHE && CAPS_CACHE.profile) || {}
  const defaultRunning = gwRunningDefault()           // ★ OS 核验，不取 serve 的 gateway_running
  const cjRunning = gwRunning(extraProfileId())        // ★ 与 default 同源（bootstrap.gateways），统一口径
  apply('default', 'ownDefaultNote', 'btnStopDefault', defaultRunning)
  apply(extraProfileId(), 'ownProfile2Note', 'btnStopProfile2', cjRunning)
}

let CAPS_CACHE = null
async function loadCapabilities() {
  try {
    const caps = await window.hermes.capabilities()
    CAPS_CACHE = caps
    renderCapabilities(caps)
    renderScopeTable()      // 能力探测完成 → 刷新「范围明细」里的额外 Profile 列
    if ($('shortcutNote')) {
      const ac = (caps && caps.external) || {}
      const cj = (caps && caps.profile) || {}
      $('shortcutNote').textContent =
        `外部能力状态 · 外部工程：${ac.installed ? (ac.running === true ? '运行中' : ac.running === false ? '已安装未运行' : '已安装·状态未验证') : '未安装'}` +
        `　·　额外 Profile：${cj.installed ? `Profile 已安装（${cj.skillsCount} 技能，网关${cj.gateway && cj.gateway.alive ? '运行中' : '未运行'}）` : '未安装'}`
    }
  } catch (err) {
    console.warn('[debug] 能力探测失败: ' + err.message)
    if ($('shortcutNote')) $('shortcutNote').textContent = `外部能力状态读取失败：${err.message}`
  }
  // 真实运行态驱动"手动启动"按钮
  try {
    renderServiceButtons(await window.hermes.services())
  } catch (err) {
    console.warn('[debug] 服务状态读取失败: ' + err.message)
  }
}

// ---------------------------------------------------------------- 退出提示（严格模式）
async function showExitModal(payload) {
  const list = $('exitSvcList')
  const svcs = (payload && payload.services) || []
  const running = svcs.filter(s => s.running)
  list.innerHTML = running.length
    ? running.map(s => `
        <li class="svc-item">
          <span class="svc-dot ok"></span>
          <div class="svc-main">
            <div class="svc-name">${esc(s.label)}</div>
            <div class="svc-detail">${esc(s.detail || '')}${s.stoppable === false && s.stoppableReason ? ' · 不可安全停止：' + esc(s.stoppableReason) : ''}</div>
          </div>
          <span class="svc-tag bad">运行中</span>
        </li>`).join('')
    : '<li class="svc-item"><span class="svc-dot off"></span><div class="svc-main"><div class="svc-name">没有仍在运行的相关服务</div></div></li>'
  $('exitPill').className = 'pill warn'
  $('exitPill').textContent = running.length ? '服务仍在运行' : '可安全退出'
  $('exitNote').textContent = (payload && payload.note ? payload.note + ' ' : '') +
    '选择「仅退出控制台」不会停止任何网关、也不会终止任何进程 —— 后台服务将继续运行，这不等于全部结束。'
  $('exitModal').classList.remove('hidden')
}

function hideExitModal() { $('exitModal').classList.add('hidden') }

// ---------------------------------------------------------------- 模型认证弹窗（按 Profile）
/**
 * 去重规则：签名 = 每个 Profile 的 `id:provider:state`。
 *   - 只有**有可靠证据**（reliable）且判定为失效（expired）时才自动弹窗；
 *   - 同一签名只弹一次；状态变化（如认证恢复或再次失效）才允许重新提醒；
 *   - 「未验证」**不自动弹窗**（无可靠依据不误报），仅在页面显示为「未验证」。
 */
let AUTH_SHOWN_SIG = null

function authSig(list) {
  return (list || []).map(p => `${p.id}:${p.provider || '-'}:${p.state}`).join('|')
}

function checkAuth(showToastOnOk) {
  const list = AUTH_PROFILES || []
  const sig = authSig(list)
  const expired = list.filter(p => p.reliable && p.expired)
  if (!expired.length) {
    // 恢复正常（或本来就没问题）：清除去重标记，下次再失效会重新提醒
    if (AUTH_SHOWN_SIG && AUTH_SHOWN_SIG !== sig) {
      AUTH_SHOWN_SIG = null
      if (showToastOnOk && list.length && list.every(p => p.state === 'valid')) toast('认证状态已恢复正常', 'ok')
    }
    return
  }
  if (AUTH_SHOWN_SIG === sig) return   // 去重：同一故障不反复弹窗
  AUTH_SHOWN_SIG = sig
  openAuthModal(expired[0].id, { auto: true })
}

function openAuthModal(profileId, opts) {
  const p = (AUTH_PROFILES || []).find(x => x.id === profileId)
  if (!p) { toast('认证信息尚未就绪，请稍等片刻或点「重新检测」。', 'warn', 6000); return }
  AUTH_MODAL_PROFILE = p.id
  fillAuthModal(p)
  if ($('authFeedback')) { $('authFeedback').classList.add('hidden'); $('authFeedback').textContent = '' }
  if ($('btnAuthStart')) $('btnAuthStart').disabled = !p.officialCommand
  $('authModal').classList.remove('hidden')
}

function fillAuthModal(p) {
  const call = p.callability || {}
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v }
  set('authTitle', `模型认证 · ${p.label}`)
  set('authProfile', p.label)
  set('authProvider', p.provider
    ? `${p.provider}${p.providerLabel && p.providerLabel !== p.provider ? '（' + p.providerLabel + '）' : ''}`
    : '未识别')
  set('authModel', p.model || '未识别')
  set('authState', authText(p.state))
  if ($('authPill')) { $('authPill').className = authPillCls(p.state); $('authPill').textContent = authText(p.state) }
  set('authReason', `${p.reason || '—'}` +
    `　·　模型可调用性：${call.state || '未验证'}${call.detail ? '（' + call.detail + '）' : ''}`)
  set('authMethod', p.officialCommand
    ? `${p.providerLabel || p.provider} · ${p.methodLabel || '官方 OAuth'}\n${p.note || ''}`
    : '未识别到可自动构造的官方认证方式。请用官方方式手动处理（hermes auth --help）。')
  set('authCmd', p.officialCommand || 'hermes auth --help')
  // 若「官方认证方式」的说明里已经提到等价入口，就不再重复一次
  const alreadyMentioned = p.alias && String(p.note || '').includes(p.alias)
  set('authGuidance', (AUTH_GUIDANCE || '') +
    (p.alias && !alreadyMentioned ? `　等价入口：${p.alias}。` : ''))
}

function hideAuthModal() { $('authModal').classList.add('hidden') }

/** 在弹窗内显示一条反馈（成功/失败/进行中），不额外弹 toast 轰炸 */
function authFeedback(text, kind) {
  const el = $('authFeedback')
  if (!el) return
  el.className = `modal-note${kind === 'bad' ? '' : ' warn'}`
  el.textContent = text
  el.classList.remove('hidden')
}

// ---------------------------------------------------------------- 渲染：统计 / 活动
/**
 * 「待处理异常」= 组件异常 + 网关未运行 + 飞书未连接 + 认证失效。
 * 注意口径：官方的 /api/status.components 只统计组件健康（gateway/dashboard/storage/platforms），
 * 不包含 Provider 认证状态。若只按组件计数会出现"Nous 认证失效但仍然显示 0 异常"的矛盾，
 * 因此这里把认证与连接问题一并计入，并在注释中说明组成。
 */
function collectProblems(status) {
  const list = []
  const comps = status.components || {}
  const compBad = Object.entries(comps)
    .filter(([, c]) => c && c.status && c.status !== 'ok')
    .map(([k]) => `${k} 组件异常`)
  list.push(...compBad)
  if (!gwRunningDefault()) list.push('网关未运行')
  const fs = (status.gateway_platforms || {}).feishu
  if (!fs || fs.state !== 'connected') list.push('飞书未连接')
  // 认证：优先用**按 Profile 实查**的结果（含额外 Profile）；未就绪时退回网关 API 的 default 口径
  if (AUTH_PROFILES && AUTH_PROFILES.length) {
    const exp = AUTH_PROFILES.filter(p => p.reliable && p.expired)
    if (exp.length) list.push(`模型认证失效（${exp.map(p => p.label).join('、')}）`)
    else if (AUTH_PROFILES.some(p => p.state === 'unverified')) list.push('模型认证未验证')
  } else if (status.nous_session_valid === 'terminal') list.push('模型认证失效')
  else if (status.nous_session_valid && status.nous_session_valid !== 'valid') list.push('模型认证未验证')
  return list
}

/** 依据最新数据刷新「待处理异常」徽标（认证结果异步到达后会再调用一次） */
function updateProblemBadge() {
  const badge = $('notifyBadge')
  if (!badge) return
  const n = STATUS_CACHE ? collectProblems(STATUS_CACHE).length : 0
  if (n) badge.classList.remove('hidden'); else badge.classList.add('hidden')
}

function renderStats(status, skills) {
  const total = Array.isArray(skills) ? skills.length : 0
  const enabled = Array.isArray(skills) ? skills.filter(s => s.enabled).length : 0
  const problems = collectProblems(status)

  $('statRunning').textContent = String(status.active_agents ?? 0)
  $('statDone').textContent = String(enabled)
  $('statFail').textContent = String(problems.length)
  $('statFail').className = 'stat-num ' + (problems.length ? 'fail' : 'done')

  const compCount = Object.values(status.components || {}).filter(c => c && c.status && c.status !== 'ok').length
  // ★ 统计口径必须写明范围与"未验证"边界：
  //   · 该数字来自 default Profile 后端 `/api/skills`，**不含额外 Profile**；
  //   · 「已启用」≠「逐个可用性已验收」。
  $('statsNote').textContent =
    `待处理异常 ${problems.length} 项` + (problems.length ? `（${problems.join('、')}）` : '') +
    `　·　组件级异常 ${compCount} 项　·　活动会话 ${status.active_sessions ?? 0}　·　` +
    `Skills ${enabled}/${total} 已启用（统计范围：default Profile 的 Skills 注册表；` +
    `不含额外 Profile；「已启用」仅表示开关状态，不代表逐个可用性已验证）`
  renderScopeTable()
}

/**
 * 「范围明细（按 Profile）」：把 Gateway / Skills / 认证三项**按 Profile 分开**展示，
 * 避免首页的大数字被误读成"全部范围"。
 * 数据来源：default → /api/status + /api/skills；额外 Profile → capabilities（只读目录扫描）；
 * 认证 → console:authInfo（按 Profile 的官方只读状态）。
 */
function renderScopeTable() {
  const rows = $('scopeRows')
  if (!rows) return
  const st = STATUS_CACHE || {}
  const skills = Array.isArray(SKILLS_CACHE) ? SKILLS_CACHE : []
  const total = skills.length
  const enabled = skills.filter(s => s.enabled).length
  const caps = CAPS_CACHE || {}
  const cj = caps.profile || null

  const authOf = id => {
    if (!id) return { text: '未验证', cls: 'muted', tip: '未发现额外 Profile（未验证）' }
    const p = (AUTH_PROFILES || []).find(x => x.id === id)
    if (!p) return { text: '未验证', cls: 'muted', tip: '认证信息尚未读取完成（未验证）' }
    const label = { valid: '有效', expired: '失效', unverified: '未验证' }[p.state] || '未验证'
    const prov = p.provider ? p.provider : '未识别'
    const cls = p.state === 'valid' ? 'ok' : p.state === 'expired' ? 'bad' : 'muted'
    const tip = `Provider=${prov}｜模型=${p.model || '—'}｜判定=${p.reliable ? '基于官方只读命令' : '不可靠/未验证'}` +
      '｜认证有效 ≠ 模型可调用'
    return { text: `${label}（${prov}）`, cls, tip }
  }

  const gwDefault = gwRunningDefault()
    ? { text: `运行中${st.gateway_pid ? `（pid ${st.gateway_pid}）` : ''}`, cls: 'ok', tip: '来源：OS 进程核验（default Profile）' }
    : { text: '未运行', cls: 'muted', tip: '来源：OS 进程核验（default Profile）' }

  const cjAlive = !!(cj && cj.gateway && cj.gateway.alive)
  const gwCj = !cj
    ? { text: '未验证', cls: 'muted', tip: '能力探测未完成' }
    : cjAlive
      ? { text: `运行中${cj.gateway && cj.gateway.pid ? `（pid ${cj.gateway.pid}）` : ''}`, cls: 'ok', tip: '来源：额外 Profile 目录状态文件 + 进程探测' }
      : { text: '未运行', cls: 'muted', tip: cj.gateway && cj.gateway.pid ? '状态文件里的记录已过期（启动前会实测核实）' : '来源：额外 Profile 目录状态文件 + 进程探测' }

  const cjSkills = !cj
    ? { text: '未验证', cls: 'muted', tip: '能力探测未完成' }
    : { text: `${cj.skillsCount} 个已注册`, cls: 'muted', tip: '统计范围：额外 Profile 的技能目录计数；未逐个校验可用性' }

  const a1 = authOf('default')
  const a2 = authOf(extraProfileId())

  const pill = (o, extra) => `<span class="pill ${o.cls}" title="${esc(o.tip)}">${esc(o.text)}</span>${extra || ''}`

  rows.innerHTML = `
    <tr>
      <td><b>default</b><div class="mini-note">Hermes 默认 Profile</div></td>
      <td>${pill(gwDefault)}</td>
      <td>${pill({ text: `${enabled}/${total} 已启用`, cls: 'ok', tip: '来源 /api/skills（default Profile 注册表）' },
        '<div class="mini-note">范围＝default Profile；已启用 ≠ 已验证可用</div>')}</td>
      <td>${pill(a1)}</td>
    </tr>
    <tr>
      <td><b>额外 Profile</b><div class="mini-note">第一个非 default 的 Profile</div></td>
      <td>${pill(gwCj)}</td>
      <td>${pill(cjSkills, '<div class="mini-note">与 default 分开统计，不合并</div>')}</td>
      <td>${pill(a2)}</td>
    </tr>`

  if ($('scopeNote')) {
    $('scopeNote').textContent =
      '三项均按 Profile 分开展示，不做跨 Profile 合并：' +
      'Gateway 状态来自各自的只读状态源；Skills 数量分别取自各 Profile（default 走 /api/skills，' +
      '额外 Profile 走其技能目录计数）；认证状态按 Profile 实查官方只读命令，且「认证有效 ≠ 模型可调用」。' +
      '任何数字都不代表"已通过可用性验证"；未取到的一律显示「未验证」。'
  }
}

function renderActivity(status, skills, platforms) {
  const items = []
  const fs = (status.gateway_platforms || {}).feishu
  if (fs && fs.updated_at) {
    items.push({ t: fs.updated_at, kind: fs.state === 'connected' ? 'ok' : 'bad', text: `飞书通道 ${fs.state === 'connected' ? '连接正常' : '状态异常（' + fs.state + '）'}` })
  }
  if (status.gateway_updated_at) {
    items.push({ t: status.gateway_updated_at, kind: 'info', text: `网关状态刷新（${status.gateway_state || '—'}）` })
  }
  if (status.nous_session_valid === 'terminal') {
    items.push({ t: status.gateway_updated_at || new Date().toISOString(), kind: 'bad', text: 'Nous 认证失效，模型链路不可用' })
  }
  if (Array.isArray(skills)) {
    items.push({ t: new Date().toISOString(), kind: 'info', text: `已加载 ${skills.filter(s => s.enabled).length} 个已启用 Skill` })
  }
  const owner = { owned: 'A 持有网关', shared: 'B 共享网关', none: '无网关' }[ownershipModeOf('default', gwRunningDefault())]
  items.push({ t: new Date(BOOT ? BOOT.startedAt : Date.now()).toISOString(), kind: 'info', text: `控制台已启动（${owner}）· 后端端口 ${BOOT && BOOT.port ? BOOT.port : '—'}` })

  items.sort((a, b) => new Date(b.t) - new Date(a.t))
  const list = $('activityList')
  if (!items.length) { list.innerHTML = '<li class="empty">暂无活动记录</li>'; return }
  list.innerHTML = items.slice(0, 8).map(i => `
    <li>
      <span class="act-dot ${i.kind}"></span>
      <span class="act-time">${esc(fmtTime(i.t))}</span>
      <span class="act-text">${esc(i.text)}</span>
    </li>`).join('')
}

// ---------------------------------------------------------------- 渲染：其它页
function renderSkills(skills) {
  const q = ($('skillFilter').value || '').trim().toLowerCase()
  const all = Array.isArray(skills) ? skills : []
  const list = q
    ? all.filter(s => (s.name + ' ' + (s.category || '') + ' ' + (s.description || '')).toLowerCase().includes(q))
    : all
  const enabled = all.filter(s => s.enabled).length
  $('skillPill').className = 'pill ok'
  $('skillPill').textContent = `${enabled}/${all.length} 已启用`

  if (!list.length) {
    $('skillTable').querySelector('tbody').innerHTML = `<tr><td colspan="4" class="empty">${all.length ? '没有匹配的 Skill' : '未读取到 Skill'}</td></tr>`
    return
  }
  if (all !== window.__skillsCache) window.__skillsCache = all
  $('skillTable').querySelector('tbody').innerHTML = list.slice(0, 400).map(s => `
    <tr>
      <td class="name" title="${esc(s.description || '')}">${esc(s.name)}</td>
      <td>${esc(s.category || '—')}</td>
      <td>${esc(s.provenance || '—')}</td>
      <td><span class="pill ${s.enabled ? 'ok' : 'muted'}">${s.enabled ? '已启用' : '已禁用'}</span></td>
    </tr>`).join('')
}

function renderPlatforms(data) {
  const plats = (data && data.platforms) || []
  $('platPill').className = 'pill muted'
  $('platPill').textContent = `${plats.filter(p => p.enabled).length} 个已启用`
  const target = plats.filter(p => p.enabled)
  const show = target.length ? target : plats
  if (!show.length) { $('platformList').innerHTML = '<div class="empty">未读取到平台配置</div>'; return }
  $('platformList').innerHTML = show.map(p => {
    const stateOk = p.state === 'connected'
    return `
    <div class="auth-row">
      <div class="left">
        <span class="provider-dot ${stateOk ? 'ok' : p.enabled ? 'bad' : 'unk'}"></span>
        <div>
          <div class="name">${esc(p.name || p.id)}</div>
          <div class="msg">${p.enabled ? '已启用' : '未启用'} · ${p.configured ? '已配置凭据' : '未配置凭据'} · 状态 ${esc(p.state || '—')}${p.error_message ? ' · ' + esc(p.error_message) : ''}</div>
        </div>
      </div>
      <span class="provider-state ${stateOk ? 'ok' : p.enabled ? 'bad' : 'unk'}">${esc(p.state === 'connected' ? '已连接' : p.enabled ? (p.state || '已启用') : '未启用')}</span>
    </div>`
  }).join('')
}

function renderSettings() {
  if (!BOOT) return
  $('setHome').textContent = BOOT.hermesHome || '未找到'
  $('setExe').textContent = BOOT.hermesExe || '未找到'
  $('setPid').textContent = BOOT.backendPid ? String(BOOT.backendPid) : '—'
  $('setPort').textContent = BOOT.port ? String(BOOT.port) : '—'
  $('setLog').textContent = BOOT.logFile || '—'
  $('setElectron').textContent = String(BOOT.electron || '—')

  const o = (BOOT.ownership) || {}
  const byP = o.byProfile || {}
  const runningDefault = gwRunningDefault()
  const mode = ownershipModeOf('default', runningDefault)
  $('modePill').className = mode === 'owned' ? 'pill warn' : (mode === 'shared' ? 'pill ok' : 'pill muted')
  $('modePill').textContent = mode === 'owned' ? 'A · 本控制台持有（default）'
    : mode === 'shared' ? 'B · 共享服务（default）' : '无运行网关（default）'

  const inst = (byP['default'] && byP['default'].instance) || o.preExisting || null
  const instText = inst && inst.pid
    ? `pid=${inst.pid}${inst.startMs ? ' · 启动于 ' + new Date(inst.startMs).toLocaleString('zh-CN') : ''}`
    : '（未记录实例身份）'

  // 按 Profile 的所有权摘要（default / 额外 Profile 分别展示）
  const summary = ['default', extraProfileId()].filter(Boolean).map(id => {
    const e = byP[id]
    return e ? `${e.label || id}：${e.owned ? 'A 持有（可停止）' : '未持有'}` : null
  }).filter(Boolean).join('；')

  $('ownNote').textContent = (mode === 'owned'
    ? (autoStopEnabled()
        ? `本控制台持有 default 网关实例（A）：${instText}。关闭控制台时将【重新核验身份】后停止它；若身份已变化则拒绝停止。`
        : `本控制台持有 default 网关实例（A）：${instText}。⚠ 自动停止当前已禁用 —— 关闭控制台【不会】停止它；如需停止请在本控制台手动确认。`)
    : mode === 'shared'
      ? `default 网关是启动控制台前已存在的共享服务（B）：${instText}。控制台【不会】在关闭时停止它；停止仅对本控制台启动并持有的实例（A 态）开放，共享实例请在其启动方停止。`
      : '当前没有运行中的 default 网关。可在「扩展能力」页按 Profile 手动启动（控制台不会自动启动网关）。')
    + (summary ? `\n按 Profile：${summary}。` : '')

  // 自动停止能力的真实状态（明示，避免任何"关闭即停止"的暗示）
  const a = autoStopInfo()
  if ($('autoStopNote')) {
    $('autoStopNote').textContent = a.enabled
      ? '自动停止网关：已启用（该路径需另行真实验收）。'
      : `自动停止网关：已禁用（ALLOW_AUTO_STOP=false）—— 关闭控制台不会停止任何网关（A/B/C 三态均不会）。限制原因：${String(a.reason).replace(/^已禁用[：:]\s*/, '')}`
  }

  // 危险操作策略（RC 轮）：stop 仅对所有权 A 态放开；重启/排空/接管仍被主进程拒绝
  if ($('dangerNote')) {
    $('dangerNote').textContent =
      '停止：仅对本控制台亲自启动并持有的网关实例（A 态）开放，执行前主进程会重新核验身份' +
      '（同 profile 单实例 + OS 进程核对）；共享实例（B 态）仍只读展示、不会代停。' +
      '重启 / 排空 / 接管：仍未开放（ALLOW_DANGEROUS_EXEC=false，未通过真实端到端验收）。' +
      '本页保留按 Profile 的手动启动能力（见「扩展能力」页）。'
  }

  // 崩溃遗留提示
  const stale = o.stale
  if (stale && stale.instance) {
    $('ownNote').textContent += `　⚠ 检测到上次会话遗留的所有权记录（网关 pid=${stale.instance.pid}），` +
      `控制台已不在运行。控制台不会自动停止它；如需处理请手动停止（停止能力仅对本控制台启动并持有的实例开放）。`
  }
}

// ---------------------------------------------------------------- 日志（多来源）
//
// 数据来自主进程的**只读**文件读取（来源：default / 额外 Profile / 外部工程 / 控制台自身）。
// 渲染原则：
//   · 每条记录都保留原文，折叠只是展示分组，展开即可看到逐行原始内容
//   · 解释与级别标签**由主进程给**（logsources.js 是唯一事实来源，渲染层不再维护第二份表）
//   · 没有可靠解释时如实显示「暂无解释」，不编造故障原因
//   · 复制一律走「脱敏后复制」，避免把凭据带出去
let LOG_SOURCES_CACHE = null
let LOG_LAST = null          // 最近一次读取结果（供展开/复制使用）
let LOG_COLLAPSE = true      // 是否折叠重复
let LOG_RANGE = 'all'        // 时间范围：all | 10m | 1h | 6h
let LOG_ORDER = 'desc'       // 时间排序：desc=最新在前（默认） | asc

const LOG_LEVEL_CLASS = { ERROR: 'bad', CRITICAL: 'bad', WARNING: 'warn', INFO: '', DEBUG: '', TRACE: '' }

function fmtMtime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  } catch { return iso }
}

function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(2)} MB`
}

/** 把 ISO 时间戳格式化为可读形式（保留日期与秒，去掉毫秒与 T） */
function fmtTs(ts) {
  if (!ts) return '无时间戳'
  const s = String(ts)
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(s)
  if (!m) return s
  return `${m[1]} ${m[2]}`
}

/** 拉取来源清单并填充「文件」下拉 + 状态行（含三态提示） */
async function loadLogSources(keepSelection) {
  const prevFile = keepSelection ? $('logFile').value : ''
  const data = await window.hermes.logSources()
  LOG_SOURCES_CACHE = data
  const srcId = $('logSource').value
  const src = (data.sources || []).find(s => s.id === srcId)
  const sel = $('logFile')
  sel.innerHTML = ''
  if (!src) { setLogStatus('未知来源。', 'bad'); return }
  for (const f of src.files) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.exists ? f.label : `${f.label}（无文件）`
    sel.appendChild(o)
  }
  if (prevFile && src.files.some(f => f.id === prevFile)) sel.value = prevFile

  const parts = [`<b>${esc(src.label)}</b>`, `<span class="log-sub">${esc(src.note || '')}</span>`]
  parts.push(`<span class="mono log-sub">${esc(src.root || '（路径未解析）')}</span>`)
  if (!src.root) parts.push('<span class="pill bad">离线</span>')
  $('logStatus').innerHTML = parts.join(' ')
}

function setLogStatus(html, kind) {
  const el = $('logStatus')
  el.innerHTML = html
  el.className = 'log-status' + (kind ? ` ${kind}` : '')
}

/** 渲染分组后的日志（折叠 + 可展开原始行 + 中文解释 + 脱敏复制） */
function renderLogGroups(data) {
  const view = $('logView')
  const groups = data.groups || []
  const orderNote = data.order === 'asc' ? '最早在前' : '最新在前'
  if (!groups.length) {
    // 「文件为空」「筛选没命中」是两种不同的情况，必须分开说
    const why = data.total === 0
      ? '该日志文件当前没有任何内容（可能该来源还没运行过）。'
      : `文件共 ${data.total} 行，但当前筛选条件没有命中任何一行。`
    view.innerHTML =
      `<div class="empty">${esc(why)}</div>` +
      `<div class="card-note">可以放宽条件：把「时间范围」调回「全部时间」、清空关键词 / job_id，或点「清除筛选」。</div>`
    $('logNote').textContent = why
    return
  }

  const parts = [`<div class="log-order-note">时间顺序：${orderNote}　·　折叠只作用于 INFO/DEBUG，ERROR/WARNING 始终逐条显示</div>`]
  let prevBlank = false
  groups.forEach((g, gi) => {
    const shown = LOG_COLLAPSE && g.collapsed
    const lv = LOG_LEVEL_CLASS[g.level] || ''
    const lz = g.levelZh || { zh: g.level, tone: 'muted', note: '' }
    const blank = !String(g.message || '').trim()
    // 视觉上把连续空行压缩成一行（原文仍完整保留在 members 中，可展开查看）
    if (blank) {
      if (prevBlank) return
      prevBlank = true
      parts.push('<div class="log-blank"></div>')
      return
    }
    prevBlank = false
    const expl = g.explain

    if (shown) {
      parts.push(`
        <div class="log-group collapsed" data-g="${gi}">
          <div class="lg-head">
            <span class="pill muted" title="该消息连续出现 ${g.count} 次；展开可看到每一行原文">×${g.count}</span>
            <span class="log-time mono">${esc(fmtTs(g.firstTs))} → ${esc(fmtTs(g.lastTs))}</span>
            <span class="lg-msg">${esc(g.message)}</span>
            <button class="lg-toggle" data-toggle="${gi}">展开 ${g.count} 行</button>
          </div>
          <div class="lg-raw" hidden>${g.members.map(m => `<div class="log-line"><span class="log-time mono">${esc(fmtTs(m.ts))}</span><span class="log-msg">${esc(m.raw)}</span></div>`).join('')}</div>
        </div>`)
    } else {
      parts.push(`
        <div class="log-group" data-g="${gi}">
          <div class="log-line lv-${esc(g.level)}">
            <span class="log-time mono">${esc(fmtTs(g.firstTs))}</span>
            <span class="log-lv ${lv}" title="${esc(lz.note || '')}">${esc(g.level)}${lz.zh && lz.zh !== g.level ? ` · ${esc(lz.zh)}` : ''}</span>
            ${g.logger ? `<span class="log-logger mono">${esc(g.logger)}</span>` : ''}
            <span class="log-msg">${esc(g.message)}</span>
            <span class="lg-actions">
              <button class="lg-act" data-copy="${gi}" title="复制该行（自动脱敏）">复制</button>
            </span>
          </div>
          ${expl ? `<div class="log-explain${expl.known ? '' : ' unknown'}">${esc(expl.title)}${expl.advice ? ` · <span class="dim">${esc(expl.advice)}</span>` : ''}</div>` : ''}
        </div>`)
    }
  })
  view.innerHTML = parts.join('')
  $('logNote').textContent =
    `显示 ${data.shown} 行（命中 ${data.matched} / 共 ${data.total} 行，含折叠）· 文件更新于 ${fmtMtime(data.fileMtime)}` +
    (data.truncated ? ' · 已截取文件尾部' : '') +
    `　·　两个数量差 ${data.matched - data.shown} 行`
}

/** 级别分布（真实计数，用于确认 ERROR/WARNING 有多少条） */
function renderLevelSummary(counts) {
  const el = $('logLevelSummary')
  if (!el) return
  const c = counts || {}
  const bits = []
  for (const lv of ['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG', 'TRACE']) {
    if (c[lv]) bits.push(`<span class="pill ${LOG_LEVEL_CLASS[lv] || 'muted'}">${lv} ${c[lv]}</span>`)
  }
  el.innerHTML = bits.length ? bits.join(' ') : '<span class="log-sub">当前窗口内没有任何已识别级别的日志行</span>'
}

function renderStages(stages) {
  const card = $('logStagesCard')
  const list = stages || []
  if (!list.length) { card.style.display = 'none'; return }
  card.style.display = ''
  $('logStages').innerHTML = list.map(s => `
    <span class="stage-chip ${s.errors ? 'bad' : ''}">
      ${esc(s.stage)} <b>${s.lines}</b>${s.errors ? ` <span class="dim">· ${s.errors} 错误</span>` : ''}
    </span>`).join('')
}

/** 读取 外部工程 作业并渲染（制作轴 / 投递轴分开显示，绝不由 completed 推断已送达） */
async function loadExternalJobs() {
  const box = $('logJobs')
  const data = await window.hermes.coverJobs({ limit: 30 })
  if (!data || !data.ok) {
    $('logJobsCard').style.display = ''
    box.innerHTML = `<div class="empty">${esc((data && data.message) || '无法读取作业记录。')}</div>`
    return
  }
  $('logJobsCard').style.display = ''
  if (!data.jobs.length) { box.innerHTML = '<div class="empty">没有任何作业记录。</div>'; return }
  box.innerHTML = data.jobs.map(j => {
    const ax = j.axes || {}
    const prod = ax.production || { label: '制作状态未知', tone: 'muted' }
    const deliv = ax.delivery || { label: '投递状态未知', tone: 'muted', known: false }
    const meta = [
      j.createdAt ? `入队 ${esc(j.createdAt.slice(11, 19))}` : null,
      prod.detail ? esc(prod.detail) : null,
      typeof j.percent === 'number' ? `${j.percent}%` : null,
      j.song ? esc(j.song) : null,
      j.voice ? `音色 ${esc(j.voice)}` : null,
      typeof j.pitch === 'number' && j.pitch !== 0 ? `音高 ${j.pitch > 0 ? '+' : ''}${j.pitch} 半音` : null,
      j.f0Method ? `音高算法 ${esc(j.f0Method)}` : null
    ].filter(Boolean)
    const adv = j.svcOptions && Object.keys(j.svcOptions).length
      ? `<div class="job-meta dim">高级参数：${esc(Object.entries(j.svcOptions).map(([k, v]) => `${k}=${v}`).join('、'))}</div>`
      : ''
    const ab = j.abVariant
      ? `<span class="pill ${j.abVariant === 'tuned' ? 'warn' : 'muted'}" title="A/B 对比任务：两版分别保存，互不覆盖">${j.abVariant === 'tuned' ? '调音版' : '原版'}</span>`
      : ''
    const abNote = j.abPairOf
      ? `<div class="job-meta dim">对比原始任务 job_id：<span class="mono">${esc(j.abPairOf)}</span></div>`
      : ''
    return `
      <div class="job-row">
        <div class="job-head">
          <span class="mono job-id">${esc(j.jobId)}</span>
          ${ab}
          <span class="pill ${prod.tone}">制作：${esc(prod.label)}</span>
          <span class="pill ${deliv.tone}">投递：${esc(deliv.label)}</span>
          <span class="job-title">${esc(j.song || '（未记录歌名）')}${j.voice ? ` · ${esc(j.voice)}` : ''}</span>
          <span class="job-actions">
            <button class="lg-act" data-logjob="${esc(j.jobId)}" title="用该 job_id 过滤日志">看日志</button>
            ${j.outputPath ? `<button class="lg-act" data-openjob="${esc(j.outputPath)}" title="打开产物所在目录">产物</button>` : ''}
          </span>
        </div>
        <div class="job-meta">${meta.join(' ｜ ')}${j.error ? ` ｜ <span class="bad">失败：${esc(j.error)}</span>` : ''}</div>
        ${adv}
        ${abNote}
        ${!deliv.known ? '<div class="job-meta dim">投递状态在作业记录里没有该字段 → 显示「未知」，不做推测。</div>' : ''}
      </div>`
  }).join('')
}

/** 复制某组日志的**脱敏**载荷 */
async function copyLogGroup(gi) {
  if (!LOG_LAST || !LOG_LAST.groups || !LOG_LAST.groups[gi]) return
  const g = LOG_LAST.groups[gi]
  const rec = g.members && g.members.length ? g.members[g.members.length - 1] : null
  if (!rec) return
  const e = g.explain || { known: false, title: '暂无解释', advice: '' }
  const lz = g.levelZh || { zh: rec.level }
  const payload = [
    `[来源] ${LOG_LAST.sourceLabel}`,
    `[文件] ${LOG_LAST.fileLabel}`,
    rec.ts ? `[时间] ${rec.ts}` : '[时间] 无时间戳',
    `[级别] ${rec.level}（${lz.zh || rec.level}）`,
    `[说明] ${e.title}`,
    e.known && e.advice ? `[建议] ${e.advice}` : '',
    '[原文]',
    rec.raw
  ].filter(Boolean).join('\n')
  const r = await window.hermes.copyRedacted(payload)
  toast(r && r.ok ? '已复制（已脱敏）' : '复制失败', r && r.ok ? 'ok' : 'bad')
}

/** 时间范围 → 传给主进程的分钟数（'all' → 不传） */
function currentRangeMinutes() {
  if (LOG_RANGE === '10m') return 10
  if (LOG_RANGE === '1h') return 60
  if (LOG_RANGE === '6h') return 360
  return null
}

/** 更新「时间范围」按钮的选中态与提示文案 */
function renderRangeNote() {
  const seg = $('logRangeSeg')
  if (seg) {
    for (const b of seg.querySelectorAll('.seg-btn')) {
      b.classList.toggle('on', b.dataset.range === LOG_RANGE)
    }
  }
  const note = $('logRangeNote')
  if (!note) return
  if (LOG_RANGE === 'all') { note.textContent = '时间范围：全部'; return }
  const mins = currentRangeMinutes()
  const refMs = LOG_LAST && LOG_LAST.latestTs ? Number(LOG_LAST.latestTs) : null
  const ref = refMs
    ? `以日志最新时间为参考：${fmtMtime(new Date(refMs).toISOString())}`
    : '（尚未读到日志，参考时间待定）'
  note.textContent = `时间范围：最近 ${mins >= 60 ? mins / 60 + ' 小时' : mins + ' 分钟'}　${ref}`
}

async function loadLogs() {
  const opts = {
    source: $('logSource').value,
    file: $('logFile').value,
    lines: 500,
    minRepeat: 3,
    order: LOG_ORDER
  }
  const mins = currentRangeMinutes()
  if (mins) opts.withinMinutes = mins
  if ($('logLevel').value) opts.minLevel = $('logLevel').value
  const kw = $('logSearch').value.trim(); if (kw) opts.search = kw
  const jid = $('logJobId').value.trim(); if (jid) opts.jobId = jid
  const since = $('logSince').value.trim(); if (since) opts.since = since
  const until = $('logUntil').value.trim(); if (until) opts.until = until

  const data = await window.hermes.readLogs(opts)
  LOG_LAST = data

  if (!data || !data.ok) {
    // 四种失败必须分开显示：离线 / 读取失败 / 参数无效 / 其它
    const reason = data && data.reason
    const label = reason === 'offline' ? '离线'
      : reason === 'read-failed' ? '读取失败'
        : reason === 'unknown-source' || reason === 'unknown-file' ? '参数无效' : '不可用'
    setLogStatus(`<span class="pill bad">${label}</span> ${esc((data && data.message) || '未知原因')}` +
      (data && data.path ? ` <span class="mono log-sub">${esc(data.path)}</span>` : ''), 'bad')
    $('logView').innerHTML = `<div class="empty">${esc((data && data.message) || '无法读取日志。')}</div>`
    $('logNote').textContent = '—'
    $('logStagesCard').style.display = 'none'
    renderLevelSummary(null)
    if (reason === 'offline') {
      $('logView').innerHTML += '<div class="card-note">文件不存在通常表示该来源还没运行过，或路径已变化。'
        + '这不代表读取出错，也不代表日志被删除。</div>'
    }
    return
  }

  setLogStatus([
    `<b>${esc(data.sourceLabel)}</b> · <span class="mono">${esc(data.fileLabel)}</span>`,
    `<span class="log-sub">路径 <span class="mono">${esc(data.path)}</span></span>`,
    `<span class="log-sub">更新于 ${esc(fmtMtime(data.fileMtime))} · ${esc(fmtBytes(data.fileSize))}</span>`,
    data.truncated ? '<span class="pill warn">仅显示尾部</span>' : '',
    `<span class="log-sub">命中 ${data.matched} / 共 ${data.total} 行</span>`
  ].filter(Boolean).join(' '))

  renderLogGroups(data)
  renderStages(data.stages)
  renderLevelSummary(data.levelCounts)
  renderRangeNote()
}

// ---------------------------------------------------------------- 刷新
/** 重新拉取主进程 bootstrap（含按 Profile 的所有权登记），用于启动/停止后刷新界面 */
async function reloadBootstrap() {
  try {
    const b = await window.hermes.bootstrap()
    if (b) BOOT = b
  } catch (err) {
    console.warn('[debug] 重载 bootstrap 失败: ' + err.message)
  }
}

async function refreshAll(showToast) {
  if (!BOOT || BOOT.backendState !== 'ready') {
    console.warn('[debug] 跳过刷新：控制台后端未就绪')
    return false
  }
  await reloadBootstrap()   // ★ 刷新主进程 bootstrap（含 OS 核验的网关运行态与带存活的所有权）→ BOOT 始终最新
  try {
    // 使用 allSettled：单个接口失败不应让整页空白（例如某端点尚未实现）
    const [statusR, metaR, modelR, platR, skillsR] = await Promise.allSettled([
      apiGet('/api/status'),
      window.hermes.gatewayMeta(),
      apiGet('/api/model/info'),
      apiGet('/api/messaging/platforms'),
      apiGet('/api/skills')
    ])
    const pick = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback)
    const failed = [statusR, metaR, modelR, platR, skillsR].filter(r => r.status === 'rejected')
    if (failed.length) {
      console.warn('[debug] 部分接口失败: ' + failed.map(f => String(f.reason && f.reason.message)).join(' | '))
    }

    const status = pick(statusR, null)
    if (!status) {
      // /api/status 是核心，失败必须明确告知
      const reason = statusR.status === 'rejected' ? (statusR.reason && statusR.reason.message) : '空响应'
      throw new Error(`/api/status 读取失败：${reason}`)
    }
    const meta = pick(metaR, null)
    const platforms = pick(platR, null)
    const skills = pick(skillsR, [])

    STATUS_CACHE = status
    SKILLS_CACHE = Array.isArray(skills) ? skills : []
    renderGateway(status, meta)
    renderFeishu(status, platforms)
    renderAuth()          // 先用缓存渲染，避免空白；随后 loadAuth() 拉真实值
    renderAgent(status)
    renderSkills(skills)
    renderPlatforms(platforms)
    renderStats(status, skills)
    renderActivity(status, skills, platforms)
    renderSettings()
    renderProfileOwnership()      // 按 Profile 展示所有权 + 停止按钮可用性（用最新 BOOT）
    // 能力探测较慢（含一次只读进程查询），独立进行，不阻塞上面的核心数据渲染
    loadCapabilities()
    // 认证状态按 Profile 独立查询（含官方只读 CLI 调用，较慢 → 不阻塞核心渲染）
    // 拿到结果后会自行 renderAuth() + checkAuth()（有可靠依据才弹窗，同故障去重）
    const authP = loadAuth(false)

    // 异常提示（先用现有数据；认证结果到达后 updateProblemBadge 会再刷新一次）
    const problems = collectProblems(status)
    updateProblemBadge()

    if (showToast) toast(problems.length ? `已刷新 · 注意：${problems.join('、')}` : '已刷新，系统运行正常', problems.length ? 'warn' : 'ok')
    authP.catch(() => {})
    return true
  } catch (err) {
    console.error(`刷新失败: ${err.message}`)
    $('greetSub').textContent = `数据读取失败：${err.message}`
    toast(`刷新失败：${err.message}`, 'bad', 6000)
    return false
  }
}

// ---------------------------------------------------------------- 导航
function switchPage(name) {
  if (window.HERMES_DEBUG) console.warn(`[debug] switchPage -> ${name}`)
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`))
  $('mainArea').scrollTop = 0
  if (name === 'logs' && !LOG_LAST) {
    loadLogSources(true)
      .then(() => loadExternalJobs())
      .catch(e => toast(`日志来源读取失败：${e.message}`, 'bad', 6000))
  }
  if (name === 'capabilities') loadCapabilities()
}

// ---------------------------------------------------------------- 事件绑定
function bind() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page))
  })
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.goto))
  })

  document.querySelectorAll('[data-win]').forEach(btn => {
    btn.addEventListener('click', () => window.hermes.windowControl(btn.dataset.win))
  })

  $('notifyBadge').parentElement.addEventListener('click', () => {
    const problems = []
    if (STATUS_CACHE) {
      if (!gwRunningDefault()) problems.push('网关未运行')
      if (STATUS_CACHE.nous_session_valid === 'terminal') problems.push('模型认证失效（需重新登录 Nous）')
      if (((STATUS_CACHE.gateway_platforms || {}).feishu || {}).state !== 'connected') problems.push('飞书未连接')
    }
    toast(problems.length ? `当前异常：${problems.join('；')}` : '当前没有检测到异常', problems.length ? 'warn' : 'ok', 6000)
  })

  $('avatarBtn').addEventListener('click', () => {
    toast(`本机实例 · HERMES_HOME=${BOOT ? BOOT.hermesHome : '—'}`, 'info', 6000)
  })

  $('btnGwStop').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    if (!confirm('确认停止 Hermes 网关？飞书机器人将停止响应。')) return
    const ok = await doGatewayAction('stop', '停止网关', { profileId: 'default' })
    if (ok) { await reloadBootstrap(); await refreshAll() }
  }))

  $('btnGwRestart').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    if (!confirm('确认重启 Hermes 网关？')) return
    const ok = await doGatewayAction('restart', '重启网关')
    if (ok) await refreshAll()
  }))

  $('btnFsDetail').addEventListener('click', () => switchPage('feishu'))
  $('btnModelDetail').addEventListener('click', () => switchPage('model'))

  document.querySelectorAll('[data-shortcut]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.shortcut
      if (k === 'logs') switchPage('logs')
      else if (k === 'settings') switchPage('settings')
      else if (k === 'external' || k === 'profile') switchPage('capabilities')
    })
  })

  $('btnLogLoad').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    try { await loadLogs(); toast('日志已刷新', 'ok', 2200) } catch (err) { toast(`日志读取失败：${err.message}`, 'bad', 6000) }
  }))

  // ---- 日志页：来源切换 / 筛选 / 折叠 / 脱敏复制 / 任务关联 ----
  $('logSource').addEventListener('change', e => withBusy(e.currentTarget, async () => {
    try {
      await loadLogSources(false)
      $('logView').innerHTML = '已切换来源，点击「读取」查看。'
      $('logNote').textContent = '—'
      $('logStagesCard').style.display = 'none'
      setLogStatus('已切换来源，点击「读取」查看该来源的真实日志。')
      LOG_LAST = null
    } catch (err) { toast(`来源清单读取失败：${err.message}`, 'bad', 6000) }
  }))

  $('btnLogIssues').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    // 「只看问题」：级别提到 WARNING，并把时间范围放宽到全部（避免"看不到问题"其实是被时窗挡住）
    $('logLevel').value = 'WARNING'
    if (LOG_RANGE !== 'all') { LOG_RANGE = 'all'; renderRangeNote() }
    try {
      await loadLogs()
      const c = (LOG_LAST && LOG_LAST.levelCounts) || {}
      const bad = (c.ERROR || 0) + (c.CRITICAL || 0)
      const warn = c.WARNING || 0
      toast(bad + warn === 0
        ? '当前日志里没有 ERROR / WARNING'
        : `只看问题：ERROR ${bad} 条 · WARNING ${warn} 条（均未被折叠）`, bad ? 'warn' : 'info', 4200)
    } catch (err) { toast(err.message, 'bad', 6000) }
  }))

  // 时间范围快捷筛选（最近 10 分钟 / 1 小时 / 6 小时 / 全部）
  $('logRangeSeg').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    const b = e.target.closest('.seg-btn')
    if (!b) return
    LOG_RANGE = b.dataset.range || 'all'
    renderRangeNote()
    try { await loadLogs() } catch (err) { toast(`读取失败：${err.message}`, 'bad', 6000) }
  }))

  $('logOrder').addEventListener('change', async () => {
    LOG_ORDER = $('logOrder').value === 'asc' ? 'asc' : 'desc'
    try { await loadLogs() } catch (err) { toast(`读取失败：${err.message}`, 'bad', 6000) }
  })

  $('btnLogClear').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    $('logLevel').value = ''
    $('logSearch').value = ''
    $('logJobId').value = ''
    $('logSince').value = ''
    $('logUntil').value = ''
    LOG_RANGE = 'all'
    renderRangeNote()
    try { await loadLogs(); toast('筛选已清除', 'ok', 2200) } catch (err) { toast(err.message, 'bad', 6000) }
  }))

  for (const id of ['logLevel', 'logSearch', 'logJobId', 'logSince', 'logUntil']) {
    const el = $(id)
    if (el) el.addEventListener('change', () => { loadLogs().catch(err => toast(err.message, 'bad', 6000)) })
  }

  $('btnLogCollapse').addEventListener('click', () => {
    LOG_COLLAPSE = !LOG_COLLAPSE
    if (LOG_LAST && LOG_LAST.ok) renderLogGroups(LOG_LAST)
    toast(LOG_COLLAPSE ? '已折叠高频重复行（ERROR/WARNING 不受影响）' : '已展开全部重复行', 'info', 2600)
  })

  $('btnLogJobsRefresh').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    try { await loadExternalJobs(); toast('作业列表已刷新', 'ok', 2200) } catch (err) { toast(`作业读取失败：${err.message}`, 'bad', 6000) }
  }))

  $('btnLogOpenFolder').addEventListener('click', async () => {
    const src = LOG_SOURCES_CACHE && (LOG_SOURCES_CACHE.sources || []).find(s => s.id === $('logSource').value)
    if (!src || !src.root) return toast('该来源的日志目录不可用。', 'warn', 4000)
    const r = await window.hermes.openPath(src.root)
    if (!r || !r.ok) toast('无法打开目录（不在允许范围内）。', 'warn', 4000)
  })

  // 日志内容区的委托事件：展开重复组 / 复制单行（脱敏）
  $('logView').addEventListener('click', async ev => {
    const t = ev.target.closest('[data-toggle]')
    if (t) {
      const box = t.closest('.log-group').querySelector('.lg-raw')
      const open = !box.hidden
      box.hidden = open
      t.textContent = open ? `展开 ${t.textContent.replace(/\D/g, '')} 行` : '收起'
      return
    }
    const c = ev.target.closest('[data-copy]')
    if (c) await copyLogGroup(Number(c.dataset.copy))
  })

  // 作业列表：按 job_id 过滤日志 / 打开产物目录
  $('logJobs').addEventListener('click', async ev => {
    const j = ev.target.closest('[data-logjob]')
    if (j) {
      $('logJobId').value = j.dataset.logjob
      // 关联 job 时先清掉其它筛选条件（尤其时间范围），否则很可能"看不到"其实是筛掉了
      $('logLevel').value = ''
      $('logSearch').value = ''
      $('logSince').value = ''
      $('logUntil').value = ''
      $('logOrder').value = 'asc'
      LOG_ORDER = 'asc'
      LOG_RANGE = 'all'
      renderRangeNote()
      if ($('logSource').value !== 'external') { $('logSource').value = 'external'; await loadLogSources(false) }
      $('logFile').value = 'pipeline'
      try {
        await loadLogs()
        const n = (LOG_LAST && LOG_LAST.matched) || 0
        toast(n
          ? `已按 job_id ${j.dataset.logjob} 找到 ${n} 行日志（最早在前）`
          : `日志里没有出现 job_id ${j.dataset.logjob}（该文件的记录范围可能不含这段时间）`,
          n ? 'info' : 'warn', n ? 3000 : 5200)
      } catch (err) { toast(err.message, 'bad', 5000) }
      return
    }
    const o = ev.target.closest('[data-openjob]')
    if (o) {
      const p = o.dataset.openjob
      const dir = p.replace(/[\\/][^\\/]*$/, '')
      const r = await window.hermes.openPath(dir)
      if (!r || !r.ok) toast('无法打开产物目录（不在允许范围内）。', 'warn', 4000)
    }
  })

  $('skillFilter').addEventListener('input', () => { if (window.__skillsCache) renderSkills(window.__skillsCache) })

  $('btnGwAdopt').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    if (!confirm('「启动并接管」会：\n· 在当前没有网关运行时启动一个新网关\n· 本控制台持有该实例（A）\n· ' +
      (autoStopEnabled()
        ? '关闭控制台时会重新核验身份后停止它'
        : '关闭控制台【不会】自动停止它（自动停止当前已禁用）') +
      '\n\n如果已有网关在运行，本操作会被拒绝（不会接管共享实例）。\n\n确认继续？')) return
    const res = await window.hermes.gatewayAdopt()
    if (res && res.ok) {
      toast(`已取得所有权：pid=${res.instance.pid}`, 'ok', 6000)
    } else {
      toast(`接管失败：${(res && (res.message || res.reason)) || '未知原因'}`, 'warn', 9000)
    }
    BOOT = await window.hermes.bootstrap()
    renderSettings()
    await refreshAll()
  }))

  $('btnGwRelease').addEventListener('click', async () => {
    if (!confirm('释放所有权？\n\n释放后本控制台不再持有该网关，关闭控制台时也不会停止它（网关继续运行）。')) return
    const res = await window.hermes.gatewayRelease()
    BOOT = await window.hermes.bootstrap()
    renderSettings(); renderGateway(STATUS_CACHE || { gateway_running: false }, null)
    toast(res && res.ok ? '已释放所有权（网关未停止）' : '释放失败', res && res.ok ? 'ok' : 'bad')
  })

  $('btnOpenLogs').addEventListener('click', () => window.hermes.openLogsFolder())

  // 扩展能力：固定目录入口（主进程侧只接受 'external' / 'profile'，不接受任意路径）
  if ($('btnAcOpen')) $('btnAcOpen').addEventListener('click', async () => {
    const r = await window.hermes.openCapability('external')
    toast(r && r.ok ? '已打开 外部工程 项目目录' : '无法打开：未找到 外部工程 目录', r && r.ok ? 'ok' : 'warn')
  })
  if ($('btnCjOpen')) $('btnCjOpen').addEventListener('click', async () => {
    const r = await window.hermes.openCapability('profile')
    toast(r && r.ok ? '已打开额外 Profile 目录' : '无法打开：未找到额外 Profile 目录', r && r.ok ? 'ok' : 'warn')
  })

  // ---- 按 Profile 手动启动 Gateway（本轮唯一保留的写操作）----
  const doStartProfile = async (btn, id, label) => {
    await withBusy(btn, async () => {
      if (!confirm(`启动 ${label} 的 Gateway？\n\n` +
        `· 只启动该 Profile 的网关，不影响另一个 Profile\n` +
        `· 启动前实测核实：Profile 目录 / 配置文件 / 记录 PID 是否仍存活 / 锁是否被持有\n` +
        `· 已运行则不会重复启动；不使用 --replace，也不强制终止任何进程\n` +
        `· 若记录是过期的：控制台不据此拒绝，但**不承诺一定启动成功**，以实际结果为准\n` +
        `· 若官方报 PID file race lost：控制台不自动重试、不删除状态文件，只给安全恢复提示\n\n确认继续？`)) return
      const r = await window.hermes.startProfile(id)
      if (r && r.ok) toast(r.message || `${label} 已启动`, 'ok', 7000)
      else if (r && r.reason === 'pid-file-race-lost') toast(r.message, 'warn', 22000)
      else toast(`启动未成功：${(r && r.message) || '未知原因'}`, 'warn', 11000)
      await reloadBootstrap()         // 重新读取主进程所有权（登记后生效）
      await loadCapabilities()
      await refreshAll()
    })
  }
  if ($('btnStartDefault')) $('btnStartDefault').addEventListener('click', e => doStartProfile(e.currentTarget, 'default', 'default'))
  if ($('btnStartProfile2')) $('btnStartProfile2').addEventListener('click', e => doStartProfile(e.currentTarget, extraProfileId(), '额外 Profile'))

  // ---- 按 Profile 停止（仅 A 态，复用 doGatewayAction 的授权门 + 复核）----
  const doStopProfile = async (btn, id, label) => {
    await withBusy(btn, async () => {
      if (!confirm(`停止 ${label} 的 Gateway？\n\n` +
        `· 仅本控制台启动并持有的实例（A 态）可被停止\n` +
        `· 执行前主进程会重新核验身份（同 profile 单实例 + OS 进程核对）；身份已变化则拒绝\n` +
        `· 共享实例（B 态）不在本控制台控制范围内`)) return
      const ok = await doGatewayAction('stop', `停止 ${label}`, { profileId: id })
      if (ok) { await reloadBootstrap(); await refreshAll() }
    })
  }
  if ($('btnStopDefault')) $('btnStopDefault').addEventListener('click', e => doStopProfile(e.currentTarget, 'default', 'default'))
  if ($('btnStopProfile2')) $('btnStopProfile2').addEventListener('click', e => doStopProfile(e.currentTarget, extraProfileId(), '额外 Profile'))

  // ---- 退出提示（严格模式）：× 触发的 ui:exit-request ----
  window.hermes.on('ui:exit-request', payload => showExitModal(payload))
  if ($('btnExitCancel')) $('btnExitCancel').addEventListener('click', async () => {
    hideExitModal()
    await window.hermes.exitDecision('cancel')
  })
  if ($('btnExitOnly')) $('btnExitOnly').addEventListener('click', async () => {
    hideExitModal()
    await window.hermes.exitDecision('exit-only')
  })

  // ---- 模型认证（按 Profile）：开始认证 / 重新检测 / 取消 / 复制 ----
  if ($('btnAuthRefresh')) $('btnAuthRefresh').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    await loadAuth(true)
    const bad = (AUTH_PROFILES || []).filter(p => p.expired).length
    toast(bad ? `重新检测完成：${bad} 个 Profile 的认证仍失效` : '重新检测完成：未发现认证失效', bad ? 'warn' : 'ok')
  }))

  if ($('btnAuthStart')) $('btnAuthStart').addEventListener('click', async e => {
    const btn = e.currentTarget
    if (btn.disabled) return
    const id = AUTH_MODAL_PROFILE
    if (!id) return
    btn.disabled = true                       // 重复点击保护
    authFeedback('正在打开独立终端…（控制台不参与授权过程）', 'ok')
    try {
      const r = await window.hermes.authStart(id)
      if (r && r.ok) {
        authFeedback(`${r.message}`, 'ok')
        toast('已打开独立终端，请在终端中完成官方授权', 'info', 9000)
      } else {
        authFeedback(`未能打开认证终端：${(r && r.message) || '未知原因'}`, 'bad')
      }
    } catch (err) {
      authFeedback(`打开认证终端失败：${err.message}`, 'bad')
    } finally {
      // 只有失败才立刻恢复按钮；成功后也恢复，但用短冷却避免连点
      setTimeout(() => { btn.disabled = !(AUTH_PROFILES || []).find(p => p.id === id)?.officialCommand }, 2500)
    }
  })

  if ($('btnAuthRecheck')) $('btnAuthRecheck').addEventListener('click', async e => {
    const btn = e.currentTarget
    const id = AUTH_MODAL_PROFILE
    btn.disabled = true
    authFeedback('正在重新查询官方认证状态…', 'ok')
    try {
      await loadAuth(true)
      const p = (AUTH_PROFILES || []).find(x => x.id === id)
      if (!p) { authFeedback('未找到该 Profile 的认证信息。', 'bad'); return }
      fillAuthModal(p)
      if (p.state === 'valid') {
        // 只有**官方**明确判定已登录才算成功
        authFeedback(`官方已确认登录：${p.providerLabel}（${p.provider}）。认证有效 ≠ 模型可调用，如需确认请做一次真实推理。`, 'ok')
        toast('认证已恢复（官方状态确认）', 'ok')
      } else if (p.state === 'expired') {
        authFeedback(`官方仍判定为未登录：${p.reason}。请确认已在该终端中完成授权。`, 'bad')
      } else {
        authFeedback(`无法确认认证结果（未验证）：${p.reason}`, 'bad')
      }
    } finally { btn.disabled = false }
  })

  if ($('btnAuthCancel')) $('btnAuthCancel').addEventListener('click', () => hideAuthModal())
  if ($('btnAuthCopy')) $('btnAuthCopy').addEventListener('click', async () => {
    const r = await window.hermes.copy($('authCmd').textContent)
    toast(r && r.ok ? '已复制官方命令' : '请手动选中命令复制', r && r.ok ? 'ok' : 'info')
  })

  // ---- 「模型与认证」页认证卡片（动态渲染，用委托绑定）----
  if ($('authProfileCards')) $('authProfileCards').addEventListener('click', async e => {
    const openBtn = e.target.closest('[data-auth-open]')
    if (openBtn) { switchPage('model'); openAuthModal(openBtn.dataset.authOpen); return }
    const recheckBtn = e.target.closest('[data-auth-recheck]')
    if (recheckBtn) {
      const id = recheckBtn.dataset.authRecheck
      recheckBtn.disabled = true
      try { await loadAuth(true) } finally { recheckBtn.disabled = false }
      const p = (AUTH_PROFILES || []).find(x => x.id === id)
      toast(p ? `${p.label}：${authText(p.state)}（官方查询）` : '未能读取该 Profile 的认证状态',
        p && p.expired ? 'warn' : 'info', 6000)
      return
    }
    const copyBtn = e.target.closest('[data-auth-copy]')
    if (copyBtn) {
      const r = await window.hermes.copy(copyBtn.dataset.authCopy)
      toast(r && r.ok ? '已复制官方命令' : '请手动选中命令复制', r && r.ok ? 'ok' : 'info')
    }
  })
  $('btnRestartBackend').addEventListener('click', e => withBusy(e.currentTarget, async () => {
    BOOT = await window.hermes.restartBackend()
    toast('正在重启控制台后端…', 'info')
    setTimeout(() => refreshAll(true), 4500)
  }))

  $('searchInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    const q = e.target.value.trim()
    if (!q) return
    for (const b of document.querySelectorAll('.nav-item')) {
      if (b.textContent.includes(q)) { switchPage(b.dataset.page); toast(`已定位到「${b.textContent.trim()}」`, 'info', 2500); return }
    }
    $('logSearch').value = q
    switchPage('logs')
    loadLogs().then(() => toast(`已在日志中搜索「${q}」`, 'info', 3000)).catch(() => {})
  })
}

// ---------------------------------------------------------------- 启动
async function boot() {
  bind()
  tickClock()
  setInterval(tickClock, 1000)

  // 日志来源清单不依赖后端（直接读盘），提前填充「文件」下拉
  loadLogSources(true).catch(() => {})

  BOOT = await window.hermes.bootstrap()
  renderSettings()

  window.hermes.on('backend:state', info => {
    BOOT = info
    renderSettings()
    if (info.backendState === 'ready') { refreshAll(); }
  })

  const waitReady = async (tries = 40) => {
    for (let i = 0; i < tries; i++) {
      BOOT = await window.hermes.bootstrap()
      if (BOOT.backendState === 'ready') return true
      if (BOOT.backendState === 'failed') return false
      await new Promise(r => setTimeout(r, 500))
    }
    return false
  }

  const ready = await waitReady()
  if (!ready) {
    const msg = (BOOT && BOOT.backendError) || '控制台后端启动失败'
    $('greetSub').textContent = `后端未就绪：${msg}`
    toast(msg, 'bad', 12000)
    updateGatewayControls()
    return
  }

  // 首次加载：有限次数自动重试（最多 4 次，间隔 3 秒；不无限等待）
  let ok = false
  for (let i = 0; i < 4 && !ok; i++) {
    ok = await refreshAll()
    if (!ok) {
      $('greetSub').textContent = i === 0 ? '正在重试读取…' : `读取失败，正在重试（${i}/3）…`
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  if (ok) {
    $('greetSub').textContent = 'Hermes 正在为你工作，当前系统运行状态如下。'
  } else {
    $('greetSub').textContent = '多次读取失败。请确认 Hermes 可用，或在「设置」中重启控制台后端。'
    toast('首次数据读取多次失败，已停止重试（不会无限等待）', 'bad', 9000)
  }
  updateGatewayControls()
  REFRESH_TIMER = setInterval(() => refreshAll(false), 20000)
}

window.addEventListener('DOMContentLoaded', boot)
