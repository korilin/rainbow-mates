import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Conversations, mentionTargets, readHandoff } from '../desktop/conversations.mjs'
import { Store } from '../desktop/store.mjs'
import { dshArgs, parseDshEvent } from '../desktop/runtimes.mjs'
import { parseChatAction } from '../desktop/chat-action.mjs'
import { References } from '../desktop/references.mjs'

function workspace(t, run, readCatalog = null) {
  const folder = mkdtempSync(join(tmpdir(), 'rainbow-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = join(folder, 'workspace.json')
  const store = new Store(file)
  store.mutate(state => {
    for (const role of state.roles) Object.assign(role, { model: role.type + '-selected', effort: 'low' })
  })
  const app = new Conversations({ store, defaultDirectory: folder, locate: kind => kind, run, readCatalog })
  return { app, store, file }
}

async function settled(app, threadId = 'clubroom') {
  for (let attempt = 0; attempt < 100 && app.groups.has(threadId); attempt++) await delay(5)
  assert.equal(app.groups.has(threadId), false)
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(5)
  assert.ok(predicate())
}

const action = (value, text = '收到。') => text + '\n<rainbow-action>' + JSON.stringify(value) + '</rainbow-action>'
const start = (title, access = 'read') => action({ kind: 'start', title, access, instructions: '执行 ' + title })
const update = (taskId, instructions) => action({ kind: 'update', taskId, instructions })

test('appearance settings persist independently of runtime paths', async t => {
  const { app, file } = workspace(t)
  app.dispatch('appearanceSettings', { theme: 'dark' })
  await app.dispatch('runtimeSettings', { codexPath: '/configured/codex', deepseekPath: '/configured/dsh' })
  assert.deepEqual(new Store(file).value.settings, { theme: 'dark', codexPath: '/configured/codex', deepseekPath: '/configured/dsh' })
  assert.throws(() => app.dispatch('appearanceSettings', { theme: 'system' }), /请选择浅色或深色/)
  app.dispatch('appearanceSettings', { theme: 'light' })
  assert.equal(new Store(file).value.settings.theme, 'light')
})

test('mentions are exact, case insensitive and can target names containing spaces', () => {
  const roles = [{ id: 'a', name: 'DeepSeek' }, { id: 'b', name: 'DeepSeek 娘' }, { id: 'c', name: '研发龙' }]
  assert.deepEqual(mentionTargets('你好 @deepseek 娘，@{研发龙} 请确认。', roles).sort(), ['b', 'c'])
  assert.deepEqual(mentionTargets('@DeepSeekX @研发龙测试', roles), [])
  assert.deepEqual(readHandoff('请验证改动。\n[交接:研发龙]', roles, 'b'), { text: '请验证改动。', to: 'c' })
  assert.deepEqual(readHandoff('交给自己。\n[交接:研发龙]', roles, 'c'), { text: '交给自己。\n[交接:研发龙]' })
})

test('shared history advances in order and runtime sessions belong to thread and role', async t => {
  const calls = []
  const { app, file } = workspace(t, async call => {
    calls.push(call)
    return { text: call.type + '-result', sessionId: call.type + '-' + calls.length }
  })
  app.dispatch('send', { threadId: 'clubroom', text: '先让同桌各答一次', targetIds: ['codex', 'deepseek'] })
  await settled(app)
  assert.deepEqual(calls.map(call => call.type), ['codex', 'deepseek'])
  assert.match(calls[1].prompt, /codex-result/)
  app.dispatch('send', { threadId: 'clubroom', text: '@DeepSeek 娘 继续', targetIds: ['codex'] })
  await settled(app)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].sessionId, 'deepseek-2')
  const firstMessage = app.snapshot().threads[0].messages[0]
  const branch = app.dispatch('reply', { threadId: 'clubroom', messageId: firstMessage.id })
  app.dispatch('send', { threadId: branch, text: '回复分支', targetIds: ['deepseek'] })
  await settled(app, branch)
  assert.equal(calls[3].sessionId, undefined)
  assert.match(calls[3].prompt, /先让同桌各答一次/)
  app.dispatch('send', { threadId: branch, text: '分支继续', targetIds: ['deepseek'] })
  await settled(app, branch)
  assert.equal(calls[4].sessionId, 'deepseek-4')
  assert.doesNotMatch(calls[4].prompt, /本线程聊到的原消息|回复分支/)
  const reopened = new Store(file)
  assert.equal(reopened.value.activeThreadId, branch)
  assert.equal(reopened.value.threads[0].messages.length, 5)
  assert.equal(reopened.value.threads.at(-1).messages.length, 4)
})

test('auto handoff carries context and cannot ping-pong', async t => {
  const calls = []
  const { app } = workspace(t, async call => {
    calls.push(call)
    return { text: call.type === 'codex' ? '请复核方案。\n[交接:DeepSeek 娘]' : '已经核对。\n[交接:Codex 龙娘]' }
  })
  app.dispatch('threadSettings', { ...app.snapshot().threads[0], threadId: 'clubroom', autoHandoff: true })
  app.dispatch('send', { threadId: 'clubroom', text: '请提出方案', targetIds: ['codex'] })
  await settled(app)
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /请复核方案/)
  assert.match(calls[1].prompt, /Codex 龙娘 交接/)
  assert.deepEqual(app.snapshot().threads[0].messages.slice(1).map(x => [x.text, x.handoffTo]),
    [['请复核方案。', 'deepseek'], ['已经核对。', undefined]])
})

