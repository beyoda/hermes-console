/**
 * Hermes 桌面控制台 — 操作系统进程核对（主进程与看门狗共用）
 *
 * 为什么需要它：
 *   gateway_state.json / gateway.pid 可能**陈旧或损坏**，
 *   仅凭状态文件宣称"进程身份已确认"是不成立的。
 *   所有权核验必须回到操作系统层面确认：
 *     · 该 PID 是否真的存在
 *     · 该进程的**实际创建时间**是否与记录一致（防 PID 复用）
 *     · 同 profile 是否存在**多个**网关进程（官方 stop 是 profile 级，无法只停一个）
 *
 * 安全：只读查询，不发送任何信号、不结束任何进程、不读凭据。
 *
 * 平台实现：
 *   Windows —— PowerShell + CIM（Get-CimInstance Win32_Process）
 *   POSIX   —— ps（etime 换算启动时间）
 * 探测失败一律返回 ok:false —— 调用方必须据此**拒绝**危险操作。
 */

'use strict'

const { execFile } = require('node:child_process')
const path = require('node:path')

// ────────────────────────────────────────────────────────────────────────
// 网关进程判别规则（2026-09-21 实测修正）
//
// ⚠️ 旧规则只认 `hermes_cli.main`，与真实启动形式不符：
//    venv\Scripts\hermes.exe 是 **uv.Trampoline** 可执行启动器（不是
//    `python -m hermes_cli.main` 的包装），它再逐层拉起解释器。实测
//    （对 `hermes.exe --help` 采样）真实网关是 **3 层进程链**，三层命令行
//    都含 `hermes.exe … gateway run`：
//      ① hermes.exe   …\Scripts\hermes.exe --profile default gateway run
//      ② python.exe   "…\venv\Scripts\python.exe" "…\hermes.exe" --profile default gateway run
//      ③ python.exe   "…\uv\python\cpython-3.11…\python.exe" "…\hermes.exe" --profile default gateway run
//    旧规则对这条链 **0 匹配** → 身份核验恒为 process-absent → 所有权登记永远
//    失败（「运行中 / 未持有 → 停止按钮禁用」的直接根因）。
//
// ⚠️ 但**不得**用 `-match 'hermes'` 这类宽泛条件兜底，它会额外命中：
//    · 控制台自身的后端 `hermes.exe serve --host …`；
//    · 路径里带 hermes 的无关程序（electron 的 `…\hermes-agent\node_modules\…`、
//      控制台目录 `…\02-Hermes桌面控制台`）；
//    · **探测脚本自己** —— PowerShell 命令行里就写着 'hermes' 与 'gateway run'
//      两个字面量，会把 powershell.exe 当成网关。
//    因此判别式收紧为「hermes **入口** + `gateway run` 子命令 + 可执行名在
//    解释器/启动器白名单内 + 不是 serve/其它 gateway 子命令 + 不是自身」。
//
// ⚠️ 且进程数与**实例数不是一回事**：3 层链是 1 个实例。按进程数计数会把
//    单实例算成 3 → 误触「同 profile 多实例」而拒绝停止。故必须按父子链归并。
// ────────────────────────────────────────────────────────────────────────

/** 可执行名白名单：只有解释器/启动器才可能是网关（PS 粗筛与 JS 判别共用同一份源） */
const GW_PROC_NAME_SRC = '^(hermes|python|pythonw|py)(\\.exe)?$'
const GW_PROC_NAME = new RegExp(GW_PROC_NAME_SRC, 'i')

/**
 * hermes「入口」（而不是"命令行里提到 hermes"）：
 *   hermes.exe / hermes-script.py(w) / hermes_cli.main / hermes_cli/main.py
 *   / 以 hermes 结尾的路径段（POSIX 的 …/bin/hermes）
 * 注意 `…\hermes-agent\…` 这类目录名**不会**被匹配。
 */
