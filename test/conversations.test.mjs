import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Conversations, mentionTargets, readHandoff } from '../desktop/conversations.mjs'
import { Store } from '../desktop/store.mjs'
import { parseEvent, runtimeArgs } from '../desktop/runtimes.mjs'
import { parseRouting } from '../desktop/routing.mjs'

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

const routeReply = roleId => JSON.stringify({ kind: 'reply', roleId, tasks: [] })
const plannedTask = (id, roleId, dependsOn = [], access = 'read') => ({ id, title: id, instructions: '只执行 ' + id, roleId, dependsOn, access })
const routeTasks = (...tasks) => JSON.stringify({ kind: 'tasks', roleId: '', tasks })

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

test('stopping marks active and queued replies and does not run the next role', async t => {
  const calls = []
  const { app } = workspace(t, call => new Promise((resolve, reject) => {
    calls.push(call)
    call.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  }))
  app.dispatch('send', { threadId: 'clubroom', text: '这轮要停止', targetIds: ['codex', 'deepseek'] })
  app.dispatch('stop', { threadId: 'clubroom' })
  await settled(app)
  assert.equal(calls.length, 1)
  assert.deepEqual(app.snapshot().threads[0].messages.slice(1).map(x => x.status), ['stopped', 'stopped'])
})

test('adapters parse native event fields and preserve resume sandbox configuration', () => {
  assert.equal(parseEvent('codex', { type: 'thread.started', thread_id: 'a' }).sessionId, 'a')
  assert.equal(parseEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: '好' } }).answer, '好')
  assert.equal(parseEvent('deepseek', { type: 'final', reason: { kind: 'completed' }, sessionId: 'dsh-1', text: '好' }).answer, '好')
  assert.deepEqual(runtimeArgs('codex', { sessionId: 'c', writeAccess: false }).slice(-3), ['sandbox_mode="read-only"', 'c', '-'])
  assert.deepEqual(runtimeArgs('deepseek', { sessionId: 'd', writeAccess: true }).slice(-3), ['--session-id', 'd', '-'])
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

test('routing is configured independently, handles silence, and direct mentions bypass it', async t => {
  const calls = []
  const { app } = workspace(t, async call => {
    calls.push(call)
    if (!call.ephemeral) return { text: '答复', sessionId: 'conversation' }
    if (call.prompt.endsWith('"同步而已"')) return { text: '{"kind":"silent","roleId":"","tasks":[]}' }
    return { text: routeReply('deepseek') }
  })
  const threadId = 'clubroom'
  app.dispatch('send', { threadId, text: '未配置时也要记下来' })
  assert.equal(calls.length, 0)
  assert.equal(app.snapshot().threads[0].messages[0].routing.configure, true)
  await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
  app.dispatch('send', { threadId, text: '同步而已' })
  await settled(app)
  assert.equal(app.snapshot().threads[0].messages.at(-1).routing.status, 'silent')
  app.dispatch('send', { threadId, text: '帮我想想' })
  await settled(app)
  app.dispatch('send', { threadId, text: '@Codex 龙娘 再问一句' })
  await settled(app)
  assert.deepEqual(calls.map(call => [call.type, call.model, Boolean(call.ephemeral)]), [
    ['codex', 'route-only', true], ['codex', 'route-only', true], ['deepseek', 'deepseek-selected', false], ['codex', 'codex-selected', false],
  ])
  assert.ok(calls[0].outputSchema)
  assert.equal(calls[0].writeAccess, false)
  assert.equal(calls[2].sessionId, undefined)
})

