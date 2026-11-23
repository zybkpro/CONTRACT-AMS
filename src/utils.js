import { reactive } from 'vue'
import * as XLSX from 'xlsx'

/* ---------------- 全局轻提示 ---------------- */
export const toasts = reactive([])
let toastSeq = 0
export function toast(text, type = 'info', duration = 3400) {
  const id = ++toastSeq
  toasts.push({ id, text, type })
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, duration)
}

/* ---------------- 常量 ---------------- */
export const DIRECTIONS = ['对内', '对外']
export const STATUSES = ['草稿', '审批中', '已驳回', '已签署', '履约中', '已完成', '已终止', '已归档']
export const STATUS_META = {
  草稿: { tag: 'tag-gray', color: '#8aa2b5' },
  审批中: { tag: 'tag-amber', color: '#ffbe4d' },
  已驳回: { tag: 'tag-red', color: '#ff6b6b' },
  已签署: { tag: 'tag-blue', color: '#3fd3ff' },
  履约中: { tag: 'tag-green', color: '#3ce0a5' },
  已完成: { tag: 'tag-blue', color: '#2f7cf6' },
  已终止: { tag: 'tag-pink', color: '#ff8fa3' },
  已归档: { tag: 'tag-gray', color: '#6f8496' },
}
export const DIRECTION_META = {
  对内: { tag: 'tag-amber', color: '#ffbe4d' },
  对外: { tag: 'tag-cyan', color: '#3fd3ff' },
}
export const CHART_COLORS = ['#3fd3ff', '#2f7cf6', '#3ce0a5', '#ffbe4d', '#ff8fa3', '#a58bff', '#4dd6c1', '#ff9f6e']
export const ROLE_LABEL = { admin: '管理员', biz: '商务', pm: '项目经理', finance: '财务' }

export const LIST_COLUMNS = [
  { key: 'contract_no', label: '合同编号', width: 128 },
  { key: 'title', label: '合同名称*', width: 210 },
  { key: 'direction', label: '方向*', width: 72, align: 'center' },
  { key: 'type', label: '类型', width: 100 },
  { key: 'status', label: '状态*', width: 88, align: 'center' },
  { key: 'project_name', label: '项目', width: 130 },
  { key: 'party_name', label: '相对方*', width: 160 },
  { key: 'amount', label: '金额', width: 108, align: 'right' },
  { key: 'sign_date', label: '签订日', width: 104 },
  { key: 'end_date', label: '到期日', width: 104 },
  { key: 'owner', label: '负责人', width: 86 },
]
export const CONFIGURABLE_COLUMNS = LIST_COLUMNS

export const EXPORT_FIELDS = [
  { key: 'contract_no', label: '合同编号' },
  { key: 'title', label: '合同名称' },
  { key: 'direction', label: '方向' },
  { key: 'type', label: '类型' },
  { key: 'status', label: '状态' },
  { key: 'project_name', label: '项目' },
  { key: 'party_name', label: '相对方' },
  { key: 'our_entity', label: '我方主体' },
  { key: 'amount', label: '金额' },
  { key: 'currency', label: '币种' },
  { key: 'sign_date', label: '签订日' },
  { key: 'start_date', label: '开始日' },
  { key: 'end_date', label: '结束日' },
  { key: 'owner', label: '负责人' },
  { key: 'remark', label: '备注' },
]

/* ---------------- 工具 ---------------- */
export function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export function formatMoney(v, digits = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) return (0).toFixed(digits)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
export function maskValue(value, keep = 4) {
  const s = String(value ?? '')
  if (!s) return ''
  if (s.length <= keep) return '*'.repeat(s.length)
  return '*'.repeat(s.length - keep) + s.slice(-keep)
}
/** 到期天数：负数为已过期 */
export function daysUntil(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const t = new Date(`${dateStr}T00:00:00`).getTime()
  const todayT = new Date(today() + 'T00:00:00').getTime()
  return Math.round((t - todayT) / 86400000)
}
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}
export function normalizeDate(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  let s = String(v).trim()
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split(/[-/]/)
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const parsed = XLSX.SSF.parse_date_code(Number(s))
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
  }
  return ''
}

/* ---------------- Excel ---------------- */
function writeBook(aoa, sheetName, filename, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, filename, { bookType: 'xlsx' })
}

export function exportContractsToExcel(contracts, columnKeys, filename = '合同台账.xlsx', opts = {}) {
  const keys = columnKeys || EXPORT_FIELDS.map((f) => f.key)
  const fields = keys.map((k) => EXPORT_FIELDS.find((f) => f.key === k)).filter(Boolean)
  const header = fields.map((f) => opts.labels?.[f.key] || f.label)
  const maskKeys = opts.mask ? ['party_name'] : []
  const rows = contracts.map((c) => fields.map((f) => {
    if (f.key === 'amount') return Number(c.amount) || 0
    if (maskKeys.includes(f.key)) return c[f.key] || ''
    return c[f.key] == null ? '' : c[f.key]
  }))
  writeBook([header, ...rows], '合同台账', filename, header.map((h) => Math.max(12, h.length * 2 + 4)))
}

