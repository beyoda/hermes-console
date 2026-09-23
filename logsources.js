/**
 * 日志读取的纯逻辑层（零副作用、可单元测试）
 *
 * 设计约束：
 *   - 只做字符串 → 结构化数据的转换；**不读写任何文件**（读盘在主进程，便于白名单约束）
 *   - 绝不清洗/截断原始行：每条记录都保留 `raw`，折叠只影响展示分组
 *   - 脱敏是**纵深防御**：既用于「一键复制」，也用于任何对外展示的错误摘要
 */

'use strict'

// ---------------------------------------------------------------------------
// 一、日志来源登记表（三源严格区分，互不冒充）
// 路径为主进程侧的绝对路径；此处只登记，不读取。
// ---------------------------------------------------------------------------
const LOG_SOURCES = [
  {
    id: 'default',
    label: 'default',
    note: 'Hermes 默认 Profile 的日志',
    files: [
      { id: 'agent', label: 'agent.log' },
      { id: 'errors', label: 'errors.log' },
      { id: 'gateway', label: 'gateway.log' }
    ]
  },
  {
    id: 'profile',
    label: '额外 Profile',
    note: 'Hermes 额外 Profile 的日志（与 default 完全独立）',
    files: [
      { id: 'agent', label: 'agent.log' },
      { id: 'errors', label: 'errors.log' },
      { id: 'gateway', label: 'gateway.log' }
    ]
  },
  {
    id: 'external',
    label: '外部工程（可选）',
    note: '外部工程流水线日志（非 Hermes 组件，未配置则不出现）',
    files: [
      { id: 'pipeline', label: 'pipeline.log' },
      { id: 'commands', label: 'commands.log' }
    ]
  },
  {
    id: 'console',
    label: '控制台自身',
    note: '本控制台的运行日志',
    files: [{ id: 'console', label: 'console-*.log' }]
  }
]

function sourceById(id) {
  return LOG_SOURCES.find(s => s.id === String(id)) || null
}

// ---------------------------------------------------------------------------
// 二、行解析
// 支持两种真实格式：
//   Hermes ：2026-09-19 21:46:16,056 INFO  logger.name: message
//   外部工程：2026-09-19 21:55:52,439 | INFO | Running command: …
//   commands.log 段头：[1] tool=python  stage=UVR  exit=0  duration=26.724s
// ---------------------------------------------------------------------------
const TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)/
const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'WARN', 'ERROR', 'CRITICAL', 'TRACE']

/** 把一行日志解析为记录。无法识别时间戳时 ts 为 null（不猜）。 */
function parseLine(raw, lineNo) {
  const text = String(raw == null ? '' : raw)
  const rec = { lineNo, raw: text, ts: null, level: 'INFO', logger: '', message: text, jobId: null }

  let rest = text
  const mTs = TS_RE.exec(text)
  if (mTs) {
    rec.ts = mTs[1].replace(',', '.').replace(' ', 'T')
    rest = text.slice(mTs[1].length)
  }

  // 外部工程 管道格式：  | INFO | msg
  let m = /^\s*\|\s*([A-Z]+)\s*\|\s*(.*)$/.exec(rest)
  if (m) {
    rec.level = normalizeLevel(m[1])
    rec.message = m[2]
  } else {
    // Hermes 格式： LEVEL  logger: message
    m = /^\s*([A-Z]{4,8})\s+(.*)$/.exec(rest)
    if (m && LEVELS.includes(m[1])) {
      rec.level = normalizeLevel(m[1])
      const body = m[2]
      const mL = /^([a-zA-Z0-9_.]+):\s*(.*)$/.exec(body)
      if (mL) {
        rec.logger = mL[1]
        rec.message = mL[2]
      } else {
        rec.message = body
      }
    } else if (rest.trim()) {
      rec.message = rest.trim()
    }
  }

  // job_id：12 位 hex。只在**明确出现**时标记，不猜测
  const mj = /\b([0-9a-f]{12})\b/.exec(text)
  if (mj) rec.jobId = mj[1]

  return rec
}

