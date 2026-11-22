'use strict'
/**
 * Electron 桌面运行时安装器（与 fast-install 同理，绕过本机 npm 网络栈）
 * 下载 npm 包 + Windows x64 二进制，放置到 node_modules/electron/dist 并生成 path.txt。
 * 正常网络环境可直接 `npm install -D electron`。
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const ROOT = path.join(__dirname, '..')
const NM = path.join(ROOT, 'node_modules')
const VERSION = process.argv[2] || '33.4.9'
const REG = `https://registry.npmmirror.com/electron/-/electron-${VERSION}.tgz`
const ZIP_URLS = [
  `https://npmmirror.com/mirrors/electron/${VERSION}/electron-v${VERSION}-win32-x64.zip`,
  `https://registry.npmmirror.com/-/binary/electron/${VERSION}/electron-v${VERSION}-win32-x64.zip`,
]
const TMP = path.join(ROOT, '.electron-install-tmp')
const ZIP = path.join(ROOT, '.electron-bin.zip')

async function download(url, dest, label) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${label} 下载失败 HTTP ${r.status}: ${url}`)
  const total = Number(r.headers.get('content-length') || 0)
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest))
  const got = fs.statSync(dest).size
  console.log(`  ↓ ${label}: ${(got / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`)
  if (total && got < total * 0.95) throw new Error(`${label} 下载不完整`)
}

function run(cmd, args, cwd = ROOT) {
  const p = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (p.status !== 0) throw new Error(`${cmd} 失败: ${(p.stderr || p.stdout || '').slice(0, 400)}`)
  return p.stdout
}

;(async () => {
  fs.mkdirSync(TMP, { recursive: true })
  const target = path.join(NM, 'electron')
  fs.mkdirSync(target, { recursive: true })

  // 1) npm 包（index.js / cli.js / package.json）
  const tgz = path.join(TMP, 'electron.tgz')
  await download(REG, tgz, `electron@${VERSION} npm 包`)
  run('tar', ['--force-local', '-xzf', tgz, '-C', TMP])
  fs.cpSync(path.join(TMP, 'package'), target, { recursive: true })

  // 2) Windows x64 二进制
  let zipUrl = null
  for (const u of ZIP_URLS) {
    try { const r = await fetch(u, { method: 'HEAD' }); if (r.ok) { zipUrl = u; break } } catch (_) {}
  }
  if (!zipUrl) throw new Error(`未找到 electron ${VERSION} 的 win32-x64 二进制镜像`)
  await download(zipUrl, ZIP, 'Electron 运行时')
  const distDir = path.join(target, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  console.log('  … 解压运行时（约 1 分钟）')
  run('unzip', ['-q', '-o', path.basename(ZIP), '-d', path.relative(ROOT, distDir)])

  // 3) path.txt + .bin 启动脚本
  fs.writeFileSync(path.join(target, 'path.txt'), 'electron.exe')
  const binDir = path.join(NM, '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'electron.cmd'),
    `@echo off\r\nnode "%~dp0..\\electron\\cli.js" %*\r\n`)
  fs.writeFileSync(path.join(binDir, 'electron'),
    `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec node "$basedir/../electron/cli.js" "$@"\n`, { mode: 0o755 })

  const exe = path.join(distDir, 'electron.exe')
  if (!fs.existsSync(exe)) throw new Error('解压后未找到 electron.exe')
  console.log(`\n✓ Electron ${VERSION} 安装完成: ${exe}`)
  console.log('  运行: npm run electron   （桌面端，服务默认未启动，本机功能仍可用）')
})().catch((e) => { console.error('✗', e.message); process.exit(1) })
