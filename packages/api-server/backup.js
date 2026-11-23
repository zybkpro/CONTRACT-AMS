'use strict'
/**
 * V1.1 本地备份：把 SQLite 主库 + 配置 + 合同附件打成一个 zip（纯 Node，跨平台）
 *  - 手动：createBackup()
 *  - 定时：startAutoBackup() 每分钟检查一次，按 settings.autoBackup 配置触发，滚动保留 N 份
 */
const fs = require('fs')
const path = require('path')
const db = require('./db')
const { writeZip } = require('../../scripts/lib/zip')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 生成一份备份 zip，返回 { file, size, files } */
function createBackup(targetDir = '') {
  const cfg = db.getSettings().autoBackup || {}
  const dir = targetDir || cfg.dir || path.join(db.DATA_DIR, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const entries = []
  // 主库
  if (fs.existsSync(db.DB_FILE)) entries.push({ name: 'contractams.sqlite', data: fs.readFileSync(db.DB_FILE), mode: 0o100644 })
  // 配置
  if (fs.existsSync(db.CONFIG_FILE)) entries.push({ name: 'config.json', data: fs.readFileSync(db.CONFIG_FILE), mode: 0o100644 })
  // 媒体文件
  let mediaCount = 0
  const walk = (abs, rel) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, item.name), r = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(p, r)
      else if (item.isFile()) { entries.push({ name: `media/${r}`, data: fs.readFileSync(p), mode: 0o100644 }); mediaCount++ }
    }
  }
  if (fs.existsSync(db.MEDIA_DIR)) walk(db.MEDIA_DIR, '')
  const file = path.join(dir, `合同管理系统_备份_${stamp()}.zip`)
  writeZip(file, entries)
  // 滚动保留
  const keep = Math.max(1, Number(cfg.keep) || 7)
  const backups = fs.readdirSync(dir).filter((f) => /^合同管理系统_备份_.*\.zip$/.test(f)).sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    try { fs.unlinkSync(path.join(dir, old)) } catch (_) {}
  }
  return { file, size: fs.statSync(file).size, files: entries.length, mediaCount }
}

let timer = null
let lastRun = ''
/** 启动定时备份（幂等）：每分钟检查一次是否到点 */
function startAutoBackup() {
  if (timer) return
  timer = setInterval(() => {
    try {
      const cfg = db.getSettings().autoBackup || {}
      if (!cfg.enabled) return
      const now = new Date()
      const time = String(cfg.time || '02:00')
      const cycle = cfg.cycle || 'daily'
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      if (hm !== time) return
      if (cycle === 'weekly' && now.getDay() !== 1) return // 每周一
      const day = now.toISOString().slice(0, 10)
      const key = `${day}_${hm}`
      if (lastRun === key) return
      lastRun = key
      const r = createBackup()
      db.addLog({ event_type: '自动备份', content: `自动备份完成：${path.basename(r.file)}（${(r.size / 1048576).toFixed(1)}MB，${r.mediaCount} 个附件）`, operator: '系统', source: 'desktop' })
    } catch (e) {
      try { db.addLog({ event_type: '备份失败', content: `自动备份失败：${e.message}`, operator: '系统', source: 'desktop' }) } catch (_) {}
    }
  }, 60 * 1000)
  if (timer.unref) timer.unref()
}
function stopAutoBackup() { if (timer) { clearInterval(timer); timer = null } }

module.exports = { createBackup, startAutoBackup, stopAutoBackup }
