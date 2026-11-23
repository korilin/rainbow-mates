const { contextBridge, ipcRenderer } = require('electron')
const subscribe = (name, fn) => {
  const listener = (_event, data) => fn(data)
  ipcRenderer.on(name, listener)
  return () => ipcRenderer.removeListener(name, listener)
}

contextBridge.exposeInMainWorld('rainbow', {
  snapshot: () => ipcRenderer.invoke('rainbow:snapshot'),
  run: (action, input) => ipcRenderer.invoke('rainbow:run', action, input),
  models: type => ipcRenderer.invoke('rainbow:models', type),
  pick: kind => ipcRenderer.invoke('rainbow:pick', kind),
  onChange: fn => subscribe('rainbow:state', fn),
  onDraft: fn => subscribe('rainbow:draft', fn),
})
