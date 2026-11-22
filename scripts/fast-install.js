'use strict'
/**
 * 轻量依赖安装器：绕过 npm 本机异常缓慢的网络栈，用 Node 原生 fetch 直连镜像。
 * 仅用于本项目开发环境的依赖准备；正常环境可直接 `npm install`。
 * 用法: node scripts/fast-install.js
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NM = path.join(ROOT, 'node_modules')
const REG = 'https://registry.npmmirror.com/'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'contractams-deps-'))
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const queue = []
for (const [name, range] of Object.entries(pkgJson.dependencies || {})) queue.push({ name, range })
for (const [name, range] of Object.entries(pkgJson.devDependencies || {})) {
  if (name === 'electron') continue // 二进制由 scripts/install-electron.js 单独安装
  queue.push({ name, range, dev: true })
}
const done = new Map()
const failed = []
let running = 0
const waiters = []

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
async function slot() {
  while (running >= 8) await new Promise((r) => waiters.push(r))
  running++
  return () => { running--; const w = waiters.shift(); if (w) w() }
}
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (i === tries - 1) throw e; await sleep(300) }
  }
}
function registryUrl(name) {
  return REG + (name.startsWith('@') ? name.replace('/', '%2f') : name)
}
function parseV(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '')
  return m ? [+m[1], +m[2], +m[3]] : null
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i] }
  return 0
}
function satisfies(v, range) {
  const p = parseV(v)
  if (!p || !range) return false
  for (const part of String(range).split('||')) {
    const r = part.trim()
    if (!r || r === '*' || r === 'latest') return true
    if (/^\d+\.\d+\.\d+$/.test(r)) { if (v === r) return true; continue }
    const m = /^([~^>=<]*)\s*(\d+)\.(\d+)\.(\d+)/.exec(r)
    if (!m) continue
    const base = [+m[2], +m[3], +m[4]]
    const op = m[1]
    if (r.startsWith('>=') && cmp(p, base) >= 0) return true
    if (r.startsWith('<') && cmp(p, base) < 0) return true
    if (op === '^' || op === '~') {
      if (cmp(p, base) < 0) continue
      const upper = op === '^'
        ? (base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1])
        : [base[0], base[1] + 1, 0]
      if (cmp(p, upper) < 0) return true
    }
    if (!op && cmp(p, base) === 0) return true
  }
  return false
}
function pickVersion(pack, range) {
  const versions = Object.keys(pack.versions || {}).filter((v) => !v.includes('-') && parseV(v))
  const hit = versions.filter((v) => satisfies(v, range)).sort((a, b) => cmp(parseV(b), parseV(a)))[0]
  return hit || pack['dist-tags']?.latest
}
function tarballUrl(name, version, manifest) {
  const short = name.startsWith('@') ? name.split('/')[1] : name
  const fallback = `${REG}${name}/-/${short}-${version}.tgz`
  const raw = manifest?.dist?.tarball || fallback
  try {
    const u = new URL(raw)
    return `${REG}${name}/-/${path.basename(u.pathname)}`
  } catch (_) { return fallback }
}

function escapeCmd(p) { return p.replace(/\//g, '\\') }
function makeBinLinks(name, pkgDir) {
  const pj = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pj)) return
  let bin
  try { bin = JSON.parse(fs.readFileSync(pj, 'utf8')).bin } catch (_) { return }
  if (!bin) return
  const entries = typeof bin === 'string' ? { [name.startsWith('@') ? name.split('/')[1] : name]: bin } : bin
  const binDir = path.join(NM, '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  for (const [cmd, rel] of Object.entries(entries)) {
    const relTarget = escapeCmd(`${name}/${rel}`)
    const cmdFile = path.join(binDir, `${cmd}.cmd`)
    fs.writeFileSync(cmdFile, `@echo off\r\nnode "%~dp0..\\${relTarget}" %*\r\n`)
    const shFile = path.join(binDir, cmd)
    fs.writeFileSync(shFile, `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec node "$basedir/../${name}/${rel}" "$@"\n`, { mode: 0o755 })
  }
}

async function installOne(name, range) {
  if (done.has(name)) return
  const release = await slot()
  try {
    if (done.has(name)) return
    done.set(name, 'pending')
    const pack = await getJSON(registryUrl(name))
    const version = pickVersion(pack, range)
    if (!version) throw new Error(`无法解析版本 ${name}@${range}`)
    const manifest = pack.versions[version]
    const url = tarballUrl(name, version, manifest)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败 ${url} HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const tgz = path.join(TMP, `${name.replace(/[/@]/g, '_')}-${version}.tgz`)
    fs.writeFileSync(tgz, buf)
    const extractDir = path.join(TMP, `x_${name.replace(/[/@]/g, '_')}_${version}`)
    fs.mkdirSync(extractDir, { recursive: true })
    // Windows 下 GNU tar 会把 C:\ 路径当成远程主机，需 --force-local
    execFileSync('tar', ['--force-local', '-xzf', tgz, '-C', extractDir], { stdio: 'ignore' })
    const target = path.join(NM, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
    // 临时目录与项目可能跨盘符，rename 会 EXDEV，改为复制
    fs.cpSync(path.join(extractDir, 'package'), target, { recursive: true })
    done.set(name, version)
    makeBinLinks(name, target)
    console.log(`  ✓ ${name}@${version}`)

    const deps = { ...(manifest.dependencies || {}) }
    // 只安装适用于 win32 的 optional 依赖
    for (const [dep, r] of Object.entries(manifest.optionalDependencies || {})) {
      if (/darwin|linux|android|freebsd/i.test(dep) && !/win32/i.test(dep)) continue
      deps[dep] = r
    }
    for (const [dep, r] of Object.entries(deps)) {
      if (!done.has(dep)) queue.push({ name: dep, range: r })
    }
  } catch (e) {
    done.delete(name)
    failed.push(`${name}@${range}: ${e.message}`)
    console.log(`  ✗ ${name}@${range} — ${e.message}`)
  } finally { release() }
}

;(async () => {
  fs.mkdirSync(NM, { recursive: true })
  const t0 = Date.now()
  const waves = []
  while (queue.length) {
    const batch = queue.splice(0, 12)
    waves.push(...batch.map((b) => installOne(b.name, b.range)))
    await Promise.all(waves.splice(0, waves.length))
  }
  console.log(`\n完成：${done.size} 个包，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (failed.length) { console.log('失败：\n' + failed.join('\n')); process.exitCode = 1 }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
})()
