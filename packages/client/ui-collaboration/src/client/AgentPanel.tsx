import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPanelProps } from './contract.ts'
import { collaborationCopy as copy, detectCollaborationLanguage } from './language.ts'
import type { CollaborationAgent, CollaborationAgentDetail, CollaborationLanguage } from './types.ts'
import css from './AgentPanel.module.css'

const COLLABORATION_TITLE = /^(?:协作|collaboration)(?:\s*[·:：-]|\s+)/iu
const MIN_WIDTH = 300
const MAX_WIDTH = 720

function AgentDetail({ agent, detail, loading, error, language }: {
  agent: CollaborationAgent
  detail: CollaborationAgentDetail | undefined
  loading: boolean
  error: string | null
  language: CollaborationLanguage
}) {
  const [tab, setTab] = useState<'work' | 'dialogue'>('work')
  return (
    <div className={css.detail}>
      <div className={css.detailHeader}>
        <span className={css.detailAvatar}>{agent.avatar}</span>
        <div>
          <strong>{agent.name}</strong>
          <span className={css.status} data-status={agent.status}>{copy(language, `agent.status.${agent.status}`)}</span>
        </div>
      </div>
      <div className={css.detailTabs}>
        <button type="button" className={tab === 'work' ? css.activeTab : undefined} onClick={() => { setTab('work') }}>{copy(language, 'agent.work')}</button>
        <button type="button" className={tab === 'dialogue' ? css.activeTab : undefined} onClick={() => { setTab('dialogue') }}>{copy(language, 'agent.dialogue')}</button>
      </div>
      <div className={css.detailBody}>
        {loading && <p className={css.notice}>{copy(language, 'agent.loading')}</p>}
        {error !== null && <p className={css.error}>{error}</p>}
        {!loading && error === null && detail?.languageMismatch === true && <p className={css.notice}>{copy(language, 'agent.language.mismatch')}</p>}
        {!loading && error === null && detail !== undefined && detail.omittedCount > 0 && <p className={css.compactNotice}>{copy(language, 'agent.history.compact', { count: detail.omittedCount })}</p>}
        {!loading && error === null && tab === 'work' && (
          detail?.work === undefined || detail.work === ''
            ? <p className={css.notice}>{copy(language, 'agent.work.empty')}</p>
            : <div className={css.doc}><MarkdownText text={detail.work} /></div>
        )}
        {!loading && error === null && tab === 'dialogue' && (
          <div className={css.dialogue}>
            {detail === undefined || detail.dialogue.length === 0
              ? <p className={css.dialogueEmpty}>{copy(language, 'agent.dialogue.empty')}</p>
              : detail.dialogue.map(item => (
                <article key={item.id}>
                  <header><strong>{item.speaker}</strong><time>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
                  <p>{item.content}</p>
                </article>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Show the current collaboration session's child agents in a resizable right panel. */
export function AgentPanel({ useSessions, useStore, actions, loadAgentDetail, readSessionLanguage, refreshAgents }: AgentPanelProps) {
  const sessions = useSessions(state => state)
  const width = useStore(state => state.width)
  const currentId = sessions.current
  const current = currentId === undefined ? undefined : sessions.byId[currentId]
  const collaboration = current !== undefined && COLLABORATION_TITLE.test(current.displayTitle)
  const catalog = collaboration ? sessions.subagentsByParent[current.id] : undefined
  const language = currentId === undefined
    ? 'zh'
    : collaboration ? readSessionLanguage(currentId) : detectCollaborationLanguage(current?.displayTitle ?? '')
  const agents = useMemo<readonly CollaborationAgent[]>(() => {
    if (catalog === undefined) return []
    return catalog.entries.flatMap((entry, index) => {
      if (entry.kind !== 'child') return []
      const summary = sessions.byId[entry.id]
      const recordedName = entry.label ?? summary?.displayTitle ?? copy(language, 'agent.unnamed')
      const name = detectCollaborationLanguage(recordedName) === language ? recordedName : copy(language, 'agent.numbered', { index: index + 1 })
      return [{
        id: entry.id,
        name,
        avatar: name.slice(0, 1),
        responsibility: '',
        status: entry.activity === 'running' || summary?.running === true ? 'working' : 'completed',
        sessionId: entry.id,
        work: '',
        dialogue: [],
      }]
    })
  }, [catalog, language, sessions.byId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Readonly<Record<string, CollaborationAgentDetail>>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const selected = agents.find(agent => agent.id === selectedId)

  useEffect(() => {
    if (!collaboration || currentId === undefined) return
    refreshAgents(currentId, true)
    return () => { refreshAgents(currentId, false) }
  }, [collaboration, currentId, refreshAgents])

  useEffect(() => {
    request.current?.abort()
    request.current = null
    setSelectedId(null)
    setDetails({})
    setLoadingId(null)
    setError(null)
  }, [currentId])

  useEffect(() => () => { request.current?.abort() }, [])

  const resize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX
    const startWidth = width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      actions.setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - moveEvent.clientX)))
    }
    const finish = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', finish)
      target.removeEventListener('pointercancel', finish)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)
  }

  const selectAgent = (agent: CollaborationAgent): void => {
    setSelectedId(agent.id)
    setError(null)
    if (details[agent.id] !== undefined || currentId === undefined) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoadingId(agent.id)
    void loadAgentDetail(currentId, agent.id, language, controller.signal).then((detail) => {
      if (controller.signal.aborted) return
      setDetails(currentDetails => ({ ...currentDetails, [agent.id]: detail }))
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingId(null)
    })
  }

  if (!collaboration) return null

  return (
    <aside className={css.root} style={{ '--collaboration-panel-width': `${width}px` } as CSSProperties} aria-label={copy(language, 'agents.panel')}>
      <div className={css.resizeHandle} role="separator" aria-orientation="vertical" aria-label={copy(language, 'agents.resize')} onPointerDown={resize} />
      <header className={css.panelHeader}>
        <div><h3>{copy(language, 'agents.title')}</h3><p>{current.displayTitle}</p></div>
      </header>
      {catalog?.state === 'loading' && agents.length === 0 && <p className={css.notice}>{copy(language, 'agents.loading')}</p>}
      {catalog?.state === 'error' && <p className={css.error}>{catalog.error?.message ?? copy(language, 'agents.error')}</p>}
      {catalog?.state === 'ready' && agents.length === 0 && <p className={css.notice}>{copy(language, 'agents.empty')}</p>}
      <div className={css.list}>
        {agents.map(agent => (
          <button
            type="button"
            key={agent.id}
            className={agent.id === selectedId ? css.itemActive : css.item}
            aria-label={agent.name}
            onClick={() => { selectAgent(agent) }}
          >
            <span className={css.avatar} data-status={agent.status}>{agent.avatar}</span>
            <span className={css.name}>{agent.name}</span>
          </button>
        ))}
      </div>
      {selected !== undefined && (
        <AgentDetail
          agent={selected}
          detail={details[selected.id]}
          loading={loadingId === selected.id}
          error={error}
          language={language}
        />
      )}
    </aside>
  )
}
