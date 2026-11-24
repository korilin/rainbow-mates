import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fileIcon } from './file-icon.jsx'
import { ContentMarkdown, ContentPanel, GeneratedMedia, contentKey, workspaceTabId } from './content.jsx'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, BookOpen, Check, ChevronRight,
  CircleAlert, ClipboardList, CodeXml, Copy, Download, Ellipsis, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Images, Lightbulb,
  MessageSquare, Monitor, Moon, PanelLeft, PanelRight, Paperclip, PencilLine, Plus, Puzzle, Reply,
  Send, Settings, Sparkles, Sun, Trash2, UserRound, UsersRound, X,
} from 'lucide-react'
import '@fontsource-variable/nunito'
import { productName } from '../package.json'
import { findMentions } from '../shared/mentions.mjs'
import { DEFAULT_THREAD_GROUP } from '../shared/thread-groups.mjs'
import { workspaceFileDrag } from '../shared/file-drop.mjs'
import { appTheme } from '../shared/theme.mjs'
import { mediaType, referenceImageURL } from '../shared/content-links.mjs'
import { inlineReferenceName, rebaseReferences, referenceLimit, referencesForSend, referenceTrigger } from '../shared/composer-references.mjs'
import './style.css'

const api = window.rainbow
const initialTheme = appTheme(new URLSearchParams(location.search).get('theme'))
document.documentElement.dataset.theme = initialTheme
const runtimeLabel = { codex: 'Codex', deepseek: 'DeepSeek' }
const roomIcons = { ideas: Lightbulb, code: CodeXml, reply: Reply }
const threadDragType = 'application/x-rainbow-thread-id'
const byActivity = (a, b) => b.activityAt - a.activityAt
const appIcon = './app-icon.png'
const art = (type, form = 'chibi') => './art/' + type + '-' + form + '.png'
const byId = (items, id) => items.find(item => item.id === id)
const roleStatus = { disconnected: '未连接', working: '任务中', replying: '回复中', idle: '空闲' }
const referenceIcons = { directory: Folder, skill: BookOpen, plugin: Puzzle }
const time = timestamp => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
const effortLabels = { none: '关闭', off: '关闭', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' }
const effortLabel = effort => effortLabels[effort] || effort
const modelLabel = (model, effort) => [model, effort && effortLabel(effort)].filter(Boolean).join(' · ')
const triggers = [
  { title: '让每个人打个招呼', text: '大家用自己的风格打个招呼，顺便说说你擅长什么。', icon: Sparkles },
  { title: '一起想个点子', text: '我们一起想一个适合周末做的小项目。大家可以贡献自己感兴趣的点子。', icon: Lightbulb },
  { title: '试试分工协作', text: '用一个具体例子演示产品和研发会怎样分工。请各自说说你会负责哪部分。', icon: UsersRound },
]

function UserAvatar({ user, size }) {
  const [failed, setFailed] = useState('')
  const src = user?.avatar === undefined && user?.avatarId
    ? 'rainbow-content://profile/' + encodeURIComponent(user.avatarId)
    : user?.avatar
  const [initial] = user?.name?.trim() || ''
  return <span className={'avatar avatar-user ' + size} aria-hidden="true">
    {src && src !== failed ? <img src={src} alt="" onError={() => setFailed(src)} /> : initial || <UserRound size={17} />}
  </span>
}

function Avatar({ role, user, size = '' }) {
  if (!role) return <UserAvatar user={user} size={size} />
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

function GroupNameDialog({ group, close }) {
  const [name, setName] = useState(group?.name || '')
  const { error, busy, save } = useSave(close)
  const title = group ? '重命名分组' : '新建分组'
  return <Dialog title={title} close={close}>
    <form className="stack" onSubmit={event => save(event, group ? 'renameThreadGroup' : 'createThreadGroup', { groupId: group?.id, name })}>
      <label>分组名<input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)} /></label>
      <FormFooter error={error} close={close} label={group ? '保存名称' : '创建分组'} busy={busy} />
    </form>
  </Dialog>
}

function DeleteGroupDialog({ group, close }) {
  const { error, busy, save } = useSave(close)
  return <Dialog title="移除分组" close={close}>
    <form className="stack" onSubmit={event => save(event, 'deleteThreadGroup', { groupId: group.id })}>
      <p className="dialog-note delete-note">移除「{group.name}」后，组内会话会移到默认分组。</p>
      <FormFooter error={error} close={close} label="移除分组" busy={busy} danger />
    </form>
  </Dialog>
}

