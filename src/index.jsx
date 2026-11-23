import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, Check, ChevronRight,
  CircleAlert, CodeXml, FileText, Folder, Hash, Images, Lightbulb,
  MessageSquare, Monitor, PanelLeft, PanelRight, PencilLine, Plus, Reply,
  Send, Settings, Sparkles, Square, Trash2, UserRound, UsersRound, X,
} from 'lucide-react'
import '@fontsource-variable/nunito'
import { productName, version } from '../package.json'
import { findMentions } from '../shared/mentions.mjs'
import './style.css'

const api = window.rainbow
const runtimeLabel = { codex: 'Codex', deepseek: 'DeepSeek' }
const roomIcons = { chat: Hash, ideas: Lightbulb, code: CodeXml, reply: Reply }
const appIcon = './app-icon.png'
const art = (type, form = 'chibi') => './art/' + type + '-' + form + '.png'
const byId = (items, id) => items.find(item => item.id === id)
const pending = status => status === 'queued' || status === 'running'
const chatWorking = thread => thread.messages.some(message => pending(message.status) || pending(message.routing?.status))
const time = timestamp => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
const effortLabels = { none: '关闭', off: '关闭', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' }
const effortLabel = effort => effortLabels[effort] || effort
const modelLabel = (model, effort) => [model, effort && effortLabel(effort)].filter(Boolean).join(' · ')
const triggers = [
  { title: '让每个人打个招呼', text: '大家用自己的风格打个招呼吧，顺便说说你想在同一桌做什么。', icon: Sparkles },
  { title: '一起想个点子', text: '我们一起想一个适合周末做的小项目。请每个人接上前一位的想法。', icon: Lightbulb },
  { title: '试试分工协作', text: '用一个具体例子演示产品和研发会怎样分工。请互相参考前一位的回复。', icon: UsersRound },
]

function Avatar({ role, size = '' }) {
  if (!role) return <span className={'avatar avatar-user ' + size}><UserRound size={17} /></span>
  return <span className={'avatar ' + role.type + ' ' + role.form + ' ' + size}><img src={art(role.type, role.form)} alt="" /></span>
}

function IconButton({ icon: Icon, label, onClick, className = '', disabled = false, ...rest }) {
  return <button type="button" className={'icon-button ' + className} aria-label={label} title={label} onClick={onClick} disabled={disabled} {...rest}><Icon size={18} /></button>
}

function RuntimeBadge({ role }) {
  return <span className={'runtime-badge ' + role.type}>{runtimeLabel[role.type]}</span>
}

function ModelBadge({ type, model, name, effort, runLabel }) {
  if (!model) return null
  const label = modelLabel(model, effort)
  const details = name && name !== model ? name + ' (' + label + ')' : label
  const title = runLabel ? ['当前配置 ' + details, '本轮使用 ' + runLabel].join('\n') : details
  return <span className={'model-badge ' + type} title={title}>{label}</span>
}

function RoleModelBadge({ role }) {
  const model = role.modelInfo
  if (!model) return <ModelBadge type={role.type} model="待选择模型" />
  if (model.unavailable) return <ModelBadge type={role.type} model="所选模型不可用" />
  if (model.needsEffort) return <ModelBadge type={role.type} model={model.id} name={model.label} effort="待选择推理强度" />
  return <ModelBadge type={role.type} model={model.id} name={model.label} effort={model.effort} />
}

function Dialog({ title, children, close, wide = false }) {
  const ref = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog className={wide ? 'wide' : ''} ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="dialog-inner">
      <header><h2 id={titleId}>{title}</h2><IconButton icon={X} label="关闭" onClick={close} /></header>
      {children}
    </div>
  </dialog>
}

function FormFooter({ error, close, label, busy, danger }) {
  return <>
    {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
    <div className="form-footer">
      <button type="button" className="secondary-button" onClick={close}>取消</button>
      <button type="submit" className={'primary-button' + (danger ? ' danger-button' : '')} disabled={busy}>{busy ? '处理中…' : label}</button>
    </div>
  </>
}

function useSave(close) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(event, operation, values) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.run(operation, values)
      close()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, save, setError }
}

function RoleDialog({ role, close }) {
  const [data, setData] = useState(role || { name: '', type: 'codex', label: '', personality: '', form: 'chibi' })
  const { error, busy, save } = useSave(close)
  const update = (name, value) => setData(prev => ({ ...prev, [name]: value }))
  const catalog = useModelCatalog(data.type)
  const selected = catalog.models.find(model => model.id === data.model)
  const effort = selected && !selected.efforts.length ? '' : data.effort || ''
  return <Dialog title={role ? '编辑角色' : '创建角色'} close={close} wide>
    <form onSubmit={event => save(event, 'role', { ...data, effort })}>
      <div className="role-editor">
        <div className={'role-preview ' + data.type}>
          <img src={art(data.type, data.form)} alt={runtimeLabel[data.type] + (data.form === 'chibi' ? ' Q 版' : '立绘')} />
          <div className="form-toggle" aria-label="角色形态">
            <button type="button" aria-pressed={data.form === 'standee'} onClick={() => update('form', 'standee')}>立绘</button>
            <button type="button" aria-pressed={data.form === 'chibi'} onClick={() => update('form', 'chibi')}>Q 版</button>
          </div>
        </div>
        <div className="stack">
          <label>角色名字<input required maxLength={36} value={data.name} onChange={e => update('name', e.target.value)} placeholder="比如：研发小龙" /></label>
          <label>Agent 类型<select value={data.type} onChange={e => setData(prev => ({ ...prev, type: e.target.value, model: '', effort: '' }))}><option value="codex">Codex</option><option value="deepseek">DeepSeek Harness (dsh)</option></select></label>
          <ModelPicker catalog={catalog} value={data.model || ''} effort={effort} selected={selected}
            onChange={model => setData(prev => ({ ...prev, model, effort: prev.model === model ? prev.effort : '' }))}
            onEffort={value => update('effort', value)} />
          <label>角色标签<input required maxLength={40} value={data.label} onChange={e => update('label', e.target.value)} placeholder="比如：彩虹项目 · 研发" /></label>
          <label>性格与习惯<textarea rows={4} maxLength={4000} value={data.personality} onChange={e => update('personality', e.target.value)} placeholder="它怎么说话，擅长什么，有哪些做事习惯？" /></label>
        </div>
      </div>
      <FormFooter error={error} close={close} label={role ? '保存角色' : '创建角色'} busy={busy} />
    </form>
  </Dialog>
}

