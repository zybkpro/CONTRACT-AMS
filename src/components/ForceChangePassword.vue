<script setup>
import { ref } from 'vue'
import { api, getCurrentUser, getSession, setSession } from '../api'
import { toast, ROLE_LABEL } from '../utils'

// 首次登录强制改密：不可取消，改成功后才放行
const emit = defineEmits(['done'])
const user = getCurrentUser()
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const err = ref('')

async function submit() {
  err.value = ''
  if (!oldPassword.value) { err.value = '请输入当前密码'; return }
  if (newPassword.value.length < 6) { err.value = '新密码至少 6 位'; return }
  if (newPassword.value !== confirmPassword.value) { err.value = '两次输入的新密码不一致'; return }
  if (newPassword.value === oldPassword.value) { err.value = '新密码不能与原密码相同'; return }
  busy.value = true
  try {
    await api.changePassword(oldPassword.value, newPassword.value)
    // 保留原会话 token，只更新本地 user 的标志；改密后端已保持会话有效
    const nextUser = { ...(user || {}), must_change_password: false }
    setSession(getSession(), nextUser)
    toast('密码已修改，请牢记新密码', 'success')
    emit('done', nextUser)
  } catch (e) { err.value = e.message || '修改失败' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="modal-mask force-mask">
    <div class="modal narrow">
      <div class="modal-head"><h3>首次登录 · 请修改初始密码</h3></div>
      <div class="modal-body">
        <p class="hint">出于安全考虑，首次使用必须修改初始密码（123456）。当前账号：{{ user?.name }}（{{ user?.username }} · {{ ROLE_LABEL[user?.role] || user?.role }}）。</p>
        <div class="form-grid" style="max-width: 460px">
          <label class="field full"><span>当前密码</span><input v-model="oldPassword" type="password" placeholder="初始密码 123456" /></label>
          <label class="field full"><span>新密码</span><input v-model="newPassword" type="password" placeholder="至少 6 位" /></label>
          <label class="field full"><span>确认新密码</span><input v-model="confirmPassword" type="password" placeholder="再次输入新密码" @keyup.enter="submit" /></label>
          <div v-if="err" class="form-error full">{{ err }}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" :disabled="busy" @click="submit">{{ busy ? '修改中…' : '确认修改并继续' }}</button>
      </div>
    </div>
  </div>
</template>
