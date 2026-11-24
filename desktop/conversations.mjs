import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { findRuntime, runRuntime, runtimeNames } from './runtimes.mjs'
import { messageArtifacts, resolveAsset } from './content.mjs'
import { readRuntimeCatalog } from './models.mjs'
import { Notes, noteInstructions, parseNoteReply, visibleDraft } from './notes.mjs'
import { chatActionInstructions, parseChatAction, visibleChatDraft } from './chat-action.mjs'
import { directedMembers, findMentions } from '../shared/mentions.mjs'
import { inlineReferenceKinds, matchesInlineReference, referenceLimit } from '../shared/composer-references.mjs'
import { DEFAULT_THREAD_GROUP } from '../shared/thread-groups.mjs'
import { referenceContext, runtimeReferences } from './references.mjs'

const MESSAGE_LIMIT = 24_000
const AUTO_HANDOFF_LIMIT = 2
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

function getGroup(state, id) {
  const group = state.threadGroups.find(item => item.id === id)
  if (!group) throw new Error('这个分组已不存在。')
  return group
}

function groupName(state, name, id) {
  const value = required(name, 40, '分组名')
  if (state.threadGroups.some(group => group.id !== id && group.name.toLowerCase() === value.toLowerCase())) {
    throw new Error('已经有同名分组。')
  }
  return value
}

function threadFamily(state, root) {
  const children = new Map()
  for (const thread of state.threads) {
    if (!thread.parentId) continue
    const siblings = children.get(thread.parentId) || []
    siblings.push(thread)
    children.set(thread.parentId, siblings)
  }
  const family = new Set([root])
  for (const thread of family) {
    for (const child of children.get(thread.id) || []) family.add(child)
  }
  return [...family]
}

function touchThread(state, thread, at = Date.now()) {
  // Activity in the same millisecond still has a stable order.
  const activityAt = state.threads.reduce((latest, item) => Math.max(latest, (item.activityAt || 0) + 1), at)
  const byId = new Map(state.threads.map(item => [item.id, item]))
  while (thread && thread.activityAt !== activityAt) {
    thread.activityAt = activityAt
    thread = byId.get(thread.parentId)
  }
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

function stamp(state, thread, message) {
  thread.messageSeq = (thread.messageSeq || 0) + 1
  message.seq = thread.messageSeq
  touchThread(state, thread, message.at)
}

const visibleMessage = message => !message.background || ['done', 'error'].includes(message.status)
function publicMessage(message) {
  const artifacts = messageArtifacts(message)
  return { ...message, ...(artifacts.length ? { artifacts } : {}),
    ...(message.references && { references: message.references.map(({ excerpt, truncated, ...reference }) => reference) }) }
}

const taskById = (thread, id) => thread.tasks?.find(task => task.id === id)
const lane = job => job.taskId ? 'task' : 'chat'
const activeKey = job => job.role.id + ':' + lane(job)
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
  const source = thread.messages.find(message => message.id === job.sourceMessageId)
  const userSequences = new Map(thread.messages.filter(message => !message.author).map(message => [message.id, message.seq]))
  const throughSource = message => !source?.seq || (message.author ? userSequences.get(message.sourceMessageId) || 0 : message.seq || 0) <= source.seq
  const before = thread.messages.filter(message => message.text && !excluded.has(message.id) && message.id !== cursor?.messageId
    && (job.taskId ? message.taskId === job.taskId || !cursor && !message.taskId && throughSource(message) : throughSource(message))
    && (!message.author || message.status === 'done') && (message.seq === undefined ? !cursor : message.seq > frontier))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
  let remaining = cursor ? 8_000 : 12_000
  const lines = []
  for (const message of before.slice(-12).reverse()) {
    const line = JSON.stringify({
      author: roles.find(role => role.id === message.author?.id)?.name || message.author?.name || '用户',
      text: message.text.slice(0, Math.max(0, Math.min(remaining - 200, 2500))),
      references: message.references?.map(({ name, path, key }) => ({ name, path, key })),
    })
    if (line.length > remaining) break
    remaining -= line.length + 1
    lines.unshift(line)
  }
  return lines.join('\n')
}

function referencedConversation(state, fromId, id) {
  if (!id.startsWith('conversation:')) return null
  const thread = state.threads.find(item => item.id === id.slice('conversation:'.length) && item.id !== fromId)
  if (!thread) return null
  const excerpt = thread.messages.filter(message => message.text && (!message.author || message.status === 'done')).slice(-4)
    .map(message => JSON.stringify({ author: message.author?.name || '用户', text: message.text.slice(0, 700) })).join('\n')
  return { id, kind: 'conversation', name: thread.name, targetThreadId: thread.id, description: thread.description?.slice(0, 500), excerpt }
}

function previousMemberWork(thread, job, taskId, excludedIds) {
  const sourceIds = [job.sourceMessageId, taskById(thread, taskId)?.sourceMessageId].filter(Boolean)
  return thread.messages.filter(message => message.author?.id === job.role.id && message.status === 'done' && message.text
    && !excludedIds.includes(message.id) && (message.taskId === taskId || !message.taskId && sourceIds.includes(message.sourceMessageId)))
    .sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 2)
}

