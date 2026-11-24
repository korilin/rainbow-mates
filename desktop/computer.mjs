import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'

const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) })
const string = maxLength => ({ type: 'string', maxLength, minLength: 1 })
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum })
const choice = (...values) => ({ type: 'string', enum: values })
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly.has(name) },
})

const readOnly = new Set(['permissions', 'list_apps', 'inspect', 'screenshot'])

const tools = [
  tool('permissions', 'Check macOS Accessibility and Screen Recording permissions for Rainbow Mates.'),
  tool('list_apps', 'List running desktop apps and the foreground app. Use the bundleId with focus_app.'),
  tool('focus_app', 'Bring a running desktop app to the foreground by bundle ID.', { bundleId: string(200) }),
  tool('open_url', 'Open an HTTP(S) page in the default browser.', { url: string(2000) }),
  tool('inspect', 'Inspect the foreground window through macOS Accessibility. Returns text, controls, and element IDs. Useful with text-only models.'),
  tool('screenshot', 'Capture a display and return its image. Coordinates for click are pixels in the returned image.', { displayId: string(32) }, []),
  tool('use_element', 'Press or focus an element from the latest inspect result. Inspect again after layout changes.',
    { id: { ...number(1, 110), type: 'integer' }, action: choice('press', 'focus') }),
  tool('click', 'Click pixel coordinates in the latest screenshot. Capture first, then use its displayId.', {
    displayId: string(32), x: number(0, 4096), y: number(0, 4096), button: choice('left', 'right'), count: { ...number(1, 2), type: 'integer' },
  }, ['displayId', 'x', 'y']),
  tool('press_key', 'Press a macOS key or shortcut in the observed foreground app, for example cmd+l, return, or shift+tab.', { keys: string(60) }),
  tool('type_text', 'Type Unicode text into the focused field of the observed foreground app.', { text: string(2000) }),
  tool('scroll', 'Scroll at the current pointer in the observed foreground app. Positive values move down or right.', { dx: number(-3000, 3000), dy: number(-3000, 3000) }, ['dy']),
]

function valid(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  return schema.required.every(name => Object.hasOwn(args, name)) && Object.entries(args).every(([name, value]) => {
    if (!Object.hasOwn(schema.properties, name)) return false
    const { type, enum: allowed, minLength, maxLength, minimum, maximum } = schema.properties[name]
    if (type === 'string') return typeof value === 'string' && (allowed ? allowed.includes(value) : value.length >= minLength && value.length <= maxLength)
    return Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)) && value >= minimum && value <= maximum
  })
}

async function body(request) {
  let length = 0
  const chunks = []
  for await (const chunk of request) {
    length += chunk.length
    if (length > 16_384) throw new Error('Desktop tool request is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export class ComputerBridge {
  constructor(desktop) {
    this.desktop = desktop
    this.grants = new Map()
    this.owner = null
  }

  status(request) {
    return this.desktop?.status(request) ?? { supported: false }
  }

  get available() { return Boolean(this.desktop) }

  async grant(signal) {
    if (!this.available) throw new Error('本机暂不支持 Computer Use。')
    signal.throwIfAborted()
    if (!this.listening) {
      this.server = createServer((request, response) => {
        void this.handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(400)
          response.end()
        })
      })
      this.server.requestTimeout = 10_000
      this.server.listen(0, '127.0.0.1')
      this.listening = once(this.server, 'listening').then(() => {
        this.server.unref()
        return 'http://127.0.0.1:' + this.server.address().port
      }).catch(error => { this.listening = null; throw error })
    }
    const endpoint = await this.listening
    signal.throwIfAborted()
    const path = '/' + randomBytes(24).toString('base64url')
    const session = { signal, state: {}, active: true, busy: false }
    this.grants.set(path, session)
    const close = () => {
      session.active = false
      this.grants.delete(path)
      if (this.owner === session && !session.busy) this.owner = null
      signal.removeEventListener('abort', close)
    }
    signal.addEventListener('abort', close, { once: true })
    return { url: endpoint + path, close }
  }

  async call(session, name, args) {
    const descriptor = tools.find(item => item.name === name)
    const fail = message => ({ content: [text(message)], isError: true })
    if (!descriptor || !valid(descriptor.inputSchema, args)) return fail('Unknown desktop tool or invalid arguments.')
    if (!session.active || session.signal.aborted) return fail('This desktop session has ended.')
    if (name === 'permissions') return { content: [text(this.status())] }
    const exclusive = name !== 'list_apps'
    if (exclusive) {
      if ((this.owner && this.owner !== session) || session.busy) return fail('The desktop is being used by another operation. Try again after it finishes.')
      this.owner = session
      session.busy = true
    }
    try {
      return { content: await this.desktop.perform(name, args, session.state, session.signal) }
    } catch (error) {
      return fail(error.message)
    } finally {
      if (exclusive) {
        session.busy = false
        if (!session.active) this.owner = null
      }
    }
  }

  async handle(request, response) {
    const end = (status, data) => {
      response.writeHead(status, data === undefined ? {} : { 'Content-Type': 'application/json' })
      response.end(data === undefined ? undefined : JSON.stringify(data))
    }
    if (request.headers.origin || request.headers.host !== '127.0.0.1:' + this.server.address().port) return end(403)
    const session = this.grants.get(request.url)
    if (!session) return end(404)
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return end(405) }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return end(415)
    const rpc = await body(request)
    if (rpc?.jsonrpc !== '2.0' || !rpc.method) return end(400)
    if (rpc.id === undefined) return end(202)
    let result
    switch (rpc.method) {
      case 'initialize':
        result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(rpc.params?.protocolVersion)
          ? rpc.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'rainbow_computer', version: '1' } }
        break
      case 'ping': result = {}; break
      case 'tools/list': result = { tools }; break
      case 'tools/call': result = await this.call(session, rpc.params?.name, rpc.params?.arguments ?? {}); break
      default: return end(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
    }
    end(200, { jsonrpc: '2.0', id: rpc.id, result })
  }
}
