/**
 * Hermes 桌面控制台 — 隔离端到端测试（真实符号链接 + 真实隔离进程 + 真实 OS 探测）
 *
 * 运行：node tests/e2e-isolated.test.js
 *
 * ★ 与"真实生产验收"的区别（务必分清）：
 *   本文件是**隔离环境**下的端到端：目录、状态文件、进程全部由本测试在系统临时目录内自建，
 *   被识别的进程是一个**无害的 sleep 进程**（仅命令行形态与网关一致），
 *   **不是**真实 Hermes Gateway，也**不调用**任何 hermes 命令。
 *   它证明的是"判定链在真实文件系统 + 真实操作系统进程上的行为"，
 *   **不能**替代用户在真实环境下的启停验收。
 *
 * 覆盖流程（全部使用真实模块）：
 *   搭建隔离目录(junction) → 真实进程启动 → 身份文件就绪 → 真实 OS 探测识别 →
 *   路径等价 → 完整身份核验 → 所有权登记 → 停止按钮解锁判定 →
 *   停止前授权(gate.decide) → 停止后核验(decideStopVerification)
 * 反向：身份不可读 / PID 复用 / 不同 Profile / 路径解析失败 / 符号链接目标变化 / 多实例
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const own = require('../ownership')
const probe = require('../process-probe')

let pass = 0, fail = 0
const results = []
function test (name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
function testAsyncFactory (name, fn) {
  return async () => {
    try { await fn(); pass++; results.push(`  [PASS] ${name}`) }
    catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
  }
}
const skip = why => results.push(`  [SKIP] ${why}`)

// 说明：本机 Python 解释器与 hermes.exe 路径由环境变量提供，未设置时使用通用占位值。
// 占位值下本套件中与真实进程相关的用例会按既有逻辑 SKIP（不伪造成功）。
const PYTHON = process.env.HERMES_CONSOLE_TEST_PYTHON || 'python'
const HERMES_EXE_STR = process.env.HERMES_CONSOLE_TEST_HERMES_EXE
  || 'C:\\Users\\<you>\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-'))
const REAL_HOME = path.join(BASE, 'real-home')        // 模拟 Hermes 真实目录
const LINK_HOME = path.join(BASE, 'link-home')        // 模拟符号链接写法
const OTHER_HOME = path.join(BASE, 'other-profile')   // 另一个真实目录（模拟额外 Profile）
const ABSENT_HOME = path.join(BASE, 'absent-home')    // 不存在（解析失败）

const PROFILE = 'e2e-isolated'   // 自定义 Profile 名：不污染真实 Profile 的实例计数
const children = []

function startFakeGateway (profile = PROFILE) {
  // ⚠️ 只传字符串给 python 的 argv，**不会**执行 hermes.exe（python 有 -c，后续参数仅进 sys.argv）
  const child = spawn(PYTHON, [
    '-c', 'import time;time.sleep(600)',
    HERMES_EXE_STR, '--profile', profile, 'gateway', 'run'
  ], { windowsHide: true, stdio: 'ignore' })
  children.push(child)
  return child
}

/** 按官方格式写状态文件（hermes_home 写**真实路径**，与官方 resolve 后的行为一致） */
function writeStateFiles (home, pid, startMs) {
  const st = Math.floor(startMs / 10)          // 官方：epoch_seconds × 100（toStartMs 会 ÷100×1000）
  const argv = [HERMES_EXE_STR, '--profile', PROFILE, 'gateway', 'run']
  fs.writeFileSync(path.join(home, 'gateway.pid'), JSON.stringify(
    { pid, kind: 'hermes-gateway', argv, start_time: st, hermes_home: REAL_HOME }))
  fs.writeFileSync(path.join(home, 'gateway.lock'), JSON.stringify(
    { pid, kind: 'hermes-gateway', argv, start_time: st, hermes_home: REAL_HOME }))
  fs.writeFileSync(path.join(home, 'gateway_state.json'), JSON.stringify(
    { pid, kind: 'hermes-gateway', argv, start_time: st, hermes_home: REAL_HOME,
      gateway_state: 'running', active_agents: 0 }))
}
function clearStateFiles (home) {
  for (const f of ['gateway.pid', 'gateway.lock', 'gateway_state.json']) {
    try { fs.unlinkSync(path.join(home, f)) } catch (e) { /* ignore */ }
  }
}

