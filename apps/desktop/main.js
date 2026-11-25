'use strict'
/**
 * Electron 主进程（主机模式）
 *  - 持有唯一 SQLite 主库；渲染进程通过 IPC 调用 API（服务停止时桌面依旧可用）
 *  - 内嵌可启停的局域网 HTTP 服务，供同网段 H5 / 其它 PC 访问同一份数据
 */
const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// 远程桌面 / 虚拟机 / 无独立 GPU 的环境可设置 CONTRACTAMS_SOFTWARE_RENDER=1 走软件渲染
if (process.env.CONTRACTAMS_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

const ROOT = path.join(__dirname, '..', '..')
if (!process.env.CONTRACTAMS_DATA_DIR) {
  // 打包后使用用户数据目录，开发时使用项目 data/
  process.env.CONTRACTAMS_DATA_DIR = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(ROOT, 'data')
}

// 兜底：后台运行/Windows 无控制台时 stdout/stderr 可能是已关闭的管道，
// 向其写入会以 async 'error' 事件抛出 EIO/EPIPE（try/catch 捕获不到）→ 主进程崩溃弹窗。
// 必须挂 error 监听器吞掉，且所有日志只写文件、绝不写 stdout。
try { process.stdout.on('error', () => {}) } catch (_) {}
try { process.stderr.on('error', () => {}) } catch (_) {}

// V1.2 启动诊断日志：Win10「有进程无窗口」等问题可查 data/app.log
const LOG_FILE = path.join(process.env.CONTRACTAMS_DATA_DIR, 'app.log')
function appLog(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`
  // 只写文件，不写控制台（控制台在后台/无控制台环境会 EIO 崩溃）
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch (_) {}
}
const OS_INFO = `${process.platform} ${process.arch} ${require('os').release()}`
appLog(`=== 启动 === 版本 ${require(path.join(ROOT, 'package.json')).version} | 系统 ${OS_INFO} | 软件渲染 ${process.env.CONTRACTAMS_SOFTWARE_RENDER === '1' ? '开' : '关'}`)
// Win7/8 检测（Electron 33 不支持；提示用户用兼容版）
if (process.platform === 'win32' && /^(6\.1|6\.2|6\.3)/.test(require('os').release())) {
  appLog('⚠ 检测到 Windows 7/8，本版本可能不兼容，请使用 Win7 兼容版或安全模式启动')
}

const db = require(path.join(ROOT, 'packages', 'api-server', 'db'))
const license = require(path.join(ROOT, 'packages', 'api-server', 'license'))
const { dispatch, ApiError } = require(path.join(ROOT, 'packages', 'api-server', 'core'))
const { LanServer } = require(path.join(ROOT, 'packages', 'api-server', 'http'))

const DEV_URL = process.env.CONTRACTAMS_DEV_URL || 'http://127.0.0.1:5176'
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html')
const lan = new LanServer()
let win = null

function wrap(fn) {
  return async (_e, payload) => {
    try { return { ok: true, data: await fn(payload || {}) } }
    catch (err) {
      if (!(err instanceof ApiError)) appLog(`✗ IPC 异常：${err?.stack || err?.message || err}`)
      // 带出 status，前端才能识别 401 并跳回登录页
      return { ok: false, error: err.message || '操作失败', status: err.status || 500 }
    }
  }
}

function registerIpc() {
  // preload 同步取媒体目录：file:// 页面无法使用 /media/ 绝对路径
  ipcMain.on('get-media-dir', (e) => { e.returnValue = db.MEDIA_DIR })

  // 业务 API：与 HTTP 共用 core.dispatch
  ipcMain.handle('api:invoke', wrap(({ method, path: p, query = {}, body = {}, token = '' }) => {
    const result = dispatch(method, p, new URLSearchParams(query), body, { source: 'ipc', trusted: true, token })
    return result.data
  }))

  // P0 附件修复：用系统默认应用预览文件（返回明确结果，替代 window.open(file://)）
  ipcMain.handle('file:preview', wrap(async ({ filePath }) => {
    const abs = String(filePath || '')
    if (!abs || !fs.existsSync(abs)) throw new ApiError(404, '文件不存在或已被移动')
    const r = await shell.openPath(abs)
    if (r) throw new ApiError(500, `系统打开失败：${r}`)
    return { ok: true }
  }))
  // P0 附件修复：另存为（用户选择目录，复制文件）
  ipcMain.handle('file:save', wrap(async ({ filePath, fileName }) => {
    const abs = String(filePath || '')
    if (!abs || !fs.existsSync(abs)) throw new ApiError(404, '文件不存在或已被移动')
    const { canceled, filePath: dest } = await dialog.showSaveDialog({
      title: '保存文件', defaultPath: String(fileName || path.basename(abs)),
    })
    if (canceled || !dest) return { canceled: true }
    fs.copyFileSync(abs, dest)
    return { ok: true, savedPath: dest }
  }))

  ipcMain.handle('service:status', wrap(() => lan.status()))
  ipcMain.handle('service:start', wrap(() => lan.start()))
  ipcMain.handle('service:stop', wrap(() => lan.stop()))
  ipcMain.handle('service:config', wrap((patch) => lan.setConfig(patch)))

  ipcMain.handle('app:info', wrap(() => ({
    version: app.getVersion(), dataDir: db.DATA_DIR, dbFile: db.DB_FILE,
    electron: process.versions.electron, node: process.versions.node,
    isPackaged: app.isPackaged,
  })))
  ipcMain.handle('app:openDataDir', wrap(() => { shell.openPath(db.DATA_DIR); return true }))

  // 激活码：机器码 / 激活 / 启动校验（Token 仅主进程持有）
  ipcMain.handle('license:status', wrap(() => license.getStatus()))
  ipcMain.handle('license:activate', wrap(({ code }) => license.activate(code)))
  ipcMain.handle('license:verify', wrap(() => license.verify()))

  // 修改软件图标：校验格式与尺寸，失败回退默认
  ipcMain.handle('app:setIcon', wrap(({ dataURL }) => {
    const img = nativeImage.createFromDataURL(String(dataURL || ''))
    if (img.isEmpty()) throw new ApiError(400, '图片格式不支持，请使用 PNG / JPG / ICO')
    const size = img.getSize()
    if (!size.width || !size.height || size.width > 1024 || size.height > 1024)
      throw new ApiError(400, `图标尺寸不合法（${size.width}×${size.height}），请使用 32～1024px 的图片`)
    if (Math.abs(size.width - size.height) > size.width * 0.3)
      throw new ApiError(400, '图标建议使用接近正方形的图片')
    const iconFile = path.join(db.DATA_DIR, 'app-icon.png')
    fs.writeFileSync(iconFile, img.toPNG())
    if (win) win.setIcon(iconFile)
    return { size, iconFile }
  }))
}

function applySavedIcon() {
  const f = path.join(db.DATA_DIR, 'app-icon.png')
  if (fs.existsSync(f) && win) { try { win.setIcon(f) } catch (_) {} }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1460, height: 920, minWidth: 1120, minHeight: 700,
    title: '合同管理系统',
    backgroundColor: '#020a17',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => { appLog('窗口已渲染显示'); win.show() })
  // 加载失败诊断（Win10 有进程无窗口的常见原因）
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    appLog(`✗ 页面加载失败：${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    appLog(`✗ 渲染进程崩溃：${details?.reason || 'unknown'}`)
  })
  // 20 秒仍未渲染则写日志提示（不弹窗，避免卡死无人看到）
  setTimeout(() => { if (win && !win.isVisible()) appLog('⚠ 窗口 20 秒未显示，可能是 GPU 渲染问题，请尝试安全模式启动') }, 20000)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })

  // 默认直接加载本地构建产物：不依赖 Vite，也不依赖局域网服务是否启动
  // 开发调试时设置 CONTRACTAMS_DEV=1 并启动 `npm run dev`，即可加载 Vite 热更新页面
  const dev = process.env.CONTRACTAMS_DEV === '1'
  if (dev) { appLog('加载开发服务器 ' + DEV_URL); win.loadURL(DEV_URL) }
  else { appLog('加载本地页面 ' + DIST_INDEX); win.loadFile(DIST_INDEX) }
  applySavedIcon()
}

app.whenReady().then(async () => {
  appLog(' Electron 主进程就绪，初始化数据库…')
  await db.init()
  appLog(' 数据库初始化完成，数据目录：' + db.DATA_DIR)
  // V1.1 定时备份（按设置自动触发）
  require(path.join(ROOT, 'packages', 'api-server', 'backup')).startAutoBackup()
  registerIpc()
  createWindow()
  if (db.getConfig().autoStart) {
    try { await lan.start() } catch (e) { appLog(`✗ 自动启动服务失败：${e.message}`) }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', async () => { try { await lan.stop() } catch (_) {} })
