'use strict'
/** 纯 Node 生成应用图标（PNG-in-ICO，多尺寸），避免引入图像库 */
const zlib = require('zlib')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

// 5×7 点阵 "IT"
const GLYPHS = [
  ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
]
function draw(size) {
  const buf = Buffer.alloc(size * size * 4)
  const pad = Math.round(size * 0.08)
  const radius = Math.round(size * 0.2)
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角深色面板 + 青色高亮渐变
      const cx = Math.min(Math.max(x, radius), size - 1 - radius)
      const cy = Math.min(Math.max(y, radius), size - 1 - radius)
      const dist = Math.hypot(x - cx, y - cy)
      if (x < pad || y < pad || x >= size - pad || y >= size - pad || dist > radius) { set(x, y, 0, 0, 0, 0); continue }
      const t = y / size
      set(x, y, Math.round(6 + 10 * t), Math.round(26 + 40 * t), Math.round(51 + 70 * t), 255)
    }
  }
  // 边框
  const bw = Math.max(1, Math.round(size / 32))
  for (let i = 0; i < bw; i++) {
    for (let x = 0; x < size; x++) {
      for (const y of [pad + i, size - 1 - pad - i]) {
        if (x > pad + radius || x < size - pad - radius) set(x, y, 63, 211, 255, 235)
      }
    }
    for (let y = 0; y < size; y++) {
      for (const x of [pad + i, size - 1 - pad - i]) {
        if (y > pad + radius || y < size - pad - radius) set(x, y, 63, 211, 255, 235)
      }
    }
  }
  // 文字
  const scale = Math.max(1, Math.floor(size / 20))
  const cw = 5 * scale, gap = 2 * scale, totalW = cw * 2 + gap
  const totalH = 7 * scale
  const ox = Math.floor((size - totalW) / 2), oy = Math.floor((size - totalH) / 2)
  GLYPHS.forEach((glyph, gi) => {
    glyph.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (row[rx] !== '1') continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = ox + gi * (cw + gap) + rx * scale + dx
            const y = oy + ry * scale + dy
            set(x, y, 234, 247, 255, 255)
          }
        }
      }
    })
  })
  return buf
}

/** 返回 ICO 文件 Buffer（32 / 48 / 256 三帧） */
function makeIco(sizes = [32, 48, 256]) {
  const images = sizes.map((s) => ({ s, data: png(s, draw(s)) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const img of images) {
    const e = Buffer.alloc(16)
    e[0] = img.s >= 256 ? 0 : img.s
    e[1] = img.s >= 256 ? 0 : img.s
    e[2] = 0; e[3] = 0
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(img.data.length, 8); e.writeUInt32LE(offset, 12)
    offset += img.data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

/** macOS .icns：把同一套 PNG 图案按 ICNS 支持的尺寸嵌入 */
function makeIcns() {
  const types = [
    ['ic12', 32],   // 16pt @2x
    ['ic11', 64],   // 32pt @2x
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
  ]
  const parts = types.map(([type, size]) => {
    const data = png(size, draw(size))
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

module.exports = { makeIco, makeIcns, png, draw }
