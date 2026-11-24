<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { api, licenseApi, setSession, clearSession, getCurrentUser } from './api'
import {
  LIST_COLUMNS, STATUSES, DIRECTIONS, ROLE_LABEL, STATUS_META, exportContractsToExcel,
  exportLogsToExcel, exportPaymentsToExcel, toast, daysUntil, formatMoney, downloadTemplate,
} from './utils'
import LoginDialog from './components/LoginDialog.vue'
import UserPanel from './components/UserPanel.vue'
import ToastStack from './components/ToastStack.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ContractTable from './components/ContractTable.vue'
import ContractDialog from './components/ContractDialog.vue'
import ContractDetail from './components/ContractDetail.vue'
import EntityPanel from './components/EntityPanel.vue'
import ChartsPanel from './components/ChartsPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import InvoicePanel from './components/InvoicePanel.vue'
import ForceChangePassword from './components/ForceChangePassword.vue'
import ActivationDialog from './components/ActivationDialog.vue'
import RecycleBin from './components/RecycleBin.vue'

const contracts = ref([]), projects = ref([]), parties = ref([])
const dictTypes = ref([]), dictCategories = ref([]), settings = ref({}), dashboard = ref(null)
const view = ref('ledger') // ledger | board | project | party | user
const keyword = ref(''), direction = ref('全部'), status = ref('全部'), projectFilter = ref('全部')
const showArchived = ref(false)
// V1.1：台账按项目分组 + 展开偏好（看板筛选直接复用 projectFilter，实现联动）
const groupByProject = ref(false)
const expandedGroups = ref(loadExpanded())
function loadExpanded() { try { return JSON.parse(localStorage.getItem('contractams-expanded-groups') || '[]') } catch (_) { return [] } }
function toggleGroup(pid) {
  const i = expandedGroups.value.indexOf(pid)
  if (i >= 0) expandedGroups.value.splice(i, 1); else expandedGroups.value.push(pid)
  try { localStorage.setItem('contractams-expanded-groups', JSON.stringify(expandedGroups.value)) } catch (_) {}
}
const selectedId = ref('')
const dialog = ref(null)
const showRecycle = ref(false) // 回收站弹窗
const detail = ref(null)
const clock = ref('')
const currentUser = ref(getCurrentUser())
const loginReady = ref(false)
const refreshing = ref(false)   // 右上角刷新按钮的加载态
const forceChange = ref(false)  // 首次登录强制改密弹窗
// 授权门禁：7 天试用 / 激活码（CAPTCHA_SYS）
const licenseChecking = ref(true)
const licenseOk = ref(false)
const licenseInfo = ref(null)
const licenseDialog = ref(false)
let timer = null

