'use strict'
/** 无 Electron 的核心 API 冒烟测试：直接驱动 db.init + core.dispatch */
const assert = require('assert')
const path = require('path')
process.env.CONTRACTAMS_DATA_DIR = path.join(__dirname, '..', 'data-test')
const db = require(path.join(__dirname, '..', 'packages', 'api-server', 'db'))
const { dispatch } = require(path.join(__dirname, '..', 'packages', 'api-server', 'core'))

let SESSION = ''
function call(method, p, body = {}, query = {}) {
  return dispatch(method, p, new URLSearchParams(query), body, { source: 'ipc', trusted: true, token: SESSION }).data
}

;(async () => {
  await db.init()
  const q = (k, v) => ({ [k]: v })

  // 0. 登录（默认账号 admin / 123456）
  const badLogin = (() => { try { return call('POST', '/api/login', { username: 'admin', password: 'wrong' }) } catch (e) { return e.message } })()
  assert.strictEqual(badLogin, '密码不正确')
  const login = call('POST', '/api/login', { username: 'admin', password: '123456' })
  assert.ok(login.token && login.user.role === 'admin' && login.user.is_super)
  SESSION = login.token
  console.log('✓ 登录：admin 账号密码校验，签发会话')
  try { dispatch('GET', '/api/bootstrap', new URLSearchParams(), {}, { source: 'ipc', trusted: true }); assert.fail('未登录应抛错') }
  catch (e) { assert.strictEqual(e.message, '请先登录') }
  console.log('✓ 未登录访问业务接口被拒绝')

  // 1. 健康 & bootstrap
  const health = call('GET', '/api/health')
  assert.strictEqual(health.service, 'CONTRACT-AMS')
  const boot = call('GET', '/api/bootstrap')
  assert.ok(boot.contracts.length >= 5, '种子合同应 >= 5')
  assert.ok(boot.projects.length >= 2)
  console.log('✓ bootstrap 加载', boot.contracts.length, '份合同 /', boot.projects.length, '个项目')

  // 2. 看板
  const dash = call('GET', '/api/dashboard')
  assert.ok(dash.total >= 5 && dash.finance.planIn > 0)
  console.log('✓ 看板统计：在签 ¥' + dash.totalAmount, '未收 ¥' + dash.finance.remainIn, '逾期', dash.overdueCount)

  // 3. 新建相对方 + 项目 + 合同
  const party = call('POST', '/api/parties', { name: '测试客户' + Date.now(), role: '客户', rating: 'A' })
  const project = call('POST', '/api/projects', { name: '测试项目' + Date.now(), owner: '张伟', status: '进行中' })
  const code = call('GET', '/api/next-code', {}, { direction: '对外' }).code
  const contract = call('POST', '/api/contracts', {
    contract_no: code, title: '冒烟测试合同', direction: '对外', type: '销售', status: '草稿',
    party_id: party.id, project_id: project.id, amount: 150000, sign_date: '2026-01-01', end_date: '2026-12-31', owner: '张伟',
  })
  assert.strictEqual(contract.contract_no, code)
  console.log('✓ 创建合同', contract.contract_no, '编号自动规则正常')

  // 4. 唯一性校验
  assert.throws(() => call('POST', '/api/contracts', { contract_no: code, title: '重复', direction: '对外', type: '销售', party_id: party.id }), /已存在/)
  console.log('✓ 合同编号唯一性校验')

  // 5. 状态流转（需先上传文件才能已签署）
  assert.throws(() => call('POST', `/api/contracts/${contract.id}/status`, { status: '已签署' }), /正文文件/)
  const dataUrl = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64')
  call('POST', `/api/contracts/${contract.id}/files`, { fileName: '正文.pdf', dataUrl, isMain: true, version: 0, changeNote: '首版' })
  const signed = call('POST', `/api/contracts/${contract.id}/status`, { status: '已签署' })
  assert.strictEqual(signed.status, '已签署')
  assert.strictEqual(signed.files.length, 1)
  console.log('✓ 文件上传 + 状态流转（已签署校验正文）')

  // 6. 审批：提交 → 驳回（意见必填）→ 通过
  call('POST', `/api/contracts/${contract.id}/status`, { status: '审批中' })
  assert.throws(() => call('POST', `/api/contracts/${contract.id}/approve`, { action: 'reject', comment: '' }), /审批意见/)
  const approved = call('POST', `/api/contracts/${contract.id}/approve`, { action: 'approve', level: 1, comment: '同意' })
  assert.strictEqual(approved.status, '已签署')
  console.log('✓ 审批流（驳回必填意见 / 通过流转）')

  // 7. 履约节点 + 逾期判定
  call('POST', '/api/milestones', { contractId: contract.id, name: '验收', plan_date: '2026-06-01', done_date: '', status: '未开始' })
  const ms = boot ? db.one('SELECT * FROM milestone WHERE contract_id=?', [contract.id]) : null
  const updatedMs = call('PUT', `/api/milestones/${ms.id}`, { done_date: '2026-06-10', status: '已完成' })
  assert.strictEqual(updatedMs.status, '已完成（逾期）')
  console.log('✓ 履约节点逾期自动判定')

  // 8. 收付款计划 + 流水 + 汇总
  const plan = call('POST', '/api/payment-plans', { contractId: contract.id, direction: '应收', seq: '首付', plan_amount: 100000, plan_date: '2026-02-01' })
  call('POST', '/api/payment-records', { contractId: contract.id, plan_id: plan.id, amount: 60000, pay_date: '2026-02-01' })
  const once = call('GET', `/api/contracts/${contract.id}`)
  assert.strictEqual(once.summary.received, 60000)
  assert.strictEqual(once.summary.remainIn, 40000)
  assert.strictEqual(once.payment_plans[0].status, '部分')
  console.log('✓ 收付款计划/流水/差额与状态联动')

  // 9. 日志：查看 + 下载留痕，只追加
  call('GET', `/api/contracts/${contract.id}`)
  call('POST', '/api/files/view-log', { fileId: once.files[0].id, action: 'download' })
  const logs = call('GET', '/api/logs', {}, { contractId: contract.id }).list
  assert.ok(logs.some((l) => l.event_type === '查看'))
  assert.ok(logs.some((l) => l.event_type === '下载文件'))
  console.log('✓ 生命周期日志（查看/下载留痕）共', logs.length, '条')

  // 10. 归档 / 解档
  call('POST', `/api/contracts/${contract.id}/archive`, {})
  const archived = call('GET', `/api/contracts/${contract.id}`)
  assert.strictEqual(archived.archived, 1)
  assert.throws(() => call('PUT', `/api/contracts/${contract.id}`, { title: '改' }), /已归档/)
  call('POST', `/api/contracts/${contract.id}/unarchive`, {})
  console.log('✓ 归档只读 / 解档')

  // 11. 黑名单确认
  const bl = call('POST', '/api/parties', { name: '黑名单客户' + Date.now(), role: '客户', blacklist: true, confirmBlacklist: true })
  assert.strictEqual(bl.blacklist, 1)
  console.log('✓ 相对方黑名单显式确认')

  // 12. 导入
  const imp = call('POST', '/api/import', { rows: [{ contract_no: 'IM' + Date.now(), title: '导入合同', direction: '对外', type: '销售', party_name: bl.name, amount: 1000 }] })
  // party_name 自动关联：导入逻辑按名称查 party
  console.log('✓ 批量导入：成功', imp.created, '失败', imp.failed.length)

  // 13. 人员管理：默认四账号 / 新增 / 超级管理员禁删 / 角色固定
  const users = call('GET', '/api/users').list
  assert.strictEqual(users.length, 4)
  assert.ok(users.some((u) => u.username === 'admin' && u.is_super))
  assert.ok(users.every((u) => !('password_hash' in u)), '不应泄露密码散列')
  console.log('✓ 人员列表：4 个默认账号，密码散列不外泄')
  const superAdmin = users.find((u) => u.is_super)
  assert.throws(() => call('DELETE', `/api/users/${superAdmin.id}`), /超级管理员不可删除/)
  console.log('✓ 超级管理员不可删除')
  const newUser = call('POST', '/api/users', { username: 'biz2', name: '商务二', role: 'biz', password: '123456' })
  assert.strictEqual(newUser.role, 'biz')
  assert.throws(() => call('POST', '/api/users', { username: 'bad', name: 'x', role: 'super' }), /角色须为/)
  console.log('✓ 新增人员 / 角色固定四选一')
  // 普通账号登录：当前仅开放超管
  assert.throws(() => call('POST', '/api/login', { username: 'pm', password: '123456' }), /仅开放超级管理员/)
  console.log('✓ 仅超管可登录（其他角色暂未开放）')
  // 临时关闭限制，验证 pm 权限逻辑仍正确（数据范围/人员/收付款）
  call('PUT', '/api/settings', { onlyAdminLogin: false })
  const pmLogin = call('POST', '/api/login', { username: 'pm', password: '123456' })
  const savedSession = SESSION
  SESSION = pmLogin.token
  const pmBoot = call('GET', '/api/bootstrap')
  assert.ok(!pmBoot.contracts.some((c) => c.project_name === 'OA 系统升级'))
  assert.ok(pmBoot.contracts.length < boot.contracts.length)
  assert.throws(() => call('GET', '/api/users'), /仅管理员/)
  assert.throws(() => call('POST', '/api/payment-records', { contractId: contract.id, amount: 1, pay_date: '2026-01-01' }), /项目经理不可登记/)
  SESSION = savedSession
  call('PUT', '/api/settings', { onlyAdminLogin: true })
  console.log('✓ 项目经理权限逻辑：仅本人项目 / 不可看人员 / 不可登记收付款')

  // 17. 修改密码（当前会话）：校验原密码 / 新密码规则 / 改后可用新密码登录
  assert.throws(() => call('POST', '/api/change-password', { old_password: 'wrong', new_password: 'newpass' }), /原密码不正确/)
  assert.throws(() => call('POST', '/api/change-password', { old_password: '123456', new_password: '123' }), /至少 6 位/)
  call('POST', '/api/change-password', { old_password: '123456', new_password: 'admin888' })
  assert.ok(call('POST', '/api/login', { username: 'admin', password: 'admin888' }).token)
  console.log('✓ 修改密码：校验原密码/长度，改后新密码可登录')

  // ===== V1.1 增量 =====
  // 18. 数据迁移：新表新字段
  const cols = db.all('PRAGMA table_info(contract)').map((c) => c.name)
  assert.ok(['amount_ex_tax','tax_amount','tax_rate','category_id'].every((c) => cols.includes(c)))
  assert.ok(db.PAY_NATURES.includes('penalty'))
  console.log('✓ V1.1 迁移：税金/分类字段 + 发票表 + nature 枚举')

  // 19. 在签收入/支出分列
  const dashV11 = call('GET', '/api/dashboard')
  assert.ok(dashV11.inSignIncome >= 0 && dashV11.inSignExpense >= 0 && dashV11.inSignNet === dashV11.inSignIncome - dashV11.inSignExpense)
  const projDash = call('GET', '/api/dashboard', {}, { projectId: 'prj-1' })
  assert.ok(projDash.total <= dashV11.total)
  console.log('✓ 在签收入/支出分列 + 项目下钻过滤')

  // 20. 补充协议一键创建：编号 -n 递增
  const main = call('GET', '/api/contracts', {}, {}).list.find((c) => !c.parent_id)
  const mkSupp = () => call('POST', '/api/contracts', {
    contract_no: '', title: main.title + '-补充协议', direction: main.direction, type: main.type,
    status: '草稿', party_id: main.party_id, parent_id: main.id, amount: 10000, confirmBlacklist: true,
  })
  const supp1 = mkSupp(), supp2 = mkSupp()
  assert.ok(supp1.contract_no.endsWith('-1') && supp2.contract_no.endsWith('-2'))
  assert.strictEqual(call('GET', `/api/contracts/${main.id}`, {}, {}).children.length, 2)
  assert.throws(() => call('DELETE', `/api/contracts/${main.id}`), /存在补充协议/)
  console.log('✓ 补充协议：编号 -n 递增 / 主合同禁删')

  // 21. 发票登记：税额计算 / 作废旧计
  const inv = call('POST', '/api/invoices', { contractId: main.id, direction: '开票', invoice_type: '专票',
    invoice_no: 'V11-001', invoice_date: '2026-11-22', amount_ex_tax: 10000, amount_incl_tax: 11300, tax_rate: 13, status: '已开具' })
  assert.strictEqual(inv.tax_amount, 1300)
  assert.strictEqual(call('GET', `/api/contracts/${main.id}/invoices/summary`, {}, {}).issued, 11300)
  assert.throws(() => call('PUT', `/api/invoices/${inv.id}`, { status: '作废' }), /作废必须填写原因/)
  call('PUT', `/api/invoices/${inv.id}`, { status: '作废', voidReason: '测试作废' })
  assert.strictEqual(call('GET', `/api/contracts/${main.id}/invoices/summary`, {}, {}).issued, 0)
  console.log('✓ 发票：税额自动算 / 作废需原因 / 作废不计入合计')

  // 22. 期次模板 + 罚息性质不污染回款率
  const gen = call('POST', '/api/payment-plans/generate', { contractId: contract.id, template: 'down-tail', direction: '应收', total: 100000, confirm: 'overwrite' })
  assert.strictEqual(gen.generated, 2)
  const beforeRate = call('GET', '/api/dashboard', {}, {}).finance.receiveRate
  call('POST', '/api/payment-records', { contractId: contract.id, amount: 9999, pay_date: '2026-11-22', nature: 'penalty' })
  assert.strictEqual(call('GET', '/api/dashboard', {}, {}).finance.receiveRate, beforeRate)
  assert.ok(call('GET', '/api/dashboard', {}, {}).penalties >= 9999)
  console.log('✓ 期次模板生成 + 罚息不污染回款率')

  // 23. 文件解析（P0 附件修复）：存在性反馈
  const dataUrlV11 = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64')
  const up = call('POST', `/api/contracts/${contract.id}/files`, { fileName: 'V11.pdf', dataUrl: dataUrlV11, isMain: true })
  const file = Array.isArray(up) ? up[0] : up
  const info = call('POST', '/api/files/resolve', { fileId: file.id })
  assert.ok(info.exists && info.absPath && info.ext === '.pdf')
  require('fs').unlinkSync(info.absPath)
  assert.strictEqual(call('POST', '/api/files/resolve', { fileId: file.id }).exists, false)
  console.log('✓ 附件解析：存在/缺失明确反馈（P0 修复）')

  // 24. 清空数据：确认短语校验 / 仅清业务数据 / 账号与设置保留（放最后，因会清库）
  assert.throws(() => call('POST', '/api/data/clear', { confirm: 'wrong' }), /确认短语不正确/)
  // 先导出若干行，供清空后导入自恢复测试
  const exportRows = call('GET', '/api/contracts', {}, {}).list.filter((c) => c.party_name).slice(0, 3).map((c) => ({
    contract_no: c.contract_no, title: c.title, direction: c.direction, type: c.type, status: c.status,
    party_name: c.party_name, project_name: c.project_name, amount: c.amount,
  }))
  const cleared = call('POST', '/api/data/clear', { confirm: 'CLEAR' })
  assert.ok(cleared.counts.contract >= 0)
  assert.strictEqual(call('GET', '/api/bootstrap', {}, {}).contracts.length, 0)
  assert.ok(db.one('SELECT COUNT(*) AS n FROM app_user').n >= 4)
  assert.ok(Object.keys(db.getSettings()).length > 0)
  console.log('✓ 清空数据：短语校验 + 仅清业务数据 + 账号设置保留')

  // 25. 清空后导入：相对方/项目档案自动重建，导出→清空→导入可自恢复
  const imported = call('POST', '/api/import', { rows: exportRows })
  assert.strictEqual(imported.failed.length, 0)
  assert.strictEqual(imported.created, exportRows.length)
  assert.ok(imported.autoParties.length > 0)
  assert.ok(db.one('SELECT COUNT(*) AS n FROM contract').n === exportRows.length)
  // 严格模式：关闭自动建档案后，缺失相对方应报错
  call('POST', '/api/data/clear', { confirm: 'CLEAR' })
  const strict = call('POST', '/api/import', { rows: exportRows, autoCreateArchive: false })
  assert.strictEqual(strict.created, 0)
  assert.ok(strict.failed.length > 0)
  console.log('✓ 清空后导入自恢复：自动建相对方/项目，严格模式可关闭')

  console.log('\n✅ 全部冒烟测试通过')
})().catch((e) => { console.error('❌ 测试失败:', e.message); console.error(e.stack); process.exit(1) })
