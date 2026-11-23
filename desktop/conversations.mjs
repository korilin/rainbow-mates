import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { findRuntime, runRuntime, runtimeNames } from './runtimes.mjs'
import { readRuntimeCatalog } from './models.mjs'
import { Notes, noteInstructions, parseNoteReply, visibleDraft } from './notes.mjs'
import { existingRoutingTasks, parseRouting, routingPrompt, runRouting } from './routing.mjs'
import { findMentions } from '../shared/mentions.mjs'

const MESSAGE_LIMIT = 24_000
const AUTO_HANDOFF_LIMIT = 2
const MAX_ACTIVE_ROLES = 2
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const required = (value, limit, field) => {
  const text = clean(value, limit)
  if (!text) throw new Error('请填写' + field + '。')
  return text
}
const getThread = (state, id) => {
  const thread = state.threads.find(item => item.id === id)
  if (!thread) throw new Error('这个会话已不存在。')
  return thread
}
const getRole = (state, id) => {
  const role = state.roles.find(item => item.id === id)
  if (!role) throw new Error('这个角色已不存在。')
  return role
}

function roster(state, ids) {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids)].filter(id => state.roles.some(role => role.id === id))
}

function roleView(role) {
  return { id: role.id, name: role.name, type: role.type, form: role.form }
}

function effortError(model, effort) {
  if (effort && !model.efforts.includes(effort)) return '请选择这个模型支持的推理强度。'
  if (!effort && model.efforts.length) return '请选择推理强度。'
  return ''
}

function stamp(thread, message) {
  thread.messageSeq = (thread.messageSeq || 0) + 1
  message.seq = thread.messageSeq
}

const taskById = (thread, id) => thread.tasks?.find(task => task.id === id)
const visitKey = (roleId, taskId) => (taskId || '') + ':' + roleId
const digest = text => createHash('sha256').update(text).digest('hex')

function workRoot(cwd) {
  let directory
  try { directory = realpathSync(cwd) } catch { return cwd }
  for (let root = directory; root !== dirname(root); root = dirname(root)) {
    if (existsSync(join(root, '.git'))) return root
  }
  return directory
}

function overlaps(a, b) {
  const inside = (from, to) => {
    const path = relative(from, to)
    return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
  }
  return inside(a, b) || inside(b, a)
}

export function mentionTargets(text, roles) {
  return [...new Set(findMentions(text, roles).map(mention => mention.roleId))]
}

export function readHandoff(text, roles, authorId) {
  const match = /(?:^|\n)\[交接[：:]([^\]\n]+)\]\s*$/.exec(text)
  if (!match) return { text }
  const role = roles.find(item => item.id !== authorId && item.name === match[1].trim())
  const body = text.slice(0, match.index).trim()
  return role && body ? { text: body, to: role.id } : { text }
}

function seenThrough(thread, cursor) {
  const previous = thread.messages.find(message => message.id === cursor?.messageId)
  return cursor?.seenSeq ?? previous?.seq ?? 0
}

function transcript(thread, job, roles, cursor, excluded) {
  const frontier = seenThrough(thread, cursor)
  const before = thread.messages.filter(message => message.text && !excluded.has(message.id) && message.id !== cursor?.messageId
    && (!job.taskId || !message.taskId || message.taskId === job.taskId)
    && (!message.author || message.status === 'done') && (message.seq === undefined ? !cursor : message.seq > frontier))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
  let remaining = cursor ? 8_000 : 12_000
  const lines = []
  for (const message of before.slice(-12).reverse()) {
    const line = JSON.stringify({
      author: roles.find(role => role.id === message.author?.id)?.name || message.author?.name || '用户',
      text: message.text.slice(0, Math.max(0, Math.min(remaining - 200, 2500))),
    })
    if (line.length > remaining) break
    remaining -= line.length + 1
    lines.unshift(line)
  }
  return lines.join('\n')
}

