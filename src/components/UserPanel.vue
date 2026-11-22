<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api'
import { toast, ROLE_LABEL } from '../utils'

const props = defineProps({ currentUser: { type: Object, default: null } })
const users = ref([])
const loading = ref(false)
const dialog = ref(false)
const editing = ref(null)
const form = ref({})
const confirmDel = ref(null)
const keyword = ref('')

const ROLE_KEYS = ['admin', 'biz', 'pm', 'finance']
const filtered = computed(() => users.value.filter((u) =>
  !keyword.value.trim() || [u.username, u.name, u.role_label].some((v) => String(v || '').toLowerCase().includes(keyword.value.trim().toLowerCase()))))

async function load() {
  loading.value = true
  try { const d = await api.users(); users.value = d.list || [] }
  catch (e) { toast(e.message, 'error') }
  finally { loading.value = false }
}
onMounted(load)

function openNew() {
  editing.value = null
  form.value = { username: '', name: '', password: '123456', role: 'biz', owner_name: '', status: '启用', remark: '' }
  dialog.value = true
}
function openEdit(u) {
  editing.value = u
  form.value = { username: u.username, name: u.name, password: '', role: u.role, owner_name: u.owner_name, status: u.status, remark: u.remark }
  dialog.value = true
}
async function save() {
  if (!form.value.name.trim()) { toast('请输入姓名', 'error'); return }
  if (!editing.value && !/^[a-z0-9_.-]{3,20}$/.test(form.value.username)) { toast('账号须为 3-20 位小写字母/数字/下划线/点/横线', 'error'); return }
  try {
    if (editing.value) await api.updateUser(editing.value.id, form.value)
    else await api.createUser(form.value)
    toast(editing.value ? '已更新' : '已新增', 'success')
    dialog.value = false; await load()
  } catch (e) { toast(e.message, 'error') }
}
async function remove() {
  const u = confirmDel.value
  try { await api.deleteUser(u.id); toast(`已删除账号【${u.username}】`, 'success'); confirmDel.value = null; await load() }
  catch (e) { toast(e.message, 'error'); confirmDel.value = null }
}
function roleTag(r) { return { admin: 'tag-cyan', biz: 'tag-blue', pm: 'tag-amber', finance: 'tag-green' }[r] || 'tag-gray' }
</script>

<template>
  <div class="user-panel">
    <div class="panel-toolbar">
      <input v-model="keyword" class="inline-input" placeholder="搜索账号 / 姓名 / 角色" />
      <button v-if="currentUser?.role === 'admin'" class="btn primary sm" @click="openNew">＋ 新增人员</button>
      <span class="hint">角色固定四种：管理员 / 商务 / 项目经理 / 财务</span>
    </div>

    <div class="table-wrap">
      <table class="grid-table">
        <thead>
          <tr><th>账号</th><th>姓名</th><th>角色</th><th>负责项目人</th><th>状态</th><th>超级管理员</th><th>创建时间</th><th style="width:100px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in filtered" :key="u.id">
            <td>{{ u.username }}</td>
            <td>{{ u.name }}</td>
            <td><span class="tag-cell" :class="roleTag(u.role)">{{ u.role_label }}</span></td>
            <td>{{ u.owner_name || '—' }}</td>
            <td><span class="tag-cell" :class="u.status === '启用' ? 'tag-green' : 'tag-gray'">{{ u.status }}</span></td>
            <td><span v-if="u.is_super" class="tag-cell tag-amber">超级管理员</span><span v-else class="muted">—</span></td>
            <td>{{ u.created_at }}</td>
            <td v-if="currentUser?.role === 'admin'">
              <button class="mini-btn" @click="openEdit(u)">编辑</button>
              <button v-if="!u.is_super" class="mini-btn danger" @click="confirmDel = u">删除</button>
              <span v-else class="muted" title="超级管理员不可删除">🔒</span>
            </td>
            <td v-else class="muted">无权限</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="8" class="empty-row">{{ loading ? '加载中…' : '暂无人员' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="hint" style="margin-top:12px">
      · 项目经理的「负责项目人」决定其可见的项目合同范围；<br />
      · 财务为只读 + 登记收付款；商务可维护合同；管理员拥有全部权限；<br />
      · 超级管理员内置，不可删除、不可降级或停用；默认四个账号初始密码均为 123456，可在编辑时修改。
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="dialog" class="modal-mask" @click.self="dialog = false">
      <div class="modal">
        <div class="modal-head"><h3>{{ editing ? '编辑人员' : '新增人员' }}</h3><button class="icon-btn" @click="dialog=false">✕</button></div>
        <div class="modal-body form-grid">
          <label class="field"><span>账号 *</span><input v-model="form.username" :disabled="!!editing" placeholder="如 zhangsan" /></label>
          <label class="field"><span>姓名 *</span><input v-model="form.name" /></label>
          <label class="field"><span>角色 *</span>
            <select v-model="form.role"><option v-for="r in ROLE_KEYS" :key="r" :value="r">{{ ROLE_LABEL[r] }}</option></select>
          </label>
          <label class="field"><span>密码（留空不改）</span><input v-model="form.password" type="text" :placeholder="editing ? '留空保持原密码' : '默认 123456'" /></label>
          <label class="field"><span>负责项目人（项目经理用）</span><input v-model="form.owner_name" placeholder="如 张伟" /></label>
          <label class="field"><span>状态</span><select v-model="form.status"><option>启用</option><option>停用</option></select></label>
          <label class="field full"><span>备注</span><input v-model="form.remark" /></label>
        </div>
        <div class="modal-foot"><button class="btn ghost" @click="dialog=false">取消</button><button class="btn primary" @click="save">保存</button></div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="confirmDel" class="modal-mask" @click.self="confirmDel = null">
      <div class="modal narrow">
        <div class="modal-head"><h3>删除账号</h3><button class="icon-btn" @click="confirmDel=null">✕</button></div>
        <div class="modal-body">确定删除账号【{{ confirmDel.username }}】（{{ confirmDel.name }}）？该账号的会话将立即失效。</div>
        <div class="modal-foot"><button class="btn ghost" @click="confirmDel=null">取消</button><button class="btn danger" @click="remove">确认删除</button></div>
      </div>
    </div>
  </div>
</template>
