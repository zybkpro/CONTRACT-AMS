<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api'
import { toast, formatMoney } from '../utils'

// 回收站（V1.2 软删除）：已删除合同可恢复，彻底删除才移除附件
const emit = defineEmits(['close', 'restored'])
const list = ref([])
const keepDays = ref(30)
const busy = ref(false)
const confirmPurge = ref('') // 输入 ID 前若干位确认彻底删除
const target = ref(null)

async function load() {
  try {
    const d = await api.recycleList()
    list.value = d.list || []
    keepDays.value = d.keepDays ?? 30
  } catch (e) { toast(e.message, 'error') }
}
onMounted(load)

async function restore(c) {
  busy.value = true
  try {
    await api.recycleRestore(c.id)
    toast(`已恢复：${c.contract_no}`, 'success')
    await load()
    emit('restored')
  } catch (e) { toast(e.message, 'error') }
  finally { busy.value = false }
}
function askPurge(c) { target.value = c; confirmPurge.value = '' }
async function doPurge() {
  if (!target.value) return
  if (confirmPurge.value.trim().toUpperCase() !== target.value.contract_no.toUpperCase()) {
    toast('请输入完整的合同编号以确认彻底删除', 'error'); return
  }
  busy.value = true
  try {
    await api.recyclePurge(target.value.id)
    toast('已彻底删除，附件已移除', 'success')
    target.value = null
    await load()
  } catch (e) { toast(e.message, 'error') }
  finally { busy.value = false }
}
async function emptyAll() {
  if (!list.value.length) return
  if (!window.confirm(`确定清空回收站？将彻底删除 ${list.value.length} 份合同及其附件，不可恢复。`)) return
  busy.value = true
  try {
    const r = await api.recycleEmpty()
    toast(`已彻底删除 ${r.purged} 份合同`, 'success')
    await load()
  } catch (e) { toast(e.message, 'error') }
  finally { busy.value = false }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-lg modal-settings">
      <div class="modal-head"><h3>回收站 · 已删除合同</h3><button class="icon-btn" @click="emit('close')">✕</button></div>
      <div class="modal-body">
        <p class="hint">删除的合同与附件会保留在此，{{ keepDays > 0 ? `${keepDays} 天内` : '永久' }}可原样恢复。只有「彻底删除」才会移除扫描件与附件文件。</p>
        <div class="row-flex" style="justify-content:flex-end;margin-bottom:10px">
          <button class="btn danger sm" :disabled="busy || !list.length" @click="emptyAll">清空回收站</button>
        </div>
        <div v-if="!list.length" class="h5-empty">回收站为空</div>
        <table v-else class="mini-table">
          <thead><tr><th>合同编号</th><th>名称</th><th>类型</th><th>金额</th><th>附件</th><th>删除时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="c in list" :key="c.id">
              <td><b>{{ c.contract_no }}</b></td>
              <td>{{ c.title }}</td>
              <td>{{ c.direction }} / {{ c.type }}</td>
              <td>¥{{ formatMoney(c.amount || 0, 0) }}</td>
              <td>{{ c.fileCount }} 份</td>
              <td>{{ c.deleted_at }}</td>
              <td>
                <button class="btn sm" :disabled="busy" @click="restore(c)">恢复</button>
                <button class="btn danger sm" :disabled="busy" @click="askPurge(c)">彻底删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="target" class="danger-zone" style="margin-top:12px">
          <div><b>彻底删除 {{ target.contract_no }}</b><span>附件文件将从主机数据目录移除，不可恢复</span></div>
          <input v-model="confirmPurge" :placeholder="`请输入 ${target.contract_no} 确认`" style="max-width:220px" />
          <button class="btn danger sm" :disabled="busy || confirmPurge.trim().toUpperCase() !== target.contract_no.toUpperCase()" @click="doPurge">确认彻底删除</button>
          <button class="btn ghost sm" @click="target = null">取消</button>
        </div>
      </div>
      <div class="modal-foot"><button class="btn ghost" @click="emit('close')">关闭</button></div>
    </div>
  </div>
</template>
