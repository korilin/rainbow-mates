import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Store } from './store.mjs'
import { Conversations } from './conversations.mjs'

app.setName('Rainbow Deskmates')
if (process.env.RDS_USER_DATA_DIR) app.setPath('userData', resolve(process.env.RDS_USER_DATA_DIR))
const ready = app.requestSingleInstanceLock()
let window
let conversations
const here = fileURLToPath(new URL('.', import.meta.url))
const icon = join(here, '..', 'dist', 'app-icon.png')

function notify(name, data) {
  if (window && !window.isDestroyed()) window.webContents.send(name, data)
}

function openWindow() {
  window = new BrowserWindow({
    title: 'Rainbow Deskmates',
    icon,
    width: 1440, height: 920, minWidth: 660, minHeight: 560,
    backgroundColor: '#f9f8fc',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.loadFile(join(here, '..', 'dist', 'index.html'))
  window.on('closed', () => { window = null })
}

const guard = handler => (event, ...args) => {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('无效的应用请求。')
  }
  return handler(...args)
}

if (!ready) app.quit()
else {
  app.on('second-instance', () => {
    if (!window) return openWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.whenReady().then(() => {
    if (!app.isPackaged) app.dock?.setIcon(icon)
    const data = app.getPath('userData')
    const work = join(data, 'workspace')
    mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      conversations = new Conversations({
        store: new Store(join(data, 'workspace.json')), defaultDirectory: work,
        publish: value => notify('rainbow:state', value), draft: value => notify('rainbow:draft', value),
      })
    } catch (error) {
      dialog.showErrorBox('无法读取本地数据', error.message + '\n\n' + data)
      app.quit()
      return
    }
    ipcMain.handle('rainbow:snapshot', guard(() => conversations.snapshot()))
    ipcMain.handle('rainbow:run', guard((action, payload) => conversations.dispatch(action, payload)))
    ipcMain.handle('rainbow:models', guard(type => {
      if (type !== 'codex' && type !== 'deepseek') throw new Error('未知运行时。')
      return conversations.modelChoices(type)
    }))
    ipcMain.handle('rainbow:pick', guard(async kind => {
      const result = await dialog.showOpenDialog(window, {
        title: kind === 'directory' ? '选择会话工作目录' : '选择运行时可执行文件',
        properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
      })
      return result.filePaths[0] ?? null
    }))
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
    openWindow()
    conversations.refreshModels()
    app.on('activate', () => { if (!window) openWindow() })
  })
  app.on('before-quit', () => conversations?.stopAll())
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
