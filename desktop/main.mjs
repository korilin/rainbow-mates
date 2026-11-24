import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { constants, createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import metadata from '../package.json' with { type: 'json' }
import { Store } from './store.mjs'
import { Conversations } from './conversations.mjs'
import { ComputerBridge } from './computer.mjs'
import { createMacDesktop } from './computer-macos.mjs'
import { closeCodexServers } from './codex-server.mjs'
import { displayVersion } from './app-version.mjs'
import { References } from './references.mjs'
import { readAssetPreview, streamAsset } from './content.mjs'
import { PanelBrowser } from './panel-browser.mjs'
import { workspaceAsset, workspaceEntries, workspaceReferencePath } from './workspace-files.mjs'
import { fileClipboardPaths } from './file-clipboard.mjs'
import { previewUserAvatar, saveUserProfile, userAvatarResponse } from './user-profile.mjs'
import { appTheme, canvasColor } from '../shared/theme.mjs'

protocol.registerSchemesAsPrivileged([{ scheme: 'rainbow-content', privileges: { standard: true, secure: true, stream: true } }])
app.setName(metadata.productName)
if (process.env.RDS_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.RDS_USER_DATA_DIR))
} else {
  // Existing installations can keep their working directory and native session paths.
  const legacyData = join(app.getPath('appData'), 'Rainbow Deskmates')
  if (existsSync(join(legacyData, 'workspace.json')) && !existsSync(join(app.getPath('userData'), 'workspace.json'))) {
    app.setPath('userData', legacyData)
  }
}
const ready = app.requestSingleInstanceLock()
let window
let conversations
let panelBrowser
const here = fileURLToPath(new URL('.', import.meta.url))
const icon = join(here, '..', 'dist', 'app-icon.png')
const withAppVersion = state => ({ ...state, appVersion: displayVersion, packaged: app.isPackaged })

function notify(name, data) {
  if (window && !window.isDestroyed()) window.webContents.send(name, data)
}

function applyTheme(theme) {
  if (nativeTheme.themeSource === theme) return
  nativeTheme.themeSource = theme
  window?.setBackgroundColor(canvasColor[theme])
}

