<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { toast, formatMoney, exportInvoicesToExcel } from '../utils'

const props = defineProps({
  mode: { type: String, default: 'detail' },   // detail | global
  contract: { type: Object, default: null },
  contracts: { type: Array, default: () => [] },
  canEdit: { type: Boolean, default: true },
})
const list = ref([])
const summary = ref({ issued: 0, received: 0 })
const busy = ref(false)
const dialog = ref(false)
const editing = ref(null)
const form = ref({})
const confirmDel = ref(null)
const voidTarget = ref(null)
const voidReason = ref('')
const keyword = ref('')
const fDirection = ref('全部')
const fStatus = ref('全部')
const DIRS = ['开票', '收票']
const TYPES = ['专票', '普票', '电子票', '其他']
const STATUS = ['草稿', '已开具', '已认证', '作废']

const cid = computed(() => props.contract?.id || '')
const filtered = computed(() => list.value.filter((i) => {
  if (props.mode === 'detail') return true
  if (fDirection.value !== '全部' && i.direction !== fDirection.value) return false
  if (fStatus.value !== '全部' && i.status !== fStatus.value) return false
  if (!keyword.value.trim()) return true
  const kw = keyword.value.trim().toLowerCase()
  return [i.invoice_no, i.invoice_code, i.contract_no, i.seller_name, i.buyer_name].some((v) => String(v || '').toLowerCase().includes(kw))
}))

async function load() {
  try {
    const params = props.mode === 'detail' && cid.value ? { contractId: cid.value } : {}
    const d = await api.invoices(params)
    list.value = d.list || []
    if (props.mode === 'detail' && cid.value) summary.value = await api.invoiceSummary(cid.value)
  } catch (e) { toast(e.message, 'error') }
}
onMounted(load)
watch(() => props.contract?.id, load)

function openNew() {
  editing.value = null
  const c = props.contract
  form.value = {
    contractId: c?.id || '', direction: c?.direction === '对内' ? '收票' : '开票',
    invoice_type: '专票', invoice_no: '', invoice_code: '', invoice_date: new Date().toISOString().slice(0, 10),
    amount_ex_tax: 0, tax_amount: 0, amount_incl_tax: 0, tax_rate: c?.tax_rate || 0,
    seller_name: c ? '' : '', buyer_name: '', status: '草稿', remark: '',
  }
  dialog.value = true
}
function openEdit(i) {
  editing.value = i
  form.value = { ...i, contractId: i.contract_id }
  dialog.value = true
}
// 含税/不含税/税额/税率 联动
function onAmountChange(changed) {
  const f = form.value
  const rate = Number(f.tax_rate) || 0
  if (changed === 'rate' || changed === 'ex') {
    f.tax_amount = Math.round((Number(f.amount_ex_tax || 0) * rate) / 100 * 100) / 100
    f.amount_incl_tax = Math.round((Number(f.amount_ex_tax || 0) + Number(f.tax_amount)) * 100) / 100
  } else if (changed === 'incl') {
    const ex = Math.round((Number(f.amount_incl_tax || 0) / (1 + rate / 100)) * 100) / 100
    f.amount_ex_tax = ex
    f.tax_amount = Math.round((Number(f.amount_incl_tax || 0) - ex) * 100) / 100
  } else if (changed === 'tax') {
    f.amount_incl_tax = Math.round((Number(f.amount_ex_tax || 0) + Number(f.tax_amount || 0)) * 100) / 100
  }
}
async function save() {
  if (!form.value.contractId) { toast('请选择关联合同', 'error'); return }
  if (!form.value.invoice_no.trim()) { toast('请输入发票号码', 'error'); return }
  busy.value = true
  try {
    if (editing.value) await api.updateInvoice(editing.value.id, form.value)
    else await api.createInvoice(form.value)
    toast('已保存', 'success'); dialog.value = false; await load()
  } catch (e) { toast(e.message, 'error') } finally { busy.value = false }
}
async function remove() {
  try { await api.deleteInvoice(confirmDel.value.id); toast('已删除', 'success'); confirmDel.value = null; await load() }
  catch (e) { toast(e.message, 'error'); confirmDel.value = null }
}
async function doVoid() {
  try { await api.updateInvoice(voidTarget.value.id, { status: '作废', voidReason: voidReason.value }); toast('已作废', 'success'); voidTarget.value = null; voidReason.value = ''; await load() }
  catch (e) { toast(e.message, 'error') }
}
function doExport() {
  if (!filtered.value.length) return toast('无可导出数据', 'warn')
  exportInvoicesToExcel(filtered.value, `发票登记_${new Date().toISOString().slice(0, 10)}.xlsx`)
  toast(`已导出 ${filtered.value.length} 条`, 'success')
}
function statusTag(s) { return { '草稿': 'tag-gray', '已开具': 'tag-blue', '已认证': 'tag-green', '作废': 'tag-red' }[s] || 'tag-gray' }
</script>

