<script setup>
import { ref, reactive, watch } from 'vue'
import { api, isDesktop } from '../api'
import { toast } from '../utils'
import ChangePassword from './ChangePassword.vue'

const props = defineProps({
  settings: { type: Object, default: () => ({}) },
  initialTab: { type: String, default: 'dict' },
  role: { type: String, default: 'admin' },
})
const emit = defineEmits(['close', 'saved', 'cleared'])

const tab = ref(props.initialTab)
// 清空数据二次确认（危险操作：需勾选同意 + 输入"清空"）
const clearDialog = ref(false)
const clearAgree = ref(false)
const clearPhrase = ref('')
const clearing = ref(false)
const dicts = ref([])
const categories = ref([])
const newDict = ref({ name: '', direction_scope: '全部' })
const newCat = ref('')
const cfg = reactive({})
const busy = ref(false)
// 字段显示名可配置（V1.1）
const LABEL_FIELDS = [
  { k: 'contract_no', def: '合同编号' }, { k: 'title', def: '合同名称' },
  { k: 'direction', def: '方向' }, { k: 'type', def: '类型' }, { k: 'status', def: '状态' },
  { k: 'project_name', def: '项目' }, { k: 'party_name', def: '相对方' }, { k: 'amount', def: '金额' },
  { k: 'sign_date', def: '签订日' }, { k: 'end_date', def: '到期日' }, { k: 'owner', def: '负责人' },
]

watch(() => props.settings, (s) => { Object.assign(cfg, {
  codePrefixIn: 'CG', codePrefixOut: 'XS', amountBasis: '含税', approvalLevel1: 100000,
  approvalLevel2: 500000, remindDays: [30, 15, 7], archiveAuto: false, sensitiveMask: true,
  maskKeep: 4, exportMask: true, visibleColumns: [], exportColumns: [],
  showNetAmount: false, amountEntryBasis: '含税', defaultTaxRate: 0, maxFileSizeMB: 200,
  invoiceNoDuplicateForbid: false, fieldLabels: {}, autoBackup: { enabled: false, cycle: 'daily', time: '02:00', keep: 7, dir: '' },
  ...s,
}) }, { immediate: true })

async function loadDicts() {
  try { const d = await api.dictTypes(); dicts.value = d.list || [] } catch (e) { toast(e.message, 'error') }
}
async function loadCategories() {
  try { const d = await api.dictCategories(); categories.value = d.list || [] } catch (e) { toast(e.message, 'error') }
}
watch(tab, (t) => { if (t === 'dict') loadDicts(); if (t === 'category') loadCategories() }, { immediate: true })

