/**
 * Hermes 桌面控制台 — 所有权 / 授权 / 停止前置核验（纯逻辑模块）
 *
 * 设计目的：
 *   1. 判定逻辑可**脱离 Electron 被自动化测试**（测试桩注入文件系统与进程探测）
 *   2. **主进程与看门狗共用同一套规则** —— 不允许任何一方复制一份更宽松的实现
 *
 * 本模块不做任何进程操作、不读凭据、不写外部日志；
 * 所有副作用（读状态文件 / 查进程）都由调用方以依赖注入方式提供。
 *
 * ─────────────────────────── 身份字段要求（明确且一致）───────────────────────────
 * 必需字段（**双方都必须存在且有效**，任一缺失即不可比 → 一律拒绝）：
 *   pid         正整数
 *   startMs     有效启动时间（epoch 毫秒，落在合理年份区间）
 *   hermesHome  非空字符串（比较时忽略大小写与尾部斜杠）
 * 强一致字段（**双方都提供时必须相等**）：
 *   argvHash    启动参数指纹
 *   kind        实例类型标记
 *
 * ★ 唯一实现原则：本模块内**只有 compareIdentity() 一个身份比较实现**，
 *   sameIdentity()（同源、精确）与 targetMatches()（跨来源、容差）都只是它的薄封装。
 *   禁止任何调用方另写一份字段更少的比较 —— 历史缺陷 targetMatches() 漏比 hermesHome
 *   就是这样产生的（见该函数注释）。
 *
 * 关于 hermesHome 取值来源：readIdentity() 优先采用状态文件里的 hermes_home，
 * 两者都没有时才退回调用方传入的 HERMES_HOME。这意味着「两份文件都缺 hermes_home」
 * 时，同一实例的前后两次读取可能得到不同来源的值 → 被判为不同实例 → **拒绝操作**。
 * 这是有意的 fail-closed 选择（宁可拒绝，不可误停）。
 * 实测本机 gateway_state.json 与 gateway.pid 均含 hermes_home = D:\<hermes-home>，不受影响。
 *
 * 依据：PID 会被操作系统复用，仅凭 PID 判定所有权会导致
 * 「网关退出 → PID 被无关进程复用」时误判并误停。
 * 因此**启动时间缺失即拒绝**，而不是"缺失就跳过校验"。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 必需身份字段 */
const REQUIRED_IDENTITY_FIELDS = ['pid', 'startMs', 'hermesHome']
/** 双方都提供时必须一致的字段 */
const MATCH_IF_PRESENT_FIELDS = ['argvHash', 'kind']
/**
 * 启动时间容差（毫秒）。
 * 仅用于「状态文件记录时间」与「操作系统进程创建时间」两个**不同来源**的比较
 * —— 两者取样路径不同，允许毫秒级偏差。
 * 同源比较（两条都来自状态文件）使用精确相等。
 */
const START_TOLERANCE_MS = 3000

const DANGEROUS_ACTIONS = ['stop', 'restart', 'drain']

// ──────────────────────────────────────────────────────────── 基础工具

/**
 * 归一化 start_time。
 * 实测 Hermes 写的是 epoch_seconds*100（形如 178972155710），
 * 但不猜格式：按常见量级试探，取第一个落在合理年份区间的结果。
 * @returns {number|null} epoch 毫秒；无法解析返回 null
 */
function toStartMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  for (const div of [1, 100, 1000, 1e6]) {
    const d = new Date((raw / div) * 1000)
    const y = d.getFullYear()
    if (y >= 2020 && y <= 2100) return d.getTime()
  }
  return null
}

/**
 * 归一化主目录路径，用于比较。
 *
 * · Windows 上 `/` 与 `\` 指向同一位置 → 统一成 `\`（否则
 *   `D:\<hermes-home>` 与 `D:/<hermes-home>` 会被判成不同 profile 而误报实例变化）
 *   ⚠️ 仅在 win32 下做此转换：POSIX 上反斜杠是合法的文件名字符，
 *      把它当成分隔符会错误地把两个不同目录判为同一个。
 * · 去掉尾部斜杠；大小写不敏感（Windows 文件系统语义）。
 */
