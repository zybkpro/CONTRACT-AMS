<script setup>
import { ref } from 'vue'
import { api } from '../api'
import { toast, readExcelFile, parseContractImport, downloadTemplate } from '../utils'

const emit = defineEmits(['close', 'imported'])
const aoa = ref([])
const parsed = ref([])
const result = ref(null)
const busy = ref(false)

async function onFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  try {
    aoa.value = await readExcelFile(file)
    parsed.value = parseContractImport(aoa.value)
    result.value = null
    toast(`已读取 ${parsed.value.length} 行，请确认导入`, 'info')
  } catch (err) { toast(err.message, 'error') }
}
async function doImport() {
  if (!parsed.value.length) { toast('请先选择 Excel 文件', 'error'); return }
  busy.value = true
  try {
    result.value = await api.importContracts(parsed.value)
    if (result.value.created) { toast(`成功导入 ${result.value.created} 条`, 'success'); emit('imported') }
  } catch (e) { toast(e.message, 'error') } finally { busy.value = false }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head"><h3>导入合同台账</h3><button class="icon-btn" @click="emit('close')">✕</button></div>
      <div class="modal-body">
        <div class="import-tip">
          <p>支持 .xlsx。列头需与模板一致；合同编号留空将自动生成；相对方/项目按名称自动关联（需已存在）。</p>
          <button class="link-btn" @click="downloadTemplate">下载导入模板 ↓</button>
        </div>
        <input type="file" accept=".xlsx,.xls" @change="onFile" />
        <div v-if="parsed.length" class="import-preview">
          <div class="muted">预览前 5 行（共 {{ parsed.length }} 行）</div>
          <table class="mini-table">
            <thead><tr><th>编号</th><th>名称</th><th>方向</th><th>类型</th><th>相对方</th><th>金额</th></tr></thead>
            <tbody><tr v-for="r in parsed.slice(0,5)" :key="r.__rowNo">
              <td>{{ r.contract_no || '自动生成' }}</td><td>{{ r.title }}</td><td>{{ r.direction }}</td><td>{{ r.type }}</td><td>{{ r.party_name }}</td><td>{{ r.amount }}</td>
            </tr></tbody>
          </table>
        </div>
        <div v-if="result" class="import-result">
          <div>成功 {{ result.created }} 条，失败 {{ result.failed.length }} 条</div>
          <div v-for="f in result.failed" :key="f.row" class="err-line">第 {{ f.row }} 行：{{ f.reason }}</div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn ghost" @click="emit('close')">关闭</button><button class="btn primary" :disabled="busy || !parsed.length" @click="doImport">{{ busy ? '导入中…' : '确认导入' }}</button></div>
    </div>
  </div>
</template>
