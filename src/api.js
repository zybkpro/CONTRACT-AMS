/**
 * 统一 API 客户端
 *  - Electron 渲染进程：走主进程 IPC（局域网服务未启动时桌面功能依旧可用）
 *  - 浏览器 / H5：走同源 HTTP（同一份 core.dispatch + 同一份 SQLite）
 */
const TOKEN_KEY = 'contractams-lan-token'       // 局域网访问口令
const SESSION_KEY = 'contractams-session'       // 用户登录会话
const USER_KEY = 'contractams-current-user'
export const isDesktop = typeof window !== 'undefined' && !!window.contractams?.isDesktop

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || '' } catch (_) { return '' } }
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch (_) {}
}
export function getSession() { try { return localStorage.getItem(SESSION_KEY) || '' } catch (_) { return '' } }
export function setSession(token, user) {
  try {
    token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY)
    user ? localStorage.setItem(USER_KEY, JSON.stringify(user)) : localStorage.removeItem(USER_KEY)
  } catch (_) {}
}
export function getCurrentUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch (_) { return null } }
export function clearSession() { setSession('', null) }
/** 兼容旧代码：role 从当前登录用户派生 */
export function getRole() { return getCurrentUser()?.role || 'guest' }

/** 桌面端 file:// 页面不能访问 /media/ 绝对路径，改指向本机数据目录 */
function desktopFileUrl(url) {
  const base = String(window.contractams?.mediaDir || '').replace(/\\/g, '/')
  if (!base || !url.startsWith('/media/')) return url
  return `file:///${base.replace(/^\/+/, '')}/${url.slice('/media/'.length)}`
}
export function mediaUrl(url) {
  if (!url) return ''
  if (isDesktop) return desktopFileUrl(url)
  const t = getToken()
  return t ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : url
}
export function downloadUrl(url) {
  if (!url) return ''
  const u = mediaUrl(url)
  if (isDesktop) return u
  return `${u}${u.includes('?') ? '&' : '?'}download=1`
}

async function request(path, options = {}) {
  const method = options.method || 'GET'
  if (isDesktop) {
    const [pathname, qs] = path.split('?')
    const query = Object.fromEntries(new URLSearchParams(qs || ''))
    const body = options.body ? JSON.parse(options.body) : {}
    const r = await window.contractams.invoke(method, pathname, query, body, getSession())
    if (!r.ok) throw new Error(r.error || '操作失败')
    return r.data
  }
  const headers = { 'Content-Type': 'application/json', 'X-CONTRACTAMS-Session': getSession(), ...(options.headers || {}) }
  const t = getToken()
  if (t) headers['X-CONTRACTAMS-Token'] = t
  const res = await fetch(path, { ...options, headers })
  let json
  try { json = await res.json() }
  catch (_) { throw new Error(`服务返回异常（HTTP ${res.status}）`) }
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `请求失败（HTTP ${res.status}）`)
    err.code = json.code || (res.status === 401 ? 'UNAUTHORIZED' : '')
    err.status = res.status
    throw err
  }
  return json.data
}