function useModelCatalog(type) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!type) return
    let alive = true
    api.models(type).then(models => { if (alive) setResult({ type, models, failed: false }) }).catch(() => {
      if (alive) setResult({ type, models: [], failed: true })
    })
    return () => { alive = false }
  }, [type])
  return result?.type === type ? { ...result, loading: false } : { models: [], loading: true, failed: false }
}

function ModelPicker({ catalog, value, effort, selected, onChange, onEffort, modelField = '模型版本', effortField = '推理强度' }) {
  const efforts = selected?.efforts || []
  return <div className="model-picker">
    <label>{modelField}<select required value={value} disabled={!catalog.models.length && !value} onChange={event => onChange(event.target.value)}>
      <option value="" disabled>选择模型</option>
      {value && !selected && <option value={value} disabled>{value}{!catalog.loading && !catalog.failed ? '（运行时未列出）' : ''}</option>}
      {catalog.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select></label>
    <label>{effortField}<select required={efforts.length > 0} value={effort} disabled={!efforts.length} onChange={event => onEffort(event.target.value)}>
      <option value="" disabled>{!selected ? '先选择模型' : efforts.length ? '选择推理强度' : '此模型无可选档位'}</option>
      {effort && !efforts.includes(effort) && <option value={effort} disabled>{effortLabel(effort)}{selected ? '（不可用）' : ''}</option>}
      {efforts.map(value => <option key={value} value={value}>{effortLabel(value)}</option>)}
    </select></label>
    {catalog.loading && <small role="status">正在读取模型…</small>}
    {(catalog.failed || (!catalog.loading && !catalog.models.length)) && <small>没有可选模型。请检查运行时设置后重新打开。</small>}
  </div>
}

function RenameThreadDialog({ thread, close }) {
  const [name, setName] = useState(thread.name)
  const { error, busy, save } = useSave(close)
  return <Dialog title="重命名" close={close}>
    <form className="stack" onSubmit={event => save(event, 'renameThread', { threadId: thread.id, name })}>
      <label>会话名<input autoFocus required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
      <FormFooter error={error} close={close} label="保存名称" busy={busy} />
    </form>
  </Dialog>
}

function DeleteThreadDialog({ thread, hasReplies, close }) {
  const { error, busy, save } = useSave(close)
  return <Dialog title="删除会话" close={close}>
    <form className="stack" onSubmit={event => save(event, 'deleteThread', { threadId: thread.id })}>
      <p className="dialog-note delete-note">将删除「{thread.name}」及其中的消息和笔记{hasReplies ? '，包括所有回复线程' : ''}。此操作无法撤销。</p>
      <FormFooter error={error} close={close} label="删除会话" busy={busy} danger />
    </form>
  </Dialog>
}

async function choosePath(kind, update, fail) {
  try {
    const path = await api.pick(kind)
    if (path) update(path)
  } catch (error) { fail(errorText(error)) }
}

function ThreadFields({ data, update, defaultDirectory, onError }) {
  return <>
    <label>会话名称<input required maxLength={60} value={data.name} onChange={event => update('name', event.target.value)} placeholder="比如：发布计划" /></label>
    <label>会话详情<textarea rows={3} maxLength={4000} value={data.description} onChange={event => update('description', event.target.value)}
      placeholder="描述会话用途和范围，供成员处理消息时参考。" /></label>
    <label>工作目录<span className="path-input"><input value={data.cwd} onChange={event => update('cwd', event.target.value)}
      placeholder="默认目录" title={data.cwd || defaultDirectory} />
      <IconButton icon={Folder} label="选择工作目录" onClick={() => choosePath('directory', value => update('cwd', value), onError)} /></span></label>
    <label className="check-label"><input type="checkbox" disabled={!data.cwd} checked={Boolean(data.cwd && data.writeAccess)} onChange={event => update('writeAccess', event.target.checked)} />允许写入工作目录</label>
    <label className="check-label"><input type="checkbox" checked={data.autoHandoff !== false} onChange={event => update('autoHandoff', event.target.checked)} />允许 Agent 直接交接</label>
  </>
}

function RoleChoices({ roles, roleIds, onChange }) {
  return <div className="role-picker">
    {roles.map(role => <label key={role.id} className="role-choice">
      <Avatar role={role} size="small" />
      <span>{role.name}<small>{role.label}</small></span>
      <input type="checkbox" aria-label={role.name} checked={roleIds.includes(role.id)}
        onChange={event => onChange(event.target.checked ? [...roleIds, role.id] : roleIds.filter(id => id !== role.id))} />
    </label>)}
  </div>
}

function ThreadDialog({ roles, defaultDirectory, close, onSaved }) {
  const [data, setData] = useState({ name: '', description: '', cwd: '', roleIds: roles.map(role => role.id), writeAccess: false, autoHandoff: true })
  const { error, busy, save, setError } = useSave(onSaved)
  const update = (name, value) => setData(prev => ({ ...prev, [name]: value }))
  return <Dialog title="新建会话" close={close}>
    <form className="stack" onSubmit={event => save(event, 'room', data)}>
      <ThreadFields data={data} update={update} defaultDirectory={defaultDirectory} onError={setError} />
      <fieldset>
        <legend>会话成员</legend>
        <RoleChoices roles={roles} roleIds={data.roleIds} onChange={value => update('roleIds', value)} />
      </fieldset>
      <FormFooter error={error} close={close} label="新建会话" busy={busy} />
    </form>
  </Dialog>
}

function ThreadMembersDialog({ thread, roles, close }) {
  const [roleIds, setRoleIds] = useState(thread.roleIds)
  const { error, busy, save } = useSave(close)
  return <Dialog title="添加成员" close={close}>
    <form className="stack" onSubmit={event => save(event, 'threadRoles', { threadId: thread.id, roleIds })}>
      <p className="dialog-note">从角色库选择要加入这个会话的成员。</p>
      <RoleChoices roles={roles} roleIds={roleIds} onChange={setRoleIds} />
      <FormFooter error={error} close={close} label="保存成员列表" busy={busy} />
    </form>
  </Dialog>
}

function NoteDialog({ thread, file, close }) {
  const [content, setContent] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api.run('readNote', { threadId: thread.id, file }).then(text => { if (alive) setContent(text) })
      .catch(failure => { if (alive) setError(errorText(failure)) })
    return () => { alive = false }
  }, [thread.id, file])
  return <Dialog title={file} close={close} wide>
    {error ? <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>
      : content === null ? <p className="dialog-note" role="status">正在读取笔记…</p>
      : <div className="bubble note-document"><ReactMarkdown
        components={{ img: ({ alt }) => <span>{alt || '[图片]'}</span>, a: ({ children }) => <span className="message-link">{children}</span> }}>
        {content}</ReactMarkdown></div>}
  </Dialog>
}

