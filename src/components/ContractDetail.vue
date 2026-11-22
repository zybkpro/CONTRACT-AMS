<script setup>
import { ref, computed, watch } from 'vue'
import { api, mediaUrl, downloadUrl, isDesktop } from '../api'
import { toast, today, fileToDataURL, STATUS_META, DIRECTION_META, formatMoney, daysUntil, maskValue } from '../utils'
import HistoryTab from './detail/HistoryTab.vue'

const props = defineProps({
  contract: { type: Object, default: null },
  role: { type: String, default: 'admin' },
  mask: { type: Boolean, default: true },
  remindDays: { type: Array, default: () => [30, 15, 7] },
})
const emit = defineEmits(['close', 'refresh', 'edit', 'status', 'approve'])

const tab = ref('base')
const busy = ref(false)

// 文件
const fileInput = ref(null)
const changeNote = ref('')
const uploadMain = ref(false)
// 履约
const msForm = ref({ name: '', plan_date: '', owner: '', remark: '' })
// 收付款
const ppForm = ref({ direction: '应收', seq: '', plan_amount: 0, plan_date: '', remark: '' })
const prForm = ref({ plan_id: '', amount: 0, pay_date: today(), method: '银行转账', remark: '' })
// 审批
const approveForm = ref({ action: 'approve', comment: '', level: 1 })

const canEdit = computed(() => props.role === 'admin' || props.role === 'biz')
const canFinance = computed(() => props.role === 'admin' || props.role === 'biz' || props.role === 'finance')
const canApprove = computed(() => props.role === 'admin' || props.role === 'biz')

watch(() => props.contract?.id, () => { tab.value = 'base' })

function dueInfo() {
  if (!props.contract) return null
  const d = daysUntil(props.contract.end_date)
  if (d === null) return null
  if (d < 0) return { text: `已过期 ${-d} 天`, cls: 'due-over' }
  if (d <= Math.max(30, ...props.remindDays)) return { text: `${d} 天后到期`, cls: 'due-soon' }
  return { text: `${d} 天后到期`, cls: '' }
}

async function refreshDetail() {
  if (!props.contract) return
  try { const fresh = await api.getContract(props.contract.id); emit('refresh', fresh) } catch (e) { toast(e.message, 'error') }
}

/* ---------- 文件 ---------- */
async function onPickFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (file.size > 50 * 1024 * 1024) { toast('单文件不能超过 50MB', 'error'); return }
  busy.value = true
  try {
    const dataUrl = await fileToDataURL(file)
    await api.uploadFile(props.contract.id, { fileName: file.name, dataUrl, isMain: uploadMain.value, version: 0, changeNote: changeNote.value, operator: props.role })
    toast('文件已上传', 'success'); changeNote.value = ''; e.target.value = ''; await refreshDetail()
  } catch (err) { toast(err.message, 'error') } finally { busy.value = false }
}
function openFile(f, download = false) {
  api.logFileView({ fileId: f.id, action: download ? 'download' : 'view', operator: props.role })
  const url = download ? downloadUrl(f.file_path) : mediaUrl(f.file_path)
  window.open(url, '_blank')
}

/* ---------- 履约节点 ---------- */
async function addMilestone() {
  if (!msForm.value.name.trim()) { toast('请填写节点名称', 'error'); return }
  try {
    await api.addMilestone({ contractId: props.contract.id, ...msForm.value, operator: props.role })
    msForm.value = { name: '', plan_date: '', owner: '', remark: '' }
    toast('履约节点已添加', 'success'); await refreshDetail()
  } catch (e) { toast(e.message, 'error') }
}
async function updateMs(m, patch) {
  try { await api.updateMilestone(m.id, { ...patch, operator: props.role }); await refreshDetail() } catch (e) { toast(e.message, 'error') }
}
async function delMs(id) {
  try { await api.deleteMilestone(id); toast('节点已删除', 'success'); await refreshDetail() } catch (e) { toast(e.message, 'error') }
}

