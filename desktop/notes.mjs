import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const noteName = /^(?![. ])[^<>:"/\\|?*\u0000-\u001f]{1,96}\.md$/iu
const noteBlock = /(?:^|\n)<rainbow-notes>[ \t]*\r?\n([\s\S]*?)\r?\n<\/rainbow-notes>[ \t]*(?=\s*(?:\[交接[：:][^\]\n]+\])?\s*$)/
const noteLimit = 6_000
const contextLimit = 12_000

export const noteInstructions = [
  '你可以维护当前会话的 Markdown 笔记，记录后续工作需要的关键决定、事实、阻塞和下一步。',
  '如需保存，请使用简洁的 Markdown，优先更新已有主题。删除笔记只用于明确过期、重复或用户要求清除的记录。',
  '需要写入或删除时，在回复末尾附加以下格式的操作块。文件名须为 .md，写入同名文件会更新它。无需操作时省略整个块。若同时交接，交接标记放在操作块之后。',
  '<rainbow-notes>\n[{"op":"write","file":"进度.md","markdown":"# 进度\\n- 关键事实"}, {"op":"delete","file":"过期方案.md"}]\n</rainbow-notes>',
].join('\n')

export function visibleDraft(text) {
  const index = text.search(/(?:^|\n)<rainbow-notes>/)
  return index < 0 ? text : text.slice(0, index).trimEnd()
}

export function parseNoteReply(text) {
  const match = noteBlock.exec(text)
  if (!match) return { text, operations: [] }
  const visible = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim()
  let operations
  try {
    operations = JSON.parse(match[1].trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''))
  } catch {
    return { text: visible, operations: [], error: '笔记操作格式无效。' }
  }
  if (!Array.isArray(operations) || operations.length > 8 || operations.some(item =>
    !item || typeof item.file !== 'string' || !noteName.test(item.file)
    || !['write', 'delete'].includes(item.op)
    || (item.op === 'write' && (typeof item.markdown !== 'string' || !item.markdown.trim() || item.markdown.length > noteLimit)))) {
    return { text: visible, operations: [], error: '笔记操作或文件内容无效。' }
  }
  return { text: visible, operations }
}

export class Notes {
  constructor(root) {
    this.root = root
  }

  directory(threadId) {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error('无效的会话笔记目录。')
    return join(this.root, threadId)
  }

  file(threadId, name) {
    if (typeof name !== 'string' || !noteName.test(name)) throw new Error('笔记名须为 .md 文件名。')
    return join(this.directory(threadId), name)
  }

  list(threadId) {
    try {
      return readdirSync(this.directory(threadId), { withFileTypes: true })
        .filter(entry => entry.isFile() && noteName.test(entry.name)).map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  read(threadId, name) {
    const file = this.file(threadId, name)
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error('这条笔记不是 Markdown 文件。')
      const buffer = Buffer.alloc(Math.min(stat.size, noteLimit * 4))
      const count = readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, count).slice(0, noteLimit)
    } finally {
      closeSync(fd)
    }
  }

  write(threadId, name, markdown) {
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > noteLimit) throw new Error('笔记内容无效。')
    const file = this.file(threadId, name)
    const directory = this.directory(threadId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, '.' + randomUUID() + '.tmp')
    try {
      writeFileSync(temp, markdown.trim() + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  delete(threadId, name) {
    rmSync(this.file(threadId, name), { force: true })
  }

  deleteThread(threadId) {
    rmSync(this.directory(threadId), { recursive: true, force: true })
  }

  context(threadId, { seen = {}, preferred = [] } = {}) {
    const files = this.list(threadId)
    const existing = new Set(files)
    const deleted = Object.keys(seen).filter(file => !existing.has(file))
    const priority = new Set(preferred)
    const index = []
    let indexBudget = 3_000
    for (const file of [...preferred.filter(file => existing.has(file)), ...files.filter(file => !priority.has(file))]) {
      indexBudget -= file.length + 3
      if (indexBudget < 0) break
      index.push(file)
    }
    const recent = files.flatMap(file => {
      try { return [{ file, at: lstatSync(this.file(threadId, file)).mtimeMs }] } catch { return [] }
    }).sort((a, b) => Number(priority.has(b.file)) - Number(priority.has(a.file)) || b.at - a.at)
    const versions = Object.fromEntries(Object.entries(seen).filter(([file]) => existing.has(file)))
    let remaining = contextLimit - JSON.stringify({ files: index, deleted }).length
    const rows = []
    for (const { file } of recent) {
      if (remaining < 1) break
      let markdown
      try { markdown = this.read(threadId, file) } catch { continue }
      const version = createHash('sha256').update(markdown).digest('hex')
      if (seen[file] === version + ':full' || (!priority.has(file) && seen[file] === version)) continue
      const max = priority.has(file) ? noteLimit : 2_400
      const excerpt = limit => ({ file, markdown: markdown.slice(0, limit) + (markdown.length > limit ? '\n[余下内容已省略]' : '') })
      let row = excerpt(max)
      if (JSON.stringify(row).length + 1 > remaining) {
        const budget = Math.floor((remaining - JSON.stringify(excerpt(0)).length - 1) / 6)
        if (budget < 1) continue
        row = excerpt(budget)
      }
      const length = JSON.stringify(row).length + 1
      if (length > remaining) continue
      rows.push(row)
      versions[file] = row.markdown === markdown ? version + ':full' : version
      remaining -= length
    }
    const missing = preferred.filter(file => !existing.has(file))
    const context = rows.length || deleted.length || missing.length
      ? JSON.stringify({ files: index, excerpts: rows, ...(deleted.length ? { deleted } : {}), ...(missing.length ? { missing } : {}) }) : ''
    return { context, versions }
  }
}
