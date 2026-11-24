import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { mediaType } from '../shared/content-links.mjs'

async function workPath(cwd, value) {
  if (typeof value !== 'string' || isAbsolute(value) || value.length > 4096 || value.includes('\0')) throw new Error('文件路径无效。')
  const root = await realpath(cwd)
  const requested = resolve(root, value)
  const within = path => {
    const offset = relative(root, path)
    return offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
  }
  if (!within(requested)) throw new Error('文件位于会话工作目录之外。')
  const path = await realpath(requested)
  if (!within(path)) throw new Error('文件位于会话工作目录之外。')
  return { path, root }
}

export async function workspaceEntries(cwd, directory = '') {
  const { path, root } = await workPath(cwd, directory)
  const items = await readdir(path, { withFileTypes: true })
  return {
    name: basename(root),
    entries: items.flatMap(item => item.isDirectory() || item.isFile()
      ? [{ name: item.name, path: directory ? directory + '/' + item.name : item.name, directory: item.isDirectory() }] : [])
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })),
  }
}

export async function workspaceAsset(cwd, file) {
  const { path } = await workPath(cwd, file)
  const meta = await stat(path)
  if (!meta.isFile()) throw new Error('请选择普通文件。')
  return { path, name: basename(path), size: meta.size, mime: mediaType(path) }
}

export async function workspaceReferencePath(cwd, entry) {
  const { path } = await workPath(cwd, entry)
  return path
}