const GW_ENTRY = /hermes(?:\.exe|-script\.pyw?|_cli[\\/.]main)|(?:^|[\s"'\\/])hermes(?=[\s"']|$)/i
/** 网关常驻子命令：gateway run（后接空白/引号/行尾） */
const GW_SUBCMD = /gateway\s+run(?=[\s"']|$)/i
/** 其它 gateway 子命令 —— 命中即排除 */
const GW_SUBCMD_OTHER = /gateway\s+(?:status|stop|restart|start|list)\b/i
/** 控制台自身的后端 serve —— 命中即排除 */
const GW_SERVE = /(?:^|[\s"'\\/])serve(?=[\s"']|$)/i

/** 兼容旧导出名（`_gwMatch`、POSIX 分支曾直接使用这两个常量） */
const GW_ARGV_MATCH = GW_ENTRY
const GW_SUBCMD_MATCH = GW_SUBCMD

/** 命令行是否描述一个**网关常驻进程**（Windows/POSIX 唯一判别实现） */
function isGatewayCmd (cmd) {
  if (typeof cmd !== 'string' || !cmd) return false
  if (!GW_ENTRY.test(cmd)) return false
  if (!GW_SUBCMD.test(cmd)) return false
  if (GW_SUBCMD_OTHER.test(cmd)) return false
  if (GW_SERVE.test(cmd)) return false
  return true
}

/** 可执行名是否可能是解释器/启动器（排除"仅在命令行文本中提到 hermes"的程序） */
function isGatewayProcName (name) {
  return GW_PROC_NAME.test(String(name == null ? '' : name).trim())
}

/** 从命令行解析实例所属 Profile（`--profile X` / `-p X`，缺省 default） */
function parseProfileFlag (cmd) {
  const s = typeof cmd === 'string' ? cmd : ''
  let m = s.match(/(?:^|\s)--profile(?:=|\s+)"?([A-Za-z0-9_.-]+)/)
  if (m) return m[1]
  m = s.match(/(?:^|\s)-p(?:=|\s+)"?([A-Za-z0-9_.-]+)/)
  if (m) return m[1]
  return 'default'
}

/**
 * 把探测到的进程按**父子关系**归并成"实例"。
 * 链根 = 父进程不在匹配集合中的那个进程（uv trampoline）。
 * 一条 3 层链 → 1 个实例；两条各自独立的链 → 2 个实例。
 * 防环：上溯最多 64 层。
 */
function mergeInstanceChains (procs) {
  const list = (Array.isArray(procs) ? procs : [])
    .filter(p => p && Number.isInteger(p.pid) && p.pid > 0)
  const byId = new Map(list.map(p => [p.pid, p]))
  const rootOf = pid => {
    let cur = byId.get(pid)
    let guard = 0
    while (cur && cur.ppid && byId.has(cur.ppid) && guard++ < 64) cur = byId.get(cur.ppid)
    return cur ? cur.pid : pid
  }
  const instances = []
  const index = new Map()
  for (const p of list) {
    const r = rootOf(p.pid)
    let inst = index.get(r)
    if (!inst) {
      const root = byId.get(r) || p
      inst = { rootPid: r, profile: root.profile || 'default', pids: [] }
      index.set(r, inst)
      instances.push(inst)
    }
    inst.pids.push(p.pid)
  }
  for (const i of instances) i.pids.sort((a, b) => a - b)
  return { instances, count: instances.length }
}

/**
 * 某 Profile 的**独立实例数**（null = 探测不可用）。
 * 用于"同 profile 单实例"核验：官方 stop 是 profile 级，因此分母必须是
 * **该 Profile 的实例数**，不能被另一个 Profile 的网关牵连。
 */
function countInstancesByProfile (instances, profileId) {
  if (!Array.isArray(instances)) return null
  if (!profileId) return null
  const id = String(profileId)
  return instances.filter(x => x && String(x.profile) === id).length
}

/**
 * 判别 + 归并（Windows / POSIX 共用，保证两侧规则完全一致）。
 * ⚠️ 只保留判别所需信息，**不把命令行原文带进返回结构**（不落盘、不进日志）。
 * @returns {{ok:true, count:number, matched:number, procs:Array, instances:Array}}
 */
function finalizeProbe (raw) {
  const procs = []
  for (const p of (Array.isArray(raw) ? raw : [])) {
    if (!p) continue
    const pid = Number(p.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!isGatewayProcName(p.name)) continue
    if (!isGatewayCmd(p.cmd)) continue
    const ppid = Number(p.ppid)
    procs.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      startMs: typeof p.startMs === 'number' ? p.startMs : null,
      profile: parseProfileFlag(p.cmd)
    })
  }
  const { instances, count } = mergeInstanceChains(procs)
  return { ok: true, count, matched: procs.length, procs, instances }
}

/** 结果缓存：一次核验内避免重复启动 PowerShell（约 1s 开销） */
const CACHE_TTL_MS = 1500
let _cache = { at: 0, value: null }

function runFile(file, args, timeoutMs = 25000) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    try {
      const child = execFile(file, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024
      }, (err, stdout, stderr) => {
        finish({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null })
      })
      child.on('error', e => finish({ ok: false, stdout: '', stderr: '', error: e.message }))
    } catch (e) {
      finish({ ok: false, stdout: '', stderr: '', error: e.message })
    }
  })
}

// ---------------------------------------------------------------- Windows

/**
 * 单行 PowerShell 脚本（用 ';' 分隔语句，避免跨行引号问题）。
 * 语义：
 *   1. 粗筛：可执行名在解释器/启动器白名单内，且**排除探测自身**（$PID）
 *      —— 本脚本命令行里含 'hermes' / 'gateway run' 字面量，不排除会自匹配
 *   2. 输出每个候选的 pid / ppid / 可执行名 / 创建时间 / 命令行原文
 *      （命令行只用于 JS 侧判别与 Profile 解析，**不进入返回结构或日志**）
 *   3. 逐个取**操作系统实际创建时间**（Unix 毫秒）；取不到则为 null
 *      —— 由核验层据此拒绝，而不是默默用状态文件的时间顶替
 */
const PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$c=@(Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and ($_.Name -match '" + GW_PROC_NAME_SRC + "') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine)",
  "$r=@()",
  "foreach($p in $c){ $s=$null; try{$s=([DateTimeOffset](Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()}catch{}; $r+=[pscustomobject]@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;name=$p.Name;startMs=$s;cmd=$p.CommandLine} }",
  "ConvertTo-Json -InputObject @{count=$r.Count;procs=@($r)} -Compress -Depth 4"
].join(';')

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function listWindows() {
  const r = await runFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT])
  if (!r.ok) return { ok: false, error: r.error || r.stderr.slice(0, 300) }
  const txt = r.stdout.trim()
  if (!txt) return finalizeProbe([])
  let j
  try { j = JSON.parse(txt) } catch (e) {
    return { ok: false, error: 'PowerShell 输出无法解析: ' + e.message }
  }
  const raw = Array.isArray(j.procs) ? j.procs : (j.procs ? [j.procs] : [])
  return finalizeProbe(raw)
}

