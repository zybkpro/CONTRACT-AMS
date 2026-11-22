'use strict'
/**
 * SQLite 数据层（sql.js：纯 WASM 实现，无原生编译依赖，Electron / 独立 Node 通用）
 * 数据文件： <data>/contractams.sqlite   合同文件目录： <data>/media/<合同编号>/
 * 与 IT-AMS 同构：三端（桌面 IPC / 局域网 HTTP / H5）共用这一份主库。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const initSqlJs = require('sql.js')

const ROOT = path.join(__dirname, '..', '..')
const DATA_DIR = process.env.CONTRACTAMS_DATA_DIR || path.join(ROOT, 'data')
const DB_FILE = path.join(DATA_DIR, 'contractams.sqlite')
const MEDIA_DIR = path.join(DATA_DIR, 'media')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SEED_FILE = path.join(ROOT, 'server', 'seed.json')

const DEFAULT_SETTINGS = {
  codePrefixIn: 'CG',       // 对内合同（采购/外包）编号前缀
  codePrefixOut: 'XS',      // 对外合同（销售/框架）编号前缀
  amountBasis: '含税',       // 金额口径：含税 / 未税（仅界面标注）
  approvalLevel1: 100000,   // 一级审批阈值
  approvalLevel2: 500000,   // 二级审批阈值
  remindDays: [30, 15, 7],  // 到期提醒窗口
  archiveAuto: false,       // 完成/终止后是否自动归档
  sensitiveMask: true,      // 敏感字段脱敏开关
  maskKeep: 4,              // 脱敏保留尾号位数
  exportMask: true,         // 导出时是否脱敏
  visibleColumns: ['contract_no', 'title', 'direction', 'type', 'status', 'project_name', 'party_name', 'amount', 'sign_date', 'end_date', 'owner'],
  exportColumns: ['contract_no', 'title', 'direction', 'type', 'status', 'project_name', 'party_name', 'our_entity', 'amount', 'currency', 'sign_date', 'start_date', 'end_date', 'owner'],
  roles: { admin: '管理员', biz: '商务', pm: '项目经理', finance: '财务' },
  onlyAdminLogin: true,     // 当前仅开放超级管理员登录（临时简化，可关闭恢复多角色）
}
const DEFAULT_CONFIG = { port: 8788, token: '', h5ReadOnly: false, autoStart: false, https: false }

const STATUS = ['草稿', '审批中', '已驳回', '已签署', '履约中', '已完成', '已终止', '已归档']
const DIRECTION = ['对内', '对外']
const ROLES = ['admin', 'biz', 'pm', 'finance']
const ROLE_LABEL = { admin: '管理员', biz: '商务', pm: '项目经理', finance: '财务' }

/** 密码散列（MVP 用带盐 SHA-256；生产应换 bcrypt/argon2） */
function hashPassword(pwd, salt = 'contractams') {
  return crypto.createHash('sha256').update(`${salt}::${String(pwd || '')}`).digest('hex')
}

let db = null

function now() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(MEDIA_DIR, { recursive: true }) }