function normHome(p) {
  let s = String(p).trim()
  if (process.platform === 'win32') s = s.replace(/\//g, '\\')
  return s.replace(/[\\/]+$/, '').toLowerCase()
}

/** 默认 realpath 实现（优先原生版本，性能更好）；异常交由调用方处理 */
function defaultRealpath (p) {
  const native = fs.realpathSync && fs.realpathSync.native
  return native ? native(p) : fs.realpathSync(p)
}

/**
 * 解析目录的**真实路径**（Windows 上会解析符号链接 / junction），并归一化。
 *
 * @param {string} p
 * @param {{realpath?:function}} [opts]
 * @returns {string|null} 归一化后的真实路径；**无法解析时返回 null**（调用方必须据此拒绝，不得猜测）
 */
function homeRealpath (p, opts = {}) {
  if (!p || typeof p !== 'string') return null
  const rp = typeof opts.realpath === 'function' ? opts.realpath : defaultRealpath
  try {
    const r = rp(p)
    return r ? normHome(r) : null
  } catch (e) {
    return null
  }
}

/**
 * 判断两个目录是否**指向同一个真实目录**（本模块**唯一**的目录身份比较实现）。
 *
 * ★ 为什么需要（2026-09-22 实测硬证据）：
 *   `%LOCALAPPDATA%\hermes`（即 `C:\Users\<u>\AppData\Local\hermes`）是**符号链接**
 *   （`lstat` 确认为 SymbolicLink），真实路径是 `D:\<hermes-home>`。
 *   控制台的 `PROFILES.default.home` 取自 `HERMES_HOME`（符号链接写法），
 *   而官方状态文件里的 `hermes_home` 写的是 **resolve 后**的真实路径
 *   ⇒ 纯字符串比较（normHome）把**同一个目录**判成两个目录，导致
 *     `verifyProfileIdentity` 返回 `profile-mismatch`（PID 4780 实例）；
 *     同一根因还波及身份比较、记录迁移、Profile 反查、"是否本控制台持有"判定。
 *
 * ★ 规则（**两侧都要守住**：既不把同一目录误判为不同，也绝不把不同目录误判为相同）：
 *   ① 归一化字符串**严格相同** → 同一目录（确定性事实，无需解析）；
 *   ② 字符串不同 → 必须由 realpath **证明**等价；
 *      **任一侧解析失败 → 判为不同**（fail-closed：解析失败即拒绝，绝不猜测两个目录相同）；
 *   ③ **不做跨调用缓存** —— 授权前的核验必须**当场**解析，
 *      不得依赖可能过期的缓存（单次 realpath 为系统调用，开销可忽略）。
 *
 * ⚠️ 本函数**只用于比较**：身份里保存的 `hermesHome` 仍存**原始值**，
 *    绝不能被 realpath 结果改写（否则会改变身份语义与落盘内容）。
 *
 * @param {string} a
 * @param {string} b
 * @param {{realpath?:function}} [opts] 注入 realpath 以便单测（保持纯函数可测性）
 * @returns {boolean}
 */
function sameHome (a, b, opts = {}) {
  if (!a || !b) return false
  const na = normHome(a)
  const nb = normHome(b)
  if (na === nb) return true                     // ① 字符串严格相同
  const ra = homeRealpath(a, opts)
  const rb = homeRealpath(b, opts)
  if (ra !== null && ra === nb) return true       // a 的真实路径 == b 的字面路径
  if (rb !== null && rb === na) return true       // b 的真实路径 == a 的字面路径
  if (ra === null || rb === null) return false    // ② 解析失败 → 判为不同（不猜测）
  return ra === rb
}

/**
 * 校验一个身份是否**完整有效**（不是"有没有值"，而是"值能不能用"）。
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateIdentity(id) {
  if (!id || typeof id !== 'object') return { ok: false, errors: ['not-an-object'] }
  const errors = []
  if (typeof id.pid !== 'number' || !Number.isInteger(id.pid) || id.pid <= 0) errors.push('pid')
  if (typeof id.startMs !== 'number' || !Number.isFinite(id.startMs) || id.startMs <= 0) errors.push('startMs')
  if (typeof id.hermesHome !== 'string' || !id.hermesHome.trim()) errors.push('hermesHome')
  return { ok: errors.length === 0, errors }
}

/**
 * 两个身份是否指向同一个实例 —— **全模块唯一的身份比较实现**。
 *
 * 之所以要"唯一"：同一套字段规则被三处使用（所有权核验、授权目标绑定、陈旧记录判定）。
 * 若各处各写一份，就会出现"某处漏比某个字段"的不一致 —— 这正是安全复审问题一：
 *   targetMatches() 曾只比 pid + startMs，**完全没比 hermesHome**，
 *   于是「同 PID、同启动时间、不同主目录」被判为同一实例。
 *
 * 必需字段（双方都必须完整有效，任一缺失即 false）：
 *   pid / startMs / hermesHome
 * 双方都提供时必须一致：
 *   argvHash / kind
 *
 * 与更早版本的另一个区别：
 *   旧: if (a.startMs && b.startMs && a.startMs !== b.startMs) return false
 *       → 一方缺 startMs 时**跳过校验**，仅 PID 相同即返回 true。
 *   新: 任一方的必需字段缺失/无效 → 直接 false（fail-closed）。
 *
 * @param {object} a
 * @param {object} b
 * @param {{startToleranceMs?:number}} opts
 *   startToleranceMs=0（默认）→ 启动时间必须**精确相等**（同源比较）
 *   startToleranceMs>0        → 允许毫秒级容差，仅供**不同来源**比较使用
 *                               （状态文件记录时间 vs 操作系统进程创建时间）
 */
function compareIdentity(a, b, opts = {}) {
  const tol = typeof opts.startToleranceMs === 'number' ? opts.startToleranceMs : 0
  const va = validateIdentity(a)
  const vb = validateIdentity(b)
  if (!va.ok || !vb.ok) return false
  if (a.pid !== b.pid) return false
  if (tol === 0) {
    if (a.startMs !== b.startMs) return false
  } else if (Math.abs(a.startMs - b.startMs) > tol) {
    return false
  }
  // 主目录必须**指向同一真实目录**：不同 HERMES_HOME 属于不同 profile，绝不是同一个实例
  // （⚠️ 必须用 sameHome 而非字符串比较：符号链接与真实路径会指向同一目录）
  if (!sameHome(a.hermesHome, b.hermesHome, opts)) return false
  for (const f of MATCH_IF_PRESENT_FIELDS) {
    if (a[f] != null && b[f] != null && a[f] !== b[f]) return false
  }
  return true
}

/** 同源身份比较（要求启动时间精确相等） */
function sameIdentity(a, b) {
  return compareIdentity(a, b, { startToleranceMs: 0 })
}

/** 供日志使用的身份摘要（不含任何可复用的凭据） */
function describeIdentity(id) {
  const v = validateIdentity(id)
  if (!v.ok) return `(身份不完整: 缺少 ${v.errors.join(',')})`
  return `pid=${id.pid} start=${id.startMs}`
}

// ──────────────────────────────────────────────────────────── 状态文件读取

/**
 * 读取一个 JSON 文件。
 * io 可注入 { exists, readFile } 以便测试桩替换真实文件系统。
 * 失败返回 { __error }，调用方必须据此拒绝危险操作。
 */
function readJson(p, io) {
  const exists = (io && io.exists) || (q => fs.existsSync(q))
  const readFile = (io && io.readFile) || fs.readFileSync
  try {
    if (!p) return { __error: 'no-path' }
    if (!exists(p)) return { __error: 'missing' }
    return JSON.parse(readFile(p, 'utf8'))
  } catch (err) {
    return { __error: String((err && err.message) || err) }
  }
}

/**
 * 读取当前网关实例身份（来自状态文件）。
 *
 * 策略：
 *   文件"不存在"         → 容忍（用另一处兜底）
 *   文件"存在但读不出来" → 状态异常 → 一律不可信，返回 null
 *   两处 pid 不一致      → 状态正在变化 → 返回 null
 *
 * 注意：本函数**不保证返回的 startMs 有效**；是否可用于所有权判定
 * 由 validateIdentity() / sameIdentity() 决定（缺失即拒绝）。
 *
 * @returns {object|null} 读取不可信时返回 null
 */
function readIdentity(hermesHome, opts = {}) {
  if (!hermesHome) return null
  const io = { exists: opts.exists, readFile: opts.readFile }

  const pidRaw = readJson(path.join(hermesHome, 'gateway.pid'), io)
  const stRaw = readJson(path.join(hermesHome, 'gateway_state.json'), io)

  const pidErr = pidRaw && pidRaw.__error
  const stErr = stRaw && stRaw.__error
  if (pidErr && pidErr !== 'missing') return null   // 损坏 → 不可信
  if (stErr && stErr !== 'missing') return null
  if (pidErr && stErr) return null                  // 两处都没有 → 无信息

  const pidFile = pidErr ? null : pidRaw
  const stFile = stErr ? null : stRaw

  const p1 = pidFile && typeof pidFile.pid === 'number' ? pidFile.pid : null
  const p2 = stFile && typeof stFile.pid === 'number' ? stFile.pid : null
  if (p1 !== null && p2 !== null && p1 !== p2) return null

  const pid = p2 !== null ? p2 : p1
  if (pid === null) return null

  // 启动时间：优先状态文件；拿不到时**退回 pid 文件**，但仍必须能被解析
  const rawStart = (stFile && stFile.start_time != null)
    ? stFile.start_time
    : (pidFile ? pidFile.start_time : null)
  const startMs = toStartMs(rawStart)

  const argv = pidFile && Array.isArray(pidFile.argv) ? pidFile.argv : null
  const argvHash = argv
    ? crypto.createHash('sha1').update(argv.join(' ')).digest('hex').slice(0, 12)
    : null

  return {
    pid,
    startMs,                                   // 可能为 null → 由校验层拒绝
    hermesHome: (stFile && stFile.hermes_home) || (pidFile && pidFile.hermes_home) || hermesHome || null,
    argvHash,
    kind: (pidFile && pidFile.kind) || null,
    state: (stFile && stFile.gateway_state) || null,
    startSource: (stFile && stFile.start_time != null) ? 'state' : (pidFile ? 'pid' : 'none')
  }
}

// ──────────────────────────────────────────────────────────── 目标核验

/**
 * 核验「目标实例」是否可安全操作。
 * 需要：身份完整 + 同 profile 实例数已知且为 1 + 操作系统进程核对通过。
 *
 * ★ 必须清楚本函数**能证明什么、不能证明什么**（安全复审第二轮 问题三）：
 *   能证明：**此刻**目标实例的身份被正确识别（PID + 启动时间 + HERMES_HOME 一致，
 *           且操作系统层面确认该进程存在、创建时间吻合、同 profile 只有它一个）。
 *   **不能**证明："执行 stop 时只会停止这一个实例"。
 *   原因：官方 `gateway stop` 是 profile 级、无 PID 参数 —— 本函数返回后到命令
 *         真正生效之间存在竞态窗口，窗口内新出现的同 profile 实例会被一并停止。
 *   因此：**任何调用方都不得把 ok:true 表述为"保证精确停止单实例"**，
 *         也不得仅凭本函数放行自动化（无人值守）的停止操作。
 *
 * @param {object} current 当前实测身份（来自状态文件）
 * @param {object} ctx     { proc, instanceCount }
 *   proc          { exists:boolean, startMs:number|null } | null  操作系统核对结果
 *   instanceCount number | null  同 profile 网关进程数（null = 探测失败）
 * @returns {{ok:boolean, reason:string, detail?:string, residualRisk?:string}}
 */
function verifyTarget(current, ctx = {}) {
  if (!current) return { ok: false, reason: 'probe-failed' }

  const v = validateIdentity(current)
  if (!v.ok) {
    return { ok: false, reason: 'identity-incomplete', detail: 'current 缺少 ' + v.errors.join(',') }
  }

  // 官方 gateway stop 是 profile 级操作（无 PID 参数）。
  // 若同 profile 存在多个网关进程，stop 会一并停止 → 无法保证只停目标实例。
  const n = ctx.instanceCount
  if (n === null || n === undefined) return { ok: false, reason: 'instance-count-unknown' }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return { ok: false, reason: 'instance-count-invalid' }
  if (n > 1) return { ok: false, reason: 'multiple-instances', detail: `同 profile 检测到 ${n} 个网关进程` }

  // 操作系统层面核对：状态文件可能陈旧，不能只凭它宣称"进程身份已确认"
  const proc = ctx.proc
  if (!proc) return { ok: false, reason: 'process-probe-failed' }
  if (!proc.exists) return { ok: false, reason: 'process-absent' }
  if (proc.startMs === null || proc.startMs === undefined) {
    // 拿不到进程创建时间 → 无法排除 PID 复用 → 拒绝
    return { ok: false, reason: 'process-time-unavailable' }
  }
  if (Math.abs(proc.startMs - current.startMs) > START_TOLERANCE_MS) {
    return {
      ok: false,
      reason: 'process-mismatch',
      detail: `状态文件 start=${current.startMs} 与进程实际 start=${proc.startMs} 不一致（可能 PID 复用）`
    }
  }
  return {
    ok: true,
    reason: 'verified',
    // 如实标注剩余风险：核验通过 ≠ 保证只停止该实例（profile 级 stop 的固有竞态）
    residualRisk: 'profile-level-stop-race'
  }
}

/**
 * 停止前置核验 —— **主进程与看门狗共用的唯一判定入口**。
 *
 * @param {object} p { owned, current, ctx }
 * @returns {{ok:boolean, reason:string, detail?:string}}
 *   reason ∈ no-ownership | probe-failed | identity-incomplete | instance-changed
 *          | instance-count-unknown | instance-count-invalid | multiple-instances
 *          | process-probe-failed | process-absent | process-time-unavailable
 *          | process-mismatch | verified
 */
function preflightStop({ owned, current, ctx } = {}) {
  if (!owned || typeof owned.pid !== 'number') return { ok: false, reason: 'no-ownership' }
  if (!current) return { ok: false, reason: 'probe-failed' }

  const vo = validateIdentity(owned)
  if (!vo.ok) return { ok: false, reason: 'identity-incomplete', detail: 'owned 缺少 ' + vo.errors.join(',') }

  const vc = validateIdentity(current)
  if (!vc.ok) return { ok: false, reason: 'identity-incomplete', detail: 'current 缺少 ' + vc.errors.join(',') }

  if (!sameIdentity(owned, current)) return { ok: false, reason: 'instance-changed' }

  return verifyTarget(current, ctx)
}

/** 兼容旧签名：无 ctx 时按"目标核验不可用"处理（即拒绝） */
function verifyOwnership(owned, current, ctx) {
  const pre = preflightStop({ owned, current, ctx: ctx || {} })
  const out = { ok: pre.ok, reason: pre.reason }
  if (pre.detail) out.detail = pre.detail
  return out
}

/**
 * 授权绑定的目标是否仍是当前目标（用于一次性授权的"目标未漂移"检查）。
 *
 * ⚠️ 历史缺陷（安全复审问题一）：本函数曾只比较 pid + startMs，
 *    **未比较 hermesHome** → 「同 PID、同启动时间、不同主目录」被误判为同一目标，
 *    使一次性授权可以作用到另一个 profile 的实例上。
 *    现已改为复用 compareIdentity()，字段规则与 sameIdentity 完全一致。
 *
 * 允许毫秒级启动时间容差：授权绑定的时间来自签发时读取的状态文件，
 * 执行时的时间可能来自另一路径取样，允许 START_TOLERANCE_MS 偏差。
 * **hermesHome 仍必须严格一致**（仅忽略大小写与尾部斜杠）。
 */
function targetMatches(bound, current) {
  return compareIdentity(bound, current, { startToleranceMs: START_TOLERANCE_MS })
}

// ──────────────────────────────────────────────────────────── 一次性授权（C）

/**
 * 构造一次性授权。**签发时即绑定目标身份**，避免"授权后目标漂移"。
 * @param {string} action 'stop' | 'restart' | 'drain'
 * @param {object} target 目标实例身份（必需；无法确认身份时不应签发）
 */
function createAuthorization(action, target, deps = {}) {
  const now = deps.now || (() => Date.now())
  if (!DANGEROUS_ACTIONS.includes(action)) return null
  const v = validateIdentity(target)
  if (!v.ok) return null            // 目标身份不完整 → 不签发
  return {
    action,
    target: { pid: target.pid, startMs: target.startMs, hermesHome: target.hermesHome },
    tokenHash: crypto.createHash('sha256')
      .update(crypto.randomBytes(24)).digest('hex').slice(0, 12),  // 仅用于日志关联，不可反推
    issuedAt: now(),
    consumed: false,
    consumedAt: null
  }
}

// ──────────────────────────────────────────────────────────── 授权门

/**
 * 危险操作授权门。
 *
 * 放行条件（**必须同时成立**，二选一且都要求目标身份可确认）：
 *   A) 所有权核验通过（含 OS 进程核对 + 单实例）
 *   C) 与该动作匹配、未消费、未过期的一次性授权
 *      **且** 当前目标身份可确认、与授权绑定的目标一致、
 *      **且** OS 进程核对通过、同 profile 只有一个实例
 *
 * 关键修正：授权**不能**替代身份确认。
 * 旧实现在 current=null 时仍会因授权有效而放行 —— 那是绕过。
 */
function createGate(deps = {}) {
  const now = deps.now || (() => Date.now())
  const ttlMs = deps.authTtlMs || 5 * 60 * 1000

  return {
    /**
     * @param {string} action
     * @param {object|null} owned 已记录的所有权身份
     * @param {object|null} current 当前实测身份
     * @param {object|null} auth 待消费的一次性授权
     * @param {object} ctx { proc, instanceCount }
     * @returns {{allowed:boolean, via?:string, reason:string, detail?:string}}
     */
    decide(action, owned, current, auth, ctx = {}) {
      if (!DANGEROUS_ACTIONS.includes(action)) {
        return { allowed: false, reason: 'unsupported-action' }
      }

      // ---- A) 所有权路径 ----
      const pre = preflightStop({ owned, current, ctx })
      if (pre.ok) {
        return { allowed: true, via: 'ownership', reason: 'verified', residualRisk: pre.residualRisk }
      }

      // ---- C) 一次性授权路径 ----
      if (!auth) return { allowed: false, reason: pre.reason, detail: pre.detail }

      if (auth.consumed) return { allowed: false, reason: 'auth-consumed' }
      if (auth.action !== action) return { allowed: false, reason: 'auth-action-mismatch' }

      const issuedAt = typeof auth.issuedAt === 'number' ? auth.issuedAt : 0
      if ((now() - issuedAt) > ttlMs) return { allowed: false, reason: 'auth-expired' }

      if (!auth.target) return { allowed: false, reason: 'auth-no-target' }

      // 授权不能绕过身份确认：目标必须当场可确认
      if (!current) return { allowed: false, reason: 'probe-failed' }
      const vc = validateIdentity(current)
      if (!vc.ok) {
        return { allowed: false, reason: 'identity-incomplete', detail: 'current 缺少 ' + vc.errors.join(',') }
      }
      if (!targetMatches(auth.target, current)) {
        return { allowed: false, reason: 'auth-target-changed' }
      }

      // 目标核验（含多实例与 OS 进程核对）
      const t = verifyTarget(current, ctx)
      if (!t.ok) return { allowed: false, reason: t.reason, detail: t.detail }

      return { allowed: true, via: 'one-shot', reason: 'verified', residualRisk: t.residualRisk }
    }
  }
}

/**
 * 消费授权。**在授权门判定的同一时刻调用**，无论后续操作成败都不再可用。
 * 失败处理约定：授权一旦被消费即作废，需要重新授权 —— 这是 fail-closed 选择，
 * 避免"操作失败后留下可复用的授权"。
 */
function consumeAuthorization(auth, deps = {}) {
  const now = deps.now || (() => Date.now())
  if (!auth || auth.consumed) return null
  auth.consumed = true
  auth.consumedAt = now()
  return auth
}

/**
 * RC 轮新增：手动停止能力的「闸门释放」判定（纯函数，供单测）。
 *
 * 设计（与用户确认过的方案一致）：
 *   · restart / drain / 接管（adopt）维持一律拒绝（ALLOW_DANGEROUS_EXEC=false）；
 *   · stop 单独放开，但**仅限所有权 A 态**（本控制台亲自启动并持有的实例）；
 *   · 共享实例（B 态）没有所有权记录 → 直接拒绝，**不走一次性授权（C）路径**
 *     —— 用户明确选择"外部启动的网关仍然只读展示"，因此 C 路径对 stop 关闭。
 *
 * 注意：本函数只判定"闸门是否放行到授权门（createGate）"，
 * 真正的身份核验（fresh 探测 + 同 profile 单实例 + OS 进程核对）仍由
 * authorizeDangerous → gate.decide 完成，此处不重复也不替代。
 *
 * @param {{
 *   action: string,
 *   allowDangerousExec?: boolean,
 *   allowOwnedStop?: boolean,
 *   hasOwned?: boolean
 * }} o
 * @returns {{allow:boolean, reason:string}}
 *   reason ∈ unsupported-action | legacy-gate-open | dangerous-disabled
 *          | no-ownership | owned-stop
 */
function decideStopRelease({ action, allowDangerousExec, allowOwnedStop, hasOwned } = {}) {
  if (!DANGEROUS_ACTIONS.includes(action)) return { allow: false, reason: 'unsupported-action' }
  // 历史总闸门开启时维持原行为（供未来真实验收后整体开启）
  if (allowDangerousExec) return { allow: true, reason: 'legacy-gate-open' }
  if (action !== 'stop') return { allow: false, reason: 'dangerous-disabled' }
  if (!allowOwnedStop) return { allow: false, reason: 'dangerous-disabled' }
  if (!hasOwned) return { allow: false, reason: 'no-ownership' }
  return { allow: true, reason: 'owned-stop' }
}

// ────────────────────────────────────────────── 启动/停止 前置与后置复核（纯逻辑）

/**
 * 判定官方 CLI 输出中是否出现 `PID file race lost`。
 *
 * 背景：官方 `gateway/status.py::write_pid_file()` 用 `os.O_CREAT|os.O_EXCL` 写 pid 文件；
 *   若旧的 `gateway.pid` 仍在（例如上次异常退出残留），新实例可能以该错误失败。
 *
 * **约定（本控制台行为边界）**：
 *   · 命中即**不自动重试**（不循环重试、不换参数重试）；
 *   · **不删除**状态文件、**不强杀**任何进程；
 *   · 只返回安全恢复指引，由用户本人决定是否执行。
 *
 * @param {...any} texts 官方命令的 stdout / stderr / 错误消息等
 * @returns {{raceLost:boolean, guidance:string|null}}
 */
function judgePidFileRace (...texts) {
  const blob = texts.filter(t => typeof t === 'string' && t).join('\n')
  const raceLost = /pid\s*file\s*race\s*lost/i.test(blob)
  if (!raceLost) return { raceLost: false, guidance: null }
  return {
    raceLost: true,
    guidance:
      '检测到 `PID file race lost`（官方写 pid 文件的 O_CREAT|O_EXCL 竞态）。' +
      '控制台**不会自动重试**、**不会删除状态文件**、**不会强杀进程**。安全恢复步骤（由你本人执行）：' +
      '① 先用官方只读命令核实该 Profile 是否真的没有网关在运行：`hermes --profile <profile> gateway status`；' +
      '② 若确认无运行中的网关，却仍报此错：把该 Profile 目录下的 `gateway.pid` 与 `gateway.lock` ' +
      '**移动到备份目录**（用移动而非删除，可随时移回）；' +
      '③ 再次点击启动。若 ① 显示仍有网关在运行，请不要动状态文件，先停止该实例。'
  }
}

/**
 * 汇总目标 Profile 的「活跃任务」信息（只读状态文件，不涉及凭据）。
 * 官方 `gateway_state.json` 有 `active_agents` 字段；缺失或非法 → known=false（如实标注"未知"）。
 *
 * @param {object|null} stateJson gateway_state.json 解析结果
 * @returns {{known:boolean, activeAgents:number|null, updatedAt:string|null}}
 */
function summarizeActiveTasks (stateJson) {
  if (!stateJson || typeof stateJson !== 'object') return { known: false, activeAgents: null, updatedAt: null }
  const a = stateJson.active_agents
  const updatedAt = typeof stateJson.updated_at === 'string' ? stateJson.updated_at : null
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0) return { known: false, activeAgents: null, updatedAt }
  return { known: true, activeAgents: a, updatedAt }
}

