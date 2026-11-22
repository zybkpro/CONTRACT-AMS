<script setup>
import { ref, computed, onMounted } from 'vue'
import { api, setSession } from '../api'
import { ROLE_LABEL } from '../utils'

const emit = defineEmits(['logged-in'])
const username = ref('')
const password = ref('')
const busy = ref(false)
const err = ref('')
const checking = ref(true)
const quickAccounts = [
  { username: 'admin', label: '超级管理员', pwd: '123456' },
]

onMounted(async () => {
  // 已有有效会话则直接放行
  try {
    const d = await api.current()
    if (d.user) emit('logged-in', d.user, true)
  } catch (_) {} finally { checking.value = false }
})

function useQuick(a) { username.value = a.username; password.value = a.pwd; err.value = '' }

async function login() {
  err.value = ''
  if (!username.value.trim() || !password.value) { err.value = '请输入账号和密码'; return }
  busy.value = true
  try {
    const d = await api.login(username.value.trim(), password.value)
    setSession(d.token, d.user)
    emit('logged-in', d.user, false)
  } catch (e) { err.value = e.message || '登录失败' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="login-gate">
    <div class="login-card">
      <div class="login-brand">
        <div class="brand-mark"><span>合</span></div>
        <div><h1>合同管理系统</h1><p>请登录后使用</p></div>
      </div>
      <div v-if="checking" class="login-checking">正在校验会话…</div>
      <template v-else>
        <div class="login-form">
          <label class="field"><span>账号</span><input v-model="username" placeholder="用户名" @keyup.enter="login" /></label>
          <label class="field"><span>密码</span><input v-model="password" type="password" placeholder="密码" @keyup.enter="login" /></label>
          <div v-if="err" class="login-err">{{ err }}</div>
          <button class="btn primary login-submit" :disabled="busy" @click="login">{{ busy ? '登录中…' : '登录' }}</button>
        </div>
        <div class="login-quick">
          <div class="login-quick-title">演示账号（点击填入，密码 123456）</div>
          <div class="login-quick-grid">
            <button v-for="a in quickAccounts" :key="a.username" @click="useQuick(a)">
              <b>{{ a.label }}</b><span>{{ a.username }}</span>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