export function exportLogsToExcel(logs, filename = '生命周期日志.xlsx') {
  const header = ['时间', '事件类型', '合同编号', '字段', '变更前', '变更后', '摘要', '操作人', '来源']
  const rows = logs.map((l) => [l.created_at, l.event_type, l.contract_no, l.target || '', l.before_value || '',
    l.after_value || '', l.content, l.operator || '', l.source || ''])
  writeBook([header, ...rows], '日志', filename, [20, 14, 16, 14, 22, 22, 60, 12, 12])
}

export function exportPaymentsToExcel(contracts, filename = '收付款汇总.xlsx') {
  const header = ['合同编号', '合同名称', '方向', '合同金额', '计划应收', '计划应付', '已收', '已付', '未收', '未付']
  const rows = contracts.map((c) => {
    const s = c.summary || {}
    return [c.contract_no, c.title, c.direction, Number(c.amount) || 0, s.planIn || 0, s.planOut || 0,
      s.received || 0, s.paid || 0, s.remainIn || 0, s.remainOut || 0]
  })
  writeBook([header, ...rows], '收付款', filename, [16, 30, 8, 14, 14, 14, 12, 12, 12, 12])
}

export function exportInvoicesToExcel(invoices, filename = '发票登记.xlsx') {
  const header = ['发票号码', '发票代码', '合同编号', '票种方向', '发票类型', '开票日期', '不含税金额', '税额', '价税合计', '税率', '销方', '购方', '状态', '备注']
  const rows = invoices.map((i) => [i.invoice_no, i.invoice_code || '', i.contract_no || '', i.direction,
    i.invoice_type, i.invoice_date, Number(i.amount_ex_tax) || 0, Number(i.tax_amount) || 0,
    Number(i.amount_incl_tax) || 0, i.tax_rate || 0, i.seller_name || '', i.buyer_name || '', i.status, i.remark || ''])
  writeBook([header, ...rows], '发票', filename, [18, 18, 16, 10, 10, 14, 14, 12, 14, 8, 24, 24, 10, 30])
}

/** 解析导入的合同 Excel（首行为表头） */
export function parseContractImport(aoa) {
  if (!aoa.length) return []
  const header = aoa[0].map((h) => String(h || '').trim())
  const map = { '合同编号': 'contract_no', '合同名称': 'title', '合同名称*': 'title', '方向': 'direction',
    '类型': 'type', '状态': 'status', '项目': 'project_name', '相对方': 'party_name', '相对方*': 'party_name',
    '我方主体': 'our_entity', '金额': 'amount', '币种': 'currency', '签订日': 'sign_date', '开始日': 'start_date',
    '结束日': 'end_date', '负责人': 'owner', '备注': 'remark', '自动续约': 'auto_renew' }
  return aoa.slice(1).filter((r) => r.some((v) => v != null && String(v).trim() !== '')).map((r, i) => {
    const obj = { __rowNo: i + 2 }
    header.forEach((h, j) => {
      const k = map[h]
      if (!k) return
      let v = r[j]
      if (k === 'sign_date' || k === 'start_date' || k === 'end_date') v = normalizeDate(v)
      if (k === 'amount') v = Number(String(v ?? '').replace(/[,¥\s]/g, '')) || 0
      if (k === 'auto_renew') v = ['是', '1', 1, true].includes(v)
      obj[k] = v
    })
    return obj
  })
}

export function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        resolve(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }))
      } catch (e) { reject(new Error('Excel 解析失败：' + e.message)) }
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsArrayBuffer(file)
  })
}

export function downloadTemplate() {
  const header = EXPORT_FIELDS.filter((f) => !['我方主体', '币种', '备注'].includes(f.label)).map((f) => f.label)
  const sample1 = ['XS20260010', '示例销售合同', '对外', '销售', '草稿', '示例项目', '示例客户', 100000, 'CNY', today(), today(), '', '张伟']
  const sample2 = ['CG20260010', '示例采购合同', '对内', '采购', '草稿', '示例项目', '示例供应商', 50000, 'CNY', today(), today(), '', '李娜']
  const pick = (row) => header.map((h) => {
    const idx = EXPORT_FIELDS.findIndex((f) => f.label === h)
    return row[idx] ?? ''
  })
  writeBook([header, pick(sample1), pick(sample2)], '合同导入模板', '合同导入模板.xlsx', header.map((h) => Math.max(12, h.length * 2 + 4)))
}
