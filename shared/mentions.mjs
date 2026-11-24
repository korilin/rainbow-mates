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

export function directedMembers(text, roles) {
  const explicit = [...new Set(findMentions(text, roles).map(item => item.roleId))]
  if (explicit.length) return explicit
  const source = text.trim().toLowerCase()
  const names = new Map()
  for (const role of roles) {
    const full = role.name.toLowerCase()
    const short = full.replace(/^(?:codex|deepseek|dsh)\s+/u, '')
    for (const name of new Set([full, short])) {
      if (name.length >= 2) names.set(name, names.has(name) ? null : role.id)
    }
  }
  const entries = [...names].sort(([a], [b]) => b.length - a.length)
  const first = namedRequest(source, entries)
  if (!first.length) return []
  const additional = source.split(/[,，;；。！？\n]/u).slice(1).flatMap(clause => namedRequest(clause.trim(), entries, false))
  return [...new Set([...first, ...additional])]
}

function namedRequest(source, entries, allowAddress = true) {
  const request = /^(?:(?:我想|这次|这轮|先|请|麻烦)\s*)?(?:让|叫|有请|请|麻烦)\s*/u.exec(source)
  let remaining = request ? source.slice(request[0].length) : source
  const result = []
  let join
  do {
    const entry = entries.find(([name]) => remaining.startsWith(name))
    if (!entry?.[1]) return []
    result.push(entry[1])
    remaining = remaining.slice(entry[0].length)
    join = /^\s*(?:和|与|、|以及|及)\s*/u.exec(remaining)
    if (join) remaining = remaining.slice(join[0].length)
  } while (join)
  remaining = remaining.trimStart().replace(/^(?:一起|分别|各自)\s*/u, '')
  if (allowAddress && /^[,，:：]/u.test(remaining)) return result
  const action = /^(?:请|帮我|帮忙|生成|出图|负责|整理|检查|核对|看看|写|做|改|查|给|把|说|回答|确认|执行|完成|发|提供|处理|看|分析|试|运行|继续|补充|交付|实现|回复|提交)/u.exec(remaining)
  if (!action || /^(?:的|了|过|吗|没|得)/u.test(remaining.slice(action[0].length))) return []
  const directAction = /^(?:请|帮我|帮忙|生成|出图|负责|整理|检查|核对|看看|写|做|改|查|回答|确认|执行|提供|分析|运行|继续|补充|交付|实现|回复|提交)$/u.test(action[0])
  return request || directAction ? result : []
}
