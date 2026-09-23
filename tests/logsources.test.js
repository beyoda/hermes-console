/**
 * Hermes 桌面控制台 — 日志解析（纯逻辑）自动化测试
 *
 * 运行：node tests/logsources.test.js
 * 无第三方依赖、无副作用：**不读任何日志文件、不启动进程、不触碰网关与 外部工程**。
 *
 * 覆盖本轮专项要求：
 *   [1] 三源（default / Extra / 外部工程 / 控制台）严格区分，不互相冒充
 *   [2] 两种真实日志格式的行解析（Hermes 空格式 / 外部工程 竖线式）
 *   [3] 级别归一与筛选（ERROR/WARN 优先）、关键词、job_id、时间范围
 *   [4] 高频重复 INFO 折叠：保留次数、首末时间、**逐行原文**
 *   [5] 脱敏只认形态不认词：状态描述（No access token found…）必须放过
 *   [6] 错误中文解释：未知类型必须如实标注，不得编造
 *   [7] 作业登记解析与时间线（含投递状态、失败原因）
 *   [8] 源码级约束：logsources.js 不得含文件/进程/网络调用
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const ls = require('../logsources')

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

// ============================================================ 1. 来源登记
test('1. 日志来源三源互不重合，且各自标注清楚', () => {
  const ids = ls.LOG_SOURCES.map(s => s.id)
  assert.deepStrictEqual(ids, ['default', 'profile', 'external', 'console'])
  const d = ls.sourceById('default'), c = ls.sourceById('profile'), a = ls.sourceById('external')
  assert.ok(d && c && a, '缺少来源')
  assert.ok(d.label.includes('default'), 'default 标注不清晰')
  assert.ok(c.label && /Profile|额外|额外 Profile/.test(c.label), 'extra 标注不清晰')
  assert.ok(a.label.includes('外部工程'), 'external 标注不清晰')
  // 外部工程 必须显式说明它不是 Hermes 组件
  assert.ok(/非 Hermes/.test(a.note), '外部工程 未声明其非 Hermes 组件')
})

test('2. 未知来源返回 null（不兜底成 default）', () => {
  assert.strictEqual(ls.sourceById('nope'), null)
  assert.strictEqual(ls.sourceById(''), null)
})

// ============================================================ 2. 行解析
test('3. 解析 Hermes 格式（时间 + LEVEL + logger + message）', () => {
  const r = ls.parseLine('2026-09-19 21:46:16,056 INFO agent.turn_context: conversation turn: history=56', 1)
  assert.strictEqual(r.ts, '2026-09-19T21:46:16.056')
  assert.strictEqual(r.level, 'INFO')
  assert.strictEqual(r.logger, 'agent.turn_context')
  assert.ok(r.message.startsWith('conversation turn'))
  assert.strictEqual(r.raw.includes('history=56'), true, '原文必须完整保留')
})

test('4. 解析 外部工程 竖线格式（时间 | LEVEL | message）', () => {
  const r = ls.parseLine('2026-09-20 21:57:01,056 | INFO | Running command: ffmpeg -y -i x.wav', 2)
  assert.strictEqual(r.ts, '2026-09-20T21:57:01.056')
  assert.strictEqual(r.level, 'INFO')
  assert.ok(r.message.startsWith('Running command'))
})

test('5. 无时间戳的行不伪造时间，且原文保留', () => {
  const r = ls.parseLine('--- stdout ---', 3)
  assert.strictEqual(r.ts, null, '不得编造时间戳')
  assert.strictEqual(r.raw, '--- stdout ---')
})

test('6. job_id 只在明确出现 12 位 hex 时识别（不猜测）', () => {
  const a = ls.parseLine('2026-09-20 21:55:52,439 | INFO | Running command: D:\\x\\workdir\\b6b1ee5ced64\\uvr', 4)
  assert.strictEqual(a.jobId, 'b6b1ee5ced64')
  const b = ls.parseLine('2026-09-20 21:55:52,439 | INFO | nothing here', 5)
  assert.strictEqual(b.jobId, null)
})

test('7. 级别归一：WARN → WARNING，未知级别不炸', () => {
  assert.strictEqual(ls.normalizeLevel('warn'), 'WARNING')
  assert.strictEqual(ls.normalizeLevel('WARNING'), 'WARNING')
  assert.strictEqual(ls.normalizeLevel(''), '')
  assert.ok(ls.levelRank('ERROR') > ls.levelRank('WARNING'))
  assert.ok(ls.levelRank('WARNING') > ls.levelRank('INFO'))
})

test('8. parseLog 按行切分且行号连续', () => {
  const recs = ls.parseLog('a\nb\r\nc')
  assert.strictEqual(recs.length, 3)
  assert.deepStrictEqual(recs.map(r => r.lineNo), [1, 2, 3])
})

// ============================================================ 3. 过滤
const FIXTURE = [
  '2026-09-19 21:46:16,056 INFO hermes_cli.auth: Nous inference auth: using NAS invoke JWT',
  '2026-09-19 21:46:31,207 ERROR gateway.run: boom happened',
  '2026-09-19 21:46:31,300 WARNING gateway.run: something odd',
  '2026-09-20 21:55:52,439 | INFO | Running command: workdir\\b6b1ee5ced64\\uvr',
  'notimestamp line mentioning b6b1ee5ced64'
].map((l, i) => ls.parseLine(l, i + 1))

test('9. 级别筛选：ERROR 及以上只留 ERROR/CRITICAL', () => {
  const out = ls.filterRecords(FIXTURE, { minLevel: 'ERROR' })
  assert.strictEqual(out.length, 1)
  assert.ok(out[0].message.includes('boom'))
})

test('10. 关键词筛选区分大小写不敏感', () => {
  const out = ls.filterRecords(FIXTURE, { search: 'NOUS INFERENCE' })
  assert.strictEqual(out.length, 1)
})

test('11. job_id 筛选命中所有包含该 id 的行（含无时间戳行）', () => {
  const out = ls.filterRecords(FIXTURE, { jobId: 'b6b1ee5ced64' })
  assert.strictEqual(out.length, 2, `期望 2 行，实际 ${out.length}`)
})

test('12. 时间范围筛选：无时间戳的行不能被时间过滤掉', () => {
  const out = ls.filterRecords(FIXTURE, { since: '21:46:00', until: '21:46:20' })
  assert.strictEqual(out.length, 2, `期望 2 行（1 条在范围内 + 1 条无时间戳），实际 ${out.length}`)
})

// ============================================================ 4. 折叠
test('13. 高频重复 INFO 被折叠，并记录次数与首末时间', () => {
  const lines = []
  for (let i = 0; i < 7; i++) {
    lines.push(`2026-09-19 23:0${i}:00,000 INFO hermes_cli.auth: Nous inference auth: using NAS invoke JWT`)
  }
  const groups = ls.collapseRepeats(ls.parseLog(lines.join('\n')), { minRepeat: 3 })
  assert.strictEqual(groups.length, 1, '应折叠为 1 组')
  assert.strictEqual(groups[0].count, 7)
  assert.strictEqual(groups[0].collapsed, true)
  assert.ok(groups[0].firstTs && groups[0].lastTs, '必须保留首末时间')
  assert.strictEqual(groups[0].members.length, 7, '每行原文必须完整保留')
  assert.ok(groups[0].members.every(m => m.raw.includes('NAS invoke JWT')), '原文不得被改写')
})

test('14. 重复次数未达阈值时不虚报折叠', () => {
  const lines = [
    '2026-09-19 23:00:00,000 INFO a.b: same message',
    '2026-09-19 23:00:01,000 INFO a.b: same message'
  ]
  const g = ls.collapseRepeats(ls.parseLog(lines.join('\n')), { minRepeat: 5 })
  assert.strictEqual(g[0].collapsed, false)
  assert.strictEqual(g[0].count, 2)
})

test('15. ERROR/WARN 永不折叠（避免掩盖问题）', () => {
  const lines = []
  for (let i = 0; i < 5; i++) lines.push(`2026-09-19 23:00:0${i},000 ERROR svc: same error text here`)
  const g = ls.collapseRepeats(ls.parseLog(lines.join('\n')), { minRepeat: 2 })
  assert.strictEqual(g.length, 5, 'ERROR 必须逐条保留')
  assert.ok(g.every(x => x.collapsed === false))
})

test('16. 折叠归一化会抹掉时间/时长/数字差异以正确归组', () => {
  const a = ls.normalizeForCollapse('took 12.5s for job 1234')
  const b = ls.normalizeForCollapse('took 98.1s for job 9876')
  assert.strictEqual(a, b)
})

// ============================================================ 5. 脱敏
test('17. 脱敏：JWT / sk- / key=value / 超长串一律替换', () => {
  const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(8)
  const sk = 'sk-' + 'z'.repeat(20)
  const kv = 'app_secret' + '=' + 'q'.repeat(24)
  const long = 'L'.repeat(40)
  const out = ls.redactText([jwt, sk, kv, long].join(' | '))
  assert.ok(!out.includes(jwt), 'JWT 未脱敏')
  assert.ok(!out.includes(sk), 'sk- 未脱敏')
  assert.ok(!out.includes('q'.repeat(24)), 'key=value 未脱敏')
  assert.ok(!out.includes(long), '超长串未脱敏')
})

test('18. 脱敏只认形态不认词：状态描述必须放过', () => {
  const status = 'nous: logged out (No access token found for Nous Portal login.)'
  const out = ls.redactText(status)
  assert.strictEqual(out, status, '状态描述被误脱敏，会丢失诊断信息')
  const status2 = 'access_token 全部为 null'
  assert.strictEqual(ls.redactText(status2), status2, '状态描述被误脱敏')
})

test('19. 脱敏不破坏正常路径与参数值', () => {
  const line = 'Running command: python inference_main.py -t 0 -s output -f0p rmvpe -wf wav'
  assert.strictEqual(ls.redactText(line), line, '正常命令行被误改')
  const p = 'D:\\codex-external\\workdir\\b6b1ee5ced64\\uvr'
  assert.strictEqual(ls.redactText(p), p, '路径被误改')
})

test('20. looksSensitive 能识别疑似凭据（供自检使用）', () => {
  assert.strictEqual(ls.looksSensitive('token=' + 'a'.repeat(20)), true)
  assert.strictEqual(ls.looksSensitive('No access token found'), false)
})

// ============================================================ 6. 错误解释
test('21. 已知错误类型给出中文解释与建议', () => {
  const e = ls.explainError("SSLError(SSLEOFError(8, '[SSL: UNEXPECTED_EOF_WHILE_READING]'))")
  assert.strictEqual(e.known, true)
  assert.ok(/TLS/.test(e.title))
  assert.ok(e.advice.length > 5)
})

test('22. 未知错误类型如实标注，不得编造', () => {
  // 本轮起措辞统一为「暂无解释」（不再写「未收录的错误类型」——那句话会把
  // 警告也说成错误，且读起来像"系统认为这是错误类型"）
  const e = ls.explainError('some totally unknown failure xyz')
  assert.strictEqual(e.known, false)
  assert.strictEqual(e.title, '暂无解释')
  assert.ok(!/错误类型/.test(e.title), '不得把未知项标成"错误类型"')
  assert.ok(!/建议|请先/.test(e.title) || /不做推测/.test(e.advice))
  assert.ok(/不做推测|展开/.test(e.advice), '应引导看原文而不是编原因')
  // 级别不同，措辞不同
  assert.notStrictEqual(
    ls.explainError('some totally unknown failure xyz', 'WARNING').advice,
    ls.explainError('some totally unknown failure xyz', 'INFO').advice
  )
})

test('23. 复制载荷含来源/时间/级别/说明/脱敏原文，且不含明文凭据', () => {
  const rec = ls.parseLine('2026-09-19 21:46:31,207 ERROR gateway.run: token=' + 'a'.repeat(24), 1)
  const payload = ls.buildCopyPayload(rec, { sourceLabel: 'default', fileLabel: 'errors.log' })
  assert.ok(payload.includes('default'))
  assert.ok(payload.includes('errors.log'))
  assert.ok(payload.includes('ERROR'))
  assert.ok(payload.includes('未收录') || payload.includes('说明'))
  assert.ok(!payload.includes('a'.repeat(24)), '复制载荷含明文凭据')
})

// ============================================================ 7. 作业
const JOB_SAMPLE = {
  job_id: 'b6b1ee5ced64',
  status: 'completed',
  created_at: '2026-09-20T21:55:49+08:00',
  started_at: '2026-09-20T21:55:52+08:00',
  finished_at: '2026-09-20T21:57:03+08:00',
  pitch: 0,
  options: { reverb: '关闭', f0_method: 'rmvpe' },
  output_path: 'D:\\codex-external\\outputs\\b6b1ee5ced64\\x.mp3',
  error: null,
  current_stage: 'done',
  progress: { percent: 100, message: 'Done' },
  notify_status: 'pending',
  metadata: { song: '底细', voice: 'Cos', retention: { status: 'active' } }
}

test('24. 作业摘要取真实字段，缺字段不编造', () => {
  const j = ls.summarizeJob(JOB_SAMPLE, 'completed')
  assert.strictEqual(j.jobId, 'b6b1ee5ced64')
  assert.strictEqual(j.song, '底细')
  assert.strictEqual(j.voice, 'Cos')
  assert.strictEqual(j.pitch, 0)
  assert.strictEqual(j.f0Method, 'rmvpe')
  assert.strictEqual(j.reverb, '关闭')
  assert.strictEqual(j.notifyStatus, 'pending')
  const bare = ls.summarizeJob({ job_id: 'aaaaaaaaaaaa' }, 'queued')
  assert.strictEqual(bare.song, '', '缺字段不得编造')
  assert.strictEqual(bare.startedAt, null)
})

test('25. 没有 job_id 的记录返回 null（不臆造标识）', () => {
  assert.strictEqual(ls.summarizeJob({ status: 'completed' }, 'completed'), null)
  assert.strictEqual(ls.summarizeJob(null, 'completed'), null)
})

test('26. 投递状态：未知时明确说未知，不默认成功', () => {
  // 本轮起文案统一为「投递：xxx」四态 + 未知（不再用「已投递/待投递」旧措辞）
  assert.strictEqual(ls.notifyLabel('sent'), '投递成功')
  assert.strictEqual(ls.notifyLabel('pending'), '等待投递')
  assert.strictEqual(ls.notifyLabel('failed'), '投递失败')
  assert.strictEqual(ls.notifyLabel('skipped'), '未投递（已跳过）')
  assert.strictEqual(ls.notifyLabel(null), '投递状态未知')
  assert.strictEqual(ls.notifyLabel('weird'), '投递状态未知')
  // 未知一律 known=false，界面据此显示"未提供该字段"
  assert.strictEqual(ls.deliveryState({ notifyStatus: null }).known, false)
  assert.strictEqual(ls.deliveryState({ notifyStatus: 'sent' }).known, true)
})

test('27. 作业时间线包含入队/开始/制作/投递，失败时含失败原因', () => {
  const j = ls.summarizeJob(JOB_SAMPLE, 'completed')
  const tl = ls.jobTimeline(j)
  const keys = tl.map(r => r.key)
  assert.ok(keys.includes('created'), '缺少「入队」节点：' + String(keys))
  assert.ok(keys.includes('started'), '缺少「开始处理」节点：' + String(keys))
  assert.ok(keys.includes('production'), '缺少「制作」节点：' + String(keys))
  assert.ok(keys.includes('delivery'), '缺少「投递」节点：' + String(keys))
  // 投递与制作必须分开：制作完成 ≠ 已送达
  assert.ok(tl.find(r => r.key === 'production').label.includes('制作完成'))
  assert.ok(tl.find(r => r.key === 'delivery').label.includes('等待投递'))
  const bad = ls.summarizeJob({ ...JOB_SAMPLE, error: 'UVR failed' }, 'failed')
  assert.ok(ls.jobTimeline(bad).some(r => r.key === 'error' && r.label.includes('UVR failed')))
})

// ============================================================ 8. 阶段
test('28. 阶段识别与汇总（含各阶段错误数）', () => {
  const recs = ls.parseLog([
    '2026-09-20 21:55:52,439 | INFO | Running command: uvr_directml.py',
    '2026-09-20 21:56:19,192 | INFO | Running command: inference_main.py',
    '2026-09-20 21:56:30,000 | ERROR | SVC failed here',
    '2026-09-20 21:57:01,056 | INFO | Running command: ffmpeg -y -i x.wav'
  ].join('\n'))
  const s = ls.stageSummary(recs)
  const byStage = Object.fromEntries(s.map(x => [x.stage, x]))
  assert.ok(byStage.UVR || byStage.SVC, '未识别出阶段')
  assert.strictEqual(byStage.SVC.errors, 1)
  assert.ok(ls.detectStage('Running command: ffmpeg ...') === 'Mixer' || ls.detectStage('nothing') === null)
})

// ============================================================ 9. 源码约束
test('29. logsources.js 为纯逻辑：无文件/进程/网络调用', () => {
  const src = readCode('logsources.js')
  assert.ok(!/require\(['"]node:fs['"]\)/.test(src), '纯逻辑模块不得依赖 fs')
  assert.ok(!/require\(['"]node:child_process['"]\)/.test(src), '不得依赖 child_process')
  assert.ok(!/require\(['"]node:net['"]\)|require\(['"]node:http/.test(src), '不得依赖网络模块')
  assert.ok(!/\bwriteFileSync\b|\bunlinkSync\b|\brmSync\b|\btruncate\b/.test(src), '不得包含写/删操作')
})

test('30. 日志 IPC 必须只读：读盘代码中不得出现写/删/截断', () => {
  const main = readCode('main.js')
  const idx = main.indexOf('console:readLogs')
  assert.ok(idx > 0, 'main.js 未实现 console:readLogs')
  // 取该 handler 到下一个 ipcMain.handle 之间的代码切片
  const rest = main.slice(idx)
  const end = rest.indexOf('ipcMain.handle', 10)
  const block = end > 0 ? rest.slice(0, end) : rest
  assert.ok(!/writeFileSync|appendFileSync|unlinkSync|rmSync|truncateSync|createWriteStream/.test(block),
    '日志读取路径出现写/删操作')
})

test('31. 日志 IPC 不得接受任意路径（必须按来源白名单解析）', () => {
  const main = readCode('main.js')
  const idx = main.indexOf('console:readLogs')
  const rest = main.slice(idx)
  const end = rest.indexOf('ipcMain.handle', 10)
  const block = end > 0 ? rest.slice(0, end) : rest
  assert.ok(/sourceById|LOG_SOURCES|resolveLogPath/.test(block), '未按来源白名单解析路径')
  assert.ok(!/path\.resolve\(String\(opts\.path/.test(block), '疑似接受 renderer 传来的任意路径')
})

// ================================================================
// 第九轮新增：时间排序 / 时间范围 / 级别解释 / 制作与投递两条轴
// ================================================================

function mkLog(lines) {
  return ls.parseLog(lines.join('\n'))
}

test('排序：默认最新在前，可切换为最早在前，无时间戳的行固定排在最后', () => {
  const recs = mkLog([
    '2026-09-20 10:00:00,000 INFO  最早',
    '2026-09-20 12:00:00,000 INFO  中间',
    '2026-09-20 11:00:00,000 INFO  次早',
    '没有时间戳的一行'
  ])
  const desc = ls.sortRecords(recs, 'desc').map(r => r.message)
  const asc = ls.sortRecords(recs, 'asc').map(r => r.message)
  assert.deepStrictEqual(desc, ['中间', '次早', '最早', '没有时间戳的一行'], String(desc))
  assert.deepStrictEqual(asc, ['最早', '次早', '中间', '没有时间戳的一行'], String(asc))
  assert.strictEqual(recs[0].message, '最早', 'sortRecords 不得修改入参数组')
})

test('时间范围：以「日志最新时间」为参考，不依赖本机当前时间', () => {
  const recs = mkLog([
    '2026-09-20 10:00:00,000 INFO  很旧',
    '2026-09-20 11:50:00,000 INFO  50 分钟前',
    '2026-09-20 11:59:00,000 INFO  1 分钟前',
    '2026-09-20 12:00:00,000 INFO  最新'
  ])
  const all = ls.filterRecords(recs, { withinMinutes: null })
  assert.strictEqual(all.length, 4)
  const last10 = ls.filterRecords(recs, { withinMinutes: 10 }).map(r => r.message)
  // 边界：11:50 恰好等于截止点，包含在内
  assert.deepStrictEqual(last10, ['50 分钟前', '1 分钟前', '最新'], String(last10))
  const last1h = ls.filterRecords(recs, { withinMinutes: 60 }).map(r => r.message)
  assert.deepStrictEqual(last1h, ['50 分钟前', '1 分钟前', '最新'], String(last1h))
  // 无时间戳的行不因时间范围被丢弃
  const recs2 = mkLog(['2026-09-20 12:00:00,000 INFO  a', '无时间戳'])
  assert.strictEqual(ls.filterRecords(recs2, { withinMinutes: 1 }).length, 2)
  // 明确传入参考时刻时以它为准：窗口 = [ref - N 分钟, ref]
  const at = t => ls.tsToMs(t)
  const byRef = ls.filterRecords(recs, { withinMinutes: 10, refMs: at('2026-09-20T12:00:00') })
    .map(r => r.message)
  assert.deepStrictEqual(byRef, ['50 分钟前', '1 分钟前', '最新'], String(byRef))
  const byRef2 = ls.filterRecords(recs, { withinMinutes: 10, refMs: at('2026-09-20T11:55:00') })
    .map(r => r.message)
  assert.deepStrictEqual(byRef2, ['50 分钟前'], String(byRef2))
  assert.strictEqual(
    ls.filterRecords(recs, { withinMinutes: 1, refMs: at('2026-09-20T10:30:00') }).length,
    0, '参考时刻早于全部记录时应没有命中（上界生效）'
  )
})

test('时间范围清单包含 10 分钟 / 1 小时 / 全部', () => {
  const ids = ls.TIME_RANGES.map(r => r.id)
  assert.deepStrictEqual(ids, ['all', '10m', '1h', '6h'], String(ids))
  assert.strictEqual(ls.timeRangeById('10m').minutes, 10)
  assert.strictEqual(ls.timeRangeById('1h').minutes, 60)
  assert.strictEqual(ls.timeRangeById('all').minutes, null)
  assert.strictEqual(ls.timeRangeById('不存在').id, 'all')
})

test('级别中文化：ERROR / WARNING / INFO 必须区分，且说明"要不要担心"', () => {
  const e = ls.levelZh('ERROR'), w = ls.levelZh('WARNING'), i = ls.levelZh('INFO')
  assert.strictEqual(e.zh, '错误')
  assert.strictEqual(w.zh, '警告')
  assert.strictEqual(i.zh, '信息')
  assert.notStrictEqual(e.zh, w.zh)
  assert.notStrictEqual(w.zh, i.zh)
  assert.notStrictEqual(e.tone, i.tone)
  assert.ok(/继续/.test(w.note), 'WARNING 应说明流程可能继续')
  assert.ok(/无需处理/.test(i.note), 'INFO 应说明通常无需处理')
  assert.strictEqual(ls.levelZh('WARN').zh, '警告', 'WARN 应归一到 WARNING')
  assert.ok(ls.levelZh('魔法').zh, '未知级别也要有可显示的名字（不得崩）')
})

test('解释按级别区分：未知的 WARNING 不得显示"未收录的错误类型"', () => {
  const unknownWarn = ls.explainMessage('这是一条谁也没见过的警告 abcdef', 'WARNING')
  assert.strictEqual(unknownWarn.known, false)
  assert.strictEqual(unknownWarn.title, '暂无解释')
  assert.ok(!/错误类型/.test(unknownWarn.title), '不得把警告说成错误类型')
  assert.ok(/警告/.test(unknownWarn.advice), '应说明这是警告的语义')

  const unknownErr = ls.explainMessage('从未见过的错误 zzzz', 'ERROR')
  assert.strictEqual(unknownErr.title, '暂无解释')
  assert.ok(!/错误类型/.test(unknownErr.title))

  const unknownInfo = ls.explainMessage('普通信息', 'INFO')
  assert.strictEqual(unknownInfo.title, '暂无解释')
  assert.ok(/无需处理/.test(unknownInfo.advice))

  // 已收录的警告类解释
  const known = ls.explainMessage('f0_method 取值不被支持，已回退默认 rmvpe', 'WARNING')
  assert.strictEqual(known.known, true)
  assert.ok(/回退默认/.test(known.title))
  // 同一句在 ERROR 级别下不应命中"警告类"条目（级别绑定）
  const sameAsError = ls.explainMessage('f0_method 取值不被支持，已回退默认 rmvpe', 'ERROR')
  assert.strictEqual(sameAsError.known, false, '警告类解释不得被当成错误解释')

  // 不限级别的条目两边都能命中
  assert.strictEqual(ls.explainMessage('SSLEOFError: EOF occurred', 'ERROR').known, true)
  assert.strictEqual(ls.explainMessage('SSLEOFError: EOF occurred', 'WARNING').known, true)
})

test('复制载荷：带级别中文，且说明为「暂无解释」时不写假的建议', () => {
  const rec = ls.parseLine('2026-09-20 12:00:00,000 WARNING 谁也没见过的警告', 1)
  const payload = ls.buildCopyPayload(rec, { sourceLabel: 'X', fileLabel: 'y.log' })
  assert.ok(payload.includes('[级别] WARNING（警告）'), payload)
  assert.ok(payload.includes('[说明] 暂无解释'), payload)
  assert.ok(!payload.includes('[建议]'), '未收录时不应给出编造的建议')
})

test('制作与投递是两条独立的轴：completed ≠ 已送达', () => {
  const completedPending = ls.jobStateView({
    jobId: 'a1b2c3d4e5f6', state: 'completed', notifyStatus: 'pending', stage: 'done'
  })
  assert.strictEqual(completedPending.production.key, 'completed')
  assert.strictEqual(completedPending.production.label, '制作完成')
  assert.strictEqual(completedPending.delivery.key, 'pending')
  assert.strictEqual(completedPending.delivery.label, '等待投递')
  assert.strictEqual(completedPending.delivered, false, 'completed 不得被判为已送达')

  const running = ls.jobStateView({ jobId: 'x', state: 'running', stage: 'svc' })
  assert.strictEqual(running.production.key, 'running')
  assert.ok(/声音转换/.test(running.production.detail), running.production.detail)

  assert.strictEqual(ls.productionState({ state: 'queued' }).key, 'queued')
  assert.strictEqual(ls.deliveryState({ notifyStatus: 'sent' }).key, 'sent')
  assert.strictEqual(ls.deliveryState({ notifyStatus: 'failed' }).key, 'failed')
  assert.strictEqual(ls.deliveryState({ notifyStatus: 'skipped' }).key, 'skipped')
})

test('投递状态未知：缺字段/未知取值都显示"未知"，不猜测', () => {
  for (const job of [{}, { notifyStatus: null }, { notifyStatus: '' }, { notifyStatus: 'weird' }]) {
    const d = ls.deliveryState(job)
    assert.strictEqual(d.key, 'unknown')
    assert.strictEqual(d.label, '投递状态未知')
    assert.strictEqual(d.known, false)
  }
  const v = ls.jobStateView({ jobId: 'z', state: 'completed' })
  assert.strictEqual(v.delivered, false)
})

test('作业时间线：投递单独一行，且缺字段时明确写出"未提供"', () => {
  const rows = ls.jobTimeline({
    jobId: 'a', state: 'completed', createdAt: '2026-09-20T12:00:00', finishedAt: '2026-09-20T12:05:00'
  })
  const labels = rows.map(r => r.label)
  assert.ok(labels.some(l => /^入队/.test(l)), String(labels))
  assert.ok(labels.some(l => /制作：制作完成/.test(l)), String(labels))
  const deliv = labels.find(l => /^投递：/.test(l))
  assert.ok(deliv && /投递：投递状态未知（作业记录未提供该字段）/.test(deliv), String(labels))
})

test('未知阶段名如实标注，不硬编造翻译', () => {
  assert.strictEqual(ls.stageZh('UVR'), '人声分离')
  assert.strictEqual(ls.stageZh('svc'), '声音转换')
  assert.ok(/未收录名称/.test(ls.stageZh('神秘阶段')), ls.stageZh('神秘阶段'))
  assert.strictEqual(ls.stageZh(''), '')
})

test('job_id 关联日志：只做子串匹配，命中不到就是 0', () => {
  const recs = mkLog([
    '2026-09-20 12:00:00,000 INFO  event=execute_start job_id=aaaaaaaaaaaa stage=UVR',
    '2026-09-20 12:01:00,000 INFO  event=stage job_id=aaaaaaaaaaaa stage=SVC',
    '2026-09-20 12:02:00,000 INFO  别的行 bbbbbbbbbbbb'
  ])
  const hit = ls.jobLogLink(recs, 'aaaaaaaaaaaa')
  assert.strictEqual(hit.matched, 2)
  assert.strictEqual(hit.first, '2026-09-20T12:00:00.000')
  assert.strictEqual(hit.last, '2026-09-20T12:01:00.000')
  assert.strictEqual(ls.jobLogLink(recs, 'ffffffffffff').matched, 0)
  assert.strictEqual(ls.jobLogLink(recs, '').matched, 0)
})

test('级别计数：真实统计，用于确认 ERROR/WARNING 有多少条', () => {
  const recs = mkLog([
    '2026-09-20 12:00:00,000 ERROR  e1',
    '2026-09-20 12:00:01,000 WARN   w1',
    '2026-09-20 12:00:02,000 INFO   i1',
    '2026-09-20 12:00:03,000 INFO   i2'
  ])
  const c = ls.levelCounts(recs)
  assert.strictEqual(c.ERROR, 1)
  assert.strictEqual(c.WARNING, 1, 'WARN 应归一为 WARNING')
  assert.strictEqual(c.INFO, 2)
})

test('折叠只作用于 INFO/DEBUG：ERROR/WARNING 再多也不折叠', () => {
  const lines = []
  for (let i = 0; i < 6; i++) lines.push(`2026-09-20 12:00:0${i},000 INFO  重复的认证心跳 job_id=aaaaaaaaaaaa`)
  for (let i = 0; i < 6; i++) lines.push(`2026-09-20 12:01:0${i},000 ERROR 重复出现的错误码 500`)
  for (let i = 0; i < 6; i++) lines.push(`2026-09-20 12:02:0${i},000 WARNING 重复出现的警告码 429`)
  const groups = ls.collapseRepeats(ls.parseLog(lines.join('\n')), { minRepeat: 3 })
  const byLevel = {}
  for (const g of groups) byLevel[g.level] = byLevel[g.level] || []
  for (const g of groups) byLevel[g.level].push(g)
  assert.strictEqual(byLevel.INFO.length, 1)
  assert.strictEqual(byLevel.INFO[0].collapsed, true)
  assert.strictEqual(byLevel.INFO[0].count, 6)
  assert.ok(byLevel.INFO[0].firstTs && byLevel.INFO[0].lastTs)
  assert.strictEqual(byLevel.INFO[0].members.length, 6, '折叠后必须保留全部原文')
  assert.strictEqual(byLevel.ERROR.length, 6, 'ERROR 不得被折叠隐藏')
  assert.strictEqual(byLevel.WARNING.length, 6, 'WARNING 不得被折叠隐藏')
  for (const g of byLevel.ERROR.concat(byLevel.WARNING)) assert.strictEqual(g.collapsed, false)
})

test('折叠+排序组合：展开后的成员顺序与列表顺序一致', () => {
  const lines = []
  for (let i = 0; i < 4; i++) lines.push(`2026-09-20 12:00:0${i},000 INFO  心跳 job_id=aaaaaaaaaaaa`)
  lines.push('2026-09-20 13:00:00,000 INFO  之后的一行')
  const recs = mkLog(lines)
  const desc = ls.collapseRepeats(ls.sortRecords(recs, 'desc'))
  const g = desc.find(x => x.count === 4)
  assert.ok(g, '应找到折叠组')
  const memberTs = g.members.map(m => m.ts)
  const sortedDesc = memberTs.slice().sort().reverse()
  assert.deepStrictEqual(memberTs, sortedDesc, '成员应按列表顺序（最新在前）')
  assert.strictEqual(desc[0].message, '之后的一行', '最新的一条应排在最前')
})

// ---------------------------------------------------------------- 汇总
console.log('='.repeat(78))
console.log('Hermes 桌面控制台 — 日志解析（纯逻辑）测试')
console.log('='.repeat(78))
console.log(results.join('\n'))
console.log('-'.repeat(78))
console.log(`通过 ${pass} 项，失败 ${fail} 项，共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
