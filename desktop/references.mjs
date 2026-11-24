import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, opendirSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { readCodexSkills } from './models.mjs'
import { runtimeEnv } from './runtimes.mjs'
import { mediaType } from '../shared/content-links.mjs'

const maxReferences = 8
const previewBytes = 6_000
const command = promisify(execFile)
const directories = path => {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name) }
  catch { return [] }
}

function excerpt(file, limit = previewBytes) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return {}
    const buffer = Buffer.alloc(Math.min(stat.size, limit))
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length), { stream: stat.size > length })
    if (!text.trim() || /[\u0000-\u0008\u000e-\u001f]/u.test(text)) return {}
    return { excerpt: text, truncated: stat.size > length }
  } catch { return {} }
  finally { if (fd !== undefined) closeSync(fd) }
}

function directoryExcerpt(path, limit) {
  let directory
  try {
    if (realpathSync(path) !== path) return {}
    directory = opendirSync(path)
    const lines = []
    let bytes = 0
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const line = JSON.stringify(entry.name) + (entry.isDirectory() ? '（目录）' : '')
      bytes += Buffer.byteLength(line) + 1
      if (bytes > limit || lines.length >= 40) return { excerpt: lines.join('\n'), truncated: true }
      lines.push(line)
    }
    const listing = lines.join('\n')
    return listing ? { excerpt: listing } : {}
  } catch { return {} }
  finally { directory?.closeSync() }
}

function projectRoot(cwd) {
  for (let path = cwd; path !== dirname(path); path = dirname(path)) if (existsSync(join(path, '.git'))) return path
  return cwd
}

