const extensionTypes = {
  avif: 'image/avif', apng: 'image/apng', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', oga: 'audio/ogg',
}
const markdownLinks = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\r\n]+)>|((?:\\[()]|[^\s()])+))(?:\s+["'][^\r\n]*?["'])?\s*\)/gu

export function websiteURL(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Unrecognized or incomplete URL. */ }
  return null
}

export function linkDestination(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null
  const url = websiteURL(value)
  if (url) return { url }
  let path = value.replace(/\\([()])/g, '$1')
  try {
    if (path.startsWith('file://')) {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = url.pathname
    } else if (path.startsWith('sandbox:/')) path = path.slice('sandbox:'.length)
    else if (/^(?:[a-z][a-z\d+.-]*:|#)/iu.test(path)) return null
    path = decodeURIComponent(path)
  } catch { return null }
  if (/[\u0000-\u001f]/u.test(path)) return null
  const suffix = /(?::(\d+)(?::\d+)?|#L(\d+))$/u.exec(path)
  if (suffix) path = path.slice(0, suffix.index)
  if (!path.startsWith('/') && !path.startsWith('~/') && !/(?:^|\/)[^/]+\.[a-z\d]+$/iu.test(path)) return null
  return { path, ...(suffix ? { line: Number(suffix[1] || suffix[2]) } : {}) }
}

export function artifactLinks(text = '') {
  const links = new Map()
  for (const [, image, label, angle, plain] of text.replace(/^ {0,3}(?:\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:\x60{3,}|~{3,})\s*$/gmu, '').matchAll(markdownLinks)) {
    const href = angle || plain
    const destination = linkDestination(href)
    if (!destination) continue
    const key = destination.path ? JSON.stringify([destination.path, destination.line]) : destination.url
    const previous = links.get(key)
    if (previous) {
      if (image) previous.inline = true
      continue
    }
    const name = label.trim().slice(0, 160) || destination.path?.split('/').at(-1) || destination.url
    links.set(key, { id: String(links.size), name, ...destination, inline: Boolean(image), mime: mediaType(destination.path) })
    if (links.size >= 32) break
  }
  return [...links.values()]
}

export function mediaType(path) {
  return extensionTypes[path?.split('.').at(-1)?.toLowerCase()] || ''
}

export function assetURL(threadId, messageId, id) {
  return 'rainbow-content://asset/' + [threadId, messageId, id].map(encodeURIComponent).join('/')
}

export function referenceImageURL(threadId, id) {
  return 'rainbow-content://reference/' + [threadId, id].map(encodeURIComponent).join('/')
}
