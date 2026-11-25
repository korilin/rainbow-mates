import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const avatarSize = 144
const maxSourceBytes = 10 * 1024 * 1024
const avatarPrefix = 'data:image/png;base64,'
const avatarIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

export async function previewUserAvatar(path) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (size > maxSourceBytes) throw new Error('请选择 10 MB 以内的头像图片。')
    const source = Buffer.alloc(size)
    const { bytesRead } = await file.read(source, 0, size, 0)
    const image = nativeImage.createFromBuffer(source.subarray(0, bytesRead))
    if (image.isEmpty()) throw new Error('无法读取头像图片，请选择 JPG 或 PNG。')
    const { width, height } = image.getSize()
    const avatar = Math.max(width, height) <= avatarSize ? image
      : image.resize(width >= height ? { width: avatarSize, quality: 'best' } : { height: avatarSize, quality: 'best' })
    return avatar.toDataURL()
  } finally {
    await file.close()
  }
}

function avatarPath(directory, id) {
  if (typeof id !== 'string' || !avatarIdPattern.test(id)) return null
  return join(directory, id + '.png')
}

function avatarBytes(value) {
  if (typeof value !== 'string' || value.length > 180_000 || !value.startsWith(avatarPrefix)) throw new Error('头像图片无效。')
  const image = nativeImage.createFromBuffer(Buffer.from(value.slice(avatarPrefix.length), 'base64'))
  const { width, height } = image.getSize()
  if (image.isEmpty() || width > avatarSize || height > avatarSize) throw new Error('头像图片无效。')
  return image.toPNG()
}

export function saveUserProfile(conversations, directory, { name, avatar }, runtimeSettings) {
  if (typeof name !== 'string' || name.length > 36 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('显示名最多 36 个字符。')
  const previous = conversations.store.value.settings.profile?.avatarId
  let avatarId = previous
  let added
  if (avatar === null) avatarId = undefined
  else if (avatar !== undefined) {
    const bytes = avatarBytes(avatar)
    avatarId = randomUUID()
    added = avatarPath(directory, avatarId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(added, bytes, { flag: 'wx', mode: 0o600 })
  }
  try {
    conversations.change(state => {
      state.settings.profile = { name: name.trim(), ...(avatarId && { avatarId }) }
      if (runtimeSettings) Object.assign(state.settings, runtimeSettings)
    })
  } catch (error) {
    if (added) rmSync(added, { force: true })
    throw error
  }
  const old = previous !== avatarId && avatarPath(directory, previous)
  if (old) rmSync(old, { force: true })
}

export async function userAvatarResponse(directory, id, profile, method) {
  if (id !== profile?.avatarId) return new Response(null, { status: 404 })
  const path = avatarPath(directory, id)
  if (!path) return new Response(null, { status: 404 })
  const bytes = await readFile(path)
  return new Response(method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' } })
}