// 角色/归属由登录账号决定（不可用视角下拉切换）
const role = computed(() => currentUser.value?.role || 'guest')
const isAdmin = computed(() => role.value === 'admin')
// 多角色模式：关闭「仅超管登录」时才显示人员管理（当前简化为单超管）
const multiRoleMode = computed(() => settings.value.onlyAdminLogin === false)
const mask = computed(() => settings.value.sensitiveMask !== false)
const remindDays = computed(() => settings.value.remindDays || [30, 15, 7])
const columns = computed(() => {
  const keys = settings.value.visibleColumns?.length ? settings.value.visibleColumns : LIST_COLUMNS.map((c) => c.key)
  return keys.map((k) => LIST_COLUMNS.find((c) => c.key === k)).filter(Boolean)
})
const canEdit = computed(() => role.value === 'admin' || role.value === 'biz')

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return contracts.value.filter((c) => {
    if (c.archived && !showArchived.value) return false
    if (direction.value !== '全部' && c.direction !== direction.value) return false
    if (status.value !== '全部' && c.status !== status.value) return false
    if (projectFilter.value !== '全部' && c.project_id !== projectFilter.value) return false
    if (!kw) return true
    return [c.contract_no, c.title, c.type, c.owner, c.remark].some((v) => String(v ?? '').toLowerCase().includes(kw))
  })
})
// V1.1 台账按项目分组（先筛后组）
const groupedContracts = computed(() => {
  const map = new Map()
  for (const c of filtered.value) {
    const key = c.project_id || '__none__'
    if (!map.has(key)) map.set(key, {
      id: key, name: c.project_name || '未归属项目', rows: [],
      count: 0, amountOut: 0, amountIn: 0, remainIn: 0, remainOut: 0,
    })
    const g = map.get(key)
    g.rows.push(c); g.count++
    if (c.direction === '对外') g.amountOut += Number(c.amount || 0)
    else g.amountIn += Number(c.amount || 0)
    g.remainIn += Number(c.summary?.remainIn || 0)
    g.remainOut += Number(c.summary?.remainOut || 0)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
})
const selected = computed(() => contracts.value.find((c) => c.id === selectedId.value) || null)

async function loadDashboard() {
  try { dashboard.value = await api.dashboard(projectFilter.value === '全部' ? '' : projectFilter.value) }
  catch (e) { toast(`看板加载失败：${e.message}`, 'error') }
}
// 项目筛选联动看板（P0-2）
watch(projectFilter, () => loadDashboard())

async function load() {
  try {
    const [d, dash, cats] = await Promise.all([
      api.bootstrap(),
      api.dashboard(projectFilter.value === '全部' ? '' : projectFilter.value),
      api.dictCategories(),
    ])
    contracts.value = d.contracts; projects.value = d.projects; parties.value = d.parties
    dictTypes.value = d.dictTypes; dictCategories.value = cats.list || []
    settings.value = d.settings; dashboard.value = dash
    if (detail.value) {
      const fresh = d.contracts.find((c) => c.id === detail.value.id)
      if (fresh) detail.value = await api.getContract(fresh.id)
    }
  } catch (e) { toast(`数据加载失败：${e.message}`, 'error') }
}
/** 右上角刷新：重新拉取台账/看板/字典/设置，并给出反馈 */
async function refreshData() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await load()
    toast('数据已刷新', 'success')
  } catch (e) { toast(`刷新失败：${e.message}`, 'error') }
  finally { refreshing.value = false }
}
function tick() { clock.value = new Date().toLocaleString('zh-CN', { hour12: false }) }

/** 登录成功：保存会话（reused=已有会话直接放行），随后加载数据 */
function onLoggedIn(user, reused = false) {
  currentUser.value = user
  loginReady.value = true
  if (view.value === 'user' && user.role !== 'admin') view.value = 'ledger'
  if (!reused) toast(`欢迎，${user.name}（${ROLE_LABEL[user.role] || user.role}）`, 'success')
  load()
  // 首次登录（密码仍是初始 123456）强制弹改密窗，改完才放行
  forceChange.value = !!user.must_change_password
  if (forceChange.value) return
  const q = new URLSearchParams(location.search)
  if (q.get('dialog') === 'settings') dialog.value = { name: 'settings', payload: { tab: q.get('tab') || 'dict' } }
}
/** 强制改密完成：更新会话用户并继续后续加载 */
function onForceChanged(user) {
  forceChange.value = false
  currentUser.value = user
}
/** 退出登录：清会话、清数据、回到登录页 */
async function onLogout() {
  try { await api.logout() } catch (_) {}
  clearSession()
  currentUser.value = null
  loginReady.value = false
  forceChange.value = false
  view.value = 'ledger'
  contracts.value = []; projects.value = []; parties.value = []; dashboard.value = null
  detail.value = null; dialog.value = null; selectedId.value = ''
  toast('已退出登录', 'info')
}

/** 授权门禁：7 天试用内放行，到期后必须输入授权码激活 */
async function checkLicense() {
  licenseChecking.value = true
  try {
    const s = await licenseApi.status()
    licenseInfo.value = s
    licenseOk.value = !!s.activated
    if (s.inTrial) {
      // 试用提醒只提示一次/天，避免每次启动都弹 toast
      const key = 'contractams-trial-toast'
      const today = new Date().toDateString()
      if (localStorage.getItem(key) !== today) {
        toast(`试用期剩余 ${s.trial?.daysLeft || 7} 天，到期后需购买授权码激活`, 'info')
        try { localStorage.setItem(key, today) } catch (_) {}
      }
    }
  } catch (e) {
    licenseOk.value = false
    licenseInfo.value = { activated: false, message: e.message || '授权校验失败' }
  } finally {
    licenseChecking.value = false
  }
}
/** 激活成功：收起授权页，恢复进入 */
function onActivated(s) {
  licenseOk.value = true
  licenseInfo.value = s
  licenseDialog.value = false
  toast('激活成功，感谢您的支持', 'success')
}
/** 手动打开授权页（试用期内查看/购买授权） */
function openLicenseDialog() { licenseDialog.value = true }

