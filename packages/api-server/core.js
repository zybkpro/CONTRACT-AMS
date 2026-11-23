'use strict'
/**
 * 协议无关的业务 API 内核。
 * 桌面渲染进程（Electron IPC）与局域网 HTTP/H5 调用同一份实现、同一份 SQLite。
 * 业务域：项目 / 相对方 / 合同台账 / 文件版本 / 履约节点 / 收付款 / 审批 / 日志 / 统计。
 */
const fs = require('fs')
const path = require('path')
const db = require('./db')

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH']
// H5 只读模式下放行的接口（查阅与登记类，按角色另在业务层约束）
const READONLY_ALLOWED = ['/api/auth', '/api/bootstrap', '/api/h5/register-payment']

const CONTRACT_FIELDS = ['contract_no', 'title', 'direction', 'type', 'status', 'project_id', 'party_id', 'parent_id',
  'our_entity', 'amount', 'currency', 'sign_date', 'start_date', 'end_date', 'auto_renew', 'terminate_note', 'owner', 'remark',
  'amount_ex_tax', 'tax_amount', 'tax_rate', 'category_id']
const FIELD_LABEL = {
  contract_no: '合同编号', title: '合同名称', direction: '方向', type: '类型', status: '状态',
  project_id: '项目', party_id: '相对方', parent_id: '主合同', our_entity: '我方主体', amount: '金额',
  currency: '币种', sign_date: '签订日', start_date: '开始日', end_date: '结束日',
  auto_renew: '自动续约', terminate_note: '终止条件', owner: '负责人', remark: '备注', archived: '归档',
  amount_ex_tax: '不含税金额', tax_amount: '税额', tax_rate: '税率', category_id: '费用分类',
}

/* ==================== 通用辅助 ==================== */
function findContract(id) {
  const c = db.one('SELECT * FROM contract WHERE id=?', [id])
  if (!c) throw new ApiError(404, '合同不存在')
  return c
}
function contractName(id) { const c = db.one('SELECT title, contract_no FROM contract WHERE id=?', [id]); return c ? `${c.contract_no} ${c.title}` : '' }
function projectName(id) { const p = db.one('SELECT name FROM project WHERE id=?', [id]); return p ? p.name : '' }
function partyName(id) { const p = db.one('SELECT name FROM party WHERE id=?', [id]); return p ? p.name : '' }

/** 合同视图：补全展示字段 + 收付款汇总 */
function contractView(c) {
  const plans = db.all('SELECT * FROM payment_plan WHERE contract_id=?', [c.id])
  const recs = db.all('SELECT * FROM payment_record WHERE contract_id=?', [c.id])
  const sumIn = plans.filter((p) => p.direction === '应收').reduce((s, p) => s + Number(p.plan_amount || 0), 0)
  const sumOut = plans.filter((p) => p.direction === '应付').reduce((s, p) => s + Number(p.plan_amount || 0), 0)
  const recIn = db.one(`SELECT COALESCE(SUM(r.amount),0) AS n FROM payment_record r
    LEFT JOIN payment_plan p ON p.id=r.plan_id WHERE r.contract_id=? AND (p.direction='应收' OR p.id IS NULL)`, [c.id]).n
  const recOut = db.one(`SELECT COALESCE(SUM(r.amount),0) AS n FROM payment_record r
    JOIN payment_plan p ON p.id=r.plan_id WHERE r.contract_id=? AND p.direction='应付'`, [c.id]).n
  const fileCount = db.one('SELECT COUNT(*) AS n FROM contract_file WHERE contract_id=?', [c.id]).n
  const msDone = db.one("SELECT COUNT(*) AS n FROM milestone WHERE contract_id=? AND status='已完成'", [c.id]).n
  const msTotal = db.one('SELECT COUNT(*) AS n FROM milestone WHERE contract_id=?', [c.id]).n
  return {
    ...c,
    project_name: projectName(c.project_id),
    party_name: partyName(c.party_id),
    parent_title: c.parent_id ? contractName(c.parent_id) : '',
    children: db.all('SELECT id, contract_no, title, status FROM contract WHERE parent_id=?', [c.id]),
    files: db.all('SELECT * FROM contract_file WHERE contract_id=? ORDER BY version DESC', [c.id]),
    milestones: db.all('SELECT * FROM milestone WHERE contract_id=? ORDER BY plan_date', [c.id]),
    payment_plans: plans,
    payment_records: recs,
    approvals: db.all('SELECT * FROM approval_log WHERE contract_id=? ORDER BY created_at DESC', [c.id]),
    summary: {
      planIn: sumIn, planOut: sumOut, received: recIn, paid: recOut,
      remainIn: Math.round((sumIn - recIn) * 100) / 100,
      remainOut: Math.round((sumOut - recOut) * 100) / 100,
      fileCount, msDone, msTotal,
    },
  }
}

function sanitizeContract(body, base = {}) {
  // 先给所有字段安全默认值，杜绝 undefined 传入 sql.js（bind 不接受 undefined）
  const c = {}
  for (const k of CONTRACT_FIELDS) {
    c[k] = k === 'amount' ? 0 : ''
  }
  Object.assign(c, base)
  for (const k of CONTRACT_FIELDS) {
    if (k in body) c[k] = body[k] == null ? '' : (typeof body[k] === 'number' ? body[k] : String(body[k]).trim())
  }
  c.amount = Number.isFinite(Number(c.amount)) ? Math.round(Number(c.amount) * 100) / 100 : 0
  for (const k of ['amount_ex_tax', 'tax_amount', 'tax_rate'])
    c[k] = Number.isFinite(Number(c[k])) ? Number(c[k]) : 0
  c.auto_renew = c.auto_renew === true || c.auto_renew === 1 || c.auto_renew === '1' || c.auto_renew === '是' ? 1 : 0
  c.currency = c.currency || 'CNY'
  c.status = c.status || '草稿'
  c.direction = c.direction || '对外'
  return c
}
function validateContract(c, exceptId) {
  if (!c.contract_no) return '合同编号不能为空'
  if (!c.title) return '合同名称不能为空'
  if (!['对内', '对外'].includes(c.direction)) return '方向须为 对内/对外'
  if (!c.type) return '合同类型不能为空'
  if (!c.party_id || !db.one('SELECT id FROM party WHERE id=?', [c.party_id])) return '请选择有效的相对方（需先在相对方档案创建）'
  if (c.project_id && !db.one('SELECT id FROM project WHERE id=?', [c.project_id])) return '关联项目不存在'
  if (c.parent_id) {
    if (c.parent_id === exceptId) return '合同不能关联自身为主合同'
    if (!db.one('SELECT id FROM contract WHERE id=?', [c.parent_id])) return '主合同不存在'
  }
  if (c.amount < 0) return '金额不能为负'
  if (c.start_date && c.end_date && c.end_date < c.start_date) return '结束日不得早于开始日'
  if (db.codeExists(c.contract_no, exceptId)) return `合同编号【${c.contract_no}】已存在`
  if (!db.STATUS.includes(c.status)) return `状态【${c.status}】不合法`
  return null
}

/** 字段差异 → 生命周期日志 */
function diffContractLogs(oldC, next, operator, source) {
  for (const k of CONTRACT_FIELDS) {
    const before = String(oldC[k] ?? ''), after = String(next[k] ?? '')
    if (before === after) continue
    db.addLog({ contract_id: next.id, contract_no: next.contract_no, event_type: k === 'status' ? '状态变更' : '信息变更',
      target: k, before_value: before, after_value: after,
      content: `${FIELD_LABEL[k] || k}：${before || '空'} → ${after || '空'}`, operator, source })
  }
}