/**
 * 停止后复核的**成功判定**（纯函数，供单测）。
 *
 * ★ 判定只以**最新 OS 进程数据**为准，不把状态文件当作"已停止"的依据：
 *   状态文件可能陈旧，而"是否真停了"只能由操作系统回答。
 *
 * ★ 2026-09-22 修正（stop-verdict）：不再把"状态文件陈旧"当作失败条件。
 *   实测证据（default pid 20508 停止后）：
 *     官方 `gateway stop` 成功后 **会删除** `gateway.pid` 与 `gateway.lock`，
 *     但**保留** `gateway_state.json` 且**不把 `gateway_state` 改成 stopped**
 *     （仍写 `"gateway_state":"running"` + 同一 pid）。
 *   若继续把"状态文件仍记着同一实例"判为失败，则**成功停止永远判不出成功**。
 *   ⇒ 拆成两种**语义完全不同**的情况：
 *     ① `stateFileStillSame`（**陈旧**）：同一实例、其进程已消失 → 仅作**独立警告**，不影响成功判定；
 *     ② `identityConflict`（**冲突**）：状态文件指向**另一个仍存活的实例**（实例已被替换）→ **拒绝**。
 *   ⚠️ 陈旧状态文件**不得由控制台删除或改写**（官方产物），只如实提示。
 *
 * 必须**同时**满足（任一未知或不满足 → `verified=false`，`warnings` 为空）：
 *   1. 命令退出码为 0
 *   2. OS 探测本身成功（无 probeError）
 *   3. 目标 PID 在操作系统里已消失（明确 === false）
 *   4. 同 Profile 剩余 Gateway 实例数 **为 0**（明确 === 0）
 *   5. **无身份冲突**（见上 ②）
 *
 * @param {{
 *   exitCode?:number|null,
 *   osProbeError?:string|null,
 *   osPidStillAlive?:boolean|null,
 *   sameProfileProcesses?:number|null,
 *   stateFileStillSame?:boolean|null,   // 陈旧：状态文件仍记着"同一个已消失的实例"
 *   identityConflict?:boolean|null      // 冲突：状态文件指向"另一个仍存活的实例"
 * }} o
 * @returns {{verified:boolean, reason:string, warnings:string[]}}
 *   reason ∈ verified | exit-nonzero | os-probe-failed | pid-still-alive |
 *            pid-unknown | other-instance | count-unknown | identity-conflict
 *   warnings ⊆ stale-state-file（**仅**在 verified=true 时可能非空）
 */