test('task delivery resumes the recipient chat first and only runs explicitly requested remaining checks', async t => {
  const calls = []
  let finishCheck, explicitlyTakeOver
  const { app, store } = workspace(t, async call => {
    calls.push(call)
    if (call.onSteer && call.type === 'codex') return new Promise(resolve => { finishCheck = resolve })
    if (call.onSteer) return { text: '已确认唯一有疑问的限制。', sessionId: 'deepseek-task' }
    if (call.type === 'codex') return { text: start('原始功能检查'), sessionId: 'codex-chat' }
    if (!call.sessionId) return { text: '已有文案初稿 DRAFT-ONE', sessionId: 'deepseek-chat' }
    if (!explicitlyTakeOver) return { text: '已合并事实，交付文案 FINAL-COPY', sessionId: 'deepseek-chat' }
    const taskId = app.snapshot().threads[0].tasks[0].id
    return { text: update(taskId, '只核对剩余的 LIMIT-CHECK'), sessionId: 'deepseek-chat' }
  })
  const threadId = 'clubroom'
  app.dispatch('send', { threadId, text: '原始用户请求 CONTEXT-ONLY' })
  await until(() => finishCheck && app.snapshot().threads[0].messages.some(item => item.text.includes('DRAFT-ONE')))
  finishCheck({ text: '已验证 VERIFIED-FACT，只剩平台限制需确认。\n[交接:DeepSeek 娘]', sessionId: 'codex-task' })
  await settled(app)
  const completed = app.snapshot().threads[0].tasks[0]
  const firstDelivery = calls.filter(call => call.type === 'deepseek').at(-1)
  assert.equal(firstDelivery.onSteer, undefined)
  assert.equal(firstDelivery.sessionId, 'deepseek-chat')
  assert.match(firstDelivery.prompt, /VERIFIED-FACT[\s\S]*DRAFT-ONE[\s\S]*聊天线程收到任务交付/)
  assert.doesNotMatch(firstDelivery.prompt, /执行 原始功能检查/)
  assert.equal(completed.roleId, 'codex')
  assert.equal(completed.status, 'done')
  const replies = app.snapshot().threads[0].messages
  assert.equal(replies.find(item => item.text.includes('FINAL-COPY')).taskThreadId, undefined)
  assert.equal(replies.find(item => item.author?.id === 'codex' && item.taskThreadId)?.taskThreadId, completed.id)
  assert.equal(replies.find(item => item.id === completed.resultMessageId).taskId, completed.id)

  explicitlyTakeOver = true
  app.dispatch('inviteReply', { threadId, roleId: 'deepseek', messageId: completed.resultMessageId })
  await settled(app)
  const [secondDelivery, followup] = calls.slice(-2)
  assert.equal(secondDelivery.onSteer, undefined)
  assert.equal(secondDelivery.sessionId, 'deepseek-chat')
  assert.ok(followup.onSteer)
  assert.equal(followup.sessionId, undefined)
  assert.match(followup.prompt, /LIMIT-CHECK[\s\S]*上一位成员已交付的结果[\s\S]*VERIFIED-FACT/)
  assert.doesNotMatch(followup.prompt, /执行 原始功能检查|CONTEXT-ONLY/)
  const [task] = store.value.threads[0].tasks
  assert.equal(task.id, completed.id)
  assert.equal(task.roleId, 'deepseek')
  assert.equal(task.sessions.codex.id, 'codex-task')
  assert.equal(task.sessions.deepseek.id, 'deepseek-task')
  assert.equal(task.status, 'done')
})

test('only tasks in an opted-in conversation receive a desktop tool grant', async t => {
  const calls = []
  let closes = 0
  const { app, file } = workspace(t, async call => {
    calls.push(call)
    return { text: call.onSteer ? '已验证' : start('操作桌面') }
  })
  app.computer = { available: true, async grant() {
    return { url: 'http://127.0.0.1:10001/desktop', close: () => { closes++ } }
  } }
  const threadId = 'clubroom'
  assert.equal(app.snapshot().threads[0].computerUse, false)
  app.dispatch('threadSettings', { threadId, computerUse: true })
  assert.equal(new Store(file).value.threads[0].computerUse, true)
  app.dispatch('send', { threadId, text: '@DeepSeek 娘 验证界面', targetIds: ['deepseek'] })
  await settled(app)
  assert.deepEqual(calls.map(call => call.computerUrl), [undefined, 'http://127.0.0.1:10001/desktop'])
  assert.match(calls[1].prompt, /当前会话已开启 Computer Use/)
  assert.equal(closes, 1)
})

test('stopping marks active and queued replies and does not run the next role', async t => {
  const calls = []
  const { app } = workspace(t, call => new Promise((resolve, reject) => {
    calls.push(call)
    call.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  }))
  app.dispatch('send', { threadId: 'clubroom', text: '这轮要停止', targetIds: ['codex', 'deepseek'] })
  await until(() => calls.length === 1)
  app.stopAll()
  await settled(app)
  assert.equal(calls.length, 1)
  assert.deepEqual(app.snapshot().threads[0].messages.slice(1).map(x => x.status), ['stopped', 'stopped'])
})