test('routed tasks run in parallel, allow consecutive messages and resume by task', async t => {
  const called = []
  const gates = new Map()
  const { app, store } = workspace(t, call => {
    called.push(call)
    if (call.ephemeral) return Promise.resolve({ text: routeTasks(plannedTask('A', 'codex'), plannedTask('B', 'deepseek'), plannedTask('C', 'codex', ['A', 'B'])) })
    const key = /"title":"([ABC])"/.exec(call.prompt)?.[1] || 'direct'
    if (key === 'C' || call.prompt.includes('FOLLOWUP')) return Promise.resolve({ text: '完成', sessionId: call.sessionId || 'c-session' })
    return new Promise(resolve => gates.set(key, () => resolve({ text: `RESULT-${key}`, sessionId: key + '-session' })))
  })
  await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
  const threadId = 'clubroom'
  app.dispatch('send', { threadId, text: '拆开检查再汇总' })
  await until(() => gates.has('A') && gates.has('B'))
  assert.equal(called.length, 3)
  app.dispatch('send', { threadId, text: '@DeepSeek 娘 另一件事' })
  assert.equal(app.snapshot().threads[0].messages.filter(message => !message.author).length, 2)
  assert.equal(called.length, 3)
  gates.get('B')()
  await until(() => gates.has('direct'))
  assert.equal(called.length, 4)
  gates.get('direct')()
  gates.get('A')()
  await settled(app)
  assert.match(called[4].prompt, /RESULT-A[\s\S]*RESULT-B|RESULT-B[\s\S]*RESULT-A/)
  const [a, b, c] = app.snapshot().threads[0].tasks
  assert.deepEqual([a.status, b.status, c.status], ['done', 'done', 'done'])
  assert.equal(store.value.threads[0].tasks[0].sessions.codex.id, 'A-session')
  assert.equal(app.snapshot().threads[0].tasks[0].sessions, undefined)
  app.dispatch('send', { threadId, taskId: a.id, text: 'FOLLOWUP' })
  await settled(app)
  assert.equal(called.length, 6)
  assert.equal(called[5].sessionId, 'A-session')
  assert.match(called[5].prompt, /FOLLOWUP/)
})

test('routing rejects nonmembers and cyclic or missing dependencies', () => {
  const roles = ['codex', 'deepseek']
  assert.throws(() => parseRouting(routeReply('outside'), roles), /分流结果无效/)
  assert.throws(() => parseRouting(routeTasks(plannedTask('a', 'codex', ['b'])), roles), /分流结果无效/)
  assert.throws(() => parseRouting(routeTasks(plannedTask('a', 'codex', ['b']), plannedTask('b', 'deepseek', ['a'])), roles), /分流结果无效/)
})

test('same-workspace writes serialize and a new task instruction holds an in-flight result', async t => {
  const calls = []
  const releases = []
  const { app } = workspace(t, call => {
    if (call.ephemeral) return Promise.resolve({ text: routeTasks(plannedTask('A', 'codex', [], 'write'), plannedTask('B', 'deepseek', [], 'write')) })
    calls.push(call)
    return new Promise(resolve => releases.push(text => resolve({ text, sessionId: call.sessionId || call.type + '-task' })))
  })
  const threadId = 'clubroom'
  await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
  app.dispatch('threadSettings', { threadId, cwd: app.defaultDirectory, writeAccess: true })
  app.dispatch('send', { threadId, text: '两项修改' })
  await until(() => releases.length === 1)
  const [first] = app.snapshot().threads[0].tasks
  assert.equal(calls[0].writeAccess, true)
  app.dispatch('send', { threadId, taskId: first.id, text: '改用新的验收条件' })
  assert.equal(releases.length, 1)
  releases[0]('旧方案草稿')
  await until(() => releases.length === 2)
  assert.equal(calls[1].type, 'deepseek')
  assert.equal(app.snapshot().threads[0].messages.find(message => message.status === 'held').heldText, '旧方案草稿')
  releases[1]('另一项完成')
  await until(() => releases.length === 3)
  assert.match(calls[2].prompt, /旧方案草稿[\s\S]*改用新的验收条件|改用新的验收条件[\s\S]*旧方案草稿/)
  assert.equal(calls[2].sessionId, 'codex-task')
  releases[2]('新方案完成')
  await settled(app)
  assert.deepEqual(app.snapshot().threads[0].tasks.map(task => task.status), ['done', 'done'])
})