function DeleteNoteDialog({ thread, file, close }) {
  const { error, busy, save } = useSave(close)
  return <Dialog title="删除笔记" close={close}>
    <form className="stack" onSubmit={event => save(event, 'deleteNote', { threadId: thread.id, file })}>
      <p className="dialog-note delete-note">将删除「{file}」。此操作无法撤销。</p>
      <FormFooter error={error} close={close} label="删除笔记" busy={busy} danger />
    </form>
  </Dialog>
}

function SettingsDialog({ settings, runtimes, close }) {
  const [data, setData] = useState(settings)
  const { error, busy, save, setError } = useSave(close)
  const update = (name, value) => setData(prev => ({ ...prev, [name]: value }))
  const routing = data.routing || { type: '', model: '', effort: '' }
  const catalog = useModelCatalog(routing.type)
  const selected = catalog.models.find(model => model.id === routing.model)
  const effort = selected && !selected.efforts.length ? '' : routing.effort
  const updateRouting = values => update('routing', { ...routing, ...values })
  return <Dialog title="运行时设置" close={close}>
    <form className="stack" onSubmit={event => save(event, 'runtimeSettings', { ...data, routing: { ...routing, effort } })}>
      <p className="dialog-note">沿用 Codex 和 DSH 现有的登录。留空时自动查找已安装的客户端。</p>
      {runtimes.map(runtime => {
        const key = runtime.type + 'Path'
        return <label key={key}>{runtimeLabel[runtime.type]} 可执行文件<span className="path-input">
          <input value={data[key]} onChange={e => update(key, e.target.value)} placeholder={runtime.path || '未找到，请选择文件'} />
          <IconButton icon={Folder} label={'选择 ' + runtimeLabel[runtime.type] + ' 可执行文件'} onClick={() => choosePath('file', value => update(key, value), setError)} />
        </span></label>
      })}
      <fieldset className="routing-settings stack">
        <legend>自动分流</legend>
        <label>分流运行时<select value={routing.type} onChange={event => updateRouting({ type: event.target.value, model: '', effort: '' })}>
          <option value="">未配置</option>
          {runtimes.map(runtime => <option key={runtime.type} value={runtime.type}>{runtimeLabel[runtime.type]}</option>)}
        </select></label>
        {routing.type && <ModelPicker catalog={catalog} value={routing.model} effort={effort} selected={selected} modelField="分流模型" effortField="分流推理强度"
          onChange={model => updateRouting({ model, effort: '' })} onEffort={value => updateRouting({ effort: value })} />}
      </fieldset>
      <FormFooter error={error} close={close} label="保存设置" busy={busy} />
    </form>
  </Dialog>
}

function BranchLinks({ parentId, threads, selectedId, select, openMenu, depth = 1 }) {
  return threads.filter(thread => thread.parentId === parentId).map(thread =>
    <React.Fragment key={thread.id}>
      <button className={'room-link branch-link ' + (selectedId === thread.id ? 'current-branch' : '')}
        style={{ '--branch-indent': Math.min(depth, 4) * 10 + 'px' }} onClick={() => select(thread.id)} onContextMenu={event => openMenu(event, thread)}
        aria-current={selectedId === thread.id ? 'page' : undefined}><Reply size={14} /><span>{thread.name}</span></button>
      <BranchLinks parentId={thread.id} threads={threads} selectedId={selectedId} select={select} openMenu={openMenu} depth={depth + 1} />
    </React.Fragment>)
}