test('DSH adapter parses native event fields and preserves the resume permission preset', () => {
  assert.equal(parseDshEvent({ type: 'final', reason: { kind: 'completed' }, sessionId: 'dsh-1', text: '好' }).answer, '好')
  assert.deepEqual(dshArgs({ sessionId: 'd', writeAccess: true }).slice(-3), ['--session-id', 'd', '-'])
  assert.ok(dshArgs({ sessionId: 'd', writeAccess: false }).includes('read-only'))
})

test('rename retains thread identity and deleting a room removes its nested replies', t => {
  const { app, file } = workspace(t, async () => ({ text: 'unused' }))
  app.dispatch('send', { threadId: 'clubroom', text: '原消息', targetIds: [] })
  const original = app.snapshot().threads[0].messages[0]
  const branch = app.dispatch('reply', { threadId: 'clubroom', messageId: original.id })
  app.dispatch('send', { threadId: branch, text: '分支消息', targetIds: [] })
  const child = app.snapshot().threads.find(thread => thread.id === branch)
  const nested = app.dispatch('reply', { threadId: branch, messageId: child.messages[0].id })
  app.dispatch('renameThread', { threadId: 'clubroom', name: ' 新会话 ' })
  assert.equal(app.snapshot().threads[0].name, '新会话')
  assert.equal(app.snapshot().threads[0].messages[0].id, original.id)
  assert.equal(app.snapshot().activeThreadId, nested)

  app.dispatch('deleteThread', { threadId: 'clubroom' })
  let reopened = new Store(file)
  assert.deepEqual(reopened.value.threads.map(thread => thread.id), ['ideas', 'code'])
  assert.equal(reopened.value.activeThreadId, 'ideas')
  app.dispatch('deleteThread', { threadId: 'ideas' })
  app.dispatch('deleteThread', { threadId: 'code' })
  reopened = new Store(file)
  assert.deepEqual(reopened.value.threads, [])
  assert.equal(reopened.value.activeThreadId, null)
})

test('model selection is per role and switching model starts a fresh native session', async t => {
  const calls = []
  const { app } = workspace(t, async call => {
    calls.push(call)
    return { text: 'reply-' + calls.length, sessionId: 'session-' + calls.length }
  })
  const send = async () => {
    app.dispatch('send', { threadId: 'clubroom', text: 'test', targetIds: ['codex', 'deepseek'] })
    await settled(app)
  }

  await send()
  await app.dispatch('role', { ...app.snapshot().roles[0], model: 'codex-override' })
  await app.dispatch('role', { ...app.snapshot().roles[1], model: 'deepseek-v4-pro' })
  await send()
  assert.deepEqual(calls.map(call => call.model), ['codex-selected', 'deepseek-selected', 'codex-override', 'deepseek-v4-pro'])
  assert.equal(calls[2].sessionId, undefined)
  assert.equal(calls[3].sessionId, undefined)
  assert.match(calls[2].prompt, /reply-1/)
  await app.dispatch('role', { ...app.snapshot().roles[0], form: 'standee' })
  await send()
  assert.equal(calls[4].sessionId, 'session-3')
  assert.equal(calls[5].sessionId, 'session-4')
})

test('run and prompt share the selected model and effort, and arbitrary choices are rejected', async t => {
  const calls = []
  const native = { id: 'native-model', label: 'Native Model', efforts: ['low', 'high'], defaultEffort: 'low' }
  const { app } = workspace(t, async call => {
    calls.push(call)
    return { text: 'saved', sessionId: 'native-' + calls.length }
  }, async () => ({ models: [native], defaultModel: native }))
  const role = app.snapshot().roles[0]
  await assert.rejects(app.dispatch('role', { ...role, model: '', effort: 'low' }), /选择模型版本/)
  await assert.rejects(app.dispatch('role', { ...role, model: 'external-model' }), /运行时列出的模型/)
  await assert.rejects(app.dispatch('role', { ...role, model: native.id, effort: 'ultra' }), /支持的推理强度/)
  await assert.rejects(app.dispatch('role', { ...role, model: native.id, effort: '' }), /选择推理强度/)
  await app.dispatch('role', { ...role, model: native.id, effort: 'low' })
  const send = async () => {
    app.dispatch('send', { threadId: 'clubroom', text: '你用什么模型？', targetIds: ['codex'] })
    await settled(app)
  }
  await send()
  assert.equal(calls[0].model, 'native-model')
  assert.equal(calls[0].effort, 'low')
  assert.equal(app.snapshot().roles[0].modelInfo.label, 'Native Model')
  await app.dispatch('role', { ...role, name: '新名字', model: native.id, effort: 'high' })
  await send()
  assert.equal(calls[1].sessionId, undefined)
  assert.match(calls[1].prompt, /本轮模型 ID：native-model/)
  assert.match(calls[1].prompt, /本轮模型名称（运行时目录）：Native Model/)
  assert.match(calls[1].prompt, /本轮推理强度：high/)
  assert.match(calls[1].prompt, /"author":"新名字","text":"saved"/)
  assert.equal(app.snapshot().threads[0].messages.at(-1).effort, 'high')
  assert.equal(app.snapshot().threads[0].messages.at(-1).modelName, 'Native Model')
})

