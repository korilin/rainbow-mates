import { session, WebContentsView } from 'electron'
import { websiteURL } from '../shared/content-links.mjs'

export class PanelBrowser {
  constructor(window, notify) {
    this.window = window
    this.notify = notify
    this.tabs = new Map()
  }

  create(id) {
    if (!this.session) {
      this.session = session.fromPartition('rainbow-content-browser')
      this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      this.session.setPermissionCheckHandler(() => false)
      this.cancelDownload = event => event.preventDefault()
      this.session.on('will-download', this.cancelDownload)
    }
    const view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true,
      contextIsolation: true, nodeIntegration: false } })
    const tab = { view, url: '', error: '' }
    this.tabs.set(id, tab)
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      contents.on(name, (event, url) => { if (!websiteURL(event.url || url)) event.preventDefault() })
    }
    for (const name of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) {
      contents.on(name, () => this.update(id, '', contents.getURL()))
    }
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3) this.update(id, description, url)
    })
    return tab
  }

  update(id, error, url) {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (error !== undefined) tab.error = error
    const nextUrl = websiteURL(url)
    if (nextUrl) tab.url = nextUrl
    const history = tab.view.webContents.navigationHistory
    this.notify({ tabId: id, url: tab.url, error: tab.error, canBack: history.canGoBack(), canForward: history.canGoForward() })
  }

  dispatch(action, id, value) {
    if (typeof id !== 'string' || !id || id.length > 120) return
    let tab = this.tabs.get(id)
    if (action === 'close') { this.close(id); return }
    if (action === 'show' || action === 'open') {
      if (action === 'open' || !tab) {
        const url = websiteURL(value)
        if (!url && action === 'show') return
        if (!url) throw new Error('请输入有效的 HTTP 或 HTTPS 地址。')
        tab ||= this.create(id)
        if (tab.url !== url || tab.error) {
          this.update(id, '', url)
          void tab.view.webContents.loadURL(url).catch(() => {})
          return
        }
      }
      this.update(id)
      return
    }
    if (!tab) return
    const { view } = tab
    const contents = view.webContents
    if (action === 'hide') view.setVisible(false)
    else if (action === 'bounds') {
      const keys = ['x', 'y', 'width', 'height']
      if (!keys.every(key => Number.isInteger(value?.[key]) && value[key] >= 0)) return
      const [width, height] = this.window.getContentSize()
      const bounds = { x: value.x, y: value.y, width: Math.min(value.width, width - value.x), height: Math.min(value.height, height - value.y) }
      if (bounds.width <= 0 || bounds.height <= 0) { view.setVisible(false); return }
      for (const other of this.tabs.values()) if (other !== tab) other.view.setVisible(false)
      view.setBounds(bounds)
      view.setVisible(true)
    } else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (action === 'reload') void contents.loadURL(tab.url).catch(() => {})
  }

  close(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.tabs.delete(id)
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
  }

  dispose() {
    for (const id of this.tabs.keys()) this.close(id)
    this.session?.removeListener('will-download', this.cancelDownload)
  }
}
