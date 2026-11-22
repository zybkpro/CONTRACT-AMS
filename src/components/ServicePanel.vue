<script setup>
import { ref, reactive, onMounted, watch, computed } from 'vue'
import QRCode from 'qrcode'
import { service, isDesktop } from '../api'
import { toast } from '../utils'

const status = ref({ running: false, port: 8788, token: '', h5ReadOnly: false, https: false, httpsAvailable: true, canControl: false, urls: [], lanIPs: [], error: '' })
const cfg = reactive({ port: 8788, token: '', h5ReadOnly: false, autoStart: false, https: false })
const qr = ref('')
const busy = ref(false)
const loaded = ref(false)

async function refresh() {
  try {
    const s = await service.status()
    status.value = s
    if (!loaded.value) {
      cfg.port = s.port
      cfg.token = s.token
      cfg.h5ReadOnly = !!s.h5ReadOnly
      cfg.https = !!s.httpsConfigured
      loaded.value = true
    }
    await makeQr(`${s.h5Url}?token=${encodeURIComponent(s.token)}`)
  } catch (e) {
    // 服务未运行是正常状态（可直接点按钮启动），静默切换为「未启动」，不弹错误
    status.value = { ...status.value, running: false, canControl: false, error: '' }
  }
}
async function makeQr(text) {
  try { qr.value = await QRCode.toDataURL(text || 'http://127.0.0.1:8788/h5/', { margin: 1, width: 320, color: { dark: '#06182f', light: '#ffffff' } }) }
  catch (_) { qr.value = '' }
}
const stateClass = computed(() => status.value.error ? 'err' : status.value.running ? 'on' : 'off')
const stateText = computed(() => status.value.error ? '异常' : status.value.running ? '运行中' : '未启动')
// 启停按钮只在「本机」显示：桌面 Electron 壳（file://）或本机浏览器（localhost / 127.0.0.1）。
// 局域网内其它 PC 与手机访问时仅展示状态与访问信息，不提供任何操作控件。
// 与底层权限一致：/api/service/shutdown 与 Vite 启动钩子都只放行回环，远端即使渲染出按钮也调不通。
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]']
const isLocal = typeof location !== 'undefined' &&
  (location.protocol === 'file:' || LOCAL_HOSTS.includes(location.hostname))
const showControls = computed(() => isDesktop || isLocal)

async function toggle() {
  busy.value = true
  try {
    if (status.value.running) {
      await service.stop()
      if (!isDesktop) {
        // 服务已退出，不能再刷新状态；保留静态「未启动」，按钮会变为可再次启动
        status.value = { ...status.value, running: false, canControl: false, error: '' }
        toast('局域网服务已停止，可随时再点按钮启动', 'success')
        return
      }
      toast('局域网服务已停止，桌面功能仍可正常使用', 'success')
    } else {
      const r = await service.start()
      toast(r?.alreadyRunning ? '局域网服务已在运行' : '局域网服务已启动', 'success')
    }
    await refresh()
  } catch (e) { toast(e.message, 'error') }
  finally { busy.value = false }
}
async function saveConfig() {
  busy.value = true
  try {
    const port = Number(cfg.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需为 1024～65535 的整数')
    if (!/^[A-Za-z0-9]{4,16}$/.test(cfg.token)) throw new Error('访问口令需为 4～16 位字母或数字')
    await service.config({ port, token: cfg.token.toUpperCase(), h5ReadOnly: !!cfg.h5ReadOnly,
      autoStart: !!cfg.autoStart, https: !!cfg.https })
    toast('服务配置已保存', 'success')
    await refresh()
  } catch (e) { toast(e.message, 'error') }
  finally { busy.value = false }
}
function newToken() { cfg.token = Math.random().toString(36).slice(2, 8).toUpperCase() }
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('已复制访问地址', 'success')).catch(() => toast('复制失败，请手动选择', 'warn'))
}
onMounted(refresh)
</script>