test('old default settings never select a runtime model or effort for an existing role', async t => {
  const calls = []
  const readCatalog = async () => ({
    models: [{ id: 'configured', label: 'Configured', efforts: ['high'] }, { id: 'plain', label: 'Plain', efforts: [] }],
    defaultModel: { id: 'configured', defaultEffort: 'high' },
  })
  const run = async call => { calls.push(call); return { text: '完成' } }
  const { app, store, file } = workspace(t, run, readCatalog)
  store.mutate(state => {
    Object.assign(state.settings, { codexModel: 'configured', deepseekModel: 'configured' })
    Object.assign(state.roles[0], { model: '', effort: '' })
    Object.assign(state.roles[1], { model: 'configured', effort: '' })
  })
  const reloaded = new Store(file)
  assert.deepEqual(reloaded.value.settings, { codexPath: '', deepseekPath: '' })
  const reopened = new Conversations({ store: reloaded, defaultDirectory: app.defaultDirectory, locate: app.locate, run, readCatalog })
  reopened.dispatch('send', { threadId: 'clubroom', text: '检查设置', targetIds: ['codex', 'deepseek'] })
  await settled(reopened)
  assert.equal(calls.length, 0)
  const { roles, threads } = reopened.snapshot()
  assert.equal(roles[0].modelInfo, null)
  assert.equal(roles[1].modelInfo.needsEffort, true)
  assert.match(threads[0].messages[1].error, /选择模型/)
  assert.match(threads[0].messages[2].error, /选择.*推理强度/)

  await reopened.dispatch('role', { ...roles[0], model: 'plain', effort: '' })
  reopened.dispatch('send', { threadId: 'clubroom', text: '开始', targetIds: ['codex'] })
  await settled(reopened)
  assert.deepEqual(calls.map(call => [call.model, call.effort]), [['plain', '']])
})

test('new conversations default to handoff and settings updates preserve membership', t => {
  const { app } = workspace(t, async () => ({ text: 'unused' }))
  const id = app.dispatch('room', { name: '新会话', roleIds: ['codex'] })
  assert.equal(app.snapshot().threads.at(-1).autoHandoff, true)
  app.dispatch('threadSettings', { threadId: id, name: '计划', description: '协作目标和约束', autoHandoff: false })
  let thread = app.snapshot().threads.at(-1)
  assert.equal(thread.autoHandoff, false)
  assert.equal(thread.description, '协作目标和约束')
  assert.deepEqual(thread.roleIds, ['codex'])
  app.dispatch('threadRoles', { threadId: id, roleIds: ['deepseek', 'codex'] })
  thread = app.snapshot().threads.at(-1)
  assert.deepEqual(thread.roleIds, ['deepseek', 'codex'])
  assert.equal(thread.autoHandoff, false)
})

test('legacy conversations move into the default group and activity follows the reply tree across group moves', t => {
  const { app, store, file } = workspace(t, async () => ({ text: 'unused' }))
  app.dispatch('send', { threadId: 'clubroom', text: '主会话', targetIds: [] })
  const anchor = app.snapshot().threads[0].messages[0]
  const branch = app.dispatch('reply', { threadId: 'clubroom', messageId: anchor.id })
  app.dispatch('send', { threadId: branch, text: '早期回复', targetIds: [] })
  store.mutate(state => {
    delete state.threadGroups
    for (const thread of state.threads) {
      delete thread.activityAt
      delete thread.groupId
    }
  })

  const reopened = new Conversations({ store: new Store(file), defaultDirectory: app.defaultDirectory, locate: () => null, readCatalog: null })
  const thread = id => reopened.snapshot().threads.find(item => item.id === id)
  assert.deepEqual(reopened.snapshot().threadGroups.map(group => group.id), ['default'])
  assert.equal(thread('clubroom').groupId, 'default')
  assert.equal(thread('clubroom').activityAt, thread(branch).messages[0].at)
  reopened.dispatch('createThreadGroup', { name: '项目' })
  const groupId = reopened.snapshot().threadGroups.at(-1).id
  assert.throws(() => reopened.dispatch('createThreadGroup', { name: '项目' }), /同名/)
  const roomId = reopened.dispatch('room', { name: '新会话', groupId, roleIds: [] })
  assert.equal(thread(roomId).groupId, 'default')
  assert.ok(thread(roomId).activityAt > thread('clubroom').activityAt)
  const activity = thread('clubroom').activityAt
  reopened.dispatch('moveThread', { threadId: 'clubroom', groupId })
  assert.equal(thread('clubroom').activityAt, activity)
  assert.equal(thread(branch).parentId, 'clubroom')
  assert.throws(() => reopened.dispatch('moveThread', { threadId: branch, groupId }), /随所属会话/)
  reopened.dispatch('send', { threadId: branch, text: '最新回复', targetIds: [] })
  assert.ok(thread('clubroom').activityAt > thread(roomId).activityAt)
  assert.equal(thread('clubroom').activityAt, thread(branch).activityAt)
  reopened.dispatch('renameThreadGroup', { groupId, name: '验收项目' })
  assert.equal(new Store(file).value.threadGroups.at(-1).name, '验收项目')
  reopened.dispatch('deleteThreadGroup', { groupId })
  assert.equal(new Store(file).value.threads.find(item => item.id === 'clubroom').groupId, 'default')
  assert.equal(thread(branch).messages.length, 2)
})