async function addDict() {
  if (!newDict.value.name.trim()) { toast('请输入类型名称', 'error'); return }
  try { await api.addDictType(newDict.value); newDict.value.name = ''; loadDicts(); toast('已添加', 'success') }
  catch (e) { toast(e.message, 'error') }
}
async function delDict(id) {
  try { await api.deleteDictType(id); loadDicts(); toast('已删除', 'success') } catch (e) { toast(e.message, 'error') }
}
async function addCat() {
  if (!newCat.value.trim()) { toast('请输入分类名称', 'error'); return }
  try { await api.addDictCategory({ name: newCat.value }); newCat.value = ''; loadCategories(); toast('已添加', 'success') }
  catch (e) { toast(e.message, 'error') }
}
async function delCat(id) {
  try { await api.deleteDictCategory(id); loadCategories(); toast('已删除', 'success') } catch (e) { toast(e.message, 'error') }
}
async function manualBackup() {
  busy.value = true
  try {
    // 桌面端：生成 zip 后弹系统「另存为」，真正导出到用户指定位置
    if (isDesktop && window.contractams?.file?.save) {
      const r = await api.runBackup(cfg.autoBackup?.dir || '')
      const name = r.file.split(/[\\/]/).pop()
      const saved = await window.contractams.file.save(r.file, name)
      if (saved?.canceled) { toast('已取消，备份文件仍保存在数据目录', 'info'); return }
      toast(`已导出：${saved.savedPath}`, 'success')
      return
    }
    // 浏览器端：取回文件内容触发下载
    const r = await api.runBackup(cfg.autoBackup?.dir || '', true)
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = r.file.split(/[\\/]/).pop()
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    toast(`已导出：${a.download}`, 'success')
  } catch (e) { toast(e.message, 'error') } finally { busy.value = false }
}
function openClearDialog() {
  clearAgree.value = false
  clearPhrase.value = ''
  clearDialog.value = true
}
async function doClear() {
  if (!clearAgree.value) { toast('请先勾选确认', 'warn'); return }
  if (clearPhrase.value.trim() !== '清空') { toast('请输入「清空」以确认', 'error'); return }
  clearing.value = true
  try {
    const r = await api.clearData()
    clearDialog.value = false
    toast(`已清空：合同 ${r.counts?.contract || 0} 份、附件 ${r.filesRemoved} 项`, 'success')
    emit('cleared')
  } catch (e) { toast(e.message, 'error') } finally { clearing.value = false }
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
            { k:'dict', l:'合同类型' }, { k:'category', l:'费用分类' }, { k:'code', l:'编号与金额' },
            { k:'approval', l:'审批阈值' }, { k:'remind', l:'提醒与归档' },
            { k:'security', l:'脱敏设置' }, { k:'labels', l:'显示文案' }, { k:'password', l:'修改密码' },
            ...(role === 'admin' ? [{ k:'data', l:'数据管理' }] : [])
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
          <div v-else-if="tab === 'category'" class="setting-section">
            <h4>费用 / 业务分类字典</h4>
            <div class="inline-form">
              <input v-model="newCat" class="inline-input" placeholder="分类名称，如：材料、工资/劳务" />
              <button class="btn primary sm" @click="addCat">添加</button>
            </div>
            <table class="mini-table">
              <thead><tr><th>分类</th><th></th></tr></thead>
              <tbody>
                <tr v-for="c in categories" :key="c.id"><td>{{ c.name }}</td>
                  <td><button class="mini-btn danger" @click="delCat(c.id)">✕</button></td></tr>
              </tbody>
            </table>
            <p class="hint">类型偏法务属性，分类偏费用/业务属性；已被合同引用的分类不可删除。</p>
          </div>
          <div v-else-if="tab === 'code'" class="setting-section">
            <h4>编号规则</h4>
            <label class="field"><span>对内前缀</span><input v-model="cfg.codePrefixIn" /></label>
            <label class="field"><span>对外前缀</span><input v-model="cfg.codePrefixOut" /></label>
            <p class="hint">格式：{前缀}{年份}{4位流水}，如 XS20260001。</p>
            <h4>金额口径</h4>
            <label class="field"><span>默认口径（仅界面标注）</span><select v-model="cfg.amountBasis"><option>含税</option><option>未税</option></select></label>
            <label class="field"><span>默认税率（%）</span><input v-model.number="cfg.defaultTaxRate" type="number" min="0" step="0.01" /></label>
            <label class="checkbox-field"><input v-model="cfg.showNetAmount" type="checkbox" /> 看板显示「在签净额」（收入 − 支出）</label>
            <h4>附件与发票</h4>
            <label class="field"><span>单文件上限（MB）</span><input v-model.number="cfg.maxFileSizeMB" type="number" min="1" max="300" /></label>
            <label class="checkbox-field"><input v-model="cfg.invoiceNoDuplicateForbid" type="checkbox" /> 禁止发票号码重复</label>
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
            <h4>定时备份（本机）</h4>
            <label class="checkbox-field"><input v-model="cfg.autoBackup.enabled" type="checkbox" /> 启用自动备份</label>
            <div class="inline-form">
              <select v-model="cfg.autoBackup.cycle"><option value="daily">每日</option><option value="weekly">每周一</option></select>
              <input v-model="cfg.autoBackup.time" type="time" />
              <label>保留 <input v-model.number="cfg.autoBackup.keep" type="number" min="1" max="99" style="width:60px" /> 份</label>
            </div>
            <label class="field"><span>备份目录（留空=数据目录/backups）</span><input v-model="cfg.autoBackup.dir" placeholder="如 D:/备份/合同系统" /></label>
            <p class="hint">备份 zip 含数据库、配置与全部附件。异地备份：把该目录同步到网盘即可；自动备份需保持程序在运行。</p>
            <button class="btn sm" :disabled="busy" @click="manualBackup">{{ busy ? '备份中…' : '备份' }}</button>
          </div>
          <div v-else-if="tab === 'security'" class="setting-section">
            <h4>敏感字段脱敏</h4>
            <label class="checkbox-field"><input v-model="cfg.sensitiveMask" type="checkbox" /> 显示时脱敏相对方账号/信用代码/电话</label>
            <label class="checkbox-field"><input v-model="cfg.exportMask" type="checkbox" /> 导出时同样脱敏</label>
            <label class="field"><span>保留尾号位数</span><input v-model.number="cfg.maskKeep" type="number" min="0" max="8" /></label>
          </div>
          <div v-else-if="tab === 'labels'" class="setting-section">
            <h4>字段显示名（仅界面文案）</h4>
            <p class="hint">修改后列表表头与导出表头同步变化，数据库字段名不变。留空则用默认名称。</p>
            <div class="form-grid">
              <label v-for="f in LABEL_FIELDS" :key="f.k" class="field"><span>{{ f.def }}</span>
                <input v-model="cfg.fieldLabels[f.k]" :placeholder="f.def" />
              </label>
            </div>
          </div>
          <div v-else-if="tab === 'password'" class="setting-section">
            <ChangePassword />
          </div>
          <div v-else-if="tab === 'data'" class="setting-section">
            <h4>数据管理</h4>
            <p class="hint">备份会导出数据库与全部附件为 zip；清空仅删除业务数据，保留账号与系统设置，且不可恢复。</p>
            <button class="btn sm" :disabled="busy" @click="manualBackup">{{ busy ? '备份中…' : '备份' }}</button>
            <div class="danger-zone">
              <div><b>清空本地业务数据</b><span>删除全部合同、项目、相对方、发票、收付款、日志、附件文件</span></div>
              <button class="btn danger sm" @click="openClearDialog">清空数据</button>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" @click="emit('close')">关闭</button>
        <button v-if="tab !== 'password' && tab !== 'data'" class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存设置' }}</button>
      </div>
    </div>

    <!-- 清空数据二次确认 -->
    <div v-if="clearDialog" class="modal-mask" @click.self="clearDialog = false">
      <div class="modal narrow">
        <div class="modal-head"><h3>⚠ 清空本地业务数据</h3><button class="icon-btn" @click="clearDialog = false">✕</button></div>
        <div class="modal-body">
          <div class="clear-warning">
            <p><b>此操作不可恢复！</b>将删除全部合同、项目、相对方、发票、收付款与附件文件。</p>
            <p>账号与系统设置会保留。建议先做一次备份。</p>
          </div>
          <label class="checkbox-field"><input v-model="clearAgree" type="checkbox" /> 我已了解后果，并已备份（如需）</label>
          <label class="field"><span>请输入「清空」以确认</span><input v-model="clearPhrase" placeholder="清空" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="clearDialog = false">取消</button>
          <button class="btn danger" :disabled="clearing || !clearAgree || clearPhrase.trim() !== '清空'" @click="doClear">
            {{ clearing ? '清空中…' : '确认清空' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