<template>
  <div>
    <div class="section-title">局域网服务（桌面主机模式）
      <span class="desc">桌面端持有唯一主库，服务停止时本机功能不受影响</span>
    </div>
    <div class="service-grid">
      <div>
        <div class="block">
          <div class="row-flex mb8">
            <span class="state-pill" :class="stateClass"><span class="dot" :class="{ off: !status.running }"></span>{{ stateText }}</span>
            <span class="note">端口 <b>{{ status.port }}</b> · 监听 0.0.0.0</span>
            <button v-if="showControls" class="btn btn-sm" :class="status.running ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="toggle">
              {{ status.running ? '停止局域网服务' : '启动局域网服务' }}
            </button>
            <span v-else class="badge-2">远端访问 · 仅查看状态</span>
          </div>
          <div v-if="status.error" class="warn-text mb8">{{ status.error }}</div>
          <div class="kv">
            <span class="k">本机桌面页</span><span class="v"><code>{{ status.desktopUrl }}</code>
              <button class="btn-link" @click="copy(status.desktopUrl)">复制</button></span>
            <span class="k">H5 访问地址</span><span class="v"><code>{{ status.h5Url }}</code>
              <button class="btn-link" @click="copy(status.h5Url)">复制</button></span>
            <span class="k">局域网 IP</span><span class="v">{{ status.lanIPs?.map(i => i.address).join('、') || '未检测到' }}</span>
            <span class="k">访问口令</span><span class="v"><code style="letter-spacing:2px">{{ status.token }}</code>
              <span class="note">手机首次打开需输入</span></span>
          </div>
          <div class="note mt8">服务启动后，同网段手机 / 电脑访问上方地址即可读写同一份 SQLite 数据。</div>
          <div class="block" style="margin:8px 0 0;padding:9px 11px;border-color:rgba(255,190,77,.35)">
            <div class="section-title" style="margin:0 0 6px;font-size:12px;color:var(--amber)">手机打不开？按顺序排查</div>
            <div class="note" style="line-height:1.9">
              ① 手机与电脑连<b>同一个 WiFi</b>（不要用访客网络 / 移动数据），可先在手机浏览器访问 <code>{{ status.h5Url }}</code> 试试。<br />
              ② <b>放行防火墙</b>：以管理员身份打开 PowerShell / CMD 执行一次<br />
              <code style="display:inline-block;margin:3px 0;padding:3px 6px;word-break:break-all">netsh advfirewall firewall add rule name="IT-AMS LAN" dir=in action=allow protocol=TCP localport={{ status.port }} profile=any</code><br />
              电脑访问 <code>localhost</code> 走回环不受防火墙影响，所以「电脑能开、手机打不开」基本都是这一步。<br />
              ③ 路由器关闭「AP 隔离 / 无线隔离」；④ 手机输入完整地址后填写访问口令（或扫右侧二维码自动带入口令）。
            </div>
          </div>
        </div>

        <div class="block">
          <div class="section-title">服务配置</div>
          <div class="row-flex">
            <label class="field-inline">端口 <input v-model.number="cfg.port" type="number" style="width:100px" /></label>
            <label class="field-inline">访问口令 <input v-model="cfg.token" type="text" style="width:120px" /></label>
            <button class="btn btn-sm" @click="newToken">生成</button>
            <label class="field-inline"><input type="checkbox" v-model="cfg.h5ReadOnly" style="accent-color:var(--cyan)" /> H5 只读</label>
            <label class="field-inline" title="摄像头扫码需要安全上下文">
              <input type="checkbox" v-model="cfg.https" style="accent-color:var(--cyan)" :disabled="!status.httpsAvailable" /> HTTPS（扫码）
            </label>
            <label v-if="isDesktop" class="field-inline"><input type="checkbox" v-model="cfg.autoStart" style="accent-color:var(--cyan)" /> 随桌面启动</label>
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="saveConfig">保存配置</button>
          </div>
          <div class="note mt8">开启「H5 只读」后，远端浏览器仅可查询，所有新增 / 编辑 / 删除 / 导入接口返回 403；但<b>扫码盘点仍可写入</b>，桌面端不受限制。修改端口或协议会自动重启服务。</div>
          <div class="note mt8" style="border-top:1px dashed var(--line);padding-top:8px">
            <b>HTTPS 与摄像头扫码</b>：浏览器只在安全上下文（HTTPS / localhost）下开放摄像头，局域网 <code>http://内网IP</code> 会被禁用。
            开启 HTTPS 后访问地址自动变为 <code>https://…</code>，手机首次打开需信任本机自签证书（点「高级 → 继续访问」）。
            当前：<b>{{ status.https ? 'HTTPS 已启用' : 'HTTP 模式' }}</b>{{ status.httpsAvailable ? '' : '（证书缺失，请检查 packages/api-server/cert/）' }}。
            不方便开启时，H5 端仍可在授权后查阅合同与登记收付款。
          </div>
        </div>
      </div>
      <div>
        <div class="qr-box">
          <img v-if="qr" :src="qr" alt="H5 访问二维码" />
          <span class="tip">手机扫码打开 H5</span>
        </div>
        <div class="note mt8 center">扫码直达（含口令）<br /><b>或手动输入访问地址并填写口令</b></div>
      </div>
    </div>
  </div>
</template>