// ---------------------------------------------------------------- POSIX

/** 从 `ps args` 的 argv[0] 取可执行名（POSIX 上命令名才是"入口"证据） */
function procNameFromArgv (args) {
  const s = String(args || '').trim()
  const m = s.match(/^"([^"]*)"|^(\S+)/)
  const first = (m && (m[1] || m[2])) || ''
  return first.split(/[\\/]/).pop() || ''
}

async function listPosix() {
  // etimes = 已运行秒数 → 启动时间 = now - etimes*1000（不依赖 locale 时间格式）
  // ppid 用于把"同一实例的多层进程"归并成 1（与 Windows 侧判别规则完全一致）
  const r = await runFile('ps', ['-A', '-o', 'pid=,ppid=,etimes=,args='])
  if (!r.ok) return { ok: false, error: r.error || r.stderr.slice(0, 300) }
  const now = Date.now()
  const raw = []
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    raw.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: procNameFromArgv(m[4]),
      startMs: now - Number(m[3]) * 1000,
      cmd: m[4]
    })
  }
  return finalizeProbe(raw)
}

// ---------------------------------------------------------------- 对外接口

/**
 * 列出当前所有网关**实例**（已按父子链归并）。
 * @param {{force?:boolean}} opts
 * @returns {Promise<{ok:boolean, count?:number, matched?:number,
 *   procs?:Array<{pid:number,ppid:number|null,startMs:number|null,profile:string}>,
 *   instances?:Array<{rootPid:number,profile:string,pids:number[]}>, error?:string}>}
 *   · count  = **实例数**（链根数），不是进程数（多层链算 1）；
 *   · procs  = 全部匹配进程（供按 PID 精确核验身份）；
 *   · ok:false → 探测失败，调用方必须据此拒绝危险操作（与"确认不存在"区分）。
 */