test('conversation export retains IDs, quoted replies, notes and tasks without runtime session mappings', async t => {
  const { app, store } = workspace(t, async call => ({
    text: call.onSteer ? '已验收' : start('验证导出'), sessionId: 'private-runtime-session',
  }))
  const threadId = 'clubroom'
  app.dispatch('send', { threadId, text: '验收记录', targetIds: ['codex'] })
  await settled(app)
  const anchor = app.snapshot().threads[0].messages[0]
  const branch = app.dispatch('reply', { threadId, messageId: anchor.id })
  app.dispatch('send', { threadId: branch, text: '保留引用', targetIds: [] })
  app.dispatch('send', { threadId, text: '引用补充', replyToId: anchor.id, targetIds: [] })
  app.notes.write(threadId, '验收.md', '# 已完成')
  app.notes.write(branch, '记录.md', '回复线程笔记')
  const exported = app.exportThread(threadId)
  assert.equal(app.dispatch('threadId', { threadId }), threadId)
  assert.equal(exported.threadId, threadId)
  const [root, reply] = exported.conversations
  assert.equal(root.messages.find(item => item.text === '引用补充').replyToId, anchor.id)
  assert.equal(root.tasks[0].status, 'done')
  assert.equal(root.notes[0].markdown, '# 已完成\n')
  assert.equal(reply.parentId, threadId)
  assert.equal(reply.notes[0].markdown, '回复线程笔记\n')
  assert.equal(reply.anchorMessageId, anchor.id)
  assert.deepEqual(app.exportThread(branch).conversations.map(item => item.id), [branch])
  assert.equal(store.value.threads[0].sessions.codex.id, 'private-runtime-session')
  assert.doesNotMatch(JSON.stringify(exported), /private-runtime-session/)
})

test('agent notes persist as Markdown and are scoped to a conversation', async t => {
  const calls = []
  const { app, file } = workspace(t, async call => {
    calls.push(call)
    if (calls.length === 1) return { text: '记录验收决定。\n<rainbow-notes>\n' + JSON.stringify([
      { op: 'write', file: '验收.md', markdown: '# 验收\n- 先检查导出功能约束。' },
      { op: 'write', file: '进度.md', markdown: '# 进度\n- 初步验证已完成。' },
    ]) + '\n</rainbow-notes>\n[交接:DeepSeek 娘]' }
    if (calls.length === 3) return { text: '<rainbow-notes>\n' + JSON.stringify([
      { op: 'delete', file: '验收.md' },
    ]) + '\n</rainbow-notes>' }
    return { text: '收到。' }
  })
  app.dispatch('threadSettings', { threadId: 'clubroom', description: '验证发布流程' })
  app.dispatch('send', { threadId: 'clubroom', text: '记录关键决定', targetIds: ['codex'] })
  await settled(app)
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /会话详情：验证发布流程/)
  assert.match(calls[1].prompt, /当前会话笔记/)
  assert.match(calls[1].prompt, /导出功能约束/)
  const main = app.snapshot().threads[0]
  assert.equal(main.messages[1].text, '记录验收决定。')
  assert.equal(main.messages[1].handoffTo, 'deepseek')
  assert.deepEqual(app.snapshot().threads[1].noteFiles, [])
  assert.equal(readFileSync(join(file, '..', 'notes', 'clubroom', '验收.md'), 'utf8'), '# 验收\n- 先检查导出功能约束。\n')
  assert.match(app.dispatch('readNote', { threadId: 'clubroom', file: '验收.md' }), /导出功能约束/)
  assert.throws(() => app.dispatch('readNote', { threadId: 'ideas', file: '验收.md' }))
  assert.throws(() => app.dispatch('deleteNote', { threadId: 'clubroom', file: '../workspace.json' }), /文件名/)
  app.dispatch('send', { threadId: 'clubroom', text: '验收笔记过期了', targetIds: ['codex'] })
  await settled(app)
  assert.deepEqual(app.snapshot().threads[0].noteFiles, ['进度.md'])
  assert.equal(app.snapshot().threads[0].messages.at(-1).text, '已更新会话笔记。')
  app.dispatch('deleteNote', { threadId: 'clubroom', file: '进度.md' })
  assert.deepEqual(app.snapshot().threads[0].noteFiles, [])
})

test('resuming after restart only supplies unseen history and changed or deleted notes', async t => {
  const calls = []
  const run = async call => {
    calls.push(call)
    return { text: 'REPLY-' + calls.length, sessionId: call.sessionId || 'codex-1' }
  }
  const { app, file } = workspace(t, run)
  const threadId = 'clubroom'
  app.notes.write(threadId, '变更.md', 'OLD-CONTENT')
  app.notes.write(threadId, '保留.md', 'STABLE-NOTE')
  app.notes.write(threadId, '移除.md', 'REMOVED-NOTE')
  app.dispatch('send', { threadId, text: 'FIRST-REQUEST', targetIds: ['codex'] })
  await settled(app)
  assert.match(calls[0].prompt, /OLD-CONTENT/)
  assert.match(calls[0].prompt, /STABLE-NOTE/)

  const reopened = new Conversations({ store: new Store(file), defaultDirectory: app.defaultDirectory, locate: app.locate, run, readCatalog: null })
  reopened.notes.write(threadId, '变更.md', 'NEW-CONTENT')
  reopened.dispatch('deleteNote', { threadId, file: '移除.md' })
  reopened.dispatch('send', { threadId, text: 'UNSEEN-MESSAGE', targetIds: [] })
  reopened.dispatch('send', { threadId, text: 'SECOND-REQUEST', targetIds: ['codex'] })
  await settled(reopened)
  assert.equal(calls[1].sessionId, 'codex-1')
  assert.match(calls[1].prompt, /UNSEEN-MESSAGE[\s\S]+SECOND-REQUEST/)
  assert.match(calls[1].prompt, /NEW-CONTENT/)
  assert.match(calls[1].prompt, /"deleted":\["移除\.md"\]/)
  assert.doesNotMatch(calls[1].prompt, /FIRST-REQUEST|REPLY-1|OLD-CONTENT|STABLE-NOTE|REMOVED-NOTE/)

  reopened.dispatch('send', { threadId, text: 'THIRD-REQUEST', targetIds: ['codex'] })
  await settled(reopened)
  assert.doesNotMatch(calls[2].prompt, /NEW-CONTENT|STABLE-NOTE|移除\.md|UNSEEN-MESSAGE/)
})