export function buildPrompt(thread, role, roles, job, { model, modelName, effort, notes, cursor } = {}) {
  const others = roles.filter(item => item.id !== role.id)
  const source = thread.messages.find(message => message.id === job.sourceMessageId && !message.author)
  const reference = thread.messages.find(message => message.id === job.referenceMessageId && message.id !== source?.id)
  const quoted = source?.replyToId && source.replyToId !== reference?.id
    ? thread.messages.find(message => message.id === source.replyToId) : null
  const includeSource = source && (!reference || !source.seq || source.seq > seenThrough(thread, cursor))
  const task = taskById(thread, job.taskId)
  const held = task && thread.messages.find(message => message.id === task.heldMessageId)
  const original = task && thread.messages.find(message => message.id === task.sourceMessageId)
  const dependencies = task?.dependsOn.map(id => taskById(thread, id)).filter(Boolean).map(dependency => ({
    title: dependency.title, resultMessageId: dependency.resultMessageId,
    result: thread.messages.find(message => message.id === dependency.resultMessageId)?.text.slice(0, 2000),
  }))
  const previousResult = task && !cursor && thread.messages.find(message => message.id === task.resultMessageId && message.id !== reference?.id)
  const excluded = new Set([source?.id, reference?.id, quoted?.id, original?.id, previousResult?.id, ...(dependencies || []).map(item => item.resultMessageId)])
  const history = transcript(thread, job, roles, cursor, excluded)
  const setup = [
    '你是当前 Rainbow Deskmates 会话的一位成员。用当前对话的语言回复，并遵循用户的实际请求。',
    '本轮用户消息或交接事项用于确定当前动作，过往消息、任务原文和笔记是供参考的资料。讨论、进度询问和延续决定时先利用已经核对的事实；只有用户要求重新验证、相关内容有变化或证据不足时，才打开必要的文件或核查对应范围。优先使用已给出的文件、章节和行号。需要后续接续的验证结果可简短记录到会话笔记。',
    '你的人设资料：' + JSON.stringify({ 名字: role.name, 职责: role.label, 性格: role.personality }),
    '本轮运行时：' + runtimeNames[role.type],
    model ? '本轮模型 ID：' + model : '',
    modelName && modelName !== model ? '本轮模型名称（运行时目录）：' + modelName : '',
    effort ? '本轮推理强度：' + effort : '',
    model || effort ? '用户问及本轮的模型或推理强度时，使用应用提供的这些值。部署快照或内部构建号仅在运行时明确提供时才可确认。' : '',
    '当前会话：' + thread.name,
    thread.description ? '会话详情：' + thread.description : '',
    thread.anchor ? '本线程聊到的原消息：' + JSON.stringify(thread.anchor) : '',
    '会话成员：' + JSON.stringify(others.map(item => ({ 名字: item.name, 职责: item.label }))),
    thread.autoHandoff && others.length
      ? '确实需要由另一位成员接手时，写清楚已完成事项、验证结果和下一步。如有相关会话笔记，写出完整文件名。最后单独一行写 [交接:成员名]，使用成员列表中的全名。'
      : '',
    noteInstructions,
  ].filter(Boolean).join('\n\n')
  const setupKey = digest(setup)
  const taskFrame = task && JSON.stringify({ title: task.title, instructions: task.instructions, dependencies, originalRequest: original?.text })
  const taskKey = taskFrame ? digest(taskFrame) : undefined
  const includeTask = taskKey && taskKey !== cursor?.taskKey
  const prompt = [
    setupKey !== cursor?.setupKey ? setup : '继续当前会话，只处理本轮新增的要求。',
    (!cursor || cursor.writeAccess !== thread.writeAccess) && (thread.writeAccess ? '本轮允许按用户请求修改工作区。' : '本轮工作区为只读。'),
    notes ? '当前会话笔记（Markdown；deleted 和 missing 项已不可用）：\n' + notes : '',
    history ? (cursor?.messageId ? '上轮之后的共享会话记录：\n' : '近期共享会话记录：\n') + history : '',
    includeTask ? '你的任务范围：' + JSON.stringify({ title: task.title, instructions: task.instructions, dependencies,
      ...(original?.id !== source?.id && original ? { originalRequest: original.text } : {}) }) + '。只完成这一项工作。' : '',
    previousResult?.text ? '任务最近已交付的结果（沿用其中已经核验的事实）：\n' + JSON.stringify(previousResult.text.slice(0, 2500)) : '',
    held ? '收到补充要求前生成的草稿（请按最新要求核对，再决定是否采用）：\n' + JSON.stringify(held.heldText.slice(0, 3500)) : '',
    quoted ? '用户引用的消息（供理解本轮问题）：\n' + JSON.stringify({ author: roles.find(item => item.id === quoted.author?.id)?.name
      || quoted.author?.name || '用户', text: quoted.text.slice(0, 2500) }) : '',
    includeSource ? (reference ? '本轮用户原始要求（供追溯）：\n' : '本轮用户消息（当前指令）：\n') + JSON.stringify(source.text) : '',
    reference ? '本轮指定的交接事项：\n' + JSON.stringify(reference.text.slice(0, 4500)) : '',
    '本轮唤醒方式：' + job.origin,
    job.checkParticipation ? '先判断这项工作是否适合你。如果决定略过，在使用工具或修改文件前，仅回复 [略过]。接受就直接执行。' : '',
    '直接给出对当前会话的回复。用你的身份回答，无需在开头重复自己的名字。',
  ].filter(Boolean).join('\n\n')
  return { prompt, setupKey, taskKey }
}

export class Conversations {
  constructor({ store, defaultDirectory, publish, draft, run = runRuntime, locate = findRuntime, readCatalog = readRuntimeCatalog }) {
    Object.assign(this, { store, defaultDirectory, publish, draft, run, locate, readCatalog })
    this.notes = new Notes(join(dirname(store.filename), 'notes'))
    this.groups = new Map()
    this.activeRoles = new Map()
    this.activeRouting = null
    this.catalogs = new Map()
  }

  change(operation) {
    const result = this.store.mutate(operation)
    this.publish?.(this.snapshot())
    return result
  }