onMounted(async () => {
  tick(); timer = setInterval(tick, 1000)
  await checkLicense()
  if (!licenseOk.value) return
  if (currentUser.value) onLoggedIn(currentUser.value, true)
})
onBeforeUnmount(() => { clearInterval(timer) })

function onSelect(id) { selectedId.value = id; openDetail({ id }) }
function openDetail(row) {
  const c = row || selected.value
  if (!c) return toast('请先选中一行合同', 'warn')
  api.getContract(c.id).then((fresh) => { detail.value = fresh }).catch((e) => toast(e.message, 'error'))
}
function openNew(prefill = {}) {
  // 预填（如从项目卡片建合同）：构造无 id 的 model，ContractDialog 会展开为新增表单
  const model = Object.keys(prefill).length
    ? { contract_no: '', title: '', direction: '对外', type: '销售', status: '草稿', project_id: '', party_id: '',
        parent_id: '', our_entity: '', amount: 0, currency: 'CNY', sign_date: '', start_date: '', end_date: '',
        auto_renew: false, terminate_note: '', owner: '', remark: '', ...prefill }
    : null
  dialog.value = { name: 'contract', payload: { model } }
}
function openEdit(contract) {
  const c = contract || selected.value
  if (!c) return toast('请先选中一行合同', 'warn')
  dialog.value = { name: 'contract', payload: { model: c } }
}
/** V1.1 补充协议：从主合同继承字段，编号留空由后端按 {主编号}-n 生成 */
function openSupplement(contract) {
  const c = contract || selected.value
  if (!c) return toast('请先选中一份主合同', 'warn')
  if (c.parent_id) return toast('补充协议下不能再创建补充协议', 'warn')
  detail.value = null
  dialog.value = { name: 'contract', payload: { model: {
    contract_no: '', title: `${c.title}-补充协议`, direction: c.direction, type: c.type,
    status: '草稿', project_id: c.project_id || '', party_id: c.party_id, parent_id: c.id,
    our_entity: c.our_entity || '', amount: 0, currency: c.currency || 'CNY',
    sign_date: '', start_date: '', end_date: '', auto_renew: false, terminate_note: '',
    owner: c.owner || '', remark: '',
  } } }
}
function newContractFor(entity) {
  const isProject = view.value === 'project'
  openNew(isProject ? { project_id: entity.id } : { party_id: entity.id })
}
// V1.1 项目卡片快捷入口：按项目下钻台账 / 看板
function viewInLedger(project) { projectFilter.value = project.id; view.value = 'ledger' }
function viewInBoard(project) { projectFilter.value = project.id; view.value = 'board' }
async function saved() { dialog.value = null; detail.value = null; await load() }
function resetFilter() { keyword.value = ''; direction.value = '全部'; status.value = '全部'; projectFilter.value = '全部'; showArchived.value = false }

function onTableAction({ type, row }) {
  if (type === 'edit') return openEdit(row)
  if (type === 'logs') return openDetail(row)
  if (type === 'unarchive') return doArchive(row, 'unarchive')
  if (type === 'more') dialog.value = { name: 'contract-actions', payload: { row } }
}
async function doArchive(row, action) {
  if (action === 'unarchive' && role.value !== 'admin') return toast('仅管理员可解档', 'error')
  try { await api.archive(row.id, action); toast(action === 'archive' ? '已归档' : '已解档', 'success'); dialog.value = null; await load() }
  catch (e) { toast(e.message, 'error') }
}
function requestStatus(row, st) {
  dialog.value = { name: 'status', payload: { row, status: st } }
}
async function confirmStatus() {
  const { row, status: st } = dialog.value.payload
  try {
    const payload = { status: st, operator: role.value }
    if (st === '已完成') {
      const unfinished = (row.summary?.msTotal || 0) - (row.summary?.msDone || 0)
      if (unfinished > 0) {
        const ok = window.confirm(`还有 ${unfinished} 个履约节点未完成，仍要标记完成吗？`)
        if (!ok) return
        payload.force = true
      }
    }
    await api.changeStatus(row.id, payload)
    toast(`状态已流转为「${st}」`, 'success'); dialog.value = null; detail.value = null; await load()
  } catch (e) { toast(e.message, 'error') }
}
function requestDelete(row) { dialog.value = { name: 'delete', payload: { row } } }
async function confirmDelete() {
  const row = dialog.value.payload.row
  try { await api.deleteContract(row.id, { operator: role.value, password: dialog.value.payload.password })
    toast('合同已删除', 'success'); selectedId.value = ''; detail.value = null; dialog.value = null; await load() }
  catch (e) { toast(e.message, 'error') }
}

