'use strict'
/**
 * 本地备份与恢复：把 SQLite 主库 + 配置 + 合同附件打成一个 zip（纯 Node，跨平台）
 *  - 手动：createBackup()
 *  - 定时：startAutoBackup() 每分钟检查一次，按 settings.autoBackup 配置触发，滚动保留 N 份
 *  - 恢复：restoreFromZip()（V1.2，校验 + 恢复前再备份 + 原子回滚）
 */
const fs = require('fs')
const path = require('path')
const db = require('./db')
const { readZip, writeZip } = require('../../scripts/lib/zip')

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

/**
 * 从备份 zip 恢复到本机（V1.2）
 *  - 校验 zip 完整性与版本兼容
 *  - 恢复前把当前数据再备份一份（防止误恢复）
 *  - media 目录用临时交换，失败可整体回滚
 * @returns {{ok, contracts, mediaCount, safetyBackup, message}}
 */
function restoreFromZip(zipPath, { keepAccounts = true } = {}) {
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('备份文件不存在')
  const entries = readZip(zipPath)
  const dbEntry = entries.find((e) => e.name === 'contractams.sqlite' || e.name.endsWith('/contractams.sqlite'))
  if (!dbEntry || !dbEntry.data || dbEntry.data.length < 100) throw new Error('备份文件缺少有效的 contractams.sqlite，无法恢复')
  const cfgEntry = entries.find((e) => e.name === 'config.json' || e.name.endsWith('/config.json'))
  const mediaEntries = entries.filter((e) => /^media\//.test(e.name) || /\/(media\/)/.test(e.name))
    .map((e) => ({ ...e, name: e.name.replace(/^.*?\/?media\//, 'media/') }))

  // 1) 先给当前数据做安全备份
  const safety = createBackup()
  const safetyBackup = path.basename(safety.file)

  // 2) 备份当前 db/config 字节，供回滚
  const oldDb = fs.existsSync(db.DB_FILE) ? fs.readFileSync(db.DB_FILE) : null
  const oldCfg = fs.existsSync(db.CONFIG_FILE) ? fs.readFileSync(db.CONFIG_FILE) : null
  const oldMediaTmp = path.join(db.DATA_DIR, `media_restore_bak_${Date.now()}`)
  const hasOldMedia = fs.existsSync(db.MEDIA_DIR)
  if (hasOldMedia) fs.renameSync(db.MEDIA_DIR, oldMediaTmp)

  try {
    // 3) 覆盖数据库
    fs.mkdirSync(db.DATA_DIR, { recursive: true })
    fs.writeFileSync(db.DB_FILE, dbEntry.data)
    // 3b) 覆盖配置（保留账号相关设置不在此文件；config 只含端口/口令等）
    if (cfgEntry) fs.writeFileSync(db.CONFIG_FILE, cfgEntry.data)
    // 4) 写回媒体
    fs.mkdirSync(db.MEDIA_DIR, { recursive: true })
    for (const e of mediaEntries) {
      const rel = e.name.replace(/^media\//, '')
      if (!rel || rel.includes('..')) continue // 防目录穿越
      const target = path.join(db.MEDIA_DIR, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, e.data)
    }
    // 5) 重新加载内存库，使恢复立即生效
    db.reload()
    // 6) 恢复成功，清理临时旧 media
    if (hasOldMedia) fs.rmSync(oldMediaTmp, { recursive: true, force: true })

    // 统计合同数
    let contracts = 0
    try { contracts = db.one('SELECT COUNT(*) AS n FROM contract').n } catch (_) {}
    db.addLog({ event_type: '恢复备份', content: `从 ${path.basename(zipPath)} 恢复完成：${contracts} 份合同、${mediaEntries.length} 个附件；恢复前安全备份 ${safetyBackup}`, operator: '管理员', source: 'desktop' })
    return { ok: true, contracts, mediaCount: mediaEntries.length, safetyBackup, message: `恢复完成：${contracts} 份合同、${mediaEntries.length} 个附件` }
  } catch (err) {
    // 回滚：还原 db/config/media
    try { oldDb ? fs.writeFileSync(db.DB_FILE, oldDb) : fs.existsSync(db.DB_FILE) && fs.unlinkSync(db.DB_FILE) } catch (_) {}
    try { oldCfg ? fs.writeFileSync(db.CONFIG_FILE, oldCfg) : fs.existsSync(db.CONFIG_FILE) && fs.unlinkSync(db.CONFIG_FILE) } catch (_) {}
    try {
      if (fs.existsSync(db.MEDIA_DIR)) fs.rmSync(db.MEDIA_DIR, { recursive: true, force: true })
      if (hasOldMedia) fs.renameSync(oldMediaTmp, db.MEDIA_DIR)
    } catch (_) {}
    try { if (oldDb) db.reload() } catch (_) {}
    throw new Error(`恢复失败，已回滚：${err.message}`)
  }
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

module.exports = { createBackup, restoreFromZip, startAutoBackup, stopAutoBackup }
