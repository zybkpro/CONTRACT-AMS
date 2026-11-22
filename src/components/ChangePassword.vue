<script setup>
import { ref } from 'vue'
import { api, getCurrentUser } from '../api'
import { toast, ROLE_LABEL } from '../utils'

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const err = ref('')
const user = getCurrentUser()

async function submit() {
  err.value = ''
  if (!oldPassword.value) { err.value = '请输入原密码'; return }
  if (newPassword.value.length < 6) { err.value = '新密码至少 6 位'; return }
  if (newPassword.value !== confirmPassword.value) { err.value = '两次输入的新密码不一致'; return }
  busy.value = true
  try {
    await api.changePassword(oldPassword.value, newPassword.value)
    toast('密码已修改，下次登录请使用新密码', 'success')
    oldPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''
  } catch (e) { err.value = e.message || '修改失败' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="change-password">
    <h4>修改登录密码</h4>
    <p class="hint">当前账号：{{ user?.name }}（{{ user?.username }} · {{ ROLE_LABEL[user?.role] || user?.role }}）。修改后当前会话保持有效，下次登录使用新密码。</p>
    <div class="form-grid" style="max-width: 460px">
      <label class="field full"><span>原密码</span><input v-model="oldPassword" type="password" placeholder="请输入当前密码" /></label>
      <label class="field full"><span>新密码</span><input v-model="newPassword" type="password" placeholder="至少 6 位" /></label>
      <label class="field full"><span>确认新密码</span><input v-model="confirmPassword" type="password" placeholder="再次输入新密码" @keyup.enter="submit" /></label>
      <div v-if="err" class="form-error full">{{ err }}</div>
    </div>
    <button class="btn primary" style="margin-top: 14px" :disabled="busy" @click="submit">{{ busy ? '修改中…' : '确认修改' }}</button>
  </div>
</template>