function doExport() {
  if (!filtered.value.length) return toast('当前视图无可导出数据', 'warn')
  exportContractsToExcel(filtered.value, settings.value.exportColumns, `合同台账_${new Date().toISOString().slice(0,10)}.xlsx`, { mask: settings.value.exportMask, labels: settings.value.fieldLabels || {} })
  toast(`已导出 ${filtered.value.length} 条合同`, 'success')
}
async function doExportLogs() {
  try { const d = await api.logs(); exportLogsToExcel(d.list, `生命周期日志_${new Date().toISOString().slice(0,10)}.xlsx`); toast('日志已导出', 'success') }
  catch (e) { toast(e.message, 'error') }
}
function doExportPayments() {
  exportPaymentsToExcel(filtered.value, `收付款汇总_${new Date().toISOString().slice(0,10)}.xlsx`)
  toast('收付款汇总已导出', 'success')
}
function switchView(v) { view.value = v }
// V1.2（4.9）：看板金额下钻到台账并带方向筛选
function drillOverview(which) {
  direction.value = which === 'income' ? '对外' : which === 'expense' ? '对内' : '全部'
  status.value = '全部'
  view.value = 'ledger'
}
function onSettingsSaved(s) { settings.value = { ...settings.value, ...s }; dialog.value = null; load() }
/** 清空业务数据后：关弹窗、清选中、回台账并重新加载 */
async function onDataCleared() {
  dialog.value = null
  detail.value = null
  selectedId.value = ''
  projectFilter.value = '全部'
  view.value = 'ledger'
  await load()
}
</script>