  snapshot() {
    const { roles, threads, settings, activeThreadId } = this.store.value
    const runtimes = Object.keys(runtimeNames).map(type => {
      const path = this.locate(type, type === 'codex' ? settings.codexPath : settings.deepseekPath)
      return { type, available: Boolean(path), path: path || '' }
    })
    const roleDetails = roles.map(role => {
      const runtime = runtimes.find(item => item.type === role.type)
      const id = role.model
      const entry = this.catalogs.get(role.type)
      const catalog = entry?.path === runtime.path ? entry.catalog : null
      const selected = catalog?.models.find(model => model.id === id)
      return { ...role, modelInfo: id ? { id, label: selected?.label || id, effort: role.effort,
        unavailable: Boolean(catalog && !selected), needsEffort: Boolean(selected && effortError(selected, role.effort)) } : null }
    })
    return { roles: roleDetails, settings, activeThreadId, runtimes, defaultDirectory: this.defaultDirectory,
      threads: threads.map(({ sessions, ...thread }) => ({ ...thread,
        tasks: (thread.tasks || []).map(({ sessions, ...task }) => task), noteFiles: this.notes.list(thread.id) })) }
  }

  runtimeCatalog(type, path) {
    if (!path || !this.readCatalog) return null
    const cached = this.catalogs.get(type)
    if (cached?.path === path && Date.now() - cached.startedAt < 30_000) return cached.promise
    const entry = { path, startedAt: Date.now(), catalog: null }
    this.catalogs.set(type, entry)
    entry.promise = this.readCatalog(type, path, this.defaultDirectory).catch(() => null).then(catalog => {
      entry.catalog = catalog
      if (this.catalogs.get(type) === entry) this.publish?.(this.snapshot())
      return catalog
    })
    return entry.promise
  }

  refreshModels() {
    for (const runtime of this.snapshot().runtimes) void this.runtimeCatalog(runtime.type, runtime.path)
  }

  async modelChoices(type) {
    const { settings } = this.store.value
    const path = this.locate(type, type === 'codex' ? settings.codexPath : settings.deepseekPath)
    const catalog = await this.runtimeCatalog(type, path)
    if (!catalog) throw new Error('运行时模型列表暂不可用。')
    return catalog.models
  }

  dispatch(action, input = {}) {
    const { threadId } = input
    switch (action) {
      case 'select': return this.change(state => { getThread(state, threadId); state.activeThreadId = threadId })
      case 'room': return this.createRoom(input)
      case 'renameThread': return this.change(state => { getThread(state, threadId).name = required(input.name, 60, '会话名') })
      case 'deleteThread': return this.deleteThread(threadId)
      case 'reply': return this.openReply(input)
      case 'threadSettings': return this.saveThread(input)
      case 'threadRoles': return this.saveThreadRoles(input)
      case 'readNote':
        getThread(this.store.value, threadId)
        return this.notes.read(threadId, input.file)
      case 'deleteNote':
        getThread(this.store.value, threadId)
        this.notes.delete(threadId, input.file)
        this.publish?.(this.snapshot())
        return
      case 'role': return this.saveRole(input)
      case 'runtimeSettings': return this.saveRuntimeSettings(input)
      case 'send': return this.send(input)
      case 'inviteReply': return this.inviteReply(input)
      case 'stop': return this.stop(threadId)
      default: throw new Error('未知操作。')
    }
  }

  async saveRuntimeSettings(input) {
    const settings = { codexPath: clean(input.codexPath, 4096), deepseekPath: clean(input.deepseekPath, 4096) }
    if (input.routing?.type) {
      const type = input.routing.type
      if (!Object.hasOwn(runtimeNames, type)) throw new Error('请选择有效的分流运行时。')
      const model = clean(input.routing.model, 160)
      const effort = clean(input.routing.effort, 32)
      if (!model) throw new Error('请选择分流模型。')
      const binary = this.locate(type, settings[type + 'Path'])
      const previous = this.store.value.settings
      if (this.readCatalog && (JSON.stringify(previous.routing) !== JSON.stringify({ type, model, effort }) || previous[type + 'Path'] !== settings[type + 'Path'])) {
        const catalog = await this.runtimeCatalog(type, binary)
        const selected = catalog?.models.find(item => item.id === model)
        if (!selected) throw new Error('请选择该运行时列出的分流模型。')
        const error = effortError(selected, effort)
        if (error) throw new Error(error)
      }
      settings.routing = { type, model, effort }
    }
    this.change(state => { state.settings = settings })
    this.refreshModels()
  }

  threadConfig(state, input) {
    const cwd = clean(input.cwd, 4096)
    if (cwd) {
      let isDir = false
      try { isDir = isAbsolute(cwd) && statSync(cwd).isDirectory() } catch {}
      if (!isDir) throw new Error('请选择存在的本地文件夹。')
    }
    return {
      name: required(input.name, 60, '会话名'),
      description: clean(input.description, 4000),
      cwd,
      writeAccess: Boolean(cwd && input.writeAccess === true),
      autoHandoff: input.autoHandoff !== false,
      roleIds: roster(state, input.roleIds),
    }
  }