const body = (method, data) => ({ method, body: JSON.stringify(data || {}) })

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  health: () => request('/api/health'),
  dashboard: (projectId) => request(`/api/dashboard${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  nextCode: (direction) => request(`/api/next-code?direction=${encodeURIComponent(direction)}`),
  logs: (contractId) => request(`/api/logs${contractId ? `?contractId=${encodeURIComponent(contractId)}` : ''}`),

  // 合同
  createContract: (data) => request('/api/contracts', body('POST', data)),
  updateContract: (id, data) => request(`/api/contracts/${id}`, body('PUT', data)),
  deleteContract: (id, extra) => request(`/api/contracts/${id}`, body('DELETE', extra || {})),
  getContract: (id) => request(`/api/contracts/${id}`),
  changeStatus: (id, data) => request(`/api/contracts/${id}/status`, body('POST', data)),
  archive: (id, action) => request(`/api/contracts/${id}/${action}`, body('POST')),
  approve: (id, data) => request(`/api/contracts/${id}/approve`, body('POST', data)),

  // 项目 / 相对方
  createProject: (data) => request('/api/projects', body('POST', data)),
  updateProject: (id, data) => request(`/api/projects/${id}`, body('PUT', data)),
  deleteProject: (id) => request(`/api/projects/${id}`, body('DELETE')),
  createParty: (data) => request('/api/parties', body('POST', data)),
  updateParty: (id, data) => request(`/api/parties/${id}`, body('PUT', data)),
  deleteParty: (id) => request(`/api/parties/${id}`, body('DELETE')),

  // 文件
  uploadFile: (cid, data) => request(`/api/contracts/${cid}/files`, body('POST', data)),
  contractFiles: (cid) => request(`/api/contracts/${cid}/files`),
  deleteFile: (id) => request(`/api/contract-files/${id}`, body('DELETE')),
  resolveFile: (fileId) => request('/api/files/resolve', body('POST', { fileId })),
  logFileView: (data) => request('/api/files/view-log', body('POST', data)),

  // 履约 / 收付款
  addMilestone: (data) => request('/api/milestones', body('POST', data)),
  updateMilestone: (id, data) => request(`/api/milestones/${id}`, body('PUT', data)),
  deleteMilestone: (id) => request(`/api/milestones/${id}`, body('DELETE')),
  addPaymentPlan: (data) => request('/api/payment-plans', body('POST', data)),
  generatePaymentPlans: (data) => request('/api/payment-plans/generate', body('POST', data)),
  updatePaymentPlan: (id, data) => request(`/api/payment-plans/${id}`, body('PUT', data)),
  deletePaymentPlan: (id) => request(`/api/payment-plans/${id}`, body('DELETE')),
  addPaymentRecord: (data) => request('/api/payment-records', body('POST', data)),
  deletePaymentRecord: (id) => request(`/api/payment-records/${id}`, body('DELETE')),

  // 统计 / 字典 / 设置 / 导入
  // V1.1 发票
  invoices: (params = {}) => request(`/api/invoices${params.contractId ? `?contractId=${encodeURIComponent(params.contractId)}` : ''}`),
  invoiceSummary: (cid) => request(`/api/contracts/${cid}/invoices/summary`),
  createInvoice: (data) => request('/api/invoices', body('POST', data)),
  updateInvoice: (id, data) => request(`/api/invoices/${id}`, body('PUT', data)),
  deleteInvoice: (id) => request(`/api/invoices/${id}`, body('DELETE')),

  statsByProject: () => request('/api/stats/by-project'),
  statsByParty: () => request('/api/stats/by-party'),
  dictTypes: () => request('/api/dict-types'),
  addDictType: (data) => request('/api/dict-types', body('POST', data)),
  deleteDictType: (id) => request(`/api/dict-types/${id}`, body('DELETE')),
  dictCategories: () => request('/api/dict-categories'),
  addDictCategory: (data) => request('/api/dict-categories', body('POST', data)),
  deleteDictCategory: (id) => request(`/api/dict-categories/${id}`, body('DELETE')),
  saveSettings: (settings) => request('/api/settings', body('PUT', settings)),
  runBackup: (dir) => request('/api/backup/run', body('POST', { dir })),
  importContracts: (rows) => request('/api/import', body('POST', { rows })),

  auth: (token) => request('/api/auth', body('POST', { token })),

  // 账号登录 / 人员管理
  login: (username, password) => request('/api/login', body('POST', { username, password })),
  logout: () => request('/api/logout', body('POST')),
  current: () => request('/api/current'),
  changePassword: (oldPassword, newPassword) => request('/api/change-password', body('POST', { old_password: oldPassword, new_password: newPassword })),
  users: () => request('/api/users'),
  createUser: (data) => request('/api/users', body('POST', data)),
  updateUser: (id, data) => request(`/api/users/${id}`, body('PUT', data)),
  deleteUser: (id) => request(`/api/users/${id}`, body('DELETE')),
}

/** 局域网服务控制：桌面端走 IPC；开发环境由 Vite 启动钩子托管独立服务 */
export const service = {
  async status() {
    if (isDesktop) return window.contractams.service.status().then(unwrap)
    return request('/api/service/status')
  },
  async start() {
    if (isDesktop) return window.contractams.service.start().then(unwrap)
    if (!import.meta.env.DEV) throw new Error('请在终端执行 npm run server 启动局域网服务')
    const res = await fetch('/__contractams/service/start', { method: 'POST' })
    let json
    try { json = await res.json() }
    catch (_) { throw new Error('启动接口不可用，请在终端执行 npm run server') }
    if (!res.ok || json.ok === false) throw new Error(json.error || '启动失败')
    return json.data
  },
  async stop() {
    if (!isDesktop) return request('/api/service/shutdown', body('POST'))
    return window.contractams.service.stop().then(unwrap)
  },
  async config(patch) {
    if (!isDesktop) throw new Error('独立服务模式不支持在线修改配置')
    return window.contractams.service.config(patch).then(unwrap)
  },
}
function unwrap(r) { if (r && r.ok === false) throw new Error(r.error || '操作失败'); return r && 'data' in r ? r.data : r }

export const desktopApp = {
  info: () => isDesktop ? window.contractams.app.info().then(unwrap) : Promise.resolve(null),
  openDataDir: () => isDesktop ? window.contractams.app.openDataDir().then(unwrap) : Promise.resolve(false),
  setIcon: (dataURL) => isDesktop
    ? window.contractams.app.setIcon(dataURL).then(unwrap)
    : Promise.reject(new Error('仅桌面端支持修改应用图标')),
}

export const licenseApi = {
  status: () => isDesktop
    ? window.contractams.license.status().then(unwrap)
    : request('/api/license/status'),
  activate: (code) => isDesktop
    ? window.contractams.license.activate(code).then(unwrap)
    : request('/api/license/activate', body('POST', { code })),
  verify: () => isDesktop
    ? window.contractams.license.verify().then(unwrap)
    : request('/api/license/verify', body('POST')),
}