function latestTaskResult(thread, task, reference) {
  return task?.resultMessageId && task.resultMessageId !== reference?.id
    ? thread.messages.find(message => message.id === task.resultMessageId && message.status === 'done') : null
}

export function buildPrompt(thread, role, roles, job, { model, modelName, effort, notes, cursor, computer = false, revisions = [], references } = {}) {
  const others = roles.filter(item => item.id !== role.id)
  const source = thread.messages.find(message => message.id === job.sourceMessageId && !message.author)
  const reference = thread.messages.find(message => message.id === job.referenceMessageId && message.id !== source?.id)
  const quoted = source?.replyToId && source.replyToId !== reference?.id
    ? thread.messages.find(message => message.id === source.replyToId) : null
  const task = taskById(thread, job.taskId)
  const deliveredTask = taskById(thread, job.handoffTaskId)
  const continuing = task && reference?.status === 'done' && reference.taskId === task.id
  const deliveredResult = latestTaskResult(thread, deliveredTask, reference)
  const ownWork = deliveredTask || continuing
    ? previousMemberWork(thread, job, (deliveredTask || task).id, [reference?.id, deliveredResult?.id]) : []
  const revisionSources = (task?.revisions || []).map(item => item.sourceMessageId)
  const includeSource = source && !revisionSources.includes(source.id)
    && (!cursor || !source.seq || source.seq > seenThrough(thread, cursor) || !task && !reference)
  const held = task && thread.messages.find(message => message.id === task.heldMessageId)
  const original = task && thread.messages.find(message => message.id === task.sourceMessageId)
  const dependencies = task?.dependsOn.map(id => taskById(thread, id)).filter(Boolean).map(dependency => ({
    title: dependency.title, resultMessageId: dependency.resultMessageId,
    result: thread.messages.find(message => message.id === dependency.resultMessageId)?.text.slice(0, 2000),
  }))
  const previousResult = !cursor && latestTaskResult(thread, task, reference)
  const excluded = new Set([source?.id, reference?.id, quoted?.id, original?.id, previousResult?.id, deliveredResult?.id,
    ...ownWork.map(message => message.id), ...revisionSources, ...(dependencies || []).map(item => item.resultMessageId)])
  const history = transcript(thread, job, roles, cursor, excluded)
  const setup = [
    '你是当前 Rainbow Mates 会话的一位成员。用当前对话的语言回复，并遵循用户的实际请求。',
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
      ? '确实需要另一位成员利用你的交付继续工作时，写清楚已完成事项、验证结果和具体未决问题。如有相关会话笔记，写出完整文件名。最后单独一行写 [交接:成员名]，使用成员列表中的全名。已经完成且只需同步的结果可以直接发到当前会话。'
      : '',
    noteInstructions,
    '会话支持交付文件。要发送实际存在的文件，直接写 Markdown 链接 [文件名](<绝对路径>)。要在消息里展示已生成的图片或动画，可使用 ![说明](<绝对路径>)。',
    job.chatLane ? chatActionInstructions : '',
    computer ? '当前会话已开启 Computer Use。用户要求实际操作应用、浏览器界面或验证功能时可以使用 rainbow_computer 工具。先观察界面再操作，文本模型优先用 inspect 和元素 ID。以工具返回和后续观察判定结果。' : '',
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
    job.chatLane ? chatTasks(thread, role, job) : '',
    revisions.length ? '用户补充或修改的任务要求，按收到顺序执行：\n' + revisions.map(taskRevisionText).join('\n') : '',
    includeTask && !continuing ? '你的任务范围：' + JSON.stringify({ title: task.title, instructions: task.instructions, dependencies,
      ...(original?.id !== source?.id && original ? { originalRequest: original.text } : {}) }) + '。只完成这一项工作。' : '',
    continuing ? '续办已有任务「' + task.title + '」。沿用已经交付且可用的结论，只核对本轮明确新增或仍不确定的问题。' : '',
    previousResult?.text ? '任务最近已交付的结果（沿用其中已经核验的事实）：\n' + JSON.stringify(previousResult.text.slice(0, 2500)) : '',
    held ? '收到补充要求前生成的草稿（请按最新要求核对，再决定是否采用）：\n' + JSON.stringify(held.heldText.slice(0, 3500)) : '',
    quoted ? '用户引用的消息（供理解本轮问题）：\n' + JSON.stringify({ author: roles.find(item => item.id === quoted.author?.id)?.name
      || quoted.author?.name || '用户', text: quoted.text.slice(0, 2500) }) : '',
    includeSource ? (reference ? '本轮用户原始要求（供追溯）：\n' : '本轮用户消息（当前指令）：\n') + JSON.stringify(source.text) : '',
    references,
    reference ? (continuing ? '上一位成员已交付的结果，作为本轮核对的基线：\n' : '本轮指定的交接事项：\n')
      + JSON.stringify(reference.text.slice(0, 4500)) : '',
    deliveredResult?.text ? '这项任务最近已交付的结果：\n' + JSON.stringify(deliveredResult.text.slice(0, 4500)) : '',
    ownWork.length ? '你在同一请求中的已有产出：\n' + JSON.stringify(ownWork.map(message => message.text.slice(0, 4500))) : '',
    deliveredTask ? '聊天线程收到任务交付：' + JSON.stringify({ id: deliveredTask.id, title: deliveredTask.title, status: deliveredTask.status })
      + '。先用交付结果补齐你已有的产出；能直接给用户完整结果时就给出，可安静接收时只输出 [略过]。只有明确的未决问题确实需要工具时才开任务。用 update 续办已结束的交接任务，用 start 创建独立的补充工作；动作里只写新增核对范围。' : '',
    '本轮唤醒方式：' + job.origin,
    job.checkParticipation ? participationPrompt(source, role, roles) : '',
    '直接给出对当前会话的回复。用你的身份回答，无需在开头重复自己的名字。',
  ].filter(Boolean).join('\n\n')
  return { prompt, setupKey, taskKey }
}