function SideBar({ state, page, navigate, show, close, command, openMenu }) {
  const room = byId(state.threads, state.activeThreadId)
  let root = room
  while (root?.parentId) root = byId(state.threads, root.parentId)
  const ready = state.runtimes.filter(item => item.available).length
  const select = id => {
    command('select', { threadId: id })
    navigate('chat')
    close()
  }
  return <aside className="sidebar">
    <section className="sidebar-top">
      <div className="workspace-title">
        <img className="workspace-logo" src={appIcon} alt="" />
        <div><strong>{productName}</strong><small>v{version}</small></div>
      </div>
      <div className="nav-switch" aria-label="工作区导航">
        <button aria-pressed={page === 'chat'} onClick={() => { navigate('chat'); close() }}><MessageSquare size={16} /> 会话</button>
        <button aria-pressed={page === 'roles'} onClick={() => { navigate('roles'); close() }}><UsersRound size={16} /> 角色</button>
      </div>
    </section>
    <div className="sidebar-scroll">
      <div className="side-heading"><span>我的会话</span><IconButton icon={Plus} label="新建会话" onClick={() => show({ type: 'room' })} /></div>
      <nav aria-label="我的会话">
        {state.threads.filter(thread => !thread.parentId).map(thread => {
          const Icon = roomIcons[thread.kind] || Hash
          const selected = page === 'chat' && root?.id === thread.id
          return <div key={thread.id}>
            <button className={'room-link ' + (selected ? 'selected' : '')} onClick={() => select(thread.id)} onContextMenu={event => openMenu(event, thread)}
              aria-current={page === 'chat' && room?.id === thread.id ? 'page' : undefined}>
              <Icon size={17} /><span>{thread.name}</span>{selected && <span className="nav-dot" />}
            </button>
            {selected && <BranchLinks parentId={thread.id} threads={state.threads} selectedId={room.id} select={select} openMenu={openMenu} />}
          </div>
        })}
      </nav>
      <button className="ghost-new" onClick={() => { show({ type: 'room' }); close() }}><Plus size={16} />新建会话</button>
    </div>
    <button className="runtime-link" onClick={() => { show({ type: 'settings' }); close() }}>
      <span className="runtime-icon"><Monitor size={17} /></span>
      <span><strong>运行时设置</strong><small><i className={ready ? 'green-dot' : 'muted-dot'} />{ready} / 2 就绪</small></span>
      <ChevronRight size={16} />
    </button>
  </aside>
}

function ThreadContextMenu({ menu, close, choose }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    const { width, height } = element.getBoundingClientRect()
    element.style.left = Math.max(6, Math.min(menu.x, innerWidth - width - 6)) + 'px'
    element.style.top = Math.max(6, Math.min(menu.y, innerHeight - height - 6)) + 'px'
    element.querySelector('button')?.focus({ preventScroll: true })
    const outside = event => { if (!element.contains(event.target)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu, close])
  return <div className="pop-menu thread-menu" role="menu" aria-label="会话操作" ref={ref} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      menu.trigger?.focus()
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const buttons = [...ref.current.querySelectorAll('button')]
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length]?.focus()
    }
    if (event.key === 'Tab') close()
  }}>
    <button type="button" role="menuitem" onClick={() => choose('renameThread')}><PencilLine size={15} />重命名</button>
    <button type="button" role="menuitem" className="delete-action" onClick={() => choose('deleteThread')}><Trash2 size={15} />删除</button>
  </div>
}

function Hero({ thread, roles, onPrompt }) {
  return <div className="welcome">
    <section className="welcome-banner">
      <div className="welcome-rainbow" aria-hidden="true" />
      <Sparkles className="banner-sparkle first" aria-hidden="true" />
      <Sparkles className="banner-sparkle second" aria-hidden="true" />
      <div className="welcome-copy">
        <h1>今天，聊点什么？</h1>
        <p>{thread.description || '和会话成员聊个话题。'}</p>
      </div>
      <div className="hero-characters" aria-hidden="true">{roles.slice(0, 2).map(role =>
        <img key={role.id} className={role.form} src={art(role.type, role.form)} alt="" />)}</div>
    </section>
    {roles.length > 0 && <div className="quick-section">
      <h2>开个话题</h2>
      <div className="quick-prompts">{triggers.map(({ title, text, icon: Icon }) =>
        <button key={title} onClick={() => onPrompt(text)}><span className="quick-icon"><Icon size={16} /></span><span>{title}</span><ArrowRight size={14} className="quick-arrow" /></button>)}</div>
    </div>}
  </div>
}

function remarkMentions(roles) {
  return () => root => {
    const visit = node => {
      if (!node.children) return
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') { visit(child); return [child] }
        const mentions = findMentions(child.value, roles)
        if (!mentions.length) return [child]
        const output = []
        let cursor = 0
        for (const { start, end } of mentions) {
          if (cursor < start) output.push({ type: 'text', value: child.value.slice(cursor, start) })
          output.push({ type: 'mention', data: { hName: 'mark', hProperties: { className: ['mention-copy'] } },
            children: [{ type: 'text', value: child.value.slice(start, end).replace(/^@\{(.+)\}$/, '@$1') }] })
          cursor = end
        }
        if (cursor < child.value.length) output.push({ type: 'text', value: child.value.slice(cursor) })
        return output
      })
    }
    visit(root)
  }
}

const taskStatus = { queued: '排队中', running: '进行中', done: '已完成', unassigned: '待认领', blocked: '前置未完成', error: '失败', stopped: '已停止' }

function QuoteContent({ message, roles }) {
  const name = byId(roles, message.author?.id)?.name || message.author?.name || '你'
  return <span className="quote-content"><strong>{name}</strong><span>{message.text.replace(/\s+/g, ' ').slice(0, 180)}</span></span>
}

