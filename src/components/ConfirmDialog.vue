<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
const props = defineProps({
  title: { type: String, default: '确认' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '是(Y)' },
  cancelText: { type: String, default: '否(N)' },
  danger: { type: Boolean, default: false },
  note: { type: String, default: '' },
})
const emit = defineEmits(['confirm', 'cancel'])
function onKey(e) {
  if (e.key === 'Escape' || e.key.toLowerCase() === 'n') emit('cancel')
  else if (e.key.toLowerCase() === 'y' || e.key === 'Enter') emit('confirm')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="modal-mask" @mousedown.self="emit('cancel')">
    <div class="modal narrow">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <span class="status">此操作不可撤销</span>
        <button class="close" @click="emit('cancel')">×</button>
      </div>
      <div class="modal-body">
        <div class="warn-text">{{ message }}</div>
        <div class="note mt12">{{ note || '关联的图片与附件文件将一并从主机数据目录清除，操作会保留在日志中供导出追溯。' }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="emit('cancel')">{{ cancelText }}</button>
        <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>
