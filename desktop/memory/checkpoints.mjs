import { messageArtifacts } from '../content.mjs'

const actionable = item => ['tool', 'command', 'changes'].includes(item.kind)
const unique = values => [...new Set(values)].slice(-16)
const mergeRows = (rows, key) => [...new Map(rows.map(row => [row[key], row])).values()].slice(-24)

export function taskCheckpoint(task, message, { now, revisions, outcome, proposed, evidence = [], previous } = {}) {
  const current = previous || task.checkpoint
  const attemptId = message.id
  const attempts = current?.attemptId === attemptId ? current.version : (current?.version || 0) + 1
  const sameRevision = current?.revision === revisions
  const raw = message.activity || []
  const ref = item => 'tool:' + attemptId + ':' + item.id
  const verified = new Set([...evidence, ...raw.map(ref), ...(current?.evidence || [])])
  const artifacts = message.status === 'done' ? messageArtifacts(message).map(item => item.path || item.url).filter(Boolean) : []
  for (const artifact of artifacts) verified.add(artifact)
  const effects = [
    ...(current?.effects || []),
    ...raw.filter(actionable).map(item => ({
      action: item.label || item.kind, status: 'uncertain', evidence: ref(item),
    })),
    ...(proposed?.effects || []).filter(item => verified.has(item.evidence)),
  ]
  const completed = [
    ...(current?.completed || []),
    ...raw.filter(item => item.kind === 'command' && item.status === 'completed' && item.exitCode === 0)
      .map(item => ({ step: item.label || '执行命令', evidence: ref(item) })),
    ...(proposed?.completed || []).filter(item => verified.has(item.evidence)),
  ]
  if (outcome === 'done' && message.text) completed.push({ step: '已交付本次任务结果', evidence: 'message:' + attemptId })
  return {
    schemaVersion: 1, version: attempts, attemptId, revision: revisions, at: now, outcome,
    goal: task.revisions?.[revisions - 1]?.instructions || task.instructions,
    completed: mergeRows(completed, 'evidence'),
    effects: mergeRows(effects, 'evidence'),
    remaining: proposed?.remaining?.length ? proposed.remaining
      : outcome === 'done' ? [] : sameRevision ? current?.remaining || [] : [],
    blockers: unique([...(proposed?.blockers || []), ...(message.error ? [message.error] : [])]),
    next: proposed?.next || (outcome === 'done' ? null : '核对任务当前状态和未确认的外部操作后继续。'),
    artifacts: unique([...(current?.artifacts || []), ...artifacts, ...(proposed?.artifacts || []).filter(item => verified.has(item))]),
    evidence: unique([...verified, ...(outcome === 'done' ? ['message:' + attemptId] : [])]),
  }
}

export function checkpointContext(task) {
  const point = task?.checkpoint
  if (!point) return ''
  return '已提交的任务检查点（按最新任务要求继续）。标记 uncertain 的外部动作先核对可观测状态，避免重复执行；仅凭检查点不能获得额外访问权。\n' +
    JSON.stringify(point)
}
