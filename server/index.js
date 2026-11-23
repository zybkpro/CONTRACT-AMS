'use strict'
/**
 * 独立 Node 服务入口（开发预览 / 无 Electron 的主机模式 / 后续抽离成 Windows 服务）
 * 与 Electron 主进程共用 packages/api-server 里的 SQLite + core + HTTP 实现，接口完全一致。
 * 用法：node server/index.js [--port 8788] [--token ABC123] [--readonly] [--https]
 *   --https 启用自签证书 HTTPS，供手机 H5 调用合同查阅（首次访问需信任证书）
 */
const path = require('path')
const db = require(path.join(__dirname, '..', 'packages', 'api-server', 'db'))
const { LanServer } = require(path.join(__dirname, '..', 'packages', 'api-server', 'http'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

;(async () => {
  await db.init()
  const patch = {}
  if (process.argv.includes('--port')) patch.port = Number(arg('port', 8788))
  if (process.argv.includes('--token')) patch.token = String(arg('token', '')).toUpperCase()
  if (process.argv.includes('--readonly')) patch.h5ReadOnly = true
  if (process.argv.includes('--https')) patch.https = true
  if (Object.keys(patch).length) db.saveConfig(patch)

  // V1.1 定时备份（按设置自动触发）
  require(path.join(__dirname, '..', 'packages', 'api-server', 'backup')).startAutoBackup()

  const lan = new LanServer()
  const status = await lan.start()
  console.log('──────────────────────────────────────────────')
  console.log('  合同管理系统 · 主机服务已启动')
  console.log(`  本机桌面页 : ${status.desktopUrl}`)
  console.log(`  H5 移动端  : ${status.h5Url}`)
  console.log(`  局域网地址 : ${status.urls.join('  |  ') || '未检测到局域网 IP'}`)
  console.log(`  访问口令   : ${status.token}`)
  console.log(`  H5 只读    : ${status.h5ReadOnly ? '是' : '否'}`)
  console.log(`  传输协议   : ${status.https ? 'HTTPS（自签证书，合同查阅可用）' : 'HTTP（摄像头受浏览器限制）'}`)
  console.log(`  数据库     : ${db.DB_FILE}`)
  console.log('──────────────────────────────────────────────')
  process.on('SIGINT', async () => { await lan.stop(); process.exit(0) })
})().catch((e) => { console.error('[CONTRACT-AMS] 启动失败:', e.message); process.exit(1) })