/** 初始化数据库；已存在则直接加载 */
async function init() {
  ensureDirs()
  const wasmDir = path.dirname(require.resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) })
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database()
  db.run('PRAGMA foreign_keys = ON')
  createTables()
  const isNew = !fs.existsSync(DB_FILE)
  if (isNew || one('SELECT COUNT(*) AS n FROM contract').n === 0) seed()
  ensureDefaultUsers()
  persist()
  return { DB_FILE, DATA_DIR }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, owner TEXT DEFAULT '',
      status TEXT DEFAULT '筹备', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', remark TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_name ON project(name);

    CREATE TABLE IF NOT EXISTS party (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT DEFAULT '客户',
      credit_code TEXT DEFAULT '', contact TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '',
      bank TEXT DEFAULT '', account TEXT DEFAULT '', rating TEXT DEFAULT '', blacklist INTEGER DEFAULT 0,
      remark TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_party_name ON party(name);

    CREATE TABLE IF NOT EXISTS contract (
      id TEXT PRIMARY KEY, contract_no TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      direction TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT '草稿',
      project_id TEXT DEFAULT '', party_id TEXT DEFAULT '', parent_id TEXT DEFAULT '',
      our_entity TEXT DEFAULT '', amount REAL DEFAULT 0, currency TEXT DEFAULT 'CNY',
      sign_date TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '',
      auto_renew INTEGER DEFAULT 0, terminate_note TEXT DEFAULT '', owner TEXT DEFAULT '',
      archived INTEGER DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contract_no ON contract(contract_no);
    CREATE INDEX IF NOT EXISTS idx_contract_project ON contract(project_id);
    CREATE INDEX IF NOT EXISTS idx_contract_party ON contract(party_id);
    CREATE INDEX IF NOT EXISTS idx_contract_status ON contract(status);
    CREATE INDEX IF NOT EXISTS idx_contract_end ON contract(end_date);

    CREATE TABLE IF NOT EXISTS contract_file (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL,
      version INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0, change_note TEXT DEFAULT '',
      size INTEGER DEFAULT 0, uploaded_by TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cfile_contract ON contract_file(contract_id);

    CREATE TABLE IF NOT EXISTS milestone (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, name TEXT NOT NULL,
      plan_date TEXT DEFAULT '', done_date TEXT DEFAULT '', status TEXT DEFAULT '未开始',
      owner TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ms_contract ON milestone(contract_id);

    CREATE TABLE IF NOT EXISTS payment_plan (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, direction TEXT NOT NULL,
      seq TEXT DEFAULT '', plan_amount REAL DEFAULT 0, plan_date TEXT DEFAULT '',
      status TEXT DEFAULT '未收付', remark TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pplan_contract ON payment_plan(contract_id);

    CREATE TABLE IF NOT EXISTS payment_record (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, plan_id TEXT DEFAULT '',
      amount REAL DEFAULT 0, pay_date TEXT NOT NULL, method TEXT DEFAULT '银行转账',
      voucher_path TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prec_contract ON payment_record(contract_id);
    CREATE INDEX IF NOT EXISTS idx_prec_plan ON payment_record(plan_id);

    CREATE TABLE IF NOT EXISTS approval_log (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, level INTEGER DEFAULT 1,
      action TEXT NOT NULL, operator TEXT DEFAULT '', comment TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_contract ON approval_log(contract_id);

    CREATE TABLE IF NOT EXISTS lifecycle_log (
      id TEXT PRIMARY KEY, contract_id TEXT DEFAULT '', contract_no TEXT DEFAULT '',
      event_type TEXT NOT NULL, target TEXT DEFAULT '', before_value TEXT DEFAULT '', after_value TEXT DEFAULT '',
      content TEXT DEFAULT '', operator TEXT DEFAULT '', source TEXT DEFAULT 'desktop', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_life_contract ON lifecycle_log(contract_id);
    CREATE INDEX IF NOT EXISTS idx_life_time ON lifecycle_log(created_at);

    CREATE TABLE IF NOT EXISTS dict_type (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, direction_scope TEXT DEFAULT '全部', sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_user (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL,
      is_super INTEGER DEFAULT 0, owner_name TEXT DEFAULT '',
      status TEXT DEFAULT '启用', remark TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_username ON app_user(username);
    CREATE TABLE IF NOT EXISTS user_session (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, last_active TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `)
}

/** 确保四个默认账号存在（新库/老库升级都调用；重复调用安全） */
function ensureDefaultUsers() {
  const defaults = [
    { username: 'admin', name: '超级管理员', role: 'admin', is_super: 1, owner_name: '', pwd: '123456', remark: '系统内置，不可删除' },
    { username: 'biz', name: '商务专员', role: 'biz', is_super: 0, owner_name: '', pwd: '123456', remark: '默认商务账号' },
    { username: 'pm', name: '项目经理', role: 'pm', is_super: 0, owner_name: '张伟', pwd: '123456', remark: '默认项目经理，仅看本人负责项目' },
    { username: 'finance', name: '财务专员', role: 'finance', is_super: 0, owner_name: '', pwd: '123456', remark: '默认财务账号，只读+登记收付款' },
  ]
  for (const u of defaults) {
    if (one('SELECT id FROM app_user WHERE username=?', [u.username])) continue
    const at = now()
    run(`INSERT INTO app_user (id,username,name,password_hash,role,is_super,owner_name,status,remark,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid('usr'), u.username, u.name, hashPassword(u.pwd), u.role, u.is_super, u.owner_name, '启用', u.remark, at, at])
  }
}

function seed() {
  if (!fs.existsSync(SEED_FILE)) return
  const s = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
  const ins = (table, cols, vals) => run(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals)
  for (const p of s.projects || []) ins('project',
    ['id','code','name','owner','status','start_date','end_date','remark','created_at','updated_at'],
    [p.id,p.code,p.name,p.owner||'',p.status||'进行中',p.start_date||'',p.end_date||'',p.remark||'',p.created_at||now(),p.updated_at||now()])
  for (const p of s.parties || []) ins('party',
    ['id','name','role','credit_code','contact','phone','email','bank','account','rating','blacklist','remark','created_at','updated_at'],
    [p.id,p.name,p.role||'客户',p.credit_code||'',p.contact||'',p.phone||'',p.email||'',p.bank||'',p.account||'',p.rating||'',p.blacklist?1:0,p.remark||'',now(),now()])
  for (const c of s.contracts || []) ins('contract',
    ['id','contract_no','title','direction','type','status','project_id','party_id','parent_id','our_entity','amount','currency','sign_date','start_date','end_date','auto_renew','terminate_note','owner','archived','remark','created_at','updated_at'],
    [c.id,c.contract_no,c.title,c.direction,c.type,c.status||'履约中',c.project_id||'',c.party_id||'',c.parent_id||'',c.our_entity||'',c.amount||0,c.currency||'CNY',c.sign_date||'',c.start_date||'',c.end_date||'',c.auto_renew?1:0,c.terminate_note||'',c.owner||'',c.archived?1:0,c.remark||'',now(),now()])
  for (const m of s.milestones || []) ins('milestone',
    ['id','contract_id','name','plan_date','done_date','status','owner','remark','created_at'],
    [m.id,m.contract_id,m.name,m.plan_date||'',m.done_date||'',m.status||'未开始',m.owner||'',m.remark||'',now()])
  for (const pp of s.payment_plans || []) ins('payment_plan',
    ['id','contract_id','direction','seq','plan_amount','plan_date','status','remark','created_at'],
    [pp.id,pp.contract_id,pp.direction,pp.seq||'',pp.plan_amount||0,pp.plan_date||'',pp.status||'未收付',pp.remark||'',now()])
  for (const pr of s.payment_records || []) ins('payment_record',
    ['id','contract_id','plan_id','amount','pay_date','method','voucher_path','remark','created_at'],
    [pr.id,pr.contract_id,pr.plan_id||'',pr.amount||0,pr.pay_date,pr.method||'银行转账',pr.voucher_path||'',pr.remark||'',now()])
  for (const d of s.dictTypes || []) ins('dict_type',['id','name','direction_scope','sort_order'],[d.id,d.name,d.direction_scope||'全部',d.sort_order||0])
  for (const [k, v] of Object.entries(s.settings || {})) setSetting(k, v)
  persist()
}

/** 参数化执行（写） */
function run(sql, params = []) {
  const stmt = db.prepare(sql)
  try { stmt.bind(params); stmt.step() } finally { stmt.free() }
}
/** 查询，返回对象数组 */
function all(sql, params = []) {
  const stmt = db.prepare(sql)
  const rows = []
  try { stmt.bind(params); while (stmt.step()) rows.push(stmt.getAsObject()) } finally { stmt.free() }
  return rows
}
function one(sql, params = []) { return all(sql, params)[0] || null }

/** 每次写事务结束后落盘为单文件 SQLite */
function persist() {
  ensureDirs()
  const bytes = db.export()
  const tmp = DB_FILE + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(bytes))
  fs.renameSync(tmp, DB_FILE)
}
function mutate(fn) { const r = fn(); persist(); return r }

function getSettings() {
  const out = { ...DEFAULT_SETTINGS }
  for (const row of all('SELECT key, value FROM settings')) {
    try { out[row.key] = JSON.parse(row.value) } catch (_) { out[row.key] = row.value }
  }
  return out
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)])
}

function getConfig() {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (_) {}
  const cfg = { ...DEFAULT_CONFIG, ...saved }
  if (!cfg.token) { cfg.token = Math.random().toString(36).slice(2, 8).toUpperCase(); saveConfig(cfg) }
  return cfg
}
function saveConfig(cfg) {
  ensureDirs()
  const next = { ...getConfigUnsafe(), ...cfg }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}
function getConfigUnsafe() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (_) { return {} } }

/** 前端一次性拉取的全量数据（数据量小，中小团队全量加载） */
function bootstrap() {
  // 带出项目/相对方名称与汇总，供台账列表直接展示（避免 N+1 请求）
  const projects = all('SELECT * FROM project ORDER BY created_at DESC, rowid DESC')
  const parties = all('SELECT * FROM party ORDER BY name, rowid')
  const pName = Object.fromEntries(projects.map((p) => [p.id, p.name]))
  const ptName = Object.fromEntries(parties.map((p) => [p.id, p.name]))
  const contracts = all('SELECT * FROM contract ORDER BY created_at DESC, rowid DESC').map((c) => {
    const plans = all('SELECT direction, plan_amount FROM payment_plan WHERE contract_id=?', [c.id])
    const recIn = one(`SELECT COALESCE(SUM(r.amount),0) AS n FROM payment_record r LEFT JOIN payment_plan p ON p.id=r.plan_id
      WHERE r.contract_id=? AND (p.direction='应收' OR p.id IS NULL)`, [c.id]).n
    const recOut = one(`SELECT COALESCE(SUM(r.amount),0) AS n FROM payment_record r JOIN payment_plan p ON p.id=r.plan_id
      WHERE r.contract_id=? AND p.direction='应付'`, [c.id]).n
    return {
      ...c,
      project_name: pName[c.project_id] || '',
      party_name: ptName[c.party_id] || '',
      summary: {
        planIn: plans.filter((p) => p.direction === '应收').reduce((s, p) => s + Number(p.plan_amount || 0), 0),
        planOut: plans.filter((p) => p.direction === '应付').reduce((s, p) => s + Number(p.plan_amount || 0), 0),
        received: recIn, paid: recOut,
      },
    }
  })
  return {
    contracts,
    projects,
    parties,
    files: all('SELECT * FROM contract_file ORDER BY created_at ASC'),
    milestones: all('SELECT * FROM milestone ORDER BY plan_date ASC'),
    paymentPlans: all('SELECT * FROM payment_plan ORDER BY created_at ASC'),
    paymentRecords: all('SELECT * FROM payment_record ORDER BY pay_date DESC'),
    approvalLogs: all('SELECT * FROM approval_log ORDER BY created_at DESC'),
    lifecycleLogs: all('SELECT * FROM lifecycle_log ORDER BY created_at DESC, rowid DESC'),
    dictTypes: all('SELECT * FROM dict_type ORDER BY sort_order, rowid'),
    settings: getSettings(),
    statuses: STATUS,
    directions: DIRECTION,
    allColumns: DEFAULT_SETTINGS.visibleColumns,
  }
}

/** 生命周期日志（只追加，业务层负责禁止修改/删除） */
function addLog({ contract_id = '', contract_no = '', event_type, target = '', before_value = '', after_value = '', content = '', operator = '商务', source = 'desktop' }) {
  run(`INSERT INTO lifecycle_log
    (id,contract_id,contract_no,event_type,target,before_value,after_value,content,operator,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uid('log'), contract_id, contract_no, event_type, target, String(before_value ?? ''), String(after_value ?? ''),
      content || '', operator || '商务', source || 'desktop', now()])
}

/** 生成合同编号：{前缀}{年份}{4位流水} */
function nextCode(direction) {
  const s = getSettings()
  const p = String(direction === '对内' ? (s.codePrefixIn || 'CG') : (s.codePrefixOut || 'XS')).toUpperCase()
  const year = String(new Date().getFullYear())
  const prefix = `${p}${year}`
  const rows = all('SELECT contract_no FROM contract WHERE contract_no LIKE ?', [`${prefix}%`])
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i')
  let max = 0
  for (const r of rows) { const m = re.exec(r.contract_no); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}
function codeExists(code, exceptId) {
  return !!one('SELECT id FROM contract WHERE UPPER(contract_no)=UPPER(?) AND id<>?', [String(code || '').trim(), exceptId || ''])
}

/** 合同文件目录（按编号，安全化） */
function contractFileDir(code) {
  const safe = String(code || 'unknown').replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '_')
  return path.join(MEDIA_DIR, safe)
}
function removeMediaFile(url) {
  if (!url || !url.startsWith('/media/')) return
  const target = path.resolve(MEDIA_DIR, decodeURIComponent(url.slice('/media/'.length).split('?')[0]))
  if (!target.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return
  try { fs.unlinkSync(target) } catch (_) {}
}

/** 敏感字段脱敏（后端兜底，前端也做展示层遮罩） */
function mask(value, keep = null) {
  const s = String(value ?? '')
  if (!s) return ''
  const k = keep == null ? Number(getSettings().maskKeep) || 4 : Number(keep)
  if (s.length <= k) return '*'.repeat(s.length)
  return '*'.repeat(s.length - k) + s.slice(-k)
}
function visible(value, field) {
  const s = getSettings()
  if (!s.sensitiveMask) return value
  if (['account', 'bank', 'credit_code', 'phone'].includes(field)) return mask(value)
  return value
}

function lanIPs() {
  const out = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push({ name, address: n.address })
    }
  }
  return out
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, MEDIA_DIR, CONFIG_FILE, DEFAULT_SETTINGS, STATUS, DIRECTION, ROLES, ROLE_LABEL,
  init, now, uid, run, all, one, persist, mutate, bootstrap, addLog,
  nextCode, codeExists, contractFileDir, removeMediaFile, mask, visible,
  getSettings, setSetting, getConfig, saveConfig, lanIPs,
  hashPassword, ensureDefaultUsers,
}