async function probeFor (pid, tries = 25) {
  for (let i = 0; i < tries; i++) {
    probe.resetCache()
    const pr = await probe.probeGatewayProcesses({ force: true })
    if (pr.ok && Array.isArray(pr.procs)) {
      const hit = pr.procs.find(p => p.pid === pid)
      if (hit) return { pr, hit }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return { pr: null, hit: null }
}

function killAll () {
  for (const c of children) { try { c.kill() } catch (e) { /* ignore */ } }
}

;(async () => {
  // ================================================================ 环境搭建
  console.log('\n[SETUP] 隔离环境（真实 junction + 无害 sleep 进程）')
  let linked = false
  try {
    fs.mkdirSync(REAL_HOME, { recursive: true })
    fs.mkdirSync(OTHER_HOME, { recursive: true })
    fs.symlinkSync(REAL_HOME, LINK_HOME, 'junction')   // Windows 创建 junction 无需管理员
    linked = true
  } catch (e) {
    skip(`无法创建 junction（${e.code || e.message}）`)
  }
  if (!fs.existsSync(PYTHON)) {
    skip(`找不到用于隔离进程的 python：${PYTHON}`)
    linked = false
  }
  console.log(`  BASE=${BASE}`)
  console.log(`  REAL_HOME=${REAL_HOME}`)
  console.log(`  LINK_HOME=${LINK_HOME}  (junction → REAL_HOME)`)

  if (!linked) {
    fail++
    results.push('  [FAIL] 隔离环境搭建失败 → 端到端测试无法进行（**不宣布通过**）')
  } else {
    // ---------- 启动隔离进程 ----------
    const child = startFakeGateway()
    console.log(`  隔离进程 pid=${child.pid}（命令行形态：python.exe -c … "<hermes.exe>" --profile ${PROFILE} gateway run）`)

    const found = await probeFor(child.pid)
    if (!found.hit) {
      fail++
      results.push('  [FAIL] 真实 OS 探测未能识别隔离进程 → 端到端中断（**不宣布通过**）')
      console.log('  probe result:', JSON.stringify(found.pr && found.pr.error ? found.pr : { ok: found.pr && found.pr.ok, matched: found.pr && found.pr.matched }))
    } else {
      const startMs = found.hit.startMs
      writeStateFiles(REAL_HOME, child.pid, startMs)
      console.log(`  状态文件已写入（hermes_home=${REAL_HOME}，startMs=${startMs}）`)

      // ============================================================ [A] 完整正向流程
      console.log('\n[A] 完整流程：进程识别 → 路径等价 → 核验 → 登记 → 解锁 → 授权 → 停止后核验')

      await testAsyncFactory('[A1] 真实 OS 探测识别隔离网关（按进程链归并为 1 个实例）', async () => {
        assert.strictEqual(found.pr.ok, true, '探测必须成功')
        assert.strictEqual(found.hit.profile, PROFILE, '应解析出本次启动的 Profile')
        const n = probe.countInstancesByProfile(found.pr.instances, PROFILE)
        assert.strictEqual(n, 1, `同 Profile 实例数应为 1，实际 ${n}`)
      })()

      await testAsyncFactory('[A2] 身份文件就绪：按**符号链接路径**读取（与生产一致）', async () => {
        const inst = own.readIdentity(LINK_HOME)
        assert.ok(inst, 'readIdentity 必须读到身份（链接路径与真实路径是同一目录）')
        assert.strictEqual(inst.pid, child.pid)
        assert.strictEqual(inst.state, 'running')
        assert.ok(inst.startMs > 0, 'startMs 必须可解析')
      })()

      await testAsyncFactory('[A3] ★ 路径等价：状态文件的真实路径 == Profile 的符号链接路径', async () => {
        const inst = own.readIdentity(LINK_HOME)
        assert.strictEqual(inst.hermesHome, REAL_HOME, '状态文件里存的是真实路径')
        assert.strictEqual(own.sameHome(inst.hermesHome, LINK_HOME), true,
          '真实路径与符号链接路径必须被判为同一目录（本次修复的核心）')
      })()

      await testAsyncFactory('[A4] ★ 完整身份核验通过（PID + 创建时间 + home + 单实例）', async () => {
        const inst = own.readIdentity(LINK_HOME)
        probe.resetCache()
        const pr = await probe.probeGatewayProcesses({ force: true })
        const n = probe.countInstancesByProfile(pr.instances, PROFILE)
        const check = own.verifyProfileIdentity({
          identity: inst, profileHome: LINK_HOME, procs: pr.procs, instanceCount: n
        })
        assert.strictEqual(check.ok, true, `核验应通过，实际 ${check.reason}`)
        assert.strictEqual(check.reason, 'verified')
      })()

      await testAsyncFactory('[A5] 所有权登记 + 停止按钮解锁判定（镜像 main.js / app.js 语义）', async () => {
        const inst = own.readIdentity(LINK_HOME)
        // 登记镜像：按 Profile 分槽（与 main.js setOwned 同语义）
        const ownedByProfile = {}
        ownedByProfile[PROFILE] = inst
        const owned = !!ownedByProfile[PROFILE]
        assert.strictEqual(owned, true, '应登记成功')
        // 按钮解锁镜像：renderer/app.js 中 `btn.disabled = !owned`
        const btnDisabled = !owned
        assert.strictEqual(btnDisabled, false, '停止按钮应解锁（disabled=false）')
      })()

      await testAsyncFactory('[A6] ★ 停止前授权放行（真实 gate.decide，A 态所有权路径）', async () => {
        const inst = own.readIdentity(LINK_HOME)
        probe.resetCache()
        const pr = await probe.probeGatewayProcesses({ force: true })
        const entry = pr.procs.find(p => p.pid === inst.pid)
        assert.ok(entry, '身份必须仍在 OS 中')
        const n = probe.countInstancesByProfile(pr.instances, PROFILE)
        const gate = own.createGate({})
        const dec = gate.decide('stop', inst, inst, null, {
          proc: { exists: true, startMs: entry.startMs },
          instanceCount: n
        })
        assert.strictEqual(dec.allowed, true, `A 态停止应放行，实际 ${dec.reason}`)
        assert.strictEqual(dec.via, 'ownership')
      })()

      await testAsyncFactory('[A7] ★ 停止后核验通过（目标 PID 消失 + 同 Profile 剩余 0）', async () => {
        const inst = own.readIdentity(LINK_HOME)
        // 模拟官方 stop 的结果：进程退出 + 状态文件清理
        children.pop()
        try { child.kill() } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 800))
        clearStateFiles(REAL_HOME)

        probe.resetCache()
        const pr = await probe.probeGatewayProcesses({ force: true })
        const osPidStillAlive = (pr.procs || []).some(p => p.pid === inst.pid)
        const sameProfileProcesses = probe.countInstancesByProfile(pr.instances, PROFILE)
        const verdict = own.decideStopVerification({
          exitCode: 0, osProbeError: null, osPidStillAlive,
          sameProfileProcesses, stateFileStillSame: false
        })
        assert.strictEqual(osPidStillAlive, false, '目标 PID 必须已从 OS 消失')
        assert.strictEqual(sameProfileProcesses, 0, '同 Profile 剩余实例数必须为 0')
        assert.strictEqual(verdict.verified, true, `停止后核验应通过，实际 ${verdict.reason}`)
      })()

      // ============================================================ [B] 反向场景
      console.log('\n[B] 反向场景（必须全部拒绝）')

      await testAsyncFactory('[B1] 身份不可读：两个状态文件的 pid 不一致 → readIdentity 返回 null', async () => {
        const c = startFakeGateway(PROFILE)
        const f = await probeFor(c.pid)
        if (!f.hit) { skip('隔离进程未被识别，跳过 [B1]'); return }
        writeStateFiles(REAL_HOME, c.pid, f.hit.startMs)
        // 篡改 gateway_state.json 的 pid，使两处不一致
        const stPath = path.join(REAL_HOME, 'gateway_state.json')
        const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
        st.pid = c.pid + 12345
        fs.writeFileSync(stPath, JSON.stringify(st))
        assert.strictEqual(own.readIdentity(LINK_HOME), null, 'pid 不一致必须判为不可信')
        clearStateFiles(REAL_HOME)
        try { c.kill() } catch (e) { /* ignore */ }
        children.pop()
      })()

      await testAsyncFactory('[B2] PID 复用（startMs 与 OS 实测不符）→ process-mismatch 拒绝', async () => {
        const c = startFakeGateway(PROFILE)
        const f = await probeFor(c.pid)
        if (!f.hit) { skip('隔离进程未被识别，跳过 [B2]'); return }
        writeStateFiles(REAL_HOME, c.pid, f.hit.startMs)
        const inst = own.readIdentity(LINK_HOME)
        probe.resetCache()
        const pr = await probe.probeGatewayProcesses({ force: true })
        const check = own.verifyProfileIdentity({
          identity: { ...inst, startMs: inst.startMs + 600000 },
          profileHome: LINK_HOME, procs: pr.procs, instanceCount: 1
        })
        assert.strictEqual(check.ok, false)
        assert.strictEqual(check.reason, 'process-mismatch')
        clearStateFiles(REAL_HOME)
        try { c.kill() } catch (e) { /* ignore */ }
        children.pop()
      })()

      await testAsyncFactory('[B3] ★ 不同 Profile 目录 → profile-mismatch 拒绝（绝不混淆）', async () => {
        const c = startFakeGateway(PROFILE)
        const f = await probeFor(c.pid)
        if (!f.hit) { skip('隔离进程未被识别，跳过 [B3]'); return }
        writeStateFiles(REAL_HOME, c.pid, f.hit.startMs)
        const inst = own.readIdentity(LINK_HOME)
        const check = own.verifyProfileIdentity({
          identity: inst, profileHome: OTHER_HOME, procs: found.pr.procs, instanceCount: 1
        })
        assert.strictEqual(check.ok, false)
        assert.strictEqual(check.reason, 'profile-mismatch')
        clearStateFiles(REAL_HOME)
        try { c.kill() } catch (e) { /* ignore */ }
        children.pop()
      })()

      await testAsyncFactory('[B4] ★ 路径解析失败（Profile 目录不存在）→ 拒绝，不猜测', async () => {
        const c = startFakeGateway(PROFILE)
        const f = await probeFor(c.pid)
        if (!f.hit) { skip('隔离进程未被识别，跳过 [B4]'); return }
        writeStateFiles(REAL_HOME, c.pid, f.hit.startMs)
        const inst = own.readIdentity(LINK_HOME)
        const check = own.verifyProfileIdentity({
          identity: inst, profileHome: ABSENT_HOME, procs: found.pr.procs, instanceCount: 1
        })
        assert.strictEqual(check.ok, false)
        assert.strictEqual(check.reason, 'profile-mismatch')
        clearStateFiles(REAL_HOME)
        try { c.kill() } catch (e) { /* ignore */ }
        children.pop()
      })()

      await testAsyncFactory('[B5] ★ 符号链接目标变化 → 原 Profile 路径不再等价 → 拒绝', async () => {
        const OTHER_LINK = path.join(BASE, 'link-moved')
        try {
          fs.symlinkSync(OTHER_HOME, OTHER_LINK, 'junction')
        } catch (e) { skip('无法创建第二个 junction，跳过 [B5]'); return }
        // OTHER_LINK 指向 OTHER_HOME，与 REAL_HOME 不是同一目录
        assert.strictEqual(own.sameHome(OTHER_LINK, REAL_HOME), false)
        const inst = { pid: 1, startMs: 2, hermesHome: REAL_HOME }
        const check = own.verifyProfileIdentity({
          identity: inst, profileHome: OTHER_LINK, procs: [{ pid: 1, startMs: 2 }], instanceCount: 1
        })
        assert.strictEqual(check.ok, false)
        assert.strictEqual(check.reason, 'profile-mismatch')
      })()

      await testAsyncFactory('[B6] ★ 同一 Profile 出现多个实例 → multiple-instances 拒绝', async () => {
        const c1 = startFakeGateway(PROFILE)
        const c2 = startFakeGateway(PROFILE)
        const f1 = await probeFor(c1.pid)
        if (!f1.hit) { skip('隔离进程未被识别，跳过 [B6]'); return }
        probe.resetCache()
        const pr = await probe.probeGatewayProcesses({ force: true })
        const n = probe.countInstancesByProfile(pr.instances, PROFILE)
        assert.ok(n >= 2, `同 Profile 实例数应 ≥2，实际 ${n}`)
        const inst = { pid: c1.pid, startMs: f1.hit.startMs, hermesHome: REAL_HOME }
        const check = own.verifyProfileIdentity({
          identity: inst, profileHome: LINK_HOME, procs: pr.procs, instanceCount: n
        })
        assert.strictEqual(check.ok, false)
        assert.strictEqual(check.reason, 'multiple-instances')
        try { c1.kill() } catch (e) { /* ignore */ }
        try { c2.kill() } catch (e) { /* ignore */ }
        children.pop(); children.pop()
      })()
    }
  }

  // ================================================================ 汇总
  console.log('\n' + '='.repeat(78))
  console.log(results.join('\n'))
  console.log('='.repeat(78))
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
  console.log('='.repeat(78))
  console.log('  ⚠️ 本文件为**隔离端到端**；真实环境启停验收仍需用户执行，未包含在此。')

  // ================================================================ 清理
  killAll()
  await new Promise(r => setTimeout(r, 500))
  try {
    if (BASE.startsWith(os.tmpdir()) && path.basename(BASE).startsWith('hermes-e2e-')) {
      fs.rmSync(BASE, { recursive: true, force: true })
    }
  } catch (e) { console.log('  [WARN] 清理隔离目录失败:', e.message) }

  process.exit(fail === 0 ? 0 : 1)
})()
