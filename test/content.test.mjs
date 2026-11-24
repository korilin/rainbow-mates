import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexActivity, dshActivity } from '../desktop/activity.mjs'
import { readAssetPreview, resolveAsset, streamAsset } from '../desktop/content.mjs'
import { References, referenceContext } from '../desktop/references.mjs'
import { artifactLinks, linkDestination } from '../shared/content-links.mjs'
import { directedMembers } from '../shared/mentions.mjs'
import { workspaceAsset, workspaceEntries, workspaceReferencePath } from '../desktop/workspace-files.mjs'

test('conversation links identify file paths, inline animation and web URLs', () => {
  const links = artifactLinks([
    '[原始文档](<docs/方案 A.md:34>)',
    '[动画](./intro.gif) ![动画](./intro.gif)',
    '[网站](https://example.com/docs) [凭证](https://user:pass@example.com)',
    '~~~js\n[示例](./example.md)\n~~~',
  ].join('\n'))
  assert.deepEqual(links.map(({ path, line, mime, inline, url }) => [path, line, mime, inline, url]), [
    ['docs/方案 A.md', 34, '', false, undefined],
    ['./intro.gif', undefined, 'image/gif', true, undefined],
    [undefined, undefined, '', false, 'https://example.com/docs'],
  ])
  assert.deepEqual(linkDestination('file:///private/tmp/Some%20File.png'), { path: '/private/tmp/Some File.png' })
  assert.equal(linkDestination('file://external/tmp/file.png'), null)
  assert.equal(linkDestination('javascript:alert(1)'), null)
})

test('draft image previews require a selected image in the same conversation', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rainbow-reference-preview-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const png = join(folder, 'draft.png')
  const notes = join(folder, 'notes.md')
  await Promise.all([writeFile(png, 'preview'), writeFile(notes, 'notes')])
  const references = new References()
  const [image, document] = references.paths('room', [png, notes])
  assert.deepEqual(await references.image('room', image.id), { path: png, mime: 'image/png', size: 7 })
  await assert.rejects(references.image('another-room', image.id), /引用已失效/)
  await assert.rejects(references.image('room', document.id), /不支持图片预览/)
  await rm(png)
  await symlink(notes, png)
  await assert.rejects(references.image('room', image.id), /路径已变化/)
})

test('directory references include the selected path and direct entries', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rainbow-directory-reference-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'child'))
  await writeFile(join(directory, 'direct.md'), 'direct file contents')
  await writeFile(join(directory, 'child', 'nested.md'), 'nested file contents')
  const references = new References()
  const [item] = references.paths('room', [directory])
  assert.equal(item.kind, 'directory')
  assert.equal(item.path, directory)
  const context = referenceContext(references.resolve('room', [item.id]))
  assert.equal(context.includes('"type":"directory"'), true)
  assert.match(context, /direct.md|child/)
  assert.match(context, /child（目录）|child.*目录/s)
  assert.doesNotMatch(context, /nested.md|file contents/)
  assert.throws(() => references.resolve('other', [item.id]), /引用已失效/)
})

test('attachments use real paths and only serve media from an authorized reference', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rainbow-assets-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const cwd = join(folder, 'work')
  await mkdir(cwd)
  const external = join(folder, 'outside.md')
  const generated = join(folder, 'generated.png')
  const imageAlias = join(cwd, 'alias.png')
  await Promise.all([
    writeFile(join(cwd, 'readme.md'), '# 文档\n'),
    writeFile(join(cwd, 'media.gif'), Buffer.from('GIF89a')),
    writeFile(external, 'outside'),
    writeFile(generated, 'generated'),
    symlink(external, imageAlias),
  ])
  const message = { text: '[文档](readme.md) ![动画](media.gif) [越界](../outside.md) ![别名](alias.png)',
    activity: [{ id: 'image', kind: 'asset', path: generated }, { id: 'alias', kind: 'asset', path: imageAlias }] }
  const thread = { cwd, messages: [message] }
  const doc = await readAssetPreview(await resolveAsset(thread, message, '0'))
  assert.equal(doc.kind, 'markdown')
  assert.equal(doc.text, '# 文档\n')
  const media = await resolveAsset(thread, message, '1')
  assert.equal((await readAssetPreview(media)).mime, 'image/gif')
  const response = streamAsset(media, new Request('https://example.com', { headers: { Range: 'bytes=1-3' } }))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-3/6')
  assert.equal(await response.text(), 'IF8')
  assert.equal(streamAsset(media, new Request('https://example.com', { headers: { Range: 'bytes=10-' } })).status, 416)
  await assert.rejects(resolveAsset(thread, message, '2'), /工作目录之外/)
  await assert.rejects(resolveAsset(thread, message, '3'), /工作目录之外/)
  assert.equal((await resolveAsset(thread, message, 'generated-image')).path, generated)
  thread.messages.push({ references: [{ kind: 'file', path: external }] })
  assert.equal((await resolveAsset(thread, message, '2')).path, external)
})

