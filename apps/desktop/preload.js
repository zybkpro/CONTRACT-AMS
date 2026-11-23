'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/** 暴露给渲染进程的最小能力面：业务 API（IPC）+ 局域网服务控制 */
let mediaDir = ''
try { mediaDir = ipcRenderer.sendSync('get-media-dir') || '' } catch (_) {}

contextBridge.exposeInMainWorld('contractams', {
  isDesktop: true,
  mediaDir,
  invoke: (method, path, query = {}, body = {}, token = '') =>
    ipcRenderer.invoke('api:invoke', { method, path, query, body, token }),
  // P0 附件修复：系统预览 / 另存为
  file: {
    preview: (filePath) => ipcRenderer.invoke('file:preview', { filePath }),
    save: (filePath, fileName) => ipcRenderer.invoke('file:save', { filePath, fileName }),
  },
  service: {
    status: () => ipcRenderer.invoke('service:status'),
    start: () => ipcRenderer.invoke('service:start'),
    stop: () => ipcRenderer.invoke('service:stop'),
    config: (patch) => ipcRenderer.invoke('service:config', { ...(patch || {}) }),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
    setIcon: (dataURL) => ipcRenderer.invoke('app:setIcon', { dataURL }),
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (code) => ipcRenderer.invoke('license:activate', { code }),
    verify: () => ipcRenderer.invoke('license:verify'),
  },
})