function decideStopVerification (o = {}) {
  const exitCode = o.exitCode
  const osProbeError = o.osProbeError || null
  const osPidStillAlive = o.osPidStillAlive === undefined ? null : o.osPidStillAlive
  const sameProfileProcesses = o.sameProfileProcesses === undefined ? null : o.sameProfileProcesses
  const stateFileStillSame = o.stateFileStillSame === true
  const identityConflict = o.identityConflict === true

  if (exitCode !== 0) return { verified: false, reason: 'exit-nonzero', warnings: [] }
  if (osProbeError) return { verified: false, reason: 'os-probe-failed', warnings: [] }
  if (osPidStillAlive === true) return { verified: false, reason: 'pid-still-alive', warnings: [] }
  if (osPidStillAlive === null) return { verified: false, reason: 'pid-unknown', warnings: [] }
  if (typeof sameProfileProcesses !== 'number' || !Number.isFinite(sameProfileProcesses) || sameProfileProcesses < 0) {
    return { verified: false, reason: 'count-unknown', warnings: [] }
  }
  // ★ 回归点：目标 PID 消失了，但同 Profile 仍有（或已出现另一个）Gateway 实例 → 不得判成功
  if (sameProfileProcesses > 0) return { verified: false, reason: 'other-instance', warnings: [] }
  // ★ 身份冲突：状态文件指向另一个**仍存活**的实例（实例已被替换）→ 不得判成功
  if (identityConflict) return { verified: false, reason: 'identity-conflict', warnings: [] }

  // ★ 成功。陈旧状态文件只是**独立警告**：不改变成功结论，也不由控制台清理
  const warnings = []
  if (stateFileStillSame) warnings.push('stale-state-file')
  return { verified: true, reason: 'verified', warnings }
}

