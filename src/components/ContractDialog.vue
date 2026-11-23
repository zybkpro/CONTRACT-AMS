<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../api'
import { toast, today, STATUSES, DIRECTIONS } from '../utils'

const props = defineProps({
  model: { type: Object, default: null },      // null = 新增
  projects: { type: Array, default: () => [] },
  parties: { type: Array, default: () => [] },
  contracts: { type: Array, default: () => [] },
  dictTypes: { type: Array, default: () => [] },
  dictCategories: { type: Array, default: () => [] },
})
const emit = defineEmits(['saved', 'close'])

const form = ref({})
const busy = ref(false)
const err = ref('')
const confirmBlacklist = ref(false)

const isEdit = computed(() => !!props.model?.id)
// 补充协议：带 parent_id 的新建，编号由后端按 {主编号}-n 生成
const isSupplement = computed(() => !isEdit.value && !!props.model?.parent_id)
const masterOptions = computed(() => props.contracts.filter((c) => !c.parent_id && (!isEdit.value || c.id !== props.model.id)))
const typesForDirection = computed(() => {
  const list = props.dictTypes.filter((d) => d.direction_scope === '全部' || d.direction_scope === form.value.direction)
  return list.length ? list.map((d) => d.name) : ['销售', '采购', '框架协议', '保密', '外包', '补充协议']
})

function reset() {
  form.value = props.model ? { ...props.model } : {
    contract_no: '', title: '', direction: '对外', type: '销售', status: '草稿',
    project_id: '', party_id: '', parent_id: '', our_entity: '', amount: 0, currency: 'CNY',
    sign_date: today(), start_date: '', end_date: '', auto_renew: false, terminate_note: '', owner: '', remark: '',
    amount_ex_tax: 0, tax_amount: 0, tax_rate: 0, category_id: '',
  }
  err.value = ''
  confirmBlacklist.value = false
  if (!isEdit.value && !isSupplement.value) {
    api.nextCode(form.value.direction).then((r) => { if (!form.value.contract_no) form.value.contract_no = r.code }).catch(() => {})
  }
}
reset()
watch(() => props.model, reset)

watch(() => form.value.direction, (d) => {
  if (!typesForDirection.value.includes(form.value.type)) form.value.type = typesForDirection.value[0] || '销售'
})

// V1.1 含税/不含税互算
function calcTax(changed) {
  const f = form.value
  const rate = Number(f.tax_rate) || 0
  if (changed === 'incl') {
    const ex = Math.round((Number(f.amount_incl_tax || 0) / (1 + rate / 100)) * 100) / 100
    f.amount_ex_tax = ex
    f.tax_amount = Math.round((Number(f.amount_incl_tax || 0) - ex) * 100) / 100
    f.amount = f.amount_incl_tax
  } else if (changed === 'tax') {
    f.amount = Math.round((Number(f.amount_ex_tax || 0) + Number(f.tax_amount || 0)) * 100) / 100
    f.amount_incl_tax = f.amount
  } else {
    f.tax_amount = Math.round((Number(f.amount_ex_tax || 0) * rate / 100) * 100) / 100
    f.amount = Math.round((Number(f.amount_ex_tax || 0) + Number(f.tax_amount)) * 100) / 100
    f.amount_incl_tax = f.amount
  }
}

async function save() {
  err.value = ''
  if (!form.value.title?.trim()) { err.value = '请填写合同名称'; return }
  if (!form.value.party_id) { err.value = '请选择相对方（如没有，请先在相对方档案新增）'; return }
  busy.value = true
  try {
    const payload = { ...form.value, confirmBlacklist: confirmBlacklist.value }
    const saved = isEdit.value ? await api.updateContract(props.model.id, payload) : await api.createContract(payload)
    toast(isEdit.value ? '合同已更新' : '合同已创建', 'success')
    emit('saved', saved)
  } catch (e) {
    err.value = e.message
    if (e.message.includes('黑名单')) confirmBlacklist.value = true
  } finally { busy.value = false }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-lg">
      <div class="modal-head">
        <h3>{{ isEdit ? '编辑合同' : (isSupplement ? '创建补充协议' : '新增合同') }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body form-grid">
        <label class="field"><span>合同编号 <i>*</i></span><input v-model="form.contract_no" :placeholder="isSupplement ? '留空自动生成（原编号-n）' : '留空自动生成'" /></label>
        <label class="field"><span>合同名称 <i>*</i></span><input v-model="form.title" placeholder="如：智慧园区平台建设合同" /></label>
        <label class="field"><span>方向 <i>*</i></span>
          <select v-model="form.direction"><option v-for="d in DIRECTIONS" :key="d">{{ d }}</option></select>
        </label>
        <label class="field"><span>合同类型 <i>*</i></span>
          <select v-model="form.type"><option v-for="t in typesForDirection" :key="t">{{ t }}</option></select>
        </label>
        <label class="field"><span>状态</span>
          <select v-model="form.status"><option v-for="s in STATUSES" :key="s">{{ s }}</option></select>
        </label>
        <label class="field"><span>关联项目</span>
          <select v-model="form.project_id"><option value="">— 无 —</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        </label>
        <label class="field"><span>相对方 <i>*</i></span>
          <select v-model="form.party_id"><option value="">— 请选择 —</option><option v-for="p in parties" :key="p.id" :value="p.id">{{ p.name }}（{{ p.role }}）</option></select>
        </label>
        <label class="field"><span>我方主体</span><input v-model="form.our_entity" placeholder="签约我方公司" /></label>
        <label class="field"><span>金额（价税合计）</span><input v-model.number="form.amount" type="number" min="0" step="0.01" @change="form.amount_incl_tax = form.amount; calcTax('incl')" /></label>
        <label class="field"><span>费用分类</span>
          <select v-model="form.category_id"><option value="">— 未分类 —</option><option v-for="c in dictCategories" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        </label>
        <label class="field"><span>税率（%）</span><input v-model.number="form.tax_rate" type="number" min="0" step="0.01" @change="calcTax('ex')" /></label>
        <label class="field"><span>不含税金额</span><input v-model.number="form.amount_ex_tax" type="number" min="0" step="0.01" @change="calcTax('ex')" /></label>
        <label class="field"><span>税额</span><input v-model.number="form.tax_amount" type="number" min="0" step="0.01" @change="calcTax('tax')" /></label>
        <label class="field"><span>币种</span><input v-model="form.currency" /></label>
        <label class="field"><span>签订日</span><input v-model="form.sign_date" type="date" /></label>
        <label class="field"><span>开始日</span><input v-model="form.start_date" type="date" /></label>
        <label class="field"><span>结束日（到期提醒依据）</span><input v-model="form.end_date" type="date" /></label>
        <label class="field"><span>负责人</span><input v-model="form.owner" /></label>
        <label class="field"><span>关联主合同</span>
          <select v-model="form.parent_id"><option value="">— 无（本身为主合同）—</option><option v-for="c in masterOptions" :key="c.id" :value="c.id">{{ c.contract_no }} {{ c.title }}</option></select>
        </label>
        <label class="field checkbox-field"><span>自动续约</span><input v-model="form.auto_renew" type="checkbox" /></label>
        <label class="field full"><span>终止条件备注</span><input v-model="form.terminate_note" placeholder="如：提前30天书面通知可终止" /></label>
        <label class="field full"><span>备注</span><textarea v-model="form.remark" rows="2" /></label>
        <div v-if="err" class="form-error full">{{ err }}
          <button v-if="confirmBlacklist === false && err.includes('黑名单')" class="link-btn" @click="save">仍要创建（确认黑名单）</button>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>