  createRoom(input) {
    return this.change(state => {
      const id = randomUUID()
      const config = this.threadConfig(state, input)
      state.threads.push({ ...config, id, kind: 'chat', messages: [], sessions: {} })
      state.activeThreadId = id
      return id
    })
  }

  deleteThread(threadId) {
    const deleted = this.change(state => {
      const root = getThread(state, threadId)
      const children = new Map()
      for (const thread of state.threads) {
        if (!thread.parentId) continue
        const siblings = children.get(thread.parentId) || []
        siblings.push(thread.id)
        children.set(thread.parentId, siblings)
      }
      const removed = new Set([root.id])
      for (const id of removed) {
        if (this.groups.has(id)) throw new Error('请先停止这条会话或其回复线程中的 Agent 回复。')
        for (const child of children.get(id) || []) removed.add(child)
      }
      state.threads = state.threads.filter(thread => !removed.has(thread.id))
      if (removed.has(state.activeThreadId)) {
        state.activeThreadId = root.parentId ?? state.threads.find(thread => !thread.parentId)?.id ?? null
      }
      return removed
    })
    for (const id of deleted) this.notes.deleteThread(id)
  }

  openReply({ threadId, messageId }) {
    return this.change(state => {
      const parent = getThread(state, threadId)
      const source = parent.messages.find(message => message.id === messageId)
      if (!source?.text || (source.author && source.status !== 'done')) throw new Error('这条消息暂时无法开启回复线程。')
      const existing = state.threads.find(thread => thread.parentId === threadId && thread.anchorMessageId === messageId)
      if (existing) {
        state.activeThreadId = existing.id
        return existing.id
      }
      const id = randomUUID()
      const name = source.text.replace(/\s+/g, ' ').slice(0, 36)
      const author = state.roles.find(role => role.id === source.author?.id)
      const anchor = { name: author?.name || source.author?.name || '你', text: source.text }
      const { cwd, writeAccess, autoHandoff, roleIds } = parent
      state.threads.push({ id, name, description: '', kind: 'reply', parentId: parent.id, anchorMessageId: messageId,
        anchor, cwd, writeAccess, autoHandoff, roleIds: [...roleIds], sessions: {}, messages: [] })
      state.activeThreadId = id
      return id
    })
  }

  saveThread(input) {
    return this.change(state => {
      const thread = getThread(state, input.threadId)
      if (this.groups.has(thread.id)) throw new Error('请等这轮回复结束后再修改会话。')
      const config = this.threadConfig(state, { ...thread, ...input })
      for (const scope of [thread, ...(thread.tasks || [])]) {
        if (thread.cwd !== config.cwd || thread.writeAccess !== config.writeAccess) scope.sessions = {}
        for (const id of Object.keys(scope.sessions)) if (!config.roleIds.includes(id)) delete scope.sessions[id]
      }
      Object.assign(thread, config)
    })
  }

  saveThreadRoles(input) {
    return this.change(state => {
      const thread = getThread(state, input.threadId)
      if (this.groups.has(thread.id)) throw new Error('请等这轮回复结束后再修改成员列表。')
      thread.roleIds = roster(state, input.roleIds)
      for (const { sessions } of [thread, ...(thread.tasks || [])]) {
        for (const id of Object.keys(sessions)) if (!thread.roleIds.includes(id)) delete sessions[id]
      }
    })
  }

