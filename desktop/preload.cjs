const { contextBridge, ipcRenderer, webUtils } = require('electron')
const subscribe = (name, fn) => {
  const listener = (_event, data) => fn(data)
  ipcRenderer.on(name, listener)
  return () => ipcRenderer.removeListener(name, listener)
}

contextBridge.exposeInMainWorld('rainbow', {
  snapshot: () => ipcRenderer.invoke('rainbow:snapshot'),
  pickAvatar: () => ipcRenderer.invoke('rainbow:profile-pick-avatar'),
  saveSettings: settings => ipcRenderer.invoke('rainbow:settings-save', settings),
  saveProfile: profile => ipcRenderer.invoke('rainbow:profile-save', profile),
  run: (action, input) => ipcRenderer.invoke('rainbow:run', action, input),
  copyThreadId: threadId => ipcRenderer.invoke('rainbow:copy-thread-id', threadId),
  exportThread: threadId => ipcRenderer.invoke('rainbow:export-thread', threadId),
  workspaceEntries: (threadId, directory) => ipcRenderer.invoke('rainbow:workspace-entries', threadId, directory),
  workspaceAsset: (threadId, file) => ipcRenderer.invoke('rainbow:workspace-asset', threadId, file),
  workspaceReference: (threadId, file) => ipcRenderer.invoke('rainbow:workspace-reference', threadId, file),
  importFiles: (threadId, paths) => ipcRenderer.invoke('rainbow:import-files', threadId, paths),
  filePath: file => webUtils.getPathForFile(file),
  clipboardFiles: () => ipcRenderer.sendSync('rainbow:clipboard-files'),
  contentAsset: (threadId, messageId, id) => ipcRenderer.invoke('rainbow:content-asset', threadId, messageId, id),
  saveContent: (threadId, messageId, id) => ipcRenderer.invoke('rainbow:content-save', threadId, messageId, id),
  browser: (action, tabId, value) => ipcRenderer.invoke('rainbow:browser', action, tabId, value),
  referenceList: (threadId, kind) => ipcRenderer.invoke('rainbow:reference-list', threadId, kind),
  referenceFiles: (threadId, kind) => ipcRenderer.invoke('rainbow:reference-files', threadId, kind),
  computerAccess: request => ipcRenderer.invoke('rainbow:computer-access', request),
  models: type => ipcRenderer.invoke('rainbow:models', type),
  pick: kind => ipcRenderer.invoke('rainbow:pick', kind),
  onChange: fn => subscribe('rainbow:state', fn),
  onDraft: fn => subscribe('rainbow:draft', fn),
  onActivity: fn => subscribe('rainbow:activity', fn),
  onBrowser: fn => subscribe('rainbow:browser-state', fn),
})