/** 停止复核失败原因 → 用户可读说明（不含任何凭据） */
const STOP_VERIFY_MESSAGES = {
  'exit-nonzero': '停止命令退出码非 0，未确认停止成功。',
  'os-probe-failed': '无法完成 OS 级复核，停止结果未确认 —— 不视为成功。',
  'pid-still-alive': '操作系统里目标 PID 仍然存在，停止结果未确认 —— 不视为成功。',
  'pid-unknown': '无法确认目标 PID 是否已消失，停止结果未确认 —— 不视为成功。',
  'other-instance': '目标 PID 已消失，但该 Profile 仍存在其它 Gateway 进程（可能已重启或被替换），' +
    '停止结果未确认 —— 不视为成功。',
  'count-unknown': '无法确认该 Profile 是否还有 Gateway 进程，停止结果未确认 —— 不视为成功。',
  'identity-conflict': '状态文件指向的是**另一个仍在运行的实例**（原实例已被替换），' +
    '这与"记录陈旧"不同，停止结果未确认 —— 不视为成功。'
}

/**
 * 停止**成功**后可能出现的**独立警告**（不影响成功结论，也不需要用户做危险操作）。
 * 用途：把"真实进程已停止"与"官方状态文件陈旧"分开表述。
 */
const STOP_VERIFY_WARNINGS = {
  'stale-state-file':
    '官方 stop 不会清理 gateway_state.json —— 它仍记录着本次已停止的实例（陈旧记录）。' +
    '本控制台不修改、不删除该文件；网关运行状态一律以操作系统实测为准。' +
    '下次由控制台启动该 Profile 时，会依据实测结果正常覆盖。'
}

