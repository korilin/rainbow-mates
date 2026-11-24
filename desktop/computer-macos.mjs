import { app, desktopCapturer, screen, shell, systemPreferences } from 'electron'
import { createRequire } from 'node:module'

const keyCodes = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28,
  0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, enter: 36, l: 37, j: 38, "'": 39, k: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, '`': 50, backspace: 51,
  escape: 53, esc: 53, home: 115, pageup: 116, delete: 117, end: 119, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
}
const modifiers = { shift: 1 << 17, control: 1 << 18, ctrl: 1 << 18, option: 1 << 19, alt: 1 << 19, command: 1 << 20, cmd: 1 << 20 }
const asText = value => ({ type: 'text', text: JSON.stringify(value) })

function parseKeys(value) {
  const parts = value.toLowerCase().split('+').map(item => item.trim())
  const key = parts.pop()
  if (!Object.hasOwn(keyCodes, key) || parts.some(modifier => !Object.hasOwn(modifiers, modifier))) {
    throw new Error('Unknown key combination. Use a key such as return or a shortcut such as cmd+l.')
  }
  return { code: keyCodes[key], flags: parts.reduce((flags, modifier) => flags | modifiers[modifier], 0) }
}

export function createMacDesktop() {
  if (process.platform !== 'darwin') return null
  let addon
  try { addon = createRequire(import.meta.url)('./native/computer.node') } catch { return null }
  const decode = output => {
    const result = JSON.parse(output)
    if (result.error) throw new Error(result.error)
    return result
  }
  const native = (operation, args) => decode(addon.run(JSON.stringify({ ...args, operation })))
  const accessibility = async (operation, args) => decode(await addon.accessibility(JSON.stringify({ ...args, operation })))
  const status = request => {
    const accessibility = systemPreferences.isTrustedAccessibilityClient(request === 'accessibility')
    if (request === 'screen' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') native('request_screen')
    return { supported: true, accessibility, screen: systemPreferences.getMediaAccessStatus('screen') === 'granted' }
  }

  return {
    status,
    async perform(name, args, state, signal) {
      if (name === 'list_apps') return [asText(native('applications'))]
      const frontmost = native('frontmost')
      if (!frontmost.pid || frontmost.bundleId === 'com.apple.loginwindow') {
        throw new Error('Unlock this Mac to use its desktop.')
      }
      if (name === 'focus_app') {
        const result = native('focus', args)
        Object.assign(state, { pid: null, inspected: false, capture: null })
        return [asText(result)]
      }
      if (name === 'open_url') {
        const url = new URL(args.url)
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP(S) URL.')
        await shell.openExternal(url.href)
        Object.assign(state, { pid: null, inspected: false, capture: null })
        return [asText({ opened: url.href })]
      }
      if (name === 'inspect') {
        if (status().accessibility && frontmost.pid === process.pid) app.accessibilitySupportEnabled = true
        const result = await accessibility('inspect')
        signal.throwIfAborted()
        if (state.pid !== result.frontmost.pid) state.capture = null
        Object.assign(state, { pid: result.frontmost.pid, inspected: true })
        return [asText(result)]
      }
      if (name === 'screenshot') {
        if (!status().screen) throw new Error('Grant Rainbow Mates Screen Recording access in macOS System Settings.')
        const displays = screen.getAllDisplays()
        const display = args.displayId ? displays.find(item => String(item.id) === args.displayId) : screen.getPrimaryDisplay()
        if (!display) throw new Error('Unknown display. Capture without a display ID to use the primary display.')
        const { bounds } = display
        const scale = Math.min(1, 1440 / Math.max(bounds.width, bounds.height))
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
          width: Math.max(1, Math.round(bounds.width * scale)), height: Math.max(1, Math.round(bounds.height * scale)),
        } })
        signal.throwIfAborted()
        const source = sources.find(item => item.display_id === String(display.id)) || (displays.length === 1 && sources[0])
        if (!source || source.thumbnail.isEmpty()) throw new Error('No image was available from the selected display.')
        if (native('frontmost').pid !== frontmost.pid) throw new Error('The foreground application changed during capture. Take a new screenshot.')
        const { width, height } = source.thumbnail.getSize()
        const displayId = String(display.id)
        if (state.pid !== frontmost.pid) state.inspected = false
        Object.assign(state, { pid: frontmost.pid, capture: { displayId, bounds, width, height } })
        return [asText({ displayId, width, height, frontmost, displays: displays.map(item => ({ id: String(item.id), label: item.label })) }),
          { type: 'image', mimeType: 'image/jpeg', data: source.thumbnail.toJPEG(78).toString('base64') }]
      }
      if (!status().accessibility) throw new Error('Grant Rainbow Mates Accessibility access in macOS System Settings.')
      if (state.pid !== frontmost.pid) throw new Error('Inspect or capture the foreground application before sending input.')
      const pid = state.pid
      switch (name) {
        case 'use_element':
          if (!state.inspected) throw new Error('Inspect the current window before using an element ID.')
          return [asText(await accessibility('element', { ...args, pid }))]
        case 'click': {
          const capture = state.capture
          if (!capture || capture.displayId !== args.displayId || args.x >= capture.width || args.y >= capture.height) {
            throw new Error('Use coordinates and the displayId from the latest screenshot.')
          }
          const x = capture.bounds.x + args.x * capture.bounds.width / capture.width
          const y = capture.bounds.y + args.y * capture.bounds.height / capture.height
          return [asText(native('click', { x, y, pid, right: args.button === 'right', clicks: args.count || 1 }))]
        }
        case 'press_key': return [asText(native('key', { ...parseKeys(args.keys), pid }))]
        case 'type_text': return [asText(native('text', { text: args.text, pid }))]
        case 'scroll': return [asText(native('scroll', { dx: Math.round(args.dx || 0), dy: Math.round(args.dy), pid }))]
        default: throw new Error('Unknown desktop action.')
      }
    },
  }
}
