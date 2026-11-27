# 04：CONTRACT-AMS 激活码加固落地记录

> 日期：2026-11-27  
> 依据：IT-AMS 同批加固（`docs/export/01~03`）平移  
> 范围：**P0 + P1**（与 IT-AMS 对齐）  
> 原则：**增量叠加，不覆盖**——CONTRACT 独有的 7 天试用（trial.json）与 getLocalStatus() 原样保留

---

## 已落地改动

| 编号 | 项 | 文件 | 说明 |
|------|----|------|------|
| P0① | 弱网宽限期 | `packages/api-server/license.js` | `license.json` 增 `lastOnlineOkAt`（仅远程成功刷新）；断网超过 `CONTRACTAMS_LICENSE_MAX_OFFLINE_DAYS`（默认 7 天）锁定；宽限期内提示剩余天数 |
| P0③ | 正式包禁 skip | `scripts/lib/license-guard.js` + `package-desktop.js` / `package-mac.js` / `package-win-portable.js` | 打包时若 `CONTRACTAMS_SKIP_LICENSE=1` 构建失败（win7 脚本复用 win-portable，一并覆盖）；未注入 Token 给警告 |
| P0④ | Token 环境变量化 | `license.js` | 环境变量 `CONTRACTAMS_LICENSE_API_TOKEN` / `_BASE` 优先，保留固定兜底值（与 IT 同，服务器确认固定） |
| P1⑤ | machine_id 加固 | `license.js` | `sha256(安装UUID + 主机名/平台/MAC/CPU/内存)`；安装UUID落盘保稳定；与 license.json 的 machineId 不符判定换机锁定 |
| P1⑦ | 业务 API 门禁 | `packages/api-server/http.js` | LAN/H5 业务接口统一授权校验，未授权 403 `LICENSE_REQUIRED`；缓存 10 分钟；health/license/auth/service 放行 |
| 前端 | 提示 | `src/App.vue` | 临时离线 / 机器码不符 / 超宽限分别提示；试用到期提醒保留 |

---

## 与 IT-AMS 的关键差异（务必注意）

1. **7 天免费试用（trial.json）原样保留**：试用期按 `startedAt` 计时，不依赖 machineId 校验；加固后 machine_id 变成哈希不影响试用。删除 trial.json 仍会重新开始试用。
2. **getLocalStatus() 保留**：CONTRACT 独有同步本地判定函数，未删除；但实际 HTTP/H5 的 `/api/license/status` 走的是 http.js 的 `getStatus()`（会联网），core.js 里的 getLocalStatus 分支仅桌面 IPC 可达。
3. **core.js 未改**：CONTRACT 是合同域（登录/会话/角色体系），与 IT 资产域不通用；http.js 门禁已覆盖局域网业务请求，无需改 core.js。
4. **环境变量前缀是 `CONTRACTAMS_`**（不是 ITAMS_），端口 8788、请求头 `X-CONTRACTAMS-*`，均未改动。
5. **三条打包链路都加了守卫**：desktop / mac / win-portable（win7 包装器复用 win-portable）。

---

## ⚠ 迁移注意

1. **现有已激活用户需重新激活**：machine_id 从明文 UUID 改为硬件指纹，旧 `license.json` 的 machineId 不匹配会被判定换机锁定。需提前告知并准备激活码。
2. **试用用户不受影响**：试用按时间计时，但如果试用已到期且未激活，会被门禁锁定——这是预期行为。
3. **局域网/H5 客户端**：授权失效后业务 API 全部 403，H5 能进页面（口令校验在前）但读不到业务数据。

---

## 验收（已自测）

- [x] 试用期 7 天内 `getStatus()` 放行（CONTRACT 独有）
- [x] machineId 为 32 位 hash、重启稳定
- [x] 激活成功，license.json 含 planType / expiresAt / lastOnlineOkAt
- [x] 断网未超宽限 → 临时放行 + 剩余天数提示
- [x] 断网超宽限 → 锁定；换机（指纹不符）→ 锁定
- [x] 业务 API 门禁：试用过期后 403 `LICENSE_REQUIRED`；health/license/status 放行；试用期内放行
- [x] 正式包 `CONTRACTAMS_SKIP_LICENSE=1` → 构建失败
- [x] `npm run test:license` 14/14；`npm run build` 通过；干净数据目录全量 API 冒烟通过（含试用门禁项）

---

## 未做（后续）

- P1⑥ Token 中转服务（需自有云服务器）
- P2⑧ 关键能力在线票据