/**
 * 停止前的「活跃任务」判定（纯函数，供单测）。
 *
 * 规则（保证"活跃任务不被无提示中断"）：
 *   · 已知活跃数 > 0 → **拒绝**（不做强制覆盖）
 *   · **活跃数未知（字段缺失/不可读）→ 一律拒绝**：真实验收在此**暂停**，
 *     **不允许**用界面上的"人工确认"强行继续（已移除 confirmActiveUnknown 绕行）
 *   · 已知活跃数 = 0 → 允许
 */
function decideActiveTaskStop ({ known, activeAgents } = {}) {
  if (known === true && typeof activeAgents === 'number' && activeAgents > 0) {
    return { allow: false, reason: 'active-tasks' }
  }
  if (known !== true) return { allow: false, reason: 'active-tasks-unknown' }
  return { allow: true, reason: 'idle' }
}

// ────────────────────────────────────── 按 Profile 的所有权登记（纯逻辑）

/**
 * 迁移/规范化所有权记录（纯函数，供单测）。
 *
 * 新版格式（v2）：`{ version:2, consolePid, gateways:{ <profileId>: identity }, acquiredAt }`
 * 旧版格式（v1）：`{ consolePid, gateway: identity, acquiredAt }`
 *
 * ★ 迁移原则：**迁移不等于授权**。旧记录只能映射到"候选"，是否真的持有，
 *   仍要经 `verifyProfileIdentity()` 当场核验（PID + 创建时间 + home + 单实例）后才生效。
 *   · 旧记录的 home 无法解析到任何已知 Profile → **丢弃**（并记录 dropped）；
 *   · 身份字段不完整 → **丢弃**；
 *   · 绝不允许"单凭 PID / 旧文件 / 同名进程"自动接管外部实例。
 *
 * @param {object|null} json 落盘记录
 * @param {Array<{id:string, home:string}>} profiles 已知 Profile
 * @returns {{version:number, legacy:boolean, byProfile:object, dropped:string[]}}
 */
function migrateOwnershipRecord (json, profiles = []) {
  const out = { version: 2, legacy: false, byProfile: {}, dropped: [] }
  if (!json || typeof json !== 'object') return out

  const resolve = home => {
    if (!home) return null
    const p = (profiles || []).find(x => x.home && sameHome(x.home, home))
    return p ? p.id : null
  }

  // v2：逐条校验，按 Profile 归位
  if (json.gateways && typeof json.gateways === 'object') {
    for (const [id, inst] of Object.entries(json.gateways)) {
      if (!inst) continue
      const v = validateIdentity(inst)
      if (!v.ok) { out.dropped.push(`${id}:身份不完整`); continue }
      const p = (profiles || []).find(x => x.id === id)
      if (!p) { out.dropped.push(`${id}:未知Profile`); continue }
      if (inst.hermesHome && !sameHome(inst.hermesHome, p.home)) {
        out.dropped.push(`${id}:home不一致`)
        continue
      }
      out.byProfile[id] = inst
    }
    return out
  }

  // v1：单条记录 → 解析 home 归位到某个 Profile
  if (json.gateway) {
    out.legacy = true
    const v = validateIdentity(json.gateway)
    const id = resolve(json.gateway && json.gateway.hermesHome)
    if (!v.ok) { out.dropped.push('v1:身份不完整'); return out }
    if (!id) { out.dropped.push('v1:home无法解析到Profile'); return out }
    out.byProfile[id] = json.gateway
  }
  return out
}

/**
 * 核验某个 Profile 的实例身份（纯函数，供单测）。
 *
 * 必须同时满足：
 *   ① 身份字段完整（pid / startMs / hermesHome）
 *   ② hermesHome 与目标 Profile 的 home 一致（防跨 Profile 串台）
 *   ③ 操作系统里存在该 PID，且**创建时间**与记录一致（容差内）→ 防 PID 复用
 *   ④ 该 Profile 的实例数恰为 1（由调用方按 PID 统计后传入）
 *
 * @param {{identity?:object, profileHome?:string, procs?:Array<{pid:number,startMs:number|null}>,
 *          instanceCount?:number|null, toleranceMs?:number}} o
 * @returns {{ok:boolean, reason:string}}
 *   reason ∈ identity-incomplete | profile-mismatch | process-absent |
 *            process-time-unavailable | process-mismatch | multiple-instances |
 *            instance-count-unknown | verified
 */