/* ---------- 收付款 ---------- */
async function addPlan() {
  if (!(Number(ppForm.value.plan_amount) > 0)) { toast('计划金额须大于 0', 'error'); return }
  try {
    await api.addPaymentPlan({ contractId: props.contract.id, ...ppForm.value })
    ppForm.value = { direction: '应收', seq: '', plan_amount: 0, plan_date: '', remark: '' }
    toast('计划已添加', 'success'); await refreshDetail()
  } catch (e) { toast(e.message, 'error') }
}
async function delPlan(id) {
  try { await api.deletePaymentPlan(id); toast('计划已删除', 'success'); await refreshDetail() } catch (e) { toast(e.message, 'error') }
}
async function addRecord() {
  if (!(Number(prForm.value.amount) > 0)) { toast('金额须大于 0', 'error'); return }
  try {
    await api.addPaymentRecord({ contractId: props.contract.id, ...prForm.value, operator: props.role })
    prForm.value = { plan_id: '', amount: 0, pay_date: today(), method: '银行转账', remark: '' }
    toast('流水已登记', 'success'); await refreshDetail()
  } catch (e) { toast(e.message, 'error') }
}
async function delRecord(id) {
  try { await api.deletePaymentRecord(id); toast('流水已删除', 'success'); await refreshDetail() } catch (e) { toast(e.message, 'error') }
}

/* ---------- 审批 ---------- */
async function doApprove() {
  if (approveForm.value.action === 'reject' && !approveForm.value.comment.trim()) { toast('驳回必须填写审批意见', 'error'); return }
  try {
    await api.approve(props.contract.id, { ...approveForm.value, operator: props.role })
    toast('审批已提交', 'success'); approveForm.value.comment = ''; await refreshDetail()
  } catch (e) { toast(e.message, 'error') }
}
</script>