function Message({ message, draft, thread, roles, onReply, onInvite, onTask, openRouting }) {
  const [show, toggle] = useState(false)
  const { author, status } = message
  const working = status === 'running' || status === 'queued'
  const error = status === 'error' || status === 'stopped'
  const currentRole = author && byId(roles, author.id)
  const displayRole = currentRole || author
  const currentModel = currentRole?.modelInfo
  const canAct = !working && !error && status !== 'held'
  const receivers = (message.targetIds || []).map(id => byId(roles, id)?.name).filter(Boolean)
  const assignable = thread.roleIds.filter(id => id !== author?.id).map(id => byId(roles, id)).filter(Boolean)
  const handoff = byId(roles, message.handoffTo)
  const tasks = thread.tasks || []
  const task = byId(tasks, message.taskId)
  const quoted = message.replyToId && byId(thread.messages, message.replyToId)
  const attached = author ? [] : tasks.filter(item => item.sourceMessageId === message.id)
  return <article id={'message-' + message.id} className={'message ' + (author?.type || 'human') + (error ? ' message-error' : '')}>
    <Avatar role={displayRole} />
    <div className="message-body">
      <div className="message-meta"><strong>{displayRole?.name || '你'}</strong>
        {currentRole ? <ModelBadge type={currentRole.type} model={currentModel?.id || '待选择模型'} name={currentModel?.label}
          effort={currentModel?.effort} runLabel={modelLabel(message.model, message.effort)} />
          : author && <ModelBadge type={author.type} model={message.model} name={message.modelName} effort={message.effort} />}
        <time dateTime={new Date(message.at).toISOString()}>{time(message.at)}</time>
      </div>
      <div className="bubble">
        {quoted && <button type="button" className="message-quote" onClick={() => {
          document.getElementById('message-' + quoted.id)?.scrollIntoView({ block: 'center' })
        }}><QuoteContent message={quoted} roles={roles} /></button>}
        {status === 'held' ? <details><summary>收到新要求，旧草稿已搁置</summary><p>{message.heldText}</p></details>
          : working && !draft ? <span className="working"><span className="typing"><i /><i /><i /></span>{status === 'queued' ? '等待接话' : '正在回复'}</span>
          : error ? <span className="message-failure"><CircleAlert size={16} />{message.error}</span>
          : <ReactMarkdown remarkPlugins={[remarkMentions(roles)]}
            components={{ img: ({ alt }) => <span>{alt || '[图片]'}</span>, a: ({ children }) => <span className="message-link">{children}</span> }}>
            {message.text || draft || ''}</ReactMarkdown>}
      </div>
      {receivers.length > 0 && <div className="delivery-receipt"><AtSign size={12} />{receivers.join('、')}</div>}
      {task && <div className="delivery-receipt">{task.title}</div>}
      {pending(message.routing?.status) && <div className="delivery-receipt" role="status">{message.routing.status === 'running' ? '正在分流' : '等待分流'}</div>}
      {message.routing?.error && <div className="delivery-receipt note-error">{message.routing.error}
        {message.routing.configure && <button type="button" className="text-button" onClick={openRouting}>设置分流</button>}</div>}
      {attached.length > 0 && <details className="routed-tasks" open>
        <summary>任务 · {attached.length}</summary>
        <ul>{attached.map(item => <li key={item.id}>
          <span><strong>{item.title}</strong><small>{[byId(roles, item.roleId)?.name,
            item.status === 'queued' && item.dependsOn.some(id => byId(tasks, id)?.status !== 'done') ? '等待前置任务' : taskStatus[item.status]].filter(Boolean).join(' · ')}</small></span>
          <button type="button" className="text-button" onClick={() => onTask(item)}>{item.roleId ? '追问' : '指定接手'}</button>
        </li>)}</ul>
      </details>}
      {message.handoffFrom && <div className="delivery-receipt"><Reply size={12} />接手来自 {message.handoffFrom} 的消息</div>}
      {handoff && <div className="delivery-receipt"><Send size={12} />交接给 {handoff.name}</div>}
      {message.noteError && <div className="delivery-receipt note-error"><CircleAlert size={12} />{message.noteError}</div>}
    </div>
    {canAct && <div className="message-actions">
      <IconButton icon={Reply} label="回复此消息" onClick={onReply} />
      {assignable.length > 0 && <div className="invite-wrap">
        <IconButton icon={Send} label="指定成员接手" onClick={() => toggle(!show)} aria-expanded={show} />
        {show && <><button className="menu-dismiss" aria-label="关闭交接菜单" onClick={() => toggle(false)} />
          <div className="pop-menu invite-menu"><span>交接给</span>{assignable.map(role =>
            <button key={role.id} onClick={() => { toggle(false); onInvite(role.id) }}><Avatar role={role} size="tiny" />{role.name}</button>)}</div></>}
      </div>}
    </div>}
  </article>
}

