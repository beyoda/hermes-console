/**
 * Hermes 桌面控制台 — 网关进程探测（process-probe）隔离回归测试
 *
 * 运行：node tests/process-probe.test.js
 *
 * ⚠️ 安全边界：**不启动、不停止、不接管任何真实网关**。
 *    · 纯函数部分：完全离线；
 *    · [F]/[G] 部分：只对**当前已在运行的**进程做只读查询（Get-CimInstance），
 *      不发送任何信号、不结束任何进程、不读凭据；
 *      若环境里没有真实网关在跑，相应断言标记 SKIP（绝不伪造成功）。
 *
 * 覆盖（对应本轮修复要求）：
 *   [A] 真实 `hermes.exe … gateway run` 形态可识别（含 uv trampoline 3 层链），
 *       同时保留 `python -m hermes_cli.main … gateway run` 与 POSIX 形式
 *   [B] 反例必须全部排除：控制台自身 serve、其它 gateway 子命令、
 *       探测脚本自身、路径/文本里提到 hermes 的无关程序、同名家族 CLI
 *   [C] 实例归并：多层进程链 = 1 个实例；两条独立链 = 2 个实例；不丢进程
 *   [D] default 与 Extra 的所有权互不覆盖（按 Profile 计数）
 *   [E] 探测失败与"确认不存在"必须区分
 *   [F] 真实 OS 探测端到端一致性（JS 判别 == 最终结果；serve/electron 不得混入）
 *   [G] 与 ownership 纯核验集成（登记与停止共用同一份探测数据）
 *   [H] 静态防回退约束
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const probe = require('../process-probe')
const own = require('../ownership')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
async function testAsync (name, fn) {
  try {
    const r = await fn()
    if (r === false) return            // fn 内部已 push [SKIP]，不计入通过
    pass++; results.push(`  [PASS] ${name}`)
  } catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
const skip = why => results.push(`  [SKIP] ${why}`)
const readCode = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

/** 真实环境的可执行文件位置（来自实测） */
const HERMES_EXE = process.env.HERMES_CONSOLE_TEST_HERMES_EXE
  || 'C:\\Users\\<you>\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'
const VENV_PY = 'D:\hermes-home\\hermes-agent\\venv\\Scripts\\python.exe'
const UV_PY = 'C:\\Users\\<you>\\AppData\\Roaming\\uv\\python\\cpython-3.11-windows-x86_64-none\\python.exe'
const HOME_DEFAULT = 'D:\hermes-home'
const HOME_EXTRA = 'D:\hermes-home\\profiles\\extra'

/** 2026-09-21 对真实网关 `hermes.exe --profile default gateway run` 采样得到的 3 层链 */
const REAL_GW = [
  `${HERMES_EXE} --profile default gateway run`,
  `"${VENV_PY}" "${HERMES_EXE}" --profile default gateway run`,
  `"${UV_PY}"  "${HERMES_EXE}" --profile default gateway run`
]
/** 同一时刻真实存在的控制台后端（必须排除） */
const REAL_SERVE = [
  `${HERMES_EXE} serve --host 127.0.0.1 --port 0`,
  `"${VENV_PY}" "${HERMES_EXE}" serve --host 127.0.0.1 --port 0`,
  `"${UV_PY}"  "${HERMES_EXE}" serve --host 127.0.0.1 --port 0`
]

/** 完整判定路径：可执行名白名单 + 命令行判别（两者同时成立才算网关进程） */
const identified = (name, cmd) => probe.isGatewayProcName(name) && probe.isGatewayCmd(cmd)

