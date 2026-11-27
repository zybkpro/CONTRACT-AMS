'use strict'
/**
 * V1.4 加固：正式打包前的授权安全检查
 * - 禁止 CONTRACTAMS_SKIP_LICENSE=1 进入正式安装包（否则用户可无授权使用）
 * - 若未通过 CONTRACTAMS_LICENSE_API_TOKEN 注入 Token，给出提醒（当前 license.js 有固定值兜底，不强制失败）
 */
function assertProductionLicenseSafe() {
  if (process.env.CONTRACTAMS_SKIP_LICENSE === '1') {
    throw new Error('正式打包禁止 CONTRACTAMS_SKIP_LICENSE=1：请在打包环境中清除该变量后再构建')
  }
  if (!String(process.env.CONTRACTAMS_LICENSE_API_TOKEN || '').trim()) {
    console.warn('  ⚠ 未设置 CONTRACTAMS_LICENSE_API_TOKEN，安装包将使用 license.js 内置兜底 Token。')
    console.warn('    正式发布建议在打包环境注入：export CONTRACTAMS_LICENSE_API_TOKEN=<服务端 API_TOKEN>')
  }
  return true
}

module.exports = { assertProductionLicenseSafe }
