<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { api, setSession, clearSession, getCurrentUser } from './api'
import {
  LIST_COLUMNS, STATUSES, DIRECTIONS, ROLE_LABEL, STATUS_META, exportContractsToExcel,
  exportLogsToExcel, exportPaymentsToExcel, toast, daysUntil, formatMoney,
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

const contracts = ref([]), projects = ref([]), parties = ref([])
const dictTypes = ref([]), settings = ref({}), dashboard = ref(null)
const view = ref('ledger') // ledger | board | project | party | user
const keyword = ref(''), direction = ref('全部'), status = ref('全部'), projectFilter = ref('全部')
const showArchived = ref(false)
const selectedId = ref('')
const dialog = ref(null)
const detail = ref(null)
const clock = ref('')
const currentUser = ref(getCurrentUser())
const loginReady = ref(false)
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
const selected = computed(() => contracts.value.find((c) => c.id === selectedId.value) || null)

async function load() {
  try {
    const [d, dash] = await Promise.all([api.bootstrap(), api.dashboard()])
    contracts.value = d.contracts; projects.value = d.projects; parties.value = d.parties
    dictTypes.value = d.dictTypes; settings.value = d.settings; dashboard.value = dash
    if (detail.value) {
      const fresh = d.contracts.find((c) => c.id === detail.value.id)
      if (fresh) detail.value = await api.getContract(fresh.id)
    }
  } catch (e) { toast(`数据加载失败：${e.message}`, 'error') }
}
function tick() { clock.value = new Date().toLocaleString('zh-CN', { hour12: false }) }

/** 登录成功：保存会话（reused=已有会话直接放行），随后加载数据 */
function onLoggedIn(user, reused = false) {
  currentUser.value = user
  loginReady.value = true
  if (view.value === 'user' && user.role !== 'admin') view.value = 'ledger'
  if (!reused) toast(`欢迎，${user.name}（${ROLE_LABEL[user.role] || user.role}）`, 'success')
  load()
  const q = new URLSearchParams(location.search)
  if (q.get('dialog') === 'settings') dialog.value = { name: 'settings', payload: { tab: q.get('tab') || 'dict' } }
}
/** 退出登录：清会话、清数据、回到登录页 */
async function onLogout() {
  try { await api.logout() } catch (_) {}
  clearSession()
  currentUser.value = null
  loginReady.value = false
  view.value = 'ledger'
  contracts.value = []; projects.value = []; parties.value = []; dashboard.value = null
  detail.value = null; dialog.value = null; selectedId.value = ''
  toast('已退出登录', 'info')
}

onMounted(async () => {
  tick(); timer = setInterval(tick, 1000)
  if (currentUser.value) onLoggedIn(currentUser.value, true)
})
onBeforeUnmount(() => { clearInterval(timer) })

function onSelect(id) { selectedId.value = id; openDetail({ id }) }
function openDetail(row) {
  const c = row || selected.value
  if (!c) return toast('请先选中一行合同', 'warn')
  api.getContract(c.id).then((fresh) => { detail.value = fresh }).catch((e) => toast(e.message, 'error'))
}
function openNew(prefill = {}) { dialog.value = { name: 'contract', payload: { model: null, prefill } } }
function openEdit(contract) {
  const c = contract || selected.value
  if (!c) return toast('请先选中一行合同', 'warn')
  dialog.value = { name: 'contract', payload: { model: c } }
}
function newContractFor(entity) {
  const isProject = view.value === 'project'
  openNew(isProject ? { project_id: entity.id } : { party_id: entity.id })
}
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
  exportContractsToExcel(filtered.value, settings.value.exportColumns, `合同台账_${new Date().toISOString().slice(0,10)}.xlsx`)
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
function onSettingsSaved(s) { settings.value = { ...settings.value, ...s }; dialog.value = null; load() }
</script>

<template>
  <div class="app-shell">
    <!-- 门禁：账号登录（权限由账号决定，无视角下拉） -->
    <LoginDialog v-if="!loginReady" @logged-in="onLoggedIn" />

    <template v-if="loginReady">
      <!-- 顶部栏 -->
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"><span>合</span></div>
          <h1>合同管理系统</h1>
        </div>
        <div class="top-status">
          <span class="current-account" :title="`${currentUser?.name}（${ROLE_LABEL[currentUser?.role] || currentUser?.role}）`">
            <span class="avatar">{{ (currentUser?.name || '?').slice(0, 1) }}</span>
            <b>{{ currentUser?.name }}</b>
            <span class="tag-cell tag-cyan">{{ ROLE_LABEL[currentUser?.role] || currentUser?.role }}</span>
          </span>
          <button class="btn ghost btn-sm" @click="onLogout" title="退出登录">退出</button>
          <span class="online"><span class="dot"></span>本机数据已连接</span>
          <span class="clock">{{ clock }}</span>
        </div>
      </header>

      <!-- 摘要 KPI -->
      <section class="kpi-strip">
        <div class="kpi"><label>合同总数</label><b>{{ dashboard?.total || 0 }}</b></div>
        <div class="kpi"><label>在签金额</label><b class="cyan">¥{{ formatMoney(dashboard?.totalAmount || 0, 0) }}</b></div>
        <div class="kpi"><label>履约中</label><b class="green">{{ dashboard?.inProgress || 0 }}</b></div>
        <div class="kpi"><label>本月到期</label><b class="amber">{{ dashboard?.soonCount || 0 }}</b></div>
        <div class="kpi"><label>已过期未处理</label><b class="red">{{ dashboard?.overdueCount || 0 }}</b></div>
        <div class="kpi"><label>应收未收</label><b class="amber">¥{{ formatMoney(dashboard?.finance?.remainIn || 0, 0) }}</b></div>
        <div class="kpi"><label>应付未付</label><b class="amber">¥{{ formatMoney(dashboard?.finance?.remainOut || 0, 0) }}</b></div>
        <div class="kpi"><label>回款率</label><b class="green">{{ dashboard?.finance?.receiveRate || 0 }}%</b></div>
      </section>

      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="view-switch">
          <button :class="{ active: view === 'ledger' }" @click="switchView('ledger')">合同台账</button>
          <button :class="{ active: view === 'board' }" @click="switchView('board')">看板</button>
          <button :class="{ active: view === 'project' }" @click="switchView('project')">项目</button>
          <button :class="{ active: view === 'party' }" @click="switchView('party')">相对方</button>
          <button v-if="isAdmin && multiRoleMode" :class="{ active: view === 'user' }" @click="switchView('user')">人员</button>
        </div>
        <span class="divider"></span>
        <template v-if="view === 'ledger'">
          <button v-if="canEdit" class="btn btn-primary" @click="openNew()">＋ 新增合同</button>
          <button v-if="canEdit" class="btn" @click="openEdit()">编辑</button>
          <button v-if="role === 'admin'" class="btn btn-danger" @click="selected && requestDelete(selected)">删除</button>
          <button v-if="canEdit" class="btn" @click="dialog = { name: 'import' }">导入</button>
          <button class="btn" @click="doExport">导出</button>
          <button class="btn" @click="doExportPayments">收付款导出</button>
          <button class="btn" @click="doExportLogs">日志导出</button>
          <span class="divider"></span>
          <label class="field-inline">方向<select v-model="direction"><option>全部</option><option v-for="d in DIRECTIONS" :key="d">{{ d }}</option></select></label>
          <label class="field-inline">状态<select v-model="status"><option>全部</option><option v-for="s in STATUSES" :key="s">{{ s }}</option></select></label>
          <label class="field-inline">项目<select v-model="projectFilter"><option value="全部">全部</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
          <label class="field-inline checkbox"><input v-model="showArchived" type="checkbox" /> 含归档</label>
          <span class="spacer"></span>
          <input v-model="keyword" class="search-input" type="text" placeholder="编号 / 名称 / 相对方 / 负责人…" @keyup.enter="() => {}" />
          <button class="btn btn-ghost" @click="resetFilter">重置</button>
          <button class="btn" @click="dialog = { name: 'settings', payload: { tab: 'dict' } }">设置</button>
        </template>
        <template v-else>
          <span class="spacer"></span>
          <button class="btn" @click="dialog = { name: 'settings', payload: { tab: 'dict' } }">设置</button>
        </template>
      </div>

      <!-- 主体 -->
      <main class="main-area">
        <!-- 台账视图 -->
        <div v-if="view === 'ledger'" class="ledger-view">
          <div class="table-summary">共 {{ filtered.length }} 份合同 · 合计金额 ¥{{ formatMoney(filtered.reduce((s,c)=>s+Number(c.amount||0),0), 0) }}</div>
          <ContractTable :rows="filtered" :columns="columns" :selected-id="selectedId" :role="role" :mask="mask"
            :remind-days="remindDays" @select="onSelect" @action="onTableAction" />
        </div>

        <!-- 看板视图 -->
        <div v-else-if="view === 'board'" class="board-view">
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
          :mask="mask" :can-edit="canEdit" @refresh="load" @new-contract="newContractFor" />

        <!-- 人员管理视图（仅管理员） -->
        <UserPanel v-else-if="view === 'user'" :current-user="currentUser" />
      </main>
    </template>

    <!-- 详情抽屉 -->
    <ContractDetail v-if="detail" :contract="detail" :role="role" :mask="mask" :remind-days="remindDays"
      @close="detail = null" @refresh="(f) => detail = f" @edit="(c) => { detail = null; openEdit(c) }"
      @status="(p) => requestStatus(p.row, p.status)" />

    <!-- 弹窗 -->
    <ContractDialog v-if="dialog?.name === 'contract'" :model="dialog.payload.model"
      :projects="projects" :parties="parties" :contracts="contracts" :dict-types="dictTypes" @saved="saved" @close="dialog = null" />
    <SettingsDialog v-if="dialog?.name === 'settings'" :settings="settings" :initial-tab="dialog.payload?.tab || 'dict'"
      @saved="onSettingsSaved" @close="dialog = null" />
    <ImportDialog v-if="dialog?.name === 'import'" @imported="load" @close="dialog = null" />
    <ConfirmDialog v-if="dialog?.name === 'delete'" title="删除合同" danger
      :message="`确定永久删除【${dialog.payload.row.contract_no}】${dialog.payload.row.title}？关联文件与流水将一并删除，不可恢复。`"
      confirm-text="确认删除" @cancel="dialog = null" @confirm="confirmDelete" />
    <ConfirmDialog v-if="dialog?.name === 'status'" :title="`流转为「${dialog.payload.status}」`"
      :message="`确定将【${dialog.payload.row.contract_no}】流转为「${dialog.payload.status}」？该变更将写入生命周期日志。`"
      confirm-text="确认" @cancel="dialog = null" @confirm="confirmStatus" />
    <ConfirmDialog v-if="dialog?.name === 'contract-actions'" :title="`合同操作：${dialog.payload.row.contract_no}`"
      :message="'请选择操作：归档（只读）或删除（不可恢复）。'" confirm-text="归档" @cancel="dialog = null"
      @confirm="doArchive(dialog.payload.row, 'archive')" />

    <ToastStack />
  </div>
</template>
