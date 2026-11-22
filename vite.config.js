import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'

const ROOT = __dirname
const CONFIG_FILE = resolve(ROOT, 'data/config.json')

/** 局域网服务端口：与 server/index.js 读同一份配置，默认 8788（与 IT-AMS 的 8787 错开） */
function lanPort() {
  try { return Number(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).port) || 8788 }
  catch (_) { return 8788 }
}
const PORT = lanPort()

function portOpen(port) {
  return new Promise((done) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); done(true) })
    s.once('error', () => done(false))
    s.setTimeout(800, () => { s.destroy(); done(false) })
  })
}

/** 开发环境专用：给「局域网服务」设置页一个仅本机的启动钩子 */
function devServiceLauncher() {
  return {
    name: 'contractams-dev-service-launcher',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        if (pathname !== '/__contractams/service/start') return next()
        const json = (code, payload) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        const addr = req.socket.remoteAddress || ''
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(addr)) {
          return json(403, { ok: false, error: '仅本机可启动局域网服务' })
        }
        if (req.method !== 'POST') return json(405, { ok: false, error: '需要 POST 请求' })

        ;(async () => {
          const port = lanPort()
          if (await portOpen(port)) return json(200, { ok: true, data: { alreadyRunning: true, port } })
          const child = spawn(process.execPath, [resolve(ROOT, 'server', 'index.js')], {
            cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
            env: { ...process.env },
          })
          child.on('error', (e) => json(500, { ok: false, error: `启动失败：${e.message}` }))
          child.unref()
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 250))
            if (await portOpen(port)) return json(200, { ok: true, data: { started: true, port } })
          }
          return json(500, { ok: false, error: '服务启动超时，请检查端口占用或在终端执行 npm run server' })
        })().catch((e) => json(500, { ok: false, error: e.message || '启动失败' }))
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), devServiceLauncher()],
  server: {
    host: '0.0.0.0',
    port: 5176,
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${PORT}`, changeOrigin: true },
      '/media': { target: `http://127.0.0.1:${PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: {
        main: resolve(ROOT, 'index.html'),
        h5: resolve(ROOT, 'h5/index.html'),
      },
    },
  },
})
