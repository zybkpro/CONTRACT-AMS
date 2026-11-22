<script setup>
import { ref, reactive, watch } from 'vue'
import { api } from '../api'
import { toast } from '../utils'
import ChangePassword from './ChangePassword.vue'

const props = defineProps({ settings: { type: Object, default: () => ({}) }, initialTab: { type: String, default: 'dict' } })
const emit = defineEmits(['close', 'saved'])

const tab = ref(props.initialTab)
const dicts = ref([])
const newDict = ref({ name: '', direction_scope: '全部' })
const cfg = reactive({})
const busy = ref(false)

watch(() => props.settings, (s) => { Object.assign(cfg, {
  codePrefixIn: 'CG', codePrefixOut: 'XS', amountBasis: '含税', approvalLevel1: 100000,
  approvalLevel2: 500000, remindDays: [30, 15, 7], archiveAuto: false, sensitiveMask: true,
  maskKeep: 4, exportMask: true, visibleColumns: [], exportColumns: [], ...s,
}) }, { immediate: true })

async function loadDicts() {
  try { const d = await api.dictTypes(); dicts.value = d.list || [] } catch (e) { toast(e.message, 'error') }
}
watch(tab, (t) => { if (t === 'dict') loadDicts() }, { immediate: true })

async function addDict() {
  if (!newDict.value.name.trim()) { toast('请输入类型名称', 'error'); return }
  try { await api.addDictType(newDict.value); newDict.value.name = ''; loadDicts(); toast('已添加', 'success') }
  catch (e) { toast(e.message, 'error') }
}
async function delDict(id) {
  try { await api.deleteDictType(id); loadDicts(); toast('已删除', 'success') } catch (e) { toast(e.message, 'error') }
}
async function save() {
  busy.value = true
  try {
    const payload = { ...cfg }
    await api.saveSettings(payload)
    toast('设置已保存', 'success'); emit('saved', payload)
  } catch (e) { toast(e.message, 'error') } finally { busy.value = false }
}
function toggleRemind(d) {
  const arr = [...(cfg.remindDays || [])]
  const i = arr.indexOf(d)
  if (i >= 0) arr.splice(i, 1); else arr.push(d)
  cfg.remindDays = arr.sort((a, b) => b - a)
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-lg">
      <div class="modal-head"><h3>系统设置</h3><button class="icon-btn" @click="emit('close')">✕</button></div>
      <div class="settings-layout">
        <div class="settings-nav">
          <button v-for="t in [
            { k:'dict', l:'合同类型' }, { k:'code', l:'编号与金额' }, { k:'approval', l:'审批阈值' },
            { k:'remind', l:'提醒与归档' }, { k:'security', l:'脱敏设置' }, { k:'password', l:'修改密码' }
          ]" :key="t.k" :class="{ active: tab === t.k }" @click="tab = t.k">{{ t.l }}</button>
        </div>
        <div class="settings-content">
          <div v-if="tab === 'dict'" class="setting-section">
            <h4>合同类型字典</h4>
            <div class="inline-form">
              <input v-model="newDict.name" class="inline-input" placeholder="类型名称，如：技术服务" />
              <select v-model="newDict.direction_scope"><option>全部</option><option>对内</option><option>对外</option></select>
              <button class="btn primary sm" @click="addDict">添加</button>
            </div>
            <table class="mini-table">
              <thead><tr><th>类型</th><th>适用方向</th><th></th></tr></thead>
              <tbody>
                <tr v-for="d in dicts" :key="d.id"><td>{{ d.name }}</td><td>{{ d.direction_scope }}</td>
                  <td><button class="mini-btn danger" @click="delDict(d.id)">✕</button></td></tr>
              </tbody>
            </table>
            <p class="hint">被引用的类型不可删除。方向切换时表单会自动过滤可选类型。</p>
          </div>
          <div v-else-if="tab === 'code'" class="setting-section">
            <h4>编号规则</h4>
            <label class="field"><span>对内前缀</span><input v-model="cfg.codePrefixIn" /></label>
            <label class="field"><span>对外前缀</span><input v-model="cfg.codePrefixOut" /></label>
            <p class="hint">格式：{前缀}{年份}{4位流水}，如 XS20260001。</p>
            <h4>金额口径</h4>
            <label class="field"><span>默认口径（仅界面标注）</span><select v-model="cfg.amountBasis"><option>含税</option><option>未税</option></select></label>
          </div>
          <div v-else-if="tab === 'approval'" class="setting-section">
            <h4>分级审批阈值（元）</h4>
            <label class="field"><span>一级审批 ≥</span><input v-model.number="cfg.approvalLevel1" type="number" min="0" /></label>
            <label class="field"><span>二级审批 ≥</span><input v-model.number="cfg.approvalLevel2" type="number" min="0" /></label>
            <p class="hint">低于一级阈值可直接签署；达到一级需一级审批；达到二级需二级审批。阈值可改。</p>
          </div>
          <div v-else-if="tab === 'remind'" class="setting-section">
            <h4>到期提醒窗口（天）</h4>
            <div class="check-row"><label v-for="d in [30,15,7,3,1]" :key="d"><input type="checkbox" :checked="cfg.remindDays?.includes(d)" @change="toggleRemind(d)" /> {{ d }} 天</label></div>
            <h4>归档策略</h4>
            <label class="checkbox-field"><input v-model="cfg.archiveAuto" type="checkbox" /> 完成/终止后自动归档为只读态</label>
          </div>
          <div v-else-if="tab === 'security'" class="setting-section">
            <h4>敏感字段脱敏</h4>
            <label class="checkbox-field"><input v-model="cfg.sensitiveMask" type="checkbox" /> 显示时脱敏相对方账号/信用代码/电话</label>
            <label class="checkbox-field"><input v-model="cfg.exportMask" type="checkbox" /> 导出时同样脱敏</label>
            <label class="field"><span>保留尾号位数</span><input v-model.number="cfg.maskKeep" type="number" min="0" max="8" /></label>
          </div>
          <div v-else-if="tab === 'password'" class="setting-section">
            <ChangePassword />
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" @click="emit('close')">关闭</button>
        <button v-if="tab !== 'password'" class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存设置' }}</button>
      </div>
    </div>
  </div>
</template>