function participationPrompt(source, role, roles) {
  const targetIds = source?.targetIds || []
  if (targetIds.includes(role.id)) return '用户点名了你。按聊天线程的规则回应这条消息。'
  if (targetIds.length) {
    const names = roles.filter(item => targetIds.includes(item.id)).map(item => item.name).join('、')
    return '这条消息点名了 ' + names + '。仅阅读这条群消息以保持聊天上下文，避免调用工具或采取行动，只输出 [略过]。'
  }
  return '所有成员都收到本消息。根据你的人设、职责和对话判断是否应参与。没有必要接话时只输出 [略过]。'
}

function chatTasks(thread, role, job) {
  const selected = taskById(thread, job.chatTaskId)
  const own = (thread.tasks || []).filter(task => task.roleId === role.id && ['running', 'queued'].includes(task.status)).slice(-8)
  const tasks = [...new Set(selected ? [...own, selected] : own)].map(task => ({
    id: task.id, title: task.title, status: task.status, owner: task.roleId,
    instructions: task.revisions?.at(-1)?.instructions || task.instructions,
  }))
  return tasks.length ? '与你相关的任务：' + JSON.stringify({ selected: selected?.id, tasks }) : ''
}

const taskRevisionText = revision => '任务更新（来自用户）：' + JSON.stringify({
  instructions: revision.instructions,
  ...(revision.sourceText && revision.sourceText !== revision.instructions ? { userMessage: revision.sourceText } : {}),
})

export class Conversations {
  constructor({ store, defaultDirectory, publish, draft, activity, computer, references, run = runRuntime, locate = findRuntime, readCatalog = readRuntimeCatalog }) {
    Object.assign(this, { store, defaultDirectory, publish, draft, activity, computer, references, run, locate, readCatalog })
    this.notes = new Notes(join(dirname(store.filename), 'notes'))
    this.groups = new Map()
    this.activeRoles = new Map()
    this.liveActivity = new Map()
    this.catalogs = new Map()
  }

  change(operation) {
    const result = this.store.mutate(operation)
    this.publish?.(this.snapshot())
    return result
  }