function Composer({ thread, roles, working, fill, error, command, task, clearTask, quote, clearQuote }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [hideMentions, setHideMentions] = useState(false)
  const [sending, setSending] = useState(false)
  const ref = useRef()
  const prefix = text.slice(0, caret)
  const mention = /(?:^|\s)@([^@\n]*)$/u.exec(prefix)
  const candidates = mention && !hideMentions ? roles.filter(role => role.name.toLowerCase().includes(mention[1].toLowerCase())) : []
  const fillText = fill?.text
  useEffect(() => {
    if (fillText) { setText(fillText); setCaret(fillText.length); ref.current?.focus() }
  }, [fill])
  useEffect(() => { if (task?.id) ref.current?.focus() }, [task?.id])
  useEffect(() => { if (quote?.id) ref.current?.focus() }, [quote?.id])
  useLayoutEffect(() => {
    const editor = ref.current
    editor.style.height = '0px'
    editor.style.height = Math.max(42, Math.min(editor.scrollHeight, 142)) + 'px'
  }, [text])

  function insertMention(role) {
    const plain = prefix.slice(0, prefix.lastIndexOf('@')) + '@' + role.name + ' '
    const next = plain + text.slice(caret)
    setText(next)
    setCaret(plain.length)
    setHideMentions(true)
    requestAnimationFrame(() => { ref.current.focus(); ref.current.setSelectionRange(plain.length, plain.length) })
  }

  async function send(event) {
    event?.preventDefault()
    if (sending || !text.trim()) return
    setSending(true)
    try {
      if (await command('send', { threadId: thread.id, taskId: task?.id, replyToId: quote?.id, text })) {
        setText('')
        setCaret(0)
        setHideMentions(false)
        if (quote) clearQuote(quote.id)
        ref.current?.focus()
      }
    } finally { setSending(false) }
  }
  return <div className="composer-area">
    {error && <div role="alert" className="composer-error"><CircleAlert size={15} />{error}</div>}
    <form className="composer" onSubmit={send}>
      {task && <div className="composer-task"><span>追问「{task.title}」</span><IconButton icon={X} label="退出任务追问" onClick={clearTask} /></div>}
      {quote && <div className="composer-quote"><QuoteContent message={quote} roles={roles} />
        <IconButton icon={X} label="取消引用" onClick={() => clearQuote(quote.id)} /></div>}
      {candidates.length > 0 && <div className="pop-menu mentions-menu"><span>点名成员</span>{candidates.map(role =>
        <button key={role.id} type="button" onMouseDown={event => event.preventDefault()} onClick={() => insertMention(role)}>
          <Avatar role={role} size="tiny" />{role.name}
          <RoleModelBadge role={role} />
        </button>)}</div>}
      <textarea aria-label="消息" ref={ref} rows={1} maxLength={24000} value={text}
        placeholder={task && !task.roleId ? '用 @ 指定接手成员，再补充要求…' : '说点什么，或用 @ 点名成员…'}
        onChange={event => { setText(event.target.value); setCaret(event.target.selectionStart); setHideMentions(false) }}
        onSelect={event => setCaret(event.target.selectionStart)}
        onKeyDown={event => {
          if (event.key === 'Escape') setHideMentions(true)
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            if (candidates.length === 1) insertMention(candidates[0])
            else if (!candidates.length) void send()
          }
        }} />
      <div className="composer-tools">
        <div className="targets">
          <IconButton icon={AtSign} label="点名成员" disabled={!roles.length} onClick={() => {
            const next = text.slice(0, caret) + (caret && !/\s$/.test(prefix) ? ' @' : '@')
            setHideMentions(false)
            setText(next + text.slice(caret))
            setCaret(next.length)
            requestAnimationFrame(() => { ref.current.focus(); ref.current.setSelectionRange(next.length, next.length) })
          }} />
        </div>
        <div className="targets">
          {working && <button type="button" className="stop-button" onClick={() => command('stop', { threadId: thread.id })}><Square size={13} />停止</button>}
          <button className="send-button" type="submit" aria-label="发送消息" title="发送消息 (Enter)" disabled={!text.trim() || sending}><ArrowUp size={19} /></button>
        </div>
      </div>
    </form>
    <div className="composer-foot">Enter 发送 <span className="separator">·</span> Shift + Enter 换行</div>
  </div>
}

function SessionSettings({ thread, roles, runtimes, defaultDirectory, memberSection, show, close }) {
  const [fields, setFields] = useState({})
  const { error, busy, save, setError } = useSave(() => setFields({}))
  const data = { ...thread, ...fields }
  const active = chatWorking(thread)
  const dirty = Object.keys(fields).some(name => thread[name] !== fields[name])
  const update = (name, value) => setFields(prev => ({ ...prev, [name]: value }))
  return <aside id="session-settings" className="roster" aria-label="会话设置">
    <div className="roster-header"><h2>会话设置</h2><IconButton icon={X} className="close-roster" label="关闭会话设置" onClick={close} /></div>
    <div className="roster-scroll">
      <section className="settings-section">
        <div className="section-heading"><h3>基本信息</h3></div>
        <form className="thread-basics" onSubmit={event => save(event, 'threadSettings', { threadId: thread.id, ...fields })}>
          <ThreadFields data={data} update={update} defaultDirectory={defaultDirectory} onError={setError} />
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <button type="submit" className="primary-button" disabled={!dirty || busy || active} title={active ? '回复结束后可保存设置' : undefined}>
            {busy ? '保存中…' : '保存设置'}
          </button>
        </form>
      </section>
      <section className="settings-section" ref={memberSection} tabIndex={-1} aria-label="会话成员">
        <div className="section-heading"><h3>成员</h3><button type="button" className="secondary-button"
          onClick={() => show({ type: 'threadRoles', threadId: thread.id })}><Plus size={15} />添加成员</button></div>
        <div className="settings-characters">
          {roles.map(role => {
            const runtime = runtimes.find(item => item.type === role.type)
            const running = thread.messages.some(message => message.author?.id === role.id && message.status === 'running')
            const model = role.modelInfo
            const configured = model && !model.unavailable && !model.needsEffort
            return <button key={role.id} className={'character-card ' + role.type}
              onClick={() => show({ type: 'role', role })} aria-label={'编辑 ' + role.name}>
              <div className="card-halo" aria-hidden="true" /><Sparkles className="card-sparkle" size={16} aria-hidden="true" />
              <div className="character-info"><RuntimeBadge role={role} /><strong>{role.name}</strong><span>{role.label}</span>
                <span className="character-model" title={model?.id}>{model?.unavailable ? '所选模型不可用' : model?.label || '待选择模型'}</span>
                {model?.needsEffort && <span className="character-effort">待选择推理强度</span>}
                {configured && model.effort && <span className="character-effort">推理强度 {effortLabel(model.effort)}</span>}
                <small><i className={runtime?.available && configured ? 'green-dot' : 'muted-dot'} />
                  {running ? '回复中' : !runtime?.available ? '未找到运行时' : configured ? '就绪' : '待配置'}</small>
              </div>
              <img src={art(role.type, role.form)} className={role.form} alt="" />
            </button>
          })}
          {!roles.length && <p className="settings-empty">暂无成员</p>}
        </div>
      </section>
      <section className="settings-section" aria-label="会话笔记">
        <div className="section-heading"><h3>会话笔记</h3></div>
        {thread.noteFiles?.length ? <ul className="note-files">
          {thread.noteFiles.map(file => <li key={file}>
            <button type="button" className="note-file" title={file} onClick={() => show({ type: 'note', threadId: thread.id, file })}>
              <FileText size={16} /><span>{file}</span>
            </button>
            <IconButton icon={Trash2} label={'删除 ' + file} onClick={() => show({ type: 'deleteNote', threadId: thread.id, file })} />
          </li>)}
        </ul> : <p className="settings-empty">暂无笔记</p>}
      </section>
    </div>
  </aside>
}

