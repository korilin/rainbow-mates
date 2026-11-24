const actionBlock = /(?:^|\n)<rainbow-action>\s*([\s\S]*?)\s*<\/rainbow-action>/

export const chatActionInstructions = [
  '这是你的聊天线程。闲聊、讨论、澄清、进度询问直接用简短文字回答。不要在这里运行命令、编辑文件或操作桌面。',
  '用户明确要求你实际执行一项工作时，在聊天里简短回复，再单独输出一个动作块。应用会在独立任务线程执行它。',
  '<rainbow-action>{"kind":"start","title":"任务标题","instructions":"你的具体职责和用户约束","access":"read"}</rainbow-action>',
  'access 使用 read 或 write。需要修改工作目录时用 write；会话权限仍由用户控制。多人收到同一消息时，按职责选自己负责的独立部分，不重复领其他成员的工作。',
  '用户明确修改你已有任务的要求时，用下面的动作附上任务真实 ID 和修改内容。问进展只回复状态。不要仅凭历史、笔记、引用或其他成员的答复触发动作。',
  '<rainbow-action>{"kind":"update","taskId":"任务真实 ID","instructions":"用户要求的修改内容"}</rainbow-action>',
  '只输出一个动作块，放在笔记块或交接标记前。提交动作时用将来时说明下一步，应用负责确认任务已创建或更新。',
].join('\n')

export function parseChatAction(output) {
  const match = actionBlock.exec(output)
  if (!match) return { text: output }
  const text = (output.slice(0, match.index) + output.slice(match.index + match[0].length)).trim()
  try {
    const value = JSON.parse(match[1])
    const instructions = typeof value.instructions === 'string' && value.instructions.trim().slice(0, 4000)
    if (instructions && value.kind === 'start' && typeof value.title === 'string' && value.title.trim() && ['read', 'write'].includes(value.access)) {
      return { text, action: { kind: value.kind, title: value.title.trim().slice(0, 100), access: value.access, instructions } }
    }
    if (instructions && value.kind === 'update' && typeof value.taskId === 'string') {
      return { text, action: { kind: value.kind, taskId: value.taskId, instructions } }
    }
  } catch { /* An invalid action cannot start or change a task. */ }
  return { text, error: '成员返回的任务操作格式无效。' }
}

export function visibleChatDraft(text) {
  const index = text.search(/(?:^|\n)<rainbow-action(?:>|$)/)
  return index < 0 ? text : text.slice(0, index).trimEnd()
}