function MoveThreadDialog({ thread, groups, close }) {
  const [groupId, setGroupId] = useState(groups.find(group => group.id !== thread.groupId)?.id || thread.groupId)
  const { error, busy, save } = useSave(close)
  return <Dialog title="移动到分组" close={close}>
    <form className="stack" onSubmit={event => save(event, 'moveThread', { threadId: thread.id, groupId })}>
      <label>目标分组<select value={groupId} onChange={event => setGroupId(event.target.value)}>
        {groups.filter(group => group.id !== thread.groupId).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>
      <FormFooter error={error} close={close} label="移动会话" busy={busy} />
    </form>
  </Dialog>
}

async function choosePath(kind, update, fail) {
  try {
    const path = await api.pick(kind)
    if (path) update(path)
  } catch (error) { fail(errorText(error)) }
}

function ComputerPermissions({ onError }) {
  const [permissions, setPermissions] = useState(null)
  useEffect(() => {
    let mounted = true
    const refresh = () => api.computerAccess()
      .then(value => { if (mounted) setPermissions(value) })
      .catch(error => { if (mounted) onError(errorText(error)) })
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { mounted = false; window.removeEventListener('focus', refresh) }
  }, [onError])
  const request = async kind => {
    try { setPermissions(await api.computerAccess(kind)) }
    catch (error) { onError(errorText(error)) }
  }
  return <div className="computer-permissions">
    <p className="dialog-note">成员执行任务时可以查看和操作此 Mac 的界面。界面文字和截图可能发送给成员所用的模型。</p>
    {permissions?.supported && <div className="computer-permission-actions">
      {permissions.accessibility ? <span>辅助功能已授权</span>
        : <button type="button" className="secondary-button" onClick={() => request('accessibility')}>授权辅助功能</button>}
      {permissions.screen ? <span>屏幕录制已授权</span>
        : <button type="button" className="secondary-button" onClick={() => request('screen')}>授权屏幕录制</button>}
    </div>}
    {permissions?.supported && (!permissions.accessibility || !permissions.screen) &&
      <p className="dialog-note">也可以在「系统设置 → 隐私与安全性」给 Rainbow Mates 授权。屏幕录制授权后可能需要重启应用。</p>}
  </div>
}

function ThreadFields({ data, update, defaultDirectory, computerAvailable, onError }) {
  return <>
    <label>会话名称<input required maxLength={60} value={data.name} onChange={event => update('name', event.target.value)} placeholder="比如：发布计划" /></label>
    <label>会话详情<textarea rows={3} maxLength={4000} value={data.description} onChange={event => update('description', event.target.value)}
      placeholder="描述会话用途和范围，供成员处理消息时参考。" /></label>
    <label>工作目录<span className="path-input"><input value={data.cwd} onChange={event => update('cwd', event.target.value)}
      placeholder="默认目录" title={data.cwd || defaultDirectory} />
      <IconButton icon={Folder} label="选择工作目录" onClick={() => choosePath('directory', value => update('cwd', value), onError)} /></span></label>
    <label className="check-label"><input type="checkbox" disabled={!data.cwd} checked={Boolean(data.cwd && data.writeAccess)} onChange={event => update('writeAccess', event.target.checked)} />允许写入工作目录</label>
    <label className="check-label"><input type="checkbox" checked={data.autoHandoff !== false} onChange={event => update('autoHandoff', event.target.checked)} />允许 Agent 直接交接</label>
    {computerAvailable && <>
      <label className="check-label"><input type="checkbox" checked={data.computerUse === true}
        onChange={event => update('computerUse', event.target.checked)} />允许 Computer Use</label>
      {data.computerUse && <ComputerPermissions onError={onError} />}
    </>}
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

function ThreadDialog({ roles, defaultDirectory, computerAvailable, close, onSaved }) {
  const [data, setData] = useState({ name: '', description: '', cwd: '', roleIds: roles.map(role => role.id), writeAccess: false, autoHandoff: true })
  const { error, busy, save, setError } = useSave(onSaved)
  const update = (name, value) => setData(prev => ({ ...prev, [name]: value }))
  return <Dialog title="新建会话" close={close}>
    <form className="stack" onSubmit={event => save(event, 'room', data)}>
      <ThreadFields data={data} update={update} defaultDirectory={defaultDirectory} computerAvailable={computerAvailable} onError={setError} />
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

function DeleteNoteDialog({ thread, file, close }) {
  const { error, busy, save } = useSave(close)
  return <Dialog title="删除笔记" close={close}>
    <form className="stack" onSubmit={event => save(event, 'deleteNote', { threadId: thread.id, file })}>
      <p className="dialog-note delete-note">将删除「{file}」。此操作无法撤销。</p>
      <FormFooter error={error} close={close} label="删除笔记" busy={busy} danger />
    </form>
  </Dialog>
}

function ProfileSettings({ profile }) {
  const [name, setName] = useState(profile?.name || '')
  const [avatar, setAvatar] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const hasAvatar = avatar === undefined ? Boolean(profile?.avatarId) : Boolean(avatar)
  const dirty = name.trim() !== (profile?.name || '') || avatar !== undefined

  function changeAvatar(image) {
    setAvatar(image)
    setSaved(false)
    setError('')
  }

  async function pickAvatar() {
    setBusy(true)
    setError('')
    try {
      const image = await api.pickAvatar()
      if (image) changeAvatar(image)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  async function saveProfile(event) {
    event.preventDefault()
    if (!dirty || busy) return
    setBusy(true)
    setError('')
    try {
      await api.saveProfile({ name, avatar })
      setName(name.trim())
      setAvatar(undefined)
      setSaved(true)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  return <form className="profile-settings" onSubmit={saveProfile}>
    <fieldset className="stack" disabled={busy}>
      <legend>个人资料</legend>
      <div className="profile-avatar-controls">
        <Avatar user={{ name, avatarId: profile?.avatarId, avatar }} size="profile-preview" />
        <button className="secondary-button" type="button" onClick={pickAvatar}>选择头像</button>
        {hasAvatar && <button className="secondary-button" type="button"
          onClick={() => changeAvatar(profile?.avatarId ? null : undefined)}>移除头像</button>}
      </div>
      <label>显示名<input value={name} maxLength={36} placeholder="你" onChange={event => {
        setName(event.target.value)
        setSaved(false)
        setError('')
      }} /></label>
      {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="profile-actions">
        <span className="dialog-note" role="status">{saved && '已保存'}</span>
        <button className="primary-button" type="submit" disabled={!dirty || busy}>保存个人资料</button>
      </div>
    </fieldset>
  </form>
}

function SettingsDialog({ settings, runtimes, close }) {
  const [data, setData] = useState(settings)
  const { error, busy, save, setError } = useSave(close)
  const theme = appTheme(settings.theme)
  const update = (name, value) => setData(prev => ({ ...prev, [name]: value }))
  function changeTheme(event) {
    setError('')
    void api.run('appearanceSettings', { theme: event.currentTarget.value }).catch(failure => setError(errorText(failure)))
  }
  return <Dialog title="设置" close={close}>
    <ProfileSettings profile={settings.profile} />
    <fieldset className="appearance-settings">
      <legend>主题</legend>
      <div className="theme-options">
        {[['light', '浅色', Sun], ['dark', '深色', Moon]].map(([id, label, Icon]) => <label key={id}>
          <input type="radio" name="theme" value={id} checked={theme === id} onChange={changeTheme} />
          <Icon size={16} aria-hidden="true" /><span>{label}</span>
          {theme === id && <Check size={14} className="theme-selected" aria-hidden="true" />}
        </label>)}
      </div>
    </fieldset>
    <form className="stack" onSubmit={event => save(event, 'runtimeSettings', data)}>
      <fieldset className="stack">
        <legend>运行时</legend>
        <p className="dialog-note">沿用 Codex 和 DSH 现有的登录。留空时自动查找已安装的客户端。</p>
        {runtimes.map(runtime => {
          const key = runtime.type + 'Path'
          return <label key={key}>{runtimeLabel[runtime.type]} 可执行文件<span className="path-input">
            <input value={data[key]} onChange={e => update(key, e.target.value)} placeholder={runtime.path || '未找到，请选择文件'} />
            <IconButton icon={Folder} label={'选择 ' + runtimeLabel[runtime.type] + ' 可执行文件'} onClick={() => choosePath('file', value => update(key, value), setError)} />
          </span></label>
        })}
      </fieldset>
      <FormFooter error={error} close={close} label="保存运行时设置" busy={busy} />
    </form>
  </Dialog>
}

function BranchLinks({ parentId, threads, selectedId, select, openMenu, depth = 1 }) {
  return threads.filter(thread => thread.parentId === parentId).sort(byActivity).map(thread =>
    <React.Fragment key={thread.id}>
      <button className={'room-link branch-link ' + (selectedId === thread.id ? 'current-branch' : '')}
        style={{ '--branch-indent': Math.min(depth, 4) * 10 + 'px' }} onClick={() => select(thread.id)} onContextMenu={event => openMenu(event, thread)}
        aria-current={selectedId === thread.id ? 'page' : undefined}><Reply size={14} /><span>{thread.name}</span></button>
      <BranchLinks parentId={thread.id} threads={threads} selectedId={selectedId} select={select} openMenu={openMenu} depth={depth + 1} />
    </React.Fragment>)
}

function SideBar({ state, page, navigate, show, close, command, sidebarAction, openMenu }) {
  const drag = useRef(null)
  const [dropGroup, setDropGroup] = useState(null)
  const room = byId(state.threads, state.activeThreadId)
  let root = room
  while (root?.parentId) root = byId(state.threads, root.parentId)
  const ready = state.runtimes.filter(item => item.available).length
  const select = id => {
    command('select', { threadId: id })
    navigate('chat')
    close()
  }
  const clearDrag = () => { drag.current = null; setDropGroup(null) }
  const droppable = (event, groupId) => drag.current && drag.current.groupId !== groupId && event.dataTransfer.types.includes(threadDragType)
  return <aside className="sidebar">
    <section className="sidebar-top">
      <div className="workspace-title">
        <img className="workspace-logo" src={appIcon} alt="" />
        <div><strong>{productName}</strong><small>v{state.appVersion}{!state.packaged && ' · 开发'}</small></div>
      </div>
      <div className="nav-switch" aria-label="工作区导航">
        <button aria-pressed={page === 'chat'} onClick={() => { navigate('chat'); close() }}><MessageSquare size={16} /> 会话</button>
        <button aria-pressed={page === 'roles'} onClick={() => { navigate('roles'); close() }}><UsersRound size={16} /> 角色</button>
      </div>
    </section>
    <div className="sidebar-scroll">
      <div className="side-heading"><span>我的会话</span><IconButton icon={FolderPlus} label="新建分组" onClick={() => { show({ type: 'newGroup' }); close() }} /></div>
      <nav aria-label="我的会话">
        {state.threadGroups.map(group => {
          const threads = state.threads.filter(thread => !thread.parentId && thread.groupId === group.id).sort(byActivity)
          const FolderIcon = group.collapsed ? Folder : FolderOpen
          const listId = 'group-threads-' + group.id
          return <section key={group.id} aria-label={group.name} className={'thread-group' + (dropGroup === group.id ? ' drop-target' : '')}
            onDragOver={event => {
              if (!droppable(event, group.id)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropGroup(group.id)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDropGroup(current => current === group.id ? null : current)
            }}
            onDrop={event => {
              if (!droppable(event, group.id)) return
              event.preventDefault()
              const threadId = event.dataTransfer.getData(threadDragType)
              if (threadId === drag.current.id) void sidebarAction(() => api.run('moveThread', { threadId, groupId: group.id }))
              clearDrag()
            }}>
            <div className="thread-group-header" onContextMenu={group.id === DEFAULT_THREAD_GROUP ? undefined : event => openMenu(event, group, 'group')}>
              <button className="thread-group-toggle" type="button" aria-expanded={!group.collapsed} aria-controls={listId}
                onClick={() => sidebarAction(() => api.run('collapseThreadGroup', { groupId: group.id, collapsed: !group.collapsed }))}>
                <FolderIcon className="folder-icon" size={16} aria-hidden="true" /><span>{group.name}</span><ChevronRight className="group-chevron" size={13} aria-hidden="true" />
              </button>
              {group.id !== DEFAULT_THREAD_GROUP && <IconButton className="thread-group-menu" icon={Ellipsis} label={'管理分组 ' + group.name}
                aria-haspopup="menu" onClick={event => openMenu(event, group, 'group')} />}
            </div>
            <div className="thread-group-list" id={listId} hidden={Boolean(group.collapsed)}>
              {!threads.length && <div className="thread-group-empty">暂无会话</div>}
              {threads.map(thread => {
                const selected = page === 'chat' && root?.id === thread.id
                return <div key={thread.id}>
                  <button className={'room-link ' + (selected ? 'selected' : '')} onClick={() => select(thread.id)} onContextMenu={event => openMenu(event, thread)}
                    aria-current={page === 'chat' && room?.id === thread.id ? 'page' : undefined}
                    draggable onDragStart={event => {
                      drag.current = { id: thread.id, groupId: group.id }
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData(threadDragType, thread.id)
                    }} onDragEnd={clearDrag}>
                    <span>{thread.name}</span>{selected && <span className="nav-dot" />}
                  </button>
                  {selected && <BranchLinks parentId={thread.id} threads={state.threads} selectedId={room.id} select={select} openMenu={openMenu} />}
                </div>
              })}
            </div>
          </section>
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

function SidebarContextMenu({ menu, close, choose, canMove }) {
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
  const group = menu.kind === 'group'
  return <div className="pop-menu thread-menu" role="menu" aria-label={group ? '分组操作' : '会话操作'} ref={ref} onKeyDown={event => {
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
    <button type="button" role="menuitem" onClick={() => choose(group ? 'renameGroup' : 'renameThread')}><PencilLine size={15} />重命名</button>
    {!group && <>
      <button type="button" role="menuitem" onClick={() => choose('sessionSettings')}><Settings size={15} />会话设置</button>
      {canMove && <button type="button" role="menuitem" onClick={() => choose('moveThread')}><FolderInput size={15} />移动到分组</button>}
      <button type="button" role="menuitem" className="thread-id-item" aria-label="复制会话 ID" title={menu.id}
        onClick={() => choose('copyThreadId')}><Copy size={15} /><span>复制会话 ID</span><code>{menu.id}</code></button>
      <button type="button" role="menuitem" onClick={() => choose('exportThread')}><Download size={15} />导出会话</button>
    </>}
    <button type="button" role="menuitem" className="delete-action" onClick={() => choose(group ? 'deleteGroup' : 'deleteThread')}>
      <Trash2 size={15} />{group ? '移除分组' : '删除'}</button>
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

function remarkMentions(roles, inline = []) {
  return () => root => {
    const visit = node => {
      if (!node.children) return
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') { visit(child); return [child] }
        const offset = child.position?.start.offset
        const spans = inline.map(span => ({ ...span, start: span.start - offset, end: span.end - offset }))
          .filter(span => span.start >= 0 && span.end <= child.value.length && child.value[span.start] === span.symbol)
        const mentions = [...findMentions(child.value, roles)
          .filter(mention => !spans.some(span => mention.start < span.end && mention.end > span.start)), ...spans]
          .sort((a, b) => a.start - b.start)
        if (!mentions.length) return [child]
        const output = []
        let cursor = 0
        for (const { start, end, kind, id } of mentions) {
          if (cursor < start) output.push({ type: 'text', value: child.value.slice(cursor, start) })
          const properties = { className: ['mention-copy'] }
          if (kind === 'conversation') properties['data-conversation'] = id.slice('conversation:'.length)
          output.push({ type: 'mention', data: { hName: 'mark', hProperties: properties },
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

function QuoteContent({ message, roles, user }) {
  const name = message.author ? byId(roles, message.author.id)?.name || message.author.name : user?.name || '你'
  return <span className="quote-content"><strong>{name}</strong><span>{message.text.replace(/\s+/g, ' ').slice(0, 180)}</span></span>
}

function Message({ message, draft, thread, roles, user, onReply, onInvite, onView, onConversation }) {
  const [show, toggle] = useState(false)
  const { author, status } = message
  const working = status === 'running' || status === 'queued'
  const error = status === 'error' || status === 'stopped'
  const currentRole = author && byId(roles, author.id)
  const displayRole = currentRole || author
  const currentModel = currentRole?.modelInfo
  const canAct = !working && !error
  const receivers = (message.targetIds || []).map(id => byId(roles, id)?.name).filter(Boolean)
  const assignable = thread.roleIds.filter(id => id !== author?.id).map(id => byId(roles, id)).filter(Boolean)
  const handoff = byId(roles, message.handoffTo)
  const associatedTaskId = message.taskId || message.taskThreadId || (!message.handoffFrom && message.relatedTaskId)
  const task = author && canAct && associatedTaskId && byId(thread.tasks || [], associatedTaskId)
  const taskThread = task && thread.messages.some(run => run.taskId === task.id && run.author?.id === author.id) ? task : null
  const quoted = message.replyToId && byId(thread.messages, message.replyToId)
  const attachedReferences = (message.references || []).filter(item => !message.inlineReferences?.some(span => span.id === item.id))
  return <article id={'message-' + message.id} className={'message ' + (author?.type || 'human') + (error ? ' message-error' : '')}>
    <Avatar role={displayRole} user={user} />
    <div className="message-body">
      <div className="message-meta"><strong>{displayRole ? displayRole.name : user?.name || '你'}</strong>
        {currentRole ? <ModelBadge type={currentRole.type} model={currentModel?.id || '待选择模型'} name={currentModel?.label}
          effort={currentModel?.effort} runLabel={modelLabel(message.model, message.effort)} />
          : author && <ModelBadge type={author.type} model={message.model} name={message.modelName} effort={message.effort} />}
        <time dateTime={new Date(message.at).toISOString()}>{time(message.at)}</time>
      </div>
      <div className="bubble">
        {quoted && <button type="button" className="message-quote" onClick={() => {
          document.getElementById('message-' + quoted.id)?.scrollIntoView({ block: 'center' })
        }}><QuoteContent message={quoted} roles={roles} user={user} /></button>}
        {working && !draft ? <span className="working"><span className="typing"><i /><i /><i /></span>{status === 'queued' ? '等待接话' : '正在回复'}</span>
          : error ? <span className="message-failure"><CircleAlert size={16} />{message.error}</span>
          : <ContentMarkdown text={message.text || draft || ''} artifacts={message.artifacts} threadId={thread.id} messageId={message.id}
            mentionPlugin={remarkMentions(roles, message.inlineReferences)} onView={onView} onConversation={onConversation} />}
        <GeneratedMedia threadId={thread.id} messageId={message.id} artifacts={message.artifacts || []} onView={onView} />
        {attachedReferences.length > 0 && <ReferenceList items={attachedReferences} />}
      </div>
      {canAct && <div className="message-actions" role="group" aria-label="消息操作">
        <IconButton icon={Reply} label="回复此消息" onClick={onReply} />
        {assignable.length > 0 && <div className="invite-wrap" onKeyDown={event => {
          if (event.key === 'Escape' && show) {
            toggle(false)
            event.currentTarget.querySelector('button')?.focus()
          }
        }}>
          <IconButton icon={Send} label="指定成员接手" onClick={() => toggle(!show)} aria-expanded={show} />
          {show && <><button className="menu-dismiss" aria-label="关闭交接菜单" onClick={() => toggle(false)} />
            <div className="pop-menu invite-menu"><span>交接给</span>{assignable.map(role =>
              <button key={role.id} onClick={() => { toggle(false); onInvite(role.id) }}><Avatar role={role} size="tiny" />{role.name}</button>)}</div></>}
        </div>}
        {taskThread && <IconButton icon={ClipboardList} className="task-thread-button" label="查看任务线程" onClick={() => onView({
          kind: 'task', taskId: taskThread.id, memberId: author.id, name: taskThread.title,
        })} />}
      </div>}
      {receivers.length > 0 && <div className="delivery-receipt"><AtSign size={12} />{receivers.join('、')}</div>}
      {message.handoffFrom && <div className="delivery-receipt"><Reply size={12} />接手来自 {message.handoffFrom} 的消息</div>}
      {handoff && <div className="delivery-receipt"><Send size={12} />交接给 {handoff.name}</div>}
      {message.taskError && <div className="delivery-receipt note-error"><CircleAlert size={12} />{message.taskError}</div>}
      {message.noteError && <div className="delivery-receipt note-error"><CircleAlert size={12} />{message.noteError}</div>}
    </div>
  </article>
}

function ReferenceList({ items }) {
  return <ul className="reference-list" aria-label="引用">
    {items.map(item => {
      const Icon = referenceIcons[item.kind] || fileIcon(item.path || item.name)
      return <li key={item.id} title={item.path || item.key}>
        <Icon size={13} aria-hidden="true" /><span>{item.name}</span>
        {item.runtime && <small>{runtimeLabel[item.runtime]}</small>}
      </li>
    })}
  </ul>
}

function ComposerReferenceCard({ threadId, item, remove }) {
  const [brokenImage, setBrokenImage] = useState(false)
  const filename = item.path || item.name
  const mime = mediaType(filename)
  const image = item.kind === 'file' && mime.startsWith('image/')
  const extension = /\.([a-z0-9]{1,12})$/iu.exec(filename)?.[1].toUpperCase()
  const kind = image ? '图片' : mime.startsWith('video/') ? '视频' : mime.startsWith('audio/') ? '音频' : '文件'
  const type = item.kind === 'file' ? [extension, kind].filter(Boolean).join(' ') : item.kind === 'directory' ? '目录'
    : [item.kind === 'skill' ? 'Skill' : 'Plugin', runtimeLabel[item.runtime]].filter(Boolean).join(' · ')
  const Icon = referenceIcons[item.kind] || fileIcon(filename, mime)
  return <li className="composer-attachment" title={filename}>
    <div className="attachment-preview" aria-hidden="true">
      {image && !brokenImage
        ? <img src={referenceImageURL(threadId, item.id)} alt="" decoding="async" onError={() => setBrokenImage(true)} />
        : <Icon size={22} />}
    </div>
    <div className="attachment-description"><strong>{item.name}</strong><small>{type}</small></div>
    <IconButton icon={X} className="attachment-remove" label={'移除引用 ' + item.name} onClick={() => remove(item.id)} />
  </li>
}

const referenceOptions = [
  { id: 'choose-file', kind: 'file', pick: true, name: '选择文件…' },
  { id: 'choose-directory', kind: 'directory', pick: true, name: '选择目录…' },
]

function composerReferenceGroups(mode, query, roles, threads, activeThread, workspace, catalogs) {
  const term = query.trim().toLocaleLowerCase()
  const matches = (...fields) => !term || fields.some(field => field?.toLocaleLowerCase().includes(term))
  const skills = catalogs.skill?.items || []
  const plugins = catalogs.plugin?.items || []
  const toolsOnly = mode === '$' || mode === '/'
  const ownership = toolsOnly ? new Map(plugins.map(item => [item.runtime + ':' + item.key, item])) : new Map()
  const owningPlugin = item => ownership.get(item.runtime + ':' + item.pluginKey)
  const matchesTool = item => matches(item.name, item.skillName, item.description, item.key)
  const standalone = skills.filter(item => !owningPlugin(item) && matchesTool(item))
  const pluginItems = plugins.flatMap(plugin => {
    const ownMatch = matchesTool(plugin)
    if (!toolsOnly) return ownMatch ? [plugin] : []
    const children = skills.filter(skill => owningPlugin(skill) === plugin && (ownMatch || matchesTool(skill)))
    return [...(ownMatch ? [plugin] : []), ...children.map(skill => ({ ...skill, pluginName: plugin.name }))]
  })
  const toolGroups = [{ label: 'Skill', items: standalone }, { label: 'Plugin', items: pluginItems }]
  if (toolsOnly) return toolGroups
  const workspaceSearch = mode === '@' ? term.split('/').at(-1) : null
  const files = workspaceSearch === null ? [] : (workspace || []).filter(item => item.name.toLocaleLowerCase().includes(workspaceSearch))
    .slice(0, 20).map(item => ({
      id: 'workspace:' + item.path, kind: item.directory ? 'directory' : 'file', name: item.name, path: item.path, workspace: true,
    }))
  const paths = { label: '文件和目录', items: [
    ...files, ...referenceOptions.filter(item => matches(item.name, item.kind, item.kind === 'directory' ? '文件夹' : '文件')),
  ] }
  if (mode !== '@') return [paths, ...toolGroups]
  const members = roles.filter(role => matches(role.name, role.label)).map(role => ({ ...role, kind: 'member' }))
  const conversations = threads.filter(thread => thread.id !== activeThread && matches(thread.name))
    .sort(byActivity).map(thread => ({ id: 'conversation:' + thread.id, name: thread.name, description: thread.description, kind: 'conversation' }))
  return [{ label: '成员', items: members }, { label: '其他会话', items: conversations }, ...toolGroups, paths]
}

function ReferencePicker({ groups, active, id, query, onQuery, onChoose, onClose, onKeyDown, catalogs }) {
  const element = useRef(null)
  useEffect(() => {
    const closeOutside = event => {
      if (!element.current?.contains(event.target) && !event.target.closest('.composer textarea, .reference-toggle')) onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [onClose])
  useEffect(() => {
    element.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const loading = !catalogs.skill || !catalogs.plugin
  const error = catalogs.skill?.error || catalogs.plugin?.error
  const empty = groups.every(group => group.items.length === 0)
  return <div className="pop-menu reference-picker" ref={element} aria-label="插入引用">
    {onQuery && <input aria-label="搜索引用" placeholder="搜索引用" value={query}
      onChange={event => onQuery(event.target.value)} onKeyDown={event => {
        if (!onKeyDown(event) && event.key === 'Enter') event.preventDefault()
      }} />}
    <div className="reference-results" id={id} role="listbox" aria-label="可选引用">
      {groups.filter(group => group.items.length).map(({ label, items }) => <div key={label} role="group" aria-label={label} className="reference-group">
        <span aria-hidden="true" className="reference-group-heading">{label}</span>
        {items.map(item => {
          const Icon = referenceIcons[item.kind] || (item.kind === 'conversation' ? MessageSquare : fileIcon(item.path || item.name))
          const detail = item.pluginName || item.description
          return <button type="button" role="option" tabIndex={-1} key={item.id} id={id + '-' + item.id}
            aria-selected={item.id === active} className={item.pluginName ? 'plugin-skill-option' : undefined}
            title={item.path || item.key || detail} onMouseDown={event => event.preventDefault()} onClick={() => onChoose(item)}>
            {item.kind === 'member' ? <Avatar role={item} size="tiny" /> : <Icon size={15} aria-hidden="true" />}
            <span className="reference-result-name"><strong>{item.name}</strong>{detail && <small>{detail}</small>}</span>
            {item.kind === 'member' ? <RoleModelBadge role={item} /> : item.runtime && <span className="reference-runtime">{runtimeLabel[item.runtime]}</span>}
          </button>
        })}
      </div>)}
    </div>
    {loading && <div role="status" className="reference-picker-note">正在读取 Skill 和 Plugin…</div>}
    {error && <div role="status" className="reference-picker-note">{error}</div>}
    {!loading && !error && empty && <div className="reference-picker-note">没有匹配的引用</div>}
  </div>
}

function Composer({ thread, roles, threads, user, fill, error, command, task, clearTask, quote, clearQuote, attachment, onAttachmentHandled }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(null)
  const [inlineReferences, setInlineReferences] = useState([])
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState([])
  const attached = useRef([])
  const [referenceMenu, setReferenceMenu] = useState(false)
  const [referenceError, setReferenceError] = useState('')
  const ref = useRef()
  const [catalogs, setCatalogs] = useState({})
  const catalogRequests = useRef(null)
  const [workspace, setWorkspace] = useState(null)
  const [manualQuery, setManualQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const listId = useId()
  const candidate = referenceTrigger(text, caret)
  const trigger = candidate && !(dismissed?.start === candidate.start && dismissed.symbol === candidate.symbol)
    && !inlineReferences.some(span => span.start <= candidate.start && candidate.start < span.end) ? candidate : null
  const mode = referenceMenu ? 'manual' : trigger?.symbol
  const query = referenceMenu ? manualQuery : trigger?.query || ''
  const workspaceDirectory = mode === '@' && query.includes('/') ? query.trim().slice(0, query.trim().lastIndexOf('/')) : ''
  const groups = mode ? composerReferenceGroups(mode, query, roles, threads, thread.id,
    workspace?.path === workspaceDirectory ? workspace.entries : [], catalogs) : []
  const options = groups.flatMap(group => group.items)
  const selected = options.find(item => item.id === selectedId) || options[0]
  const pickerOpen = Boolean(mode)
  const catalogScope = thread.cwd + '|' + thread.roleIds.join(',')
  useEffect(() => {
    if (!pickerOpen) return
    let live = true
    const kinds = ['skill', 'plugin']
    if (catalogRequests.current?.scope !== catalogScope || Date.now() - catalogRequests.current.startedAt > 30_000) {
      catalogRequests.current = { scope: catalogScope, startedAt: Date.now(), requests: Object.fromEntries(kinds.map(kind => [
        kind, api.referenceList(thread.id, kind).then(items => ({ items })).catch(failure => ({ error: errorText(failure) })),
      ])) }
      setCatalogs({})
    }
    for (const kind of kinds) void catalogRequests.current.requests[kind].then(result => {
      if (live) setCatalogs(previous => ({ ...previous, [kind]: result }))
    })
    return () => { live = false }
  }, [pickerOpen, thread.id, catalogScope])
  useEffect(() => {
    if (mode !== '@') return
    let live = true
    api.workspaceEntries(thread.id, workspaceDirectory).then(({ entries }) => {
      if (live) setWorkspace({ path: workspaceDirectory, entries })
    }).catch(() => { if (live) setWorkspace({ path: workspaceDirectory, entries: [] }) })
    return () => { live = false }
  }, [mode, thread.id, thread.cwd, workspaceDirectory])
  const fillText = fill?.text
  useEffect(() => {
    if (fillText) { setText(fillText); setInlineReferences([]); setDismissed(null); setCaret(fillText.length); ref.current?.focus() }
  }, [fill])
  useEffect(() => { if (task?.id) ref.current?.focus() }, [task?.id])
  useEffect(() => { if (quote?.id) ref.current?.focus() }, [quote?.id])
  useLayoutEffect(() => {
    const editor = ref.current
    editor.style.height = '0px'
    editor.style.height = Math.max(42, Math.min(editor.scrollHeight, 142)) + 'px'
  }, [text])

  function closeReferences() {
    setReferenceMenu(false)
    setSelectedId('')
    if (candidate) setDismissed({ start: candidate.start, symbol: candidate.symbol })
  }

  function updateDraft(next, position) {
    setInlineReferences(spans => rebaseReferences(text, next, spans))
    if (dismissed && text.slice(0, dismissed.start + 1) !== next.slice(0, dismissed.start + 1)) setDismissed(null)
    setSelectedId('')
    setText(next)
    setCaret(position)
  }

  function replaceDraft(value, range, item, symbol) {
    const editor = ref.current
    if (!editor) return
    const current = editor.value
    if (range && current.slice(range.start, range.end) !== range.symbol + range.query) range = null
    const start = range?.start ?? editor.selectionStart
    const end = range?.end ?? editor.selectionEnd
    const before = current.slice(0, start)
    const padding = value && before && !/\s$/u.test(before) && !range ? ' ' : ''
    const next = before + padding + value + current.slice(end)
    if (next.length > editor.maxLength) return
    const position = start + padding.length + value.length
    setInlineReferences(spans => {
      const updated = rebaseReferences(current, next, spans)
      return item ? [...updated, { kind: item.kind, id: item.id, symbol, start: start + padding.length, end: position - 1 }]
        .sort((a, b) => a.start - b.start) : updated
    })
    setText(next)
    setCaret(position)
    closeReferences()
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(position, position) })
  }

  function setAttached(items) {
    attached.current = items
    setReferences(items)
  }

  function attach(items, range) {
    if (!items.length) return
    const combined = [...new Map([...attached.current, ...items].map(item => [item.id, item])).values()]
    if (new Set([...combined.map(item => item.id), ...inlineReferences.map(item => item.id)]).size > referenceLimit) {
      setReferenceError('每条消息最多引用 8 项。')
      return
    }
    setAttached(combined)
    setReferenceError('')
    if (range) replaceDraft('', range)
    else { closeReferences(); requestAnimationFrame(() => ref.current?.focus()) }
  }

  async function chooseReference(item) {
    const range = trigger
    try {
      if (item.pick) { attach(await api.referenceFiles(thread.id, item.kind), range); return }
      if (item.workspace) { attach(await api.workspaceReference(thread.id, item.path), range); return }
      if (item.kind === 'member') {
        replaceDraft('@' + item.name + ' ', range)
        return
      }
      if (new Set([...attached.current.map(ref => ref.id), ...inlineReferences.map(ref => ref.id), item.id]).size > referenceLimit
        || inlineReferences.length >= referenceLimit) {
        setReferenceError('每条消息最多引用 8 项。')
        return
      }
      const symbol = item.kind === 'conversation' ? '@' : range?.symbol || '$'
      setReferenceError('')
      replaceDraft(symbol + inlineReferenceName(item.name) + ' ', range, item, symbol)
    } catch (failure) {
      setReferenceError(errorText(failure))
    }
  }

  function onPickerKeyDown(event) {
    if (!pickerOpen || event.nativeEvent.isComposing || event.keyCode === 229) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      closeReferences()
      return true
    }
    if (selected && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const from = options.indexOf(selected)
      const next = (from + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      setSelectedId(options[next].id)
      return true
    }
    if (selected && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void chooseReference(selected)
      return true
    }
    return false
  }

  async function attachFiles({ path, paths }) {
    try {
      const items = path ? await api.workspaceReference(thread.id, path) : await api.importFiles(thread.id, paths)
      if (ref.current) attach(items)
    } catch (failure) {
      if (ref.current) setReferenceError(errorText(failure))
    }
  }

  useEffect(() => {
    if (!attachment) return
    onAttachmentHandled(attachment)
    void attachFiles(attachment)
  }, [attachment])

  function pasteFiles(event) {
    const paths = [...event.clipboardData.files].map(file => api.filePath(file)).filter(Boolean)
    const clipboard = [...new Set([...paths, ...(api.clipboardFiles() || [])])]
    if (!clipboard?.length) return
    event.preventDefault()
    void attachFiles({ paths: clipboard })
  }

  async function send(event) {
    event?.preventDefault()
    if (sending || !text.trim()) return
    setSending(true)
    try {
      const draft = referencesForSend(text, inlineReferences)
      if (await command('send', { threadId: thread.id, taskId: task?.id, replyToId: quote?.id, ...draft,
        ...(references.length ? { referenceIds: references.map(item => item.id) } : {}) })) {
        setText('')
        setCaret(0)
        setDismissed(null)
        setInlineReferences([])
        setAttached([])
        setReferenceMenu(false)
        setReferenceError('')
        if (quote) clearQuote(quote.id)
        ref.current?.focus()
      }
    } finally { setSending(false) }
  }
  return <div className="composer-area">
    {(error || referenceError) && <div role="alert" className="composer-error"><CircleAlert size={15} />{error || referenceError}</div>}
    <form className="composer" onSubmit={send}>
      {task && <div className="composer-task"><span>追问「{task.title}」</span><IconButton icon={X} label="退出任务追问" onClick={clearTask} /></div>}
      {quote && <div className="composer-quote"><QuoteContent message={quote} roles={roles} user={user} />
        <IconButton icon={X} label="取消引用" onClick={() => clearQuote(quote.id)} /></div>}
      {references.length > 0 && <ul className="composer-attachments" aria-label="待发送引用">
        {references.map(item => <ComposerReferenceCard key={item.id} threadId={thread.id} item={item} remove={id => {
          setAttached(attached.current.filter(item => item.id !== id))
          setReferenceError('')
        }} />)}
      </ul>}
      {pickerOpen && <ReferencePicker groups={groups} id={listId} active={selected?.id} catalogs={catalogs} query={manualQuery}
        onQuery={referenceMenu ? value => { setManualQuery(value); setSelectedId('') } : undefined}
        onClose={closeReferences} onChoose={chooseReference} onKeyDown={onPickerKeyDown} />}
      <textarea aria-label="消息" ref={ref} rows={1} maxLength={24000} value={text}
        placeholder={task && !task.roleId ? '用 @ 指定接手成员，再补充要求…' : '说点什么，或用 @、$、/ 插入引用…'}
        aria-expanded={pickerOpen} aria-controls={pickerOpen ? listId : undefined}
        aria-activedescendant={selected ? listId + '-' + selected.id : undefined}
        onChange={event => updateDraft(event.target.value, event.target.selectionStart)}
        onSelect={event => setCaret(event.target.selectionStart)} onPaste={pasteFiles}
        onKeyDown={event => {
          if (onPickerKeyDown(event)) return
          if (event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey) && !event.altKey) {
            const paths = api.clipboardFiles()
            if (paths?.length) { event.preventDefault(); void attachFiles({ paths }); return }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            if (!referenceMenu) void send()
          }
        }} />
      <div className="composer-tools">
        <div className="targets">
          <IconButton icon={Paperclip} className="reference-toggle" label="插入引用" aria-expanded={referenceMenu} onClick={() => {
            if (referenceMenu) { closeReferences(); return }
            closeReferences()
            setManualQuery('')
            setReferenceMenu(true)
            ref.current?.focus()
          }} />
          <IconButton icon={AtSign} label="插入 @ 引用" onClick={() => {
            const editor = ref.current
            const start = editor.selectionStart
            const before = text.slice(0, start)
            const prefix = before && !/\s$/u.test(before) ? ' @' : '@'
            const next = before + prefix + text.slice(editor.selectionEnd)
            const position = start + prefix.length
            updateDraft(next, position)
            setDismissed(null)
            setReferenceMenu(false)
            requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(position, position) })
          }} />
        </div>
        <div className="targets">
          <button className="send-button" type="submit" aria-label="发送消息" title="发送消息 (Enter)" disabled={!text.trim() || sending}><ArrowUp size={19} /></button>
        </div>
      </div>
    </form>
    <div className="composer-foot">Enter 发送 <span className="separator">·</span> Shift + Enter 换行</div>
  </div>
}

function SessionSettings({ thread, defaultDirectory, computerAvailable, close }) {
  const [fields, setFields] = useState({})
  const { error, busy, save, setError } = useSave(close)
  const data = { ...thread, ...fields }
  const update = (name, value) => setFields(previous => ({ ...previous, [name]: value }))
  return <Dialog title="会话设置" close={close}>
    <form className="stack" onSubmit={event => save(event, 'threadSettings', { threadId: thread.id, ...fields })}>
      <ThreadFields data={data} update={update} defaultDirectory={defaultDirectory} computerAvailable={computerAvailable} onError={setError} />
      <FormFooter error={error} close={close} label="保存设置" busy={busy || thread.busy} />
    </form>
  </Dialog>
}

function MembersPanel({ thread, roles, show, onView, open }) {
  return <div className="members-shell" inert={!open}>
    <aside id="members-panel" className="members-panel" aria-label="会话成员">
      <button type="button" className="secondary-button add-member" onClick={() => show({ type: 'threadRoles', threadId: thread.id })}>
        <Plus size={15} />添加成员
      </button>
      <div className="settings-characters">
        {roles.map(role => {
          const model = role.modelInfo
          const configured = model && !model.unavailable && !model.needsEffort
          return <div className="member-tile" key={role.id}>
            <button className={'character-card ' + role.type}
              onClick={() => onView({ kind: 'member', memberId: role.id, name: role.name })} aria-label={'查看 ' + role.name + ' 的任务'}>
              <div className="card-halo" aria-hidden="true" />
              <div className="character-info"><RuntimeBadge role={role} /><strong>{role.name}</strong><span>{role.label}</span>
                <span className="character-model" title={model?.id}>{model?.unavailable ? '所选模型不可用' : model?.label || '待选择模型'}</span>
                {model?.needsEffort && <span className="character-effort">待选择推理强度</span>}
                {configured && model.effort && <span className="character-effort">推理强度 {effortLabel(model.effort)}</span>}
                <RoleStatus role={role} />
              </div>
              <img src={art(role.type, role.form)} className={role.form} alt="" />
            </button>
            <IconButton className="member-edit" icon={PencilLine} label={'编辑 ' + role.name} onClick={() => show({ type: 'role', role })} />
          </div>
        })}
        {!roles.length && <p className="settings-empty">暂无成员</p>}
      </div>
    </aside>
  </div>
}

function RoleStatus({ role }) {
  const dot = role.status === 'working' || role.status === 'replying' ? 'working-dot' : role.status === 'idle' ? 'green-dot' : 'muted-dot'
  return <small className="role-status"><i className={dot} />{roleStatus[role.status]}</small>
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
        </div><span>{role.label}</span><RoleStatus role={role} />
          {role.personality && <p>{role.personality}</p>}</div>
      </button>)}
    </div>
  </main>
}

function Chat({ state, thread, command, drafts, error, membersOpen, contentOpen, toggleMembers, toggleContent, onView,
  attachment, onAttachmentHandled, onAttach, taskId, onTask }) {
  const [fill, setFill] = useState(null)
  const [replyToId, setReplyToId] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const list = useRef(null)
  const stick = useRef(true)
  const memberCountId = useId()
  useEffect(() => { if (taskId) setReplyToId(null) }, [taskId])
  const messages = thread.messages.filter(message => !message.taskId || message.status === 'done' || !message.author)
  const roles = thread.roleIds.map(id => byId(state.roles, id)).filter(Boolean)
  const user = state.settings.profile
  const HeadingIcon = roomIcons[thread.kind]
  const parent = byId(state.threads, thread.parentId)
  const anchor = parent?.messages.find(message => message.id === thread.anchorMessageId)
  const anchorName = anchor && !anchor.author ? user?.name || '你' : byId(state.roles, anchor?.author?.id)?.name || thread.anchor?.name
  const moveToBottom = () => {
    if (!list.current) return
    list.current.scrollTop = list.current.scrollHeight
    stick.current = true
    setAtBottom(true)
  }
  useLayoutEffect(() => { if (stick.current) moveToBottom() }, [thread.messages, drafts])
  const fileDrag = event => event.dataTransfer.types.some(type => type === workspaceFileDrag || type === 'Files')
  const dropFiles = event => {
    if (!fileDrag(event)) return
    event.preventDefault()
    const path = event.dataTransfer.getData(workspaceFileDrag)
    const paths = [...event.dataTransfer.files].map(file => api.filePath(file)).filter(Boolean)
    if (path || paths.length) onAttach({ path, paths })
  }
  return <main className="chat" onDragOver={event => {
    if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
  }} onDrop={dropFiles}>
    <header className="chat-header">
      {parent
        ? <IconButton icon={ArrowLeft} label={'返回 ' + parent.name} onClick={() => command('select', { threadId: parent.id })} />
        : HeadingIcon && <div className="room-icon"><HeadingIcon size={21} /></div>}
      <div className="chat-title">
        <h1>{thread.name}</h1>
        <button type="button" className="avatar-group" aria-label="查看会话成员" aria-describedby={memberCountId}
          aria-expanded={membersOpen} onClick={toggleMembers} aria-controls="members-panel">
          <span className="avatar-stack" aria-hidden="true">
            {roles.slice(0, 5).map(role => <Avatar key={role.id} role={role} size="tiny" />)}
            {!roles.length && <UsersRound size={15} />}
          </span>
          <span className="member-count" id={memberCountId}>{roles.length} 位成员</span>
        </button>
      </div>
      <div className="chat-header-tools">
        <IconButton icon={PanelRight} label={contentOpen ? '收起内容详情' : '展开内容详情'} onClick={toggleContent}
          aria-expanded={contentOpen} aria-controls="content-panel" />
      </div>
    </header>
    <div className="conversation" ref={list} onScroll={e => {
      const target = e.currentTarget
      stick.current = target.scrollHeight - target.clientHeight - target.scrollTop < 100
      setAtBottom(stick.current)
    }}>
      {thread.anchor && <div className="thread-anchor"><Reply size={17} /><div><strong>{anchorName}</strong><p>{thread.anchor.text}</p></div></div>}
      {messages.length === 0 && <Hero thread={thread} roles={roles} onPrompt={text => setFill({ text })} />}
      {messages.length > 0 && <section className="message-list" aria-label="会话记录">
        {messages.map(message => <Message key={message.id} message={message} draft={drafts[message.id]} thread={thread} roles={state.roles} user={user} onView={onView}
          onConversation={id => command('select', { threadId: id })}
          onReply={() => { onTask(null); setReplyToId(message.id) }}
          onInvite={roleId => command('inviteReply', { threadId: thread.id, messageId: message.id, roleId })} />)}
      </section>}
    </div>
    {!atBottom && <button type="button" className="jump-latest" onClick={moveToBottom}><ArrowDown size={15} />回到最新</button>}
    <Composer thread={thread} roles={roles} threads={state.threads} user={user} fill={fill} error={error} command={command} attachment={attachment} onAttachmentHandled={onAttachmentHandled}
      task={byId(thread.tasks || [], taskId)} clearTask={() => onTask(null)}
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
  const [activity, setActivity] = useState({})
  const [page, setPage] = useState('chat')
  const [dialog, show] = useState(null)
  const [menu, setMenu] = useState(null)
  const [sidebarFeedback, setSidebarFeedback] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const theme = state ? appTheme(state.settings.theme) : initialTheme
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const [sidebar, setSidebar] = useState(false)
  const [members, setMembers] = useState(null)
  const [panels, setPanels] = useState({})
  const [followUp, setFollowUp] = useState(null)
  const [contentWidth, setContentWidth] = useState(() => Number(localStorage.getItem('rainbow.contentWidth')) || null)
  useEffect(() => {
    if (contentWidth) localStorage.setItem('rainbow.contentWidth', String(contentWidth))
  }, [contentWidth])
  const [attachment, setAttachment] = useState(null)
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1051px)').matches)
  const membersOpen = members ?? wide
  useEffect(() => {
    const query = matchMedia('(min-width: 1051px)')
    const update = event => setWide(event.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!sidebarFeedback) return
    const timer = setTimeout(() => setSidebarFeedback(null), sidebarFeedback.error ? 5000 : 2000)
    return () => clearTimeout(timer)
  }, [sidebarFeedback])
  useEffect(() => {
    if (!api) { setLoadingError('请用 npm start 打开 ' + productName + ' 桌面应用。'); return }
    let alive = true
    let received = false
    const offChange = api.onChange(value => {
      received = true
      setState(value)
      const running = new Set(value.threads.flatMap(thread => thread.messages.filter(message => message.status === 'running').map(message => message.id)))
      setDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => running.has(id))))
      setActivity(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => running.has(id))))
    })
    const offDraft = api.onDraft(({ messageId, text }) => setDrafts(prev => ({ ...prev, [messageId]: text })))
    const offActivity = api.onActivity(({ messageId, item }) => setActivity(previous => ({ ...previous,
      [messageId]: { ...previous[messageId], [item.id]: item } })))
    api.snapshot().then(value => { if (alive && !received) setState(value) })
      .catch(failure => { if (alive) setLoadingError(errorText(failure)) })
    return () => { alive = false; offChange(); offDraft(); offActivity() }
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
  async function sidebarAction(action, success) {
    try {
      const result = await action()
      if (success && result !== false) setSidebarFeedback({ text: success })
    } catch (failure) {
      setSidebarFeedback({ text: errorText(failure), error: true })
    }
  }
  function openMenu(event, target, kind = 'thread') {
    event.preventDefault()
    const trigger = event.currentTarget
    const rect = trigger.getBoundingClientRect()
    const fromPointer = event.type === 'contextmenu' && (event.clientX || event.clientY)
    setMenu({ id: target.id, kind, trigger,
      x: fromPointer ? event.clientX : rect.left, y: fromPointer ? event.clientY : rect.bottom + 4 })
  }
  if (!state) return <div className="app-loading" role="status"><img src={appIcon} alt="" />{loadingError || '正在打开会话…'}</div>
  const thread = byId(state.threads, state.activeThreadId) || state.threads[0]
  const roles = thread ? thread.roleIds.map(id => byId(state.roles, id)).filter(Boolean) : []
  const emptyPanel = { open: false, tabs: [], active: workspaceTabId }
  const panel = panels[thread?.id] || emptyPanel
  const selectTask = id => setFollowUp(id ? { threadId: thread.id, id } : null)
  const contentOpen = panel.open
  const updatePanel = update => setPanels(current => ({
    ...current, [thread.id]: update(current[thread.id] || emptyPanel),
  }))
  const openContent = view => {
    const key = contentKey(view)
    const id = crypto.randomUUID()
    updatePanel(current => {
      const existing = current.tabs.find(tab => tab.key === key)
      return existing ? { ...current, open: true, active: existing.id } : {
        open: true, active: id, tabs: [...current.tabs, { id, key, view }],
      }
    })
  }
  const closeTab = id => {
    if (panel.tabs.find(tab => tab.id === id)?.view.kind === 'browser') void api.browser('close', id)
    updatePanel(current => {
      const index = current.tabs.findIndex(tab => tab.id === id)
      const tabs = current.tabs.filter(tab => tab.id !== id)
      return { ...current, tabs, active: current.active === id ? (tabs[index] || tabs[index - 1])?.id || workspaceTabId : current.active }
    })
  }
  const addAttachment = input => setAttachment({ ...input, threadId: thread.id })
  const contentThread = contentOpen ? { ...thread, messages: thread.messages.map(message => activity[message.id]
    ? { ...message, activity: Object.values(activity[message.id]) } : message) } : null
  const dialogThread = dialog?.threadId ? byId(state.threads, dialog.threadId) : thread
  const dialogGroup = byId(state.threadGroups, dialog?.groupId)
  const menuThread = menu?.kind === 'thread' && byId(state.threads, menu.id)
  const close = () => show(null)
  return <div className="app">
    <header className="titlebar">
      <button type="button" className="icon-button titlebar-nav" aria-label="切换会话导航" onClick={() => setSidebar(!sidebar)}><PanelLeft size={18} /></button>
      <div className="titlebar-actions">
        <IconButton icon={Settings} label="设置" onClick={() => show({ type: 'settings' })} />
      </div>
    </header>
    <div style={contentWidth ? { '--preferred-content-width': contentWidth + 'px' } : undefined}
      className={'workspace ' + (sidebar ? 'sidebar-open ' : '') + (membersOpen && page === 'chat' && thread ? 'members-open ' : '') + (contentOpen && page === 'chat' ? 'content-open' : '')}>
      {sidebar && <button className="sidebar-scrim" aria-label="关闭会话导航" onClick={() => setSidebar(false)} />}
      <SideBar state={state} page={page} navigate={setPage} show={show} command={command} sidebarAction={sidebarAction}
        openMenu={openMenu} close={() => setSidebar(false)} />
      {page === 'roles' ? <RoleLibrary roles={state.roles} show={show} /> : thread ? <React.Fragment key={thread.id}>
        <Chat state={state} thread={thread} command={command} drafts={drafts} error={error} onView={openContent}
          membersOpen={membersOpen} contentOpen={contentOpen} toggleMembers={() => setMembers(!membersOpen)}
          toggleContent={() => updatePanel(current => ({ ...current, open: !current.open }))}
          attachment={attachment?.threadId === thread.id ? attachment : null} onAttach={addAttachment}
          taskId={followUp?.threadId === thread.id ? followUp.id : null} onTask={selectTask}
          onAttachmentHandled={request => setAttachment(current => current === request ? null : current)} />
        <MembersPanel thread={thread} roles={roles} show={show} onView={openContent} open={membersOpen} />
        {contentOpen && <ContentPanel thread={contentThread} roles={state.roles} drafts={drafts} tabs={panel.tabs}
          active={panel.active} onSelect={id => updatePanel(current => ({ ...current, active: id }))} onView={openContent} onTabClose={closeTab} onTask={selectTask}
          suspended={Boolean(dialog || menu || sidebar)} onNoteDelete={file => show({ type: 'deleteNote', threadId: thread.id, file })}
          onReference={path => addAttachment({ path })} onResize={width => setContentWidth(Math.max(240, Math.min(innerWidth, Math.round(width))))} />}
      </React.Fragment> : <main className="empty-conversations"><MessageSquare size={27} /><h1>还没有会话</h1>
        <button className="primary-button" onClick={() => show({ type: 'room' })}><Plus size={16} />新建会话</button></main>}
    </div>
    {sidebarFeedback && <div className={'sidebar-feedback' + (sidebarFeedback.error ? ' failed' : '')}
      role={sidebarFeedback.error ? 'alert' : 'status'}>{sidebarFeedback.text}</div>}
    {menu && <SidebarContextMenu menu={menu} close={closeMenu} canMove={menuThread && !menuThread.parentId && state.threadGroups.length > 1} choose={type => {
      closeMenu()
      if (type === 'copyThreadId') {
        void sidebarAction(() => api.copyThreadId(menu.id), '已复制会话 ID')
        menu.trigger?.focus({ preventScroll: true })
      } else if (type === 'exportThread') {
        void sidebarAction(() => api.exportThread(menu.id), '会话已导出')
      } else show({ type, ...(menu.kind === 'group' ? { groupId: menu.id } : { threadId: menu.id }) })
    }} />}
    {dialog?.type === 'role' && <RoleDialog role={dialog.role} close={close} />}
    {dialog?.type === 'settings' && <SettingsDialog settings={state.settings} runtimes={state.runtimes} close={close} />}
    {dialog?.type === 'newGroup' && <GroupNameDialog close={close} />}
    {dialog?.type === 'renameGroup' && dialogGroup && <GroupNameDialog group={dialogGroup} close={close} />}
    {dialog?.type === 'deleteGroup' && dialogGroup && <DeleteGroupDialog group={dialogGroup} close={close} />}
    {dialog?.type === 'moveThread' && dialogThread && <MoveThreadDialog thread={dialogThread} groups={state.threadGroups} close={close} />}
    {dialog?.type === 'renameThread' && dialogThread && <RenameThreadDialog thread={dialogThread} close={close} />}
    {dialog?.type === 'deleteThread' && dialogThread && <DeleteThreadDialog thread={dialogThread} close={close}
      hasReplies={state.threads.some(item => item.parentId === dialogThread.id)} />}
    {dialog?.type === 'sessionSettings' && dialogThread && <SessionSettings thread={dialogThread} defaultDirectory={state.defaultDirectory}
      computerAvailable={state.computerAvailable} close={close} />}
    {dialog?.type === 'threadRoles' && dialogThread && <ThreadMembersDialog thread={dialogThread} roles={state.roles} close={close} />}
    {dialog?.type === 'deleteNote' && dialogThread && <DeleteNoteDialog thread={dialogThread} file={dialog.file} close={close} />}
    {dialog?.type === 'room' && <ThreadDialog roles={state.roles} defaultDirectory={state.defaultDirectory}
      computerAvailable={state.computerAvailable} close={close} onSaved={() => { close(); setPage('chat') }} />}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
