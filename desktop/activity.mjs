import { isAbsolute } from 'node:path'
import { mediaType, websiteURL } from '../shared/content-links.mjs'

const asText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : ''
export const commandOutput = value => typeof value === 'string'
  ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-4000) : ''

export function codexActivity(method, params) {
  const completed = method === 'item/completed'
  const item = method === 'item/fileChange/patchUpdated'
    ? { id: params.itemId, type: 'fileChange', status: 'inProgress', changes: params.changes }
    : completed || method === 'item/started' ? params.item : null
  if (!item || typeof item.id !== 'string') return []
  const status = item.status || (completed ? 'completed' : 'inProgress')
  const base = { id: item.id, status }
  switch (item.type) {
    case 'commandExecution': return [{ ...base, kind: 'command', label: asText(item.command, 1600),
      output: commandOutput(item.aggregatedOutput), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : undefined }]
    case 'agentMessage':
    case 'plan': return completed && (item.type === 'plan' || item.phase === 'commentary') && item.text
      ? [{ ...base, kind: 'text', text: asText(item.text, 5000) }] : []
    case 'fileChange': return [{ ...base, kind: 'changes', files: (item.changes || []).slice(0, 12).map(change => ({
      path: asText(change.path, 1200), diff: asText(change.diff, 5000), operation: asText(change.kind?.type, 30),
    })) }]
    case 'imageGeneration': return completed && typeof item.savedPath === 'string' && isAbsolute(item.savedPath) && mediaType(item.savedPath).startsWith('image/')
      ? [{ ...base, kind: 'asset', path: item.savedPath }] : []
    case 'webSearch': {
      const links = [item.action?.url, ...(Array.isArray(item.results) ? item.results.map(result => result?.url) : [])]
        .map(websiteURL).filter(Boolean).slice(0, 10)
      return [{ ...base, kind: 'web', label: asText(item.query, 400) || '网页', urls: [...new Set(links)] }]
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const url = item.tool === 'open_url' && websiteURL(item.arguments?.url)
      return [url ? { ...base, kind: 'web', label: url, urls: [url] }
        : { ...base, kind: 'tool', label: asText(item.tool, 140) }]
    }
    default: return []
  }
}

export function dshActivity(event) {
  if (typeof event.callId !== 'string') return null
  if (event.type === 'tool_call' && typeof event.tool === 'string') {
    const url = event.tool === 'open_url' && websiteURL(event.input?.url)
    return url ? { id: event.callId, kind: 'web', label: url, urls: [url], status: 'inProgress' }
      : { id: event.callId, kind: 'tool', label: asText(event.tool, 140), status: 'inProgress' }
  }
  if (event.type === 'tool_result') return {
    id: event.callId, status: event.status === 'error' ? 'failed' : 'completed',
    ...(typeof event.result === 'string' && event.result ? { output: commandOutput(event.result) } : {}),
  }
  return null
}
