# 对话导出 02：IT-AMS / CONTRACT-AMS 是否需要为激活码系统改动

> 来源：CAPTCHA_SYS 项目对话  
> 日期：2026-11-27  
> 涉及项目：  
> - `/Users/sun/Desktop/project/IT-AMS`  
> - `/Users/sun/Desktop/project/CONTRACT-AMS`

---

## 结论

**为「天卡 / 七天卡 / 月季年终身」套餐：业务代码基本不用大改。**  
两边已按 `planType` + `expiresAt` 通用对接，新套餐只是服务端多返回两种类型。

**真正要立刻核对的是：API Token 是否与 CAPTCHA 服务器一致。**

---

## 两边已具备的能力

| 能力 | IT-AMS | CONTRACT-AMS |
|------|--------|--------------|
| API 根地址 `https://www.zybkpro.top/captcha` | ✅ | ✅ |
| 桌面启动远程 `verify` | ✅ | ✅ |
| 本地存 `planType` / `planLabel` / `expiresAt` | ✅ | ✅ |
| 弱网按本地 `expiresAt` 判断 | ✅ | ✅ |
| 远程返回「已过期」则锁定 | ✅ | ✅ |
| 请求体 `code` + `machine_id` | ✅ | ✅ |

关键文件：

- `IT-AMS/packages/api-server/license.js`
- `CONTRACT-AMS/packages/api-server/license.js`

---

## 必须检查（建议立刻做）

### 1. API Token 对齐

两边默认值曾硬编码为类似：

```text
ZYBKPROTOPCAPTCHA2026
```

若服务器 `/opt/captcha_sys/.env` 中 `API_TOKEN` 已改成随机串，两边**必须同步**，否则激活/校验 401。

改法：

```bash
# 服务器查看
cd /opt/captcha_sys && docker compose exec app printenv API_TOKEN
```

写入产品侧（环境变量优先）：

| 项目 | 环境变量 |
|------|----------|
| IT-AMS | `ITAMS_LICENSE_API_TOKEN` |
| CONTRACT-AMS | `CONTRACTAMS_LICENSE_API_TOKEN` |

或改各自 `license.js` 的 `DEFAULTS.apiToken`（正式包更建议构建注入，不要长期明文写死）。

### 2. 发版冒烟清单

- [ ] 天卡 / 七天卡各激活一次 → `data/license.json` 有 `expiresAt`
- [ ] 重启应用 → `verify` 通过
- [ ] 过期码 → 锁定并提示「激活码已过期」
- [ ] 终身卡 → `expiresAt` 为空，长期可用
- [ ] 换机未解绑 → 失败「已绑定其他机器」

---

## 建议改、但非必须（体验）

| 项 | 说明 |
|----|------|
| 设置页展示套餐 | IT-AMS 设置里已有 `planLabel`/到期；CONTRACT-AMS 可对齐展示 |
| 激活页文案 | 补充：支持天卡、七天卡、月卡、季卡、年卡、终身 |
| 区分「试用」与「七天卡」 | CONTRACT-AMS 本地还有 7 天试用（`trial.json`），与付费七天卡不是一回事 |

---

## 不必为套餐去改的

- `activate` / `verify` 请求格式  
- `machine_id` 生成逻辑（加固见文档 03）  
- 门禁流程骨架  

CONTRACT-AMS 若正式售卖，确认激活码门禁已打开（README 曾写「临时去掉」）。

---

## CAPTCHA 侧套餐一览（产品对接用）

| planType | 名称 | 计时 |
|----------|------|------|
| `day` | 天卡 | 激活后 +1 天 |
| `week` | 七天卡 | 激活后 +7 天 |
| `month` | 月卡 | 激活后 +1 个月 |
| `quarter` | 季卡 | 激活后 +3 个月 |
| `year` | 年卡 | 激活后 +1 年 |
| `lifetime` | 终身 | `expiresAt = null` |

- 计时从**首次激活**开始  
- 解绑换机**不重置**到期时间  
- 产品每次启动应调用 `verify`

### 接口（生产）

```text
POST https://www.zybkpro.top/captcha/api/v1/activate
POST https://www.zybkpro.top/captcha/api/v1/verify

Header: X-API-Token: <服务器 API_TOKEN>
Body: { "code": "XXXX-...", "machine_id": "..." }
```

成功 `data` 含：`code`、`machineId`、`planType`、`planLabel`、`activatedAt`、`expiresAt`。
