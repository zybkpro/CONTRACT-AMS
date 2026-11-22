<script setup>
import { ref, computed, onMounted } from 'vue'
import { licenseApi } from '../api'
import { toast } from '../utils'
import localWechatQr from '../assets/wechat-cs.png'

const props = defineProps({
  /** 启动校验失败时的初始状态（可为空，组件内自行拉取） */
  initial: { type: Object, default: null },
  /** 是否允许关闭（设置页内打开时可关；启动门禁不可关） */
  closable: { type: Boolean, default: false },
})
const emit = defineEmits(['activated', 'close'])

const code = ref('')
const busy = ref(false)
const checking = ref(true)
const status = ref(props.initial || null)
const errMsg = ref('')

const machineId = computed(() => status.value?.machineId || '')
/** 优先本地打包图，保证离线也能展示客服二维码 */
const wechatQr = computed(() => localWechatQr || status.value?.meta?.wechatQrUrl
  || 'https://zhouqm.oss-cn-beijing.aliyuncs.com/zybkpro/w4.png')
const hint = computed(() => status.value?.message || '请输入激活码，或扫码添加客服获取体验码 / 正式码')

function formatCode(v) {
  const raw = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)
  const parts = []
  for (let i = 0; i < raw.length; i += 4) parts.push(raw.slice(i, i + 4))
  return parts.join('-')
}
function onCodeInput(e) {
  code.value = formatCode(e.target.value)
}

async function refresh() {
  checking.value = true
  errMsg.value = ''
  try {
    status.value = await licenseApi.status()
    if (status.value?.activated) emit('activated', status.value)
  } catch (e) {
    errMsg.value = e.message || '无法读取授权状态'
  } finally {
    checking.value = false
  }
}

async function doActivate() {
  if (!code.value.trim()) return toast('请输入激活码', 'warn')
  busy.value = true
  errMsg.value = ''
  try {
    const r = await licenseApi.activate(code.value)
    if (r.success) {
      toast(r.message || '激活成功', 'success')
      status.value = { activated: true, license: r.data, machineId: r.machineId, meta: r.meta, message: r.message }
      emit('activated', status.value)
    } else {
      errMsg.value = r.message || '激活失败'
      toast(errMsg.value, 'error')
    }
  } catch (e) {
    errMsg.value = e.message || '激活失败'
    toast(errMsg.value, 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (!props.initial) refresh()
  else checking.value = false
})
</script>

<template>
  <div class="modal-mask activation-mask" :class="{ gate: !closable }">
    <div class="modal activation-modal">
      <div class="modal-head">
        <h3>软件授权激活</h3>
        <span class="status">{{ checking ? '正在校验…' : (status?.activated ? '已授权' : '未激活') }}</span>
        <button v-if="closable" class="close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body activation-body">
        <div class="act-left">
          <div class="section-title">输入激活码</div>
          <p class="note mb8">{{ hint }}</p>
          <label class="field-block">
            <span>激活码</span>
            <input
              :value="code"
              type="text"
              class="code-input"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxlength="19"
              autocomplete="off"
              spellcheck="false"
              @input="onCodeInput"
              @keyup.enter="doActivate"
            />
          </label>
          <div v-if="errMsg" class="err-banner mt8">{{ errMsg }}</div>
          <div class="row-flex mt12">
            <button class="btn btn-primary" :disabled="busy || checking" @click="doActivate">
              {{ busy ? '激活中…' : '立即激活' }}
            </button>
            <button class="btn btn-ghost" :disabled="checking" @click="refresh">重新校验</button>
          </div>
          <div class="machine-box mt12">
            <div class="section-title">本机机器码</div>
            <code class="machine-id">{{ machineId || '—' }}</code>
            <p class="note mt8">换机需联系客服解绑后，再在新设备重新激活；到期后请续费购买正式码。</p>
          </div>
        </div>

        <div class="act-right">
          <div class="section-title">添加客服 · 体验 / 购买</div>
          <div class="qr-card">
            <p class="note center mb8">需要<strong>体验码</strong>或<strong>正式授权</strong>？鼠标移入下方区域查看客服微信二维码。</p>
            <div class="qr-hover" tabindex="0" title="鼠标移入显示二维码">
              <div class="qr-placeholder">
                <span class="qr-icon">微信</span>
                <span>鼠标移入显示二维码</span>
                <span class="qr-sub">扫码添加客服 · 体验 / 购买</span>
              </div>
              <img :src="wechatQr" alt="客服微信二维码" class="qr-img" />
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <span class="left-tip">一机一码 · 激活后按套餐计时 · 终身码不过期</span>
        <button v-if="closable" class="btn btn-primary" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activation-mask.gate { z-index: 200; background: rgba(1, 7, 18, .88); }
.activation-modal { width: 820px; }
.activation-body {
  display: grid;
  grid-template-columns: 1.15fr 0.95fr;
  gap: 18px;
  align-items: start;
}
.field-block { display: flex; flex-direction: column; gap: 7px; color: var(--muted); }
.field-block > span { font-size: 12px; }
.code-input {
  width: 100%; height: 40px; font-size: 16px; letter-spacing: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
}
.err-banner {
  padding: 8px 10px; border-radius: 5px;
  background: rgba(255, 107, 107, .12); border: 1px solid rgba(255, 107, 107, .35);
  color: #ffb0b0; font-size: 12.5px; line-height: 1.5;
}
.machine-box {
  padding: 10px 12px; border-radius: 6px;
  border: 1px solid var(--line-soft); background: rgba(6, 26, 52, .45);
}
.machine-id {
  display: block; word-break: break-all; color: var(--cyan);
  font-size: 12px; letter-spacing: .3px;
}
.qr-card {
  padding: 14px 12px 16px; border-radius: 8px; text-align: center;
  border: 1px solid var(--line-soft); background: rgba(6, 26, 52, .45);
}
.qr-card .note { color: var(--muted); }
.qr-card .note strong { color: var(--cyan); font-weight: 700; }
.qr-hover {
  position: relative; width: 100%; max-width: 240px; margin: 0 auto;
  aspect-ratio: 3 / 4; border-radius: 8px; overflow: hidden; cursor: pointer;
  border: 1px dashed rgba(90, 170, 255, .35); background: rgba(4, 20, 42, .7);
}
.qr-placeholder {
  position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); font-size: 13px; transition: opacity .2s ease;
}
.qr-placeholder .qr-icon {
  width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center;
  background: linear-gradient(135deg, rgba(63, 211, 255, .25), rgba(47, 124, 246, .2));
  border: 1px solid rgba(63, 211, 255, .45); color: var(--cyan); font-size: 12px; font-weight: 700;
}
.qr-placeholder .qr-sub { font-size: 11.5px; opacity: .8; }
.qr-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  opacity: 0; transition: opacity .2s ease; background: #fff;
}
.qr-hover:hover .qr-placeholder,
.qr-hover:focus-within .qr-placeholder { opacity: 0; pointer-events: none; }
.qr-hover:hover .qr-img,
.qr-hover:focus-within .qr-img { opacity: 1; }
@media (max-width: 720px) {
  .activation-body { grid-template-columns: 1fr; }
}
</style>