;(async () => {
  // ================================================================ [A] 正向
  console.log('\n[A] 真实启动形态可识别（正向）')
  for (const cmd of REAL_GW) {
    test(`[A] 真实网关命令行（…${cmd.slice(-44)}）`, () => {
      assert.strictEqual(probe.isGatewayCmd(cmd), true)
    })
  }
  test('[A] 保留 Python 模块启动形式（-m hermes_cli.main … gateway run）', () => {
    assert.strictEqual(probe.isGatewayCmd(`${VENV_PY} -m hermes_cli.main --profile default gateway run`), true)
    assert.strictEqual(probe.isGatewayCmd(`"${VENV_PY}" -m hermes_cli.main gateway run`), true)
    assert.strictEqual(probe.isGatewayCmd('pythonw.exe -m hermes_cli.main gateway run'), true)
  })
  test('[A] 保留 POSIX 形式（…/bin/hermes … gateway run）', () => {
    assert.strictEqual(probe.isGatewayCmd('/usr/local/bin/hermes --profile default gateway run'), true)
    assert.strictEqual(probe.isGatewayCmd('python3 /opt/venv/bin/hermes --profile extra gateway run'), true)
  })
  test('[A] 可执行名白名单：hermes / python / pythonw / py', () => {
    for (const n of ['hermes.exe', 'hermes', 'python.exe', 'pythonw.exe', 'py.exe', 'PYTHON.EXE']) {
      assert.strictEqual(probe.isGatewayProcName(n), true, n)
    }
  })

  // ================================================================ [B] 反向
  console.log('\n[B] 必须排除的形态（反向）')
  for (const cmd of REAL_SERVE) {
    test(`[B] 控制台自身后端 serve（…${cmd.slice(-38)}）`, () => {
      assert.strictEqual(probe.isGatewayCmd(cmd), false, 'serve 不得被当成网关')
      assert.strictEqual(identified('hermes.exe', cmd), false)
    })
  }
  test('[B] 其它 gateway 子命令（status/stop/restart/start/list）一律排除', () => {
    for (const sub of ['status', 'stop', 'restart', 'start', 'list']) {
      const cmd = `${HERMES_EXE} --profile default gateway ${sub}`
      assert.strictEqual(probe.isGatewayCmd(cmd), false, `gateway ${sub} 不得被当成 gateway run`)
    }
  })
  test('[B] 控制台自身（electron 主进程 / 渲染子进程）不得被识别', () => {
    const cases = [
      ['electron.exe', '"D:\hermes-home\\hermes-agent\\node_modules\\electron\\dist\\electron.exe"  "D:\dev\hermes-console\\02-Hermes桌面控制台"'],
      ['electron.exe', '"D:\hermes-home\\hermes-agent\\node_modules\\electron\\dist\\electron.exe" --type=renderer --app-path="D:\dev\hermes-console\\02-Hermes桌面控制台"']
    ]
    for (const [name, cmd] of cases) {
      assert.strictEqual(probe.isGatewayProcName(name), false, 'electron 不在白名单')
      assert.strictEqual(identified(name, cmd), false, '路径里带 hermes 不等于 hermes 入口')
    }
  })
  test('[B] 探测脚本自身（PowerShell 命令行含 hermes / gateway run 字面量）不得被识别', () => {
    const self = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive '
      + '-Command "$ErrorActionPreference=\'SilentlyContinue\';$c=@(Get-CimInstance Win32_Process | '
      + 'Where-Object { $_.CommandLine -match \'hermes\' -and $_.CommandLine -match \'gateway\\s+run\' })"'
    assert.strictEqual(probe.isGatewayProcName('powershell.exe'), false)
    assert.strictEqual(identified('powershell.exe', self), false, '探测自身不得被采集为网关')
    // PS 脚本必须显式排除自身 PID
    assert.ok(/\$_\.ProcessId\s+-ne\s+\$PID/.test(probe._psScript), 'PS 脚本必须排除 $PID')
  })
  test('[B] 仅在文本/参数里提到 Hermes 的程序不得被识别', () => {
    const cases = [
      ['notepad.exe', 'C:\\Windows\\System32\\notepad.exe D:\\notes\\hermes gateway run.txt'],
      ['cmd.exe', 'cmd.exe /c start "" cmd.exe /k "C:\\x\\hermes.exe --profile default gateway run"'],
      ['node.exe', 'node.exe script.js hermes gateway run'],
      ['explorer.exe', 'explorer.exe "D:\dev\hermes-console"'],
      ['python.exe', 'python.exe -c "import hermes" gateway runner.py']
    ]
    for (const [name, cmd] of cases) {
      assert.strictEqual(identified(name, cmd), false, `${name} 不得被识别为网关`)
    }
  })
  test('[B] 同名家族的其它 CLI（hermes-agent.exe / hermes-acp.exe）不得被识别', () => {
    for (const n of ['hermes-agent.exe', 'hermes-acp.exe', 'hermes.exe.old']) {
      assert.strictEqual(probe.isGatewayProcName(n), false, n)
      assert.strictEqual(identified(n, `C:\\x\\${n} --help`), false, n)
    }
  })
  test('[B] shell / 宿主进程一律不在白名单', () => {
    for (const n of ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'conhost.exe', 'node.exe', 'wsl.exe']) {
      assert.strictEqual(probe.isGatewayProcName(n), false, n)
    }
  })

  // ================================================================ [C] 归并
  console.log('\n[C] 实例归并（多层进程链 = 1 个实例）')
  const chain = [
    { pid: 432, ppid: 16904, startMs: 1, profile: 'default' },
    { pid: 37488, ppid: 432, startMs: 2, profile: 'default' },
    { pid: 9904, ppid: 37488, startMs: 3, profile: 'default' }
  ]
  test('[C] 3 层链 → 1 个实例，链根为最外层 trampoline', () => {
    const r = probe.mergeInstanceChains(chain)
    assert.strictEqual(r.count, 1, `应为 1 个实例，实际 ${r.count}`)
    assert.strictEqual(r.instances[0].rootPid, 432)
    assert.deepStrictEqual(r.instances[0].pids, [432, 9904, 37488])
  })
  test('[C] 输入顺序打乱不影响归并结果', () => {
    for (const perm of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
      const r = probe.mergeInstanceChains(perm.map(i => chain[i]))
      assert.strictEqual(r.count, 1)
      assert.strictEqual(r.instances[0].rootPid, 432)
    }
  })
  test('[C] 不丢进程：所有输入进程都必须落在某个实例中', () => {
    const r = probe.mergeInstanceChains(chain)
    const got = r.instances.flatMap(i => i.pids).sort((a, b) => a - b)
    assert.deepStrictEqual(got, [432, 9904, 37488])
  })
  test('[C] 两条各自独立的链 → 2 个实例（真正的多实例必须被发现）', () => {
    const two = chain.concat([
      { pid: 5000, ppid: 1, startMs: 4, profile: 'default' },
      { pid: 5001, ppid: 5000, startMs: 5, profile: 'default' }
    ])
    const r = probe.mergeInstanceChains(two)
    assert.strictEqual(r.count, 2, `应发现 2 个独立实例，实际 ${r.count}`)
    assert.deepStrictEqual(r.instances.map(i => i.rootPid).sort((a, b) => a - b), [432, 5000])
  })
  test('[C] 父进程已退出（ppid 不在集合里）→ 该进程自身即链根', () => {
    const r = probe.mergeInstanceChains([{ pid: 7000, ppid: 999999, startMs: 1, profile: 'default' }])
    assert.strictEqual(r.count, 1)
    assert.strictEqual(r.instances[0].rootPid, 7000)
  })
  test('[C] 空输入 → 0 个实例', () => {
    const r = probe.mergeInstanceChains([])
    assert.strictEqual(r.count, 0)
    assert.deepStrictEqual(r.instances, [])
  })
  test('[C] 相互引用（异常数据）不得死循环，且不丢进程', () => {
    const r = probe.mergeInstanceChains([
      { pid: 8001, ppid: 8002, startMs: 1, profile: 'default' },
      { pid: 8002, ppid: 8001, startMs: 1, profile: 'default' }
    ])
    assert.ok(r.count >= 1 && r.count <= 2, `异常数据下实例数应保守合理，实际 ${r.count}`)
    assert.strictEqual(r.instances.reduce((s, i) => s + i.pids.length, 0), 2)
  })

  // ================================================================ [D] Profile 隔离
  console.log('\n[D] default 与 Extra 的所有权互不覆盖')
  const mixed = chain.concat([{ pid: 6001, ppid: 1, startMs: 9, profile: 'extra' }])
  test('[D] 两侧同时在线：default=1、extra=1（全局=2，互不覆盖）', () => {
    const { instances, count } = probe.mergeInstanceChains(mixed)
    assert.strictEqual(count, 2)
    assert.strictEqual(probe.countInstancesByProfile(instances, 'default'), 1)
    assert.strictEqual(probe.countInstancesByProfile(instances, 'extra'), 1)
  })
  test('[D] 只有 default 在线：extra 计数为 0（不被牵连）', () => {
    const { instances } = probe.mergeInstanceChains(mixed.filter(p => p.profile === 'default'))
    assert.strictEqual(probe.countInstancesByProfile(instances, 'default'), 1)
    assert.strictEqual(probe.countInstancesByProfile(instances, 'extra'), 0)
  })
  test('[D] Extra 的多层链不会被算进 default 的实例数', () => {
    const both = chain.concat([
      { pid: 6100, ppid: 1, startMs: 9, profile: 'extra' },
      { pid: 6101, ppid: 6100, startMs: 9, profile: 'extra' },
      { pid: 6102, ppid: 6101, startMs: 9, profile: 'extra' }
    ])
    const { instances, count } = probe.mergeInstanceChains(both)
    assert.strictEqual(count, 2, '两个 Profile 各 1 个实例')
    assert.strictEqual(probe.countInstancesByProfile(instances, 'default'), 1)
    assert.strictEqual(probe.countInstancesByProfile(instances, 'extra'), 1)
  })
  test('[D] 探测不可用（instances 为 null）→ 计数为 null，调用方必须 fail-closed', () => {
    assert.strictEqual(probe.countInstancesByProfile(null, 'default'), null)
    assert.strictEqual(probe.countInstancesByProfile(undefined, 'default'), null)
  })
  test('[D] Profile 解析：--profile X / --profile=X / -p X / 缺省 default', () => {
    assert.strictEqual(probe.parseProfileFlag(`${HERMES_EXE} --profile extra gateway run`), 'extra')
    assert.strictEqual(probe.parseProfileFlag(`${HERMES_EXE} --profile=extra gateway run`), 'extra')
    assert.strictEqual(probe.parseProfileFlag(`${HERMES_EXE} -p extra gateway run`), 'extra')
    assert.strictEqual(probe.parseProfileFlag(`${HERMES_EXE} gateway run`), 'default')
  })

  // ================================================================ [E] 失败 vs 不存在
  console.log('\n[E] 探测失败与"确认不存在"必须区分')
  test('[E] 空候选 → 明确表达"确认无实例"（ok:true, count:0）', () => {
    const r = probe.finalizeProbe([])
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.count, 0)
    assert.strictEqual(r.matched, 0)
  })
  test('[E] 候选里只有 serve / 无关进程 → 过滤后 count=0（是"没有实例"，不是探测失败）', () => {
    const r = probe.finalizeProbe([
      { pid: 36640, ppid: 1, name: 'hermes.exe', startMs: 1, cmd: REAL_SERVE[0] },
      { pid: 16904, ppid: 1, name: 'electron.exe', startMs: 1, cmd: 'electron.exe "D:\dev\hermes-console"' }
    ])
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.count, 0)
    assert.strictEqual(r.matched, 0)
  })
  test('[E] 探测失败路径返回 ok:false（不得被当作"没有进程"）', () => {
    const src = readCode('process-probe.js')
    assert.ok(/if\s*\(!r\.ok\)\s*return\s*\{\s*ok:\s*false/.test(src), 'listWindows/listPosix 失败必须返回 ok:false')
    assert.ok(/res\s*=\s*\{\s*ok:\s*false,\s*error:\s*'探测异常: '/.test(src), '异常必须被捕获为 ok:false')
  })
  test('[E] buildVerifyContext：探测失败 → probeError 非空且 instanceCount=null', () => {
    const src = readCode('process-probe.js')
    assert.ok(/probeError:\s*pr\.error\s*\|\|\s*'进程探测失败'/.test(src))
    assert.ok(/instanceCount:\s*null,\s*byProfile:\s*null,\s*proc:\s*null/.test(src))
  })
  test('[E] 探测结果不含命令行原文（只保留 pid/ppid/startMs/profile）', () => {
    const r = probe.finalizeProbe([
      { pid: 1, ppid: 2, name: 'python.exe', startMs: 3, cmd: REAL_GW[0], secret: 'x' }
    ])
    assert.deepStrictEqual(Object.keys(r.procs[0]).sort(), ['pid', 'ppid', 'profile', 'startMs'])
  })

  // ================================================================ [F] 真实 OS 探测
  console.log('\n[F] 真实操作系统探测（只读；不启动/停止任何网关）')
  let live = null
  await testAsync('[F] probeGatewayProcesses 返回结构完整（真实 PowerShell 只读探测）', async () => {
    probe.resetCache()
    live = await probe.probeGatewayProcesses({ force: true })
    if (!live.ok) throw new Error(`探测失败: ${live.error}`)
    assert.ok(Array.isArray(live.procs), 'procs 必须是数组')
    assert.ok(Array.isArray(live.instances), 'instances 必须是数组')
    assert.strictEqual(typeof live.count, 'number')
    assert.strictEqual(live.count, live.instances.length, 'count 必须等于实例数（链根数）')
    assert.ok(live.matched >= live.count, 'matched（进程数）不得小于实例数')
  })

  await testAsync('[F] 真实一致性：模块结果 == 全量进程经同一判别式过滤后的结果', async () => {
    if (!live || !live.ok) { skip('探测不可用，跳过真实一致性对比'); return false }
    const all = await rawCandidates()
    if (!all.length) { skip('未能取到全量进程快照，跳过真实一致性对比'); return false }
    const expect = all
      .filter(p => probe.isGatewayProcName(p.name) && probe.isGatewayCmd(p.cmd))
      .map(p => p.pid)
      .sort((a, b) => a - b)
    const got = live.procs.map(p => p.pid).sort((a, b) => a - b)
    assert.deepStrictEqual(got, expect, '探测结果必须与全量进程经同一判别式的过滤结果完全一致')
  })

  await testAsync('[F] 真实证据：控制台自身的 hermes.exe serve 进程不得混入探测结果', async () => {
    if (!live || !live.ok) { skip('探测不可用，跳过 serve 排除验证'); return false }
    const all = await rawCandidates()
    const serveProcs = all.filter(p => probe.isGatewayProcName(p.name) && /serve/i.test(p.cmd || ''))
    if (!serveProcs.length) { skip('当前环境没有 serve 进程（无法做真实排除验证）'); return false }
    for (const s of serveProcs) {
      assert.ok(!live.procs.some(x => x.pid === s.pid), `serve 进程 pid=${s.pid} 不得进入探测结果`)
    }
    results.push(`  [INFO] 已排除 ${serveProcs.length} 个真实 serve 进程（pid ${serveProcs.map(p => p.pid).join(',')}）`)
  })

  await testAsync('[F] 真实证据：electron 控制台进程（命令行含 hermes 路径与中文目录）不得混入', async () => {
    if (!live || !live.ok) { skip('探测不可用，跳过 electron 排除验证'); return false }
    const all = await rawCandidates()
    const el = all.filter(p => /^electron(\.exe)?$/i.test(p.name || ''))
    if (!el.length) { skip('当前环境没有 electron 进程（无法做真实排除验证）'); return false }
    for (const p of el) {
      assert.strictEqual(probe.isGatewayProcName(p.name), false, `electron 不得进入候选（pid=${p.pid}）`)
      assert.ok(!live.procs.some(x => x.pid === p.pid), `electron pid=${p.pid} 不得出现在探测结果`)
    }
    results.push(`  [INFO] 已排除 ${el.length} 个真实 electron 进程`)
  })

  await testAsync('[F] 真实证据：若真实网关在跑，多层链必须归并为 1 个实例', async () => {
    if (!live || !live.ok) { skip('探测不可用，跳过真实归并验证'); return false }
    const gwProcs = live.procs.filter(p => p.profile === 'default')
    if (!gwProcs.length) { skip('当前没有 default 网关在运行（无法做真实归并验证）'); return false }
    const insts = live.instances.filter(i => i.profile === 'default')
    assert.strictEqual(insts.length, 1, `default 应有 1 个实例，实际 ${insts.length}`)
    assert.strictEqual(insts[0].pids.length, gwProcs.length, '实例必须涵盖该链的全部进程')
    for (const p of gwProcs) {
      assert.ok(insts[0].pids.includes(p.pid), `实例必须包含进程 pid=${p.pid}`)
    }
    results.push(`  [INFO] 真实 default 网关链包含 ${gwProcs.length} 个进程 → 归并为 1 个实例（root pid=${insts[0].rootPid}）`)
  })

  // ================================================================ [G] 与所有权核验集成
  console.log('\n[G] 与所有权核验集成（登记与停止共用同一份探测数据）')

  /** 取"真实在跑的 default 网关身份 + 探测上下文"，拿不到则返回 null（SKIP，不伪造） */
  async function liveDefault () {
    const ident = own.readIdentity(HOME_DEFAULT)
    if (!ident) return null
    probe.resetCache()
    const ctx = await probe.buildVerifyContext(ident, { force: true })
    if (ctx.probeError) return null
    if (!ctx.all.some(x => Number(x.pid) === Number(ident.pid))) return null
    return { ident, ctx }
  }

  await testAsync('[G] 正向：真实网关身份 + OS 探测 + 单实例 → verifyProfileIdentity 通过', async () => {
    const d = await liveDefault()
    if (!d) { skip('当前没有可信的真实 default 网关在跑（无法做真实正向核验）'); return false }
    const n = probe.countInstancesByProfile(d.ctx.instances, 'default')
    const r = own.verifyProfileIdentity({
      identity: d.ident, profileHome: HOME_DEFAULT, procs: d.ctx.all, instanceCount: n
    })
    assert.strictEqual(r.ok, true, `应通过核验，实际 ${r.reason}`)
    assert.strictEqual(r.reason, 'verified')
    results.push(`  [INFO] 真实核验通过：pid=${d.ident.pid}（同 Profile 实例数=${n}）`)
  })

  await testAsync('[G] 反向：Profile Home 不一致（跨 Profile 串台）→ profile-mismatch 拒绝', async () => {
    const d = await liveDefault()
    if (!d) { skip('无真实网关在跑（跳过 Profile 不一致反向验证）'); return false }
    const r = own.verifyProfileIdentity({
      identity: d.ident, profileHome: HOME_EXTRA, procs: d.ctx.all, instanceCount: 1
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'profile-mismatch')
  })

  await testAsync('[G] 反向：PID 复用（创建时间与 OS 实测不符）→ process-mismatch 拒绝', async () => {
    const d = await liveDefault()
    if (!d) { skip('无真实网关在跑（跳过 PID 复用反向验证）'); return false }
    const entry = d.ctx.all.find(x => Number(x.pid) === Number(d.ident.pid))
    const r = own.verifyProfileIdentity({
      identity: { ...d.ident, startMs: entry.startMs + 120000 },
      profileHome: HOME_DEFAULT, procs: d.ctx.all, instanceCount: 1
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'process-mismatch')
  })

  await testAsync('[G] 反向：身份 PID 不在 OS 探测结果中 → process-absent 拒绝', async () => {
    const d = await liveDefault()
    if (!d) { skip('无真实网关在跑（跳过 process-absent 反向验证）'); return false }
    const r = own.verifyProfileIdentity({
      identity: { ...d.ident, pid: 999999 },
      profileHome: HOME_DEFAULT, procs: d.ctx.all, instanceCount: 1
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'process-absent')
  })

  await testAsync('[G] 反向：同 Profile 出现第 2 个实例 → multiple-instances 拒绝', async () => {
    const d = await liveDefault()
    if (!d) { skip('无真实网关在跑（跳过 multiple-instances 反向验证）'); return false }
    const r = own.verifyProfileIdentity({
      identity: d.ident, profileHome: HOME_DEFAULT, procs: d.ctx.all, instanceCount: 2
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'multiple-instances')
  })

  await testAsync('[G] 反向：探测不可用（实例数未知）→ instance-count-unknown 拒绝', async () => {
    const ident = own.readIdentity(HOME_DEFAULT) || { pid: 1, startMs: 1, hermesHome: HOME_DEFAULT }
    const r = own.verifyProfileIdentity({
      identity: ident, profileHome: HOME_DEFAULT, procs: [{ pid: ident.pid, startMs: ident.startMs }], instanceCount: null
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'instance-count-unknown')
  })

  await testAsync('[G] 授权门：A 态停止的 ctx.proc 必须是 { exists, startMs }（结构对齐）', async () => {
    const d = await liveDefault()
    if (!d) { skip('无真实网关在跑（跳过授权门结构验证）'); return false }
    assert.ok(d.ctx.proc && d.ctx.proc.exists === true, 'ctx.proc.exists 必须为 true')
    assert.strictEqual(typeof d.ctx.proc.startMs, 'number')
    const gate = own.createGate({})
    const dec = gate.decide('stop', d.ident, d.ident, null, {
      proc: d.ctx.proc,
      instanceCount: probe.countInstancesByProfile(d.ctx.instances, 'default')
    })
    assert.strictEqual(dec.allowed, true, `A 态停止应放行，实际 ${dec.reason}`)
    assert.strictEqual(dec.via, 'ownership')
    results.push('  [INFO] A 态停止在实际探测数据上可放行（未真正执行 stop）')
  })

  // ================================================================ [H] 静态防回退
  console.log('\n[H] 静态防回退（源码约束）')
  test('[H] 旧规则（只匹配 hermes_cli.main）已不再作为唯一判别', () => {
    const src = readCode('process-probe.js')
    assert.ok(!/CommandLine\s+-match\s*'hermes_cli\\\\\.main'/.test(src), 'PS 脚本不得再只匹配 hermes_cli.main')
  })
  test('[H] 不得使用宽泛的 -match \'hermes\' 作为判别条件', () => {
    const src = readCode('process-probe.js')
    assert.ok(!/CommandLine\s+-match\s*'hermes'/.test(src), "不得出现 -match 'hermes' 这类宽泛条件")
    assert.ok(!/GW_ENTRY\s*=\s*\/hermes\/i/.test(src), '判别正则不得退化为裸 /hermes/i')
  })
  test('[H] PS 脚本必须：排除自身 + 名字白名单粗筛 + 输出 ppid 供归并', () => {
    const ps = probe._psScript
    assert.ok(/\$_\.ProcessId\s+-ne\s+\$PID/.test(ps), '必须排除探测自身')
    assert.ok(ps.includes('^(hermes|python|pythonw|py)(\\.exe)?$'), '必须做可执行名白名单粗筛')
    assert.ok(/ppid=\[int\]\$p\.ParentProcessId/.test(ps), '必须输出 ppid')
  })
  test('[H] 探测模块仍为只读（不含 taskkill / Stop-Process / kill）', () => {
    const src = readCode('process-probe.js')
    assert.ok(!/taskkill|Stop-Process|TerminateProcess|\bkill\(/i.test(src))
  })
  test('[H] main.js：停止后复核使用"按 Profile 的实例数"（不是全局计数）', () => {
    const src = readCode('main.js')
    assert.ok(/sameProfileProcesses\s*=\s*profileInstanceCount\(ctx,\s*prof\.id\)/.test(src),
      '停止后复核必须按 Profile 计数')
  })
  test('[H] main.js：授权门收到的 proc 必须是 ctx.proc（含 exists）', () => {
    const src = readCode('main.js')
    assert.ok(/proc:\s*ctx\.proc\s*\|\|\s*null/.test(src), '必须传 ctx.proc')
    assert.ok(!/proc:\s*\(ctx\.all\s*\|\|\s*\[\]\)\.find/.test(src), '不得把 all 的原始元素当 proc 传')
  })
  test('[H] main.js：登记与所有权核验统一走 profileInstanceCount', () => {
    const src = readCode('main.js')
    assert.ok(/function\s+profileInstanceCount\s*\(/.test(src), '必须定义 profileInstanceCount')
    assert.ok(!/own\.countProfileInstances\(/.test(src), '不得再按 PID 计数当作实例数')
    // 定义处写作 `profileInstanceCount (ctx, …)`（带空格），不计入调用点
    const hits = (src.match(/[^a-zA-Z]profileInstanceCount\(/g) || []).length
    assert.ok(hits >= 3, `登记 / 所有权核验 / 停止后复核共需 ≥3 处调用，实际 ${hits}`)
  })
  test('[H] watchdog 仍通过同一模块做核验（未绕过）', () => {
    const src = readCode('watchdog.js')
    assert.ok(/require\(['"]\.\/process-probe['"]\)/.test(src))
    assert.ok(/buildVerifyContext\(cur,\s*\{\s*force:\s*true\s*\}\)/.test(src))
  })

  // ================================================================ 汇总
  console.log('\n' + '='.repeat(78))
  console.log(results.join('\n'))
  console.log('='.repeat(78))
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
  console.log('='.repeat(78))
  process.exit(fail === 0 ? 0 : 1)
})()

/**
 * 只读取全量进程快照（不做任何名字预筛，交由 JS 判别）——
 * 仅用于验证"最终结果 == 全量进程经同一判别式过滤"，不落盘、不打印命令行。
 */
function rawCandidates () {
  const PS = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const S = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$o=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | Select-Object ProcessId,ParentProcessId,Name,CommandLine)",
    "ConvertTo-Json -InputObject @($o) -Compress -Depth 4"
  ].join(';')
  return new Promise(resolve => {
    try {
      execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', S],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 40000 }, (err, so) => {
          if (err) return resolve([])
          try {
            let j = JSON.parse(String(so || '').trim() || '[]')
            if (!Array.isArray(j)) j = [j]
            resolve(j
              .filter(p => p && Number.isInteger(p.ProcessId))
              .map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine })))
          } catch { resolve([]) }
        })
    } catch { resolve([]) }
  })
}