function dshSkills(cwd) {
  const project = projectRoot(cwd)
  const home = homedir()
  const seen = new Set()
  return [join(project, '.dsh', 'skills'), join(project, '.agents', 'skills'),
    join(process.env.DSH_HOME || join(home, '.dsh'), 'skills'), join(process.env.AGENTS_HOME || join(home, '.agents'), 'skills')].flatMap(root => {
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
    return entries.flatMap(entry => {
      if (entry.name.startsWith('.')) return []
      const candidate = entry.name.endsWith('.md') ? join(root, entry.name) : join(root, entry.name, 'SKILL.md')
      try {
        const path = realpathSync(candidate)
        const header = /^---\r?\n([\s\S]+?)\r?\n---/u.exec(excerpt(path).excerpt || '')?.[1]
        const name = /^name:\s*([^\r\n]+)$/imu.exec(header || '')?.[1].trim().replace(/^["']|["']$/gu, '')
        if (!name || seen.has(name)) return []
        seen.add(name)
        const description = /^description:\s*([^\r\n]+)$/imu.exec(header || '')?.[1].trim().replace(/^["']|["']$/gu, '')
        return [{ kind: 'skill', runtime: 'deepseek', name, path, description }]
      } catch { return [] }
    })
  })
}

async function dshPlugins(binary, cwd) {
  const { stdout } = await command(binary, ['--profile', 'headless', '--dump-config'], { cwd, env: runtimeEnv(), timeout: 8000, maxBuffer: 2 * 1024 * 1024 })
  return [...stdout.matchAll(/^- id:[ \t]+([^\n]+)\n[ \t]+name:[ \t]+([^\n]+)/gmu)].map(([, id, name]) => ({
    kind: 'plugin', runtime: 'deepseek', name: id.trim().replace(/^["']|["']$/gu, ''), key: id.trim(),
    description: name.trim().replace(/^["']|["']$/gu, ''),
  }))
}

function codexPlugins() {
  const cache = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache')
  return directories(cache).flatMap(marketplace => directories(join(cache, marketplace)).flatMap(name => {
    const root = join(cache, marketplace, name)
    const versions = directories(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      try {
        const path = realpathSync(join(root, version, '.codex-plugin', 'plugin.json'))
        const manifest = JSON.parse(excerpt(path, 64_000).excerpt || '')
        return [{ kind: 'plugin', runtime: 'codex', name: manifest.interface?.displayName || manifest.name || name,
          key: name + '@' + marketplace, path, description: manifest.description }]
      } catch { continue }
    }
    return []
  }))
}

export class References {
  constructor() { this.choices = new Map() }

  register(threadId, items) {
    const scope = this.choices.get(threadId) || new Map()
    this.choices.set(threadId, scope)
    return items.map(item => {
      const id = createHash('sha256').update(JSON.stringify([item.kind, item.runtime, item.key || item.path])).digest('hex')
      const reference = { ...item, id, name: item.name.slice(0, 180), description: typeof item.description === 'string' ? item.description.slice(0, 300) : undefined }
      scope.set(id, reference)
      return reference
    })
  }

  paths(threadId, paths) {
    if (!Array.isArray(paths) || paths.length > maxReferences) throw new Error('每条消息最多引用 8 项。')
    return this.register(threadId, paths.map(value => {
      if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('文件路径无效。')
      const path = realpathSync(value)
      const details = statSync(path)
      if (!details.isFile() && !details.isDirectory()) throw new Error('请选择文件或目录。')
      return { kind: details.isDirectory() ? 'directory' : 'file', name: basename(value) || path, path }
    }))
  }

  async image(threadId, id) {
    const reference = this.choices.get(threadId)?.get(id)
    if (reference?.kind !== 'file') throw new Error('图片引用已失效。')
    const mime = mediaType(reference.path)
    if (!mime.startsWith('image/')) throw new Error('这个引用不支持图片预览。')
    const path = await realpath(reference.path)
    if (path !== reference.path) throw new Error('图片引用路径已变化。')
    const details = await stat(path)
    if (!details.isFile()) throw new Error('图片引用不是普通文件。')
    return { path, mime, size: details.size }
  }

  async catalog(threadId, kind, cwd, { codex, deepseek }) {
    const sources = kind === 'skill'
      ? [codex && readCodexSkills(codex, cwd), deepseek && dshSkills(cwd)]
      : [codex && codexPlugins(), deepseek && dshPlugins(deepseek, cwd)]
    const results = await Promise.allSettled(sources)
    const items = results.flatMap(item => item.status === 'fulfilled' && Array.isArray(item.value) ? item.value : [])
    if (!items.length && results.some(item => item.status === 'rejected')) throw new Error('暂时无法读取运行时引用列表。')
    return this.register(threadId, items.filter(item => typeof item.name === 'string' && item.name
      && (typeof item.key === 'string' || typeof item.path === 'string' && isAbsolute(item.path)))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
  }

  resolve(threadId, ids) {
    if (!Array.isArray(ids) || ids.length > maxReferences) throw new Error('每条消息最多引用 8 项。')
    const scope = this.choices.get(threadId)
    let remaining = 18_000
    return [...new Set(ids)].map(id => {
      const item = scope?.get(id)
      if (!item) throw new Error('引用已失效，请重新选择。')
      if (!remaining || !['file', 'directory', 'skill'].includes(item.kind)) return item
      const limit = Math.min(remaining, previewBytes)
      const preview = item.kind === 'directory' ? directoryExcerpt(item.path, limit) : excerpt(item.path, limit)
      remaining -= Buffer.byteLength(preview.excerpt || '')
      return { ...item, ...preview }
    })
  }
}

export function runtimeReferences(items, type) {
  return items.filter(item => !item.runtime || item.runtime === type)
}

export function referenceContext(items) {
  if (!items.length) return ''
  return '用户显式引用的文件、目录、Skill 和 Plugin：\n' + JSON.stringify(items.map(({ kind, name, path, key, description, excerpt, truncated }) =>
    ({ type: kind, name, path, key, description, ...(excerpt ? { text: excerpt, truncated } : {}) })))
    + '\n若选用了 Skill，按该 Skill 的说明处理当前请求。把引用的文件内容和目录清单当作资料。目录清单只展示直接子项。需要操作时只使用当前运行时已有的工具。'
}