<template>
  <div class="app-shell">
    <!-- 授权门禁：7 天试用内放行，到期后全屏授权页（不可关闭） -->
    <ActivationDialog
      v-if="!licenseChecking && !licenseOk"
      :initial="licenseInfo"
      @activated="onActivated"
    />
    <!-- 试用期内主动查看/购买授权：可关闭 -->
    <ActivationDialog
      v-if="licenseDialog && licenseOk"
      :initial="licenseInfo"
      :closable="true"
      @activated="onActivated"
      @close="licenseDialog = false"
    />
    <template v-if="licenseOk">
    <!-- 门禁：账号登录（权限由账号决定，无视角下拉） -->
    <LoginDialog v-if="!loginReady" @logged-in="onLoggedIn" />
    <!-- 首次登录强制改密：不可取消，覆盖整个界面 -->
    <ForceChangePassword v-if="forceChange" @done="onForceChanged" />

    <template v-if="loginReady">
      <!-- 顶部栏 -->
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"><span>合</span></div>
          <h1>合同管理系统</h1>
        </div>
        <div class="top-status">
          <button v-if="licenseInfo?.inTrial" class="trial-chip" @click="openLicenseDialog" title="查看授权 / 购买正式版">
            试用剩余 {{ licenseInfo.trial?.daysLeft }} 天
          </button>
          <span class="online"><span class="dot"></span>本机数据已连接</span>
          <span class="clock">{{ clock }}</span>
          <span class="current-account" :title="`${currentUser?.name}（${ROLE_LABEL[currentUser?.role] || currentUser?.role}）`">
            <span class="avatar">{{ (currentUser?.name || '?').slice(0, 1) }}</span>
            <b>{{ currentUser?.name }}</b>
            <span class="tag-cell tag-cyan">{{ ROLE_LABEL[currentUser?.role] || currentUser?.role }}</span>
            <span v-if="role === 'viewer'" class="tag-cell tag-amber" title="只读账号：可浏览，不可修改任何数据">只读视图</span>
          </span>
          <button class="icon-btn top-icon-btn refresh-btn" :class="{ spinning: refreshing }" :disabled="refreshing" @click="refreshData" title="刷新数据" aria-label="刷新数据">
            <svg class="top-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button class="icon-btn top-icon-btn" @click="dialog = { name: 'settings', payload: { tab: 'dict' } }" title="系统设置" aria-label="系统设置">
            <svg class="top-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button class="btn ghost btn-sm" @click="onLogout" title="退出登录">退出</button>
        </div>
      </header>

      <!-- V1.2（4.9）收支全景：合同金额 → 已收/已付 → 差额 -->
      <section class="kpi-strip overview-strip">
        <div class="kpi clickable" title="方向=对外的全部合同金额；点击下钻到台账" @click="drillOverview('income')"><label>收入合同</label><b class="cyan">¥{{ formatMoney(dashboard?.overview?.incomeAmount || 0, 0) }}</b><small>{{ dashboard?.overview?.countIn || 0 }} 份</small></div>
        <div class="kpi" title="合同款性质的已收合计（无期次流水按合同方向归属）"><label>已收</label><b class="green">¥{{ formatMoney(dashboard?.overview?.received || 0, 0) }}</b></div>
        <div class="kpi clickable" title="方向=对内的全部合同金额；点击下钻到台账" @click="drillOverview('expense')"><label>支出合同</label><b class="red">¥{{ formatMoney(dashboard?.overview?.expenseAmount || 0, 0) }}</b><small>{{ dashboard?.overview?.countOut || 0 }} 份</small></div>
        <div class="kpi" title="合同款性质的已付合计（无期次流水按合同方向归属）"><label>已付</label><b class="green">¥{{ formatMoney(dashboard?.overview?.paid || 0, 0) }}</b></div>
        <div class="kpi" title="收入合同金额 − 支出合同金额（签订口径）"><label>合同差额</label><b :class="(dashboard?.overview?.netSigned || 0) >= 0 ? 'cyan' : 'red'">¥{{ formatMoney(dashboard?.overview?.netSigned || 0, 0) }}</b></div>
        <div class="kpi" title="已收 − 已付（现金流口径）"><label>现金净额</label><b :class="(dashboard?.overview?.netCash || 0) >= 0 ? 'cyan' : 'red'">¥{{ formatMoney(dashboard?.overview?.netCash || 0, 0) }}</b></div>
      </section>
      <!-- 摘要 KPI -->
      <section class="kpi-strip">
        <div class="kpi"><label>合同总数</label><b>{{ dashboard?.total || 0 }}</b></div>
        <div class="kpi" title="方向=对外，状态=已签署/履约中"><label>在签收入</label><b class="cyan">¥{{ formatMoney(dashboard?.inSignIncome || 0, 0) }}</b></div>
        <div class="kpi" title="方向=对内，状态=已签署/履约中"><label>在签支出</label><b class="red">¥{{ formatMoney(dashboard?.inSignExpense || 0, 0) }}</b></div>
        <div class="kpi" v-if="settings.showNetAmount" title="在签收入 − 在签支出"><label>在签净额</label><b class="cyan">¥{{ formatMoney(dashboard?.inSignNet || 0, 0) }}</b></div>
        <div class="kpi"><label>履约中</label><b class="green">{{ dashboard?.inProgress || 0 }}</b></div>
        <div class="kpi"><label>本月到期</label><b class="amber">{{ dashboard?.soonCount || 0 }}</b></div>
        <div class="kpi"><label>已过期未处理</label><b class="red">{{ dashboard?.overdueCount || 0 }}</b></div>
        <div class="kpi"><label>应收未收</label><b class="amber">¥{{ formatMoney(dashboard?.finance?.remainIn || 0, 0) }}</b></div>
        <div class="kpi"><label>回款率</label><b class="green">{{ dashboard?.finance?.receiveRate || 0 }}%</b></div>
      </section>
      <div class="kpi-note">口径：金额均为{{ settings.amountBasis || '含税' }} · 收支全景按全部合同方向统计（点击金额下钻台账）· 在签收入/支出按「对外/对内 且 已签署/履约中」统计 · 已收/已付仅含合同款（罚息类不计）</div>

      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="view-switch">
          <button :class="{ active: view === 'ledger' }" @click="switchView('ledger')">合同台账</button>
          <button :class="{ active: view === 'board' }" @click="switchView('board')">看板</button>
          <button :class="{ active: view === 'project' }" @click="switchView('project')">项目</button>
          <button :class="{ active: view === 'party' }" @click="switchView('party')">相对方</button>
          <button :class="{ active: view === 'invoice' }" @click="switchView('invoice')">发票</button>
          <button v-if="isAdmin && multiRoleMode" :class="{ active: view === 'user' }" @click="switchView('user')">人员</button>
        </div>
        <span class="divider"></span>
        <template v-if="view === 'ledger'">
          <button v-if="canEdit" class="btn btn-primary" @click="openNew()">＋ 新增合同</button>
          <button v-if="canEdit" class="btn" @click="openEdit()">编辑</button>
          <button v-if="canEdit" class="btn" @click="selected && openSupplement(selected)">补充协议</button>
          <button v-if="role === 'admin'" class="btn btn-danger" @click="selected && requestDelete(selected)">删除</button>
          <button v-if="canEdit" class="btn" @click="dialog = { name: 'import' }">导入</button>
          <button class="btn" @click="downloadTemplate">下载模板</button>
          <button class="btn" @click="doExport">导出</button>
          <button class="btn" @click="doExportPayments">收付款导出</button>
          <button class="btn" @click="doExportLogs">日志导出</button>
          <button v-if="isAdmin" class="btn" @click="showRecycle = true">回收站</button>
          <span class="divider"></span>
          <label class="field-inline">方向<select v-model="direction"><option>全部</option><option v-for="d in DIRECTIONS" :key="d">{{ d }}</option></select></label>
          <label class="field-inline">状态<select v-model="status"><option>全部</option><option v-for="s in STATUSES" :key="s">{{ s }}</option></select></label>
          <label class="field-inline">项目<select v-model="projectFilter"><option value="全部">全部</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
          <label class="field-inline checkbox"><input v-model="groupByProject" type="checkbox" /> 按项目分组</label>
          <label class="field-inline checkbox"><input v-model="showArchived" type="checkbox" /> 含归档</label>
          <span class="spacer"></span>
          <input v-model="keyword" class="search-input" type="text" placeholder="编号 / 名称 / 相对方 / 负责人…" @keyup.enter="() => {}" />
          <button class="btn btn-ghost" @click="resetFilter">重置</button>
        </template>
        <template v-else>
          <span class="spacer"></span>
        </template>
      </div>

      <!-- 主体 -->
      <main class="main-area">
        <!-- 台账视图 -->
        <div v-if="view === 'ledger'" class="ledger-view">
          <div class="table-summary">共 {{ filtered.length }} 份合同 · 合计金额 ¥{{ formatMoney(filtered.reduce((s,c)=>s+Number(c.amount||0),0), 0) }}</div>
          <!-- V1.1 按项目分组二级台账 -->
          <template v-if="groupByProject">
            <div v-for="g in groupedContracts" :key="g.id" class="proj-group">
              <div class="proj-group-head" @click="toggleGroup(g.id)">
                <span class="proj-group-toggle">{{ expandedGroups.includes(g.id) ? '▾' : '▸' }}</span>
                <b>{{ g.name }}</b>
                <span>{{ g.count }} 份</span>
                <span>对外 ¥{{ formatMoney(g.amountOut, 0) }}</span>
                <span>对内 ¥{{ formatMoney(g.amountIn, 0) }}</span>
                <span class="amber">应收未收 ¥{{ formatMoney(g.remainIn, 0) }}</span>
                <span class="amber">应付未付 ¥{{ formatMoney(g.remainOut, 0) }}</span>
              </div>
              <div v-if="expandedGroups.includes(g.id)" class="proj-group-body">
                <ContractTable :rows="g.rows" :columns="columns" :selected-id="selectedId" :role="role" :mask="mask"
                  :remind-days="remindDays" :field-labels="settings.fieldLabels || {}" @select="onSelect" @action="onTableAction" />
              </div>
            </div>
            <div v-if="!groupedContracts.length" class="empty-row">无合同数据</div>
          </template>
          <ContractTable v-else :rows="filtered" :columns="columns" :selected-id="selectedId" :role="role" :mask="mask"
            :remind-days="remindDays" :field-labels="settings.fieldLabels || {}" @select="onSelect" @action="onTableAction" />
        </div>

        <!-- 看板视图 -->
        <div v-else-if="view === 'board'" class="board-view">
          <div v-if="projectFilter !== '全部'" class="board-filter-note">当前看板按项目「{{ projects.find(p => p.id === projectFilter)?.name || '未归属项目' }}」统计 · <a href="javascript:;" @click="projectFilter = '全部'">查看全部</a></div>
          <div v-if="dashboard?.penalties" class="board-filter-note">违约金/罚息等其它收支合计：¥{{ formatMoney(dashboard.penalties, 0) }}（不计入回款率）</div>
          <ChartsPanel :dashboard="dashboard" />
          <div class="board-lists">
            <div class="board-card">
              <h3>即将到期 Top 10</h3>
              <div v-for="c in dashboard?.soon || []" :key="c.id" class="board-row" @click="openDetail({ id: c.id })">
                <span>{{ c.contract_no }}</span><span class="grow">{{ c.title }}</span><span class="tag-cell tag-amber">{{ c.days }} 天</span>
              </div>
              <div v-if="!dashboard?.soon?.length" class="empty-row">无即将到期合同</div>
            </div>
            <div class="board-card">
              <h3>已过期未处理 Top 10</h3>
              <div v-for="c in dashboard?.overdue || []" :key="c.id" class="board-row" @click="openDetail({ id: c.id })">
                <span>{{ c.contract_no }}</span><span class="grow">{{ c.title }}</span><span class="tag-cell tag-red">逾期 {{ -c.days }} 天</span>
              </div>
              <div v-if="!dashboard?.overdue?.length" class="empty-row">无逾期合同</div>
            </div>
          </div>
        </div>

        <!-- 项目 / 相对方视图 -->
        <EntityPanel v-else-if="view === 'project' || view === 'party'" :mode="view" :projects="projects" :parties="parties" :contracts="contracts"
          :mask="mask" :can-edit="canEdit" @refresh="load" @new-contract="newContractFor"
          @view-in-ledger="viewInLedger" @view-in-board="viewInBoard" />

        <!-- 发票列表（V1.1） -->
        <InvoicePanel v-else-if="view === 'invoice'" mode="global" :contracts="contracts" :can-edit="canEdit" />

        <!-- 人员管理视图（仅管理员） -->
        <UserPanel v-else-if="view === 'user'" :current-user="currentUser" />
      </main>
    </template>

    <!-- 详情抽屉 -->
    <ContractDetail v-if="detail" :contract="detail" :contracts="contracts" :role="role" :mask="mask" :remind-days="remindDays"
      :max-file-m-b="settings.maxFileSizeMB || 200"
      @close="detail = null" @refresh="(f) => detail = f" @edit="(c) => { detail = null; openEdit(c) }"
      @supplement="(c) => openSupplement(c)" @status="(p) => requestStatus(p.row, p.status)" />

    <!-- 弹窗 -->
    <ContractDialog v-if="dialog?.name === 'contract'" :model="dialog.payload.model"
      :projects="projects" :parties="parties" :contracts="contracts" :dict-types="dictTypes"
      :dict-categories="dictCategories" @saved="saved" @close="dialog = null" />
    <SettingsDialog v-if="dialog?.name === 'settings'" :settings="settings" :initial-tab="dialog.payload?.tab || 'dict'"
      :role="role" @saved="onSettingsSaved" @cleared="onDataCleared" @close="dialog = null" />
    <ImportDialog v-if="dialog?.name === 'import'" @imported="load" @close="dialog = null" />
    <ConfirmDialog v-if="dialog?.name === 'delete'" title="删除合同" danger
      :message="`确定删除【${dialog.payload.row.contract_no}】${dialog.payload.row.title}？合同将移入回收站，附件文件保留、30 天内可原样恢复；只有「彻底删除」才会移除附件。`"
      confirm-text="移入回收站" @cancel="dialog = null" @confirm="confirmDelete" />
    <ConfirmDialog v-if="dialog?.name === 'status'" :title="`流转为「${dialog.payload.status}」`"
      :message="`确定将【${dialog.payload.row.contract_no}】流转为「${dialog.payload.status}」？该变更将写入生命周期日志。`"
      confirm-text="确认" @cancel="dialog = null" @confirm="confirmStatus" />
    <ConfirmDialog v-if="dialog?.name === 'contract-actions'" :title="`合同操作：${dialog.payload.row.contract_no}`"
      :message="'请选择操作：归档（只读）或删除（不可恢复）。'" confirm-text="归档" @cancel="dialog = null"
      @confirm="doArchive(dialog.payload.row, 'archive')" />

    </template>
    <RecycleBin v-if="showRecycle" @close="showRecycle = false" @restored="load" />
    <ToastStack />
  </div>
</template>