  snapshot() {
    const { roles, threads, threadGroups, settings, activeThreadId } = this.store.value
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
      const connected = Boolean(runtime.available && id && (!this.readCatalog || selected && !effortError(selected, role.effort)))
      const chat = this.activeRoles.get(role.id + ':chat')
      const status = this.activeRoles.has(role.id + ':task') ? 'working'
        : !connected ? 'disconnected' : chat && !chat.job.passive ? 'replying' : 'idle'
      return { ...role, status, modelInfo: id ? { id, label: selected?.label || id, effort: role.effort,
        unavailable: Boolean(catalog && !selected), needsEffort: Boolean(selected && effortError(selected, role.effort)) } : null }
    })
    return { roles: roleDetails, settings, activeThreadId, threadGroups, runtimes, defaultDirectory: this.defaultDirectory,
      computerAvailable: Boolean(this.computer?.available),
      threads: threads.map(({ sessions, ...thread }) => ({ ...thread,
        computerUse: thread.computerUse === true,
        messages: thread.messages.filter(visibleMessage).map(publicMessage),
        busy: this.groups.has(thread.id),
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

  workspaceDirectory(threadId) {
    return getThread(this.store.value, threadId).cwd || this.defaultDirectory
  }

  referenceScope(threadId) {
    const { settings, roles } = this.store.value
    const thread = getThread(this.store.value, threadId)
    const types = new Set(roles.filter(role => thread.roleIds.includes(role.id)).map(role => role.type))
    const binaries = Object.fromEntries(Object.keys(runtimeNames).filter(type => !types.size || types.has(type))
      .map(type => [type, this.locate(type, settings[type + 'Path'])]))
    return { cwd: thread.cwd || this.defaultDirectory, binaries }
  }

  contentMessage(threadId, messageId) {
    const thread = getThread(this.store.value, threadId)
    const message = thread.messages.find(item => item.id === messageId && visibleMessage(item))
    if (!message) throw new Error('这条消息已不存在。')
    const live = this.liveActivity.get(messageId)
    return { thread, message: live ? { ...message, activity: [...live.values()] } : message }
  }

  messageAsset(threadId, messageId, id) {
    const { thread, message } = this.contentMessage(threadId, messageId)
    return resolveAsset(thread, message, id, this.defaultDirectory)
  }

  dispatch(action, input = {}) {
    const { threadId, groupId } = input
    switch (action) {
      case 'select': return this.change(state => { getThread(state, threadId); state.activeThreadId = threadId })
      case 'room': return this.createRoom(input)
      case 'threadId': return getThread(this.store.value, threadId).id
      case 'moveThread': return this.change(state => {
        const thread = getThread(state, threadId)
        if (thread.parentId) throw new Error('回复线程会随所属会话移动。')
        const group = getGroup(state, groupId)
        thread.groupId = group.id
        group.collapsed = false
      })
      case 'createThreadGroup': return this.change(state => {
        state.threadGroups.push({ id: randomUUID(), name: groupName(state, input.name) })
      })
      case 'renameThreadGroup': return this.change(state => {
        if (groupId === DEFAULT_THREAD_GROUP) throw new Error('默认分组的名称固定。')
        getGroup(state, groupId).name = groupName(state, input.name, groupId)
      })
      case 'collapseThreadGroup': return this.change(state => {
        getGroup(state, groupId).collapsed = input.collapsed === true
      })
      case 'deleteThreadGroup': return this.change(state => {
        if (groupId === DEFAULT_THREAD_GROUP) throw new Error('默认分组不可移除。')
        getGroup(state, groupId)
        const removed = state.threads.filter(thread => thread.groupId === groupId)
        for (const thread of removed) thread.groupId = DEFAULT_THREAD_GROUP
        if (removed.length) getGroup(state, DEFAULT_THREAD_GROUP).collapsed = false
        state.threadGroups = state.threadGroups.filter(group => group.id !== groupId)
      })
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
      case 'appearanceSettings': {
        if (input.theme !== 'light' && input.theme !== 'dark') throw new Error('请选择浅色或深色主题。')
        return this.change(state => { state.settings.theme = input.theme })
      }
      case 'runtimeSettings': return this.saveRuntimeSettings(input)
      case 'send': return this.send(input)
      case 'inviteReply': return this.inviteReply(input)
      default: throw new Error('未知操作。')
    }
  }

  async saveRuntimeSettings(input) {
    const settings = { codexPath: clean(input.codexPath, 4096), deepseekPath: clean(input.deepseekPath, 4096) }
    this.change(state => { Object.assign(state.settings, settings) })
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
      computerUse: input.computerUse === true,
      autoHandoff: input.autoHandoff !== false,
      roleIds: roster(state, input.roleIds),
    }
  }

  createRoom(input) {
    return this.change(state => {
      const id = randomUUID()
      const config = this.threadConfig(state, input)
      const thread = { ...config, id, kind: 'chat', groupId: DEFAULT_THREAD_GROUP, messages: [], sessions: {} }
      touchThread(state, thread)
      state.threads.push(thread)
      getGroup(state, DEFAULT_THREAD_GROUP).collapsed = false
      state.activeThreadId = id
      return id
    })
  }

  deleteThread(threadId) {
    const deleted = this.change(state => {
      const root = getThread(state, threadId)
      const removed = new Set(threadFamily(state, root).map(thread => thread.id))
      for (const id of removed) {
        if (this.groups.has(id)) throw new Error('请等待此会话及回复线程中的成员完成工作。')
      }
      state.threads = state.threads.filter(thread => !removed.has(thread.id))
      if (removed.has(state.activeThreadId)) {
        state.activeThreadId = root.parentId ?? state.threads.find(thread => !thread.parentId)?.id ?? null
      }
      return removed
    })
    for (const id of deleted) this.notes.deleteThread(id)
  }

  exportThread(threadId) {
    const state = this.store.value
    const root = getThread(state, threadId)
    let room = root
    while (room.parentId) room = getThread(state, room.parentId)
    const { id, name } = getGroup(state, room.groupId)
    return {
      format: 'rainbow-mates-conversation', version: 1, exportedAt: new Date().toISOString(),
      group: { id, name }, threadId,
      conversations: threadFamily(state, root).map(thread => ({
        id: thread.id, parentId: thread.parentId, name: thread.name, description: thread.description, kind: thread.kind,
        anchorMessageId: thread.anchorMessageId, anchor: thread.anchor, activityAt: thread.activityAt,
        members: thread.roleIds.map(id => roleView(getRole(state, id))),
        messages: thread.messages.filter(message => visibleMessage(message) && !['queued', 'running'].includes(message.status))
          .map(({ background, ...message }) => publicMessage(message)),
        tasks: (thread.tasks || []).map(({ sessions, ...task }) => task),
        notes: this.notes.list(thread.id).map(file => ({ file, markdown: this.notes.read(thread.id, file) })),
      })),
    }
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
      const { cwd, writeAccess, computerUse, autoHandoff, roleIds } = parent
      const reply = { id, name, description: '', kind: 'reply', parentId: parent.id, anchorMessageId: messageId,
        anchor, cwd, writeAccess, computerUse, autoHandoff, roleIds: [...roleIds], sessions: {}, messages: [] }
      touchThread(state, reply)
      state.threads.push(reply)
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

  send({ threadId, text, targetIds, taskId, replyToId, referenceIds, inlineReferences = [] }) {
    const state = this.store.value
    const thread = getThread(state, threadId)
    const messageText = required(text, MESSAGE_LIMIT, '消息')
    const roles = thread.roleIds.map(id => getRole(state, id))
    const user = { id: randomUUID(), text: messageText, at: Date.now() }
    if (!Array.isArray(inlineReferences) || inlineReferences.length > referenceLimit
      || referenceIds !== undefined && !Array.isArray(referenceIds)) throw new Error('引用格式无效。')
    let previousEnd = 0
    for (const span of inlineReferences) {
      if (!span || typeof span.id !== 'string' || !inlineReferenceKinds.includes(span.kind)
        || !Number.isInteger(span.start) || !Number.isInteger(span.end)
        || span.start < previousEnd || span.start >= span.end || span.end > messageText.length) throw new Error('正文中的引用已失效。')
      previousEnd = span.end
    }
    const selectedIds = [...new Set([...(referenceIds || []), ...inlineReferences.map(span => span.id)])]
    if (selectedIds.length > referenceLimit) throw new Error('每条消息最多引用 8 项。')
    const catalogIds = selectedIds.filter(id => typeof id !== 'string' || !id.startsWith('conversation:'))
    if (catalogIds.length && !this.references) throw new Error('引用不可用。')
    const selected = new Map((this.references?.resolve(threadId, catalogIds) || []).map(item => [item.id, item]))
    for (const id of selectedIds) {
      if (typeof id !== 'string' || !id.startsWith('conversation:')) continue
      if (!inlineReferences.some(span => span.id === id && span.kind === 'conversation')) throw new Error('请选择正文中的会话引用。')
      const conversation = referencedConversation(state, threadId, id)
      if (!conversation) throw new Error('引用的会话已不存在。')
      selected.set(id, conversation)
    }
    let routingText = messageText
    for (const span of [...inlineReferences].reverse()) {
      if (!matchesInlineReference(messageText, span, selected.get(span.id))) throw new Error('正文中的引用已失效。')
      routingText = routingText.slice(0, span.start) + ' '.repeat(span.end - span.start) + routingText.slice(span.end)
    }
    const direct = directedMembers(routingText, roles)
    if (selected.size) user.references = selectedIds.map(id => selected.get(id))
    if (inlineReferences.length) user.inlineReferences = inlineReferences.map(({ id, kind, symbol, start, end }) => ({ id, kind, symbol, start, end }))
    if (replyToId) {
      const quoted = thread.messages.find(item => item.id === replyToId && item.text && (!item.author || item.status === 'done'))
      if (!quoted) throw new Error('引用的消息已不可用，请重新选择。')
      user.replyToId = quoted.id
    }
    if (taskId && !taskById(thread, taskId)) throw new Error('未找到这项任务。')
    if (taskId) user.taskId = taskId
    if (direct.length) user.targetIds = direct
    const explicit = Array.isArray(targetIds)
    const ids = explicit ? (direct.length ? direct : roster(state, targetIds).filter(id => thread.roleIds.includes(id))) : thread.roleIds
    this.submit(threadId, ids, direct.length ? '用户点名' : '用户发送', {
      user, chatTaskId: taskId, checkParticipation: !explicit, serial: explicit && !direct.length,
    })
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
      referenceMessageId: message.id, handoffTaskId: message.taskId,
    })
  }

  submit(threadId, ids, origin, { user, from, sourceMessageId = user?.id, referenceMessageId, handoffTaskId, chatTaskId, checkParticipation, serial = false } = {}) {
    const group = { serial, transferred: new Set(), running: new Set(), jobs: [], stopped: false, handoffs: 0 }
    this.change(state => {
      const thread = getThread(state, threadId)
      if (user) {
        stamp(state, thread, user)
        thread.messages.push(user)
      }
      if (handoffTaskId) {
        const sender = thread.messages.find(message => message.id === referenceMessageId)?.author?.id
        if (sender) group.transferred.add(visitKey(sender, handoffTaskId))
        for (const id of ids) group.transferred.add(visitKey(id, handoffTaskId))
      }
      for (const id of ids) group.jobs.push(this.queue(state, thread, id, origin, { from, sourceMessageId, referenceMessageId, handoffTaskId, chatTaskId,
        checkParticipation, background: checkParticipation && !user?.targetIds?.includes(id),
        passive: Boolean(checkParticipation && user?.targetIds?.length && !user.targetIds.includes(id)) }))
    })
    if (group.jobs.length) {
      const groups = this.groups.get(threadId) || new Set()
      groups.add(group)
      this.groups.set(threadId, groups)
      this.pump()
    }
  }

  queue(state, thread, roleId, origin, { from, sourceMessageId, referenceMessageId, taskId, handoffTaskId, chatTaskId, checkParticipation, background, passive }) {
    const role = structuredClone(getRole(state, roleId))
    const messageId = randomUUID()
    thread.messages.push({ id: messageId, at: Date.now(), text: '', status: 'queued', author: roleView(role), handoffFrom: from,
      sourceMessageId, referenceMessageId, taskId, background: background || undefined })
    return { role, messageId, origin, sourceMessageId, referenceMessageId, taskId, handoffTaskId, chatTaskId, checkParticipation, passive, chatLane: !taskId }
  }

  receiveTaskAction(state, thread, job, group, action) {
    if (action.kind === 'start') {
      const task = { id: randomUUID(), title: action.title, instructions: action.instructions, access: action.access,
        roleId: job.role.id, sourceMessageId: job.sourceMessageId, dependsOn: [], status: 'queued', sessions: {} }
      thread.tasks ||= []
      thread.tasks.push(task)
      group.jobs.push(this.queue(state, thread, task.roleId, '成员从聊天发起任务', {
        taskId: task.id, sourceMessageId: job.sourceMessageId, referenceMessageId: job.handoffTaskId ? job.referenceMessageId : undefined,
      }))
      return { task }
    }
    const task = taskById(thread, action.taskId)
    const active = task && ['queued', 'running'].includes(task.status)
    const mayTakeOver = task && !active && job.handoffTaskId === task.id
    if (!task || (task.roleId !== job.role.id && !mayTakeOver && !(job.chatTaskId === task.id && !thread.roleIds.includes(task.roleId)))) {
      return { error: '成员无法更新这项任务。' }
    }
    const source = thread.messages.find(message => message.id === job.sourceMessageId)
    const revision = { id: randomUUID(), at: Date.now(), instructions: action.instructions,
      sourceMessageId: source?.id, sourceText: job.handoffTaskId ? undefined : source?.text.slice(0, 4000) }
    task.revisions ||= []
    task.revisions.push(revision)
    if (!active) {
      Object.assign(task, { roleId: job.role.id, status: 'queued' })
      group.jobs.push(this.queue(state, thread, task.roleId, '成员从聊天追加任务要求', {
        taskId: task.id, sourceMessageId: job.sourceMessageId, referenceMessageId: task.resultMessageId,
      }))
    }
    return { task, revision }
  }

  deliverTaskRevisions(entry) {
    if (!entry.steer || entry.delivery || entry.controller.signal.aborted) return
    const { threadId, job, steer } = entry
    const thread = getThread(this.store.value, threadId)
    const revisions = taskById(thread, job.taskId).revisions || []
    if (revisions.length <= entry.observedRevisions) return
    let deliveredAll = false
    entry.delivery = (async () => {
      for (const revision of revisions.slice(entry.observedRevisions)) {
        const source = thread.messages.find(message => message.id === revision.sourceMessageId)
        const refs = runtimeReferences(source?.references || [], job.role.type)
        if (!await steer([taskRevisionText(revision), referenceContext(refs)].filter(Boolean).join('\n\n'), revision.id, refs)) return
        entry.observedRevisions++
      }
      deliveredAll = true
    })().catch(() => {}).finally(() => {
      entry.delivery = null
      if (deliveredAll) this.deliverTaskRevisions(entry)
    })
  }

  pump() {
    let started = false
    for (const [threadId, groups] of this.groups) {
      for (const group of groups) {
        if (!group.stopped && !this.stoppingAll) {
          for (const job of [...group.jobs]) {
            const state = this.store.value
            const thread = getThread(state, threadId)
            const task = taskById(thread, job.taskId)
            job.role = structuredClone(getRole(state, job.role.id))
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
            const key = activeKey(job)
            if (unfinished.length || (group.serial && group.running.size) || this.activeRoles.has(key)
              || job.taskId && running.some(entry => entry.threadId === threadId && entry.job.taskId === job.taskId)) continue
            const writeAccess = Boolean(task && thread.writeAccess && task.access !== 'read')
            const root = writeAccess ? workRoot(thread.cwd || this.defaultDirectory) : null
            if (root && running.some(entry => entry.root && overlaps(root, entry.root))) continue
            group.jobs.splice(group.jobs.indexOf(job), 1)
            group.running.add(job)
            const controller = new AbortController()
            const entry = { job, threadId, root, controller, observedRevisions: 0 }
            this.activeRoles.set(key, entry)
            started = true
            void this.consume(threadId, group, entry, writeAccess)
              .catch(error => console.error('Conversation queue failed:', error)).finally(() => {
                this.activeRoles.delete(key)
                group.running.delete(job)
                this.pump()
                this.publish?.(this.snapshot())
              })
          }
        }
        if ((!group.jobs.length || group.stopped) && !group.running.size) groups.delete(group)
      }
      if (!groups.size) this.groups.delete(threadId)
    }
    if (started) this.publish?.(this.snapshot())
  }

  async consume(threadId, group, entry, writeAccess) {
    const { job, controller } = entry
    const { passive } = job
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
    const cached = this.catalogs.get(role.type)
    const catalog = !model ? null : cached?.path === path && cached.catalog || await this.runtimeCatalog(role.type, path)
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
      if (task) message.startedAt = Date.now()
      message.author = roleView(role)
      const currentTask = taskById(updated, job.taskId)
      if (currentTask) Object.assign(currentTask, { status: 'running', roleId: role.id })
      if (model) message.model = model
      if (modelName && modelName !== model) message.modelName = modelName
      if (effort) message.effort = effort
    })
    const anchorRole = state.threads.find(item => item.id === thread.parentId)?.messages
      .find(message => message.id === thread.anchorMessageId)?.author?.id
    const name = state.roles.find(item => item.id === anchorRole)?.name
    const latest = getThread(this.store.value, threadId)
    const promptThread = { ...latest, writeAccess, ...(name && latest.anchor ? { anchor: { ...latest.anchor, name } } : {}) }
    const sourceSeq = latest.messages.find(message => message.id === job.sourceMessageId)?.seq
    const seenSeq = job.chatLane && job.checkParticipation && sourceSeq ? Math.max(seenThrough(latest, session), sourceSeq) : latest.messageSeq || 0
    const revisions = taskById(latest, job.taskId)?.revisions || []
    entry.observedRevisions = revisions.length
    let result
    let failure
    let noteVersions
    let context
    let grant
    const events = new Map()
    this.liveActivity.set(job.messageId, events)
    try {
      if (!model) throw new Error('请先在角色设置中为「' + role.name + '」选择模型。')
      if (!path) throw new Error('未找到 ' + runtimeNames[role.type] + '。请在运行时设置中选择可执行文件。')
      if (this.readCatalog && !selected) {
        throw new Error(catalog ? '所选模型已不在运行时列表中，请重新选择。' : '暂时无法确认模型列表，请稍后再试。')
      }
      const invalidEffort = selected && effortError(selected, effort)
      if (invalidEffort) throw new Error('请为「' + role.name + '」选择该模型支持的推理强度。')
      if (task && thread.computerUse && this.computer?.available) {
        grant = await this.computer.grant(controller.signal)
      }
      const reference = latest.messages.find(message => message.id === job.referenceMessageId)
      const source = thread.messages.find(message => message.id === job.sourceMessageId)
      const named = this.notes.list(threadId).filter(file => reference?.text.includes(file) || source?.text.includes(file))
      const continuation = task && reference?.status === 'done' && reference.taskId === task.id
      const deliveredResult = latestTaskResult(latest, taskById(latest, job.handoffTaskId), reference)
      const ownWork = job.handoffTaskId || continuation
        ? previousMemberWork(latest, job, job.handoffTaskId || task.id, [reference?.id, deliveredResult?.id]) : []
      const handoffNotes = [reference, deliveredResult, ...ownWork].flatMap(message => message?.noteRefs || [])
      const preferred = [...new Set([...handoffNotes, ...named])].slice(0, 8)
      const execute = cursor => {
        const notes = this.notes.context(threadId, { seen: cursor?.noteVersions,
          preferred: cursor ? preferred : [...new Set([...(task?.noteRefs || []), ...preferred])].slice(0, 8) })
        noteVersions = notes.versions
        const quoted = latest.messages.find(message => message.id === source?.replyToId)
        const original = !cursor && latest.messages.find(message => message.id === task?.sourceMessageId)
        const pendingRevisions = revisions.slice(cursor || continuation ? task?.appliedRevisions || 0 : 0)
        const revisedMessages = pendingRevisions.map(revision => latest.messages.find(message => message.id === revision.sourceMessageId))
        const items = [source, quoted, original, ...revisedMessages].filter(Boolean).flatMap(message => message.references || [])
        const refs = passive ? [] : runtimeReferences([...new Map(items.map(item => [item.id, item])).values()], role.type)
        context = buildPrompt(promptThread, role, roles, job, { model, modelName, effort, notes: notes.context, cursor, computer: Boolean(grant),
          revisions: pendingRevisions, references: referenceContext(refs) })
        return this.run({
          type: role.type, binary: path, cwd, sessionId: cursor?.id,
          writeAccess, model, effort, provider: catalog?.provider, computerUrl: grant?.url,
          prompt: context.prompt, references: refs,
          signal: controller.signal,
          onDraft: text => {
            if (!passive) this.draft?.({ threadId, messageId: job.messageId, text: visibleChatDraft(visibleDraft(text)).slice(0, MESSAGE_LIMIT) })
          },
          onActivity: event => {
            const previous = events.get(event.id)
            if (passive || !task && ['tool', 'command', 'text'].includes(event.kind || previous?.kind)) return
            if (!previous && (!event.kind || !task && events.size >= 48)) return
            const item = { at: Date.now(), ...previous,
              ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== '' && value !== undefined)) }
            events.set(item.id, item)
            this.activity?.({ threadId, messageId: job.messageId, item })
          },
          ...(task ? { onSteer: callback => { entry.steer = callback; this.deliverTaskRevisions(entry) } } : {}),
        })
      }
      try {
        result = await execute(canResume ? session : undefined)
      } catch (error) {
        const canRebuild = error.code === 'RDS_SESSION_MISSING' || error.code === 'RDS_SESSION_BUSY'
        if (!canResume || !canRebuild || controller.signal.aborted) throw error
        result = await execute()
      }
    } catch (error) { failure = error } finally { grant?.close(); this.liveActivity.delete(job.messageId) }
    entry.steer = null
    await entry.delivery
    let changedTask
    this.change(current => {
      const updated = getThread(current, threadId)
      const message = updated.messages.find(item => item.id === job.messageId)
      const currentTask = taskById(updated, job.taskId)
      if (currentTask) message.finishedAt = Date.now()
      if (events.size) message.activity = [...events.values()]
      if (group.stopped || failure) {
        if (!group.stopped && job.checkParticipation && (passive || message.background && (!path || !model))) {
          updated.messages = updated.messages.filter(item => item.id !== job.messageId)
          return
        }
        message.status = group.stopped ? 'stopped' : 'error'
        message.error = group.stopped ? '本轮已停止。' : failure.message
        if (currentTask && !group.stopped && (currentTask.revisions?.length || 0) > entry.observedRevisions) {
          currentTask.status = 'queued'
          group.jobs.push(this.queue(current, updated, role.id, '继续处理最新任务要求', { taskId: currentTask.id, sourceMessageId: job.sourceMessageId }))
        } else if (currentTask) currentTask.status = message.status
        return
      }
      const sessions = currentTask?.sessions || updated.sessions
      if (result.sessionId) sessions[role.id] = { id: result.sessionId, key: sessionKey, model, effort, messageId: job.messageId, seenSeq,
        noteVersions, setupKey: context.setupKey, taskKey: context.taskKey, writeAccess }
      if (passive || (job.checkParticipation || job.handoffTaskId) && result.text.trim() === '[略过]') {
        updated.messages = updated.messages.filter(item => item.id !== job.messageId)
        return
      }
      const chatReply = job.chatLane ? parseChatAction(result.text) : { text: result.text }
      const noteReply = parseNoteReply(chatReply.text)
      if (currentTask) {
        currentTask.appliedRevisions = entry.observedRevisions
        if ((currentTask.revisions || []).length > entry.observedRevisions) {
          message.status = 'held'
          message.heldText = readHandoff(noteReply.text, roles, role.id).text.slice(0, MESSAGE_LIMIT)
          Object.assign(currentTask, { status: 'queued', heldMessageId: message.id })
          group.jobs.push(this.queue(current, updated, role.id, '继续处理最新任务要求', { taskId: currentTask.id, sourceMessageId: job.sourceMessageId }))
          return
        }
      }
      const work = chatReply.action && this.receiveTaskAction(current, updated, job, group, chatReply.action)
      if (work?.revision) changedTask = work.task.id
      if (work?.task) message.taskThreadId = work.task.id
      if (chatReply.error || work?.error) message.taskError = chatReply.error || work.error
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
      const body = noteReply.text || (work?.task ? work.revision ? '我会按最新要求更新任务。' : '我开始处理这项任务。' : '')
      const text = (updatedNotes || noteError) && /^(?:\[交接[：:][^\]\n]+\])?$/.test(noteReply.text)
        ? [noteSummary, body].filter(Boolean).join('\n') : body
      const reply = updated.autoHandoff ? readHandoff(text, roles, role.id) : { text }
      if (noteError) message.noteError = noteError
      message.status = 'done'
      message.at = Date.now()
      message.text = reply.text.slice(0, MESSAGE_LIMIT)
      stamp(current, updated, message)
      const noteRefs = this.notes.list(threadId).filter(file => written.includes(file) || message.text.includes(file)).slice(0, 8)
      if (noteRefs.length) message.noteRefs = noteRefs
      if (currentTask) {
        delete currentTask.heldMessageId
        Object.assign(currentTask, { status: 'done', resultMessageId: message.id,
          noteRefs: [...new Set([...noteRefs, ...(currentTask.noteRefs || [])])].slice(0, 8) })
      }
      const handoffTaskId = job.taskId || job.handoffTaskId
      const pending = group.jobs.find(item => item.role.id === reply.to && !item.taskId && !item.referenceMessageId
        && item.sourceMessageId === job.sourceMessageId)
      if (reply.to && group.handoffs < AUTO_HANDOFF_LIMIT && !group.transferred.has(visitKey(reply.to, handoffTaskId))
          && updated.roleIds.includes(reply.to)) {
        message.handoffTo = reply.to
        group.handoffs++
        group.transferred.add(visitKey(role.id, handoffTaskId))
        group.transferred.add(visitKey(reply.to, handoffTaskId))
        const origin = role.name + ' 交接'
        if (pending) {
          const queued = updated.messages.find(item => item.id === pending.messageId)
          Object.assign(queued, { handoffFrom: role.name, referenceMessageId: message.id, background: undefined })
          Object.assign(pending, { origin, referenceMessageId: message.id, handoffTaskId, checkParticipation: false, passive: false })
        } else {
          group.jobs.push(this.queue(current, updated, reply.to, origin, {
            from: role.name, sourceMessageId: job.sourceMessageId, referenceMessageId: message.id, handoffTaskId,
          }))
        }
      }
    })
    if (changedTask) {
      const taskEntry = [...this.activeRoles.values()].find(item => item.threadId === threadId && item.job.taskId === changedTask)
      if (taskEntry) this.deliverTaskRevisions(taskEntry)
    }
  }

  stop(threadId) {
    const groups = this.groups.get(threadId)
    if (!groups) return
    for (const group of groups) {
      group.stopped = true
      for (const job of group.running) this.activeRoles.get(activeKey(job))?.controller.abort()
    }
    this.change(state => {
      const thread = getThread(state, threadId)
      for (const message of thread.messages) {
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
