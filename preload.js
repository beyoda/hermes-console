/**
 * Hermes 桌面控制台 — 预加载脚本
 *
 * 只暴露具名方法。renderer 无法访问 Node、fs、child_process，
 * 也无法发起任意 HTTP —— 所有请求都要经过主进程白名单。
 */

const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED_EVENTS = ['backend:state', 'ui:exit-request']

contextBridge.exposeInMainWorld('hermes', {
  // 基础信息
  bootstrap: () => ipcRenderer.invoke('console:bootstrap'),
  restartBackend: () => ipcRenderer.invoke('console:restartBackend'),

  // 白名单 API 访问（主进程侧校验路径）
  get: (apiPath, params) => ipcRenderer.invoke('hermes:get', apiPath, params),
  post: (apiPath, body) => ipcRenderer.invoke('hermes:post', apiPath, body),

  // 生命周期 / 所有权
  // 注意：这里【没有】setGatewayOwnership —— 所有权不能被界面直接设定。
  // 界面只能请求「启动并接管(A)」「释放」或「签发一次性授权(C)」，
  // 真正的判定由主进程 authorizeDangerous() 完成。
  gatewayStatus: () => ipcRenderer.invoke('gateway:status'),
  gatewayAdopt: () => ipcRenderer.invoke('gateway:adopt'),
  gatewayRelease: () => ipcRenderer.invoke('gateway:release'),
  // 一次性授权：主进程会绑定目标实例身份，且【不下发任何 token 值】给渲染进程
  gatewayAuthorizeOnce: action => ipcRenderer.invoke('gateway:authorizeOnce', action),
  authorizationState: () => ipcRenderer.invoke('gateway:authorizationState'),
  clearAuthorization: () => ipcRenderer.invoke('gateway:clearAuthorization'),
  // opts **不承载任何放行语义**：界面确认既不是授权，也不能绕过"活跃任务未知时暂停"；
  // 权限判定只在主进程授权门，成功判定只在 decideStopVerification。
  gatewayStop: opts => ipcRenderer.invoke('gateway:stop', opts),
  gatewayRestart: () => ipcRenderer.invoke('gateway:restart'),
  gatewayDrain: () => ipcRenderer.invoke('gateway:drain'),

  // 系统集成
  gatewayMeta: () => ipcRenderer.invoke('console:gatewayMeta'),
  openLogsFolder: () => ipcRenderer.invoke('console:openLogsFolder'),
  openPath: p => ipcRenderer.invoke('console:openPath', p),
  openExternal: url => ipcRenderer.invoke('console:openExternal', url),

  // 扩展能力（外部工程 / 额外 Profile）：只读状态 + 固定目录入口
  capabilities: () => ipcRenderer.invoke('console:capabilities'),
  openCapability: id => ipcRenderer.invoke('console:openCapability', id),

  // 运行态服务（退出提示用）与按 Profile 手动启动（本轮唯一保留的写操作）
  services: () => ipcRenderer.invoke('console:services'),
  startProfile: (id, opts) => ipcRenderer.invoke('gateway:startProfile', id, opts),
  // 认证信息（只读，按 Profile；不含任何凭据）
  authInfo: (id, opts) => ipcRenderer.invoke('console:authInfo', id, opts),
  // 开始认证：仅打开独立终端执行**白名单内的官方命令**，控制台不参与 OAuth
  authStart: (id, opts) => ipcRenderer.invoke('console:authStart', id, opts),
  // 退出决策（渲染进程在退出提示里选择后回传）
  exitDecision: mode => ipcRenderer.invoke('console:exitDecision', mode),
  // 复制文本（仅用于把官方命令交给用户）
  copy: text => ipcRenderer.invoke('console:copy', text),

  // 多来源日志（一律只读；路径由主进程按来源白名单解析）
  logSources: () => ipcRenderer.invoke('console:logSources'),
  readLogs: opts => ipcRenderer.invoke('console:readLogs', opts),
  coverJobs: opts => ipcRenderer.invoke('console:coverJobs', opts),
  // 复制前强制脱敏（原始日志内容不会被明文外传）
  copyRedacted: text => ipcRenderer.invoke('console:copyRedacted', text),

  // 窗口控制
  windowControl: action => ipcRenderer.invoke('window:control', action),

  // 事件订阅（仅白名单事件）
  on: (channel, cb) => {
    if (!ALLOWED_EVENTS.includes(channel)) return () => {}
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
})
