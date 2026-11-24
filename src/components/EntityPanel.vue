<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../api'
import { toast, formatMoney, maskValue } from '../utils'

const props = defineProps({
  mode: { type: String, default: 'project' }, // project | party
  projects: { type: Array, default: () => [] },
  parties: { type: Array, default: () => [] },
  contracts: { type: Array, default: () => [] },
  mask: { type: Boolean, default: true },
  canEdit: { type: Boolean, default: true },
})
const emit = defineEmits(['refresh', 'new-contract', 'view-in-ledger', 'view-in-board'])

const keyword = ref('')
const dialog = ref(false)
const editing = ref(null)
const form = ref({})
const stats = ref([])

const list = computed(() => (props.mode === 'project' ? props.projects : props.parties)
  .filter((x) => !keyword.value.trim() || JSON.stringify(x).toLowerCase().includes(keyword.value.trim().toLowerCase())))

async function loadStats() {
  try {
    const d = props.mode === 'project' ? await api.statsByProject() : await api.statsByParty()
    stats.value = d.list
  } catch (_) {}
}
watch(() => [props.mode, props.projects.length, props.parties.length, props.contracts.length], loadStats, { immediate: true })

function stat(id) { return stats.value.find((s) => s.id === id) || {} }
function openNew() { editing.value = null; form.value = props.mode === 'project'
  ? { name: '', code: '', owner: '', status: '筹备', start_date: '', end_date: '', remark: '' }
  : { name: '', role: '客户', credit_code: '', contact: '', phone: '', bank: '', account: '', rating: '', blacklist: false, remark: '' }
  ; dialog.value = true }
function openEdit(x) { editing.value = x; form.value = { ...x }; dialog.value = true }

async function save() {
  if (!form.value.name?.trim()) { toast('名称不能为空', 'error'); return }
  try {
    if (props.mode === 'project') editing.value ? await api.updateProject(editing.value.id, form.value) : await api.createProject(form.value)
    else editing.value ? await api.updateParty(editing.value.id, form.value) : await api.createParty(form.value)
    toast('已保存', 'success'); dialog.value = false; emit('refresh')
  } catch (e) { toast(e.message, 'error') }
}
async function remove(x) {
  try { props.mode === 'project' ? await api.deleteProject(x.id) : await api.deleteParty(x.id); toast('已删除', 'success'); emit('refresh') }
  catch (e) { toast(e.message, 'error') }
}
function contractsOf(x) {
  return props.contracts.filter((c) => (props.mode === 'project' ? c.project_id === x.id : c.party_id === x.id))
}
</script>