<template>
  <div v-if="contract" class="drawer-mask" @click.self="emit('close')">
    <div class="drawer">
      <div class="drawer-head">
        <div>
          <div class="drawer-title">{{ contract.contract_no }} · {{ contract.title }}</div>
          <div class="drawer-sub">
            <span class="tag-cell" :class="DIRECTION_META[contract.direction]?.tag">{{ contract.direction }}</span>
            <span class="tag-cell" :class="STATUS_META[contract.status]?.tag">{{ contract.status }}</span>
            <span>相对方：{{ mask && contract.party_name ? maskValue(contract.party_name, 2) : contract.party_name }}</span>
            <span v-if="dueInfo()" class="due-tag" :class="dueInfo().cls">{{ dueInfo().text }}</span>
          </div>
        </div>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="drawer-tabs">
        <button v-for="t in [
          { k:'base', l:'基本信息' }, { k:'files', l:'文件与版本' }, { k:'ms', l:'履约节点' },
          { k:'pay', l:'收付款' }, { k:'approve', l:'审批' }, { k:'logs', l:'生命周期日志' }
        ]" :key="t.k" :class="{ active: tab === t.k }" @click="tab = t.k">{{ t.l }}</button>
      </div>
      <div class="drawer-body">
        <!-- 基本信息 -->
        <div v-if="tab === 'base'" class="detail-grid">
          <div><label>合同编号</label><div>{{ contract.contract_no }}</div></div>
          <div><label>方向 / 类型</label><div>{{ contract.direction }} · {{ contract.type }}</div></div>
          <div><label>项目</label><div>{{ contract.project_name || '—' }}</div></div>
          <div><label>我方主体</label><div>{{ contract.our_entity || '—' }}</div></div>
          <div><label>金额</label><div class="money">¥{{ formatMoney(contract.amount) }} {{ contract.currency }}</div></div>
          <div><label>负责人</label><div>{{ contract.owner || '—' }}</div></div>
          <div><label>签订日</label><div>{{ contract.sign_date || '—' }}</div></div>
          <div><label>起止日</label><div>{{ contract.start_date || '—' }} ~ {{ contract.end_date || '—' }}</div></div>
          <div><label>自动续约</label><div>{{ contract.auto_renew ? '是' : '否' }}</div></div>
          <div><label>终止条件</label><div>{{ contract.terminate_note || '—' }}</div></div>
          <div class="full"><label>相对方</label><div>{{ contract.party_name }}</div></div>
          <div class="full"><label>备注</label><div>{{ contract.remark || '—' }}</div></div>
          <div v-if="contract.children?.length" class="full"><label>补充协议</label>
            <div><span v-for="c in contract.children" :key="c.id" class="tag-cell tag-blue" style="margin-right:6px">{{ c.contract_no }} {{ c.title }}</span></div>
          </div>
        </div>

        <!-- 文件与版本 -->
        <div v-else-if="tab === 'files'">
          <div v-if="canEdit && !contract.archived" class="inline-form">
            <input ref="fileInput" type="file" @change="onPickFile" />
            <input v-model="changeNote" class="inline-input" placeholder="变更说明（谁在何时换了哪一版）" />
            <label class="inline-check"><input v-model="uploadMain" type="checkbox" /> 设为正文</label>
          </div>
          <table class="mini-table">
            <thead><tr><th>文件</th><th>版本</th><th>正文</th><th>变更说明</th><th>大小</th><th>上传人</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="f in contract.files" :key="f.id">
                <td>{{ f.file_name }}</td>
                <td>v{{ f.version }}</td>
                <td><span v-if="f.is_main" class="tag-cell tag-cyan">正文</span><span v-else class="muted">附件</span></td>
                <td>{{ f.change_note || '—' }}</td>
                <td>{{ (f.size / 1024).toFixed(0) }} KB</td>
                <td>{{ f.uploaded_by }}</td>
                <td>
                  <button class="mini-btn" @click="openFile(f, false)">预览</button>
                  <button class="mini-btn" @click="openFile(f, true)">下载</button>
                  <button v-if="canEdit && !contract.archived" class="mini-btn danger" @click="api.deleteFile(f.id).then(refreshDetail).catch(e=>toast(e.message,'error'))">删除</button>
                </td>
              </tr>
              <tr v-if="!contract.files?.length"><td colspan="7" class="empty-row">尚未上传文件。上传正文后可将状态流转为「已签署」。</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 履约节点 -->
        <div v-else-if="tab === 'ms'">
          <div v-if="canEdit" class="inline-form">
            <input v-model="msForm.name" class="inline-input" placeholder="节点名称，如验收" />
            <input v-model="msForm.plan_date" type="date" />
            <input v-model="msForm.owner" class="inline-input short" placeholder="负责人" />
            <button class="btn primary sm" @click="addMilestone">添加</button>
          </div>
          <div class="timeline">
            <div v-for="m in contract.milestones" :key="m.id" class="tl-item">
              <div class="tl-dot" :class="{ done: m.status.startsWith('已完成') }"></div>
              <div class="tl-content">
                <div class="tl-title">{{ m.name }} <span class="tag-cell tag-gray">{{ m.status }}</span></div>
                <div class="tl-meta">计划 {{ m.plan_date || '—' }} · 实际 {{ m.done_date || '—' }} · {{ m.owner || '—' }}</div>
              </div>
              <div v-if="canEdit" class="tl-actions">
                <button v-if="!m.done_date" class="mini-btn" @click="updateMs(m, { done_date: today(), status: '已完成' })">完成</button>
                <button class="mini-btn danger" @click="delMs(m.id)">删除</button>
              </div>
            </div>
            <div v-if="!contract.milestones?.length" class="empty-row">暂无履约节点</div>
          </div>
        </div>

        <!-- 收付款 -->
        <div v-else-if="tab === 'pay'">
          <div class="pay-summary">
            <div><label>合同金额</label><b>¥{{ formatMoney(contract.amount) }}</b></div>
            <div><label>计划应收</label><b>¥{{ formatMoney(contract.summary?.planIn) }}</b></div>
            <div><label>已收</label><b class="green">¥{{ formatMoney(contract.summary?.received) }}</b></div>
            <div><label>未收</label><b class="amber">¥{{ formatMoney(contract.summary?.remainIn) }}</b></div>
            <div><label>计划应付</label><b>¥{{ formatMoney(contract.summary?.planOut) }}</b></div>
            <div><label>已付</label><b class="green">¥{{ formatMoney(contract.summary?.paid) }}</b></div>
            <div><label>未付</label><b class="amber">¥{{ formatMoney(contract.summary?.remainOut) }}</b></div>
            <div><label>回款率</label><b>{{ contract.summary?.planIn ? Math.round(contract.summary.received / contract.summary.planIn * 100) : 0 }}%</b></div>
          </div>
          <h4>收付款计划</h4>
          <div v-if="canEdit" class="inline-form">
            <select v-model="ppForm.direction"><option>应收</option><option>应付</option></select>
            <input v-model="ppForm.seq" class="inline-input short" placeholder="期次" />
            <input v-model.number="ppForm.plan_amount" type="number" class="inline-input short" placeholder="计划金额" />
            <input v-model="ppForm.plan_date" type="date" />
            <button class="btn primary sm" @click="addPlan">添加计划</button>
          </div>
          <table class="mini-table">
            <thead><tr><th>方向</th><th>期次</th><th>计划金额</th><th>计划日期</th><th>状态</th><th>到账合计</th><th></th></tr></thead>
            <tbody>
              <tr v-for="pp in contract.payment_plans" :key="pp.id">
                <td>{{ pp.direction }}</td><td>{{ pp.seq }}</td><td>¥{{ formatMoney(pp.plan_amount) }}</td>
                <td>{{ pp.plan_date }}</td><td><span class="tag-cell tag-gray">{{ pp.status }}</span></td>
                <td>¥{{ formatMoney((contract.payment_records || []).filter(r => r.plan_id === pp.id).reduce((s,r)=>s+Number(r.amount||0),0)) }}</td>
                <td><button v-if="canEdit" class="mini-btn danger" @click="delPlan(pp.id)">✕</button></td>
              </tr>
            </tbody>
          </table>
          <h4>实际流水</h4>
          <div v-if="canFinance" class="inline-form">
            <select v-model="prForm.plan_id"><option value="">— 计划外 —</option><option v-for="pp in contract.payment_plans" :key="pp.id" :value="pp.id">{{ pp.seq }} · {{ pp.direction }}</option></select>
            <input v-model.number="prForm.amount" type="number" class="inline-input short" placeholder="金额" />
            <input v-model="prForm.pay_date" type="date" />
            <input v-model="prForm.method" class="inline-input short" placeholder="方式" />
            <button class="btn primary sm" @click="addRecord">登记</button>
          </div>
          <table class="mini-table">
            <thead><tr><th>日期</th><th>金额</th><th>方式</th><th>关联期次</th><th>备注</th><th></th></tr></thead>
            <tbody>
              <tr v-for="pr in contract.payment_records" :key="pr.id">
                <td>{{ pr.pay_date }}</td><td>¥{{ formatMoney(pr.amount) }}</td><td>{{ pr.method }}</td>
                <td>{{ contract.payment_plans?.find(p=>p.id===pr.plan_id)?.seq || '计划外' }}</td><td>{{ pr.remark }}</td>
                <td><button v-if="canFinance" class="mini-btn danger" @click="delRecord(pr.id)">✕</button></td>
              </tr>
              <tr v-if="!contract.payment_records?.length"><td colspan="6" class="empty-row">暂无到账流水</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 审批 -->
        <div v-else-if="tab === 'approve'">
          <div class="approve-box">
            <div class="approve-status">当前状态：<span class="tag-cell" :class="STATUS_META[contract.status]?.tag">{{ contract.status }}</span></div>
            <template v-if="contract.status === '审批中' && canApprove">
              <select v-model.number="approveForm.level"><option :value="1">一级审批</option><option :value="2">二级审批</option></select>
              <select v-model="approveForm.action"><option value="approve">通过</option><option value="reject">驳回</option></select>
              <textarea v-model="approveForm.comment" rows="3" placeholder="审批意见（驳回必填）"></textarea>
              <button class="btn primary" @click="doApprove">提交审批</button>
            </template>
            <div v-else class="muted">仅「审批中」状态可审批。</div>
          </div>
          <table class="mini-table">
            <thead><tr><th>时间</th><th>层级</th><th>动作</th><th>操作人</th><th>意见</th></tr></thead>
            <tbody>
              <tr v-for="a in contract.approvals" :key="a.id"><td>{{ a.created_at }}</td><td>{{ a.level }}级</td><td>{{ a.action }}</td><td>{{ a.operator }}</td><td>{{ a.comment }}</td></tr>
              <tr v-if="!contract.approvals?.length"><td colspan="5" class="empty-row">暂无审批记录</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 日志 -->
        <div v-else-if="tab === 'logs'">
          <HistoryTab :contract-id="contract.id" />
        </div>
      </div>
      <div class="drawer-foot">
        <button v-if="canEdit && !contract.archived" class="btn ghost" @click="emit('edit', contract)">编辑合同</button>
        <button v-if="canEdit && !contract.archived && contract.status === '草稿'" class="btn" @click="emit('status', { row: contract, status: '审批中' })">提交审批</button>
        <button v-if="canEdit && !contract.archived && contract.status === '履约中'" class="btn" @click="emit('status', { row: contract, status: '已完成' })">标记完成</button>
        <button v-if="role === 'admin' && contract.archived" class="btn" @click="api.archive(contract.id,'unarchive').then(refreshDetail).catch(e=>toast(e.message,'error'))">解档</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.money { color: #3fd3ff; font-weight: 600; }
.green { color: #3ce0a5; } .amber { color: #ffbe4d; }
</style>