  async saveRole(input) {
    const state = this.store.value
    const { settings } = state
    if (!Object.hasOwn(runtimeNames, input.type)) throw new Error('请选择 Agent 类型。')
    const previous = input.id ? getRole(state, input.id) : null
    const model = clean(input.model, 160)
    const effort = clean(input.effort, 32)
    if (!model) throw new Error('请选择模型版本。')
    if (/\s/.test(model) || model.startsWith('-')) throw new Error('请选择有效的模型版本。')
    if (effort && !/^[a-z][a-z0-9_-]*$/.test(effort)) throw new Error('请选择有效的推理强度。')
    const configuredPath = input.type === 'codex' ? settings.codexPath : settings.deepseekPath
    const changed = input.type !== previous?.type || (previous?.model || '') !== model || (previous?.effort || '') !== effort
    if (this.readCatalog) {
      const catalog = await this.runtimeCatalog(input.type, this.locate(input.type, configuredPath))
      if (!catalog && changed) throw new Error('运行时模型列表暂不可用。')
      if (catalog) {
        const selected = catalog.models.find(item => item.id === model)
        if (!selected) throw new Error('请选择运行时列出的模型。')
        const error = effortError(selected, effort)
        if (error) throw new Error(error)
      }
    }
    return this.change(state => {
      const existing = input.id ? getRole(state, input.id) : null
      const type = input.type
      const name = required(input.name, 36, '角色名')
      if (/[@{}\[\]\n]/.test(name)) throw new Error('角色名不能包含 @、换行或括号标记。')
      if (state.roles.some(role => role.id !== existing?.id && role.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('已经有同名角色。')
      }
      const role = {
        id: existing?.id || randomUUID(), type, name,
        form: input.form === 'standee' ? 'standee' : 'chibi',
        label: required(input.label, 40, '角色标签'),
        personality: clean(input.personality, 4000),
        model, effort,
      }
      if (!existing) state.roles.push(role)
      else Object.assign(existing, role)
      return role.id
    })
  }

  send({ threadId, text, targetIds, taskId, replyToId }) {
    const state = this.store.value
    const thread = getThread(state, threadId)
    const messageText = required(text, MESSAGE_LIMIT, '消息')
    const roles = thread.roleIds.map(id => getRole(state, id))
    const direct = mentionTargets(messageText, roles)
    const user = { id: randomUUID(), text: messageText, at: Date.now() }
    if (replyToId) {
      const quoted = thread.messages.find(item => item.id === replyToId && item.text && (!item.author || item.status === 'done'))
      if (!quoted) throw new Error('引用的消息已不可用，请重新选择。')
      user.replyToId = quoted.id
    }
    if (taskId) {
      const task = taskById(thread, taskId)
      if (!task) throw new Error('未找到这项任务。')
      if (direct.length > 1) throw new Error('每项任务只能点名一位接手者。')
      const roleId = direct[0] || task.roleId
      if (!thread.roleIds.includes(roleId)) throw new Error('请用 @ 为任务指定接手成员。')
      user.taskId = task.id
      user.targetIds = [roleId]
      this.submit(threadId, [roleId], '用户追问任务', { user, taskId, followOwner: !direct.length })
    } else if (direct.length || Array.isArray(targetIds)) {
      const ids = direct.length ? direct : roster(state, targetIds).filter(id => thread.roleIds.includes(id))
      user.targetIds = ids
      this.submit(threadId, ids, direct.length ? '用户点名' : '用户发送', { user, serial: !direct.length })
    } else if (roles.length && state.settings.routing) {
      user.routing = { status: 'queued' }
      this.submit(threadId, [], '自动分流', { user, route: true })
    } else {
      if (roles.length) user.routing = { status: 'error', error: '请设置分流模型，或用 @ 指定回复成员。', configure: true }
      this.submit(threadId, [], '用户发送', { user })
    }
  }

  inviteReply({ threadId, roleId, messageId }) {
    const state = this.store.value
    const thread = getThread(state, threadId)
    if (!thread.roleIds.includes(roleId)) throw new Error('请选择当前会话的成员。')
    const message = thread.messages.find(item => item.id === messageId && item.text && (!item.author || item.status === 'done'))
    if (!message) throw new Error('未找到交接消息。')
    const person = state.roles.find(role => role.id === message.author?.id)?.name || message.author?.name || '用户'
    const previous = thread.messages.slice(0, thread.messages.indexOf(message)).findLast(item => !item.author)
    this.submit(threadId, [roleId], '用户指定接手，引用消息来自 ' + person, {
      from: person, sourceMessageId: message.author ? message.sourceMessageId || previous?.id : message.id,
      referenceMessageId: message.id, taskId: message.taskId,
    })
  }

  submit(threadId, ids, origin, { user, from, sourceMessageId = user?.id, referenceMessageId, taskId, followOwner, route = false, serial = false } = {}) {
    const group = { sourceMessageId, route, serial, visited: new Set(), running: new Set(), jobs: [], stopped: false, handoffs: 0 }
    this.change(state => {
      const thread = getThread(state, threadId)
      if (user) {
        stamp(thread, user)
        thread.messages.push(user)
      }
      const task = taskById(thread, taskId)
      if (task && !['running', 'queued'].includes(task.status)) {
        task.status = 'queued'
        task.roleId = ids[0]
      }
      for (const id of ids) group.jobs.push(this.queue(state, thread, id, origin, { from, sourceMessageId, referenceMessageId, taskId, followOwner }))
    })
    if (group.jobs.length || route) {
      const groups = this.groups.get(threadId) || new Set()
      groups.add(group)
      this.groups.set(threadId, groups)
      this.pump()
    }
  }

  queue(state, thread, roleId, origin, { from, sourceMessageId, referenceMessageId, taskId, checkParticipation, followOwner, access }) {
    const role = structuredClone(getRole(state, roleId))
    const messageId = randomUUID()
    thread.messages.push({ id: messageId, at: Date.now(), text: '', status: 'queued', author: roleView(role), handoffFrom: from,
      sourceMessageId, referenceMessageId, taskId })
    return { role, messageId, origin, sourceMessageId, referenceMessageId, taskId, checkParticipation, followOwner, access }
  }

  async routeGroup(threadId, group, signal) {
    const { settings } = this.store.value
    const { type, model, effort } = settings.routing || {}
    const { sourceMessageId } = group
    const mark = status => this.change(state => {
      getThread(state, threadId).messages.find(message => message.id === sourceMessageId).routing = status
    })
    mark({ status: 'running' })
    try {
      const binary = type && this.locate(type, settings[type + 'Path'])
      if (!binary || !model) throw new Error('请在运行时设置中配置分流模型。')
      const catalog = await this.runtimeCatalog(type, binary)
      signal.throwIfAborted()
      const selected = catalog?.models.find(item => item.id === model)
      if (this.readCatalog && !selected) throw new Error('分流模型不可用，请在运行时设置中重新选择。')
      if (selected && effortError(selected, effort)) throw new Error('请在运行时设置中选择分流推理强度。')
      const state = this.store.value
      const thread = getThread(state, threadId)
      const message = thread.messages.find(item => item.id === sourceMessageId)
      const roles = thread.roleIds.map(id => getRole(state, id)).filter(role => {
        const path = this.locate(role.type, settings[role.type + 'Path'])
        const entry = this.catalogs.get(role.type)
        const available = entry?.path === path ? entry?.catalog : null
        const choice = available?.models.find(item => item.id === role.model)
        return path && role.model && (!available || choice && !effortError(choice, role.effort))
      }).map(role => ({ ...role, busy: this.activeRoles.has(role.id) }))
      if (!roles.length) throw new Error('请先为会话成员配置可用模型和推理强度。')
      const response = await runRouting(this.run, { type, binary, model, effort, provider: catalog?.provider,
        signal, prompt: routingPrompt(thread, message, roles) })
      signal.throwIfAborted()
      const roleIds = roles.map(role => role.id)
      const result = parseRouting(response, roleIds, existingRoutingTasks(thread, roleIds))
      this.change(current => {
        const updated = getThread(current, threadId)
        const user = updated.messages.find(item => item.id === sourceMessageId)
        user.routing = { status: result.kind === 'silent' ? 'silent' : 'done' }
        if (result.kind === 'reply') {
          group.jobs.push(this.queue(current, updated, result.roleId, '自动分流', { sourceMessageId, checkParticipation: true, access: result.access }))
        } else if (result.kind === 'continue') {
          const task = taskById(updated, result.taskId)
          const roleId = task?.roleId
          if (!roleIds.includes(roleId)) {
            user.routing = { status: 'error', error: '任务需要新的接手成员。请在任务卡上点「指定接手」。' }
            return
          }
          user.taskId = task.id
          if (task.status !== 'running') task.status = 'queued'
          group.jobs.push(this.queue(current, updated, roleId, '延续已有任务', {
            sourceMessageId, taskId: task.id, access: result.access, followOwner: true,
          }))
        } else if (result.kind === 'tasks') {
          const ids = new Map(result.tasks.map(task => [task.id, randomUUID()]))
          updated.tasks ||= []
          for (const planned of result.tasks) {
            const task = { ...planned, id: ids.get(planned.id), sourceMessageId,
              dependsOn: planned.dependsOn.map(id => ids.get(id)), status: planned.roleId ? 'queued' : 'unassigned', sessions: {} }
            updated.tasks.push(task)
            if (task.roleId) group.jobs.push(this.queue(current, updated, task.roleId, '自动认领任务', {
              sourceMessageId, taskId: task.id, checkParticipation: true,
            }))
          }
        }
      })
    } catch (error) {
      if (!signal.aborted) mark({ status: 'error', error: error.message, configure: true })
    }
  }

  pump() {
    for (const [threadId, groups] of this.groups) {
      for (const group of groups) {
        if (group.route && !group.stopped && !this.activeRouting && !this.stoppingAll) {
          group.route = false
          const controller = new AbortController()
          group.routingController = controller
          this.activeRouting = controller
          void this.routeGroup(threadId, group, controller.signal).catch(error => console.error('Routing failed:', error)).finally(() => {
            this.activeRouting = null
            group.routingController = null
            this.pump()
          })
        }
        if (!group.stopped && !this.stoppingAll) {
          for (const job of [...group.jobs]) {
            const state = this.store.value
            const thread = getThread(state, threadId)
            const task = taskById(thread, job.taskId)
            if (job.followOwner && task?.roleId && task.roleId !== job.role.id) job.role = structuredClone(getRole(state, task.roleId))
            const unfinished = (task?.dependsOn || []).map(id => taskById(thread, id)).filter(item => item?.status !== 'done')
            if (unfinished.some(item => !item || !['queued', 'running'].includes(item.status))) {
              group.jobs.splice(group.jobs.indexOf(job), 1)
              this.change(state => {
                const updated = getThread(state, threadId)
                taskById(updated, job.taskId).status = 'blocked'
                updated.messages = updated.messages.filter(message => message.id !== job.messageId)
              })
              continue
            }
            const running = [...this.activeRoles.values()]
            if (unfinished.length || (group.serial && group.running.size) || running.length >= MAX_ACTIVE_ROLES
              || this.activeRoles.has(job.role.id) || job.taskId && running.some(entry => entry.job.taskId === job.taskId)) continue
            const access = job.access || task?.access || (job.checkParticipation ? 'read' : 'write')
            const writeAccess = thread.writeAccess && access === 'write'
            const root = writeAccess ? workRoot(thread.cwd || this.defaultDirectory) : null
            if (root && running.some(entry => entry.root && overlaps(root, entry.root))) continue
            group.jobs.splice(group.jobs.indexOf(job), 1)
            group.running.add(job)
            group.visited.add(visitKey(job.role.id, job.taskId))
            const controller = new AbortController()
            this.activeRoles.set(job.role.id, { job, root, controller })
            void this.consume(threadId, group, job, controller, writeAccess)
              .catch(error => console.error('Conversation queue failed:', error)).finally(() => {
                this.activeRoles.delete(job.role.id)
                group.running.delete(job)
                this.pump()
              })
          }
        }
        if ((!group.jobs.length || group.stopped) && !group.route && !group.routingController && !group.running.size) groups.delete(group)
      }
      if (!groups.size) this.groups.delete(threadId)
    }
  }

  async consume(threadId, group, job, controller, writeAccess) {
    const role = job.role
    const state = this.store.value
    const thread = getThread(state, threadId)
    const roles = thread.roleIds.map(id => getRole(state, id))
    const settings = state.settings
    const task = taskById(thread, job.taskId)
    const session = (task?.sessions || thread.sessions)[role.id]
    const path = this.locate(role.type, role.type === 'codex' ? settings.codexPath : settings.deepseekPath)
    const cwd = thread.cwd || this.defaultDirectory
    const model = role.model || ''
    const effort = role.effort || ''
    const catalogPromise = model && this.runtimeCatalog(role.type, path)
    const catalog = catalogPromise ? await catalogPromise : null
    if (group.stopped) return
    const selected = catalog?.models.find(item => item.id === model)
    const modelName = selected?.label || ''
    const sessionKeyFor = permission => JSON.stringify([role.type, path, cwd, permission, model, role.name, role.label, role.personality,
      ...(effort ? [effort] : [])])
    const sessionKey = sessionKeyFor(thread.writeAccess)
    const compatibleKey = session?.key === sessionKey || thread.writeAccess && session?.key === sessionKeyFor(false)
    const canResume = compatibleKey && (!session.model || session.model === model)
      && (!session.effort || session.effort === effort)
    this.change(current => {
      const updated = getThread(current, threadId)
      const message = updated.messages.find(item => item.id === job.messageId)
      message.status = 'running'
      message.author = roleView(role)
      const currentTask = taskById(updated, job.taskId)
      if (currentTask) Object.assign(currentTask, { status: 'running', roleId: role.id, access: job.access || currentTask.access })
      if (model) message.model = model
      if (modelName && modelName !== model) message.modelName = modelName
      if (effort) message.effort = effort
    })
    const anchorRole = state.threads.find(item => item.id === thread.parentId)?.messages
      .find(message => message.id === thread.anchorMessageId)?.author?.id
    const name = state.roles.find(item => item.id === anchorRole)?.name
    const latest = getThread(this.store.value, threadId)
    const promptThread = { ...latest, writeAccess, ...(name && latest.anchor ? { anchor: { ...latest.anchor, name } } : {}) }
    const seenSeq = latest.messageSeq || 0
    let result
    let failure
    let noteVersions
    let context
    try {
      if (!model) throw new Error('请先在角色设置中为「' + role.name + '」选择模型。')
      if (!path) throw new Error('未找到 ' + runtimeNames[role.type] + '。请在运行时设置中选择可执行文件。')
      if (this.readCatalog && !selected) {
        throw new Error(catalog ? '所选模型已不在运行时列表中，请重新选择。' : '暂时无法确认模型列表，请稍后再试。')
      }
      const invalidEffort = selected && effortError(selected, effort)
      if (invalidEffort) throw new Error('请为「' + role.name + '」选择该模型支持的推理强度。')
      const reference = thread.messages.find(message => message.id === job.referenceMessageId)
      const source = thread.messages.find(message => message.id === job.sourceMessageId)
      const named = this.notes.list(threadId).filter(file => reference?.text.includes(file) || source?.text.includes(file))
      const preferred = [...new Set([...(reference?.noteRefs || []), ...named])].slice(0, 8)
      const execute = cursor => {
        const notes = this.notes.context(threadId, { seen: cursor?.noteVersions,
          preferred: cursor ? preferred : [...new Set([...(task?.noteRefs || []), ...preferred])].slice(0, 8) })
        noteVersions = notes.versions
        context = buildPrompt(promptThread, role, roles, job, { model, modelName, effort, notes: notes.context, cursor })
        return this.run({
          type: role.type, binary: path, cwd, sessionId: cursor?.id,
          writeAccess, model, effort, provider: catalog?.provider,
          prompt: context.prompt,
          signal: controller.signal,
          onDraft: text => this.draft?.({ threadId, messageId: job.messageId, text: visibleDraft(text).slice(0, MESSAGE_LIMIT) }),
        })
      }
      try {
        result = await execute(canResume ? session : undefined)
      } catch (error) {
        if (!canResume || error.code !== 'RDS_SESSION_MISSING' || controller.signal.aborted) throw error
        result = await execute()
      }
    } catch (error) { failure = error }
    this.change(current => {
      const updated = getThread(current, threadId)
      const message = updated.messages.find(item => item.id === job.messageId)
      const currentTask = taskById(updated, job.taskId)
      if (group.stopped || failure) {
        message.status = group.stopped ? 'stopped' : 'error'
        message.error = group.stopped ? '本轮已停止。' : failure.message
        if (currentTask) currentTask.status = message.status
        return
      }
      if (job.checkParticipation && result.text.trim() === '[略过]') {
        updated.messages = updated.messages.filter(item => item.id !== job.messageId)
        if (currentTask) Object.assign(currentTask, { status: 'unassigned', roleId: '' })
        return
      }
      const noteReply = parseNoteReply(result.text)
      const sessions = currentTask?.sessions || updated.sessions
      if (result.sessionId) sessions[role.id] = { id: result.sessionId, key: sessionKey, model, effort, messageId: job.messageId, seenSeq,
        noteVersions, setupKey: context.setupKey, taskKey: context.taskKey, writeAccess }
      if (currentTask && updated.messages.some(item => !item.author && item.taskId === job.taskId && item.seq > seenSeq)) {
        message.status = 'held'
        message.heldText = readHandoff(noteReply.text, roles, role.id).text.slice(0, MESSAGE_LIMIT)
        Object.assign(currentTask, { status: 'queued', heldMessageId: message.id })
        return
      }
      let noteError = noteReply.error
      let updatedNotes = false
      const written = []
      for (const operation of noteReply.operations) {
        try {
          if (operation.op === 'write') {
            this.notes.write(threadId, operation.file, operation.markdown)
            written.push(operation.file)
          }
          else this.notes.delete(threadId, operation.file)
          updatedNotes = true
        } catch {
          noteError = '无法更新部分会话笔记。'
        }
      }
      const noteSummary = updatedNotes ? '已更新会话笔记。' : '会话笔记更新失败。'
      const text = (updatedNotes || noteError) && /^(?:\[交接[：:][^\]\n]+\])?$/.test(noteReply.text)
        ? [noteSummary, noteReply.text].filter(Boolean).join('\n') : noteReply.text
      const reply = updated.autoHandoff ? readHandoff(text, roles, role.id) : { text }
      if (noteError) message.noteError = noteError
      message.status = 'done'
      message.at = Date.now()
      message.text = reply.text.slice(0, MESSAGE_LIMIT)
      stamp(updated, message)
      const noteRefs = this.notes.list(threadId).filter(file => written.includes(file) || message.text.includes(file)).slice(0, 8)
      if (noteRefs.length) message.noteRefs = noteRefs
      if (currentTask) {
        delete currentTask.heldMessageId
        Object.assign(currentTask, { status: 'done', resultMessageId: message.id,
          noteRefs: [...new Set([...noteRefs, ...(currentTask.noteRefs || [])])].slice(0, 8) })
      }
      const pending = group.jobs.find(item => item.role.id === reply.to && item.taskId === job.taskId)
      if (reply.to && group.handoffs < AUTO_HANDOFF_LIMIT && !group.visited.has(visitKey(reply.to, job.taskId))
          && !pending?.referenceMessageId && updated.roleIds.includes(reply.to)) {
        message.handoffTo = reply.to
        group.handoffs++
        const origin = role.name + ' 交接'
        if (pending) {
          const queued = updated.messages.find(item => item.id === pending.messageId)
          Object.assign(queued, { handoffFrom: role.name, referenceMessageId: message.id })
          Object.assign(pending, { origin, referenceMessageId: message.id })
        } else {
          if (currentTask) Object.assign(currentTask, { status: 'queued', roleId: reply.to })
          group.jobs.push(this.queue(current, updated, reply.to, origin, {
            from: role.name, sourceMessageId: job.sourceMessageId, referenceMessageId: message.id, taskId: job.taskId,
          }))
        }
      }
    })
  }

  stop(threadId) {
    const groups = this.groups.get(threadId)
    if (!groups) return
    for (const group of groups) {
      group.stopped = true
      group.route = false
      group.routingController?.abort()
      for (const job of group.running) this.activeRoles.get(job.role.id)?.controller.abort()
    }
    this.change(state => {
      const thread = getThread(state, threadId)
      for (const message of thread.messages) {
        if (['queued', 'running'].includes(message.routing?.status)) message.routing = { status: 'stopped', error: '分流已停止。' }
        if (message.status !== 'queued') continue
        message.status = 'stopped'
        message.error = '本轮已停止。'
      }
      for (const task of thread.tasks || []) {
        if (['queued', 'running'].includes(task.status)) task.status = 'stopped'
      }
    })
    this.pump()
  }

  stopAll() {
    this.stoppingAll = true
    for (const threadId of this.groups.keys()) this.stop(threadId)
  }
}
