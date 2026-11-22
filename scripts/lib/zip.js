'use strict'
/**
 * 轻量 ZIP 读写（保留 Unix mode 与符号链接）
 * 用途：在 Windows 上重组 Electron macOS .app，避免解压/重压时丢掉可执行位和 Framework 软链。
 * 不支持 ZIP64 / 加密（Electron 官方发行包用不到）。
 */
const fs = require('fs')
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
function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** @returns {{name:string, data:Buffer, mode:number}[]} */
function readZip(file) {
  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效 ZIP：未找到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`中央目录损坏 @${off}`)
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const size = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const mode = (buf.readUInt32LE(off + 38) >>> 16) & 0xffff
    const lhOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    off += 46 + nameLen + extraLen + commentLen
    if (compSize === 0xffffffff || size === 0xffffffff) throw new Error(`不支持 ZIP64 条目: ${name}`)
    const dataOff = lhOff + 30 + buf.readUInt16LE(lhOff + 26) + buf.readUInt16LE(lhOff + 28)
    const comp = buf.slice(dataOff, dataOff + compSize)
    let data
    if (method === 8) data = zlib.inflateRawSync(comp)
    else if (method === 0) data = comp
    else throw new Error(`不支持的压缩方式 ${method}: ${name}`)
    if (data.length !== size) throw new Error(`解压尺寸不符: ${name}`)
    entries.push({ name, data, mode: mode || 0o100644 })
  }
  return entries
}

/**
 * @param {string} file
 * @param {{name:string, data:Buffer|string, mode?:number}[]} entries
 */
function writeZip(file, entries) {
  const fd = fs.openSync(file, 'w')
  let offset = 0
  const { time, date } = dosDateTime()
  const w = (buf) => { fs.writeSync(fd, buf); offset += buf.length }
  const central = []
  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const mode = e.mode || 0o100644
      const isLink = (mode & 0o170000) === 0o120000
      const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8')
      const method = !isLink && data.length > 64 ? 8 : 0
      const comp = method === 8 ? zlib.deflateRawSync(data, { level: 6 }) : data
      const crc = crc32(data)
      const localOffset = offset

      const lfh = Buffer.alloc(30)
      lfh.writeUInt32LE(0x04034b50, 0)
      lfh.writeUInt16LE(20, 4)
      lfh.writeUInt16LE(0x0800, 6)      // UTF-8 文件名
      lfh.writeUInt16LE(method, 8)
      lfh.writeUInt16LE(time, 10); lfh.writeUInt16LE(date, 12)
      lfh.writeUInt32LE(crc, 14)
      lfh.writeUInt32LE(comp.length, 18)
      lfh.writeUInt32LE(data.length, 22)
      lfh.writeUInt16LE(nameBuf.length, 26)
      w(lfh); w(nameBuf); w(comp)

      const cdh = Buffer.alloc(46)
      cdh.writeUInt32LE(0x02014b50, 0)
      cdh.writeUInt16LE(0x031e, 4)      // version made by: Unix
      cdh.writeUInt16LE(20, 6)
      cdh.writeUInt16LE(0x0800, 8)
      cdh.writeUInt16LE(method, 10)
      cdh.writeUInt16LE(time, 12); cdh.writeUInt16LE(date, 14)
      cdh.writeUInt32LE(crc, 16)
      cdh.writeUInt32LE(comp.length, 20)
      cdh.writeUInt32LE(data.length, 24)
      cdh.writeUInt16LE(nameBuf.length, 28)
      cdh.writeUInt32LE(((mode << 16) >>> 0), 38)  // Unix 权限
      cdh.writeUInt32LE(localOffset, 42)
      central.push(Buffer.concat([cdh, nameBuf]))
    }
    const cdStart = offset
    for (const c of central) w(c)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(offset - cdStart, 12)
    eocd.writeUInt32LE(cdStart, 16)
    w(eocd)
  } finally { fs.closeSync(fd) }
  return offset
}

module.exports = { readZip, writeZip, crc32 }
