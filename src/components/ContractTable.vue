<script setup>
import { computed } from 'vue'
import { STATUS_META, DIRECTION_META, LIST_COLUMNS, formatMoney, daysUntil, maskValue, ROLE_LABEL } from '../utils'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, default: () => LIST_COLUMNS },
  selectedId: { type: String, default: '' },
  role: { type: String, default: 'admin' },
  mask: { type: Boolean, default: true },
  remindDays: { type: Array, default: () => [30, 15, 7] },
  fieldLabels: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['select', 'action', 'sort'])

const maxRemind = computed(() => Math.max(30, ...(props.remindDays || [])))

function cellClass(row, key) {
  if (key === 'direction') return DIRECTION_META[row.direction]?.tag || ''
  if (key === 'status') return STATUS_META[row.status]?.tag || ''
  return ''
}
function cellText(row, key) {
  let v = row[key]
  if (key === 'project_name' && !v) return '—'
  if (key === 'amount') return `¥${formatMoney(v)}`
  if (key === 'party_name' && props.mask) return maskValue(v, 2)
  return v ?? ''
}
function dueInfo(row) {
  if (row.archived || ['已完成', '已终止'].includes(row.status)) return null
  const d = daysUntil(row.end_date)
  if (d === null) return null
  if (d < 0) return { text: `已过期 ${-d} 天`, cls: 'due-over' }
  if (d <= maxRemind.value) return { text: `${d} 天后到期`, cls: 'due-soon' }
  return null
}
</script>

<template>
  <div class="table-wrap">
    <table class="grid-table">
      <thead>
        <tr>
          <th class="col-actions">操作</th>
          <th v-for="c in columns" :key="c.key" :style="{ width: c.width + 'px', textAlign: c.align || 'left' }">
            {{ fieldLabels[c.key] || c.label }}
          </th>
          <th class="col-due">到期</th>
          <th class="col-life">日志</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ selected: row.id === selectedId, archived: row.archived }"
            @click="emit('select', row.id)">
          <td class="col-actions" @click.stop>
            <button class="mini-btn" title="编辑" @click="emit('action', { type: 'edit', row })">✎</button>
            <button v-if="!row.archived" class="mini-btn" title="更多" @click="emit('action', { type: 'more', row })">⋯</button>
            <button v-else class="mini-btn" title="解档" @click="emit('action', { type: 'unarchive', row })">↩</button>
          </td>
          <td v-for="c in columns" :key="c.key" :style="{ textAlign: c.align || 'left' }">
            <template v-if="c.key === 'title'">
              <span class="title-cell">{{ cellText(row, c.key) }}</span>
              <span v-if="row.parent_id" class="sub-tag">补充协议</span>
            </template>
            <span v-else class="tag-cell" :class="cellClass(row, c.key)">{{ cellText(row, c.key) }}</span>
          </td>
          <td class="col-due">
            <span v-if="dueInfo(row)" class="due-tag" :class="dueInfo(row).cls">{{ dueInfo(row).text }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="col-life" @click.stop>
            <button class="mini-btn" title="生命周期日志" @click="emit('action', { type: 'logs', row })">🕘</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-row">暂无合同，点击「新增合同」开始，或先下载导入模板。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.col-actions { width: 74px; }
.col-life { width: 48px; }
.col-due { width: 96px; }
.muted { color: #58738a; }
.title-cell { color: #e6f2ff; font-weight: 500; }
.sub-tag { margin-left: 6px; font-size: 10px; padding: 1px 5px; border-radius: 3px; color: #ffbe4d; border: 1px solid rgba(255,190,77,.35); }
.due-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
.due-soon { color: #ffbe4d; background: rgba(255,190,77,.12); }
.due-over { color: #ff6b6b; background: rgba(255,107,107,.12); }
</style>
