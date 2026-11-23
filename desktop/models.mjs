import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readDshProvider, runtimeEnv } from './runtimes.mjs'

function queryCatalog({ binary, cwd, args, initial, follow, initialized, jsonrpc = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: runtimeEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const lines = createInterface({ input: child.stdout })
    const send = message => child.stdin.write(JSON.stringify({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), ...message }) + '\n')
    let settled = false
    const timer = setTimeout(() => finish(new Error('读取模型列表超时。')), 12_000)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(result)
    }

    child.stdin.on('error', () => {})
    child.on('error', () => finish(new Error('无法启动运行时读取模型列表。')))
    child.on('exit', () => finish(new Error('运行时未返回模型列表。')))
    lines.on('line', line => {
      let response
      try { response = JSON.parse(line) } catch { return }
      if (response.id !== 0 && response.id !== 1) return
      if (response.error) return finish(new Error('运行时未返回模型列表。'))
      if (response.id === 0) {
        if (initialized) send(initialized)
        send({ id: 1, ...follow })
      } else finish(null, response.result)
    })
    send({ id: 0, ...initial })
  })
}

async function codexCatalog(binary, cwd) {
  const result = await queryCatalog({
    binary, cwd, args: ['app-server', '--listen', 'stdio://'],
    initial: { method: 'initialize', params: { clientInfo: { name: 'rainbow_mates', version: '0.1.0' } } },
    initialized: { method: 'initialized' },
    follow: { method: 'model/list', params: { includeHidden: false } },
  })
  if (!Array.isArray(result?.data)) throw new Error('Codex 返回的模型列表无法读取。')
  const models = []
  for (const row of result.data) {
    const id = row.model || row.id
    if (typeof id !== 'string' || !id || row.hidden) continue
    const entry = {
      id, label: row.displayName || id,
      efforts: (row.supportedReasoningEfforts || []).map(item => item.reasoningEffort).filter(value => typeof value === 'string'),
    }
    models.push(entry)
  }
  return { models }
}

async function dshCatalog(binary, cwd) {
  const provider = await readDshProvider(binary, cwd)
  if (!provider) throw new Error('无法读取 DSH 的模型提供方。')
  const result = await queryCatalog({
    binary, cwd, args: ['--profile', 'acp'], jsonrpc: true,
    initial: { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    follow: { method: 'session/new', params: { cwd, mcpServers: [] } },
  })
  const options = result?.configOptions || []
  const modelOptions = options.find(option => option.category === 'model')?.options || []
  const effortOptions = options.find(option => option.category === 'thought_level')
  const efforts = (provider === 'deepseek-account' || provider === 'deepseek-official')
    ? (effortOptions?.options || []).map(option => option.value).filter(value => typeof value === 'string')
    : []
  const models = []
  for (const option of modelOptions.flatMap(group => group.options || [group])) {
    let route
    try { route = JSON.parse(option.value) } catch { continue }
    if (!Array.isArray(route) || route[0] !== provider || typeof route[1] !== 'string') continue
    models.push({ id: route[1], label: option.name || route[1], efforts })
  }
  return { models, provider }
}

export function readRuntimeCatalog(type, binary, cwd) {
  if (!binary) return Promise.reject(new Error('未找到运行时。'))
  return type === 'codex' ? codexCatalog(binary, cwd) : dshCatalog(binary, cwd)
}