/* ==================== 看板统计 ==================== */
function dashboard(list) {
  const totalAmount = list.reduce((s, c) => s + Number(c.amount || 0), 0)
  const byStatus = {}, byDirection = { 对内: 0, 对外: 0 }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const soon = [], overdue = []
  let inProgress = 0, archived = 0
  // V1.1：在签收入/支出分列（方向=对外/对内 且 状态∈已签署/履约中）
  const SIGNED = ['已签署', '履约中']
  let inSignIncome = 0, inSignExpense = 0
  const inSign = (c) => SIGNED.includes(c.status) && !c.archived
  for (const c of list) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1
    if (c.direction in byDirection) byDirection[c.direction]++
    if (c.status === '履约中') inProgress++
    if (c.archived) archived++
    if (inSign(c)) {
      if (c.direction === '对外') inSignIncome += Number(c.amount || 0)
      else if (c.direction === '对内') inSignExpense += Number(c.amount || 0)
    }
    if (c.end_date && !c.archived && !['已完成', '已终止'].includes(c.status)) {
      const t = new Date(c.end_date + 'T00:00:00').getTime()
      const days = Math.round((t - today.getTime()) / 86400000)
      if (days < 0) overdue.push({ id: c.id, contract_no: c.contract_no, title: c.title, days })
      else if (days <= 30) soon.push({ id: c.id, contract_no: c.contract_no, title: c.title, days })
    }
  }
  soon.sort((a, b) => a.days - b.days)
  overdue.sort((a, b) => a.days - b.days)
  // 收付款汇总：基于当前 list（支持按项目过滤），只统计合同款（nature='contract'）
  const ids = new Set(list.map((c) => c.id))
  const plans = db.all('SELECT * FROM payment_plan').filter((p) => ids.has(p.contract_id))
  const recs = db.all('SELECT * FROM payment_record').filter((r) => ids.has(r.contract_id))
  const planById = new Map(plans.map((p) => [p.id, p]))
  const num = (v) => Number(v || 0)
  const planIn = plans.filter((p) => p.direction === '应收' && p.nature === 'contract').reduce((s, p) => s + num(p.plan_amount), 0)
  const planOut = plans.filter((p) => p.direction === '应付' && p.nature === 'contract').reduce((s, p) => s + num(p.plan_amount), 0)
  // 实际到账：合同款且（关联应收计划 或 无计划）；应付：关联应付计划
  const received = recs.filter((r) => r.nature === 'contract' && (!r.plan_id || planById.get(r.plan_id)?.direction === '应收')).reduce((s, r) => s + num(r.amount), 0)
  const paid = recs.filter((r) => r.nature === 'contract' && planById.get(r.plan_id)?.direction === '应付').reduce((s, r) => s + num(r.amount), 0)
  // V1.1 可开关：罚息类合计（展示用，不进回款率）
  const penalties = recs.filter((r) => r.nature !== 'contract').reduce((s, r) => s + num(r.amount), 0)
  return {
    total: list.length, totalAmount, inProgress, archived, byStatus, byDirection,
    inSignIncome, inSignExpense, inSignNet: inSignIncome - inSignExpense,
    soon: soon.slice(0, 10), overdue: overdue.slice(0, 10),
    soonCount: soon.length, overdueCount: overdue.length,
    penalties,
    finance: { planIn, planOut, received, paid, remainIn: planIn - received, remainOut: planOut - paid,
      receiveRate: planIn ? Math.round(received / planIn * 100) : 0 },
  }
}

/* ==================== 用户 / 会话 ==================== */
function publicUser(u) {
  if (!u) return null
  const { password_hash, ...rest } = u
  return { ...rest, role_label: db.ROLE_LABEL[u.role] || u.role, is_super: !!u.is_super }
}
/** 从 token 解析当前用户；token 来自 ctx.token 或 query/body */
function resolveUser(ctx, query, body) {
  const token = ctx.token || query.get('token') || body.token || ''
  if (!token) return null
  const s = db.one('SELECT * FROM user_session WHERE token=?', [token])
  if (!s) return null
  const u = db.one('SELECT * FROM app_user WHERE id=?', [s.user_id])
  if (!u || u.status !== '启用') return null
  db.run('UPDATE user_session SET last_active=? WHERE token=?', [db.now(), token])
  return u
}
function issueToken(userId) {
  const token = db.uid('tok') + '-' + Math.random().toString(36).slice(2, 10)
  db.run('INSERT INTO user_session (token,user_id,created_at,last_active) VALUES (?,?,?,?)', [token, userId, db.now(), db.now()])
  return token
}

/* ==================== dispatch ==================== */
/**
 * @param {string} method  GET/POST/PUT/DELETE
 * @param {string} pathname  /api/xxx
 * @param {URLSearchParams} query
 * @param {object} body
 * @param {object} ctx  { source:'ipc'|'http', trusted:boolean, readOnly:boolean, role:string }
 * @returns {{status:number, data:any}}
 */
