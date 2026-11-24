<script setup>
import { ref, computed, onMounted } from 'vue'

const TOKEN_KEY = 'contractams-lan-token'
const SESSION_KEY = 'contractams-session'
const USER_KEY = 'contractams-current-user'
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || '' } catch (_) { return '' } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch (_) {} }
function getSession() { try { return localStorage.getItem(SESSION_KEY) || '' } catch (_) { return '' } }
function setSession(t, u) {
  try {
    t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY)
    u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY)
  } catch (_) {}
}
function getCurrentUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch (_) { return null } }

const phase = ref('token') // token → app（口令即门禁，无需账号密码）
const tokenInput = ref('')
const currentUser = ref(null)
const msg = ref(''), busy = ref(false)
const contracts = ref([]), keyword = ref('')
const detail = ref(null), payForm = ref({ amount: 0, pay_date: new Date().toISOString().slice(0,10), method: '银行转账', remark: '' })
const ROLE_LABEL = { admin: '管理员', biz: '商务', pm: '项目经理', finance: '财务' }

function flash(t) { msg.value = t; setTimeout(() => { if (msg.value === t) msg.value = '' }, 3000) }
async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const lan = getToken(); if (lan) headers['X-CONTRACTAMS-Token'] = lan
  const session = getSession(); if (session) headers['X-CONTRACTAMS-Session'] = session
  const res = await fetch(path, { ...options, headers })
  let json
  try { json = await res.json() } catch (_) { throw new Error(`服务异常（${res.status}）`) }
  if (!res.ok || json.ok === false) {
    const e = new Error(json.error || '请求失败')
    if (json.code === 'UNAUTHORIZED' || res.status === 401) {
      setToken(''); phase.value = 'token'
    }
    throw e
  }
  return json.data
}

async function connectToken() {
  const t = tokenInput.value.trim().toUpperCase()
  if (!t) return flash('请输入局域网访问口令')
  busy.value = true
  try {
    const d = await req('/api/auth', { method: 'POST', body: JSON.stringify({ token: t }) })
    setToken(t); tokenInput.value = ''
    // 口令校验通过即签发会话，直接进入主界面（无需账号密码）
    if (d?.session?.token) {
      setSession(d.session.token, d.session.user)
      currentUser.value = d.session.user
      phase.value = 'app'
      await load()
    } else {
      flash('服务未返回登录会话，请确认已升级到最新版本')
    }
  } catch (e) { flash(e.message) } finally { busy.value = false }
}
async function load() {
  try { const d = await req('/api/bootstrap'); contracts.value = d.contracts || [] }
  catch (e) { flash(e.message) }
}
function logoutAll() {
  setToken(''); setSession('', null)
  currentUser.value = null; contracts.value = []; detail.value = null
  phase.value = 'token'
}

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return contracts.value.filter((c) => !c.archived && (!kw || [c.contract_no, c.title, c.owner].some((v) => String(v||'').toLowerCase().includes(kw))))
})
function openDetail(id) {
  req(`/api/contracts/${encodeURIComponent(id)}`).then((d) => { detail.value = { ...d, payment_plans: d.payment_plans || [] }; payForm.value.plan_id = '' }).catch((e) => flash(e.message))
}
async function submitPay() {
  if (!(Number(payForm.value.amount) > 0)) return flash('金额须大于 0')
  try {
    await req('/api/payment-records', { method: 'POST', body: JSON.stringify({ contractId: detail.value.id, ...payForm.value }) })
    flash('登记成功'); await openDetail(detail.value.id); await load()
  } catch (e) { flash(e.message) }
}

onMounted(async () => {
  const urlToken = new URLSearchParams(location.search).get('token')
  if (urlToken) { setToken(urlToken.toUpperCase()); tokenInput.value = urlToken.toUpperCase() }
  // 已有会话：校验后直接进入（无需重新输口令）
  if (getSession()) {
    try {
      const d = await req('/api/current')
      if (d.user) { currentUser.value = d.user; phase.value = 'app'; await load(); return }
    } catch (_) {}
    setSession('', null)
  }
  // 只有口令没会话（旧版本残留）：清掉，回到口令页重新进入
  if (getToken() && !getSession()) setToken('')
})
</script>

