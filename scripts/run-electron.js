'use strict'
/** Electron 启动器：清理宿主注入的 NODE_OPTIONS（Electron 不允许其中的部分开关） */
const { spawn } = require('child_process')
const path = require('path')

let exe
try { exe = require('electron') } catch (_) {
  exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
}
const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  env, stdio: 'inherit', windowsHide: false,
})
child.on('exit', (code) => process.exit(code || 0))
child.on('error', (e) => { console.error('[CONTRACT-AMS] Electron 启动失败:', e.message); process.exit(1) })