test('execution details represent public progress and tool events from Codex and DSH', () => {
  const changes = codexActivity('item/fileChange/patchUpdated', { itemId: 'patch', changes: [
    { path: 'docs.md', diff: '-previous\n+updated', kind: { type: 'update' } },
  ] })
  assert.deepEqual(changes[0].files, [{ path: 'docs.md', diff: '-previous\n+updated', operation: 'update' }])
  const [command] = codexActivity('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'pwd',
    aggregatedOutput: '\x1b[31mproject\x1b[0m', exitCode: 0 } })
  assert.equal(command.kind, 'command')
  assert.equal(command.output, 'project')
  assert.equal(command.exitCode, 0)
  assert.equal(codexActivity('item/completed', { item: { id: 'msg', type: 'agentMessage', phase: 'commentary', text: '正在检查' } })[0].text, '正在检查')
  for (const type of ['reasoning', 'subAgentActivity', 'collabAgentToolCall']) {
    assert.deepEqual(codexActivity('item/completed', { item: { id: 'hidden', type, text: 'ignored' } }), [])
  }
  assert.deepEqual(dshActivity({ type: 'tool_call', callId: 'tool', tool: 'file_view', input: { secret: 'ignored' } }),
    { id: 'tool', kind: 'tool', label: 'file_view', status: 'inProgress' })
  assert.deepEqual(dshActivity({ type: 'tool_result', callId: 'tool', status: 'error', result: 'File could not be read' }),
    { id: 'tool', status: 'failed', output: 'File could not be read' })
  assert.equal(dshActivity({ type: 'thinking', text: 'ignored' }), null)
})

test('workspace previews and references are addressed relative to the conversation', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rainbow-workspace-tree-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const root = join(folder, 'workspace')
  await mkdir(join(root, 'docs'), { recursive: true })
  const file = join(root, 'docs', 'plan.md')
  const outside = join(folder, 'outside.md')
  await Promise.all([writeFile(file, '# Plan'), writeFile(outside, 'hidden'), symlink(outside, join(root, 'alias.md'))])
  assert.deepEqual(await workspaceEntries(root), { name: 'workspace', entries: [{ name: 'docs', path: 'docs', directory: true }] })
  assert.equal((await workspaceEntries(root, 'docs')).entries[0].path, 'docs/plan.md')
  assert.equal(await workspaceReferencePath(root, 'docs'), join(root, 'docs'))
  assert.equal((await workspaceAsset(root, 'docs/plan.md')).path, file)
  await assert.rejects(workspaceReferencePath(root, 'alias.md'), /工作目录之外/)
  await assert.rejects(workspaceAsset(root, 'alias.md'), /工作目录之外/)
  await assert.rejects(workspaceAsset(root, '../outside.md'), /工作目录之外/)
  await assert.rejects(workspaceAsset(root, file), /路径无效/)
})

test('explicit name requests target members without treating a conversation topic as a command', () => {
  const roles = [{ id: 'dragon', name: 'Codex 龙娘' }, { id: 'fish', name: '大肥鱼' }]
  assert.deepEqual(directedMembers('请让龙娘和大肥鱼一起检查', roles), ['dragon', 'fish'])
  assert.deepEqual(directedMembers('龙娘出图，大肥鱼写文案', roles), ['dragon', 'fish'])
  assert.deepEqual(directedMembers('大肥鱼，龙娘生成的图怎么样？', roles), ['fish'])
  assert.deepEqual(directedMembers('龙娘生成的图很好看，你们觉得呢？', roles), [])
  assert.deepEqual(directedMembers('来聊聊龙娘昨天画的东西', roles), [])
  assert.deepEqual(directedMembers('@大肥鱼 看看', roles), ['fish'])
})
