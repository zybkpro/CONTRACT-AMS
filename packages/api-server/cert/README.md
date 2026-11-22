# 局域网自签证书（V1.3 · H5 摄像头扫码）

`server.key` / `server.crt` 是随项目分发的**自签**证书，仅用于让局域网内的 H5 页面落在浏览器的
「安全上下文」里，从而允许调用 `getUserMedia` 打开摄像头扫描资产二维码。

- 有效期 10 年，CN = `IT-AMS LAN`，SAN 含 `localhost` / `itams.local` / `127.0.0.1`。
- **不用于公网、不承担身份认证**；局域网访问仍由 `X-ITAMS-Token` 口令鉴权。
- 自签证书必然触发浏览器警告，手机首次访问需点「高级 → 继续访问」。部分内置浏览器
  （如微信）可能直接拦截，此时请用 H5 盘点页的「手动输入资产编号」兜底。
- 这两个文件会被 `scripts/package-desktop.js` 与 `scripts/lib/mac-bundle.js` 打进安装包，
  **请勿删除或改名**。如需替换，用 openssl 重新生成同名文件即可：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout packages/api-server/cert/server.key \
  -out   packages/api-server/cert/server.crt \
  -days 3650 -subj "/C=CN/O=IT-AMS/CN=IT-AMS LAN" \
  -addext "subjectAltName=DNS:localhost,DNS:itams.local,IP:127.0.0.1"
```

开启方式：桌面端「系统设置 → 局域网服务 → 勾选 HTTPS（扫码）→ 保存配置」；
独立服务模式用 `node server/index.js --https`。
