import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { runCodex } from './codex-server.mjs'
import { dshActivity } from './activity.mjs'

export const runtimeNames = { codex: 'Codex', deepseek: 'DeepSeek Harness' }

export function runtimeEnv() {
  const extra = [
    join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ]
  return { ...process.env, PATH: [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter) }
}

export function findRuntime(type, configuredPath) {
  const name = type === 'deepseek' ? 'dsh' : 'codex'
  const extensions = process.platform === 'win32' ? ['.exe'] : ['']
  const bundled = type === 'codex' && process.platform === 'darwin'
    ? ['/Applications', join(homedir(), 'Applications')].map(root => join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'))
    : []
  const candidates = configuredPath
    ? [isAbsolute(configuredPath) ? configuredPath : '']
    : [...bundled, ...runtimeEnv().PATH.split(delimiter).flatMap(dir => extensions.map(ext => join(dir, name + ext)))]
  return candidates.find(candidate => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

export function dshArgs({ sessionId, writeAccess, modelPatch }) {
  const mode = writeAccess ? 'workspace-write' : 'read-only'
  return ['--profile', 'headless', ...(modelPatch ? ['--patch', modelPatch] : []), '--json', '--permission-mode', mode, '--approval-policy', 'never',
    ...(sessionId ? ['--session-id', sessionId] : []), '-']
}

export function parseDshEvent(event) {
  if (event.type === 'session') return { sessionId: event.sessionId }
  if (event.type === 'text') return { draft: event.text }
  if (event.type === 'final') {
    return { sessionId: event.sessionId, answer: event.text,
      error: event.reason?.kind === 'completed' ? undefined
        : event.reason?.message || event.message || 'DSH 结束了本轮执行（' + (event.reason?.kind || '未知状态') + '）' }
  }
  if (event.type === 'error') return { warning: event.message || event.error?.message }
  return {}
}

function cleanError(value) {
  let message = value || '运行时未返回有效回复。'
  try {
    const data = JSON.parse(message)
    message = data.error?.message || data.message || message
  } catch {}
  return message.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 1400)
}

export async function readDshProvider(binary, cwd, signal) {
  const { stdout } = await promisify(execFile)(binary, ['--profile', 'headless', '--dump-config'], {
    cwd, env: runtimeEnv(), timeout: 8000, signal, maxBuffer: 2 * 1024 * 1024,
  })
  const profile = stdout.split(/^(?=- id: )/m).find(section => /^- id: agent-default-model\s*$/m.test(section)) || ''
  return /^\s+provider:\s*["']?([\w./:@-]+)["']?\s*$/m.exec(profile)?.[1]
}

export async function runRuntime(options) {
  const { type, binary, cwd, model, effort, signal } = options
  if (!binary) throw new Error('未找到 ' + runtimeNames[type] + '。请在运行时设置中选择可执行文件。')
  if (!model) throw new Error('请先为角色选择模型版本。')
  if (signal.aborted) throw new Error('已停止')
  if (type === 'codex') return runCodex({ ...options, env: runtimeEnv() })

  const provider = options.provider || await readDshProvider(binary, cwd, signal).catch(() => null)
  if (!provider) throw new Error(signal.aborted ? '已停止' : '无法读取 DSH headless 配置的模型提供方。')
  const folder = await mkdtemp(join(tmpdir(), 'rainbow-dsh-model-'))
  const deliveries = new Set()
  let stopped = false, sequence = 0
  try {
    const modelPatch = join(folder, 'model.yml')
    const patches = [{ id: 'agent-default-model', config: {
      provider, model, ...(effort ? { reasoningEffort: effort } : {}),
    } }]
    if (options.computerUrl) patches.push({ insert: [{ id: 'rainbow-computer', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'rainbow_computer', transport: 'streamable-http', url: options.computerUrl,
      failOnStartupError: true, reconnect: { enabled: false },
    } }] })
    if (options.onSteer) {
      const plugin = join(folder, 'steering.mjs')
      await writeFile(plugin, await readFile(new URL('./dsh-steering.mjs', import.meta.url)), { mode: 0o600 })
      patches.push({ insert: [{ id: 'rainbow-task-steering', name: plugin, config: { directory: folder } }] })
    }
    await writeFile(modelPatch, JSON.stringify(patches), { mode: 0o600 })
    options.onSteer?.((text, id) => {
      const delivery = (async () => {
        const path = join(folder, 'steer-' + String(++sequence).padStart(8, '0'))
        await writeFile(path + '.tmp', JSON.stringify({ id, text }), { mode: 0o600, flag: 'wx' })
        await rename(path + '.tmp', path)
        const ack = join(folder, 'ack-' + id)
        while (!stopped && !signal.aborted && !existsSync(ack)) await delay(100)
        return existsSync(ack)
      })()
      deliveries.add(delivery)
      void delivery.catch(() => {}).finally(() => deliveries.delete(delivery))
      return delivery
    })
    return await runDsh(options, dshArgs({ ...options, modelPatch }))
  } finally {
    stopped = true
    await Promise.allSettled(deliveries)
    await rm(folder, { recursive: true, force: true })
  }
}

function runDsh({ binary, cwd, sessionId, prompt, signal, onDraft, onActivity, timeoutMs = 15 * 60_000 }, args) {
  if (signal.aborted) return Promise.reject(new Error('已停止'))
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32'
    const child = spawn(binary, args, {
      cwd, env: runtimeEnv(), detached: group, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let error = '', warning = '', stderr = '', answer = '', currentId = sessionId
    let pendingText = '', textSequence = 0
    let timeout, forcedStop
    let timedOut = false, sawRunEvent = false
    const terminate = signalName => {
      try {
        if (group && child.pid) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch {}
    }
    const stop = () => {
      terminate('SIGTERM')
      if (!forcedStop) {
        forcedStop = setTimeout(() => terminate('SIGKILL'), 1500)
        forcedStop.unref()
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    timeout = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    timeout.unref()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event?.type !== 'error') sawRunEvent = true
      const result = parseDshEvent(event)
      if (typeof result.sessionId === 'string') currentId = result.sessionId
      if (typeof result.answer === 'string') answer = result.answer
      if (typeof result.error === 'string') error = result.error
      if (typeof result.warning === 'string') warning = result.warning
      if (typeof result.draft === 'string') {
        onDraft?.(result.draft)
        pendingText = (pendingText + result.draft).slice(-5000)
      }
      const activity = dshActivity(event)
      if (activity) {
        if (event.type === 'tool_call' && pendingText) {
          onActivity?.({ id: 'text-' + ++textSequence, kind: 'text', status: 'completed', text: pendingText })
          pendingText = ''
        }
        onActivity?.(activity)
      }
    })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-6000) })
    child.stdin.on('error', () => {})
    child.once('error', failure => { error = failure.message })
    child.once('close', code => {
      clearTimeout(timeout)
      clearTimeout(forcedStop)
      signal.removeEventListener('abort', stop)
      lines.close()
      if (signal.aborted) return reject(new Error('已停止'))
      if (timedOut) {
        const failure = new Error('本轮达到 ' + Math.round(timeoutMs / 1000) + ' 秒执行上限。')
        failure.code = 'RDS_RUNTIME_TIMEOUT'
        return reject(failure)
      }
      if (error || code !== 0 || !answer.trim()) {
        const failure = new Error(cleanError(error || warning || stderr))
        if (sessionId && code !== 0 && !sawRunEvent && warning === 'session ' + JSON.stringify(sessionId) + ' does not exist; omit --session-id to start a new Session') {
          failure.code = 'RDS_SESSION_MISSING'
        }
        return reject(failure)
      }
      resolve({ text: answer.trim(), sessionId: currentId })
    })
    child.stdin.end(prompt)
  })
}
