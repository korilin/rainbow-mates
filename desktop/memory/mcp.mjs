import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'

const searchTool = {
  name: 'memory_search',
  description: 'Search your own previously learned memories using the current question, evidence or error as query. Results include IDs, versions and evidence. Searching does not count as using a memory.',
  inputSchema: {
    type: 'object', required: ['query'], additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 4000 },
      limit: { type: 'integer', minimum: 1, maximum: 12 },
    },
  },
  annotations: { readOnlyHint: true },
}
const protocols = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const content = value => [{ type: 'text', text: JSON.stringify(value) }]

export class MemoryMcp {
  constructor() { this.grants = new Map() }

  start() {
    if (this.closed) return Promise.reject(new Error('记忆工具已关闭。'))
    if (this.listening) return this.listening
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400)
        response.end()
      })
    })
    this.server = server
    server.requestTimeout = 10_000
    server.listen(0, '127.0.0.1')
    this.listening = once(server, 'listening').then(() => {
      server.unref()
      return 'http://127.0.0.1:' + server.address().port
    }).catch(error => { this.listening = null; throw error })
    return this.listening
  }

  async grant(signal, search) {
    signal.throwIfAborted()
    const endpoint = await this.start()
    signal.throwIfAborted()
    const path = '/' + randomBytes(32).toString('base64url')
    const grant = { search, signal, calls: 0, active: true }
    this.grants.set(path, grant)
    const close = () => {
      grant.active = false
      this.grants.delete(path)
      signal.removeEventListener('abort', close)
    }
    signal.addEventListener('abort', close, { once: true })
    return { url: endpoint + path, close }
  }

  async handle(request, response) {
    const end = (status, body) => {
      response.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (request.headers.origin || request.headers.host !== '127.0.0.1:' + this.server.address()?.port) return end(403)
    const grant = this.grants.get(request.url)
    if (!grant) return end(404)
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return end(405) }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return end(415)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 32_768) return end(413)
      chunks.push(chunk)
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return end(400)
    if (rpc.id === undefined) return end(202)
    let result
    switch (rpc.method) {
      case 'initialize':
        result = { protocolVersion: protocols.includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : protocols.at(-1),
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'rainbow_memory', version: '1' } }
        break
      case 'ping': result = {}; break
      case 'tools/list': result = { tools: [searchTool] }; break
      case 'tools/call': result = await this.call(grant, rpc.params); break
      default: return end(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
    }
    end(200, { jsonrpc: '2.0', id: rpc.id, result })
  }

  async call(grant, params) {
    const fail = message => ({ content: content({ error: message }), isError: true })
    const args = params?.arguments
    if (params?.name !== searchTool.name || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['query', 'limit'].includes(key))
      || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4000
      || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 12)) return fail('Invalid memory_search arguments.')
    if (grant.calls >= 8) return fail('This turn has reached its memory search budget.')
    grant.calls++
    try {
      grant.signal.throwIfAborted()
      const result = await grant.search(args.query.trim(), args.limit ?? 12)
      grant.signal.throwIfAborted()
      if (!grant.active) return fail('This memory session has ended.')
      return { content: content(result) }
    } catch {
      return fail('Memory search is currently unavailable.')
    }
  }

  close() {
    this.closed = true
    this.grants.clear()
    this.server?.close()
    this.server?.closeAllConnections()
  }
}