<template>
  <div class="h5-app">
    <header class="h5-head">
      <h1>合同管理系统 <small>移动查阅</small></h1>
      <button v-if="phase === 'app'" class="h5-btn ghost" @click="logoutAll">退出</button>
    </header>

    <div v-if="msg" class="h5-msg">{{ msg }}</div>

    <!-- 局域网口令（口令即门禁，输入后直接进入） -->
    <div v-if="phase === 'token'" class="h5-login">
      <p>请输入局域网访问口令。</p>
      <input v-model="tokenInput" type="text" placeholder="局域网访问口令" @keyup.enter="connectToken" />
      <button class="h5-btn primary" :disabled="busy" @click="connectToken">{{ busy ? '进入中…' : '进入' }}</button>
    </div>

    <!-- 主界面 -->
    <template v-else>
      <div class="h5-search">
        <input v-model="keyword" placeholder="搜索编号 / 名称 / 负责人" />
        <span class="h5-role">{{ currentUser?.name }} · {{ ROLE_LABEL[currentUser?.role] || currentUser?.role }}</span>
      </div>
      <div class="h5-list">
        <div v-for="c in filtered" :key="c.id" class="h5-card" @click="openDetail(c.id)">
          <div class="h5-card-top"><b>{{ c.contract_no }}</b><span class="h5-tag">{{ c.status }}</span></div>
          <div class="h5-card-title">{{ c.title }}</div>
          <div class="h5-card-meta">{{ c.direction }} · {{ c.type }} · {{ c.project_name || '无项目' }}</div>
          <div class="h5-card-meta">¥{{ Number(c.amount||0).toLocaleString() }} · 到期 {{ c.end_date || '—' }} · {{ c.owner }}</div>
        </div>
        <div v-if="!filtered.length" class="h5-empty">暂无合同</div>
      </div>
    </template>

    <div v-if="detail" class="h5-detail-mask" @click.self="detail = null">
      <div class="h5-detail">
        <div class="h5-detail-head"><h2>{{ detail.contract_no }}</h2><button class="h5-btn ghost" @click="detail = null">关闭</button></div>
        <h3>{{ detail.title }}</h3>
        <div class="h5-kv"><span>方向/类型</span><b>{{ detail.direction }} · {{ detail.type }}</b></div>
        <div class="h5-kv"><span>相对方</span><b>{{ detail.party_name }}</b></div>
        <div class="h5-kv"><span>项目</span><b>{{ detail.project_name || '—' }}</b></div>
        <div class="h5-kv"><span>金额</span><b>¥{{ Number(detail.amount||0).toLocaleString() }}</b></div>
        <div class="h5-kv"><span>起止</span><b>{{ detail.start_date || '—' }} ~ {{ detail.end_date || '—' }}</b></div>
        <div class="h5-kv"><span>负责人</span><b>{{ detail.owner || '—' }}</b></div>
        <div class="h5-kv"><span>已收/已付</span><b>¥{{ Number(detail.summary?.received||0).toLocaleString() }} / ¥{{ Number(detail.summary?.paid||0).toLocaleString() }}</b></div>
        <h3 class="h5-sub-title">登记收付款流水</h3>
        <div class="h5-form">
          <select v-model="payForm.plan_id"><option value="">— 计划外 —</option><option v-for="pp in detail.payment_plans" :key="pp.id" :value="pp.id">{{ pp.seq }} · {{ pp.direction }}</option></select>
          <input v-model.number="payForm.amount" type="number" placeholder="金额" />
          <input v-model="payForm.pay_date" type="date" />
          <input v-model="payForm.method" placeholder="方式（银行转账/承兑）" />
          <input v-model="payForm.remark" placeholder="备注" />
          <button class="h5-btn primary" @click="submitPay">登记流水</button>
        </div>
        <div v-if="detail.payment_records?.length" class="h5-records">
          <h3 class="h5-sub-title">最近流水</h3>
          <div v-for="pr in detail.payment_records.slice(0,8)" :key="pr.id" class="h5-kv"><span>{{ pr.pay_date }} {{ pr.method }}</span><b>¥{{ Number(pr.amount||0).toLocaleString() }}</b></div>
        </div>
      </div>
    </div>
  </div>
</template>