test('handoff enriches an already queued role and brings referenced notes to a resumed session', async t => {
  const calls = []
  const { app } = workspace(t, async call => {
    calls.push(call)
    return { sessionId: call.type, text: call.type === 'codex' ? '请检查约束.md 中的条目。\n[交接:DeepSeek 娘]' : '收到。' }
  })
  const threadId = 'clubroom'
  app.notes.write(threadId, '约束.md', '测试'.repeat(1300) + '\nACCEPTANCE-DETAIL')
  app.notes.write('ideas', '约束.md', 'OTHER-CONVERSATION')
  app.dispatch('send', { threadId, text: 'WARMUP', targetIds: ['deepseek'] })
  await settled(app)
  assert.doesNotMatch(calls[0].prompt, /ACCEPTANCE-DETAIL/)

  app.dispatch('send', { threadId, text: 'ORIGINAL-REQUEST', targetIds: ['codex', 'deepseek'] })
  await settled(app)
  assert.deepEqual(calls.map(call => call.type), ['deepseek', 'codex', 'deepseek'])
  assert.equal(calls[2].sessionId, 'deepseek')
  assert.match(calls[2].prompt, /ACCEPTANCE-DETAIL/)
  assert.match(calls[2].prompt, /本轮用户原始要求（供追溯）：\n"ORIGINAL-REQUEST"/)
  assert.match(calls[2].prompt, /本轮指定的交接事项：\n"请检查约束\.md/)
  assert.doesNotMatch(calls[2].prompt, /WARMUP|OTHER-CONVERSATION/)
  const messages = app.snapshot().threads[0].messages
  const sender = messages.at(-2)
  assert.equal(sender.handoffTo, 'deepseek')
  assert.equal(messages.at(-1).referenceMessageId, sender.id)

  app.dispatch('send', { threadId, text: 'UNRELATED-REQUEST', targetIds: [] })
  app.dispatch('inviteReply', { threadId, roleId: 'deepseek', messageId: sender.id })
  await settled(app)
  assert.doesNotMatch(calls[3].prompt, /ACCEPTANCE-DETAIL|ORIGINAL-REQUEST/)
  assert.match(calls[3].prompt, /本轮指定的交接事项/)
})

test('a missing native session is rebuilt once with notes and unrelated runtime errors are not retried', async t => {
  const calls = []
  const { app, store } = workspace(t, async call => {
    calls.push(call)
    if (calls.length === 2) throw Object.assign(new Error('missing session'), { code: 'RDS_SESSION_MISSING' })
    if (calls.length === 4) throw new Error('runtime interrupted')
    return { text: '回复', sessionId: 'session-' + calls.length }
  })
  const threadId = 'clubroom'
  app.notes.write(threadId, '决策.md', 'RECOVER-THIS-NOTE')
  for (const text of ['FIRST-REQUEST', 'SECOND-REQUEST', 'THIRD-REQUEST']) {
    app.dispatch('send', { threadId, text, targetIds: ['codex'] })
    await settled(app)
  }
  assert.deepEqual(calls.map(call => call.sessionId), [undefined, 'session-1', undefined, 'session-3'])
  assert.doesNotMatch(calls[1].prompt, /RECOVER-THIS-NOTE|FIRST-REQUEST/)
  assert.match(calls[2].prompt, /RECOVER-THIS-NOTE/)
  assert.match(calls[2].prompt, /FIRST-REQUEST[\s\S]*SECOND-REQUEST/)
  assert.equal(store.value.threads[0].sessions.codex.messageId, store.value.threads[0].messages[3].id)
  assert.equal(app.snapshot().threads[0].messages.at(-1).error, 'runtime interrupted')
})

test('all member chat lanes get ordered messages and preserve the session after a silent turn', async t => {
  const calls = []
  const { app, store } = workspace(t, async call => {
    calls.push(call)
    const text = call.type === 'deepseek' || call.prompt.includes('SILENT-MESSAGE') && !call.sessionId ? '[略过]' : '接话'
    return { text, sessionId: call.sessionId || call.type + '-chat' }
  })
  const threadId = 'clubroom'
  store.mutate(state => { state.settings.routing = { type: 'codex', model: 'old-router' } })
  assert.equal(new Store(store.filename).value.settings.routing, undefined)
  app.dispatch('send', { threadId, text: 'SILENT-MESSAGE' })
  app.dispatch('send', { threadId, text: '@Codex 龙娘 SECOND-MESSAGE' })
  await settled(app)
  assert.equal(calls.length, 4)
  for (const type of ['codex', 'deepseek']) {
    const [first, second] = calls.filter(call => call.type === type)
    assert.equal(first.sessionId, undefined)
    assert.match(first.prompt, /SILENT-MESSAGE/)
    assert.doesNotMatch(first.prompt, /SECOND-MESSAGE/)
    assert.equal(second.sessionId, type + '-chat')
    assert.match(second.prompt, /SECOND-MESSAGE/)
    assert.doesNotMatch(second.prompt, /SILENT-MESSAGE/)
  }
  assert.deepEqual(app.snapshot().threads[0].messages.map(message => message.text), ['SILENT-MESSAGE', '@Codex 龙娘 SECOND-MESSAGE', '接话'])
})

test('a naturally addressed task reaches all chats but only its recipient can participate', async t => {
  const calls = []
  const drafts = []
  const events = []
  const { app, store } = workspace(t, async call => {
    calls.push(call)
    call.onDraft(call.type)
    call.onActivity({ id: call.type, kind: 'web', urls: [] })
    if (call.type === 'deepseek') {
      assert.equal(app.snapshot().roles.find(role => role.id === 'deepseek').status, 'idle')
      return { text: action({ kind: 'start', title: '误领任务', instructions: '不要执行', access: 'write' },
        '我也可以出图。\n[交接:Codex 龙娘]'), sessionId: 'fish-chat' }
    }
    return { text: '已经出图。', sessionId: 'dragon-chat' }
  })
  store.mutate(state => { state.roles.find(role => role.id === 'deepseek').name = '大肥鱼' })
  app.draft = event => drafts.push(event.text)
  app.activity = event => events.push(event.item.id)
  const text = '让 codex 龙娘生成几张界面概念宣传图就好了'
  app.dispatch('send', { threadId: 'clubroom', text })
  await settled(app)
  const thread = app.snapshot().threads[0]
  assert.deepEqual(calls.map(call => call.type).sort(), ['codex', 'deepseek'])
  assert.ok(calls.every(call => call.prompt.includes(text)))
  assert.match(calls.find(call => call.type === 'deepseek').prompt, /只输出 \[略过\]/)
  assert.equal(store.value.threads[0].sessions.deepseek.id, 'fish-chat')
  assert.deepEqual(drafts, ['codex'])
  assert.deepEqual(events, ['codex'])
  assert.deepEqual(thread.messages[0].targetIds, ['codex'])
  assert.deepEqual(thread.messages.slice(1).map(message => [message.author.id, message.text]), [['codex', '已经出图。']])
  assert.deepEqual(thread.tasks, [])
})

test('a member replies through its chat while its separate task receives changes in flight', async t => {
  const calls = []
  const updates = []
  let finishTask, taskId
  const { app, store } = workspace(t, async call => {
    calls.push(call)
    if (call.onSteer) {
      call.onSteer((text, id) => { updates.push({ text, id }); return true })
      return new Promise(resolve => { finishTask = () => resolve({ text: '更新后完成', sessionId: 'task-session' }) })
    }
    if (call.type === 'deepseek') return { text: '[略过]', sessionId: 'deepseek-chat' }
    if (!call.sessionId) return { text: start('独立检查'), sessionId: 'codex-chat' }
    if (call.prompt.includes('修改条件')) return { text: update(taskId, '检查新版条件'), sessionId: call.sessionId }
    return { text: '进度正常', sessionId: call.sessionId }
  })
  const threadId = 'clubroom'
  assert.equal(app.snapshot().roles[0].status, 'idle')
  app.dispatch('send', { threadId, text: '请单独检查' })
  await until(() => finishTask)
  taskId = app.snapshot().threads[0].tasks[0].id
  assert.equal(app.snapshot().roles[0].status, 'working')
  app.dispatch('send', { threadId, text: '@Codex 龙娘 进度如何' })
  app.dispatch('send', { threadId, text: '@Codex 龙娘 修改条件', taskId })
  await until(() => updates.length === 1)
  assert.match(updates[0].text, /检查新版条件.*修改条件/)
  assert.ok(app.snapshot().threads[0].messages.some(message => message.text === '进度正常'))
  const [taskCall] = calls.filter(call => call.onSteer)
  assert.equal(taskCall.sessionId, undefined)
  assert.ok(calls.some(call => call.sessionId === 'codex-chat' && call.prompt.includes('进度如何')))
  finishTask()
  await settled(app)
  assert.equal(app.snapshot().roles[0].status, 'idle')
  assert.equal(store.value.threads[0].sessions.codex.id, 'codex-chat')
  assert.equal(store.value.threads[0].tasks[0].sessions.codex.id, 'task-session')
  assert.equal(store.value.threads[0].tasks[0].appliedRevisions, 1)
})

test('workspace writes serialize and an undelivered change resumes the same task before publishing its result', async t => {
  const calls = []
  const releases = []
  let taskId
  const { app } = workspace(t, async call => {
    if (!call.onSteer) {
      if (call.prompt.includes('改用新条件')) return { text: call.type === 'codex' ? update(taskId, '改用新条件') : '[略过]' }
      return { text: start(call.type, 'write') }
    }
    calls.push(call)
    call.onSteer(() => false)
    return new Promise(resolve => releases.push(text => resolve({ text, sessionId: call.sessionId || call.type + '-task' })))
  })
  const threadId = 'clubroom'
  app.dispatch('threadSettings', { threadId, cwd: app.defaultDirectory, writeAccess: true })
  app.dispatch('send', { threadId, text: '请分别修改两处' })
  await until(() => releases.length === 1 && app.snapshot().threads[0].tasks.length === 2)
  const first = app.snapshot().threads[0].tasks.find(task => task.roleId === 'codex')
  taskId = first.id
  assert.equal(calls[0].writeAccess, true)
  app.dispatch('send', { threadId, taskId, text: '@Codex 龙娘 改用新条件' })
  await until(() => app.snapshot().threads[0].tasks.find(task => task.id === taskId).revisions?.length === 1)
  assert.equal(releases.length, 1)
  releases[0]('旧方案草稿')
  await until(() => releases.length === 2)
  assert.equal(calls[1].type, 'deepseek')
  assert.ok(app.snapshot().threads[0].messages.find(message => message.status === 'held'))
  releases[1]('另一项完成')
  await until(() => releases.length === 3)
  assert.equal(calls[2].type, 'codex')
  assert.equal(calls[2].sessionId, 'codex-task')
  assert.match(calls[2].prompt, /改用新条件[\s\S]*旧方案草稿/)
  releases[2]('新方案完成')
  await settled(app)
  assert.deepEqual(app.snapshot().threads[0].tasks.map(task => task.status), ['done', 'done'])
})

test('task control blocks are removed from replies and invalid actions cannot change tasks', () => {
  assert.deepEqual(parseChatAction(start('验收')), { text: '收到。', action: { kind: 'start', title: '验收', access: 'read', instructions: '执行 验收' } })
  assert.match(parseChatAction(action({ kind: 'delete', taskId: 'other' })).error, /无效/)
})

test('a quoted reply stays in the current chat and preserves the quoted text in each member lane', async t => {
  const calls = []
  const { app, file } = workspace(t, async call => {
    calls.push(call)
    return { text: call.type === 'codex' ? '[略过]' : call.sessionId ? '已说明。' : 'QUOTE-ANCHOR', sessionId: call.type + '-chat' }
  })
  const threadId = 'clubroom'
  app.dispatch('send', { threadId, text: '@DeepSeek 娘 给出一句结论' })
  await settled(app)
  const quote = app.snapshot().threads[0].messages.at(-1)
  assert.throws(() => app.dispatch('send', { threadId: 'ideas', replyToId: quote.id, text: '这个是什么？' }), /引用的消息已不可用/)
  app.dispatch('send', { threadId, text: '请解释这句话', replyToId: quote.id })
  await settled(app)
  for (const call of calls.slice(2)) {
    assert.match(call.prompt, /用户引用的消息[\s\S]+QUOTE-ANCHOR[\s\S]+本轮用户消息（当前指令）/)
    assert.equal(call.prompt.match(/QUOTE-ANCHOR/g).length, 1)
  }
  const reopened = new Store(file).value
  assert.equal(reopened.activeThreadId, threadId)
  assert.equal(reopened.threads.length, 3)
  assert.equal(reopened.threads[0].messages.at(-2).replyToId, quote.id)
})

test('composer references are scoped to the conversation and reach the selected runtime with visible reply status', async t => {
  let finish
  const calls = []
  const { app } = workspace(t, call => {
    calls.push(call)
    if (call.type === 'codex') return new Promise(resolve => { finish = resolve })
    return { text: '[略过]', sessionId: 'deepseek-receipt' }
  })
  const refs = new References()
  app.references = refs
  app.notes.write('clubroom', '引用示例.md', '文件内容 CHECK-FILE-41')
  const [file] = refs.paths('clubroom', [app.notes.file('clubroom', '引用示例.md')])
  const [skill, plugin] = refs.register('clubroom', [
    { kind: 'skill', runtime: 'codex', name: 'fixture-skill', path: '/tmp/skills/fixture-skill/SKILL.md' },
    { kind: 'plugin', runtime: 'deepseek', name: 'fixture-plugin', key: 'plugin-fixture' },
  ])
  assert.throws(() => app.dispatch('send', { threadId: 'ideas', text: '跨会话', referenceIds: [file.id] }), /失效/)
  const referenceIds = [file.id, skill.id, plugin.id]
  app.dispatch('send', { threadId: 'clubroom', text: '请参考附件', referenceIds })
  await until(() => finish && calls.length === 2)
  assert.equal(app.snapshot().roles[0].status, 'replying')
  const codex = calls.find(call => call.type === 'codex')
  const deepseek = calls.find(call => call.type === 'deepseek')
  assert.deepEqual(codex.references.map(item => item.kind), ['file', 'skill'])
  assert.match(codex.prompt, /CHECK-FILE-41.*fixture-skill/)
  assert.match(deepseek.prompt, /CHECK-FILE-41.*fixture-plugin/)
  assert.doesNotMatch(deepseek.prompt, /fixture-skill/)
  const outgoing = app.snapshot().threads[0].messages[0]
  assert.deepEqual(outgoing.references.map(item => item.id), referenceIds)
  assert.equal(outgoing.references[0].excerpt, undefined)
  assert.equal(app.exportThread('clubroom').conversations[0].messages[0].references[0].excerpt, undefined)
  finish({ text: '看过了。', sessionId: 'codex-chat' })
  await settled(app)
  assert.equal(app.snapshot().roles[0].status, 'idle')
})
