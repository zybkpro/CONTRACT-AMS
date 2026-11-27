'use strict'
/** V1.4 激活码加固联调：弱网宽限期 / 机器指纹 / 换机锁定 / 正式包禁 skip / 试用不受影响 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'contractams-lic-'))
process.env.CONTRACTAMS_DATA_DIR = DATA_DIR

const db = require('../packages/api-server/db')
const license = require('../packages/api-server/license')
const { assertProductionLicenseSafe } = require('./lib/license-guard')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name, extra === undefined ? '' : extra) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra) }
}
const licFile = () => path.join(DATA_DIR, 'license.json')

async function main() {
  await db.init()
  const mid = license.getMachineId()

  console.log('\n== 免费试用（CONTRACT 独有，须保留） ==')
  const trial = license.trialStatus(mid)
  ok('默认 7 天试用中', trial.inTrial && trial.totalDays === 7, `剩余 ${trial.daysLeft} 天`)
  const stTrial = await license.getStatus()
  ok('试用状态下 getStatus 放行', stTrial.activated && stTrial.inTrial)

  console.log('\n== 机器指纹加固 ==')
  ok('machineId 为 32位 hash', /^[0-9a-f]{32}$/.test(mid), mid)
  ok('重启后指纹稳定', license.getMachineId() === mid)
  ok('machine_id 文件存的是种子UUID', /^[0-9a-f-]{36}$/.test(fs.readFileSync(path.join(DATA_DIR, 'machine_id'), 'utf8').trim()))

  console.log('\n== 激活 / verify 成功 ==')
  global.fetch = async () => ({ status: 200, json: async () => ({
    success: true, data: { code: 'TEST-XXXX-XXXX-XXXX', machineId: mid, planType: 'lifetime', planLabel: '终身', expiresAt: null },
  }) })
  const act = await license.activate('TEST-XXXX-XXXX-XXXX')
  ok('激活成功', act.success)
  const licRaw = fs.readFileSync(licFile(), 'utf8')
  ok('license.json 含 lastOnlineOkAt', /lastOnlineOkAt/.test(licRaw))
  ok('verify 通过', (await license.getStatus()).activated)

  console.log('\n== 弱网宽限期 ==')
  global.fetch = async () => { throw new Error('network down') }
  const off = await license.getStatus()
  ok('宽限期内临时放行', off.activated && off.offline, `剩余 ${off.offlineDaysLeft} 天`)
  ok('提示含离线与宽限文案', /临时离线模式/.test(off.message) && /宽限/.test(off.message))

  // 篡改 lastOnlineOkAt 为 8 天前
  const l = JSON.parse(fs.readFileSync(licFile(), 'utf8'))
  l.lastOnlineOkAt = new Date(Date.now() - 8 * 86400000).toISOString()
  fs.writeFileSync(licFile(), JSON.stringify(l))
  const expired = await license.getStatus()
  ok('超宽限期锁定', !expired.activated && /超过/.test(expired.message))

  console.log('\n== 换机检测 ==')
  const l2 = JSON.parse(fs.readFileSync(licFile(), 'utf8'))
  l2.machineId = 'another-machine-id'
  l2.lastOnlineOkAt = new Date().toISOString()
  fs.writeFileSync(licFile(), JSON.stringify(l2))
  const mm = await license.getStatus()
  ok('指纹不匹配锁定', !mm.activated && mm.machineMismatch === true)

  console.log('\n== 正式包禁 skip ==')
  delete process.env.CONTRACTAMS_SKIP_LICENSE
  ok('无 SKIP 正常', assertProductionLicenseSafe() === true)
  process.env.CONTRACTAMS_SKIP_LICENSE = '1'
  let blocked = false
  try { assertProductionLicenseSafe() } catch (e) { blocked = /禁止/.test(e.message) }
  ok('SKIP=1 被拦截', blocked)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
