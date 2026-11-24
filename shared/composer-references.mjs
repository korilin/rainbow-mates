export const inlineReferenceKinds = ['skill', 'plugin', 'conversation']
export const referenceLimit = 8

export const inlineReferenceName = name => name.trim().replace(/\s+/gu, ' ')

export function referenceTrigger(text, caret) {
  const prefix = text.slice(0, caret)
  const match = [...prefix.matchAll(/(?:^|[\s(（:：])([@$/])/gu)].at(-1)
  if (!match) return null
  const symbol = match[1]
  const start = match.index + match[0].length - 1
  const query = prefix.slice(start + 1)
  if (query.length > 180 || /[\r\n@$]/u.test(query) || symbol !== '@' && query.includes('/')) return null
  return { symbol, query, start, end: caret }
}

export function rebaseReferences(previous, next, spans) {
  if (!spans.length || previous === next) return spans
  let start = 0
  let oldEnd = previous.length
  let newEnd = next.length
  const shortest = Math.min(oldEnd, newEnd)
  while (start < shortest && previous[start] === next[start]) start++
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const delta = newEnd - oldEnd
  return spans.flatMap(span => {
    if (span.end <= start) return [span]
    if (span.start < oldEnd) return []
    return [{ ...span, start: span.start + delta, end: span.end + delta }]
  })
}

export function referencesForSend(text, spans) {
  const trimmed = text.trim()
  const offset = text.length - text.trimStart().length
  return {
    text: trimmed,
    inlineReferences: spans
      .map(({ start, end, ...span }) => ({ ...span, start: start - offset, end: end - offset }))
      .filter(span => span.start >= 0 && span.end <= trimmed.length),
  }
}

export function matchesInlineReference(text, span, item) {
  return Boolean(item && item.kind === span.kind
    && (span.kind === 'conversation' ? span.symbol === '@' : ['@', '$', '/'].includes(span.symbol))
    && text.slice(span.start, span.end) === span.symbol + inlineReferenceName(item.name))
}
