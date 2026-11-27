'use strict'
/**
 * 一键打包 Windows 桌面端
 *  - 组装标准 Electron 应用目录（resources/app），不依赖 electron-builder / npm postinstall
 *  - 生成自定义图标并用 rcedit 写入 exe 资源与版本信息
 *  - NSIS 编译用户级安装包（无需管理员）+ 7za 生成绿色版 ZIP
 * 用法: node scripts/package-desktop.js
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { makeIco } = require('./lib/make-ico')
const buildNsi = require('./lib/nsi-template')
const { assertProductionLicenseSafe } = require('./lib/license-guard')

const ROOT = path.join(__dirname, '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const TOOLS = path.join(ROOT, '.packaging', 'tools')
const RELEASE = path.join(ROOT, 'release')
const UNPACKED = path.join(RELEASE, 'CONTRACT-AMS-win32-x64')
const APP = path.join(UNPACKED, 'resources', 'app')
const ICON = path.join(RELEASE, 'app.ico')
const SETUP = path.join(RELEASE, `合同管理系统-Setup-${VERSION}.exe`)
const ZIP = path.join(RELEASE, `合同管理系统-绿色版-${VERSION}.zip`)
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist')

const TOOL_URLS = {
  nsis: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.10/nsis-3.10.zip',
  sevenZip: 'https://www.7-zip.org/a/7za920.zip',
  // GitHub release 在本机网络常不通；npm 镜像的 rcedit 包内自带 bin/rcedit-x64.exe
  rcedit: 'https://cdn.npmmirror.com/packages/rcedit/3.0.0/rcedit-3.0.0.tgz',
}

function run(cmd, args, cwd = ROOT, timeout = 15 * 60 * 1000) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 执行失败:\n${(r.stderr || r.stdout || r.error?.message || '').slice(-1500)}`)
  return r.stdout || ''
}
function mb(file) { return (fs.statSync(file).size / 1024 / 1024).toFixed(1) + ' MB' }
function copy(rel, target = rel) {
  const dest = path.join(APP, target)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), dest)
}
async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return console.log('  · 已缓存', path.basename(dest))
  let lastErr
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest))
      if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) throw new Error('文件不完整')
      console.log('  ↓', path.basename(dest), mb(dest))
      return
    } catch (e) {
      lastErr = e
      try { fs.unlinkSync(dest) } catch (_) {}
      if (i < 3) { console.log(`  · ${path.basename(dest)} 第 ${i + 1} 次下载失败，重试…`); await new Promise((r) => setTimeout(r, 1200 * (i + 1))) }
    }
  }
  throw new Error(`${path.basename(dest)} 下载失败（已重试 4 次）: ${lastErr?.message || ''} ${url}`)
}
function cleanDir(dir) {
  if (!fs.existsSync(dir)) return
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`], { stdio: 'ignore' })
}

async function prepareTools() {
  fs.mkdirSync(TOOLS, { recursive: true })
  const nsisZip = path.join(TOOLS, 'nsis-3.10.zip')
  const sevenZip = path.join(TOOLS, '7za920.zip')
  const rcedit = path.join(TOOLS, 'rcedit-x64.exe')
  await download(TOOL_URLS.nsis, nsisZip)
  await download(TOOL_URLS.sevenZip, sevenZip)
  if (!fs.existsSync(rcedit)) {
    const tgz = path.join(TOOLS, 'rcedit-npm.tgz')
    await download(TOOL_URLS.rcedit, tgz)
    const srcDir = path.join(TOOLS, 'rcedit-src')
    fs.mkdirSync(srcDir, { recursive: true })
    run('tar', ['--force-local', '-xzf', 'rcedit-npm.tgz', '-C', 'rcedit-src'], TOOLS)
    fs.copyFileSync(path.join(srcDir, 'package', 'bin', 'rcedit-x64.exe'), rcedit)
  }
  if (!fs.existsSync(path.join(TOOLS, 'nsis', 'nsis-3.10', 'makensis.exe')))
    run('unzip', ['-q', '-o', 'nsis-3.10.zip', '-d', 'nsis'], TOOLS)
  if (!fs.existsSync(path.join(TOOLS, '7za', '7za.exe')))
    run('unzip', ['-q', '-o', '7za920.zip', '-d', '7za'], TOOLS)
  return {
    makensis: path.join(TOOLS, 'nsis', 'nsis-3.10', 'makensis.exe'),
    sevenZip: path.join(TOOLS, '7za', '7za.exe'),
    rcedit,
  }
}

function assemble() {
  fs.mkdirSync(RELEASE, { recursive: true })
  cleanDir(UNPACKED)
  fs.cpSync(ELECTRON_DIST, UNPACKED, { recursive: true, force: true })
  fs.mkdirSync(APP, { recursive: true })

  fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
    name: 'contract-ams', productName: '合同管理系统', version: VERSION,
    main: 'apps/desktop/main.js', dependencies: { 'sql.js': '^1.13.0' },
  }, null, 2))

  for (const f of [
    'apps/desktop/main.js', 'apps/desktop/preload.js',
    'packages/api-server/db.js', 'packages/api-server/core.js', 'packages/api-server/http.js',
    // V1.3.1 激活码功能：http.js 依赖 ./license，必须一并打包否则服务启动崩溃
    'packages/api-server/license.js',
    // V1.1 备份：main.js 启动时 require('./backup')，backup 又依赖 scripts/lib/zip
    'packages/api-server/backup.js', 'scripts/lib/zip.js',
    // V1.3 可选 HTTPS 自签证书：H5 摄像头扫码需要安全上下文
    'packages/api-server/cert/server.key', 'packages/api-server/cert/server.crt',
    'server/seed.json',
  ]) copy(f)

  fs.cpSync(path.join(ROOT, 'dist'), path.join(APP, 'dist'), { recursive: true })
  // 主进程只需要 sql.js 的 WASM 运行时，前端依赖已打进 dist
  const sqlSrc = path.join(ROOT, 'node_modules', 'sql.js')
  const sqlDst = path.join(APP, 'node_modules', 'sql.js', 'dist')
  fs.mkdirSync(sqlDst, { recursive: true })
  for (const f of ['sql-wasm.js', 'sql-wasm.wasm'])
    fs.copyFileSync(path.join(sqlSrc, 'dist', f), path.join(sqlDst, f))
  fs.copyFileSync(path.join(sqlSrc, 'package.json'), path.join(APP, 'node_modules', 'sql.js', 'package.json'))

  fs.renameSync(path.join(UNPACKED, 'electron.exe'), path.join(UNPACKED, 'CONTRACT-AMS.exe'))
  console.log('  ✓ 应用目录', UNPACKED)
}

function iconAndVersion(tools) {
  fs.writeFileSync(ICON, makeIco())
  fs.copyFileSync(ICON, path.join(UNPACKED, 'app.ico'))  // 快捷方式图标，独立于 exe 资源
  const exe = path.join(UNPACKED, 'CONTRACT-AMS.exe')
  try {
    run(tools.rcedit, [exe,
      '--set-icon', ICON,
      '--set-version-string', 'FileDescription', 'IT Asset Management System',
      '--set-version-string', 'ProductName', 'CONTRACT-AMS',
      '--set-version-string', 'CompanyName', 'CONTRACT-AMS',
      '--set-version-string', 'LegalCopyright', 'CONTRACT-AMS',
      '--set-file-version', `${VERSION}.0`,
      '--set-product-version', `${VERSION}.0`,
    ])
    console.log('  ✓ 图标与版本信息已写入 CONTRACT-AMS.exe')
  } catch (e) {
    // 图标/版本只是修饰，失败不应阻断安装包产出
    console.log('  ! 图标写入跳过（不影响使用）:', String(e.message).split('\n')[0])
  }
}

function buildInstaller(tools) {
  const nsi = buildNsi({ root: ROOT, unpacked: UNPACKED, outFile: SETUP, iconFile: ICON, version: VERSION })
  fs.writeFileSync(path.join(TOOLS, 'installer.nsi'), nsi, 'utf8')
  console.log('  … NSIS 编译中（约 1～3 分钟）')
  run(tools.makensis, ['/V1', 'installer.nsi'], TOOLS)
  console.log('  ✓ 安装包', SETUP, mb(SETUP))
}

function buildZip(tools) {
  console.log('  … 压缩绿色版中')
  run(tools.sevenZip, ['a', '-tzip', '-mx=5', '-y', ZIP, path.join(UNPACKED, '*')], ROOT)
  console.log('  ✓ 绿色版', ZIP, mb(ZIP))
}

;(async () => {
  const t0 = Date.now()
  assertProductionLicenseSafe()
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('请先执行 npm run build')
  if (!fs.existsSync(ELECTRON_DIST)) throw new Error('缺少 Electron 运行时，请先执行 npm run install:electron')

  console.log('[1/5] 准备打包工具')
  const tools = await prepareTools()
  console.log('[2/5] 组装 Electron 应用目录')
  assemble()
  console.log('[3/5] 写入图标与版本信息')
  iconAndVersion(tools)
  console.log('[4/5] 生成 NSIS 安装包')
  buildInstaller(tools)
  console.log('[5/5] 生成绿色版 ZIP')
  buildZip(tools)

  console.log(`\n打包完成（${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟）：`)
  console.log('  安装程序 :', SETUP, mb(SETUP))
  console.log('  绿色版   :', ZIP, mb(ZIP))
  console.log('  免安装目录:', UNPACKED)
})().catch((e) => { console.error('\n✗ 打包失败:', e.message); process.exit(1) })
