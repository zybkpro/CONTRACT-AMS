'use strict'
/**
 * Electron 主进程（主机模式）
 *  - 持有唯一 SQLite 主库；渲染进程通过 IPC 调用 API（服务停止时桌面依旧可用）
 *  - 内嵌可启停的局域网 HTTP 服务，供同网段 H5 / 其它 PC 访问同一份数据
 */
const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } = require('electron')
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
      if (!(err instanceof ApiError)) console.error('[CONTRACT-AMS IPC]', err)
      return { ok: false, error: err.message || '操作失败' }
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
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })

  // 默认直接加载本地构建产物：不依赖 Vite，也不依赖局域网服务是否启动
  // 开发调试时设置 CONTRACTAMS_DEV=1 并启动 `npm run dev`，即可加载 Vite 热更新页面
  const dev = process.env.CONTRACTAMS_DEV === '1'
  if (dev) win.loadURL(DEV_URL)
  else win.loadFile(DIST_INDEX)
  applySavedIcon()
}

app.whenReady().then(async () => {
  await db.init()
  registerIpc()
  createWindow()
  if (db.getConfig().autoStart) {
    try { await lan.start() } catch (e) { console.warn('[CONTRACT-AMS] 自动启动服务失败:', e.message) }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', async () => { try { await lan.stop() } catch (_) {} })