function normalizeLevel(l) {
  const u = String(l || '').toUpperCase()
  if (u === 'WARN') return 'WARNING'
  return u
}

/** 级别严重度（用于「ERROR 及以上」这类过滤） */
const LEVEL_RANK = { TRACE: 0, DEBUG: 1, INFO: 2, WARNING: 3, ERROR: 4, CRITICAL: 5 }
function levelRank(l) {
  const r = LEVEL_RANK[normalizeLevel(l)]
  return r == null ? 2 : r
}

/**
 * 级别中文说明。三级必须严格区分：
 *   ERROR/WARNING 表示"有麻烦"，INFO 只是过程记录——不能混为一谈。
 * 同时给出「要不要担心」的一句话，避免用户把 INFO 心跳当成故障。
 */
const LEVEL_ZH = {
  CRITICAL: { zh: '严重', tone: 'bad', note: '功能已中断，需要处理' },
  ERROR: { zh: '错误', tone: 'bad', note: '该操作失败，相关功能不可用' },
  WARNING: { zh: '警告', tone: 'warn', note: '出现问题但流程可能仍继续，建议查看' },
  INFO: { zh: '信息', tone: 'ok', note: '正常运行记录，通常无需处理' },
  DEBUG: { zh: '调试', tone: 'muted', note: '调试细节，通常无需关注' },
  TRACE: { zh: '跟踪', tone: 'muted', note: '最细粒度跟踪，通常无需关注' }
}

function levelZh(level) {
  const l = normalizeLevel(level)
  return LEVEL_ZH[l] || { zh: l || '未知', tone: 'muted', note: '未识别的级别名' }
}

// ---------------------------------------------------------------------------
// 时间范围快捷筛选
//   参考时刻 = 「已取到的最新一条日志时间」（不是本机当前时间）——
//   否则读一份昨天的日志时「最近 10 分钟」会永远是空的，失去意义。
//   参考值会在界面上写明，避免误解。
// ---------------------------------------------------------------------------
const TIME_RANGES = [
  { id: 'all', label: '全部时间', minutes: null },
  { id: '10m', label: '最近 10 分钟', minutes: 10 },
  { id: '1h', label: '最近 1 小时', minutes: 60 },
  { id: '6h', label: '最近 6 小时', minutes: 360 }
]

function timeRangeById(id) {
  return TIME_RANGES.find(r => r.id === String(id)) || TIME_RANGES[0]
}

function tsToMs(ts) {
  if (!ts) return null
  const s = String(ts)
  // 允许 2026-09-20T22:10:30 / 2026-09-20 22:10:30,123 两种形态
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?/.exec(s)
  if (!m) return null
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
    Number(((m[7] || '0') + '000').slice(0, 3))
  )
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

/** 记录集合里最新的时间戳（毫秒）；没有时间戳则 null */
function latestTsMs(records) {
  let best = null
  for (const r of records) {
    const t = tsToMs(r && r.ts)
    if (t != null && (best == null || t > best)) best = t
  }
  return best
}

/** 解析整段文本 → 记录数组 */
function parseLog(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line, i) => parseLine(line, i + 1))
}

// ---------------------------------------------------------------------------
// 排序：展示用。默认「最新在前」（desc）。
// 只重排顺序，不改任何记录的 raw。
// ---------------------------------------------------------------------------
function sortRecords(records, order) {
  const list = Array.isArray(records) ? records.slice() : []
  const dir = String(order || 'desc').toLowerCase() === 'asc' ? 1 : -1
  // 无时间戳的行没有可比较的位置 → 一律排在最后（不凭时间臆测顺序）
  const withTs = []
  const noTs = []
  for (const r of list) (r && r.ts ? withTs : noTs).push(r)
  withTs.sort((a, b) => {
    const ta = tsToMs(a.ts)
    const tb = tsToMs(b.ts)
    if (ta == null && tb == null) return 0
    if (ta == null) return 1
    if (tb == null) return -1
    if (ta === tb) return (a.lineNo || 0) - (b.lineNo || 0)
    return ta < tb ? -1 * dir : 1 * dir
  })
  return withTs.concat(noTs)
}

