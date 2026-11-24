import { clipboard } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export function fileClipboardPaths() {
  if (process.platform === 'darwin') {
    try {
      const addon = createRequire(import.meta.url)('./native/computer.node')
      const data = JSON.parse(addon.run('{"operation":"clipboard_files"}'))
      return Array.isArray(data.paths) ? data.paths : []
    } catch { return [] }
  }
  return clipboard.readBuffer('text/uri-list').toString('utf8').split(/\r?\n/u).flatMap(value => {
    if (!value.startsWith('file:')) return []
    try { return [fileURLToPath(value.trim())] } catch { return [] }
  })
}
