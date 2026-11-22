'use strict'
/** macOS .app 内容准备：Info.plist 改写、应用文件收集、随包脚本 */
const fs = require('fs')
const path = require('path')
const { makeIcns } = require('./make-ico')

const PREFIX = 'Electron.app/'
const RES = `${PREFIX}Contents/Resources/`

function setPlistValue(s, key, xmlValue) {
  const re = new RegExp(`(<key>${key}</key>\\s*)(<string>[^<]*</string>|<true/>|<false/>|<integer>[^<]*</integer>|<dict>[\\s\\S]*?</dict>)`)
  if (re.test(s)) return s.replace(re, `$1${xmlValue}`)
  const at = s.lastIndexOf('</dict>')
  return s.slice(0, at) + `  <key>${key}</key>\n  ${xmlValue}\n  ` + s.slice(at)
}

/** 基于 Electron 官方 plist 修改，保留其全部必需键 */
function infoPlist(original, version) {
  let s = (original || '').toString('utf8')
  if (!s.includes('<plist')) throw new Error('官方 Info.plist 格式异常')
  const str = (v) => `<string>${v}</string>`
  s = setPlistValue(s, 'CFBundleName', str('合同管理系统'))
  s = setPlistValue(s, 'CFBundleDisplayName', str('合同管理系统'))
  s = setPlistValue(s, 'CFBundleIdentifier', str('cn.contractams.desktop'))
  s = setPlistValue(s, 'CFBundleVersion', str(version))
  s = setPlistValue(s, 'CFBundleShortVersionString', str(version))
  s = setPlistValue(s, 'CFBundleIconFile', str('app.icns'))
  s = setPlistValue(s, 'CFBundleDevelopmentRegion', str('zh_CN'))
  s = setPlistValue(s, 'LSMinimumSystemVersion', str('10.13.0'))
  s = setPlistValue(s, 'NSHighResolutionCapable', '<true/>')
  // 桌面内嵌局域网服务与 H5 均为 http，需放行本地网络
  s = setPlistValue(s, 'NSAppTransportSecurity',
    '<dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>')
  return Buffer.from(s, 'utf8')
}

function collectAppFiles(root, version) {
  const out = []
  const add = (rel, data, mode = 0o100644) => out.push({ name: RES + 'app/' + rel, data, mode })
  add('package.json', Buffer.from(JSON.stringify({
    name: 'contract-ams', productName: '合同管理系统', version,
    main: 'apps/desktop/main.js', dependencies: { 'sql.js': '^1.13.0' },
  }, null, 2)))

  for (const f of [
    'apps/desktop/main.js', 'apps/desktop/preload.js',
    'packages/api-server/db.js', 'packages/api-server/core.js', 'packages/api-server/http.js',
    // V1.3.1 激活码功能：http.js 依赖 ./license，必须一并打包否则服务启动崩溃
    'packages/api-server/license.js',
    // V1.3 可选 HTTPS 自签证书：H5 摄像头扫码需要安全上下文
    'packages/api-server/cert/server.key', 'packages/api-server/cert/server.crt',
    'server/seed.json',
  ]) add(f, fs.readFileSync(path.join(root, f)))

  const walk = (abs, rel) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, item.name), r = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(p, r)
      else if (item.isFile()) add(`dist/${r}`, fs.readFileSync(p))
    }
  }
  walk(path.join(root, 'dist'), '')

  const sql = path.join(root, 'node_modules', 'sql.js')
  add('node_modules/sql.js/package.json', fs.readFileSync(path.join(sql, 'package.json')))
  for (const f of ['sql-wasm.js', 'sql-wasm.wasm'])
    add(`node_modules/sql.js/dist/${f}`, fs.readFileSync(path.join(sql, 'dist', f)))
  return out
}

/** 随包交付的 macOS 端辅助脚本（.dmg 生成 / 首次运行解除隔离） */
function helperScripts(version, appName) {
  return [
    {
      name: 'make-dmg.sh',
      mode: 0o100755,
      content: `#!/bin/bash
# 在 macOS 上执行：把 .app 打成带「应用程序」快捷方式的 DMG 安装包
set -euo pipefail
cd "$(dirname "$0")"
APP="${appName}"
OUT="合同管理系统-macOS-${version}.dmg"
if [ ! -d "$APP" ]; then echo "未找到 $APP，请先解压对应架构的 zip 并把 .app 放到本目录"; exit 1; fi
STAGE="$(mktemp -d)/stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "合同管理系统" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$(dirname "$STAGE")"
echo "✓ 已生成 $OUT"
`,
    },
    {
      name: 'mac-first-run.sh',
      mode: 0o100755,
      content: `#!/bin/bash
# 未做 Apple 开发者签名的应用，首次运行前执行一次：移除隔离属性并补可执行位
set -e
cd "$(dirname "$0")"
APP="${appName}"
xattr -cr "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/Electron" 2>/dev/null || true
# 如需 ad-hoc 签名，可取消下一行注释（正式分发仍建议使用 Developer ID 签名 + 公证）
# codesign --force --deep --sign - "$APP"
echo "✓ 已处理，可直接双击打开 $APP"
`,
    },
  ]
}

module.exports = { PREFIX, RES, infoPlist, collectAppFiles, helperScripts, makeIcns }
