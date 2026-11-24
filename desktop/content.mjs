import { constants, createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { artifactLinks, mediaType } from '../shared/content-links.mjs'

const contained = (root, file) => {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

export function messageArtifacts(message) {
  const links = artifactLinks(message.text)
  for (const item of message.activity || []) {
    if (item.kind === 'asset' && !links.some(link => link.path === item.path)) {
      links.push({ id: 'generated-' + item.id, name: basename(item.path), path: item.path, mime: mediaType(item.path), inline: true })
    }
  }
  return links
}

export async function resolveAsset(thread, message, artifactId, defaultDirectory) {
  const artifact = messageArtifacts(message).find(item => item.id === artifactId && item.path)
  if (!artifact) throw new Error('找不到这个附件。')
  const cwd = thread.cwd || defaultDirectory
  const requested = artifact.path.startsWith('~/') ? resolve(homedir(), artifact.path.slice(2)) : resolve(cwd, artifact.path)
  const path = await realpath(requested)
  const root = await realpath(cwd)
  const alreadySelected = thread.messages.some(item => item.references?.some(ref => ref.kind === 'file' && ref.path === path))
  const mime = mediaType(path)
  const generated = path === requested && mime.startsWith('image/')
    && message.activity?.some(item => item.kind === 'asset' && item.path === path)
  if (!contained(root, path) && !alreadySelected && !generated) throw new Error('附件位于会话工作目录之外。')
  const meta = await stat(path)
  if (!meta.isFile()) throw new Error('附件不是普通文件。')
  return { path, name: basename(path), size: meta.size, mime, line: artifact.line }
}

export async function readAssetPreview(asset) {
  if (asset.mime) return { kind: asset.mime.split('/')[0], name: asset.name, mime: asset.mime }
  const file = await open(asset.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) return { kind: 'file', name: asset.name }
    const bytes = Buffer.alloc(Math.min(asset.size, 160_000))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead), { stream: bytesRead < asset.size })
    if (!/[\u0000-\u0008\u000e-\u001f]/u.test(text)) return { kind: /\.m(?:arkdown|d)$/iu.test(asset.name) ? 'markdown' : 'text',
      name: asset.name, text, truncated: bytesRead < asset.size, line: asset.line }
  } catch (error) { if (!(error instanceof TypeError)) throw error }
  finally { await file.close() }
  return { kind: 'file', name: asset.name }
}

export function streamAsset(asset, request) {
  if (!asset.mime) return new Response(null, { status: 404 })
  const headers = { 'Content-Type': asset.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'" }
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get('Range') || '')
  const start = range ? (range[1] ? Number(range[1]) : Math.max(0, asset.size - Number(range[2]))) : 0
  const end = range?.[1] && range[2] ? Math.min(Number(range[2]), asset.size - 1) : asset.size - 1
  if (range && (start > end || !range[1] && !range[2])) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + asset.size } })
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${asset.size}`
  headers['Content-Length'] = String(Math.max(0, end - start + 1))
  const body = request.method === 'HEAD' || !asset.size ? null : Readable.toWeb(createReadStream(asset.path, {
    start, end, flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK,
  }))
  return new Response(body, { status: range ? 206 : 200, headers })
}