<template>
  <div class="entity-panel">
    <div class="panel-toolbar">
      <input v-model="keyword" class="inline-input" :placeholder="mode === 'project' ? '搜索项目' : '搜索相对方'" />
      <button v-if="canEdit" class="btn primary sm" @click="openNew">新增{{ mode === 'project' ? '项目' : '相对方' }}</button>
    </div>
    <div class="entity-grid">
      <div v-for="x in list" :key="x.id" class="entity-card">
        <div class="ec-head">
          <div class="ec-title">{{ x.name }}</div>
          <div v-if="mode === 'project'" class="ec-meta">{{ x.code }} · {{ x.status }} · 负责人 {{ x.owner || '—' }}</div>
          <div v-else class="ec-meta">
            {{ x.role }} · 评级 {{ x.rating || '—' }}
            <span v-if="x.blacklist" class="tag-cell tag-red">黑名单</span>
          </div>
        </div>
        <div class="ec-stats">
          <div><label>关联合同</label><b>{{ stat(x.id).contractCount || 0 }} 份</b></div>
          <div v-if="mode !== 'project'"><label>合同金额</label><b>¥{{ formatMoney(stat(x.id).amount) }}</b></div>
          <template v-if="mode === 'project'">
            <div><label>收入合同</label><b class="cyan">¥{{ formatMoney(stat(x.id).receiveAmount) }}</b></div>
            <div><label>已收</label><b class="green">¥{{ formatMoney(stat(x.id).received) }}</b></div>
            <div><label>未收</label><b class="amber">¥{{ formatMoney(stat(x.id).remainIn) }}</b></div>
            <div><label>支出合同</label><b class="red">¥{{ formatMoney(stat(x.id).payAmount) }}</b></div>
            <div><label>已付</label><b class="green">¥{{ formatMoney(stat(x.id).paid) }}</b></div>
            <div><label>未付</label><b class="amber">¥{{ formatMoney(stat(x.id).remainOut) }}</b></div>
            <div><label>合同净额</label><b>¥{{ formatMoney(stat(x.id).netAmount) }}</b></div>
          </template>
        </div>
        <div v-if="mode === 'party'" class="ec-fields">
          <div>联系人 {{ x.contact || '—' }} · {{ mask ? maskValue(x.phone, 4) : x.phone }}</div>
          <div>开户行 {{ x.bank || '—' }} · 账号 {{ mask ? maskValue(x.account, 4) : x.account }}</div>
        </div>
        <div v-if="mode === 'project'" class="ec-fields">
          <div>{{ x.start_date || '—' }} ~ {{ x.end_date || '—' }}</div>
        </div>
        <div class="ec-contracts">
          <span v-for="c in contractsOf(x).slice(0,6)" :key="c.id" class="tag-cell tag-gray" style="margin:2px 4px 0 0">{{ c.contract_no }}</span>
          <div v-if="mode === 'project'" class="ec-quick-links">
            <button class="link-btn" @click="emit('view-in-ledger', x)">在台账中查看</button>
            <button class="link-btn" @click="emit('view-in-board', x)">在看板中查看</button>
          </div>
          <button class="link-btn" @click="emit('new-contract', x)">+ 为此{{ mode === 'project' ? '项目' : '相对方' }}建合同</button>
        </div>
        <div v-if="canEdit" class="ec-foot">
          <button class="mini-btn" @click="openEdit(x)">编辑</button>
          <button class="mini-btn danger" @click="remove(x)">删除</button>
        </div>
      </div>
      <div v-if="!list.length" class="empty-row">暂无数据</div>
    </div>

    <div v-if="dialog" class="modal-mask" @click.self="dialog = false">
      <div class="modal">
        <div class="modal-head"><h3>{{ editing ? '编辑' : '新增' }}{{ mode === 'project' ? '项目' : '相对方' }}</h3><button class="icon-btn" @click="dialog=false">✕</button></div>
        <div class="modal-body form-grid">
          <template v-if="mode === 'project'">
            <label class="field"><span>名称 *</span><input v-model="form.name" /></label>
            <label class="field"><span>编号</span><input v-model="form.code" placeholder="留空自动生成" /></label>
            <label class="field"><span>负责人</span><input v-model="form.owner" /></label>
            <label class="field"><span>状态</span><select v-model="form.status"><option>筹备</option><option>进行中</option><option>已结束</option></select></label>
            <label class="field"><span>开始日</span><input v-model="form.start_date" type="date" /></label>
            <label class="field"><span>结束日</span><input v-model="form.end_date" type="date" /></label>
            <label class="field full"><span>备注</span><textarea v-model="form.remark" rows="2"></textarea></label>
          </template>
          <template v-else>
            <label class="field"><span>名称 *</span><input v-model="form.name" /></label>
            <label class="field"><span>角色倾向</span><select v-model="form.role"><option>客户</option><option>供应商</option><option>两者</option></select></label>
            <label class="field"><span>统一社会信用代码</span><input v-model="form.credit_code" /></label>
            <label class="field"><span>评级</span><input v-model="form.rating" placeholder="A/B/C" /></label>
            <label class="field"><span>联系人</span><input v-model="form.contact" /></label>
            <label class="field"><span>电话</span><input v-model="form.phone" /></label>
            <label class="field"><span>开户行</span><input v-model="form.bank" /></label>
            <label class="field"><span>账号</span><input v-model="form.account" /></label>
            <label class="field checkbox-field"><span>黑名单</span><input v-model="form.blacklist" type="checkbox" /></label>
            <label class="field full"><span>备注</span><textarea v-model="form.remark" rows="2"></textarea></label>
          </template>
        </div>
        <div class="modal-foot"><button class="btn ghost" @click="dialog=false">取消</button><button class="btn primary" @click="save">保存</button></div>
      </div>
    </div>
  </div>
</template>
