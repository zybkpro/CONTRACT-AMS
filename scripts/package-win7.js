'use strict'
/**
 * Win7 兼容版打包包装器（跨平台，无需 cross-env）
 * Electron 22.3.27 是最后一个支持 Windows 7/8 的分支；本脚本设置环境变量后复用通用打包器。
 * 用法: node scripts/package-win7.js [x64|ia32]
 */
process.env.CONTRACTAMS_WIN7 = '1'
process.env.CONTRACTAMS_ELECTRON_VERSION = '22.3.27'
require('./package-win-portable')
