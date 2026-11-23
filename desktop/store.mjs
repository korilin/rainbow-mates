import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function seed() {
  return {
    version: 1,
    settings: { codexPath: '', deepseekPath: '' },
    roles: [
      { id: 'codex', name: 'Codex 龙娘', type: 'codex', label: '研发', form: 'chibi', personality: '冷静利落、有一点傲娇。写代码时严谨，聊天时自然。习惯先看证据再给结论。' },
      { id: 'deepseek', name: 'DeepSeek 娘', type: 'deepseek', label: '产品', form: 'chibi', personality: '温和好奇，擅长拆解需求和组织想法。乐于接梗，提出异议时具体清楚。' },
    ],
    threads: [
      { id: 'clubroom', name: '综合讨论', description: '用于日常交流和共同讨论问题。', kind: 'chat', roleIds: ['codex', 'deepseek'], messages: [], cwd: '', writeAccess: false, autoHandoff: true, sessions: {} },
      { id: 'ideas', name: '灵感收集站', description: '收集和讨论还在成形的想法。', kind: 'ideas', roleIds: ['deepseek', 'codex'], messages: [], cwd: '', writeAccess: false, autoHandoff: true, sessions: {} },
      { id: 'code', name: '代码工坊', description: '聊实现、协作写代码、交接验收。', kind: 'code', roleIds: ['codex', 'deepseek'], messages: [], cwd: '', writeAccess: false, autoHandoff: true, sessions: {} },
    ],
    activeThreadId: 'clubroom',
  }
}

export class Store {
  constructor(filename) {
    this.filename = filename
    this.value = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : seed()
    if (this.value.version !== 1) throw new Error('本地数据版本不受支持。')
    let recovered = false
    for (const key of ['codexModel', 'deepseekModel']) {
      if (!Object.hasOwn(this.value.settings, key)) continue
      delete this.value.settings[key]
      recovered = true
    }
    const defaults = seed()
    const previousLabels = { codex: '研发搭子', deepseek: '产品搭子' }
    for (const role of this.value.roles) {
      if (Object.hasOwn(previousLabels, role.id) && role.label === previousLabels[role.id]) {
        role.label = defaults.roles.find(item => item.id === role.id).label
        recovered = true
      }
    }
    for (const thread of this.value.threads) {
      if (thread.id === 'clubroom' && thread.name === '同桌茶话会') {
        thread.name = defaults.threads[0].name
        recovered = true
      }
      if ((thread.id === 'clubroom' && thread.description === '点名聊两句，或叫上大家一起想办法。')
          || (thread.id === 'ideas' && thread.description === '把半成品想法摆上桌。')) {
        thread.description = defaults.threads.find(item => item.id === thread.id).description
        recovered = true
      }
      for (const message of thread.messages) {
        if (['queued', 'running'].includes(message.status)) {
          message.status = 'stopped'
          message.error = '上次退出时，这轮回复尚未完成。'
          recovered = true
        }
        if (['queued', 'running'].includes(message.routing?.status)) {
          message.routing = { status: 'stopped', error: '上次退出时，分流尚未完成。' }
          recovered = true
        }
      }
      for (const task of thread.tasks || []) {
        if (!['queued', 'running'].includes(task.status)) continue
        task.status = 'stopped'
        recovered = true
      }
      if (!Number.isSafeInteger(thread.messageSeq)) {
        thread.messageSeq = 0
        for (const message of thread.messages) {
          if (message.text && (!message.author || message.status === 'done')) message.seq = ++thread.messageSeq
        }
        recovered = true
      }
    }
    if (!existsSync(filename) || recovered) this.save(this.value)
  }

  save(value) {
    mkdirSync(dirname(this.filename), { recursive: true })
    const temp = this.filename + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.filename)
    this.value = value
  }

  mutate(change) {
    const next = structuredClone(this.value)
    const result = change(next)
    this.save(next)
    return result
  }
}
