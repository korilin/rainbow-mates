import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, ArrowRight, ClipboardList, CodeXml, Download, FileImage, FileText, Folder, Globe, Paperclip, Plus, RefreshCw, X } from 'lucide-react'
import { assetURL, linkDestination, mediaType, websiteURL } from '../shared/content-links.mjs'

import { fileIcon } from './file-icon.jsx'
import { WorkspaceFiles } from './workspace-files.jsx'

const api = window.rainbow
const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const workspaceTabId = 'work-directory'
const taskStatus = { queued: '排队中', running: '进行中', done: '已完成', unassigned: '待认领', blocked: '前置未完成', error: '失败', stopped: '已停止' }
const eventStatus = { inProgress: '进行中', completed: '完成', failed: '失败', declined: '已拒绝', interrupted: '已中断' }
const operationLabel = { add: '新增', update: '修改', delete: '删除' }
const find = (items, id) => items?.find(item => item.id === id)
const time = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value)
const taskRuns = (thread, taskId) => thread.messages.filter(message => message.taskId === taskId && message.author)
const memberTasks = (thread, memberId) => (thread.tasks || []).filter(task =>
  task.roleId === memberId || taskRuns(thread, task.id).some(message => message.author.id === memberId)).reverse()

export function contentKey(view) {
  switch (view.kind) {
    case 'asset': return JSON.stringify(['asset', view.messageId, view.item.id])
    case 'diff': return JSON.stringify(['diff', view.messageId, view.itemId, view.filePath])
    case 'browser': return JSON.stringify(['browser', view.url || ''])
    case 'workspace': return JSON.stringify(['workspace', view.path])
    case 'member': return JSON.stringify(['member', view.memberId])
    case 'task': return JSON.stringify(['task', view.taskId, view.memberId])
  }
}

function Media({ mime, src, alt }) {
  if (mime?.startsWith('image/')) return <img className="content-image" src={src} alt={alt} loading="lazy" />
  if (mime?.startsWith('video/')) return <video className="content-video" src={src} controls playsInline preload="metadata" />
  if (mime?.startsWith('audio/')) return <audio src={src} controls preload="metadata" />
  return null
}

function InlineImage({ src, alt }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return failed ? <span>{alt || '图片'}</span>
    : <img className="content-image" src={src} alt={alt || ''} loading="lazy" onError={() => setFailed(true)} />
}

const targetAsset = (messageId, item) => ({ kind: 'asset', messageId, item })