function RoleLibrary({ roles, show }) {
  return <main className="library">
    <header className="library-head"><div><h1>我的角色</h1><p>设置角色的名字、分工和性格。</p></div>
      <button className="primary-button" onClick={() => show({ type: 'role' })}><Plus size={16} />创建角色</button>
    </header>
    <div className="library-grid">
      {roles.map(role => <button className={'library-card ' + role.type} key={role.id} onClick={() => show({ type: 'role', role })} aria-label={'编辑 ' + role.name}>
        <div className="library-art"><img src={art(role.type, role.form)} alt="" /><span className="form-pill"><Images size={13} />{role.form === 'chibi' ? 'Q 版' : '立绘'}</span></div>
        <div className="library-info"><div><strong>{role.name}</strong>
          <RoleModelBadge role={role} />
        </div><span>{role.label}</span>
          {role.personality && <p>{role.personality}</p>}</div>
      </button>)}
    </div>
  </main>
}

function Chat({ state, thread, show, command, drafts, error, toggleRoster, settingsOpen, showMembers }) {
  const [fill, setFill] = useState(null)
  const [taskId, setTaskId] = useState(null)
  const [replyToId, setReplyToId] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const list = useRef(null)
  const stick = useRef(true)
  const roles = thread.roleIds.map(id => byId(state.roles, id)).filter(Boolean)
  const running = chatWorking(thread)
  const HeadingIcon = roomIcons[thread.kind] || Hash
  const parent = byId(state.threads, thread.parentId)
  const anchorAuthor = parent?.messages.find(message => message.id === thread.anchorMessageId)?.author?.id
  const anchorName = byId(state.roles, anchorAuthor)?.name || thread.anchor?.name
  const moveToBottom = () => {
    if (!list.current) return
    list.current.scrollTop = list.current.scrollHeight
    stick.current = true
    setAtBottom(true)
  }
  useLayoutEffect(() => { if (stick.current) moveToBottom() }, [thread.messages, drafts])
  return <main className="chat">
    <header className="chat-header">
      {parent
        ? <IconButton icon={ArrowLeft} label={'返回 ' + parent.name} onClick={() => command('select', { threadId: parent.id })} />
        : <div className="room-icon"><HeadingIcon size={21} /></div>}
      <div className="chat-title"><h1>{thread.name}</h1><span>{parent ? '回复线程 · ' + parent.name : '共享会话 · ' + roles.length + ' 位成员'}</span></div>
      <div className="chat-header-tools">
        <button type="button" className="avatar-group" aria-label="查看会话成员" onClick={showMembers} aria-controls="session-settings">
          {roles.slice(0, 5).map(role => <Avatar key={role.id} role={role} size="tiny" />)}
          {roles.length > 5 && <span>+{roles.length - 5}</span>}
          {!roles.length && <UsersRound size={17} />}
        </button>
        <IconButton icon={PanelRight} label={settingsOpen ? '收起会话设置' : '展开会话设置'} onClick={toggleRoster}
          aria-expanded={settingsOpen} aria-controls="session-settings" />
      </div>
    </header>
    <div className="conversation" ref={list} onScroll={e => {
      const target = e.currentTarget
      stick.current = target.scrollHeight - target.clientHeight - target.scrollTop < 100
      setAtBottom(stick.current)
    }}>
      {thread.anchor && <div className="thread-anchor"><Reply size={17} /><div><strong>{anchorName}</strong><p>{thread.anchor.text}</p></div></div>}
      {thread.messages.length === 0 && <Hero thread={thread} roles={roles} onPrompt={text => setFill({ text })} />}
      {thread.messages.length > 0 && <section className="message-list" aria-label="会话记录">
        {thread.messages.map(message => <Message key={message.id} message={message} draft={drafts[message.id]} thread={thread} roles={state.roles}
          onTask={task => { setReplyToId(null); setTaskId(task.id) }} openRouting={() => show({ type: 'settings' })}
          onReply={() => { setTaskId(null); setReplyToId(message.id) }}
          onInvite={roleId => command('inviteReply', { threadId: thread.id, messageId: message.id, roleId })} />)}
      </section>}
    </div>
    {!atBottom && <button type="button" className="jump-latest" onClick={moveToBottom}><ArrowDown size={15} />回到最新</button>}
    <Composer thread={thread} roles={roles} working={running} fill={fill} error={error} command={command}
      task={byId(thread.tasks || [], taskId)} clearTask={() => setTaskId(null)}
      quote={byId(thread.messages, replyToId)} clearQuote={id => setReplyToId(current => current === id ? null : current)} />
  </main>
}

