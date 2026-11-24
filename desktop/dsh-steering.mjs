import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'rainbow-task-steering'
export const inject = ['agents']

export function apply(ctx, config) {
  const submitted = new Set()
  let taskAgent
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (taskAgent && agent !== taskAgent) return
    taskAgent = agent
    if (submitted.has(message.id)) writeFileSync(join(config.directory, 'ack-' + message.id), '', { mode: 0o600 })
  })
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!taskAgent) return
      let files
      try { files = readdirSync(config.directory).filter(file => /^steer-\d+$/.test(file)).sort() }
      catch { return }
      for (const file of files) {
        try {
          const { id, text } = JSON.parse(readFileSync(join(config.directory, file), 'utf8'))
          if (submitted.has(id) || !/^[a-f0-9-]{36}$/.test(id) || typeof text !== 'string') continue
          submitted.add(id)
          taskAgent.steer({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
        } catch { /* The app will deliver an unacknowledged change in the next turn. */ }
      }
    }, 100)
    timer.unref()
    return () => clearInterval(timer)
  })
}
