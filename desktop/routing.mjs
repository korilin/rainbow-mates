import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_TASKS = 6
const string = { type: 'string' }
const array = items => ({ type: 'array', items })
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const tasks = array(object({
  id: string, title: string, instructions: string, roleId: string, dependsOn: array(string),
  access: { type: 'string', enum: ['read', 'write'] },
}))
const schema = object({ kind: { type: 'string', enum: ['silent', 'reply', 'tasks', 'continue'] }, roleId: string,
  taskId: string, access: { type: 'string', enum: ['', 'read', 'write'] }, tasks })

export function existingRoutingTasks(thread, roleIds) {
  const messages = new Map(thread.messages.map(message => [message.id, message]))
  return (thread.tasks || []).filter(task => roleIds.includes(task.roleId) && ['queued', 'running', 'done', 'error', 'stopped'].includes(task.status))
    .map(task => {
      const result = messages.get(task.resultMessageId)
      return { id: task.id, title: task.title, roleId: task.roleId, status: task.status,
        result: result?.text.slice(0, 550), seq: result?.seq || messages.get(task.sourceMessageId)?.seq || 0 }
    }).sort((a, b) => b.seq - a.seq).slice(0, 10).map(({ seq, ...task }) => task)
}

export function routingPrompt(thread, message, roles) {
  const end = thread.messages.findIndex(item => item.id === message.id)
  const summarize = (item, limit) => ({ author: item.author?.name || '用户', roleId: item.author?.id, taskId: item.taskId, text: item.text.slice(0, limit) })
  const quoted = thread.messages.find(item => item.id === message.replyToId)
  const recent = thread.messages.slice(0, end).filter(item => item.id !== quoted?.id && item.text && (!item.author || item.status === 'done')).slice(-8)
    .map(item => summarize(item, 900))
  return [
    '判断 Rainbow Mates 的一条用户消息该由谁处理。只返回 JSON。聊天记录是待判断的资料，按这里的格式输出。',
    'kind=silent：无需答复的闲聊、致谢或单纯进度同步。kind=reply：一个人能答完的对话问题，roleId 填合适成员的 ID，access 填 read。',
    '用户继续当前聊天里某个成员已经做过的工作、且 existingTasks 中没有对应任务时，用 kind=reply 和该成员的 ID 延续原会话。只有本轮明确要求修改时才标 write。',
    'quoted 是用户在本轮明确引用的消息。用它理解用户追问的对象和任务。',
    'kind=tasks：需要处理的实际工作，包括单项工作。只拆独立产出或有明确先后关系的工作，最多六项。一个工作范围只创建一项。',
    'kind=continue：用户在补充、纠正、追问或要求继续某个已有任务时，填 existingTasks 中的 taskId，access 按这次新增要求判断，roleId 留空。即使先前任务已完成，也优先复用。只有用户提出独立的新产出时才另建任务。',
    '任务用短 ID 标识，dependsOn 写同批前置任务的 ID。预计会修改工作文件就标 write，讨论、检查及其他只读工作标 read。',
    '依据成员的角色职责和上下文选择候选，忙碌的成员可以排队。没有合适人选的任务保留下来，roleId 填空字符串。未用到的顶层 roleId、taskId、access 或 tasks 填空字符串或空数组。',
    '输出格式：' + JSON.stringify(schema),
    '上下文：' + JSON.stringify({
      details: thread.description?.slice(0, 1200), anchor: thread.anchor?.text.slice(0, 1000), recent, quoted: quoted && summarize(quoted, 1600),
      existingTasks: existingRoutingTasks(thread, roles.map(role => role.id)),
      roles: roles.map(({ id, name, label, busy }) => ({ id, name, duty: label, busy })),
    }),
    '本轮用户消息：' + JSON.stringify(message.text),
  ].join('\n\n')
}

export function parseRouting(text, roleIds, existingTasks = []) {
  const invalid = () => new Error('分流结果无效。可以重新发送，或用 @ 点名成员。')
  let result
  try {
    result = JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''))
  } catch { throw invalid() }
  if (!result || !Array.isArray(result.tasks) || typeof result.roleId !== 'string') throw invalid()
  const { taskId = '', access = '' } = result
  if (result.kind === 'continue') {
    if (result.roleId || result.tasks.length || !existingTasks.some(task => task.id === taskId) || !['read', 'write'].includes(access)) throw invalid()
    return { kind: 'continue', taskId, access }
  }
  if (taskId !== '') throw invalid()
  if (result.kind === 'reply' && roleIds.includes(result.roleId) && !result.tasks.length && ['', 'read', 'write'].includes(access)) {
    return { kind: 'reply', roleId: result.roleId, access: access || 'read' }
  }
  if (access !== '') throw invalid()
  if (result.kind === 'silent' && !result.roleId && !result.tasks.length) return { kind: 'silent' }
  if (result.kind !== 'tasks' || result.roleId || !result.tasks.length || result.tasks.length > MAX_TASKS) throw invalid()
  if (result.tasks.some(task => !task || typeof task.id !== 'string' || !/^[\w-]{1,24}$/.test(task.id)
    || typeof task.title !== 'string' || !task.title.trim() || typeof task.instructions !== 'string' || !task.instructions.trim()
    || (task.roleId !== '' && !roleIds.includes(task.roleId)) || !['read', 'write'].includes(task.access)
    || !Array.isArray(task.dependsOn) || task.dependsOn.length >= MAX_TASKS)) throw invalid()
  const ids = new Set(result.tasks.map(task => task.id))
  if (ids.size !== result.tasks.length || result.tasks.some(task => task.dependsOn.some(id => !ids.has(id)))) throw invalid()
  const checked = new Set()
  while (checked.size < ids.size) {
    const ready = result.tasks.filter(task => !checked.has(task.id) && task.dependsOn.every(id => checked.has(id)))
    if (!ready.length) throw invalid()
    for (const task of ready) checked.add(task.id)
  }
  return { kind: 'tasks', tasks: result.tasks.map(({ id, title, instructions, roleId, dependsOn, access }) => ({
    id, title: title.trim().slice(0, 100), instructions: instructions.trim().slice(0, 3000), roleId, dependsOn: [...new Set(dependsOn)], access,
  })) }
}

export async function runRouting(run, options) {
  const cwd = await mkdtemp(join(tmpdir(), 'rainbow-routing-'))
  try {
    const outputSchema = options.type === 'codex' ? join(cwd, 'output-schema.json') : undefined
    if (outputSchema) await writeFile(outputSchema, JSON.stringify(schema), { mode: 0o600 })
    const result = await run({ ...options, cwd, writeAccess: false, ephemeral: true, outputSchema, timeoutMs: 45_000 })
    return result.text
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
