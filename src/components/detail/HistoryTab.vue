<script setup>
import { ref, watch } from 'vue'
import { api } from '../../api'
import { toast, exportLogsToExcel } from '../../utils'

const props = defineProps({ contractId: { type: String, default: '' } })
const logs = ref([])
const loading = ref(false)
const keyword = ref('')

async function load() {
  if (!props.contractId) return
  loading.value = true
  try { const d = await api.logs(props.contractId); logs.value = d.list || [] }
  catch (e) { toast(e.message, 'error') }
  finally { loading.value = false }
}
watch(() => props.contractId, load, { immediate: true })

const filtered = () => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return logs.value
  return logs.value.filter((l) => [l.event_type, l.content, l.operator, l.contract_no, l.target].some((v) => String(v || '').toLowerCase().includes(kw)))
}
function exportCsv() { exportLogsToExcel(filtered(), `生命周期日志_${props.contractId}.xlsx`) }
</script>

<template>
  <div class="history-tab">
    <div class="history-tools">
      <input v-model="keyword" class="inline-input" placeholder="筛选事件 / 操作人 / 摘要" />
      <span class="muted">共 {{ logs.length }} 条 · 只追加不可篡改</span>
      <button class="btn sm" @click="exportCsv">导出日志</button>
    </div>
    <div class="timeline">
      <div v-for="l in filtered()" :key="l.id" class="tl-item">
        <div class="tl-dot"></div>
        <div class="tl-content">
          <div class="tl-title">
            <span class="tag-cell tag-blue">{{ l.event_type }}</span>
            <span class="tl-text">{{ l.content }}</span>
          </div>
          <div class="tl-meta">{{ l.created_at }} · {{ l.operator || '—' }} · 来源 {{ l.source || 'desktop' }}
            <template v-if="l.target"> · {{ l.target }}</template>
            <template v-if="l.before_value || l.after_value"> · {{ l.before_value || '空' }} → {{ l.after_value || '空' }}</template>
          </div>
        </div>
      </div>
      <div v-if="!filtered().length" class="empty-row">{{ loading ? '加载中…' : '暂无日志' }}</div>
    </div>
  </div>
</template>