function verifyProfileIdentity ({ identity, profileHome, procs, instanceCount, toleranceMs } = {}) {
  if (!identity) return { ok: false, reason: 'identity-incomplete' }
  const v = validateIdentity(identity)
  if (!v.ok) return { ok: false, reason: 'identity-incomplete' }
  // 必须**指向同一真实目录**（符号链接 / junction 与真实路径视为同一目录；
  // 解析失败 → sameHome 返回 false → 拒绝，绝不猜测）
  if (profileHome && !sameHome(identity.hermesHome, profileHome)) {
    return { ok: false, reason: 'profile-mismatch' }
  }
  if (!Array.isArray(procs)) return { ok: false, reason: 'process-absent' }
  const entry = procs.find(x => Number(x.pid) === Number(identity.pid))
  if (!entry) return { ok: false, reason: 'process-absent' }
  if (entry.startMs === null || entry.startMs === undefined) return { ok: false, reason: 'process-time-unavailable' }
  const tol = typeof toleranceMs === 'number' ? toleranceMs : START_TOLERANCE_MS
  if (Math.abs(entry.startMs - identity.startMs) > tol) return { ok: false, reason: 'process-mismatch' }
  if (instanceCount === null || instanceCount === undefined) return { ok: false, reason: 'instance-count-unknown' }
  if (instanceCount !== 1) return { ok: false, reason: 'multiple-instances' }
  return { ok: true, reason: 'verified' }
}

/**
 * 统计**某个 Profile** 的网关实例数（按该 Profile 记录的 PID 计；纯函数）。
 * 这样各 Profile 互不干扰：另一个 Profile 的网关 PID 不会被算进来。
 *
 * @param {Array<{pid:number}>|null} procs OS 探测到的网关进程
 * @param {object|null} identity 该 Profile 状态文件里的身份（含 pid）
 * @returns {number|null} null = 探测不可用
 */
function countProfileInstances (procs, identity) {
  if (!Array.isArray(procs)) return null
  if (!identity || typeof identity.pid !== 'number') return 0
  return procs.filter(x => Number(x.pid) === Number(identity.pid)).length
}

/**
 * 停止前的「目标 Profile 复核」（纯函数）。
 * 确保执行停止的目标 Profile 与所有权记录一致，且状态文件里此刻的实例没有漂移到别的 Profile。
 */
function verifyStopTarget ({ ownedProfileId, targetProfileId, currentProfileId } = {}) {
  if (!ownedProfileId) return { ok: false, reason: 'no-ownership' }
  if (!targetProfileId || targetProfileId !== ownedProfileId) return { ok: false, reason: 'profile-mismatch' }
  if (currentProfileId && currentProfileId !== ownedProfileId) return { ok: false, reason: 'profile-drift' }
  return { ok: true, reason: 'profile-verified' }
}

/**
 * 决定"是否允许启动某 Profile 的 Gateway"（纯函数，供单测）。
 *
 * 背景（处理「陈旧状态」的正确口径）：
 *   ⚠️ **不得使用绝对表述**。此前文档与界面写过「陈旧状态一定不影响启动 / 官方会自动覆盖」，
 *   那是**把结论当保证**：官方是否覆盖成功取决于它自己对 runtime lock 的持有判定，
 *   以及 pid 文件写入是否遇到 `O_CREAT|O_EXCL` 竞态（可能报 `PID file race lost`）。
 *   因此这里的语义收紧为：
 *     · 「记录的进程已死」**只作为一项实测事实**，本身不作为拒绝理由（否则按钮点了没反应）；
 *     · 是否真的能起来，**以本次启动的真实探测结果为准**（不预判、不承诺）；
 *     · 若官方报 `PID file race lost` → 由 `judgePidFileRace()` 给出安全恢复指引，**不自动重试**。
 *
 * 判定规则（只描述本函数的事）：
 *   · Profile 目录缺失            → 拒绝 profile-missing
 *   · 配置文件缺失                → 拒绝 config-missing
 *   · 记录的 pid / lock pid 仍存活 → 拒绝 already-running（绝不重复启动）
 *   · 探测不可用、无法断定存活     → 拒绝 probe-failed（fail-closed）
 *   · 记录进程确已死亡（陈旧状态） → 允许尝试启动（stale=true，界面须如实描述"待实测确认"）
 *
 * @param {{
 *   profileExists?:boolean,
 *   configExists?:boolean,
 *   recordedPidLive?:boolean|null,   // null = 无记录
 *   lockPidLive?:boolean|null,
 *   probeAvailable?:boolean          // false = 无法可靠判定存活
 * }} o
 * @returns {{allow:boolean, reason:string, stale:boolean}}
 */
function decideProfileStart(o = {}) {
  const profileExists = o.profileExists === true
  const configExists = o.configExists === true
  const recordedPidLive = o.recordedPidLive === undefined ? null : o.recordedPidLive
  const lockPidLive = o.lockPidLive === undefined ? null : o.lockPidLive
  const probeAvailable = o.probeAvailable !== false

  if (!profileExists) return { allow: false, reason: 'profile-missing', stale: false }
  if (!configExists) return { allow: false, reason: 'config-missing', stale: false }
  // 任一记录进程仍存活 → 已在运行，绝不重复启动
  if (recordedPidLive === true || lockPidLive === true) return { allow: false, reason: 'already-running', stale: false }
  // 探测不可用、无法断定进程是否存活 → fail-closed
  if (!probeAvailable) return { allow: false, reason: 'probe-failed', stale: false }
  // 记录进程确已死亡 → 陈旧记录，允许尝试启动；
  // ⚠️ 仅表示"本函数不拒绝"，不承诺启动一定成功（结果以真实探测为准，见函数注释）
  const stale = recordedPidLive === false || lockPidLive === false
  return { allow: true, reason: 'ok', stale }
}

// ───────────────────────────── 启动后身份重读 / 所有权保留（纯逻辑）

/**
 * 默认重读窗口（毫秒）。
 * ★ **仅**用于"该实例由本控制台刚刚启动、且 OS 已确认存活"的场景；
 *   非本控制台启动的实例**不得**重读 —— 否则等于变相等待接管外部网关。
 */
const IDENTITY_REREAD_WINDOW_MS = 2000
/** 两次重读之间的间隔（毫秒） */
const IDENTITY_REREAD_INTERVAL_MS = 250

/** 属于"尚未就绪"的登记结果：界面应显示"正在确认停止权限"，而不是把它当成失败原因 */
const REGISTER_PENDING_REASONS = ['identity-not-ready', 'identity-unreadable-timeout']

