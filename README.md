# 合同管理系统（CONTRACT-AMS）

面向中小企业的**本地化合同台账与履约管理**产品。覆盖对内/对外合同、项目关联、文件版本、收付款节点与到期提醒、权限审计与激活授权，是 IT-AMS 的姊妹产品（同技术栈、同工程骨架、同局域网主机模式）。

| 项 | 说明 |
|----|------|
| 产品代号 | CONTRACT-AMS |
| 需求文档 | `docs/合同管理系统-需求文档-V1.0.md`（内部版本 V1.0.2） |
| 激活码接入 | `docs/激活码接入说明.md` |
| 灵感来源 | IT-AMS 试用反馈中用户对「合同管理系统」的明确诉求 |
| 技术栈 | Electron 33 + Vue 3.5 + Vite 6 + sql.js + ECharts + xlsx（与 IT-AMS 同源） |
| 架构 | 桌面 IPC / 局域网 HTTP / H5 三端共用 `core.dispatch` 与同一份 SQLite |

## 快速开始

```bash
npm install                 # 首次安装依赖
npm run dev                 # 开发预览（Vite，localhost:5176）
npm run server              # 独立主机服务（局域网 :8788，供 H5 访问）
npm run electron            # 开发模式桌面端（需先 npm run dev）
npm run build               # 构建桌面与 H5 产物到 dist/
npm run desktop             # 构建并启动桌面端
npm run package             # 打包 Windows 安装包（需在 Windows 上：NSIS 生成 .exe）
npm run package:win         # 跨平台打包 Windows 绿色版 ZIP（macOS/Linux 也可）
npm run package:mac         # 打包 macOS x64 + arm64 ZIP（跨平台）
npm run test:api            # 核心 API 冒烟测试
```

产物在 `release/`：Windows 绿色版 ZIP、macOS x64/arm64 ZIP；Mac 包附带 `mac-first-run.sh`（首次解除隔离）与 `make-dmg.sh`（生成 .dmg）。

> 激活码门禁已临时去掉，无需跳过变量。

## 登录与账号

启动后进入 **账号登录**（激活码门禁已临时去掉），权限由登录账号决定（无视角下拉）。**当前仅开放超级管理员登录**，其他角色暂未开放（设置项 `onlyAdminLogin=true`，可关闭恢复多角色）。

| 账号 | 姓名 | 角色 | 状态 |
|------|------|------|------|
| admin | 超级管理员 | 管理员 | 可登录；**内置不可删除/降级/停用** |
| biz | 商务专员 | 商务 | 暂未开放 |
| pm | 项目经理 | 项目经理 | 暂未开放（负责人张伟） |
| finance | 财务专员 | 财务 | 暂未开放 |

- 初始密码 `123456`；登录后可在 **设置 → 修改密码** 自行修改（校验原密码，至少 6 位）。
- 「人员」管理视图与「局域网服务」设置项当前已隐藏（代码保留，关闭 `onlyAdminLogin` 可恢复人员视图）。

## 工程结构

```
apps/desktop/          Electron 主进程 + preload（IPC 通道）
packages/api-server/
  db.js                sql.js 数据层，contractams.sqlite + 合同域建表
  core.js              协议无关业务内核（dispatch），合同/项目/相对方/收付款/审批/日志
  http.js              局域网 HTTP 服务（LanServer），托管桌面页与 H5
  license.js           激活码（CAPTCHA_SYS，CONTRACTAMS_* 环境变量）
server/                独立主机入口 + 演示数据 seed.json
src/                   桌面 Vue 前端（深色台账 UI）
h5/                    移动端查阅端（口令访问 + 收付款登记）
scripts/               开发/打包/测试脚本（复用 IT-AMS）
docs/                  需求文档与接入说明
```

## 与 IT-AMS 的关系

- **原样复用**：sql.js 数据层骨架、dispatch 模式、LanServer、license.js、Electron 壳、打包脚本、三套深色 CSS、通用组件（激活/服务/确认/Toast）。
- **业务替换**：合同域数据模型（项目/相对方/合同/文件版本/履约/收付款/审批/日志）替代资产域模型（分类/盘点/二维码）。
- **命名错开**：环境变量前缀 `CONTRACTAMS_*`，数据库 `contractams.sqlite`，局域网端口 8788（IT-AMS 为 8787）。
