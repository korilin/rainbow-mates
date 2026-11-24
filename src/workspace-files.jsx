import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Paperclip, RefreshCw } from 'lucide-react'
import { fileIcon } from './file-icon.jsx'
import { workspaceFileDrag } from '../shared/file-drop.mjs'

const api = window.rainbow

export function WorkspaceFiles({ thread, onView, onReference, activePath }) {
  const [directories, setDirectories] = useState({})
  const [expanded, setExpanded] = useState({})
  const [revision, refresh] = useState(0)
  const [menu, setMenu] = useState(null)
  const files = useRef(null)
  const secondaryDrag = useRef(null)
  const suppressMenuUntil = useRef(0)
  const folders = ['', ...Object.keys(expanded).filter(path => expanded[path])]
  const expandedKey = JSON.stringify(folders)

  useEffect(() => {
    let alive = true
    for (const path of JSON.parse(expandedKey)) {
      api.workspaceEntries(thread.id, path).then(data => {
        if (alive) setDirectories(current => ({ ...current, [path]: data }))
      }).catch(error => {
        if (alive) setDirectories(current => ({ ...current, [path]: { error: error.message.replace(/^.*?: (?:Error: )?/, '') } }))
      })
    }
    return () => { alive = false }
  }, [thread.id, thread.cwd, thread.activityAt, expandedKey, revision])

  useEffect(() => {
    if (!menu) return
    const outside = event => { if (!event.target.closest('.workspace-file-menu')) setMenu(null) }
    const escape = event => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [menu])

  const open = item => {
    if (item.directory) {
      setExpanded(current => ({ ...current, [item.path]: current[item.path] !== true }))
    } else {
      onView({ kind: 'workspace', path: item.path, name: item.name })
    }
  }
  const showMenu = (event, item) => {
    event.preventDefault()
    if (secondaryDrag.current?.moved || Date.now() < suppressMenuUntil.current) return
    const rect = files.current.getBoundingClientRect()
    const y = event.clientY || event.currentTarget.getBoundingClientRect().bottom
    setMenu({ item, y: Math.max(2, Math.min(y - rect.top, rect.height - 76)) })
  }
  const beginSecondaryDrag = (event, item) => {
    if (event.button !== 2) return
    secondaryDrag.current = { x: event.clientX, y: event.clientY, item, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const trackSecondaryDrag = event => {
    const drag = secondaryDrag.current
    if (drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7 && !drag.moved) {
      drag.moved = true
      setMenu(null)
    }
  }
  const endSecondaryDrag = event => {
    const drag = secondaryDrag.current
    secondaryDrag.current = null
    if (!drag?.moved || event.type === 'pointercancel') return
    suppressMenuUntil.current = Date.now() + 250
    if (document.elementFromPoint(event.clientX, event.clientY)?.closest('.chat')) onReference(drag.item.path)
  }
  const renderFolder = (path, depth) => {
    const data = Object.hasOwn(directories, path) && directories[path]
    if (data?.error) return <p className="workspace-tree-note" role="alert">{data.error}</p>
    if (!data) return <p className="workspace-tree-note">正在读取…</p>
    if (!data.entries.length) return <p className="workspace-tree-note">空目录</p>
    return <ul>{data.entries.map(item => {
      const isOpen = expanded[item.path] === true
      const ToggleIcon = isOpen ? ChevronDown : ChevronRight
      const Icon = item.directory ? (isOpen ? FolderOpen : Folder) : fileIcon(item.name)
      const style = { paddingLeft: Math.min(52, 4 + depth * 11) }
      return <li key={item.path}>
        <button type="button" className="workspace-tree-row workspace-file-row" style={style}
          aria-expanded={item.directory ? isOpen : undefined} aria-current={activePath === item.path ? 'true' : undefined}
          title={item.path} draggable
          onClick={() => open(item)} onDragStart={event => {
            event.dataTransfer.setData(workspaceFileDrag, item.path)
            event.dataTransfer.effectAllowed = 'copy'
          }}
          onContextMenu={event => showMenu(event, item)} onPointerDown={event => beginSecondaryDrag(event, item)}
          onPointerMove={trackSecondaryDrag} onPointerUp={endSecondaryDrag} onPointerCancel={endSecondaryDrag}>
          {item.directory && <ToggleIcon size={11} aria-hidden="true" />}<Icon size={14} aria-hidden="true" /><span>{item.name}</span>
        </button>
        {item.directory && isOpen && renderFolder(item.path, depth + 1)}
      </li>
    })}</ul>
  }

  return <nav ref={files} className="workspace-files" aria-label="工作目录文件">
    <header className="workspace-files-head">
      <div><strong title={thread.cwd || directories['']?.name}>{directories['']?.name || '工作目录'}</strong></div>
      <button className="icon-button" type="button" aria-label="刷新工作目录" title="刷新工作目录" onClick={() => refresh(value => value + 1)}><RefreshCw size={13} /></button>
    </header>
    <div className="workspace-tree">{renderFolder('', 0)}</div>
    {menu && <div className="workspace-file-menu" style={{ top: menu.y }} role="menu">
      <button type="button" role="menuitem" onClick={() => { open(menu.item); setMenu(null) }}>
        {menu.item.directory ? <><Folder size={14} />{expanded[menu.item.path] === true ? '收起目录' : '展开目录'}</> : <><FileText size={14} />打开文件</>}
      </button>
      <button type="button" role="menuitem" onClick={() => { onReference(menu.item.path); setMenu(null) }}><Paperclip size={14} />引用到输入框</button>
    </div>}
  </nav>
}
