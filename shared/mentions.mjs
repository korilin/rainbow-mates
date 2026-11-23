const boundary = /^[\s@.,!?;:，。！？；：、）)」』\]]|^$/

export function findMentions(text, roles) {
  const names = [...roles].sort((a, b) => b.name.length - a.name.length)
    .map(role => ({ ...role, normalized: role.name.toLowerCase() }))
  const matches = []
  let end = 0
  for (const { index: start } of text.matchAll(/@/g)) {
    if (start < end) continue
    const tail = text.slice(start + 1)
    const braces = /^\{([^{}\n]+)\}/.exec(tail)
    const normalized = tail.toLowerCase()
    const role = braces
      ? names.find(item => item.normalized === braces[1].toLowerCase())
      : names.find(item => normalized.startsWith(item.normalized) && boundary.test(tail.slice(item.name.length)))
    if (!role) continue
    end = start + 1 + (braces ? braces[0].length : role.name.length)
    matches.push({ start, end, roleId: role.id, name: role.name })
  }
  return matches
}