export function ContentMarkdown({ text, artifacts = [], threadId, messageId, onView, mentionPlugin, onConversation }) {
  const target = href => {
    const destination = linkDestination(href)
    if (destination?.url) return { kind: 'browser', url: destination.url }
    if (!destination?.path) return null
    const item = artifacts.find(entry => entry.path === destination.path && entry.line === destination.line)
    return item ? targetAsset(messageId, item) : null
  }
  return <ReactMarkdown remarkPlugins={mentionPlugin ? [remarkGfm, mentionPlugin] : [remarkGfm]}
    urlTransform={url => target(url) ? url : defaultUrlTransform(url)}
    components={{
      mark: ({ node, children, ...props }) => props['data-conversation'] && onConversation
        ? <button type="button" className="mention-copy conversation-reference" onClick={() => onConversation(props['data-conversation'])}>{children}</button>
        : <mark {...props}>{children}</mark>,
      a: ({ href, children }) => {
        const view = target(href)
        if (view?.kind === 'browser' && typeof children === 'string') view.name = children.trim().slice(0, 100)
        if (!view || !onView) return <span>{children}</span>
        const Icon = view.kind === 'browser' ? Globe : fileIcon(view.item.path, view.item.mime)
        return <button type="button" className="content-link inline-reference" title={view.item?.path || view.url} onClick={() => onView(view)}>
          <Icon size={13} aria-hidden="true" /><span>{children}</span>
        </button>
      },
      img: ({ src, alt }) => {
        const view = target(src)
        if (!view || !onView) return <span>{alt || '图片'}</span>
        const local = view.kind === 'asset' && view.item.mime?.startsWith('image/')
        return <button type="button" className={local ? 'inline-image' : 'content-link inline-reference'} aria-label={'预览 ' + (alt || view.item?.name || '图片')}
          onClick={() => onView(view)}>
          {local ? <InlineImage src={assetURL(threadId, messageId, view.item.id)} alt={alt} />
            : <><FileImage size={13} aria-hidden="true" /><span>{alt || '打开图片'}</span></>}
        </button>
      },
      table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown>
}

export function GeneratedMedia({ threadId, messageId, artifacts, onView }) {
  const items = artifacts.filter(item => item.id.startsWith('generated-'))
  if (!items.length) return null
  return <div className="generated-media">{items.map(item => <button key={item.id} type="button" className="inline-image"
    aria-label={'预览 ' + item.name} onClick={() => onView(targetAsset(messageId, item))}>
    <InlineImage src={assetURL(threadId, messageId, item.id)} alt={item.name} />
  </button>)}</div>
}

function BrowserContent({ tabId, initialUrl, suspended }) {
  const [address, setAddress] = useState(initialUrl || '')
  const [state, setState] = useState({ url: '', error: '', canBack: false, canForward: false })
  const viewport = useRef(null)
  const sync = useRef(() => {})
  useEffect(() => api.onBrowser(result => {
    if (result.tabId !== tabId) return
    setState(result)
    if (result.url) setAddress(result.url)
  }), [tabId])
  useLayoutEffect(() => {
    if (suspended) return
    const element = viewport.current
    let alive = true
    sync.current = () => {
      if (!alive) return
      const { x, y, width, height } = element.getBoundingClientRect()
      void api.browser('bounds', tabId, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.round(width), height: Math.round(height) })
    }
    const observer = new ResizeObserver(sync.current)
    observer.observe(element)
    window.addEventListener('resize', sync.current)
    void api.browser('show', tabId, initialUrl).then(sync.current)
      .catch(error => { if (alive) setState(previous => ({ ...previous, error: errorText(error) })) })
    return () => {
      alive = false
      observer.disconnect()
      window.removeEventListener('resize', sync.current)
      void api.browser('hide', tabId)
    }
  }, [tabId, initialUrl, suspended])
  const navigate = value => {
    const url = websiteURL(value) || websiteURL('https://' + value.trim())
    if (!url) { setState(previous => ({ ...previous, error: '请输入有效的网页地址。' })); return }
    void api.browser('open', tabId, url).then(sync.current)
      .catch(error => setState(previous => ({ ...previous, error: errorText(error) })))
  }
  return <div className="panel-browser">
    <form className="browser-bar" onSubmit={event => { event.preventDefault(); navigate(address) }}>
      <button type="button" className="icon-button" aria-label="浏览器后退" disabled={!state.canBack} onClick={() => api.browser('back', tabId)}><ArrowLeft size={15} /></button>
      <button type="button" className="icon-button" aria-label="浏览器前进" disabled={!state.canForward} onClick={() => api.browser('forward', tabId)}><ArrowRight size={15} /></button>
      <button type="button" className="icon-button" aria-label="刷新网页" disabled={!state.url} onClick={() => api.browser('reload', tabId)}><RefreshCw size={14} /></button>
      <input aria-label="网页地址" placeholder="输入网页地址" value={address} onChange={event => setAddress(event.target.value)} />
      <button className="secondary-button" type="submit">打开</button>
    </form>
    {state.error && <p role="alert" className="content-error">{state.error}</p>}
    <div className="browser-viewport" ref={viewport} />
  </div>
}

function FileContent({ threadId, view, onView, onReference }) {
  const [state, setState] = useState(null)
  const { messageId, item, path } = view
  const workspace = view.kind === 'workspace'
  useEffect(() => {
    let live = true
    const request = workspace ? api.workspaceAsset(threadId, path) : api.contentAsset(threadId, messageId, item.id)
    request.then(data => { if (live) setState(data) }).catch(error => { if (live) setState({ error: errorText(error) }) })
    return () => { live = false }
  }, [threadId, workspace, path, messageId, item?.id])
  if (!state) return <p role="status" className="content-empty">正在打开文件…</p>
  if (state.error) return <p role="alert" className="content-error">{state.error}</p>
  const download = async () => {
    setState(previous => ({ ...previous, actionError: '' }))
    try { await api.saveContent(threadId, messageId, item.id) }
    catch (error) { setState(previous => ({ ...previous, actionError: errorText(error) })) }
  }
  const src = workspace ? 'rainbow-content://workspace/' + encodeURIComponent(threadId) + '/' + encodeURIComponent(path)
    : assetURL(threadId, messageId, item.id)
  return <div className="content-body">
    <div className="content-document-heading"><strong title={path || state.name}>{state.name}</strong>
      {workspace ? <button type="button" className="secondary-button" onClick={() => onReference(path)}><Paperclip size={14} />引用</button>
        : <button type="button" className="secondary-button" onClick={download}><Download size={14} />保存文件</button>}</div>
    {state.actionError && <p role="alert" className="content-error">{state.actionError}</p>}
    {state.kind === 'markdown' && <div className="bubble standalone-markdown"><ContentMarkdown text={state.text} onView={onView} /></div>}
    {state.kind === 'text' && <pre className="content-code"><code>{state.text}</code></pre>}
    {state.kind === 'file' && <p className="content-empty">这个文件格式暂无预览。</p>}
    {state.mime && <Media mime={state.mime} src={src} alt={state.name} />}
    {state.line && <p className="content-empty">引用第 {state.line} 行</p>}
    {state.truncated && <p className="content-empty">仅预览文件开头。</p>}
  </div>
}

const diffView = (messageId, item, file) => ({ kind: 'diff', messageId, itemId: item.id, filePath: file.path })
function DiffContent({ thread, view }) {
  const message = find(thread.messages, view.messageId)
  const file = find(message?.activity, view.itemId)?.files.find(file => file.path === view.filePath)
  return <div className="content-body">
    <div className="content-document-heading"><strong>{view.filePath}</strong>{file && <small>{operationLabel[file.operation]}</small>}</div>
    {file?.diff ? <pre className="content-code"><code>{file.diff}</code></pre> : <p className="content-empty">暂无差异内容。</p>}
  </div>
}

function Activity({ event, message, onView }) {
  if (event.kind === 'text') return <div className="bubble task-progress-text"><ContentMarkdown text={event.text} onView={onView} /></div>
  if (event.kind === 'changes') return <div className="task-event">
    <div className="task-event-label"><CodeXml size={14} />文件改动 <small>{eventStatus[event.status]}</small></div>
    {event.files.map(file => <button className="task-event-link content-link" type="button" key={file.path}
      onClick={() => onView(diffView(message.id, event, file))}>{file.path}</button>)}
  </div>
  if (event.kind === 'web') return <div className="task-event">
    <div className="task-event-label"><Globe size={14} />{event.label} <small>{eventStatus[event.status]}</small></div>
    {event.urls?.map(url => <button className="task-event-link content-link" type="button" key={url}
      onClick={() => onView({ kind: 'browser', url })}>{url}</button>)}
  </div>
  if (event.kind === 'asset') {
    const name = event.path.split('/').at(-1)
    const item = message.artifacts?.find(artifact => artifact.path === event.path)
      || { id: 'generated-' + event.id, path: event.path, mime: mediaType(event.path), name }
    return <button className="content-link inline-reference" type="button" onClick={() => onView(targetAsset(message.id, item))}>
      <FileImage size={13} aria-hidden="true" /><span>{name}</span>
    </button>
  }
  if (event.kind !== 'command' && event.kind !== 'tool') return null
  return <div className="task-event">
    <details open={event.status === 'inProgress' && event.output ? true : undefined}>
      <summary><span>{event.label || '工具调用'}</span><small>{eventStatus[event.status]}{Number.isInteger(event.exitCode) && ' · 退出码 ' + event.exitCode}</small></summary>
      <pre className="content-code"><code>{event.output || event.label || '暂无输出'}</code></pre>
    </details>
  </div>
}

function TaskTimeline({ thread, task, memberId, roles, drafts, onView }) {
  const runs = taskRuns(thread, task.id).filter(message => !memberId || message.author.id === memberId)
  const source = find(thread.messages, task.sourceMessageId)
  return <>
    {source?.text && !source.author && source.text !== task.instructions && <section className="task-scope">
      <strong>用户原始要求</strong><div className="bubble"><ContentMarkdown text={source.text} artifacts={source.artifacts}
        threadId={thread.id} messageId={source.id} onView={onView} /></div>
    </section>}
    {task.instructions && <section className="task-scope">
      <strong>任务指令</strong><div className="bubble"><ContentMarkdown text={task.instructions} onView={onView} /></div>
    </section>}
    {task.revisions?.length > 0 && <section className="task-scope">
      <strong>补充要求</strong>
      {task.revisions.map(revision => <div className="task-revision" key={revision.id}>
        {revision.at && <time>{time(revision.at)}</time>}<ContentMarkdown text={revision.instructions} onView={onView} />
      </div>)}
    </section>}
    {!runs.length && <p className="content-empty">暂无执行记录。</p>}
    {runs.map(message => {
      const author = find(roles, message.author.id)?.name || message.author.name
      const result = message.text || message.heldText || drafts[message.id]
      const visibleResult = result && !message.activity?.some(event => event.kind === 'text' && event.text.trim() === result.trim())
      return <section key={message.id} className="task-run">
        <header><strong>{author}</strong><small>{taskStatus[message.status] || (message.status === 'held' ? '已保留旧草稿' : message.status)}
          {message.startedAt && ' · ' + time(message.startedAt)}
          {message.finishedAt && message.finishedAt - message.startedAt >= 1000 && ' – ' + time(message.finishedAt)}</small></header>
        {message.activity?.map(event => <Activity key={event.id} event={event} message={message} onView={onView} />)}
        {visibleResult && <div className="bubble"><ContentMarkdown text={result} artifacts={message.artifacts}
          threadId={thread.id} messageId={message.id} onView={onView} /></div>}
        {message.error && <p className="content-error">{message.error}</p>}
        {message.status === 'running' && !message.activity?.length && !result && <p className="content-empty" role="status">正在执行…</p>}
      </section>
    })}
  </>
}

function MemberContent({ thread, view, roles, drafts, onView, onTask }) {
  const [selected, setSelected] = useState('')
  const member = find(roles, view.memberId)
  const tasks = memberTasks(thread, view.memberId)
  const task = find(tasks, selected) || tasks.find(item => item.roleId === view.memberId && item.status === 'running')
    || tasks.find(item => item.roleId === view.memberId && item.status === 'queued') || tasks[0]
  return <div className="content-body">
    <div className="content-document-heading"><strong>{member?.name || view.name}</strong></div>
    {task ? <>
      <div className="task-selection"><select aria-label="任务" value={task.id} onChange={event => setSelected(event.target.value)}>
        {tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select><small>{task.roleId !== view.memberId ? '已交接' : taskStatus[task.status]}</small>
        <button className="secondary-button task-followup" type="button" onClick={() => onTask(task.id)}>追问</button></div>
      <TaskTimeline thread={thread} task={task} memberId={view.memberId} roles={roles} drafts={drafts} onView={onView} />
    </> : <p className="content-empty">这位成员在当前会话还没有任务。</p>}
  </div>
}

function TaskContent({ thread, view, roles, drafts, onView, onTask }) {
  const task = find(thread.tasks, view.taskId)
  if (!task) return <p className="content-empty">任务已不可用。</p>
  const member = find(roles, view.memberId)?.name || taskRuns(thread, task.id).find(run => run.author.id === view.memberId)?.author.name
  return <div className="content-body">
    <div className="content-document-heading"><strong>{task.title}</strong>
      <small>{task.roleId === view.memberId ? taskStatus[task.status] : '已交接'}</small>
      <button type="button" className="secondary-button task-followup" onClick={() => onTask(task.id)}>追问</button></div>
    {member && <p className="task-member-name">{member}</p>}
    <TaskTimeline thread={thread} task={task} memberId={view.memberId} roles={roles} drafts={drafts} onView={onView} />
  </div>
}

function ContentPicker({ thread, roles, onView }) {
  const messages = [...thread.messages].sort((a, b) => b.at - a.at)
  const files = messages.flatMap(message => (message.artifacts || []).filter(item => item.path).map(item => ({ messageId: message.id, item })))
  const links = [...new Set(messages.flatMap(message => [
    ...(message.artifacts || []).map(item => item.url).filter(Boolean),
    ...(message.activity || []).flatMap(item => item.urls || []),
  ]))].slice(0, 20)
  return <div className="content-body content-picker">
    <button className="secondary-button" type="button" onClick={() => onView({ kind: 'browser' })}><Globe size={14} />打开网页</button>
    {thread.roleIds.length > 0 && <details open><summary>成员任务</summary><ul className="content-list">
      {thread.roleIds.map(id => find(roles, id)).filter(Boolean).map(role => <li key={role.id}>
        <button type="button" onClick={() => onView({ kind: 'member', memberId: role.id, name: role.name })}><ClipboardList size={15} /><span>{role.name}</span></button>
      </li>)}
    </ul></details>}
    {files.length > 0 && <details open><summary>消息附件</summary><ul className="content-list">
      {files.map(({ messageId, item }) => <li key={messageId + ':' + item.id}>
        <button type="button" title={item.path} onClick={() => onView(targetAsset(messageId, item))}><FileText size={15} /><span>{item.name}</span></button></li>)}
    </ul></details>}
    {links.length > 0 && <details><summary>会话链接</summary><ul className="content-list">
      {links.map(url => <li key={url}><button type="button" title={url} onClick={() => onView({ kind: 'browser', url })}><Globe size={15} /><span>{url}</span></button></li>)}
    </ul></details>}
  </div>
}

function tabTitle(view, thread, roles) {
  switch (view.kind) {
    case 'workspace': return view.name
    case 'asset': return view.item.path?.split('/').at(-1) || view.item.name
    case 'diff': return view.filePath.split('/').at(-1) + ' · 改动'
    case 'browser': return view.name || (view.url ? new URL(view.url).host : '网页')
    case 'member': return (find(roles, view.memberId)?.name || view.name) + ' · 任务'
    case 'task': {
      const title = find(thread.tasks, view.taskId)?.title || view.name
      const name = find(roles, view.memberId)?.name
      return name ? title + ' · ' + name : title
    }
  }
}

export function ContentPanel({ thread, roles, drafts, tabs, active, onSelect, onView, onTabClose, onReference, onResize, onTask, suspended }) {
  const [menu, setMenu] = useState(null)
  const strip = useRef(null)
  const panel = useRef(null)
  const drag = useRef(null)
  const [resizing, setResizing] = useState(false)
  const [measuredWidth, setMeasuredWidth] = useState(0)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setMeasuredWidth(Math.round(entry.contentRect.width)))
    observer.observe(panel.current)
    return () => observer.disconnect()
  }, [])
  const startResize = event => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, width: panel.current.getBoundingClientRect().width }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  const resize = event => {
    if (drag.current) onResize(drag.current.width + drag.current.x - event.clientX)
  }
  const endResize = () => {
    drag.current = null
    setResizing(false)
  }
  const resizeByKey = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    onResize(panel.current.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24))
  }
  const tab = find(tabs, active)
  const view = tab?.view
  const allTabs = [{ id: workspaceTabId }, ...tabs]
  const workspaceActive = active === workspaceTabId
  const close = id => {
    onTabClose(id)
    requestAnimationFrame(() => {
      strip.current?.querySelector('[aria-selected=true]')?.focus({ preventScroll: true })
    })
  }
  useEffect(() => {
    strip.current?.querySelector('.content-tab[data-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  useEffect(() => {
    if (!menu) return
    const outside = event => { if (!event.target.closest('.content-tab-menu')) setMenu(null) }
    const escape = event => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [menu])
  const selectByKey = (event, index) => {
    if (event.key === 'Delete' && index > 0) { close(allTabs[index].id); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? allTabs.length - 1
      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + allTabs.length) % allTabs.length
    onSelect(allTabs[next].id)
    strip.current.querySelectorAll('[role=tab]')[next]?.focus()
  }
  return <aside ref={panel} id="content-panel" className="content-panel" aria-label="内容详情">
    <div className="content-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整侧边内容宽度"
      aria-valuemin={240} aria-valuemax={Math.max(240, innerWidth)} aria-valuenow={measuredWidth || undefined}
      aria-grabbed={resizing} onKeyDown={resizeByKey} onPointerDown={startResize} onPointerMove={resize}
      onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} />
    <section className="content-documents">
      <div className="content-tabs">
        <div ref={strip} className="content-tab-strip" role="tablist" aria-label="已打开内容">
          {allTabs.map(({ id, view }, index) => {
            const title = view ? tabTitle(view, thread, roles) : '工作目录'
            const Icon = !view ? Folder : view.kind === 'browser' ? Globe : view.kind === 'member' || view.kind === 'task' ? ClipboardList
              : view.kind === 'diff' ? CodeXml : FileText
            const selected = id === active
            return <div className="content-tab" key={id} role="presentation" data-selected={selected}>
              <button id={'content-tab-' + id} aria-controls={view ? 'content-tab-page' : 'content-work-directory'} role="tab" type="button" title={title}
                aria-selected={selected} tabIndex={selected || !active && index === 0 ? 0 : -1} onClick={() => onSelect(id)}
                onKeyDown={event => selectByKey(event, index)} onAuxClick={event => { if (view && event.button === 1) close(id) }}
                onContextMenu={event => {
                  if (!view) return
                  event.preventDefault()
                  const bar = strip.current.parentElement.getBoundingClientRect()
                  setMenu({ id, x: Math.min(bar.width - 104, Math.max(0, event.clientX - bar.left)) })
                }}><Icon size={13} /><span>{title}</span></button>
              {view && <button type="button" className="icon-button content-tab-close" aria-label={'关闭标签页 ' + title} title={'关闭 ' + title}
                tabIndex={selected ? 0 : -1} onClick={() => close(id)}><X size={12} /></button>}
            </div>
          })}
        </div>
        <button className="icon-button" type="button" aria-label="打开更多内容" title="打开更多内容" onClick={() => onSelect(null)}><Plus size={16} /></button>
        {menu && <div className="content-tab-menu" style={{ left: menu.x }} role="menu">
          <button type="button" role="menuitem" onClick={() => { close(menu.id); setMenu(null) }}>关闭标签页</button>
        </div>}
      </div>
      <div className="content-tab-page" id="content-work-directory" hidden={!workspaceActive} role="tabpanel"
        aria-labelledby={'content-tab-' + workspaceTabId}>
        <WorkspaceFiles key={thread.id + ':' + thread.cwd} thread={thread} onView={onView} onReference={onReference}
          activePath={view?.kind === 'workspace' ? view.path : undefined} />
      </div>
      <div className="content-tab-page" id="content-tab-page" hidden={workspaceActive}
        role={view ? 'tabpanel' : undefined} aria-labelledby={view ? 'content-tab-' + tab.id : undefined}>
        {!view && !workspaceActive && <ContentPicker thread={thread} roles={roles} onView={onView} />}
        {view?.kind === 'browser' && <BrowserContent key={tab.id} tabId={tab.id} initialUrl={view.url} suspended={suspended || resizing || Boolean(menu)} />}
        {(view?.kind === 'asset' || view?.kind === 'workspace') && <FileContent key={tab.id} threadId={thread.id} view={view} onView={onView} onReference={onReference} />}
        {view?.kind === 'diff' && <DiffContent thread={thread} view={view} />}
        {view?.kind === 'member' && <MemberContent key={tab.id} thread={thread} view={view} roles={roles} drafts={drafts} onView={onView} onTask={onTask} />}
        {view?.kind === 'task' && <TaskContent thread={thread} view={view} roles={roles} drafts={drafts} onView={onView} onTask={onTask} />}
      </div>
    </section>
  </aside>
}