function dispatch(method, pathname, query, body = {}, ctx = {}) {
  const p = pathname.replace(/\/+$/, '') || '/'
  const isWrite = WRITE_METHODS.includes(method)
  const currentUser = resolveUser(ctx, query, body)
  // 角色由登录账号决定；无有效会话时降级为只读访客（登录/健康/授权等公共接口例外）
  const role = currentUser?.role || ctx.role || 'guest'
  if (ctx.source === 'http' && ctx.readOnly && isWrite && !READONLY_ALLOWED.includes(p)) {
    throw new ApiError(403, '当前主机已开启只读模式，远端客户端不可修改数据')
  }

  // ---------- 认证（公共接口，无需登录） ----------
  if (p === '/api/login' && method === 'POST') {
    const username = String(body.username || '').trim().toLowerCase()
    const u = db.one('SELECT * FROM app_user WHERE lower(username)=?', [username])
    if (!u) throw new ApiError(401, '账号不存在')
    if (u.status !== '启用') throw new ApiError(403, '该账号已停用，请联系管理员')
    if (u.password_hash !== db.hashPassword(body.password)) throw new ApiError(401, '密码不正确')
    // 当前仅开放超级管理员登录（可在设置中关闭该限制以恢复多角色）
    if (db.getSettings().onlyAdminLogin !== false && u.role !== 'admin')
      throw new ApiError(403, '当前仅开放超级管理员登录，其他角色暂未开放')
    const token = issueToken(u.id)
    return { status: 200, data: { token, user: publicUser(u) } }
  }
  if (p === '/api/logout' && method === 'POST') {
    const token = ctx.token || body.token || ''
    if (token) db.run('DELETE FROM user_session WHERE token=?', [token])
    return { status: 200, data: { ok: true } }
  }
  if (p === '/api/current' && method === 'GET') {
    return { status: 200, data: { user: currentUser ? publicUser(currentUser) : null } }
  }

  // 除公共接口外，均需登录
  const PUBLIC = ['/api/health', '/api/auth', '/api/license/status', '/api/license/activate', '/api/license/verify']
  if (!currentUser && !PUBLIC.includes(p)) throw new ApiError(401, '请先登录')

  // ---------- 修改密码（当前登录账号） ----------
  if (p === '/api/change-password' && method === 'POST') {
    const oldPwd = String(body.old_password || '')
    const newPwd = String(body.new_password || '')
    if (currentUser.password_hash !== db.hashPassword(oldPwd)) throw new ApiError(400, '原密码不正确')
    if (newPwd.length < 6) throw new ApiError(400, '新密码至少 6 位')
    if (newPwd === oldPwd) throw new ApiError(400, '新密码不能与原密码相同')
    db.run('UPDATE app_user SET password_hash=?, updated_at=? WHERE id=?', [db.hashPassword(newPwd), db.now(), currentUser.id])
    db.addLog({ event_type: '修改密码', target: currentUser.username, content: `账号【${currentUser.username}】修改了登录密码`, operator: currentUser.name, source: ctx.source || 'desktop' })
    return { status: 200, data: { ok: true } }
  }

  // ---------- 人员管理（仅管理员） ----------
  if (p === '/api/users' && method === 'GET') {
    if (role !== 'admin') throw new ApiError(403, '仅管理员可查看人员列表')
    return { status: 200, data: { list: db.all('SELECT * FROM app_user ORDER BY is_super DESC, created_at ASC').map(publicUser) } }
  }
  if (p === '/api/users' && method === 'POST') {
    if (role !== 'admin') throw new ApiError(403, '仅管理员可新增人员')
    const username = String(body.username || '').trim().toLowerCase()
    const name = String(body.name || '').trim()
    const r = String(body.role || '').trim()
    if (!/^[a-z0-9_.-]{3,20}$/.test(username)) throw new ApiError(400, '账号须为 3-20 位小写字母/数字/下划线/点/横线')
    if (!name) throw new ApiError(400, '姓名不能为空')
    if (!db.ROLES.includes(r)) throw new ApiError(400, `角色须为 ${db.ROLES.join('/')}`)
    if (db.one('SELECT id FROM app_user WHERE lower(username)=?', [username])) throw new ApiError(400, `账号【${username}】已存在`)
    const at = db.now()
    const u = { id: db.uid('usr'), username, name, password_hash: db.hashPassword(body.password || '123456'),
      role: r, is_super: 0, owner_name: String(body.owner_name || '').trim(), status: '启用',
      remark: String(body.remark || '').trim(), created_at: at, updated_at: at }
    db.run(`INSERT INTO app_user (id,username,name,password_hash,role,is_super,owner_name,status,remark,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [u.id, u.username, u.name, u.password_hash, u.role, 0, u.owner_name, u.status, u.remark, at, at])
    return { status: 200, data: publicUser(u) }
  }
  const userMatch = /^\/api\/users\/([^/]+)$/.exec(p)
  if (userMatch) {
    if (role !== 'admin') throw new ApiError(403, '仅管理员可管理人员')
    const id = userMatch[1]
    const u = db.one('SELECT * FROM app_user WHERE id=?', [id])
    if (!u) throw new ApiError(404, '账号不存在')
    if (method === 'PUT') {
      const name = String(body.name ?? u.name).trim()
      const r = String(body.role || u.role).trim()
      if (!name) throw new ApiError(400, '姓名不能为空')
      if (!db.ROLES.includes(r)) throw new ApiError(400, `角色须为 ${db.ROLES.join('/')}`)
      // 超级管理员不可降级/停用
      if (u.is_super && (r !== 'admin' || body.status === '停用')) throw new ApiError(400, '超级管理员不可降级或停用')
      const pwdHash = body.password ? db.hashPassword(body.password) : u.password_hash
      db.run(`UPDATE app_user SET name=?,role=?,password_hash=?,owner_name=?,status=?,remark=?,updated_at=? WHERE id=?`,
        [name, r, pwdHash, String(body.owner_name ?? (u.owner_name || '')).trim(),
          String(body.status || u.status || '启用'), String(body.remark ?? (u.remark || '')).trim(), db.now(), id])
      return { status: 200, data: publicUser(db.one('SELECT * FROM app_user WHERE id=?', [id])) }
    }
    if (method === 'DELETE') {
      if (u.is_super) throw new ApiError(400, '超级管理员不可删除')
      if (u.id === currentUser.id) throw new ApiError(400, '不可删除当前登录账号')
      db.mutate(() => {
        db.run('DELETE FROM user_session WHERE user_id=?', [id])
        db.run('DELETE FROM app_user WHERE id=?', [id])
      })
      return { status: 200, data: { id } }
    }
  }

  // ---------- 基础 ----------
  if (p === '/api/health' && method === 'GET')
    return { status: 200, data: { service: 'CONTRACT-AMS', time: db.now(), contracts: db.one('SELECT COUNT(*) AS n FROM contract').n } }
  if (p === '/api/bootstrap' && method === 'GET') {
    const data = db.bootstrap()
    // 数据范围：项目经理仅看其负责项目（负责人由登录账号的 owner_name 决定）
    if (role === 'pm') {
      const owner = currentUser?.owner_name || ''
      const owned = data.projects.filter((x) => x.owner === owner)
      const ids = new Set(owned.map((x) => x.id))
      data.contracts = data.contracts.filter((c) => ids.has(c.project_id))
    }
    return { status: 200, data }
  }
  if (p === '/api/backup' && method === 'GET') return { status: 200, data: db.bootstrap() }
  // V1.1：手动备份为 zip（可指定目录）
  if (p === '/api/backup/run' && method === 'POST') {
    if (role !== 'admin') throw new ApiError(403, '仅管理员可备份')
    const backup = require('./backup')
    const r = backup.createBackup(String(body.dir || '').trim())
    db.addLog({ event_type: '手动备份', content: `手动备份：${path.basename(r.file)}（${(r.size / 1048576).toFixed(1)}MB）`, operator: currentUser?.name || '', source: ctx.source || 'desktop' })
    return { status: 200, data: r }
  }
  if (p === '/api/next-code' && method === 'GET')
    return { status: 200, data: { code: db.nextCode(query.get('direction') || '对外') } }
  if (p === '/api/dashboard' && method === 'GET') {
    let list = db.all('SELECT * FROM contract')
    if (role === 'pm') {
      const owned = db.all('SELECT id FROM project WHERE owner=?', [currentUser?.owner_name || ''])
      const ids = new Set(owned.map((x) => x.id))
      list = list.filter((c) => ids.has(c.project_id))
    }
    // V1.1：按项目下钻（全部 / 指定项目 / 未归属）
    const pid = query.get('projectId')
    if (pid === '__none__') list = list.filter((c) => !c.project_id)
    else if (pid && pid !== 'all') list = list.filter((c) => c.project_id === pid)
    return { status: 200, data: dashboard(list) }
  }
  if (p === '/api/logs' && method === 'GET') {
    const cid = query.get('contractId')
    const list = cid
      ? db.all('SELECT * FROM lifecycle_log WHERE contract_id=? ORDER BY created_at DESC, rowid DESC', [cid])
      : db.all('SELECT * FROM lifecycle_log ORDER BY created_at DESC, rowid DESC')
    return { status: 200, data: { list } }
  }

  // ---------- 项目 ----------
  if (p === '/api/projects' && method === 'GET') return { status: 200, data: { list: db.all('SELECT * FROM project ORDER BY created_at DESC, rowid DESC') } }
  if (p === '/api/projects' && method === 'POST') {
    const pr = { id: db.uid('prj'), code: String(body.code || '').trim(), name: String(body.name || '').trim(),
      owner: String(body.owner || '').trim(), status: String(body.status || '筹备'), start_date: body.start_date || '',
      end_date: body.end_date || '', remark: body.remark || '', created_at: db.now(), updated_at: db.now() }
    if (!pr.name) throw new ApiError(400, '项目名称不能为空')
    if (!pr.code) pr.code = `P${new Date().getFullYear()}${String(db.one('SELECT COUNT(*) AS n FROM project').n + 1).padStart(3, '0')}`
    if (db.one('SELECT id FROM project WHERE code=?', [pr.code])) throw new ApiError(400, `项目编号【${pr.code}】已存在`)
    db.run(`INSERT INTO project (id,code,name,owner,status,start_date,end_date,remark,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [pr.id, pr.code, pr.name, pr.owner, pr.status, pr.start_date, pr.end_date, pr.remark, pr.created_at, pr.updated_at])
    db.persist()
    return { status: 200, data: pr }
  }
  const prjMatch = /^\/api\/projects\/([^/]+)$/.exec(p)
  if (prjMatch) {
    const id = prjMatch[1]
    const pr = db.one('SELECT * FROM project WHERE id=?', [id])
    if (!pr) throw new ApiError(404, '项目不存在')
    if (method === 'PUT') {
      const next = { ...pr, code: body.code || pr.code, name: String(body.name || pr.name).trim(), owner: body.owner ?? pr.owner,
        status: body.status || pr.status, start_date: body.start_date ?? pr.start_date, end_date: body.end_date ?? pr.end_date,
        remark: body.remark ?? pr.remark, updated_at: db.now() }
      if (!next.name) throw new ApiError(400, '项目名称不能为空')
      db.run(`UPDATE project SET code=?,name=?,owner=?,status=?,start_date=?,end_date=?,remark=?,updated_at=? WHERE id=?`,
        [next.code, next.name, next.owner, next.status, next.start_date, next.end_date, next.remark, next.updated_at, id])
      db.persist()
      return { status: 200, data: next }
    }
    if (method === 'DELETE') {
      if (db.one('SELECT COUNT(*) AS n FROM contract WHERE project_id=?', [id]).n > 0)
        throw new ApiError(400, '该项目下仍有合同，请先转移或删除合同')
      db.run('DELETE FROM project WHERE id=?', [id]); db.persist()
      return { status: 200, data: { id } }
    }
  }

  // ---------- 相对方 ----------
  if (p === '/api/parties' && method === 'GET') return { status: 200, data: { list: db.all('SELECT * FROM party ORDER BY name, rowid') } }
  if (p === '/api/parties' && method === 'POST') {
    const pt = { id: db.uid('pty'), name: String(body.name || '').trim(), role: body.role || '客户',
      credit_code: body.credit_code || '', contact: body.contact || '', phone: body.phone || '', email: body.email || '',
      bank: body.bank || '', account: body.account || '', rating: body.rating || '', blacklist: body.blacklist ? 1 : 0,
      remark: body.remark || '', created_at: db.now(), updated_at: db.now() }
    if (!pt.name) throw new ApiError(400, '相对方名称不能为空')
    if (db.one('SELECT id FROM party WHERE name=?', [pt.name])) throw new ApiError(400, `相对方【${pt.name}】已存在`)
    if (pt.blacklist && body.confirmBlacklist !== true) throw new ApiError(400, '标记为黑名单需确认（confirmBlacklist=true）')
    db.run(`INSERT INTO party (id,name,role,credit_code,contact,phone,email,bank,account,rating,blacklist,remark,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [pt.id, pt.name, pt.role, pt.credit_code, pt.contact, pt.phone, pt.email, pt.bank, pt.account, pt.rating, pt.blacklist, pt.remark, pt.created_at, pt.updated_at])
    db.persist()
    return { status: 200, data: pt }
  }
  const ptyMatch = /^\/api\/parties\/([^/]+)$/.exec(p)
  if (ptyMatch) {
    const id = ptyMatch[1]
    const pt = db.one('SELECT * FROM party WHERE id=?', [id])
    if (!pt) throw new ApiError(404, '相对方不存在')
    if (method === 'PUT') {
      const next = { ...pt, name: String(body.name || pt.name).trim(), role: body.role || pt.role,
        credit_code: body.credit_code ?? pt.credit_code, contact: body.contact ?? pt.contact, phone: body.phone ?? pt.phone,
        email: body.email ?? pt.email, bank: body.bank ?? pt.bank, account: body.account ?? pt.account,
        rating: body.rating ?? pt.rating, blacklist: body.blacklist === undefined ? pt.blacklist : (body.blacklist ? 1 : 0),
        remark: body.remark ?? pt.remark, updated_at: db.now() }
      if (!next.name) throw new ApiError(400, '相对方名称不能为空')
      if (db.one('SELECT id FROM party WHERE name=? AND id<>?', [next.name, id])) throw new ApiError(400, `相对方【${next.name}】已存在`)
      db.run(`UPDATE party SET name=?,role=?,credit_code=?,contact=?,phone=?,email=?,bank=?,account=?,rating=?,blacklist=?,remark=?,updated_at=? WHERE id=?`,
        [next.name, next.role, next.credit_code, next.contact, next.phone, next.email, next.bank, next.account, next.rating, next.blacklist, next.remark, next.updated_at, id])
      db.persist()
      return { status: 200, data: next }
    }
    if (method === 'DELETE') {
      if (db.one('SELECT COUNT(*) AS n FROM contract WHERE party_id=?', [id]).n > 0)
        throw new ApiError(400, '该相对方下仍有合同，请先转移或删除合同')
      db.run('DELETE FROM party WHERE id=?', [id]); db.persist()
      return { status: 200, data: { id } }
    }
  }

  // ---------- 合同台账 ----------
  if (p === '/api/contracts' && method === 'GET') {
    let list = db.all('SELECT * FROM contract ORDER BY created_at DESC, rowid DESC')
    if (role === 'pm') {
      const owned = db.all('SELECT id FROM project WHERE owner=?', [currentUser?.owner_name || ''])
      const ids = new Set(owned.map((x) => x.id))
      list = list.filter((c) => ids.has(c.project_id))
    }
    return { status: 200, data: { list: list.map(contractView) } }
  }
  if (p === '/api/contracts' && method === 'POST') {
    const c = sanitizeContract(body, { id: db.uid('ct'), created_at: db.now(), updated_at: db.now(), archived: 0 })
    // V1.1 补充协议：继承主合同信息时自动生成 {主编号}-n（全局唯一，冲突跳号）
    if (!c.contract_no && c.parent_id) {
      const parent = db.one('SELECT contract_no FROM contract WHERE id=?', [c.parent_id])
      if (parent) {
        let n = 1
        while (db.one('SELECT id FROM contract WHERE contract_no=?', [`${parent.contract_no}-${n}`])) n++
        c.contract_no = `${parent.contract_no}-${n}`
      }
    }
    if (!c.contract_no) c.contract_no = db.nextCode(c.direction)
    const err = validateContract(c)
    if (err) throw new ApiError(400, err)
    const pt = db.one('SELECT blacklist FROM party WHERE id=?', [c.party_id])
    if (pt && pt.blacklist && body.confirmBlacklist !== true) throw new ApiError(400, '该相对方在黑名单中，请显式确认后创建（confirmBlacklist=true）')
    db.mutate(() => {
      db.run(`INSERT INTO contract (id,contract_no,title,direction,type,status,project_id,party_id,parent_id,our_entity,amount,currency,sign_date,start_date,end_date,auto_renew,terminate_note,owner,archived,remark,created_at,updated_at,amount_ex_tax,tax_amount,tax_rate,category_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [c.id, c.contract_no, c.title, c.direction, c.type, c.status, c.project_id, c.party_id, c.parent_id,
          c.our_entity, c.amount, c.currency, c.sign_date, c.start_date, c.end_date, c.auto_renew, c.terminate_note,
          c.owner, 0, c.remark, c.created_at, c.updated_at, c.amount_ex_tax, c.tax_amount, c.tax_rate, c.category_id])
      db.addLog({ contract_id: c.id, contract_no: c.contract_no, event_type: '创建', content: `新增合同【${c.contract_no}】${c.title}${c.parent_id ? '（补充协议）' : ''}`, operator: body.operator || c.owner || '商务', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: contractView(findContract(c.id)) }
  }
  const ctMatch = /^\/api\/contracts\/([^/]+)$/.exec(p)
  if (ctMatch) {
    const id = ctMatch[1]
    const old = findContract(id)
    if (method === 'GET') {
      db.addLog({ contract_id: id, contract_no: old.contract_no, event_type: '查看', content: `打开合同【${old.contract_no}】详情`, operator: currentUser?.name || '访客', source: ctx.source || 'desktop' })
      return { status: 200, data: contractView(old) }
    }
    if (method === 'PUT') {
      if (old.archived) throw new ApiError(400, '合同已归档，请先解档再编辑')
      const next = sanitizeContract(body, old)
      next.updated_at = db.now()
      const err = validateContract(next, id)
      if (err) throw new ApiError(400, err)
      db.mutate(() => {
        db.run(`UPDATE contract SET contract_no=?,title=?,direction=?,type=?,status=?,project_id=?,party_id=?,parent_id=?,our_entity=?,amount=?,currency=?,sign_date=?,start_date=?,end_date=?,auto_renew=?,terminate_note=?,owner=?,remark=?,updated_at=?,amount_ex_tax=?,tax_amount=?,tax_rate=?,category_id=? WHERE id=?`,
          [next.contract_no, next.title, next.direction, next.type, next.status, next.project_id, next.party_id, next.parent_id,
            next.our_entity, next.amount, next.currency, next.sign_date, next.start_date, next.end_date, next.auto_renew,
            next.terminate_note, next.owner, next.remark, next.updated_at, next.amount_ex_tax, next.tax_amount, next.tax_rate, next.category_id, id])
        diffContractLogs(old, next, body.operator || next.owner || '商务', ctx.source || 'desktop')
      })
      return { status: 200, data: contractView(findContract(id)) }
    }
    if (method === 'DELETE') {
      if (db.one('SELECT COUNT(*) AS n FROM contract WHERE parent_id=?', [id]).n > 0)
        throw new ApiError(400, '该合同存在补充协议，请先处理子合同')
      if (body.password && body.password !== db.getSettings().deletePassword && db.getSettings().deletePassword)
        throw new ApiError(403, '删除口令不正确')
      db.mutate(() => {
        // 删除关联文件
        for (const f of db.all('SELECT file_path FROM contract_file WHERE contract_id=?', [id])) db.removeMediaFile(f.file_path)
        for (const t of ['contract_file', 'milestone', 'payment_plan', 'payment_record', 'approval_log']) db.run(`DELETE FROM ${t} WHERE contract_id=?`, [id])
        db.run('DELETE FROM contract WHERE id=?', [id])
        db.addLog({ contract_id: '', contract_no: old.contract_no, event_type: '删除', content: `合同【${old.contract_no}】${old.title} 已永久删除`, operator: body.operator || '管理员', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: { id } }
    }
  }
  const ctAction = /^\/api\/contracts\/([^/]+)\/(status|archive|unarchive)$/.exec(p)
  if (ctAction && method === 'POST') {
    const id = ctAction[1], action = ctAction[2]
    const old = findContract(id)
    if (action === 'status') {
      const to = String(body.status || '').trim()
      if (!db.STATUS.includes(to)) throw new ApiError(400, `非法状态：${to}`)
      if (to === '已签署' && db.one('SELECT COUNT(*) AS n FROM contract_file WHERE contract_id=?', [id]).n === 0)
        throw new ApiError(400, '转为「已签署」前需至少上传 1 份正文文件')
      if (to === '已完成') {
        const unfinished = db.one("SELECT COUNT(*) AS n FROM milestone WHERE contract_id=? AND status<>'已完成'", [id]).n
        if (unfinished > 0 && body.force !== true) throw new ApiError(400, `还有 ${unfinished} 个履约节点未完成，确认请传 force=true`)
      }
      db.mutate(() => {
        db.run('UPDATE contract SET status=?, updated_at=? WHERE id=?', [to, db.now(), id])
        db.addLog({ contract_id: id, contract_no: old.contract_no, event_type: '状态变更', target: 'status',
          before_value: old.status, after_value: to, content: `状态：${old.status} → ${to}${body.comment ? '（' + body.comment + '）' : ''}`,
          operator: body.operator || '商务', source: ctx.source || 'desktop' })
        if (to === '已归档' && db.getSettings().archiveAuto !== false) db.run('UPDATE contract SET archived=1 WHERE id=?', [id])
      })
      return { status: 200, data: contractView(findContract(id)) }
    }
    if (action === 'archive' || action === 'unarchive') {
      const to = action === 'archive' ? 1 : 0
      if (to === 0 && role !== 'admin') throw new ApiError(403, '仅管理员可解档')
      db.mutate(() => {
        db.run('UPDATE contract SET archived=?, updated_at=? WHERE id=?', [to, db.now(), id])
        db.addLog({ contract_id: id, contract_no: old.contract_no, event_type: to ? '归档' : '解档',
          content: to ? '合同已归档为只读态' : '合同已解档，恢复可编辑', operator: body.operator || '管理员', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: contractView(findContract(id)) }
    }
  }

  // ---------- 合同文件与版本 ----------
  if (p === '/api/contracts/:id/files') { /* 占位，实际用下方正则 */ }
  const fileMatch = /^\/api\/contracts\/([^/]+)\/files$/.exec(p)
  if (fileMatch) {
    const cid = fileMatch[1]
    const c = findContract(cid)
    if (method === 'GET') return { status: 200, data: { list: db.all('SELECT * FROM contract_file WHERE contract_id=? ORDER BY version DESC', [cid]) } }
    if (method === 'POST') {
      if (c.archived) throw new ApiError(400, '合同已归档，不可上传文件')
      const name = String(body.fileName || '未命名文件')
      const dataUrl = String(body.dataUrl || '')
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
      if (!m) throw new ApiError(400, '文件内容须为 base64 DataURL')
      const buf = Buffer.from(m[2], 'base64')
      const maxMB = Number(db.getSettings().maxFileSizeMB) || 200
      if (buf.length > maxMB * 1024 * 1024) throw new ApiError(413, `单文件不能超过 ${maxMB}MB（可在设置中调整，上限 300MB）`)
      const isMain = body.isMain ? 1 : 0
      const version = Number(body.version) || (db.one('SELECT MAX(version) AS v FROM contract_file WHERE contract_id=?', [cid]).v || 0) + 1
      const safe = name.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5.]/g, '_')
      const dir = db.contractFileDir(c.contract_no)
      fs.mkdirSync(dir, { recursive: true })
      const diskName = `v${version}_${Date.now()}_${safe}`
      fs.writeFileSync(path.join(dir, diskName), buf)
      const file_path = `/media/${encodeURIComponent(c.contract_no.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '_'))}/${diskName}`
      const f = { id: db.uid('file'), contract_id: cid, file_name: name, file_path, version, is_main: isMain,
        change_note: body.changeNote || '', size: buf.length, uploaded_by: body.operator || '商务', created_at: db.now() }
      db.mutate(() => {
        if (isMain) db.run('UPDATE contract_file SET is_main=0 WHERE contract_id=?', [cid])
        db.run(`INSERT INTO contract_file (id,contract_id,file_name,file_path,version,is_main,change_note,size,uploaded_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [f.id, f.contract_id, f.file_name, f.file_path, f.version, f.is_main, f.change_note, f.size, f.uploaded_by, f.created_at])
        db.addLog({ contract_id: cid, contract_no: c.contract_no, event_type: '文件变更', target: f.file_name,
          after_value: `v${version}`, content: `${isMain ? '替换正文' : '上传附件'}【${name}】v${version}${f.change_note ? '：' + f.change_note : ''}`,
          operator: f.uploaded_by, source: ctx.source || 'desktop' })
      })
      return { status: 200, data: f }
    }
  }
  const fileDel = /^\/api\/contract-files\/([^/]+)$/.exec(p)
  if (fileDel && method === 'DELETE') {
    const f = db.one('SELECT * FROM contract_file WHERE id=?', [fileDel[1]])
    if (!f) throw new ApiError(404, '文件不存在')
    const c = findContract(f.contract_id)
    if (c.archived) throw new ApiError(400, '合同已归档，不可删除文件')
    db.mutate(() => {
      db.removeMediaFile(f.file_path)
      db.run('DELETE FROM contract_file WHERE id=?', [f.id])
      db.addLog({ contract_id: c.id, contract_no: c.contract_no, event_type: '文件变更', target: f.file_name,
        before_value: `v${f.version}`, content: `删除文件【${f.file_name}】v${f.version}`, operator: body.operator || '商务', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: { id: f.id } }
  }
  // P0 修复：解析文件路径（桌面端 IPC 预览/下载用），带存在性校验与权限校验
  if (p === '/api/files/resolve' && method === 'POST') {
    const f = db.one('SELECT * FROM contract_file WHERE id=?', [body.fileId])
    if (!f) throw new ApiError(404, '文件记录不存在')
    // 权限：pm 仅本项目
    if (role === 'pm') {
      const owned = db.all('SELECT id FROM project WHERE owner=?', [currentUser?.owner_name || '']).map((x) => x.id)
      const c = db.one('SELECT project_id FROM contract WHERE id=?', [f.contract_id])
      if (!c || !owned.includes(c.project_id)) throw new ApiError(403, '无权访问该项目的文件')
    }
    const abs = db.mediaFilePath(f.file_path)
    if (!abs) throw new ApiError(400, '文件路径不合法')
    const exists = fs.existsSync(abs)
    const contract = db.one('SELECT contract_no FROM contract WHERE id=?', [f.contract_id]) || {}
    return { status: 200, data: {
      fileId: f.id, fileName: f.file_name, filePath: f.file_path, absPath: abs,
      size: f.size, version: f.version, exists, contractNo: contract.contract_no || '',
      ext: path.extname(f.file_name).toLowerCase(),
    } }
  }
  // 下载事件留痕
  if (p === '/api/files/view-log' && method === 'POST') {
    const f = db.one('SELECT * FROM contract_file WHERE id=?', [body.fileId])
    if (f) {
      const c = db.one('SELECT contract_no FROM contract WHERE id=?', [f.contract_id]) || {}
      db.addLog({ contract_id: f.contract_id, contract_no: c.contract_no || '', event_type: body.action === 'download' ? '下载文件' : '预览文件',
        target: f.file_name, content: `${body.action === 'download' ? '下载' : '预览'}【${f.file_name}】`,
        operator: currentUser?.name || '访客', source: ctx.source || 'desktop' })
    }
    return { status: 200, data: { ok: true } }
  }

  // ---------- 履约节点 ----------
  if (p === '/api/milestones' && method === 'POST') {
    const cid = body.contractId
    const c = findContract(cid)
    const m = { id: db.uid('ms'), contract_id: cid, name: String(body.name || '').trim(), plan_date: body.plan_date || '',
      done_date: body.done_date || '', status: body.status || '未开始', owner: body.owner || '', remark: body.remark || '', created_at: db.now() }
    if (!m.name) throw new ApiError(400, '节点名称不能为空')
    db.mutate(() => {
      db.run(`INSERT INTO milestone (id,contract_id,name,plan_date,done_date,status,owner,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [m.id, m.contract_id, m.name, m.plan_date, m.done_date, m.status, m.owner, m.remark, m.created_at])
      db.addLog({ contract_id: cid, contract_no: c.contract_no, event_type: '履约节点', content: `新增履约节点【${m.name}】`, operator: body.operator || '商务', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: m }
  }
  const msMatch = /^\/api\/milestones\/([^/]+)$/.exec(p)
  if (msMatch) {
    const m = db.one('SELECT * FROM milestone WHERE id=?', [msMatch[1]])
    if (!m) throw new ApiError(404, '履约节点不存在')
    const c = db.one('SELECT contract_no FROM contract WHERE id=?', [m.contract_id]) || {}
    if (method === 'PUT') {
      const next = { ...m, name: String(body.name || m.name).trim(), plan_date: body.plan_date ?? m.plan_date,
        done_date: body.done_date ?? m.done_date, status: body.status || m.status, owner: body.owner ?? m.owner, remark: body.remark ?? m.remark }
      // 逾期判定
      if (next.done_date && next.plan_date && next.done_date > next.plan_date) next.status = '已完成（逾期）'
      db.mutate(() => {
        db.run(`UPDATE milestone SET name=?,plan_date=?,done_date=?,status=?,owner=?,remark=? WHERE id=?`,
          [next.name, next.plan_date, next.done_date, next.status, next.owner, next.remark, m.id])
        db.addLog({ contract_id: m.contract_id, contract_no: c.contract_no, event_type: '履约节点',
          content: `节点【${next.name}】更新为 ${next.status}${next.done_date ? '（' + next.done_date + '）' : ''}`, operator: body.operator || '商务', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: next }
    }
    if (method === 'DELETE') {
      db.mutate(() => {
        db.run('DELETE FROM milestone WHERE id=?', [m.id])
        db.addLog({ contract_id: m.contract_id, contract_no: c.contract_no, event_type: '履约节点', content: `删除节点【${m.name}】`, operator: body.operator || '商务', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: { id: m.id } }
    }
  }

  // ---------- V1.1 期次模板生成 ----------
  if (p === '/api/payment-plans/generate' && method === 'POST') {
    const c = findContract(body.contractId)
    const template = String(body.template || 'once')
    const direction = body.direction || '应收'
    const total = Number(body.total ?? c.amount) || 0
    if (!['应收', '应付'].includes(direction)) throw new ApiError(400, '方向须为 应收/应付')
    const existing = db.all('SELECT id FROM payment_plan WHERE contract_id=?', [c.id])
    if (existing.length && body.confirm !== 'overwrite' && body.confirm !== 'append')
      throw new ApiError(400, '该合同已有收付款计划，请确认覆盖或追加（confirm=overwrite/append）')
    // 生成 {seq, ratio, date}
    const plans = []
    const addMonths = (dateStr, months) => {
      const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return ''
      d.setMonth(d.getMonth() + months)
      const p2 = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    }
    if (template === 'once') {
      plans.push({ seq: '一次性', ratio: 1, date: c.end_date || '' })
    } else if (template === 'down-tail') {
      const first = Number(body.firstRatio ?? 30) / 100
      plans.push({ seq: '首付', ratio: first, date: c.start_date || addMonths(c.sign_date, 0) })
      plans.push({ seq: '尾款', ratio: 1 - first, date: c.end_date || '' })
    } else if (template === 'quarterly') {
      const start = c.start_date || c.sign_date
      const end = c.end_date
      if (!start || !end) throw new ApiError(400, '按季度生成需要合同填写开始日与结束日')
      const months = []
      for (let d = new Date(start + 'T00:00:00'); d <= new Date(end + 'T00:00:00'); d.setMonth(d.getMonth() + 3)) {
        const p2 = (n) => String(n).padStart(2, '0')
        months.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(Math.min(d.getDate(), new Date(end + 'T00:00:00').getDate()))}`)
      }
      if (!months.length) months.push(addMonths(start, 3))
      months.forEach((dt, i) => plans.push({ seq: `第${i + 1}期`, ratio: Math.round((1 / months.length) * 100) / 100, date: dt }))
    } else if (template === 'custom') {
      const specs = Array.isArray(body.items) ? body.items : []
      if (!specs.length) throw new ApiError(400, '自定义模板请提供期次明细 items')
      for (const it of specs) plans.push({ seq: String(it.seq || ''), ratio: Number(it.ratio) || 0, date: String(it.date || '') })
    } else throw new ApiError(400, '模板须为 once / down-tail / quarterly / custom')
    db.mutate(() => {
      if (body.confirm === 'overwrite') db.run('DELETE FROM payment_plan WHERE contract_id=?', [c.id])
      for (const pl of plans) {
        db.run(`INSERT INTO payment_plan (id,contract_id,direction,seq,plan_amount,plan_date,status,remark,created_at,nature) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [db.uid('pp'), c.id, direction, pl.seq, Math.round(total * pl.ratio * 100) / 100, pl.date || '', '未收付', `模板：${template}`, db.now(), body.nature || 'contract'])
      }
      db.addLog({ contract_id: c.id, contract_no: c.contract_no, event_type: '收付款计划',
        content: `按模板【${template}】生成 ${plans.length} 期收付款计划${body.confirm === 'overwrite' ? '（覆盖）' : ''}`, operator: currentUser?.name || '', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: { generated: plans.length, template } }
  }

  // ---------- 收付款计划 ----------
  if (p === '/api/payment-plans' && method === 'POST') {
    const cid = body.contractId
    findContract(cid)
    const pp = { id: db.uid('pp'), contract_id: cid, direction: body.direction || '应收', seq: body.seq || '',
      plan_amount: Number(body.plan_amount) || 0, plan_date: body.plan_date || '', status: body.status || '未收付',
      remark: body.remark || '', created_at: db.now(), nature: body.nature || 'contract' }
    if (!['应收', '应付'].includes(pp.direction)) throw new ApiError(400, '方向须为 应收/应付')
    if (!db.PAY_NATURES.includes(pp.nature)) throw new ApiError(400, '收付款性质不合法')
    db.run(`INSERT INTO payment_plan (id,contract_id,direction,seq,plan_amount,plan_date,status,remark,created_at,nature) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [pp.id, pp.contract_id, pp.direction, pp.seq, pp.plan_amount, pp.plan_date, pp.status, pp.remark, pp.created_at, pp.nature])
    db.persist()
    return { status: 200, data: pp }
  }
  const ppMatch = /^\/api\/payment-plans\/([^/]+)$/.exec(p)
  if (ppMatch) {
    const pp = db.one('SELECT * FROM payment_plan WHERE id=?', [ppMatch[1]])
    if (!pp) throw new ApiError(404, '收付款计划不存在')
    if (method === 'PUT') {
      const next = { ...pp, direction: body.direction || pp.direction, seq: body.seq ?? pp.seq,
        plan_amount: Number(body.plan_amount ?? pp.plan_amount) || 0, plan_date: body.plan_date ?? pp.plan_date,
        status: body.status || pp.status, remark: body.remark ?? pp.remark }
      db.run(`UPDATE payment_plan SET direction=?,seq=?,plan_amount=?,plan_date=?,status=?,remark=? WHERE id=?`,
        [next.direction, next.seq, next.plan_amount, next.plan_date, next.status, next.remark, pp.id])
      db.persist()
      return { status: 200, data: next }
    }
    if (method === 'DELETE') {
      if (db.one('SELECT COUNT(*) AS n FROM payment_record WHERE plan_id=?', [pp.id]).n > 0)
        throw new ApiError(400, '该计划已有到账流水，请先删除流水')
      db.run('DELETE FROM payment_plan WHERE id=?', [pp.id]); db.persist()
      return { status: 200, data: { id: pp.id } }
    }
  }
  // ---------- 收付款流水 ----------
  if (p === '/api/payment-records' && method === 'POST') {
    const cid = body.contractId
    const c = findContract(cid)
    const pr = { id: db.uid('pr'), contract_id: cid, plan_id: body.plan_id || '', amount: Number(body.amount) || 0,
      pay_date: String(body.pay_date || '').trim(), method: body.method || '银行转账', voucher_path: body.voucher_path || '',
      remark: body.remark || '', created_at: db.now(), nature: body.nature || 'contract' }
    if (!pr.pay_date || !/^\d{4}-\d{2}-\d{2}$/.test(pr.pay_date)) throw new ApiError(400, '到账日期格式应为 YYYY-MM-DD')
    if (!(pr.amount > 0)) throw new ApiError(400, '金额须大于 0')
    if (!db.PAY_NATURES.includes(pr.nature)) throw new ApiError(400, '收付款性质不合法')
    if (role === 'pm' && !READONLY_ALLOWED.includes(p)) throw new ApiError(403, '项目经理不可登记收付款')
    db.mutate(() => {
      db.run(`INSERT INTO payment_record (id,contract_id,plan_id,amount,pay_date,method,voucher_path,remark,created_at,nature) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [pr.id, pr.contract_id, pr.plan_id, pr.amount, pr.pay_date, pr.method, pr.voucher_path, pr.remark, pr.created_at, pr.nature])
      if (pr.plan_id) {
        const plan = db.one('SELECT * FROM payment_plan WHERE id=?', [pr.plan_id])
        if (plan) {
          const got = db.one('SELECT COALESCE(SUM(amount),0) AS n FROM payment_record WHERE plan_id=?', [pr.plan_id]).n
          const st = got <= 0 ? '未收付' : got + 0.01 >= Number(plan.plan_amount) ? '已完成' : '部分'
          db.run('UPDATE payment_plan SET status=? WHERE id=?', [st, pr.plan_id])
        }
      }
      db.addLog({ contract_id: cid, contract_no: c.contract_no, event_type: '收付款登记',
        content: `登记${(db.one('SELECT direction FROM payment_plan WHERE id=?', [pr.plan_id]) || {}).direction || '计划外'}流水 ¥${pr.amount}（${pr.pay_date}，${pr.method}）`,
        operator: body.operator || '财务', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: pr }
  }
  const prMatch = /^\/api\/payment-records\/([^/]+)$/.exec(p)
  if (prMatch && method === 'DELETE') {
    const pr = db.one('SELECT * FROM payment_record WHERE id=?', [prMatch[1]])
    if (!pr) throw new ApiError(404, '流水不存在')
    const c = db.one('SELECT contract_no FROM contract WHERE id=?', [pr.contract_id]) || {}
    db.mutate(() => {
      db.run('DELETE FROM payment_record WHERE id=?', [pr.id])
      if (pr.plan_id) {
        const plan = db.one('SELECT plan_amount FROM payment_plan WHERE id=?', [pr.plan_id])
        if (plan) {
          const got = db.one('SELECT COALESCE(SUM(amount),0) AS n FROM payment_record WHERE plan_id=?', [pr.plan_id]).n
          db.run('UPDATE payment_plan SET status=? WHERE id=?', [got <= 0 ? '未收付' : got + 0.01 >= Number(plan.plan_amount) ? '已完成' : '部分', pr.plan_id])
        }
      }
      db.addLog({ contract_id: pr.contract_id, contract_no: c.contract_no, event_type: '收付款登记', content: `删除流水 ¥${pr.amount}（${pr.pay_date}）`, operator: body.operator || '财务', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: { id: pr.id } }
  }
  // ---------- V1.1 发票登记 ----------
  // 合同维度发票汇总
  if (/^\/api\/contracts\/([^/]+)\/invoices\/summary$/.test(p) && method === 'GET') {
    const cid = /^\/api\/contracts\/([^/]+)\/invoices\/summary$/.exec(p)[1]
    findContract(cid)
    const rows = db.all("SELECT direction, amount_incl_tax FROM invoice WHERE contract_id=? AND status!='作废'", [cid])
    const issued = rows.filter((x) => x.direction === '开票').reduce((s, x) => s + Number(x.amount_incl_tax || 0), 0)
    const received = rows.filter((x) => x.direction === '收票').reduce((s, x) => s + Number(x.amount_incl_tax || 0), 0)
    return { status: 200, data: { issued, received, count: rows.length } }
  }
  if (p === '/api/invoices' && method === 'GET') {
    // 全局列表，可按 contractId / direction / status 筛选，pm 限本项目
    let list = db.all('SELECT i.*, c.contract_no, c.title AS contract_title FROM invoice i LEFT JOIN contract c ON c.id=i.contract_id ORDER BY i.invoice_date DESC, i.created_at DESC')
    if (role === 'pm') {
      const owned = db.all('SELECT id FROM project WHERE owner=?', [currentUser?.owner_name || '']).map((x) => x.id)
      const cids = new Set(db.all('SELECT id, project_id FROM contract').filter((c) => owned.includes(c.project_id)).map((c) => c.id))
      list = list.filter((i) => cids.has(i.contract_id))
    }
    if (query.get('contractId')) list = list.filter((i) => i.contract_id === query.get('contractId'))
    if (query.get('direction')) list = list.filter((i) => i.direction === query.get('direction'))
    if (query.get('status')) list = list.filter((i) => i.status === query.get('status'))
    return { status: 200, data: { list } }
  }
  if (p === '/api/invoices' && method === 'POST') {
    const cid = body.contractId
    const c = findContract(cid)
    if (role === 'pm') throw new ApiError(403, '项目经理不可维护发票')
    const inv = {
      id: db.uid('inv'), contract_id: cid,
      direction: body.direction || (c.direction === '对外' ? '开票' : '收票'),
      invoice_type: body.invoice_type || '普票', invoice_no: String(body.invoice_no || '').trim(),
      invoice_code: String(body.invoice_code || '').trim(), invoice_date: String(body.invoice_date || '').trim(),
      amount_ex_tax: Number(body.amount_ex_tax) || 0, tax_amount: Number(body.tax_amount) || 0,
      amount_incl_tax: Number(body.amount_incl_tax) || 0, tax_rate: Number(body.tax_rate) || 0,
      seller_name: String(body.seller_name || '').trim(), buyer_name: String(body.buyer_name || '').trim(),
      status: body.status || '草稿', remark: String(body.remark || '').trim(),
      created_by: currentUser?.name || '', created_at: db.now(), updated_at: db.now(),
    }
    if (!db.INVOICE_DIRECTIONS.includes(inv.direction)) throw new ApiError(400, '票种方向须为 开票/收票')
    if (!db.INVOICE_TYPES.includes(inv.invoice_type)) throw new ApiError(400, '发票类型不合法')
    if (!inv.invoice_no) throw new ApiError(400, '发票号码不能为空')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date)) throw new ApiError(400, '开票日期格式应为 YYYY-MM-DD')
    if (!(inv.amount_incl_tax >= 0)) throw new ApiError(400, '价税合计不能为负')
    if (!db.INVOICE_STATUS.includes(inv.status)) throw new ApiError(400, '发票状态不合法')
    // 自动算税额：填了价税合计与不含税金额时
    if (inv.amount_ex_tax && inv.amount_incl_tax) inv.tax_amount = Math.round((inv.amount_incl_tax - inv.amount_ex_tax) * 100) / 100
    const dup = db.one('SELECT id FROM invoice WHERE invoice_no=?', [inv.invoice_no])
    if (dup && db.getSettings().invoiceNoDuplicateForbid) throw new ApiError(400, `发票号码【${inv.invoice_no}】已存在`)
    db.mutate(() => {
      db.run(`INSERT INTO invoice (id,contract_id,direction,invoice_type,invoice_no,invoice_code,invoice_date,amount_ex_tax,tax_amount,amount_incl_tax,tax_rate,seller_name,buyer_name,status,remark,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [inv.id, inv.contract_id, inv.direction, inv.invoice_type, inv.invoice_no, inv.invoice_code, inv.invoice_date,
          inv.amount_ex_tax, inv.tax_amount, inv.amount_incl_tax, inv.tax_rate, inv.seller_name, inv.buyer_name,
          inv.status, inv.remark, inv.created_by, inv.created_at, inv.updated_at])
      db.addLog({ contract_id: cid, contract_no: c.contract_no, event_type: '发票登记',
        content: `登记${inv.direction}【${inv.invoice_no}】价税合计 ¥${inv.amount_incl_tax}`, operator: inv.created_by, source: ctx.source || 'desktop' })
    })
    return { status: 200, data: inv }
  }
  const invMatch = /^\/api\/invoices\/([^/]+)$/.exec(p)
  if (invMatch) {
    const inv = db.one('SELECT * FROM invoice WHERE id=?', [invMatch[1]])
    if (!inv) throw new ApiError(404, '发票不存在')
    if (role === 'pm') throw new ApiError(403, '项目经理不可维护发票')
    if (method === 'PUT') {
      const next = { ...inv }
      for (const k of ['direction','invoice_type','invoice_no','invoice_code','invoice_date','seller_name','buyer_name','status','remark'])
        if (k in body) next[k] = String(body[k] ?? '').trim()
      for (const k of ['amount_ex_tax','tax_amount','amount_incl_tax','tax_rate'])
        if (k in body) next[k] = Number(body[k]) || 0
      if (!db.INVOICE_DIRECTIONS.includes(next.direction)) throw new ApiError(400, '票种方向不合法')
      if (!db.INVOICE_TYPES.includes(next.invoice_type)) throw new ApiError(400, '发票类型不合法')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.invoice_date)) throw new ApiError(400, '开票日期格式应为 YYYY-MM-DD')
      if (!db.INVOICE_STATUS.includes(next.status)) throw new ApiError(400, '发票状态不合法')
      if (inv.status !== '作废' && next.status === '作废' && !String(body.voidReason || '').trim())
        throw new ApiError(400, '发票作废必须填写原因')
      if (inv.status !== '作废' && next.status === '作废')
        next.remark = `${next.remark} [作废原因：${String(body.voidReason).trim()}]`.trim()
      if (next.amount_ex_tax && next.amount_incl_tax) next.tax_amount = Math.round((next.amount_incl_tax - next.amount_ex_tax) * 100) / 100
      db.mutate(() => {
        db.run(`UPDATE invoice SET direction=?,invoice_type=?,invoice_no=?,invoice_code=?,invoice_date=?,amount_ex_tax=?,tax_amount=?,amount_incl_tax=?,tax_rate=?,seller_name=?,buyer_name=?,status=?,remark=?,updated_at=? WHERE id=?`,
          [next.direction, next.invoice_type, next.invoice_no, next.invoice_code, next.invoice_date, next.amount_ex_tax,
            next.tax_amount, next.amount_incl_tax, next.tax_rate, next.seller_name, next.buyer_name, next.status, next.remark, db.now(), inv.id])
        db.addLog({ contract_id: inv.contract_id, event_type: '发票变更', target: inv.invoice_no,
          content: `发票【${inv.invoice_no}】更新${inv.status !== '作废' && next.status === '作废' ? '（作废）' : ''}`, operator: currentUser?.name || '', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: next }
    }
    if (method === 'DELETE') {
      db.mutate(() => {
        db.run('DELETE FROM invoice_payment_link WHERE invoice_id=?', [inv.id])
        db.run('DELETE FROM invoice WHERE id=?', [inv.id])
        db.addLog({ contract_id: inv.contract_id, event_type: '发票变更', content: `删除发票【${inv.invoice_no}】`, operator: currentUser?.name || '', source: ctx.source || 'desktop' })
      })
      return { status: 200, data: { id: inv.id } }
    }
  }

  // H5 简易登记（只读白名单）
  if (p === '/api/h5/register-payment' && method === 'POST') {
    body.contractId = body.contractId || body.contract_id
    return dispatch('POST', '/api/payment-records', query, body, ctx)
  }

  // ---------- 审批 ----------
  const apMatch = /^\/api\/contracts\/([^/]+)\/approve$/.exec(p)
  if (apMatch && method === 'POST') {
    const id = apMatch[1]
    const c = findContract(id)
    if (c.status !== '审批中') throw new ApiError(400, '仅「审批中」的合同可审批')
    const action = String(body.action || '') // approve | reject
    if (!['approve', 'reject'].includes(action)) throw new ApiError(400, 'action 须为 approve/reject')
    if (action === 'reject' && !String(body.comment || '').trim()) throw new ApiError(400, '驳回必须填写审批意见')
    const level = Number(body.level) || 1
    db.mutate(() => {
      db.run(`INSERT INTO approval_log (id,contract_id,level,action,operator,comment,created_at) VALUES (?,?,?,?,?,?,?)`,
        [db.uid('ap'), id, level, action === 'approve' ? '通过' : '驳回', body.operator || '审批人', body.comment || '', db.now()])
      const nextStatus = action === 'approve' ? (level >= 2 || c.amount < db.getSettings().approvalLevel2 ? '已签署' : '审批中') : '已驳回'
      db.run('UPDATE contract SET status=?, updated_at=? WHERE id=?', [nextStatus, db.now(), id])
      db.addLog({ contract_id: id, contract_no: c.contract_no, event_type: '审批',
        content: `${level}级审批${action === 'approve' ? '通过' : '驳回'}：${body.comment || ''}${action === 'approve' && nextStatus === '已签署' ? ' → 已签署' : ''}`,
        operator: body.operator || '审批人', source: ctx.source || 'desktop' })
    })
    return { status: 200, data: contractView(findContract(id)) }
  }

  // ---------- 统计（按项目 / 相对方） ----------
  if (p === '/api/stats/by-project' && method === 'GET') {
    const list = db.all('SELECT * FROM contract')
    const out = db.all('SELECT * FROM project').map((pr) => {
      const cs = list.filter((c) => c.project_id === pr.id)
      return { ...pr, contractCount: cs.length, amount: cs.reduce((s, c) => s + Number(c.amount || 0), 0) }
    })
    return { status: 200, data: { list: out } }
  }
  if (p === '/api/stats/by-party' && method === 'GET') {
    const list = db.all('SELECT * FROM contract')
    const out = db.all('SELECT * FROM party').map((pt) => {
      const cs = list.filter((c) => c.party_id === pt.id)
      return { ...pt, contractCount: cs.length, amount: cs.reduce((s, c) => s + Number(c.amount || 0), 0) }
    })
    return { status: 200, data: { list: out } }
  }

  // ---------- 字典 / 设置 ----------
  if (p === '/api/dict-types' && method === 'GET') return { status: 200, data: { list: db.all('SELECT * FROM dict_type ORDER BY sort_order, rowid') } }
  if (p === '/api/dict-types' && method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) throw new ApiError(400, '类型名称不能为空')
    if (db.one('SELECT id FROM dict_type WHERE name=?', [name])) throw new ApiError(400, `类型【${name}】已存在`)
    const d = { id: db.uid('dt'), name, direction_scope: body.direction_scope || '全部', sort_order: Number(body.sort_order) || 0 }
    db.run('INSERT INTO dict_type (id,name,direction_scope,sort_order) VALUES (?,?,?,?)', [d.id, d.name, d.direction_scope, d.sort_order])
    db.persist()
    return { status: 200, data: d }
  }
  const dictDel = /^\/api\/dict-types\/([^/]+)$/.exec(p)
  if (dictDel && method === 'DELETE') {
    const d = db.one('SELECT * FROM dict_type WHERE id=?', [dictDel[1]])
    if (!d) throw new ApiError(404, '类型不存在')
    if (db.one('SELECT COUNT(*) AS n FROM contract WHERE type=?', [d.name]).n > 0) throw new ApiError(400, `类型【${d.name}】已被合同引用，不可删除`)
    db.run('DELETE FROM dict_type WHERE id=?', [d.id]); db.persist()
    return { status: 200, data: { id: d.id } }
  }
  // V1.1 费用/业务分类字典
  if (p === '/api/dict-categories' && method === 'GET')
    return { status: 200, data: { list: db.all('SELECT * FROM dict_category ORDER BY sort_order, rowid') } }
  if (p === '/api/dict-categories' && method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) throw new ApiError(400, '分类名称不能为空')
    if (db.one('SELECT id FROM dict_category WHERE name=?', [name])) throw new ApiError(400, `分类【${name}】已存在`)
    const d = { id: db.uid('cat'), name, sort_order: Number(body.sort_order) || 0 }
    db.run('INSERT INTO dict_category (id,name,sort_order) VALUES (?,?,?)', [d.id, d.name, d.sort_order])
    db.persist()
    return { status: 200, data: d }
  }
  const catDel = /^\/api\/dict-categories\/([^/]+)$/.exec(p)
  if (catDel && method === 'DELETE') {
    const d = db.one('SELECT * FROM dict_category WHERE id=?', [catDel[1]])
    if (!d) throw new ApiError(404, '分类不存在')
    if (db.one('SELECT COUNT(*) AS n FROM contract WHERE category_id=?', [d.id]).n > 0) throw new ApiError(400, `分类【${d.name}】已被合同引用，不可删除`)
    db.run('DELETE FROM dict_category WHERE id=?', [d.id]); db.persist()
    return { status: 200, data: { id: d.id } }
  }
  if (p === '/api/settings' && method === 'PUT') {
    db.mutate(() => { for (const [k, v] of Object.entries(body)) db.setSetting(k, v) })
    return { status: 200, data: db.getSettings() }
  }

  // ---------- 导入 / 导出 ----------
  if (p === '/api/import' && method === 'POST') {
    const rows = Array.isArray(body.rows) ? body.rows : []
    const created = [], failed = [], seen = new Set()
    db.mutate(() => {
      rows.forEach((raw, i) => {
        const rowNo = raw.__rowNo || i + 1
        const c = sanitizeContract(raw, { id: db.uid('ct'), created_at: db.now(), updated_at: db.now(), archived: 0 })
        if (!c.contract_no) c.contract_no = db.nextCode(c.direction)
        // 按名称关联相对方 / 项目（这些字段不在 contract 表中，需从原始行读取）
        const rawParty = String(raw.party_name || raw['相对方'] || '').trim()
        const rawProject = String(raw.project_name || raw['项目'] || '').trim()
        const pt = rawParty ? db.one('SELECT id FROM party WHERE name=?', [rawParty]) : null
        if (pt && !c.party_id) c.party_id = pt.id
        let err = validateContract(c)
        if (!err && !pt && rawParty) err = `相对方【${rawParty}】不存在，请先在相对方档案创建`
        if (!err && seen.has(c.contract_no.toUpperCase())) err = `合同编号【${c.contract_no}】在本批次中重复`
        if (err) { failed.push({ row: rowNo, code: c.contract_no, reason: err }); return }
        seen.add(c.contract_no.toUpperCase())
        const prj = rawProject ? db.one('SELECT id FROM project WHERE name=?', [rawProject]) : null
        if (prj && !c.project_id) c.project_id = prj.id
        db.run(`INSERT INTO contract (id,contract_no,title,direction,type,status,project_id,party_id,parent_id,our_entity,amount,currency,sign_date,start_date,end_date,auto_renew,terminate_note,owner,archived,remark,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.contract_no, c.title, c.direction, c.type, c.status, c.project_id, c.party_id, c.parent_id,
            c.our_entity, c.amount, c.currency, c.sign_date, c.start_date, c.end_date, c.auto_renew, c.terminate_note,
            c.owner, 0, c.remark, c.created_at, c.updated_at])
        db.addLog({ contract_id: c.id, contract_no: c.contract_no, event_type: '创建', content: `导入合同【${c.contract_no}】${c.title}`, operator: body.operator || '商务', source: 'import' })
        created.push(c)
      })
      if (created.length) db.addLog({ event_type: '批量导入', content: `批量导入合同：成功 ${created.length} 条，失败 ${failed.length} 条`, operator: body.operator || '商务', source: 'import' })
    })
    return { status: 200, data: { created: created.length, failed, total: rows.length } }
  }

  throw new ApiError(404, `未知接口：${method} ${p}`)
}

module.exports = { dispatch, ApiError, dashboard, contractView }
