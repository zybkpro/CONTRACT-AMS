'use strict'
/**
 * 组装 macOS .app 并打包为可分发 zip（Intel x64 + Apple Silicon arm64）
 *  - 直接改写 Electron 官方 darwin zip 的条目，保留 Unix 权限与 Framework 符号链接
 *  - Windows 上无法运行 hdiutil / codesign，真正的 .dmg 由随包的 make-dmg.sh 在 Mac 上生成
 * 用法: node scripts/package-mac.js
 */
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { readZip, writeZip } = require('./lib/zip')
const { PREFIX, RES, infoPlist, collectAppFiles, helperScripts, makeIcns } = require('./lib/mac-bundle')
const { assertProductionLicenseSafe } = require('./lib/license-guard')

const ROOT = path.join(__dirname, '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const ELECTRON_VERSION = '33.4.9'
const RELEASE = path.join(ROOT, 'release')
const WORK = path.join(ROOT, '.packaging', 'mac')
const APP_NAME = '合同管理系统.app'
const MIRROR = `https://cdn.npmmirror.com/binaries/electron/${ELECTRON_VERSION}/`
const ARCHES = ['x64', 'arm64']

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

function build(arch, zipFile, icns) {
  const src = readZip(zipFile)
  const plistEntry = src.find((e) => e.name === `${PREFIX}Contents/Info.plist`)
  if (!plistEntry) throw new Error('官方包中未找到 Info.plist')

  const out = []
  for (const e of src) {
    if (e.name.startsWith('__MACOSX/') || e.name.endsWith('.DS_Store')) continue
    if (e.name === `${PREFIX}Contents/Info.plist`) continue
    if (e.name === `${RES}default_app.asar`) continue      // 让 Resources/app 生效
    if (e.name === `${RES}electron.icns`) { out.push({ ...e, data: icns }); continue }
    out.push(e)
  }
  out.push({ name: `${PREFIX}Contents/Info.plist`, data: infoPlist(plistEntry.data, VERSION), mode: 0o100644 })
  out.push({ name: `${RES}app.icns`, data: icns, mode: 0o100644 })
  out.push(...collectAppFiles(ROOT, VERSION))
  for (const e of out) if (e.name.startsWith(PREFIX)) e.name = APP_NAME + '/' + e.name.slice(PREFIX.length)
  // 随包附带 Mac 端辅助脚本，保持可执行位
  for (const s of helperScripts(VERSION, APP_NAME))
    out.push({ name: s.name, data: Buffer.from(s.content, 'utf8'), mode: s.mode })

  const target = path.join(RELEASE, `合同管理系统-macOS-${arch}-${VERSION}.zip`)
  writeZip(target, out)
  src.length = 0; out.length = 0
  return target
}

function verify(zipFile) {
  const es = readZip(zipFile)
  const get = (n) => es.find((e) => e.name === n)
  const exe = get(`${APP_NAME}/Contents/MacOS/Electron`)
  const plist = get(`${APP_NAME}/Contents/Info.plist`).data.toString('utf8')
  const index = get(`${APP_NAME}/Contents/Resources/app/dist/index.html`)
  const icns = get(`${APP_NAME}/Contents/Resources/app.icns`)
  const links = es.filter((e) => (e.mode & 0o170000) === 0o120000)
  const framework = es.some((e) => e.name.includes('Electron Framework.framework'))
  const checks = {
    '主程序可执行位': !!exe && (exe.mode & 0o111) !== 0,
    '符号链接保留': links.length > 0,
    'Electron Framework': framework,
    'Info.plist 应用名': plist.includes('合同管理系统') && plist.includes('NSAllowsLocalNetworking'),
    '前端页面': !!index,
    '自定义图标': !!icns && icns.data.slice(0, 4).toString() === 'icns',
  }
  for (const [k, v] of Object.entries(checks)) console.log(`    ${v ? 'OK  ' : 'FAIL'} ${k}`)
  es.length = 0
  if (Object.values(checks).some((v) => !v)) throw new Error(`${path.basename(zipFile)} 校验未通过`)
  return links.length
}

;(async () => {
  const t0 = Date.now()
  assertProductionLicenseSafe()
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('请先执行 npm run build')
  fs.mkdirSync(RELEASE, { recursive: true })
  fs.mkdirSync(WORK, { recursive: true })
  const icns = makeIcns()

  for (const [name, content] of helperScripts(VERSION, APP_NAME).map((s) => [s.name, s.content])) {
    fs.writeFileSync(path.join(RELEASE, name), content, { mode: 0o755 })
  }
  console.log('  · 已生成 make-dmg.sh / mac-first-run.sh')

  const results = []
  for (const arch of ARCHES) {
    console.log(`\n[${arch}] 下载 Electron macOS 运行时`)
    const file = `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`
    const zipFile = path.join(WORK, file)
    await download(MIRROR + file, zipFile)
    console.log(`[${arch}] 组装 .app 并写出 zip`)
    const target = build(arch, zipFile, icns)
    console.log(`[${arch}] 校验包内容`)
    const links = verify(target)
    console.log(`  ✓ ${path.basename(target)}  ${mb(target)}  (${links} 个符号链接)`)
    results.push(target)
  }

  console.log(`\n完成（${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟）：`)
  for (const f of results) console.log('  ', f, mb(f))
  console.log('  在 Mac 上解压任一 zip → 运行 mac-first-run.sh → 双击 .app；运行 make-dmg.sh 可生成 .dmg')
})().catch((e) => { console.error('\n✗ 打包失败:', e.message); process.exit(1) })
