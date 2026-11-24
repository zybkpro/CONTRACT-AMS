'use strict'
/**
 * 跨平台打包 Windows 绿色版（无需 NSIS / PowerShell，macOS/Linux 上即可产出）
 *  - 下载 Electron 官方 win32 运行时（x64 / ia32），注入应用文件到 resources/app
 *  - 输出 ZIP，Windows 上解压后运行 CONTRACT-AMS.exe 即用
 * 注：NSIS .exe 安装包需 Windows + rcedit/NSIS，由 scripts/package-desktop.js 在 Windows 上生成。
 * 用法: node scripts/package-win-portable.js [x64|ia32]
 *   - 默认 x64，文件名：合同管理系统-Windows-<版本>-绿色版.zip
 *   - ia32（32 位），文件名：合同管理系统-Windows32位-<版本>-绿色版.zip
 */
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { readZip, writeZip } = require('./lib/zip')

const ROOT = path.join(__dirname, '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
// V1.2：可用环境变量覆盖 Electron 版本，打 Win7 兼容版（Electron 22.3.27 是最后支持 Win7 的分支）
const ELECTRON_VERSION = process.env.CONTRACTAMS_ELECTRON_VERSION || '33.4.9'
const IS_WIN7 = process.env.CONTRACTAMS_WIN7 === '1'
const RELEASE = path.join(ROOT, 'release')
const WORK = path.join(ROOT, '.packaging', IS_WIN7 ? 'win7' : 'win')
const ARCH = (process.argv[2] === 'ia32') ? 'ia32' : 'x64'
const ARCH_LABEL = ARCH === 'ia32' ? 'Windows32位' : 'Windows'
const EDITION = IS_WIN7 ? 'Win7兼容版' : '绿色版'
const ZIP_FILE = path.join(RELEASE, `合同管理系统-${ARCH_LABEL}-${VERSION}-${EDITION}.zip`)
const MIRROR = `https://cdn.npmmirror.com/binaries/electron/${ELECTRON_VERSION}/`
const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return console.log('  · 已缓存', path.basename(dest))
  let last
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest))
      console.log('  ↓', path.basename(dest), mb(dest))
      return
    } catch (e) {
      last = e
      try { fs.unlinkSync(dest) } catch (_) {}
      if (i < 3) { console.log(`  · 第 ${i + 1} 次失败，重试…`); await new Promise((r) => setTimeout(r, 1500 * (i + 1))) }
    }
  }
  throw new Error(`${path.basename(dest)} 下载失败: ${last?.message || ''}`)
}

/** 收集要注入 resources/app 下的文件 */
function appEntries() {
  const out = []
  const add = (rel, data, mode = 0o100644) => out.push({ name: `resources/app/${rel}`, data, mode })
  add('package.json', Buffer.from(JSON.stringify({
    name: 'contract-ams', productName: '合同管理系统', version: VERSION,
    main: 'apps/desktop/main.js', dependencies: { 'sql.js': '^1.13.0' },
  }, null, 2)))
  for (const f of [
    'apps/desktop/main.js', 'apps/desktop/preload.js',
    'packages/api-server/db.js', 'packages/api-server/core.js', 'packages/api-server/http.js',
    'packages/api-server/license.js',
    // V1.1 备份：main.js 启动时 require('./backup')，backup 又依赖 scripts/lib/zip
    'packages/api-server/backup.js', 'scripts/lib/zip.js',
    'server/seed.json',
  ]) add(f, fs.readFileSync(path.join(ROOT, f)))
  const walk = (abs, rel) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, item.name), r = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(p, r)
      else if (item.isFile()) add(`dist/${r}`, fs.readFileSync(p))
    }
  }
  walk(path.join(ROOT, 'dist'), '')
  const sql = path.join(ROOT, 'node_modules', 'sql.js')
  add('node_modules/sql.js/package.json', fs.readFileSync(path.join(sql, 'package.json')))
  for (const f of ['sql-wasm.js', 'sql-wasm.wasm'])
    add(`node_modules/sql.js/dist/${f}`, fs.readFileSync(path.join(sql, 'dist', f)))
  return out
}

function verify(zipFile) {
  const es = readZip(zipFile)
  const get = (n) => es.find((e) => e.name === n)
  const exe = get('CONTRACT-AMS.exe')
  const index = get('resources/app/dist/index.html')
  const main = get('resources/app/apps/desktop/main.js')
  const wasm = get('resources/app/node_modules/sql.js/dist/sql-wasm.wasm')
  const checks = {
    '主程序': !!exe,
    '前端页面': !!index,
    '主进程代码': !!main,
    'SQLite WASM 运行时': !!wasm,
  }
  for (const [k, v] of Object.entries(checks)) console.log(`    ${v ? 'OK  ' : 'FAIL'} ${k}`)
  es.length = 0
  if (Object.values(checks).some((v) => !v)) throw new Error('Windows 包校验未通过')
}

;(async () => {
  const t0 = Date.now()
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('请先执行 npm run build')
  fs.mkdirSync(RELEASE, { recursive: true })
  fs.mkdirSync(WORK, { recursive: true })

  const file = `electron-v${ELECTRON_VERSION}-win32-${ARCH}.zip`
  const zipFile = path.join(WORK, file)
  console.log('[1/3] 下载 Electron Windows 运行时')
  await download(MIRROR + file, zipFile)

  console.log('[2/3] 组装 green 版（注入 resources/app）')
  const src = readZip(zipFile)
  const out = []
  for (const e of src) {
    if (e.name.startsWith('__MACOSX/') || e.name.endsWith('.DS_Store')) continue
    if (e.name === 'resources/default_app.asar') continue
    if (e.name === 'electron.exe') { out.push({ ...e, name: 'CONTRACT-AMS.exe' }); continue }
    out.push(e)
  }
  out.push(...appEntries())
  // V1.2：附带安全模式启动脚本（GPU 兼容问题一键启动）
  const safeBat = path.join(__dirname, 'win-safe-mode.bat')
  if (fs.existsSync(safeBat)) out.push({ name: '安全模式启动.bat', data: fs.readFileSync(safeBat), mode: 0o100644 })
  writeZip(ZIP_FILE, out)
  src.length = 0; out.length = 0

  console.log('[3/3] 校验包内容')
  verify(ZIP_FILE)
  console.log(`\n完成（${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟）：`)
  console.log(`  Windows 绿色版（${ARCH === 'ia32' ? '32 位' : '64 位'}）:`, ZIP_FILE, mb(ZIP_FILE))
  console.log('  解压后运行 CONTRACT-AMS.exe 即可；.exe 安装包请在 Windows 上执行 npm run package（NSIS）。')
})().catch((e) => { console.error('\n✗ 打包失败:', e.message); process.exit(1) })