/**
 * 判定"启动后身份重读"的下一步动作（纯函数，供单测）。
 *
 * 背景（2026-09-22 实测）：
 *   官方 `gateway run` **先写** `gateway.pid` + `gateway.lock`、**后写** `gateway_state.json`
 *   （实测相隔约 1 秒）。窗口内 `readIdentity()` 因两处 pid 不一致而返回 null
 *   （两个文件都有 pid 且不相等 → 判"不可信"），于是出现
 *   "前端报启动成功 pid=X、后端登记报身份不可读" 的矛盾。
 *
 * 本函数职责**只有一个**：决定"再读一次 / 进入完整核验 / 立即终止"。
 *   · 它**不等待**、不 sleep、不做任何 I/O；
 *   · 它**不降低**任何标准 —— 进入核验后仍走 verifyProfileIdentity 的四项完整核验。
 *
 * 判定次序（异常优先：环境已经不对时不再空转重读）：
 *   ① otherInstanceCount > 0  → abort other-instance      （出现不属于本次启动的存活实例）
 *   ② alivePidCount >= 2      → abort identity-conflict   （状态文件之间矛盾且都活着）
 *   ③ expectedPid 已死        → abort process-gone        （本次启动的进程没了）
 *   ④ identity 可读           → proceed identity-ready
 *   ⑤ elapsedMs >= windowMs   → abort identity-unreadable-timeout
 *   ⑥ 其余                    → retry identity-not-ready
 *
 * @param {{
 *   attempt?:number,             // 本轮序号（1 起，仅用于日志/测试）
 *   elapsedMs?:number,           // 距重读开始的毫秒数
 *   windowMs?:number,            // 允许窗口（0 = 只读一次，不重读）
 *   identity?:object|null,       // 本轮 readIdentity() 结果
 *   expectedPid?:number|null,    // 本控制台刚启动时观测到的 pid
 *   expectedAlive?:boolean|null, // expectedPid 是否存活（null = 未提供/无法判定）
 *   alivePidCount?:number,       // 状态文件候选 pid 中**存活**的个数
 *   otherInstanceCount?:number   // 存活但 ≠ expectedPid 的候选个数
 * }} o
 * @returns {{action:'proceed'|'retry'|'abort', reason:string}}
 */
function decideIdentityReread (o = {}) {
  const windowMs = (typeof o.windowMs === 'number' && o.windowMs >= 0) ? o.windowMs : IDENTITY_REREAD_WINDOW_MS
  const elapsedMs = (typeof o.elapsedMs === 'number' && o.elapsedMs >= 0) ? o.elapsedMs : 0
  const alivePidCount = typeof o.alivePidCount === 'number' ? o.alivePidCount : 0
  const otherInstanceCount = typeof o.otherInstanceCount === 'number' ? o.otherInstanceCount : 0
  const hasExpected = (typeof o.expectedPid === 'number' && o.expectedPid > 0)

  if (otherInstanceCount > 0) return { action: 'abort', reason: 'other-instance' }
  if (alivePidCount >= 2) return { action: 'abort', reason: 'identity-conflict' }
  if (hasExpected && o.expectedAlive === false) return { action: 'abort', reason: 'process-gone' }
  if (o.identity) return { action: 'proceed', reason: 'identity-ready' }
  if (elapsedMs >= windowMs) return { action: 'abort', reason: 'identity-unreadable-timeout' }
  return { action: 'retry', reason: 'identity-not-ready' }
}

/**
 * 判定"所有权记录是否应当释放"（纯函数，供单测）。
 *
 * 背景（2026-09-22）：
 *   原实现把"身份**暂时**读不到"（`cur === null`，典型场景就是上面那个 ~1 秒写入窗口）
 *   与"实例确实被换掉了"混为一谈，统一算成 `instance-changed`，而后者属于 hardInvalid
 *   → 会直接 `releaseOwnership()`，把**已经取得的 A 态误释放**。
 *   这与该处注释声明的意图（"暂时查不到不销毁记录"）自相矛盾。
 *
 * 严格区分（**不降低标准**）：
 *   · 可读 + 一致 + verified            → retain（正常）
 *   · 可读 + 确凿无效（hardInvalid）     → **release**（实例已变更 / 换 Profile / 进程不匹配 / 多实例）
 *   · 暂时不可读 + 探测失败              → retain（无法证明原实例已死 → 不销毁）
 *   · 暂时不可读 + 原进程已死（OS 确凿）  → **release**（记录已无意义）
 *   · 暂时不可读 + 原进程仍存活           → retain（fail-closed：本次核验不通过，停止按钮禁用）
 *
 * ⚠️ 无论 retain 还是 release，**核验不通过时调用方一律不得放行停止**
 *   （由 verifyTarget / preflightStop 的 `current === null → probe-failed` 保证）。
 *
 * @param {{
 *   curReadable:boolean,         // 状态文件里的身份是否可读
 *   unchanged?:boolean,          // 可读时：是否与记录指向同一实例
 *   checkReason?:string,         // 可读时：verifyProfileIdentity 的结论
 *   probeError?:string|null,     // 不可读时：OS 探测是否失败
 *   ownedPidAlive?:boolean|null  // 不可读时：记录里的进程是否存活（null = 无法判定）
 * }} o
 * @returns {{retain:boolean, release:boolean, reason:string}}
 */
function decideOwnershipRetention (o = {}) {
  if (o.curReadable) {
    if (o.unchanged === true && (!o.checkReason || o.checkReason === 'verified')) {
      return { retain: true, release: false, reason: 'verified' }
    }
    const reason = (o.unchanged === false || o.unchanged === undefined)
      ? 'instance-changed'
      : (o.checkReason || 'unverified')
    const hardInvalid = ['instance-changed', 'profile-mismatch', 'process-mismatch', 'multiple-instances'].includes(reason)
    return hardInvalid
      ? { retain: false, release: true, reason }
      : { retain: true, release: false, reason }
  }
  // ---- 身份暂时不可读 ----
  if (o.probeError) return { retain: true, release: false, reason: 'identity-unreadable-probe-failed' }
  if (o.ownedPidAlive === false) return { retain: false, release: true, reason: 'instance-gone' }
  return { retain: true, release: false, reason: 'identity-unreadable' }
}

module.exports = {
  // 常量
  REQUIRED_IDENTITY_FIELDS,
  MATCH_IF_PRESENT_FIELDS,
  START_TOLERANCE_MS,
  DANGEROUS_ACTIONS,
  IDENTITY_REREAD_WINDOW_MS,
  IDENTITY_REREAD_INTERVAL_MS,
  REGISTER_PENDING_REASONS,
  // 基础
  toStartMs,
  normHome,
  homeRealpath,
  sameHome,
  validateIdentity,
  compareIdentity,
  sameIdentity,
  describeIdentity,
  readJson,
  readIdentity,
  // 核验
  verifyTarget,
  preflightStop,
  decideProfileStart,
  decideStopRelease,
  judgePidFileRace,
  summarizeActiveTasks,
  decideActiveTaskStop,
  decideStopVerification,
  STOP_VERIFY_MESSAGES,
  STOP_VERIFY_WARNINGS,
  migrateOwnershipRecord,
  verifyProfileIdentity,
  countProfileInstances,
  verifyStopTarget,
  verifyOwnership,
  targetMatches,
  decideIdentityReread,
  decideOwnershipRetention,
  // 授权
  createAuthorization,
  consumeAuthorization,
  createGate
}