// ---------------------------------------------------------------------------
// 三、过滤
// opts: { minLevel, search, since, until, jobId, withinMinutes, refMs }
//   since/until 为 ISO 或 HH:MM 字符串；对**没有时间戳**的记录一律保留（不能凭时间丢弃）
//   withinMinutes 以 refMs（默认取集合内最新时间）为参考
// ---------------------------------------------------------------------------
function filterRecords(records, opts) {
  const o = opts || {}
  const minRank = o.minLevel ? levelRank(o.minLevel) : null
  const kw = (o.search || '').trim().toLowerCase()
  const jid = (o.jobId || '').trim().toLowerCase()

  let cutoffMs = null
  let refMs = null
  if (o.withinMinutes) {
    const mins = Number(o.withinMinutes)
    if (Number.isFinite(mins) && mins > 0) {
      const ref = o.refMs != null ? Number(o.refMs) : latestTsMs(records)
      if (ref != null && Number.isFinite(ref)) {
        refMs = ref
        cutoffMs = ref - mins * 60000
      }
    }
  }

  return records.filter(r => {
    if (minRank != null && levelRank(r.level) < minRank) return false
    if (kw && !r.raw.toLowerCase().includes(kw)) return false
    if (jid && !r.raw.toLowerCase().includes(jid)) return false
    if (o.since || o.until) {
      if (!r.ts) return true // 无时间戳 → 不凭时间排除
      const t = r.ts.slice(11, 19)
      if (o.since && t < String(o.since).slice(0, 8)) return false
      if (o.until && t > String(o.until).slice(0, 8)) return false
    }
    if (cutoffMs != null) {
      const t = tsToMs(r.ts)
      if (t == null) return true // 无时间戳 → 保留（并会在界面上标注）
      if (t < cutoffMs) return false
      // 上界：参考时刻之后的记录不算"最近 N 分钟"内（默认参考=最新一条，故此条通常不生效）
      if (refMs != null && t > refMs) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// 四、重复折叠
// 把「消息归一化后相同」的**相邻**记录合并成一组，保留首次/末次时间与出现次数，
// 且**完整保留每一行的原文**（members），展开即原始内容。
// ---------------------------------------------------------------------------
function normalizeForCollapse(message) {
  return String(message || '')
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, '<TS>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    .replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, '<DUR>')
    .replace(/\d+/g, '<N>')
    .trim()
}

function collapseRepeats(records, opts) {
  const o = opts || {}
  const minRepeat = Math.max(2, Number(o.minRepeat) || 2)
  // 默认只折叠 INFO/DEBUG（ERROR/WARN 不折叠，避免掩盖问题）
  const collapseLevels = o.levels || ['INFO', 'DEBUG', 'TRACE']

  const groups = []
  let cur = null
  for (const r of records) {
    const key = normalizeForCollapse(r.message)
    const collapsible = collapseLevels.includes(normalizeLevel(r.level))
    if (
      cur &&
      collapsible &&
      cur.collapsible &&
      cur.key === key &&
      cur.level === normalizeLevel(r.level)
    ) {
      cur.members.push(r)
      cur.lastTs = r.ts
      cur.count += 1
    } else {
      if (cur) groups.push(cur)
      cur = {
        key,
        collapsible,
        level: normalizeLevel(r.level),
        logger: r.logger,
        message: r.message,
        firstTs: r.ts,
        lastTs: r.ts,
        count: 1,
        members: [r],
        jobId: r.jobId
      }
    }
  }
  if (cur) groups.push(cur)

  return groups.map(g => ({
    // 未达阈值的可折叠组直接摊平（不虚报"重复"）
    collapsed: g.collapsible && g.count >= minRepeat,
    level: g.level,
    logger: g.logger,
    message: g.message,
    firstTs: g.firstTs,
    lastTs: g.lastTs,
    count: g.count,
    jobId: g.jobId,
    members: g.members
  }))
}

// ---------------------------------------------------------------------------
// 五、脱敏（用于「一键复制」与对外展示）
// 只认**形态**，不认词：状态描述（如 "No access token found"）必须放过。
// ---------------------------------------------------------------------------
const REDACT_RULES = [
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '<jwt>'],
  // 常见前缀密钥
  [/\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, '<key>'],
  // key = value / key: value（键名含敏感词，值长度 >= 16 才判定）
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|app[_-]?secret|bearer|cookie|session[_-]?token)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})["']?/gi,
    '$1=<redacted>'
  ],
  // 飞书长凭据形态（cli_ 前缀 app id 之外的超长随机串）
  [/\b[A-Za-z0-9]{32,}\b/g, '<long-token>']
]

