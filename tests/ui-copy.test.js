/**
 * Hermes 桌面控制台 — UI 文案 / 死控件 / 能力入口 回归测试
 *
 * 运行：node tests/ui-copy.test.js
 * 无第三方依赖；纯静态检查（读源码文本做约束断言），**不启动任何进程、不触碰网关**。
 *
 * 覆盖本轮「控制台收尾」的核心要求：
 *   [OPEN-1] 关闭控制台 == 不停止网关：所有相关文案不得写死成"会停止"
 *   [死 UI ] Agent 页字段必须由真实 API 赋值（不是永久 "—"）
 *   [能力 ] 外部工程 / Extra 必须有真实状态与入口，不得留"下一阶段接入"占位
 *   [安全 ] ALLOW_AUTO_STOP 保持 false；不得出现"保证只停单实例"的正面表述
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const APP = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(APP, p), 'utf8')
const appJs = read('renderer/app.js')
const indexHtml = read('renderer/index.html')
const styles = read('renderer/styles.css')
const mainJs = read('main.js')
const preloadJs = read('preload.js')

let pass = 0, fail = 0
const results = []
function test(name, fn) {
  try { fn(); pass++; results.push(`  [PASS] ${name}`) }
  catch (err) { fail++; results.push(`  [FAIL] ${name}\n         ${err.message}`) }
}
/** 某处出现 needle 时，其前后 window 行内必须出现 guard（用于校验条件分支包裹） */
function occurrencesGuarded(text, needle, guard, window = 3) {
  const lines = text.split(/\r?\n/)
  const idx = []
  lines.forEach((l, i) => { if (l.includes(needle)) idx.push(i) })
  assert.ok(idx.length > 0, `未找到「${needle}」（应至少在 autoStop 开启分支中存在）`)
  for (const i of idx) {
    const lo = Math.max(0, i - window), hi = Math.min(lines.length, i + window + 1)
    const near = lines.slice(lo, hi).join('\n')
    assert.ok(near.includes(guard), `「${needle}」出现在第 ${i + 1} 行附近，但 ±${window} 行内没有 ${guard} 守卫`)
  }
  return idx.length
}

// =============================================================== [1] OPEN-1 文案
console.log('\n[1] OPEN-1：关闭控制台不会停止网关（文案回归）')

test('app.js 不得再出现写死的"关闭控制台也会停止它"', () => {
  assert.ok(!appJs.includes('关闭控制台也会停止它'), 'app.js 仍含旧文案')
})
test('app.js 不得再出现写死的"关闭控制台将停止它"', () => {
  assert.ok(!appJs.includes('关闭控制台将停止它'), 'app.js 仍含旧文案')
})
test('index.html 不得再出现"关闭控制台时重新核验实例身份后才停止"', () => {
  assert.ok(!indexHtml.includes('关闭控制台时重新核验实例身份后才停止'), 'index.html 仍含旧文案')
})
test('★ 所有"关闭控制台会停止它"的表述都必须受 autoStopEnabled() 条件守卫', () => {
  const n = occurrencesGuarded(appJs, '关闭控制台时会重新核验身份后停止它', 'autoStopEnabled')
  assert.ok(n >= 1, '应存在 autoStop 开启分支的文案')
})
test('app.js 必须提供 autoStopEnabled() 并读取 BOOT.ownership.autoStop', () => {
  assert.ok(/function autoStopEnabled\s*\(\s*\)/.test(appJs), '缺少 autoStopEnabled()')
  assert.ok(appJs.includes('o.autoStop'), 'autoStopEnabled 未读取 BOOT.ownership.autoStop')
})
test('index.html 必须明示"关闭控制台不会自动停止它"', () => {
  assert.ok(indexHtml.includes('关闭控制台不会自动停止它'), '缺少如实的 A 态说明')
})
test('index.html 必须包含自动停止状态节点 autoStopNote', () => {
  assert.ok(indexHtml.includes('id="autoStopNote"'), '缺少 autoStopNote')
})
test('app.js 必须给 autoStopNote 写入真实状态', () => {
  assert.ok(/\$\('autoStopNote'\)/.test(appJs), 'app.js 未写入 autoStopNote')
})

// =============================================================== [2] 死 UI
console.log('\n[2] 死 UI：Agent 页字段必须由真实 API 赋值')

