'use strict'
/** 生成 NSIS 安装脚本（UTF-8 BOM，Unicode 安装程序，用户级安装无需管理员） */
const path = require('path')

module.exports = function buildNsi({ root, unpacked, outFile, iconFile, version }) {
  const w = (p) => p.replace(/\//g, '\\')
  const appName = '合同管理系统'
  return `\uFEFFUnicode true
!include "MUI2.nsh"

!define APPNAME "${appName}"
!define APPVERSION "${version}"
!define EXENAME "CONTRACT-AMS.exe"

Name "\${APPNAME} \${APPVERSION}"
OutFile "${w(outFile)}"
InstallDir "$LOCALAPPDATA\\Programs\\CONTRACT-AMS"
InstallDirRegKey HKCU "Software\\CONTRACT-AMS" "InstallDir"
RequestExecutionLevel user
SetCompressor lzma
SetCompressorDictSize 32
Icon "${w(iconFile)}"
UninstallIcon "${w(iconFile)}"
BrandingText "CONTRACT-AMS · 合同台账 / 局域网共享"

!define MUI_ABORTWARNING
!define MUI_ICON "${w(iconFile)}"
!define MUI_UNICON "${w(iconFile)}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\\\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 合同管理系统"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${w(path.join(root, 'node_modules', 'electron', 'dist', 'LICENSE'))}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装"
  SetOutPath "$INSTDIR"
  File /r "${w(unpacked)}\\*.*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  CreateShortCut "$DESKTOP\\\${APPNAME}.lnk" "$INSTDIR\\\${EXENAME}" "" "$INSTDIR\\app.ico" 0
  CreateDirectory "$SMPROGRAMS\\\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\\\${APPNAME}\\\${APPNAME}.lnk" "$INSTDIR\\\${EXENAME}" "" "$INSTDIR\\app.ico" 0
  CreateShortCut "$SMPROGRAMS\\\${APPNAME}\\卸载.lnk" "$INSTDIR\\Uninstall.exe"

  WriteRegStr HKCU "Software\\CONTRACT-AMS" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "DisplayName" "\${APPNAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "DisplayVersion" "\${APPVERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "Publisher" "CONTRACT-AMS"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "DisplayIcon" "$INSTDIR\\\${EXENAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "UninstallString" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\\\${APPNAME}\\\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\\\${APPNAME}\\卸载.lnk"
  RMDir "$SMPROGRAMS\\\${APPNAME}"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CONTRACTAMS"
  DeleteRegKey HKCU "Software\\CONTRACT-AMS"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除本机合同数据（SQLite 数据库与合同文件）？$\\n建议保留，以便重装后继续使用。" IDNO KeepData
    RMDir /r "$APPDATA\\contract-ams\\data"
  KeepData:
SectionEnd
`
}