function redactText(text) {
  let s = String(text == null ? '' : text)
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep)
  return s
}

/** 是否包含疑似凭据（供测试断言用；不改变原文） */
function looksSensitive(text) {
  const s = String(text == null ? '' : text)
  return REDACT_RULES.some(([re]) => new RegExp(re.source, re.flags).test(s))
}

// ---------------------------------------------------------------------------
// 六、错误/警告的中文解释
//
// 规则（重要）：
//   - 只收录**已确认**的类型；查不到就如实说「暂无解释」，**不编造故障原因**
//   - 解释与级别绑定：警告类条目不会被当成错误，反之亦然（levels: null = 不限级别）
//   - ERROR / WARNING / INFO 三级用不同文案，避免把 WARNING 说成「未收录的错误类型」
// ---------------------------------------------------------------------------
const ERROR_EXPLAIN = [
  {
    re: /UNEXPECTED_EOF_WHILE_READING|SSLEOFError/i,
    levels: null,
    title: 'TLS 连接被中途切断',
    advice: '多为代理或网络层拦截所致。若目标域名为飞书，请确认该 Profile 是否需要绕过系统代理（NO_PROXY）。'
  },
  {
    re: /getaddrinfo failed|Name or service not known/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '域名解析失败',
    advice: '本机 DNS 暂时无法解析该域名；可能是网络抖动或 DNS 服务不可用。'
  },
  {
    re: /PID file race lost/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '网关启动被陈旧 PID 文件阻塞',
    advice: '上游已知问题（#14128）：旧的 gateway.pid 未被清除。核验旧进程确已结束后，将 pid/lock 移存（不要直接删除）再启动。'
  },
  {
    re: /initialize' timed out|method 'initialize' timed out/i,
    levels: ['ERROR', 'CRITICAL'],
    title: 'Codex app-server 初始化握手超时',
    advice: 'Hermes 硬编码 10 秒上限。若由工具沙箱启动的网关出现，请改用你自己的终端/控制台启动网关。'
  },
  {
    re: /\b(429|rate limit|rate_limit_reached)\b/i,
    levels: ['WARNING', 'ERROR', 'CRITICAL'],
    title: '触发速率限制（429）',
    advice: '短时间内请求过多。等待额度窗口重置，或降低并发。'
  },
  {
    re: /Access denied|403 Forbidden/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '权限不足（403）',
    advice: '当前凭据无权访问该资源，可能未授权或权限范围不足。'
  },
  {
    re: /ETIMEDOUT|Read timed out|ReadTimeout|Connection timed out/i,
    levels: null,
    title: '请求超时',
    advice: '目标服务在超时时间内未响应；可能是网络慢、服务繁忙或代理异常。'
  },
  {
    re: /Connection refused|ECONNREFUSED/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '连接被拒绝',
    advice: '目标端口没有服务在监听，或服务尚未启动。'
  },
  {
    re: /No space left|disk full/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '磁盘空间不足',
    advice: '请先释放磁盘空间，否则写入会持续失败。'
  },
  {
    re: /command not found|不是内部或外部命令/i,
    levels: ['ERROR', 'CRITICAL'],
    title: '命令不存在',
    advice: 'PATH 中找不到该可执行文件；请确认依赖已安装且路径正确。'
  },
  // ---- 警告类（这些是"有问题但流程可能继续"，不是错误） ----
  {
    re: /回退默认|取值不被支持|fallback|unsupported/i,
    levels: ['WARNING', 'INFO'],
    title: '参数取值不被支持，已回退默认值',
    advice: '该取值不在推理脚本的合法范围内，流程按默认值继续。若要使用它，请改用受支持的取值。'
  },
  {
    re: /超出允许范围|out of range|越界/i,
    levels: ['WARNING', 'ERROR'],
    title: '参数取值越界',
    advice: '为避免结果被静默改变，越界值会被拒绝而不是自动夹取到边界。请改成范围内的值。'
  },
  {
    re: /not running|未运行|no running/i,
    levels: ['WARNING', 'INFO'],
    title: '目标服务当前未运行',
    advice: '若期望它在运行，请确认启动方式与 Profile；未运行时相关功能不可用，但其他部分不受影响。'
  },
  {
    re: /stale|陈旧/i,
    levels: ['WARNING', 'INFO'],
    title: '检测到陈旧状态文件',
    advice: '状态文件残留（如 pid/lock）。需要启动时应先核验旧进程确已结束，再移存这些文件。'
  },
  {
    re: /deprecat|已废弃/i,
    levels: ['WARNING', 'INFO'],
    title: '使用了已废弃的接口或参数',
    advice: '当前仍可用，但后续版本可能移除；建议改用新的等价方式。'
  },
  {
    re: /skipped|跳过/i,
    levels: ['WARNING', 'INFO'],
    title: '某个步骤被跳过',
    advice: '常见于缓存命中或前置条件已满足；若不符合预期，请检查是否本该执行该步骤。'
  },
  {
    re: /retry|retrying|重试/i,
    levels: ['WARNING', 'INFO'],
    title: '正在重试',
    advice: '上一次尝试未成功，已自动重试。若反复出现，请查看同一 job_id 的相邻日志定位根因。'
  },
  {
    re: /dropped|discard|被丢弃/i,
    levels: ['WARNING', 'ERROR'],
    title: '有消息被丢弃',
    advice: '发送链路未成功，内容未送达。检查网络/代理与目标凭据配置。'
  }
]

