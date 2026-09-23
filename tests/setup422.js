/**
 * 阶段 4.2.2 真实集成测试装置 —— 准备沙箱
 *
 * 目标：在**不可能触及真实飞书网关**的前提下，真实验证看门狗的
 *       观察周期 → 交接 → 单槽锁 → 判决 全链路。
 *
 * 沙箱两道保险：
 *   ① HERMES_HOME 指向临时目录（任何 stop 都只会作用在该 profile）
 *   ② 看门狗进程的 PATH 不含 hermes 可执行文件（spawn 会直接失败，命令根本不会执行）
 *
 * 但为了让 preflightStop 能**真正走到通过**（从而验证 auto-stop 闸门），
 * 临时目录里的状态文件内容 = 真实网关身份（复制而来）。
 * 这样「身份核验通过 + allowStop=0」这一关键分支才被真实覆盖。
 *
 * 用法：node setup422.js <REAL_HOME> <TMP_DIR> <FAKE_CONSOLE_PID>
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const own = require(path.join(__dirname, '..', 'ownership.js'))

const [REAL_HOME, TMP, CONSOLE_PID] = process.argv.slice(2)
if (!REAL_HOME || !TMP || !CONSOLE_PID) {
  console.error('用法: node setup422.js <REAL_HOME> <TMP_DIR> <FAKE_CONSOLE_PID>')
  process.exit(2)
}

const tmpHome = path.join(TMP, 'home')
fs.mkdirSync(tmpHome, { recursive: true })

// 1) 复制真实状态文件（内容 = 真实网关身份）
const copied = []
for (const f of ['gateway.pid', 'gateway_state.json']) {
  const src = path.join(REAL_HOME, f)
  if (!fs.existsSync(src)) { console.error(`缺少 ${src}`); process.exit(3) }
  fs.copyFileSync(src, path.join(tmpHome, f))
  copied.push(f)
}

// 2) 用 ownership.js 自己解析真实身份（保证与看门狗读到的完全一致）
const inst = own.readIdentity(REAL_HOME)
if (!inst) { console.error('无法读取真实网关身份'); process.exit(4) }
const v = own.validateIdentity(inst)
if (!v.ok) { console.error('身份不完整: ' + v.errors.join(',')); process.exit(5) }

// 3) 写出所有权记录：consolePid = 我们控制的假控制台进程
const recordPath = path.join(TMP, 'record.json')
fs.writeFileSync(recordPath, JSON.stringify({
  consolePid: Number(CONSOLE_PID),
  gateway: inst,
  acquiredAt: new Date().toISOString(),
  _note: '阶段4.2.2 测试装置生成，非真实所有权记录'
}, null, 2), 'utf8')

console.log(JSON.stringify({
  ok: true,
  copiedFiles: copied,
  realIdentity: { pid: inst.pid, startMs: inst.startMs, hermesHome: inst.hermesHome, kind: inst.kind },
  recordPath,
  tmpHome,
  consolePid: Number(CONSOLE_PID)
}, null, 2))
