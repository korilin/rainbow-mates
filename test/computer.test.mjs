import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputerBridge } from '../desktop/computer.mjs'

test('desktop tool grants are private, exclusive for input and revoked at the end of a turn', async t => {
  const bridge = new ComputerBridge({
    status: () => ({ supported: true, accessibility: true, screen: false }),
    perform: async (operation, args) => [{ type: 'text', text: JSON.stringify({ operation, args }) }],
  })
  const first = new AbortController()
  const second = new AbortController()
  const a = await bridge.grant(first.signal)
  const b = await bridge.grant(second.signal)
  t.after(() => { a.close(); b.close(); bridge.server.close() })

  const rpc = (grant, method, params, headers) => fetch(grant.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const call = async (grant, name, args) => (await (await rpc(grant, 'tools/call', { name, arguments: args })).json()).result

  assert.notEqual(a.url, b.url)
  assert.equal(new URL(a.url).hostname, '127.0.0.1')
  assert.equal((await rpc(a, 'tools/list', {}, { Origin: 'https://example.test' })).status, 403)
  assert.equal((await rpc({ url: a.url + 'x' }, 'tools/list')).status, 404)
  const init = (await (await rpc(a, 'initialize', { protocolVersion: '2025-06-18' })).json()).result
  assert.equal(init.protocolVersion, '2025-06-18')
  const listed = (await (await rpc(a, 'tools/list')).json()).result.tools
  assert.equal(listed.find(tool => tool.name === 'inspect').annotations.readOnlyHint, true)
  assert.equal(listed.find(tool => tool.name === 'click').annotations.readOnlyHint, false)
  assert.equal((await call(a, 'click', { x: -1 })).isError, true)
  assert.deepEqual(JSON.parse((await call(a, 'permissions')).content[0].text),
    { supported: true, accessibility: true, screen: false })
  assert.equal((await call(a, 'inspect')).isError, undefined)
  assert.equal((await call(b, 'list_apps')).isError, undefined)
  assert.match((await call(b, 'inspect')).content[0].text, /another operation/)
  first.abort()
  assert.equal((await rpc(a, 'tools/list')).status, 404)
  assert.equal((await call(b, 'inspect')).isError, undefined)
  b.close()
  assert.equal((await rpc(b, 'tools/list')).status, 404)
})
