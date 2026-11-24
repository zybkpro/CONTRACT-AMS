'use strict'
/**
 * 桌面主进程内嵌的局域网 HTTP 服务（可一键启停）
 *  - 同时托管 桌面页(/) 与 H5 页(/h5/)
 *  - 本机回环免口令；局域网访问需 Token（请求头 / query / 首次输入口令）
 *  - 可配置 H5 只读，开启后远端写接口一律 403
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const db = require('./db')
const license = require('./license')
const { dispatch, ApiError, lanSession } = require('./core')

const DIST = path.join(db.ROOT, 'dist')
// V1.3：可选 HTTPS 自签证书。局域网 http:// 下浏览器禁止调用摄像头，
// 开启 HTTPS 后 H5 才能调起 getUserMedia 扫码（首次访问需在手机上信任此自签证书）。
const CERT_KEY = path.join(__dirname, 'cert', 'server.key')
const CERT_CRT = path.join(__dirname, 'cert', 'server.crt')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

function isLoopback(addr) {
  if (!addr) return false
  return /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1|localhost)$/i.test(addr)
}

class LanServer {
  constructor() {
    this.server = null
    this.error = ''
    this.startedAt = ''
  }

  config() { return db.getConfig() }

  certReady() { return fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT) }
  /** 当前实际使用的协议：配置开启 HTTPS 且证书齐备时才生效 */
  useHttps() { return !!this.config().https && this.certReady() }
  proto() { return this.useHttps() ? 'https' : 'http' }

  status() {
    const cfg = this.config()
    const ips = db.lanIPs().map((i) => i.address)
    const port = cfg.port
    const proto = this.proto()
    return {
      running: !!this.server,
      port, token: cfg.token, h5ReadOnly: !!cfg.h5ReadOnly,
      https: this.useHttps(), httpsConfigured: !!cfg.https, httpsAvailable: this.certReady(),
      lanIPs: db.lanIPs(),
      desktopUrl: `${proto}://127.0.0.1:${port}/`,
      h5Url: `${proto}://${ips[0] || '127.0.0.1'}:${port}/h5/`,
      urls: ips.map((ip) => `${proto}://${ip}:${port}/h5/`),
      startedAt: this.startedAt, error: this.error,
    }
  }

  /** 修改配置：端口变化时若服务在运行则自动重启 */
  async setConfig(patch = {}) {
    const before = this.config()
    const cfg = db.saveConfig(patch)
    const portChanged = Number(cfg.port) !== Number(before.port)
    const protoChanged = !!cfg.https !== !!before.https
    if (this.server && (portChanged || protoChanged)) { await this.stop(); await this.start() }
    return this.status()
  }

  async start() {
    if (this.server) return this.status()
    const cfg = this.config()
    const port = Number(cfg.port) || 8788
    const secure = this.useHttps()
    try {
      const handler = (req, res) => this.handle(req, res)
      this.server = secure
        ? https.createServer({ key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CRT) }, handler)
        : http.createServer(handler)
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(port, '0.0.0.0', () => { this.server.removeListener('error', reject); resolve() })
      })
      this.server.on('error', (e) => { this.error = e.message })
      this.error = ''
      this.startedAt = db.now()
      console.log(`[CONTRACT-AMS] 局域网服务已启动: ${secure ? 'https' : 'http'}://0.0.0.0:${port}  H5: /h5/  口令: ${cfg.token}`)
      return this.status()
    } catch (e) {
      this.server = null
      this.error = e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请更换端口` : (e.message || '启动失败')
      throw new ApiError(500, this.error)
    }
  }

  async stop() {
    if (!this.server) { this.error = ''; return this.status() }
    const s = this.server
    this.server = null
    await new Promise((resolve) => { try { s.close(() => resolve()) } catch (_) { resolve() } })
    this.startedAt = ''
    console.log('[CONTRACT-AMS] 局域网服务已停止')
    return this.status()
  }

  send(res, status, body, headers = {}) {
    const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-CONTRACTAMS-Token, X-CONTRACTAMS-Session, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...headers,
    })
    res.end(payload)
  }

  async readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > 32 * 1024 * 1024) { reject(new ApiError(413, '请求体过大（上限 32MB）')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (_) { reject(new ApiError(400, '请求体不是合法 JSON')) }
      })
      req.on('error', reject)
    })
  }

  tokenOf(req, url) {
    const h = req.headers['x-contractams-token'] || req.headers['authorization'] || ''
    return String(Array.isArray(h) ? h[0] : h).replace(/^Bearer\s+/i, '').trim() || url.searchParams.get('token') || ''
  }

  async handle(req, res) {
    if (req.method === 'OPTIONS') return this.send(res, 204, '')
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname
    const trusted = isLoopback(req.socket.remoteAddress)
    const cfg = this.config()

    try {
      // 口令校验接口（无需预先鉴权）
      if (p === '/api/auth' && req.method === 'POST') {
        const body = await this.readBody(req)
        if (String(body.token || '').trim().toUpperCase() !== String(cfg.token).toUpperCase()) {
          return this.send(res, 401, { ok: false, error: '访问口令不正确' })
        }
        // 口令即门禁：校验通过直接签发会话，H5 无需再输入账号密码
        const session = typeof lanSession === 'function' ? lanSession() : null
        return this.send(res, 200, { ok: true, data: { authenticated: true, session } })
      }
      if (p === '/api/service/status' && req.method === 'GET') {
        const s = this.status()
        if (!trusted) {
          // 远端只能拿运行状态，绝不外泄访问口令与内网拓扑
          if (this.tokenOf(req, url) !== cfg.token) {
            return this.send(res, 401, { ok: false, error: '需要局域网访问口令', code: 'UNAUTHORIZED' })
          }
          delete s.token
          delete s.lanIPs
          s.canControl = false
        } else {
          // 仅本机可显示「停止服务」按钮；远端浏览器不允许关停主机服务
          s.canControl = true
        }
        return this.send(res, 200, { ok: true, data: s })
      }
      // 独立服务模式（node server/index.js）下，本机的停止按钮走这里。
      // 严格限制为本机回环，远端即使带正确口令也不能关停服务。
      if (p === '/api/service/shutdown' && req.method === 'POST') {
        if (!trusted) return this.send(res, 403, { ok: false, error: '仅本机可停止局域网服务' })
        this.send(res, 200, { ok: true, data: { stopping: true } })
        setTimeout(() => { this.stop().catch(() => {}) }, 150)
        return
      }

      const needAuth = !trusted && (p.startsWith('/api/') || p.startsWith('/media/')) && p !== '/api/health'
      if (needAuth && this.tokenOf(req, url) !== cfg.token) {
        return this.send(res, 401, { ok: false, error: '需要局域网访问口令', code: 'UNAUTHORIZED' })
      }

      // 本地媒体文件：支持 Range（PDF 内嵌预览必需），文件不存在明确 404
      if (p.startsWith('/media/')) {
        const target = db.mediaFilePath(p)
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return this.send(res, 404, { ok: false, error: '文件不存在或已被移动' })
        }
        const stat = fs.statSync(target)
        const headers = {
          'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'Accept-Ranges': 'bytes',
        }
        if (url.searchParams.get('download') === '1') {
          headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`
        }
        // Range 请求 → 206 分段
        const range = req.headers.range
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (m) {
            let start = m[1] === '' ? 0 : parseInt(m[1], 10)
            let end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10)
            if (start >= stat.size || end < start) {
              headers['Content-Range'] = `bytes */${stat.size}`
              return this.send(res, 416, Buffer.alloc(0), headers)
            }
            end = Math.min(end, stat.size - 1)
            headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
            headers['Content-Length'] = end - start + 1
            res.writeHead(206, {
              'Content-Type': headers['Content-Type'],
              'Content-Range': headers['Content-Range'],
              'Content-Length': headers['Content-Length'],
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
              ...(headers['Content-Disposition'] ? { 'Content-Disposition': headers['Content-Disposition'] } : {}),
            })
            return fs.createReadStream(target, { start, end }).pipe(res)
          }
        }
        headers['Content-Length'] = stat.size
        res.writeHead(200, {
          'Content-Type': headers['Content-Type'],
          'Content-Length': headers['Content-Length'],
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          ...(headers['Content-Disposition'] ? { 'Content-Disposition': headers['Content-Disposition'] } : {}),
        })
        return fs.createReadStream(target).pipe(res)
      }

      // 授权激活（异步远程校验，仅本机 / 已鉴权客户端可操作）
      if (p === '/api/license/status' && req.method === 'GET') {
        return this.send(res, 200, { ok: true, data: await license.getStatus() })
      }
      if (p === '/api/license/activate' && req.method === 'POST') {
        if (!trusted) return this.send(res, 403, { ok: false, error: '仅主机本机可执行激活' })
        const body = await this.readBody(req)
        const result = await license.activate(body.code)
        return this.send(res, 200, { ok: true, data: result })
      }
      if (p === '/api/license/verify' && req.method === 'POST') {
        return this.send(res, 200, { ok: true, data: await license.verify() })
      }

      // 业务 API
      if (p.startsWith('/api/')) {
        const body = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) ? await this.readBody(req) : {}
        const result = dispatch(req.method, p, url.searchParams, body, {
          source: 'http', trusted, readOnly: !!cfg.h5ReadOnly,
          role: String(req.headers['x-contractams-role'] || url.searchParams.get('role') || ''),
          token: String(req.headers['x-contractams-session'] || url.searchParams.get('session') || ''),
        })
        if (p === '/api/backup') {
          return this.send(res, 200, JSON.stringify(result.data, null, 2), {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="contractams-backup-${Date.now()}.json"`,
          })
        }
        return this.send(res, result.status, { ok: true, data: result.data })
      }

      // 静态资源：/h5/ → H5 页，其余 → 桌面页
      let rel = decodeURIComponent(p)
      if (rel === '/h5' || rel === '/h5/') rel = '/h5/index.html'
      else if (rel === '/' || rel === '') rel = '/index.html'
      else if (rel.startsWith('/h5/assets/')) rel = rel.replace('/h5/assets/', '/assets/')
      const target = path.resolve(DIST, '.' + rel)
      if (target.startsWith(path.resolve(DIST) + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        return this.send(res, 200, fs.readFileSync(target), { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' })
      }
      const fallback = rel.startsWith('/h5/') ? path.join(DIST, 'h5', 'index.html') : path.join(DIST, 'index.html')
      if (fs.existsSync(fallback)) {
        return this.send(res, 200, fs.readFileSync(fallback), { 'Content-Type': MIME['.html'] })
      }
      return this.send(res, 200, `<!doctype html><meta charset="utf-8"><body style="background:#061526;color:#cfe6ff;font:16px sans-serif;padding:40px">
        <h2>合同管理系统</h2><p>前端尚未构建，请先执行 <code>npm run build</code>。</p>
        <p>API 已就绪：<a style="color:#3fd3ff" href="/api/health">/api/health</a></p></body>`, { 'Content-Type': MIME['.html'] })
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('[CONTRACT-AMS HTTP]', err)
      return this.send(res, err.status || 500, { ok: false, error: err.message || '服务内部错误' })
    }
  }
}

module.exports = { LanServer }