<template>
  <div class="invoice-panel">
    <!-- 合同维度汇总 -->
    <div v-if="mode === 'detail'" class="inv-summary">
      <div><label>已开票</label><b>¥{{ formatMoney(summary.issued || 0) }}</b></div>
      <div><label>已收票</label><b>¥{{ formatMoney(summary.received || 0) }}</b></div>
      <div><label>合同金额 − 已开票</label><b class="amber">¥{{ formatMoney((contract?.amount || 0) - (summary.issued || 0)) }}</b></div>
    </div>

    <div class="panel-toolbar">
      <template v-if="mode === 'global'">
        <input v-model="keyword" class="inline-input" placeholder="搜索发票号 / 合同 / 销购方" />
        <select v-model="fDirection"><option>全部</option><option v-for="d in DIRS" :key="d">{{ d }}</option></select>
        <select v-model="fStatus"><option>全部</option><option v-for="s in STATUS" :key="s">{{ s }}</option></select>
        <button class="btn sm" @click="doExport">导出</button>
      </template>
      <button v-if="canEdit && (mode === 'global' || contract)" class="btn primary sm" @click="openNew">＋ 登记发票</button>
    </div>

    <div class="table-wrap">
      <table class="grid-table">
        <thead><tr>
          <th>发票号码</th><th v-if="mode==='global'">合同</th><th>方向</th><th>类型</th><th>开票日期</th>
          <th>不含税</th><th>税额</th><th>价税合计</th><th>状态</th><th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="i in filtered" :key="i.id">
            <td>{{ i.invoice_no }}</td>
            <td v-if="mode==='global'">{{ i.contract_no }} {{ i.contract_title }}</td>
            <td><span class="tag-cell" :class="i.direction==='开票'?'tag-cyan':'tag-blue'">{{ i.direction }}</span></td>
            <td>{{ i.invoice_type }}</td>
            <td>{{ i.invoice_date }}</td>
            <td>¥{{ formatMoney(i.amount_ex_tax) }}</td>
            <td>¥{{ formatMoney(i.tax_amount) }}</td>
            <td><b>¥{{ formatMoney(i.amount_incl_tax) }}</b></td>
            <td><span class="tag-cell" :class="statusTag(i.status)">{{ i.status }}</span></td>
            <td v-if="canEdit">
              <button v-if="i.status!=='作废'" class="mini-btn" @click="openEdit(i)">编辑</button>
              <button v-if="i.status!=='作废'" class="mini-btn" @click="voidTarget=i">作废</button>
              <button class="mini-btn danger" @click="confirmDel=i">删</button>
            </td>
            <td v-else class="muted">—</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="10" class="empty-row">暂无发票记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 新增/编辑 -->
    <div v-if="dialog" class="modal-mask" @click.self="dialog=false">
      <div class="modal modal-lg">
        <div class="modal-head"><h3>{{ editing ? '编辑发票' : '登记发票' }}</h3><button class="icon-btn" @click="dialog=false">✕</button></div>
        <div class="modal-body form-grid">
          <label class="field full"><span>关联合同 *</span>
            <select v-model="form.contractId" :disabled="!!editing || mode==='detail'"><option value="">— 请选择 —</option><option v-for="c in contracts" :key="c.id" :value="c.id">{{ c.contract_no }} {{ c.title }}</option></select>
          </label>
          <label class="field"><span>票种方向 *</span><select v-model="form.direction"><option v-for="d in DIRS" :key="d">{{ d }}</option></select></label>
          <label class="field"><span>发票类型 *</span><select v-model="form.invoice_type"><option v-for="t in TYPES" :key="t">{{ t }}</option></select></label>
          <label class="field"><span>发票号码 *</span><input v-model="form.invoice_no" /></label>
          <label class="field"><span>发票代码</span><input v-model="form.invoice_code" /></label>
          <label class="field"><span>开票日期 *</span><input v-model="form.invoice_date" type="date" /></label>
          <label class="field"><span>税率（%）</span><input v-model.number="form.tax_rate" type="number" min="0" step="0.01" @change="onAmountChange('rate')" /></label>
          <label class="field"><span>不含税金额</span><input v-model.number="form.amount_ex_tax" type="number" min="0" step="0.01" @change="onAmountChange('ex')" /></label>
          <label class="field"><span>税额</span><input v-model.number="form.tax_amount" type="number" min="0" step="0.01" @change="onAmountChange('tax')" /></label>
          <label class="field"><span>价税合计</span><input v-model.number="form.amount_incl_tax" type="number" min="0" step="0.01" @change="onAmountChange('incl')" /></label>
          <label class="field"><span>销方名称</span><input v-model="form.seller_name" /></label>
          <label class="field"><span>购方名称</span><input v-model="form.buyer_name" /></label>
          <label class="field"><span>状态</span><select v-model="form.status"><option v-for="s in STATUS.filter(x=>x!=='作废')" :key="s">{{ s }}</option></select></label>
          <label class="field full"><span>备注</span><input v-model="form.remark" /></label>
        </div>
        <div class="modal-foot"><button class="btn ghost" @click="dialog=false">取消</button><button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button></div>
      </div>
    </div>

    <!-- 作废确认 -->
    <div v-if="voidTarget" class="modal-mask" @click.self="voidTarget=null">
      <div class="modal narrow">
        <div class="modal-head"><h3>作废发票</h3><button class="icon-btn" @click="voidTarget=null">✕</button></div>
        <div class="modal-body">
          <p>确定作废发票【{{ voidTarget.invoice_no }}】？作废后不计入合计。</p>
          <label class="field full"><span>作废原因 *</span><input v-model="voidReason" /></label>
        </div>
        <div class="modal-foot"><button class="btn ghost" @click="voidTarget=null">取消</button><button class="btn danger" @click="doVoid">确认作废</button></div>
      </div>
    </div>
    <!-- 删除确认 -->
    <div v-if="confirmDel" class="modal-mask" @click.self="confirmDel=null">
      <div class="modal narrow">
        <div class="modal-head"><h3>删除发票</h3><button class="icon-btn" @click="confirmDel=null">✕</button></div>
        <div class="modal-body">确定删除发票【{{ confirmDel.invoice_no }}】？此操作不可恢复。</div>
        <div class="modal-foot"><button class="btn ghost" @click="confirmDel=null">取消</button><button class="btn danger" @click="remove">确认删除</button></div>
      </div>
    </div>
  </div>
</template>