test('app.js 必须定义 renderAgent()', () => {
  assert.ok(/function renderAgent\s*\(/.test(appJs), '缺少 renderAgent()')
})
for (const id of ['agentActive', 'agentSessions', 'agentBusy', 'agentDrainable', 'agentProfiles', 'agentMode']) {
  test(`app.js 必须给 ${id} 赋值`, () => {
    assert.ok(appJs.includes(`'${id}'`), `${id} 从未被赋值`)
  })
}
test('renderAgent 连接到 refreshAll 主流程', () => {
  assert.ok(/renderAgent\(status\)/.test(appJs), 'refreshAll 未调用 renderAgent')
})
test('index.html 用真实字段 agentDrainable（不是无来源的 agentTurns）', () => {
  assert.ok(indexHtml.includes('id="agentDrainable"'), '缺少 agentDrainable')
  assert.ok(!indexHtml.includes('agentTurns'), '仍残留无数据来源的 agentTurns')
})
test('shortcutNote 必须被赋值（不是永久 —）', () => {
  assert.ok(/\$\('shortcutNote'\)\.textContent/.test(appJs), 'shortcutNote 从未赋值')
})

// =============================================================== [3] 能力入口
console.log('\n[3] 外部工程 / Extra：真实状态与入口')

test('main.js 提供 console:capabilities', () => {
  assert.ok(mainJs.includes("'console:capabilities'"), '缺少 capabilities IPC')
})
test('main.js 提供 console:openCapability（固定目录，不接受任意路径）', () => {
  assert.ok(mainJs.includes("'console:openCapability'"), '缺少 openCapability IPC')
  assert.ok(/id === 'external'/.test(mainJs) && /id === 'profile'/.test(mainJs), 'openCapability 未限定固定 id')
})
test('preload.js 暴露 capabilities / openCapability', () => {
  assert.ok(/capabilities:\s*\(\)\s*=>/.test(preloadJs), 'preload 未暴露 capabilities')
  assert.ok(/openCapability:\s*id\s*=>/.test(preloadJs), 'preload 未暴露 openCapability')
})
test('app.js 必须定义 renderCapabilities() 并调用 loadCapabilities()', () => {
  assert.ok(/function renderCapabilities\s*\(/.test(appJs), '缺少 renderCapabilities()')
  assert.ok(/loadCapabilities\(\)/.test(appJs), '未调用 loadCapabilities()')
})
test('index.html 必须具备「扩展能力」页与导航项', () => {
  assert.ok(indexHtml.includes('id="page-capabilities"'), '缺少扩展能力页')
  assert.ok(/data-page="capabilities"/.test(indexHtml), '导航缺少 capabilities')
})
test('能力探测必须来自主进程（renderer 不得自行假设运行状态）', () => {
  assert.ok(mainJs.includes('detectCapabilities'), '缺少主进程探测函数')
  assert.ok(mainJs.includes('probeProcessesByCmdline'), '缺少进程探测（运行状态不能靠假设）')
})
test('★ 不得残留"下一阶段接入"占位文案', () => {
  assert.ok(!appJs.includes('将在下一阶段接入'), 'app.js 仍含占位文案')
  assert.ok(!indexHtml.includes('下一阶段接入'), 'index.html 仍含占位文案')
})
test('快捷入口 外部工程/额外 Profile 必须导航到能力页（不是弹"未接入"）', () => {
  assert.ok(/k === 'external' \|\| k === 'profile'/.test(appJs), 'external/extra 未指向能力页')
})

// =============================================================== [4] 安全不回退
console.log('\n[4] 安全红线不回退')

test('★ main.js 的 ALLOW_AUTO_STOP 必须仍为 false', () => {
  assert.ok(/const ALLOW_AUTO_STOP = false/.test(mainJs), 'ALLOW_AUTO_STOP 已被改动')
})
test('main.js 不得出现"保证只停目标实例"的正面表述（注释除外，且必须是否定式）', () => {
  // 去掉块注释与整行 // 注释后再检查：注释里允许出现"不得声称…保证只停…"这类反例说明
  const code = mainJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n')
  const needle = '保证只停目标实例'
  let i = code.indexOf(needle)
  let found = 0
  while (i !== -1) {
    found++
    const before = code.slice(Math.max(0, i - 2), i)
    assert.strictEqual(before, '无法', `出现不受否定的正面保证（前文="${before}"）`)
    i = code.indexOf(needle, i + needle.length)
  }
  assert.ok(found >= 1, '应至少保留一处否定式表述（无法保证只停目标实例）')
})
test('renderer 仍无 Node 能力：CSP 保持 default-src self', () => {
  assert.ok(indexHtml.includes("default-src 'self'"), 'CSP 被放宽')
  assert.ok(indexHtml.includes("object-src 'none'"), 'CSP object-src 缺失')
})
test('openPath 白名单仍受控，且能力目录以常量加入（非任意路径）', () => {
  assert.ok(mainJs.includes('EXTERNAL_DIR') && mainJs.includes('PROFILES_DIR'), '缺少能力目录常量')
  assert.ok(/OPENABLE_ROOTS\s*=/.test(mainJs), '缺少 OPENABLE_ROOTS')
})
test('危险 API 仍不被通用通道放行', () => {
  assert.ok(mainJs.includes('isDangerousApi'), '缺少危险 API 判定')
  assert.ok(/DANGEROUS_API/.test(mainJs), '缺少 DANGEROUS_API 列表')
})

// =============================================================== [5] 可读性/一致性
console.log('\n[5] 视觉一致性与可读性')

test('图标基座仍使用 currentColor（防黑色实心块回归）', () => {
  assert.ok(/\.ico\s*\{[^}]*stroke:\s*currentColor/.test(styles), '.ico 未使用 currentColor')
  assert.ok(/\.ico\s*\{[^}]*fill:\s*none/.test(styles), '.ico 未设置 fill:none')
})
test('扩展能力状态色 ok-text / unk-text 已定义', () => {
  assert.ok(styles.includes('.ok-text') && styles.includes('.unk-text'), '缺少能力状态色')
})
test('快捷入口标签不再重叠（顶部留白）', () => {
  assert.ok(/\.shortcut\s*\{[^}]*padding:\s*24px/.test(styles), '快捷入口未给 sc-tag 留白')
})

// =============================================================== [6] 最终完工轮：启动/退出/认证/闸门
console.log('\n[6] 最终完工轮：启动行为 · 功能开关 · 退出 · 认证 · 危险闸门')

test('1. 控制台启动不自动启动 Gateway（只 spawn hermes serve）', () => {
  // startBackend 只启动 dashboard 后端，绝不出现 gateway run
  const m = mainJs.match(/function startBackend\(\)\s*\{[\s\S]*?\n\}/)
  assert.ok(m, '未找到 startBackend')
  assert.ok(!/gateway['"]\s*,\s*['"]run/.test(m[0]), 'startBackend 里出现了 gateway run')
  assert.ok(/['"]serve['"]/.test(m[0]), 'startBackend 未使用 serve')
})
test('1b. 启动日志明确"不自动启动网关"（app 启动即读状态）', () => {
  assert.ok(/probeGatewayPreExisted/.test(mainJs), '缺少启动时只读探测')
})
test('2. 已运行的 Gateway 不重复启动', () => {
  assert.ok(mainJs.includes("'already-running'"), '缺少 already-running 拒绝分支')
})
test('3. 两个 Profile 不串线（default / extra 显式注册）', () => {
  assert.ok(/id:\s*'default'/.test(mainJs), '缺少 default Profile 注册')
  assert.ok(/function discoverProfiles/.test(mainJs) && /PROFILES_DIR/.test(mainJs), '非 default Profile 必须由运行时发现（不得写死私有名）')
  assert.ok(mainJs.includes("'gateway:default'") || mainJs.includes("'gateway:' + p.id"), '服务 id 未按 Profile 区分')
})
test('4. 启动失败时 UI 不误报成功（返回 ok:false + 复核超时）', () => {
  assert.ok(mainJs.includes("'verify-timeout'"), '缺少启动后复核超时')
  assert.ok(mainJs.includes("'spawn-failed'"), '缺少 spawn 失败返回')
  assert.ok(/启动未成功/.test(appJs), 'UI 未对失败给出提示')
})
test('5. 独立功能开关不会误停共享 Gateway（无 stop 调用）', () => {
  // 开关实现里不得出现任何停止/终止调用
  assert.ok(!/kill\(|taskkill|gateway\/stop/.test(appJs), 'app.js 出现进程/网关停止调用')
})
test('6. 无独立禁用能力时不展示可操作的假开关（disabled）', () => {
  assert.ok(/id="acSwitch"[^>]*disabled/.test(indexHtml), '外部工程 开关未禁用')
  assert.ok(/id="cjSwitch"[^>]*disabled/.test(indexHtml), 'Extra 开关未禁用')
  assert.ok(indexHtml.includes('独立开关：暂不支持') || appJs.includes('暂不支持'), '未标注开关暂不支持')
})
test('7. 认证失效能被可靠识别，并按签名去重', () => {
  assert.ok(/AUTH_SHOWN_SIG/.test(appJs), '缺少认证去重标记')
  // 失效识别必须同时要求「可靠」与「失效」两项（不得只看单侧）
  assert.ok(/filter\(p\s*=>\s*p\.reliable\s*&&\s*p\.expired\)/.test(appJs), '未按"可靠且失效"识别认证失败')
  // 去重：同一签名不重复弹窗
  assert.ok(/if\s*\(AUTH_SHOWN_SIG === sig\)\s*return/.test(appJs), '未按签名去重')
  // 状态判定必须来自主进程的纯逻辑模块
  assert.ok(/state === 'expired'|state: 'expired'/.test(mainJs) || /'expired'/.test(read('auth.js')), '缺少 expired 状态')
})

test('8. 无可靠认证依据时不误报（只有 reliable+expired 才自动弹窗）', () => {
  const fn = appJs.split('function checkAuth')[1] || ''
  const body = fn.split('function openAuthModal')[0] || fn
  assert.ok(/filter\(p\s*=>\s*p\.reliable\s*&&\s*p\.expired\)/.test(body), 'checkAuth 未要求可靠证据')
  const iGuard = body.indexOf('if (!expired.length)')
  const iOpen = body.indexOf('openAuthModal(')
  assert.ok(iGuard >= 0, '缺少"无失效即返回"分支')
  assert.ok(iOpen > iGuard, '自动弹窗必须发生在"无失效即返回"之后')
  assert.ok(/reliable/.test(mainJs), 'main.js 未给出 reliable 判定')
  assert.ok(/state: 'unverified'/.test(read('auth.js')), 'auth.js 缺少 unverified 分支')
  // 「未验证」不得被当作失效
  assert.ok(!/unverified'[\s\S]{0,80}?expired: true/.test(read('auth.js')), 'unverified 不得被判为 expired')
})
test('9. 存在运行服务时显示退出提示（不直接关窗）', () => {
  assert.ok(/ui:exit-request/.test(mainJs), '缺少退出请求事件')
  assert.ok(/askExitDecision/.test(mainJs), '缺少退出决策')
  assert.ok(/e\.preventDefault\(\)/.test(mainJs), '未拦截窗口关闭')
})
test('10. 全部服务停止后正常退出', () => {
  assert.ok(/!payload\.anyRunning/.test(mainJs), '缺"无运行服务即退出"分支')
})
test('11. "仅退出控制台"不停止后台', () => {
  const m = mainJs.match(/console:exitDecision'[\s\S]*?\n\}\)/)
  assert.ok(m, '未找到 exitDecision')
  assert.ok(!/gateway\/stop|runDangerous|\.kill\(/.test(m[0]), 'exit-only 分支里出现了停止动作')
})
test('12. ALLOW_AUTO_STOP 与 ALLOW_DANGEROUS_EXEC 均为 false', () => {
  assert.ok(/const ALLOW_AUTO_STOP = false/.test(mainJs), 'ALLOW_AUTO_STOP 被改动')
  assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(mainJs), 'ALLOW_DANGEROUS_EXEC 被改动')
})
test('13. 不修改 Provider / 凭据 / 上游（无写入型 Provider API）', () => {
  assert.ok(!/\/api\/providers\/(set|update|write)/.test(mainJs), '出现 Provider 写入接口')
  assert.ok(!/ALLOWED_POST[\s\S]{0,200}gateway\/(stop|restart|drain)/.test(mainJs), '危险接口被通用通道放行')
})
test('13b. 危险入口统一闸门：stop/restart/drain/adopt 均先判 ALLOW_DANGEROUS_EXEC', () => {
  const n = (mainJs.match(/ALLOW_DANGEROUS_EXEC/g) || []).length
  assert.ok(n >= 3, `闸门引用过少（${n}），可能未覆盖全部危险入口`)
})
test('14. 自动启动项已按要求处置（禁用记录存在）', () => {
  // 源码侧不新增任何登录项/服务安装调用
  assert.ok(!/gateway['"]\s*,\s*['"]install/.test(mainJs), '代码中出现 gateway install')
  assert.ok(!/schtasks|reg add|New-Service/.test(mainJs), '代码中出现自启动写入')
})
test('15. ★ 陈旧状态不得再阻止启动（Extra 启动障碍修复）', () => {
  assert.ok(!/reason:\s*'stale-state'/.test(mainJs), '仍存在 stale-state 硬拒绝分支')
  assert.ok(mainJs.includes('decideProfileStart'), 'main.js 未使用 decideProfileStart')
  const ownJs = read('ownership.js')
  assert.ok(/function decideProfileStart/.test(ownJs), 'ownership.js 缺少 decideProfileStart')
  assert.ok(/decideProfileStart/.test(ownJs.split('module.exports')[1] || ''), 'decideProfileStart 未导出')
  // 启动 handler 体内不得出现删除状态文件的调用（清理交给官方）
  const after = mainJs.split("ipcMain.handle('gateway:startProfile'")[1] || ''
  const startBlock = after.split("ipcMain.handle('")[0] || ''
  assert.ok(startBlock.length > 100, '未能定位 startProfile handler 体')
  assert.ok(!/\bunlink|rmSync|safe-delete/i.test(startBlock), '启动路径出现删除状态文件的调用')
})
test('16. ★ 过期记录：禁止绝对表述，必须"以实测为准"并含 race lost 安全指引', () => {
  const blob = appJs + indexHtml
  // 旧文案「这**不影响启动**：官方会在启动时自动覆盖…」把结论当保证 → 必须移除
  assert.ok(!/不影响启动/.test(blob), '仍存在"不影响启动"的绝对表述')
  assert.ok(!/启动时自动覆盖|会自动覆盖/.test(blob), '仍存在"自动覆盖"的绝对表述')
  // 必须给出"以实测为准"的口径
  assert.ok(/以启动时的实测结果为准|以实际结果为准|启动前实测核实/.test(blob), '缺少"以实测为准"的措辞')
  // 必须说明 race lost 的行为边界
  assert.ok(/PID file race lost/.test(appJs), '界面缺少 PID file race lost 说明')
  assert.ok(/不自动重试/.test(appJs) && /不删除状态文件/.test(appJs), '缺少"不自动重试 / 不删除状态文件"声明')
  // 启动前必须逐项展示实测事实（而非一句"不影响启动"）
  assert.ok(/recordedPidLive/.test(mainJs) && /precheck/.test(mainJs), '启动路径缺少实测事实回报')
})

// ------------------------------------------------ 本轮专项：模型认证界面
test('17. 认证弹窗必须含 Profile / Provider / 模型 / 状态 四项 + 三按钮', () => {
  for (const id of ['authProfile', 'authProvider', 'authModel', 'authState']) {
    assert.ok(new RegExp(`id="${id}"`).test(indexHtml), `弹窗缺少 ${id}`)
  }
  for (const id of ['btnAuthStart', 'btnAuthRecheck', 'btnAuthCancel']) {
    assert.ok(new RegExp(`id="${id}"`).test(indexHtml), `弹窗缺少按钮 ${id}`)
  }
  assert.ok(/官方支持的认证方式/.test(indexHtml), '弹窗未说明官方认证方式')
})

test('18. 模型与认证页按 Profile 渲染（不再写死单一 Provider）', () => {
  assert.ok(/id="authProfileCards"/.test(indexHtml), '缺少按 Profile 的认证卡片容器')
  assert.ok(/authProfileCards[\s\S]{0,200}?addEventListener/.test(appJs), '认证卡片未绑定事件（委托）')
  // 页面渲染必须以数组驱动，而非硬编码 provider 名
  assert.ok(/list\.map\(authCardHtml\)/.test(appJs), '认证卡片未按 Profile 列表渲染')
  // 旧的写死 openai-codex 行必须已移除
  assert.ok(!/name:\s*'openai-codex',\s*\n\s*ok:\s*null/.test(appJs), '仍存在写死 openai-codex 的假行')
})

test('19. 认证 ≠ 可调用：界面不得把"认证有效"说成"可用"', () => {
  assert.ok(/认证有效 ≠ 模型可调用/.test(indexHtml), '页面未声明认证与可调用的区别')
  // 「待验证」口径由主进程的纯逻辑模块给出，界面直接消费该结果
  assert.ok(/待验证/.test(read('auth.js')), 'auth.js 缺少"待验证"口径')
  assert.ok(/callability/.test(appJs) && /callability/.test(mainJs), '界面/主进程未消费可调用性口径')
  assert.ok(!/认证有效[，。、]?\s*模型可用/.test(indexHtml + appJs), '出现"认证有效=可用"的表述')
})

test('20. 开始认证不代跑 OAuth：只打开终端并载入官方命令', () => {
  assert.ok(!/type\s*=\s*["']password["']/i.test(indexHtml), '出现密码输入框')
  assert.ok(!/扫码|模拟登录|模拟网页登录/.test(indexHtml + appJs), '出现模拟登录措辞')
  assert.ok(/不会收集|不收集/.test(indexHtml), '未声明不收集凭据')
  assert.ok(/不自动切换/.test(indexHtml), '未声明不自动切换 Provider')
})

test('21. 认证相关文案不得暗示会自动停止/重启网关', () => {
  const seg = indexHtml.split('id="page-model"')[1] || ''
  const body = seg.split('<!-- 飞书连接 -->')[0] || seg
  assert.ok(!/停止|重启/.test(body.replace(/不会停止或重启/g, '')), '模型与认证页出现停止/重启暗示')
})

// ------------------------------------------------- RC 轮：手动停止（仅 A 态）
console.log('\n[RC] 手动停止能力（仅本控制台启动并持有的实例）')

test('22. 主进程存在独立开关 ALLOW_OWNED_STOP=true，且 ALLOW_DANGEROUS_EXEC 仍为 false', () => {
  assert.ok(/const ALLOW_OWNED_STOP = true/.test(mainJs), '缺少 ALLOW_OWNED_STOP 开关')
  assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(mainJs), 'ALLOW_DANGEROUS_EXEC 被改动')
})

test('23. stop 必须由 decideStopRelease 释放且仍经 authorizeDangerous 核验', () => {
  assert.ok(/decideStopRelease/.test(mainJs), 'main.js 未使用 decideStopRelease')
  assert.ok(/execOwnedStopCli/.test(mainJs), '缺少 execOwnedStopCli 执行函数')
  // 执行层必须走官方 CLI 并由所有权记录反查 profile，不得用后端 /api/gateway/stop
  // （只检查函数体：到下一个 ipcMain.handle 为止；其后的退出流程历史路径受 ALLOW_AUTO_STOP=false 守卫，另有人管）
  const block = (mainJs.split('async function execOwnedStopCli')[1] || '')
    .split("ipcMain.handle('gateway:stop'")[0] || ''
  assert.ok(block.includes("'--profile', prof.id, 'gateway', 'stop'"), '停止未使用官方 CLI --profile')
  assert.ok(!block.includes('/api/gateway/stop'), '停止执行层不得调用后端 API（只会停 default，存在误停风险）')
})

test('24. 停止按钮必须受所有权状态守卫（A 态才可用）', () => {
  assert.ok(/stopBtn\.disabled = !owned/.test(appJs), '停止按钮未按所有权状态禁用/启用')
  assert.ok(/restartBtn\.disabled = true/.test(appJs), '重启按钮必须保持禁用')
})

test('25. stop 不得提供一次性授权兜底（用户边界：外部实例仍只读）', () => {
  assert.ok(/停止仅对本控制台启动并持有的实例/.test(appJs), '缺少 A 态边界说明文案')
  assert.ok(!/gatewayAuthorizeOnce\('stop'\)/.test(appJs), 'stop 出现一次性授权调用')
})

test('26. 能力页必须如实区分"已开放(仅A态)"与"仍未开放"', () => {
  assert.ok(/仅对本控制台亲自启动并持有的网关实例/.test(indexHtml), '能力页缺少停止开放范围说明')
  assert.ok(/仍未开放/.test(indexHtml), '能力页缺少仍未开放项说明')
})

test('27. ★ 不得残留与 RC 策略矛盾的旧文案（停止一律禁用 / 逐次授权）', () => {
  assert.ok(!/停止\s*\/\s*重启本轮未授权/.test(appJs + indexHtml), '仍存在"停止/重启本轮未授权"旧文案')
  assert.ok(!/停止\/重启需逐次授权/.test(appJs + indexHtml), '仍存在"停止/重启需逐次授权"旧文案')
  assert.ok(!/停止\/重启需你逐次明确授权/.test(appJs + indexHtml), '仍存在逐次授权旧文案（另一处）')
})

// ------------------------------------ 本轮（RC 收尾）：三件事的静态断言
console.log('\n[RC-收尾] 首页统计范围 / 停止前置复核 / 安全规则保留')

test('28. 首页 Skills 数字必须标注统计范围，且不得暗示已通过可用性验证', () => {
  assert.ok(/已启用 Skills<span class="stat-sub">（仅 default Profile）/.test(indexHtml),
    '首页"已启用 Skills"标签未标注范围')
  assert.ok(/统计范围：default Profile/.test(appJs), 'statsNote 未写明统计范围')
  // 必须出现"否定式"声明
  assert.ok(/不代表逐个可用性已验证|≠ 已验证可用/.test(appJs), '未声明"已启用 ≠ 已验证可用"')
  // 不得出现"肯定式"可用性声明（否定句允许：用"不/未/≠"开头的排除）
  const positive = (appJs + indexHtml)
    .split(/(?:不|未|≠|无)\s*/).join('|')   // 把否定词替换为分隔符，避免误伤否定句
    .match(/全部技能[^。\n]{0,12}(已)?通过可用性验证|所有技能[^。\n]{0,12}(已)?验证通过/g)
  assert.strictEqual(positive, null, `出现"可用性已验证"的肯定式表述：${positive}`)
  // ★ 界面用 textContent 渲染，Markdown 粗体标记 ** 会被原样显示 → 界面字符串里不得出现
  //   （注释里的 ** 无害，这里只扫描非注释行）
  const appJsCode = appJs.split(/\r?\n/)
    .filter(l => { const t = l.trim(); return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) })
    .join('\n')
  for (const bad of ['**统计范围', '不影响启动**', '**不代表逐个可用性', '**无法确认**', '**能否启动', '**按 Profile 分开**展示']) {
    assert.ok(!appJsCode.includes(bad), `界面字符串残留 Markdown 标记：${bad}`)
  }
})

test('29. 首页必须有按 Profile 的"范围明细"（Gateway / Skills / 认证 三项分区）', () => {
  assert.ok(/id="scopeRows"/.test(indexHtml), '缺少范围明细表体 scopeRows')
  assert.ok(/id="scopeTable"/.test(indexHtml), '缺少范围明细表 scopeTable')
  for (const h of ['Gateway', 'Skills', '认证']) {
    assert.ok(new RegExp(`<th>${h}</th>`).test(indexHtml), `范围明细缺少列 ${h}`)
  }
  assert.ok(/function renderScopeTable\s*\(/.test(appJs), 'app.js 缺少 renderScopeTable')
  assert.ok(/renderScopeTable\(\)/.test(appJs), 'renderScopeTable 未被调用')
  // 两个 Profile 必须各占一行，且明确"不合并"
  assert.ok(/'default'/.test(appJs) && /authOf\(extraProfileId\(\)\)/.test(appJs), '范围明细未按 default / 额外 Profile 两行渲染')
  assert.ok(/不做跨 Profile 合并/.test(appJs), '未声明不做跨 Profile 合并')
})

test('30. 停止前必须复核"活跃任务"；★ 未知一律暂停，不得用人工确认继续', () => {
  const block = mainJs.split('async function execOwnedStopCli')[1] || ''
  const body = block.split("ipcMain.handle('gateway:stop'")[0] || ''
  assert.ok(/summarizeActiveTasks/.test(body), 'execOwnedStopCli 未读取活跃任务')
  assert.ok(/decideActiveTaskStop/.test(body), 'execOwnedStopCli 未做活跃任务判定')
  assert.ok(/verifyStopTarget/.test(body), '缺少目标 Profile 复核')
  // ★ 不再允许 confirmActiveUnknown 绕行（真实验收遇到未知活跃数必须暂停）
  assert.ok(!/confirmActiveUnknown/.test(mainJs), '仍存在 confirmActiveUnknown 人工确认绕行')
  assert.ok(!/confirmActiveUnknown/.test(appJs), '界面仍存在人工确认继续的分支')
  assert.ok(/active-tasks/.test(appJs), '界面缺少活跃任务分支处理')
})

test('31. 停止后必须有 OS 级验证（不能只看状态文件）', () => {
  const block = mainJs.split('async function execOwnedStopCli')[1] || ''
  const body = block.split("ipcMain.handle('gateway:stop'")[0] || ''
  assert.ok(/buildVerifyContext/.test(body), '停止后未做 OS 级进程探测')
  assert.ok(/osPidStillAlive/.test(body), '缺少 osPidStillAlive 判定')
  assert.ok(/osProbeError/.test(body), 'OS 探测失败时未 fail-closed')
})

test('32. 停止路径不得自动重试，且不得删除状态文件 / 强杀目标进程', () => {
  const block = mainJs.split('async function execOwnedStopCli')[1] || ''
  const body = block.split("ipcMain.handle('gateway:stop'")[0] || ''
  assert.ok(!/\bwhile\s*\(/.test(body), '停止路径出现循环（可能构成自动重试）')
  // 不得删除任何文件
  assert.ok(!/unlink|rmSync|unlinkSync|Remove-Item/i.test(body), '停止路径出现删除文件调用')
  // 不得强杀**目标/其它**进程（自己对子进程的超时清理 child.kill() 允许）
  assert.ok(!/process\.kill\s*\(|taskkill|Stop-Process/i.test(body), '停止路径出现强杀进程调用')
  assert.ok(/child\.kill\(\)/.test(body), '超时保护应只作用于自己派生的子进程')
  // 启动路径同理：单次等待 + 命中 race lost 即返回（不重试、不删文件、不强杀）
  const sblock = (mainJs.split("ipcMain.handle('gateway:startProfile'")[1] || '').split("ipcMain.handle('")[0] || ''
  assert.ok(/pid-file-race-lost/.test(sblock), '启动路径未处理 race lost')
  assert.ok(!/unlink|rmSync|taskkill|Stop-Process|process\.kill/i.test(sblock), '启动路径出现删除/强杀调用')
})

test('33. 安全规则必须保留（B 态禁停 / 关闭不自动停 / 重启与接管禁用）', () => {
  assert.ok(/const ALLOW_AUTO_STOP = false/.test(mainJs), 'ALLOW_AUTO_STOP 被改动')
  assert.ok(/const ALLOW_DANGEROUS_EXEC = false/.test(mainJs), 'ALLOW_DANGEROUS_EXEC 被改动')
  assert.ok(/const ALLOW_OWNED_STOP = true/.test(mainJs), 'ALLOW_OWNED_STOP 缺失')
  assert.ok(/停止仅对本控制台启动并持有的实例/.test(appJs), '缺少 B 态禁停文案')
  assert.ok(/restartBtn\.disabled = true/.test(appJs), '重启按钮未保持禁用')
  assert.ok(/btnGwAdopt/.test(indexHtml) && /disabled/.test((indexHtml.split('btnGwAdopt')[1] || '').slice(0, 60)),
    '接管按钮未保持禁用')
})

test('34. 停止成功判定必须同时满足：退出码 0 + OS 探测成功 + 目标 PID 消失 + 同 Profile 剩余 0 + 状态文件不矛盾', () => {
  const block = mainJs.split('async function execOwnedStopCli')[1] || ''
  const body = block.split("ipcMain.handle('gateway:stop'")[0] || ''
  assert.ok(/decideStopVerification/.test(body), '未使用纯函数 decideStopVerification 做成功判定')
  for (const k of ['exitCode', 'osProbeError', 'osPidStillAlive', 'sameProfileProcesses', 'stateFileStillSame']) {
    assert.ok(new RegExp(k).test(body), `成功判定未纳入条件: ${k}`)
  }
  assert.ok(/verdict\.verified/.test(body), '未根据 verdict.verified 决定成败')
  // 未确认时统一 stop-unverified 且 ok:false（不得有任何"状态文件消失即成功"的旧分支）
  const tail = body.slice(body.indexOf('verdict.verified'), body.indexOf('verdict.verified') + 900)
  assert.ok(/ok:\s*false/.test(tail) && /stop-unverified/.test(tail), '未确认时未统一返回 stop-unverified / ok:false')
  assert.ok(!/状态文件仍记录着目标实例在运行 —— 停止结果未确认/.test(body), '残留旧的"只看状态文件"成功分支')
})

// ---------------------------------------------------------------- 本轮（状态一致性修复）
console.log('\n[状态一致性] 运行态以 OS 核验为准 · 失效所有权安全释放 · 启动后停止按钮解锁')

test('A1. 界面运行态不得读 serve 缓存 gateway_running（必须来自 BOOT.gateways 的 OS 核验）', () => {
  // 渲染层不得用 serve 后端 /api/status 的陈旧值驱动显示
  assert.ok(!/STATUS_CACHE\.gateway_running/.test(appJs), 'app.js 仍用 serve 缓存的 gateway_running 驱动显示')
  assert.ok(/function gwRunning\s*\(/.test(appJs), '缺少 gwRunning()')
  assert.ok(/BOOT\.gateways/.test(appJs), '运行态未取自 BOOT.gateways（OS 核验）')
  assert.ok(/source:\s*'os-probe'/.test(mainJs), 'getBootstrapInfo 未标注运行态来源为 os-probe')
})

test('A2. getBootstrapInfo 的网关运行态来自 readProfileGateway（OS 核验），不取 /api/status', () => {
  const block = (mainJs.split('function getBootstrapInfo()')[1] || '').split('function ')[0] || ''
  assert.ok(/readProfileGateway\(p\)/.test(block), 'getBootstrapInfo 未调用 readProfileGateway（OS 核验）')
  assert.ok(/running:\s*!!g\.running/.test(block), 'getBootstrapInfo 未以 OS 核验的 running 为准')
})

test('A3. 失效所有权必须被安全释放：getBootstrapInfo 用 liveOwnedOf（进程死亡即失权）', () => {
  const block = (mainJs.split('function getBootstrapInfo()')[1] || '').split('function ')[0] || ''
  assert.ok(/liveOwnedOf\(p\.id\)/.test(block), 'getBootstrapInfo 未用 liveOwnedOf 释放失效所有权')
  const lo = (mainJs.split('function liveOwnedOf')[1] || '').split('function ')[0] || ''
  assert.ok(/!pidAlive\(inst\.pid\)/.test(lo), 'liveOwnedOf 未在 PID 死亡时失权')
  assert.ok(/releaseOwnership\(profileId\)/.test(lo), 'liveOwnedOf 未释放失效所有权')
})

test('A4. 启动期探测也用 OS 核验，不再读 serve /api/status（serve 与真实 Gateway 严格分离）', () => {
  const block = (mainJs.split('async function probeGatewayPreExisted')[1] || '').split('async function ')[0] || ''
  assert.ok(/readProfileGateway\(/.test(block), 'probeGatewayPreExisted 未改用 readProfileGateway')
  assert.ok(!/callApi\('GET', '\/api\/status'\)/.test(block), 'probeGatewayPreExisted 仍读 serve /api/status')
})

test('B1. 控制台启动 Gateway 成功后必须登记所有权（registerOwnershipFor + 定向重读参数）', () => {
  const block = (mainJs.split("ipcMain.handle('gateway:startProfile'")[1] || '').split("ipcMain.handle('")[0] || ''
  assert.ok(/registerOwnershipFor\(p,\s*\{\s*startedByUs:\s*true,\s*expectedPid:\s*now\.pid\s*\}\)/.test(block),
    'startProfile 成功分支未以「本控制台刚启动」的显式参数登记所有权（定向重读的前提）')
  assert.ok(/ownership:\s*reg/.test(block), 'startProfile 未把登记结果并入返回')
})

test('B2. 启动成功后界面必须 reloadBootstrap 重读主进程所有权（停止按钮才能解锁）', () => {
  const i = appJs.indexOf('const doStartProfile')
  assert.ok(i >= 0, '未找到 doStartProfile')
  const end = appJs.indexOf("if ($('btnStartDefault')", i)
  const block = appJs.slice(i, end > i ? end : i + 900)
  assert.ok(/reloadBootstrap\(\)/.test(block), 'doStartProfile 启动后未 reloadBootstrap（停止按钮不会解锁）')
})

test('B3. 停止按钮解锁严格取决于 A 态所有权（owned），且运行态来自 OS 核验', () => {
  assert.ok(/stopBtn\.disabled = !owned/.test(appJs), '停止按钮未按 owned 禁用/启用')
  const u = (appJs.split('function updateGatewayControls')[1] || '').split('function ')[0] || ''
  assert.ok(/ownershipModeOf\('default', running\)/.test(u), 'updateGatewayControls 未以 OS 核验 running 计算模式')
})

// ---------------------------------------------------------------- 输出
console.log(results.join('\n'))
console.log('='.repeat(78))
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(78))
process.exit(fail ? 1 : 0)