/**
 * 查一条记录的中文解释。
 * 未收录时**按级别**给出不同措辞，并且绝不编造原因。
 */
function explainMessage(message, level) {
  const s = String(message == null ? '' : message)
  const lv = normalizeLevel(level || 'ERROR')
  for (const item of ERROR_EXPLAIN) {
    if (!item.re.test(s)) continue
    if (item.levels && !item.levels.includes(lv)) continue
    return { known: true, title: item.title, advice: item.advice }
  }
  if (lv === 'ERROR' || lv === 'CRITICAL') {
    return {
      known: false,
      title: '暂无解释',
      advice: '这条错误尚未收录；请展开原始日志查看完整上下文（不做推测）。'
    }
  }
  if (lv === 'WARNING') {
    return {
      known: false,
      title: '暂无解释',
      advice: '这条警告尚未收录。警告表示"可能有问题、但流程可能仍在继续"；请展开原文判断是否需要处理。'
    }
  }
  return {
    known: false,
    title: '暂无解释',
    advice: '这是普通运行记录，通常无需处理。'
  }
}

/** 兼容旧调用名 */
function explainError(message, level) {
  return explainMessage(message, level)
}

/** 「一键复制」用的脱敏摘要 */
function buildCopyPayload(rec, opts) {
  const o = opts || {}
  const e = explainMessage(rec.message, rec.level)
  const lz = levelZh(rec.level)
  const lines = [
    `[来源] ${o.sourceLabel || '未知'}`,
    `[文件] ${o.fileLabel || '未知'}`,
    rec.ts ? `[时间] ${rec.ts}` : '[时间] 无时间戳',
    `[级别] ${rec.level}（${lz.zh}）`,
    `[说明] ${e.title}`,
    e.known ? `[建议] ${e.advice}` : '',
    '[原文]',
    redactText(rec.raw)
  ].filter(Boolean)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 七、作业（job）登记：把 jobs/<state>/*.json 转成时间线摘要
//
// ⚠️ 两条轴必须严格分开：
//      「制作轴」= 翻唱做出来没有（入队 / 处理中 / 制作完成 / 制作失败 / 已取消）
//      「投递轴」= 飞书收到没有（等待投递 / 投递成功 / 投递失败 / 未知）
//   Job completed **不等于**已送达。缺 notify_status 时投递轴显示「未知」，不臆测。
// ---------------------------------------------------------------------------
const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'outbox']

const STAGE_ZH = {
  prepare: '准备', uvr: '人声分离', svc: '声音转换', vocalfx: '人声效果',
  mixing: '混音', mixer: '混音', exporting: '导出', export: '导出',
  pending: '待处理', done: '完成', failed: '失败',
  input: '输入检查', voice: '音色解析', options: '参数校验'
}

function stageZh(stage) {
  const k = String(stage || '').trim().toLowerCase()
  if (!k) return ''
  if (STAGE_ZH[k]) return STAGE_ZH[k]
  return `${stage}（未收录名称）`
}

const PRODUCTION_ZH = {
  queued: { label: '入队（等待处理）', tone: 'muted' },
  running: { label: '正在处理', tone: 'warn' },
  completed: { label: '制作完成', tone: 'ok' },
  failed: { label: '制作失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'muted' }
}

const DELIVERY_ZH = {
  pending: { label: '等待投递', tone: 'muted' },
  sent: { label: '投递成功', tone: 'ok' },
  failed: { label: '投递失败', tone: 'bad' },
  skipped: { label: '未投递（已跳过）', tone: 'muted' }
}

function productionState(job) {
  const raw = String((job && job.state) || '').trim().toLowerCase()
  const hit = PRODUCTION_ZH[raw]
  if (!hit) return { key: 'unknown', label: '制作状态未知', tone: 'muted', raw: raw || '' }
  if (raw === 'running') {
    const zh = stageZh(job && job.stage)
    return { key: 'running', label: '正在处理', tone: 'warn', detail: zh ? `当前阶段：${zh}` : '阶段未记录' }
  }
  return { key: raw, label: hit.label, tone: hit.tone, detail: '' }
}

function deliveryState(job) {
  const raw = job && job.notifyStatus != null ? String(job.notifyStatus).trim() : ''
  if (!raw) return { key: 'unknown', label: '投递状态未知', tone: 'muted', known: false, raw: '' }
  const hit = DELIVERY_ZH[raw.toLowerCase()]
  if (!hit) return { key: 'unknown', label: '投递状态未知', tone: 'muted', known: false, raw }
  return { key: raw.toLowerCase(), label: hit.label, tone: hit.tone, known: true, raw }
}

function summarizeJob(obj, stateDir) {
  if (!obj || typeof obj !== 'object') return null
  const jobId = obj.job_id || null
  if (!jobId) return null
  const pr = obj.progress || {}
  const md = obj.metadata || {}
  return {
    jobId,
    state: String(obj.status || stateDir || ''),
    queueDir: stateDir || '',
    createdAt: obj.created_at || null,
    startedAt: obj.started_at || null,
    finishedAt: obj.finished_at || null,
    stage: obj.current_stage || '',
    percent: typeof pr.percent === 'number' ? pr.percent : null,
    message: pr.message || '',
    song: md.song || obj.source || '',
    voice: md.voice || obj.voice_id || '',
    pitch: typeof obj.pitch === 'number' ? obj.pitch : null,
    reverb: (obj.options || {}).reverb || null,
    f0Method: (obj.options || {}).f0_method || null,
    svcOptions: (obj.options || {}).svc_options || null,
    // A/B 对比：原版 / 调音版成对出现，成对关系与差异都记在作业里
    abVariant: md.ab_variant || null,
    abGroup: md.ab_group || null,
    abPairOf: md.ab_pair_of || null,
    abDiff: md.ab_diff || null,
    outputPath: obj.output_path || null,
    error: obj.error || null,
    errorCode: md.error_code || null,
    notifyStatus: obj.notify_status || null,
    retentionStatus: (md.retention || {}).status || null
  }
}

/** 作业的「制作 + 投递」双轴摘要（界面直接用它渲染，避免两处判断不一致） */
function jobStateView(job) {
  if (!job) return null
  return {
    jobId: job.jobId,
    production: productionState(job),
    delivery: deliveryState(job),
    stageZh: stageZh(job.stage),
    delivered: deliveryState(job).key === 'sent'
  }
}

/** 一个作业的「阶段时间线」文案（只依据 json 里真实存在的字段，不推测） */
function jobTimeline(job) {
  if (!job) return []
  const rows = []
  const prod = productionState(job)
  const deliv = deliveryState(job)
  rows.push({ key: 'created', label: '入队', at: job.createdAt })
  if (job.startedAt) rows.push({ key: 'started', label: '开始处理', at: job.startedAt })
  if (prod.key === 'running') {
    rows.push({ key: 'stage', label: prod.detail, at: null })
    if (typeof job.percent === 'number') rows.push({ key: 'progress', label: `进度 ${job.percent}%`, at: null })
  }
  rows.push({ key: 'production', label: `制作：${prod.label}`, at: job.finishedAt })
  // 投递是独立的一条轴，绝不由「制作完成」推断
  rows.push({
    key: 'delivery',
    label: `投递：${deliv.label}` + (deliv.known ? '' : '（作业记录未提供该字段）'),
    at: null
  })
  if (job.error) rows.push({ key: 'error', label: `失败原因：${job.error}`, at: null })
  return rows
}

function notifyLabel(s) {
  return deliveryState({ notifyStatus: s }).label
}

/** 用 job_id 关联日志行（子串匹配，与主进程读取口径一致）；关联不到就是 0，不猜 */
function jobLogLink(records, jobId) {
  const jid = String(jobId || '').trim().toLowerCase()
  if (!jid || !Array.isArray(records)) return { matched: 0, first: null, last: null }
  let matched = 0
  let first = null
  let last = null
  for (const r of records) {
    if (!r || !String(r.raw || '').toLowerCase().includes(jid)) continue
    matched += 1
    if (!first) first = r.ts || null
    last = r.ts || last
  }
  return { matched, first, last }
}

/** 各等级出现次数（用于「只看问题」时给出真实分布） */
function levelCounts(records) {
  const out = {}
  for (const r of records || []) {
    const l = normalizeLevel(r && r.level)
    out[l] = (out[l] || 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 八、运行阶段识别（外部工程 的 commands.log / pipeline.log 共有的阶段名）
// ---------------------------------------------------------------------------
const STAGES = ['Prepare', 'UVR', 'SVC', 'VocalFX', 'Mixer', 'Export']

function detectStage(message) {
  const s = String(message || '')
  for (const st of STAGES) {
    if (new RegExp(`\\b${st}\\b`, 'i').test(s)) return st
  }
  return null
}

/** 记录数组 → 阶段计数（用于「按阶段」概览） */
function stageSummary(records) {
  const out = {}
  for (const r of records) {
    const st = detectStage(r.message)
    if (!st) continue
    if (!out[st]) out[st] = { stage: st, lines: 0, errors: 0 }
    out[st].lines += 1
    if (levelRank(r.level) >= LEVEL_RANK.ERROR) out[st].errors += 1
  }
  return STAGES.filter(s => out[s]).map(s => out[s])
}

module.exports = {
  LOG_SOURCES,
  sourceById,
  parseLine,
  parseLog,
  normalizeLevel,
  levelRank,
  LEVEL_RANK,
  LEVEL_ZH,
  levelZh,
  filterRecords,
  sortRecords,
  tsToMs,
  latestTsMs,
  TIME_RANGES,
  timeRangeById,
  normalizeForCollapse,
  collapseRepeats,
  redactText,
  looksSensitive,
  REDACT_RULES,
  explainError,
  explainMessage,
  ERROR_EXPLAIN,
  buildCopyPayload,
  summarizeJob,
  jobTimeline,
  jobStateView,
  productionState,
  deliveryState,
  stageZh,
  notifyLabel,
  jobLogLink,
  levelCounts,
  JOB_STATES,
  STAGES,
  detectStage,
  stageSummary
}