function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function App() {
  const [state, setState] = useState(null)
  const [loadingError, setLoadingError] = useState('')
  const [error, setError] = useState('')
  const [drafts, setDrafts] = useState({})
  const [page, setPage] = useState('chat')
  const [dialog, show] = useState(null)
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [sidebar, setSidebar] = useState(false)
  const [roster, setRoster] = useState(null)
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1051px)').matches)
  const memberSection = useRef(null)
  const settingsOpen = roster ?? wide
  useEffect(() => {
    const query = matchMedia('(min-width: 1051px)')
    const update = event => setWide(event.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!api) { setLoadingError('请用 npm start 打开 ' + productName + ' 桌面应用。'); return }
    let alive = true
    let received = false
    const offChange = api.onChange(value => {
      received = true
      setState(value)
      const running = new Set(value.threads.flatMap(thread => thread.messages.filter(message => message.status === 'running').map(message => message.id)))
      setDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => running.has(id))))
    })
    const offDraft = api.onDraft(({ messageId, text }) => setDrafts(prev => ({ ...prev, [messageId]: text })))
    api.snapshot().then(value => { if (alive && !received) setState(value) })
      .catch(failure => { if (alive) setLoadingError(errorText(failure)) })
    return () => { alive = false; offChange(); offDraft() }
  }, [])

  async function command(action, values) {
    setError('')
    try {
      await api.run(action, values)
      return true
    } catch (failure) {
      setError(errorText(failure))
      return false
    }
  }
  function openMenu(event, target) {
    event.preventDefault()
    const trigger = event.currentTarget
    const rect = trigger.getBoundingClientRect()
    const fromPointer = event.type === 'contextmenu' && (event.clientX || event.clientY)
    setMenu({ threadId: target.id, trigger,
      x: fromPointer ? event.clientX : rect.left, y: fromPointer ? event.clientY : rect.bottom + 4 })
  }
  function showMembers() {
    setRoster(true)
    requestAnimationFrame(() => {
      memberSection.current?.focus({ preventScroll: true })
      memberSection.current?.scrollIntoView({ block: 'start' })
    })
  }
  if (!state) return <div className="app-loading" role="status"><img src={appIcon} alt="" />{loadingError || '正在打开会话…'}</div>
  const thread = byId(state.threads, state.activeThreadId) || state.threads[0]
  const roles = thread ? thread.roleIds.map(id => byId(state.roles, id)).filter(Boolean) : []
  const dialogThread = byId(state.threads, dialog?.threadId) || thread
  const close = () => show(null)
  return <div className="app">
    <header className="titlebar">
      <button type="button" className="icon-button titlebar-nav" aria-label="切换会话导航" onClick={() => setSidebar(!sidebar)}><PanelLeft size={18} /></button>
      <div className="desktop-brand"><img src={appIcon} alt="" /><strong>{productName}</strong></div>
      <div className="titlebar-actions">
        <IconButton icon={Settings} label="运行时设置" onClick={() => show({ type: 'settings' })} />
      </div>
    </header>
    <div className={'workspace ' + (sidebar ? 'sidebar-open ' : '') + (roster === true ? 'roster-open ' : roster === false ? 'roster-hidden ' : '') + (page === 'roles' || !thread ? 'roles-page' : '')}>
      {sidebar && <button className="sidebar-scrim" aria-label="关闭会话导航" onClick={() => setSidebar(false)} />}
      <SideBar state={state} page={page} navigate={setPage} show={show} command={command} openMenu={openMenu} close={() => setSidebar(false)} />
      {page === 'roles' ? <RoleLibrary roles={state.roles} show={show} /> : thread ? <React.Fragment key={thread.id}>
        <Chat state={state} thread={thread} show={show} command={command} drafts={drafts} error={error}
          settingsOpen={settingsOpen} showMembers={showMembers} toggleRoster={() => setRoster(!settingsOpen)} />
        <SessionSettings thread={thread} roles={roles} runtimes={state.runtimes} defaultDirectory={state.defaultDirectory}
          memberSection={memberSection} show={show} close={() => setRoster(false)} />
      </React.Fragment> : <main className="empty-conversations"><MessageSquare size={27} /><h1>还没有会话</h1>
        <button className="primary-button" onClick={() => show({ type: 'room' })}><Plus size={16} />新建会话</button></main>}
    </div>
    {menu && <ThreadContextMenu menu={menu} close={closeMenu} choose={type => {
      show({ type, threadId: menu.threadId })
      closeMenu()
    }} />}
    {dialog?.type === 'role' && <RoleDialog role={dialog.role} close={close} />}
    {dialog?.type === 'settings' && <SettingsDialog settings={state.settings} runtimes={state.runtimes} close={close} />}
    {dialog?.type === 'renameThread' && dialogThread && <RenameThreadDialog thread={dialogThread} close={close} />}
    {dialog?.type === 'deleteThread' && dialogThread && <DeleteThreadDialog thread={dialogThread} close={close}
      hasReplies={state.threads.some(item => item.parentId === dialogThread.id)} />}
    {dialog?.type === 'threadRoles' && dialogThread && <ThreadMembersDialog thread={dialogThread} roles={state.roles} close={close} />}
    {dialog?.type === 'note' && dialogThread && <NoteDialog thread={dialogThread} file={dialog.file} close={close} />}
    {dialog?.type === 'deleteNote' && dialogThread && <DeleteNoteDialog thread={dialogThread} file={dialog.file} close={close} />}
    {dialog?.type === 'room' && <ThreadDialog roles={state.roles} defaultDirectory={state.defaultDirectory}
      close={close} onSaved={() => { close(); setPage('chat') }} />}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
