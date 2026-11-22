'use strict'
/**
 * 激活码授权（对接 CAPTCHA_SYS / 激活码管理系统）
 * - 本机持久化 machine_id + license.json
 * - 激活 / 启动校验走远程 POST /api/v1/activate|verify
 * - Token 仅存在于主机进程，不暴露给渲染页静态资源
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const db = require('./db')

/** 与激活码服务约定一致；可用环境变量覆盖 */
const DEFAULTS = {
  apiBase: 'https://www.zybkpro.top/captcha',
  // 须与激活码服务 .env 中 API_TOKEN 一致；部署后请用 CONTRACTAMS_LICENSE_API_TOKEN 覆盖
  apiToken: 'ZYBKPROTOPCAPTCHA2026',
  wechatQrUrl: 'https://zhouqm.oss-cn-beijing.aliyuncs.com/zybkpro/w4.png',
  timeoutMs: 12000,
}

function cfg() {
  return {
    apiBase: String(process.env.CONTRACTAMS_LICENSE_API_BASE || DEFAULTS.apiBase).replace(/\/+$/, ''),
    apiToken: String(process.env.CONTRACTAMS_LICENSE_API_TOKEN || DEFAULTS.apiToken).trim(),
    wechatQrUrl: process.env.CONTRACTAMS_LICENSE_WECHAT_QR || DEFAULTS.wechatQrUrl,
    timeoutMs: Number(process.env.CONTRACTAMS_LICENSE_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    skip: process.env.CONTRACTAMS_SKIP_LICENSE === '1',
  }
}

function machineFile() { return path.join(db.DATA_DIR, 'machine_id') }
function licenseFile() { return path.join(db.DATA_DIR, 'license.json') }

function getMachineId() {
  fs.mkdirSync(db.DATA_DIR, { recursive: true })
  const f = machineFile()
  try {
    const id = fs.readFileSync(f, 'utf8').trim()
    if (id && id.length >= 8) return id
  } catch (_) {}
  const id = crypto.randomUUID()
  fs.writeFileSync(f, id, 'utf8')
  return id
}

function loadLicense() {
  try {
    const raw = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'))
    if (!raw || !raw.code) return null
    return raw
  } catch (_) { return null }
}

function saveLicense(data) {
  fs.mkdirSync(db.DATA_DIR, { recursive: true })
  const payload = {
    code: data.code,
    machineId: data.machineId || getMachineId(),
    planType: data.planType || null,
    planLabel: data.planLabel || null,
    activatedAt: data.activatedAt || null,
    expiresAt: data.expiresAt ?? null,
    verifiedAt: new Date().toISOString(),
  }
  fs.writeFileSync(licenseFile(), JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

function clearLicense() {
  try { fs.unlinkSync(licenseFile()) } catch (_) {}
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '')
}

function isCodeFormatOk(code) {
  return /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)
}

function localStillValid(lic) {
  if (!lic || !lic.code) return false
  if (lic.expiresAt == null || lic.expiresAt === '') return true // 终身
  const t = Date.parse(lic.expiresAt)
  if (!Number.isFinite(t)) return true
  return t > Date.now()
}

async function remoteCall(pathname, code, machineId) {
  const { apiBase, apiToken, timeoutMs } = cfg()
  if (!apiToken) throw new Error('未配置授权服务 Token（CONTRACTAMS_LICENSE_API_TOKEN）')
  const url = `${apiBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Token': apiToken,
      },
      body: JSON.stringify({ code, machine_id: machineId }),
      signal: ctrl.signal,
    })
    let json
    try { json = await res.json() }
    catch (_) { throw new Error(`授权服务返回异常（HTTP ${res.status}）`) }
    if (res.status === 401) throw new Error(json.message || '授权服务鉴权失败，请检查 API Token')
    // 5xx 时把服务端文案带回，避免只看到笼统「服务器内部错误」
    if (res.status >= 500) {
      return {
        success: false,
        message: json.message || `授权服务异常（HTTP ${res.status}）`,
      }
    }
    return json
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('连接授权服务超时，请检查网络后重试')
    if (err.message && /fetch|network|ENOTFOUND|ECONNREFUSED/i.test(err.message))
      throw new Error('无法连接授权服务，请检查网络后重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function publicMeta() {
  const c = cfg()
  return {
    wechatQrUrl: c.wechatQrUrl,
    apiBase: c.apiBase,
    skip: c.skip,
  }
}

/**
 * 启动/进入应用时的授权状态
 * @returns {{ activated: boolean, offline?: boolean, message: string, license: object|null, machineId: string, meta: object }}
 */
async function getStatus() {
  const machineId = getMachineId()
  const meta = publicMeta()
  if (cfg().skip) {
    return {
      activated: true, skipped: true, message: '已跳过授权校验（开发模式）',
      license: loadLicense(), machineId, meta,
    }
  }
  const lic = loadLicense()
  if (!lic) {
    return { activated: false, message: '尚未激活，请输入激活码', license: null, machineId, meta }
  }

  try {
    const result = await remoteCall('/api/v1/verify', lic.code, machineId)
    if (result.success) {
      const next = saveLicense({ ...lic, ...result.data, machineId })
      return { activated: true, message: result.message || '校验通过', license: next, machineId, meta }
    }
    // 远程明确失败（过期/作废/换机等）→ 锁定
    return {
      activated: false,
      message: result.message || '授权校验失败',
      license: lic,
      machineId,
      meta,
    }
  } catch (err) {
    // 弱网兜底：本地未过期可短暂放行
    if (localStillValid(lic)) {
      return {
        activated: true,
        offline: true,
        message: `网络异常，已按本地授权临时放行：${err.message}`,
        license: lic,
        machineId,
        meta,
      }
    }
    return {
      activated: false,
      offline: true,
      message: `授权已到期或无法联网校验：${err.message}`,
      license: lic,
      machineId,
      meta,
    }
  }
}

async function activate(rawCode) {
  const machineId = getMachineId()
  const meta = publicMeta()
  if (cfg().skip) {
    return { success: true, message: '开发模式无需激活', data: null, machineId, meta }
  }
  const code = normalizeCode(rawCode)
  if (!code) return { success: false, message: '请输入激活码', machineId, meta }
  if (!isCodeFormatOk(code)) {
    return { success: false, message: '激活码格式不正确（应为 XXXX-XXXX-XXXX-XXXX）', machineId, meta }
  }
  try {
    const result = await remoteCall('/api/v1/activate', code, machineId)
    if (result.success && result.data) {
      const lic = saveLicense({ ...result.data, machineId })
      return { success: true, message: result.message || '激活成功', data: lic, machineId, meta }
    }
    return { success: false, message: result.message || '激活失败', machineId, meta }
  } catch (err) {
    return { success: false, message: err.message || '激活失败', machineId, meta }
  }
}

async function verify() {
  return getStatus()
}

module.exports = {
  getMachineId,
  loadLicense,
  saveLicense,
  clearLicense,
  getStatus,
  activate,
  verify,
  publicMeta,
  normalizeCode,
}