test('both role runtimes reuse a chat session when the next turn is read-only and omit unchanged instructions', async t => {
  for (const [id, name] of [['codex', 'Codex 龙娘'], ['deepseek', 'DeepSeek 娘']]) {
    const calls = []
    const { app } = workspace(t, async call => {
      if (call.ephemeral) return { text: routeReply(id) }
      calls.push(call)
      return { text: '已核对。', sessionId: call.sessionId || id + '-session' }
    })
    const threadId = 'clubroom'
    await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
    app.dispatch('threadSettings', { threadId, cwd: app.defaultDirectory, writeAccess: true, description: 'STABLE-DETAIL' })
    app.dispatch('send', { threadId, text: '@' + name + ' CHECK-FIRST' })
    await settled(app)
    app.dispatch('send', { threadId, text: '梳理一下刚才的结论' })
    await settled(app)
    assert.equal(calls[0].writeAccess, true)
    assert.match(calls[0].prompt, /STABLE-DETAIL|rainbow-notes/)
    assert.equal(calls[1].writeAccess, false)
    assert.equal(calls[1].sessionId, id + '-session')
    assert.match(calls[1].prompt, /本轮工作区为只读/)
    assert.doesNotMatch(calls[1].prompt, /STABLE-DETAIL|rainbow-notes|CHECK-FIRST|已核对。/)
    app.dispatch('threadSettings', { threadId, description: 'UPDATED-DETAIL' })
    app.dispatch('send', { threadId, text: '梳理最新结论' })
    await settled(app)
    assert.equal(calls[2].sessionId, id + '-session')
    assert.match(calls[2].prompt, /UPDATED-DETAIL/)
  }
})

test('ordinary follow-up routes back to the existing task without replaying its instructions', async t => {
  const calls = []
  let taskId
  const { app } = workspace(t, async call => {
    if (call.ephemeral) {
      if (!taskId) return { text: routeTasks(plannedTask('ORIGINAL-TASK', 'deepseek')) }
      assert.match(call.prompt, /ORIGINAL-TASK/)
      assert.match(call.prompt, /DEEPSEEK-PREVIOUS-RESULT/)
      return { text: JSON.stringify({ kind: 'continue', taskId, access: 'read', roleId: '', tasks: [] }) }
    }
    calls.push(call)
    return { text: 'DEEPSEEK-PREVIOUS-RESULT', sessionId: call.sessionId || 'existing-task-session' }
  })
  const threadId = 'clubroom'
  await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
  app.dispatch('send', { threadId, text: 'ORIGINAL-REQUEST' })
  await settled(app)
  taskId = app.snapshot().threads[0].tasks[0].id
  app.dispatch('send', { threadId, text: 'FOLLOWUP-ONLY' })
  await settled(app)
  const thread = app.snapshot().threads[0]
  assert.deepEqual(thread.tasks.map(task => task.id), [taskId])
  assert.equal(thread.messages.at(-1).taskId, taskId)
  assert.equal(calls[1].sessionId, 'existing-task-session')
  assert.match(calls[1].prompt, /FOLLOWUP-ONLY/)
  assert.doesNotMatch(calls[1].prompt, /ORIGINAL-TASK|ORIGINAL-REQUEST|DEEPSEEK-PREVIOUS-RESULT|rainbow-notes/)
})

test('a quoted reply stays in the current chat and carries the quote separately through routing and execution', async t => {
  const calls = []
  const { app, file } = workspace(t, async call => {
    calls.push(call)
    if (call.ephemeral) return { text: routeReply('deepseek') }
    return { text: calls.length === 1 ? 'QUOTE-ANCHOR' : '已说明。', sessionId: 'deepseek-chat' }
  })
  const threadId = 'clubroom'
  await app.dispatch('runtimeSettings', { routing: { type: 'codex', model: 'route-only', effort: 'low' } })
  app.dispatch('send', { threadId, text: '@DeepSeek 娘 给出一句结论' })
  await settled(app)
  const quote = app.snapshot().threads[0].messages.at(-1)
  assert.throws(() => app.dispatch('send', { threadId: 'ideas', replyToId: quote.id, text: '这个是什么？' }), /引用的消息已不可用/)
  app.dispatch('send', { threadId, text: '请解释这句话', replyToId: quote.id })
  await settled(app)
  assert.match(calls[1].prompt, /"quoted":\{[^\n]*QUOTE-ANCHOR/)
  assert.equal(calls[2].sessionId, 'deepseek-chat')
  assert.match(calls[2].prompt, /用户引用的消息[\s\S]+QUOTE-ANCHOR[\s\S]+本轮用户消息（当前指令）/)
  assert.equal(calls[2].prompt.match(/QUOTE-ANCHOR/g).length, 1)
  const reopened = new Store(file).value
  assert.equal(reopened.activeThreadId, threadId)
  assert.equal(reopened.threads.length, 3)
  assert.equal(reopened.threads[0].messages.at(-2).replyToId, quote.id)
})