function openWindow() {
  const theme = appTheme(conversations.store.value.settings.theme)
  applyTheme(theme)
  window = new BrowserWindow({
    title: metadata.productName,
    icon,
    width: 1440, height: 920, minWidth: 660, minHeight: 560,
    backgroundColor: canvasColor[theme],
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  panelBrowser = new PanelBrowser(window, data => notify('rainbow:browser-state', data))
  window.loadFile(join(here, '..', 'dist', 'index.html'), { query: { theme } })
  window.on('closed', () => { panelBrowser.dispose(); window = null; panelBrowser = null })
}

const guard = handler => (event, ...args) => {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('无效的应用请求。')
  }
  return handler(...args)
}

async function exportConversation(threadId) {
  const data = conversations.exportThread(threadId)
  const name = data.conversations[0].name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/^[. ]+|[. ]+$/g, '') || '会话'
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '导出会话',
    defaultPath: join(app.getPath('downloads'), name + '.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return false
  const temporary = filePath + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

async function saveAttachment(threadId, messageId, id) {
  const { name } = await conversations.messageAsset(threadId, messageId, id)
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '保存附件', defaultPath: join(app.getPath('downloads'), name),
  })
  if (canceled || !filePath) return false
  const asset = await conversations.messageAsset(threadId, messageId, id)
  if (resolve(filePath) === asset.path) return true
  const temporary = filePath + '.' + randomUUID() + '.tmp'
  try {
    await pipeline(createReadStream(asset.path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

if (!ready) app.quit()
else {
  app.on('second-instance', () => {
    if (!window) return openWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: metadata.productName, applicationVersion: displayVersion })
    if (!app.isPackaged) app.dock?.setIcon(icon)
    const data = app.getPath('userData')
    const work = join(data, 'workspace')
    const profileDirectory = join(data, 'profile-avatars')
    const computer = new ComputerBridge(createMacDesktop())
    const references = new References()
    mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      conversations = new Conversations({
        store: new Store(join(data, 'workspace.json')), defaultDirectory: work, computer, references,
        publish: value => {
          applyTheme(appTheme(value.settings.theme))
          notify('rainbow:state', withAppVersion(value))
        },
        draft: value => notify('rainbow:draft', value),
        activity: value => notify('rainbow:activity', value),
      })
    } catch (error) {
      dialog.showErrorBox('无法读取本地数据', error.message + '\n\n' + data)
      app.quit()
      return
    }
    ipcMain.handle('rainbow:snapshot', guard(() => withAppVersion(conversations.snapshot())))
    ipcMain.handle('rainbow:run', guard((action, payload) => conversations.dispatch(action, payload)))
    ipcMain.handle('rainbow:copy-thread-id', guard(threadId => {
      clipboard.writeText(conversations.dispatch('threadId', { threadId }))
    }))
    ipcMain.handle('rainbow:export-thread', guard(exportConversation))
    const cwdFor = threadId => conversations.workspaceDirectory(threadId)
    ipcMain.handle('rainbow:workspace-entries', guard((threadId, directory) => workspaceEntries(cwdFor(threadId), directory)))
    ipcMain.handle('rainbow:workspace-asset', guard(async (threadId, file) => readAssetPreview(await workspaceAsset(cwdFor(threadId), file))))
    ipcMain.handle('rainbow:workspace-reference', guard(async (threadId, entry) => {
      const path = await workspaceReferencePath(cwdFor(threadId), entry)
      return references.paths(threadId, [path])
    }))
    ipcMain.handle('rainbow:import-files', guard((threadId, paths) => {
      cwdFor(threadId)
      return references.paths(threadId, paths)
    }))
    ipcMain.on('rainbow:clipboard-files', (event) => {
      event.returnValue = event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame ? fileClipboardPaths() : []
    })
    ipcMain.handle('rainbow:profile-pick-avatar', guard(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择头像', properties: ['openFile'], filters: [{ name: '头像图片', extensions: ['png', 'jpg', 'jpeg'] }],
      })
      return result.canceled || !result.filePaths[0] ? null : previewUserAvatar(result.filePaths[0])
    }))
    ipcMain.handle('rainbow:profile-save', guard(profile => saveUserProfile(conversations, profileDirectory, profile)))
    ipcMain.handle('rainbow:content-asset', guard(async (threadId, messageId, id) =>
      readAssetPreview(await conversations.messageAsset(threadId, messageId, id))))
    ipcMain.handle('rainbow:content-save', guard(saveAttachment))
    ipcMain.handle('rainbow:browser', guard((action, tabId, value) => panelBrowser?.dispatch(action, tabId, value)))
    protocol.handle('rainbow-content', async request => {
      try {
        const url = new URL(request.url)
        const parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
        if (url.hostname === 'profile' && parts.length === 1) {
          return await userAvatarResponse(profileDirectory, parts[0], conversations.store.value.settings.profile, request.method)
        }
        if (url.hostname === 'asset' && parts.length === 3) return streamAsset(await conversations.messageAsset(...parts), request)
        if (url.hostname === 'workspace' && parts.length === 2) return streamAsset(await workspaceAsset(cwdFor(parts[0]), parts[1]), request)
        if (url.hostname === 'reference' && parts.length === 2) {
          cwdFor(parts[0])
          return streamAsset(await references.image(...parts), request)
        }
      } catch { /* Missing or unauthorized media. */ }
      return new Response(null, { status: 404 })
    })
    ipcMain.handle('rainbow:reference-list', guard((threadId, kind) => {
      if (kind !== 'skill' && kind !== 'plugin') throw new Error('未知引用类型。')
      const { cwd, binaries } = conversations.referenceScope(threadId)
      return references.catalog(threadId, kind, cwd, binaries)
    }))
    ipcMain.handle('rainbow:reference-files', guard(async (threadId, kind = 'file') => {
      if (kind !== 'file' && kind !== 'directory') throw new Error('引用类型无效。')
      const directory = kind === 'directory'
      const result = await dialog.showOpenDialog(window, {
        title: directory ? '引用目录' : '引用文件', defaultPath: cwdFor(threadId),
        properties: [directory ? 'openDirectory' : 'openFile', 'multiSelections'],
      })
      if (result.canceled) return []
      return references.paths(threadId, result.filePaths)
    }))
    ipcMain.handle('rainbow:computer-access', guard(request => {
      if (request !== undefined && request !== 'accessibility' && request !== 'screen') throw new Error('未知的系统权限。')
      return computer.status(request)
    }))
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
  app.on('before-quit', () => {
    conversations?.stopAll()
    closeCodexServers()
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
