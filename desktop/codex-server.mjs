import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexClientInfo } from './app-version.mjs'
import { codexActivity, commandOutput } from './activity.mjs'

const servers = new Map()
function userInput(text, references = []) {
  const skills = references.filter(item => item.kind === 'skill' && item.runtime === 'codex')
  const mentions = skills.map(item => '$' + item.name).join(' ')
  return [
    { type: 'text', text: mentions ? mentions + '\n\n' + text : text, text_elements: [] },
    ...skills.map(({ name, path }) => ({ type: 'skill', name, path })),
  ]
}
const errorText = error => error?.message || 'Codex app-server 未返回有效结果。'

class AppServer {
  constructor(binary, cwd, env, computerUrl) {
    const args = ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'plugins={}']
    if (computerUrl) args.push('-c', 'mcp_servers.rainbow_computer.url=' + JSON.stringify(computerUrl),
      '-c', 'mcp_servers.rainbow_computer.default_tools_approval_mode="approve"')
    this.child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.requests = new Map()
    this.turns = new Map()
    this.sequence = 0
    this.stderr = ''
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let frame
      try { frame = JSON.parse(line) } catch { return }
      if (frame.method) {
        if (frame.id !== undefined) {
          // This client runs with approvalPolicy 'never'. Decline unexpected interactive requests.
          this.send({ id: frame.id, error: { code: -32601, message: 'Interactive requests are unavailable in Rainbow Mates.' } })
        } else this.turns.get(frame.params?.threadId)?.notify(frame)
        return
      }
      this.requests.get(frame.id)?.(frame)
    })
    this.child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2000) })
    this.child.stdin.on('error', () => {})
    this.child.once('error', error => this.close(error))
    this.child.once('close', () => { lines.close(); this.close(new Error(this.stderr || 'Codex app-server 已退出。')) })
    this.ready = this.request('initialize', { clientInfo: codexClientInfo })
      .then(() => this.send({ method: 'initialized' })).catch(error => { this.close(error); throw error })
  }

  send(frame) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  request(method, params, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(this.closed)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const finish = ({ result, error }) => {
        clearTimeout(timer)
        this.requests.delete(id)
        if (error) reject(new Error(errorText(error)))
        else resolve(result)
      }
      const timer = setTimeout(() => finish({ error: { message: method + ' 超时。' } }), timeoutMs)
      timer.unref()
      this.requests.set(id, finish)
      this.send({ id, method, params })
    })
  }

  close(error = new Error('Codex app-server 已关闭。')) {
    if (this.closed) return
    this.closed = error
    this.child.kill()
    for (const finish of this.requests.values()) finish({ error })
    for (const turn of this.turns.values()) turn.fail(error)
  }
}

export function closeCodexServers() {
  for (const server of servers.values()) server.close()
  servers.clear()
}

function appServer(binary, cwd, env, computerUrl) {
  let server = !computerUrl && servers.get(binary)
  if (!server || server.closed) {
    server = new AppServer(binary, cwd, env, computerUrl)
    if (!computerUrl) servers.set(binary, server)
  }
  return server
}

export async function runCodex({ binary, cwd, env, sessionId, prompt, model, effort, writeAccess, signal, onDraft, onSteer, onActivity, references,
  computerUrl, timeoutMs = 15 * 60_000 }) {
  const server = appServer(binary, cwd, env, computerUrl)
  let threadId
  try {
    await server.ready
    signal.throwIfAborted()
    const sandbox = writeAccess ? 'workspace-write' : 'read-only'
    const sandboxPolicy = writeAccess
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', networkAccess: false }
    const settings = { cwd, model, sandbox, approvalPolicy: 'never' }
    let response
    try {
      response = sessionId
        ? await server.request('thread/resume', { threadId: sessionId, excludeTurns: true, ...settings })
        : await server.request('thread/start', settings)
    } catch (error) {
      if (sessionId && /no rollout (found|available)|thread not found|unknown thread|thread.+does not exist/i.test(error.message)) {
        error.code = 'RDS_SESSION_MISSING'
      }
      throw error
    }
    threadId = response?.thread?.id
    if (!threadId) throw new Error('Codex app-server 未返回线程 ID。')
    signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
      const assistant = new Map()
      const commandTails = new Map()
      let lastOutputAt = 0
      let turnId, interrupted, interruptTimer, complete = false, mediaDelivered = false
      const finish = (error, result) => {
        if (complete) return
        complete = true
        clearTimeout(timeout)
        clearTimeout(interruptTimer)
        signal.removeEventListener('abort', abort)
        server.turns.delete(threadId)
        if (error) reject(error)
        else resolve(result)
      }
      const interrupt = error => {
        if (!interrupted) {
          interrupted = error
          interruptTimer = setTimeout(() => server.close(error), 5000)
          interruptTimer.unref()
        }
        if (turnId) void server.request('turn/interrupt', { threadId, turnId }, 4000).catch(() => server.close(error))
      }
      const abort = () => interrupt(new Error('已停止'))
      const timeout = setTimeout(() => interrupt(new Error('Codex 本轮达到执行上限。')), timeoutMs)
      timeout.unref()
      signal.addEventListener('abort', abort, { once: true })
      server.turns.set(threadId, {
        fail: error => finish(interrupted || error),
        notify({ method, params }) {
          if (turnId && (params.turnId || params.turn?.id) !== turnId) return
          if (method === 'item/commandExecution/outputDelta' && commandTails.has(params.itemId)) {
            const output = commandOutput(commandTails.get(params.itemId) + params.delta)
            commandTails.set(params.itemId, output)
            if (Date.now() - lastOutputAt >= 180) {
              lastOutputAt = Date.now()
              onActivity?.({ id: params.itemId, output })
            }
          }
          for (const item of codexActivity(method, params)) {
            if (item.kind === 'command') {
              if (method === 'item/started' && commandTails.size < 48) commandTails.set(item.id, item.output)
              if (method === 'item/completed') {
                item.output ||= commandTails.get(item.id) || ''
                commandTails.delete(item.id)
              }
            }
            if (item.kind === 'asset') mediaDelivered = true
            onActivity?.(item)
          }
          if (method === 'item/agentMessage/delta') {
            const text = (assistant.get(params.itemId) || '') + params.delta
            assistant.set(params.itemId, text)
            onDraft?.(text)
          } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
            assistant.set(params.item.id, params.item.text)
            onDraft?.(params.item.text)
          } else if (method === 'turn/completed') {
            const turn = params.turn
            const text = [...assistant.values()].at(-1)?.trim()
            if (interrupted || turn.status !== 'completed' || !text && !mediaDelivered) finish(interrupted || new Error(errorText(turn.error)))
            else finish(null, { text: text || '图片已生成。', sessionId: threadId })
          }
        },
      })
      void server.request('turn/start', { threadId, input: userInput(prompt, references), approvalPolicy: 'never',
        sandboxPolicy, ...(effort ? { effort } : {}) }).then(value => {
        if (complete) return
        turnId = value?.turn?.id
        if (!turnId) return finish(new Error('Codex app-server 未返回轮次 ID。'))
        if (interrupted) return interrupt(interrupted)
        onSteer?.(async (text, id, refs) => {
          if (complete || interrupted) return false
          await server.request('turn/steer', { threadId, expectedTurnId: turnId, input: userInput(text, refs), clientUserMessageId: id }, 6000)
          return true
        })
      }, error => finish(interrupted || error))
    })
  } finally {
    if (threadId && !server.closed) await server.request('thread/unsubscribe', { threadId }, 3000).catch(() => {})
    if (computerUrl) server.close()
  }
}