async function probeGatewayProcesses(opts = {}) {
  const now = Date.now()
  if (!opts.force && _cache.value && (now - _cache.at) < CACHE_TTL_MS) return _cache.value

  let res
  try {
    res = process.platform === 'win32' ? await listWindows() : await listPosix()
  } catch (e) {
    res = { ok: false, error: '探测异常: ' + e.message }
  }
  _cache = { at: now, value: res }
  return res
}

/** 清空缓存（测试用；正常流程不需要） */
function resetCache() { _cache = { at: 0, value: null } }

/**
 * 构造停止前置核验所需的 ctx。
 *
 * ⚠️ force=true 用于**危险操作前的最后一次探测**：绕过 CACHE_TTL_MS 缓存，
 *    确保"检查"与"执行"之间的时间窗口尽可能小。
 *    注意这只**缩小**竞态窗口，**不能消除**它 —— 官方 stop 是 profile 级、
 *    无 PID 参数，检查与执行之间同 profile 新出现的实例仍会被一并停止。
 *
 * ★ 探测失败与"确认不存在"必须区分：
 *     probeError !== null → 探测异常（instanceCount / instances 为 null）→ 调用方拒绝；
 *     probeError === null 且 instanceCount === 0 → 确认此刻没有网关实例。
 *
 * @param {object|null} current 当前实测身份（来自状态文件）
 * @param {{force?:boolean}} opts
 * @returns {Promise<{instanceCount:number|null, byProfile:object|null, proc:object|null,
 *   probeError:string|null, all:Array, instances:Array|null, matched:number|null}>}
 */
async function buildVerifyContext(current, opts = {}) {
  const pr = await probeGatewayProcesses({ force: !!opts.force })
  if (!pr.ok) {
    return {
      instanceCount: null, byProfile: null, proc: null,
      probeError: pr.error || '进程探测失败', all: [], instances: null, matched: null
    }
  }
  const pid = current && typeof current.pid === 'number' ? current.pid : null
  const entry = pid === null ? null : pr.procs.find(p => p.pid === pid)
  const byProfile = {}
  for (const inst of (pr.instances || [])) {
    byProfile[inst.profile] = (byProfile[inst.profile] || 0) + 1
  }
  return {
    instanceCount: pr.count,        // 全局实例数（链根数）
    byProfile,                      // 按 Profile 的实例数（各 Profile 互不牵连）
    proc: entry ? { exists: true, startMs: entry.startMs } : { exists: false, startMs: null },
    probeError: null,
    all: pr.procs,                  // 全部匹配进程（按 PID 精确核验身份用）
    instances: pr.instances,
    matched: pr.matched
  }
}

module.exports = {
  probeGatewayProcesses,
  buildVerifyContext,
  resetCache,
  // 供单测使用的纯逻辑
  isGatewayCmd,
  isGatewayProcName,
  parseProfileFlag,
  mergeInstanceChains,
  countInstancesByProfile,
  finalizeProbe,
  _parseWindows: listWindows,
  _parsePosix: listPosix,
  _psScript: PS_SCRIPT,
  _gwMatch: isGatewayCmd
}
