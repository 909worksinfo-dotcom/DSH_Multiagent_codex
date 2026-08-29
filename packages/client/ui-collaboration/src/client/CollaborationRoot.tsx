import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  IconBranchOutline16, IconChevronRightOutline14, IconCloseOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationRootProps, CollaborationTriggerProps } from './contract.ts'
import { collaborationCopy as copy, detectCollaborationLanguage } from './language.ts'
import {
  collaborationDisplayText, collaborationRunEventSections, collaborationRunParticipantName,
} from './presentation.ts'
import { ProtocolPanel } from './ProtocolPanel.tsx'
import type {
  CollaborationActor, CollaborationCatalogSnapshot, CollaborationExpertMember, CollaborationLanguage,
  CollaborationMessageReferences, CollaborationRunSnapshot, CollaborationRunStatus,
  CollaborationTask, CollaborationTimelineEvent,
} from './types.ts'
import type { CollaborationViewTab } from './store.ts'
import css from './CollaborationRoot.module.css'

const TABS: readonly CollaborationViewTab[] = ['timeline', 'roster', 'protocol']

function sameParticipant(left: CollaborationActor, right: CollaborationActor): boolean {
  return left.role === right.role
    && (left.role === 'lead'
      ? left.sessionId === right.sessionId
      : right.role === 'expert' && left.memberId === right.memberId)
}

function statusTone(status: CollaborationRunStatus): 'neutral' | 'live' | 'success' | 'error' {
  if (status === 'completed') return 'success'
  if (status === 'team_formation_failed' || status === 'failed') return 'error'
  if (status === 'forming' || status === 'running' || status === 'reviewing' || status === 'reworking') return 'live'
  return 'neutral'
}

function ExpertBinding({ expert, language }: { expert: CollaborationExpertMember; language: CollaborationLanguage }) {
  const marketplaceSkills = expert.binding.marketplaceSkills ?? []
  const mountedMarketplaceSkills = marketplaceSkills.filter(value => value.status === 'loaded' || value.status === 'connected')
  const pendingMarketplaceSkills = marketplaceSkills.filter(value => value.status === 'authorization_required')
  const marketplaceProviders = expert.binding.marketplaceProviders ?? []
  const list = (title: string, values: readonly { readonly id: string; readonly label: string }[]) => (
    <div className={css.bindingGroup}><dt>{title}</dt><dd>{values.length === 0 ? <span>{copy(language, 'member.none')}</span> : values.map(value => <span key={value.id} title={value.id}>{collaborationDisplayText(value.label, language)}</span>)}</dd></div>
  )
  return (
    <section className={css.binding} aria-label={copy(language, 'member.binding')}>
      <div className={css.bindingTitle}><div><span>{copy(language, 'member.role')}</span><strong>{collaborationDisplayText(expert.role, language)}</strong></div><span className={css.memberPhase} data-phase={expert.phase}>{copy(language, `member.phase.${expert.phase}`)}</span></div>
      <dl>
        <div className={css.bindingGroup}><dt>{copy(language, 'member.blueprint')}</dt><dd><code>{expert.binding.blueprint.id}</code><span>r{expert.binding.blueprint.revision}</span></dd></div>
        <div className={css.bindingGroup}><dt>{copy(language, 'member.preset')}</dt><dd><span title={expert.binding.preset.id}>{expert.binding.preset.label}</span></dd></div>
        {list(copy(language, 'member.skills'), expert.binding.skills)}
        <div className={css.bindingGroup}>
          <dt>{copy(language, 'member.marketplaceProviders')}</dt>
          <dd>
            {marketplaceProviders.length === 0
              ? <span>{copy(language, 'member.marketplaceProviders.legacy')}</span>
              : marketplaceProviders.map(value => (
                <span key={value.source} title={value.source}>
                  {copy(language, `member.marketplace.source.${value.source}`)} · {copy(language, `member.marketplace.providerState.${value.state}`)}
                </span>
              ))}
          </dd>
        </div>
        <div className={css.bindingGroup}>
          <dt>{copy(language, 'member.marketplaceSkills')}</dt>
          <dd className={css.marketplaceSkills}>
            {mountedMarketplaceSkills.length === 0
              ? <span>{copy(language, 'member.marketplaceSkills.empty')}</span>
              : mountedMarketplaceSkills.map(value => (
                <span key={value.id} className={css.marketplaceSkill} data-status={value.status} title={value.id}>
                  <strong>{collaborationDisplayText(value.label, language)}</strong>
                  <small>{copy(language, `member.marketplace.source.${value.source}`)} · {copy(language, `member.marketplace.access.${value.access ?? (value.source === 'skills_sh' ? 'public' : value.source === 'composio' ? 'user' : 'platform')}`)} · {copy(language, `member.marketplace.status.${value.status}`)}</small>
                </span>
              ))}
          </dd>
        </div>
        {pendingMarketplaceSkills.length === 0 ? null : (
          <div className={css.bindingGroup}>
            <dt>{copy(language, 'member.marketplaceCandidates')}</dt>
            <dd className={css.marketplaceSkills}>
              {pendingMarketplaceSkills.map(value => (
                <span key={value.id} className={css.marketplaceSkill} data-status={value.status} title={value.id}>
                  <strong>{collaborationDisplayText(value.label, language)}</strong>
                  <small>{copy(language, `member.marketplace.source.${value.source}`)} · {copy(language, `member.marketplace.status.${value.status}`)}</small>
                </span>
              ))}
            </dd>
          </div>
        )}
        {list(copy(language, 'member.plugins'), expert.binding.plugins)}
      </dl>
      {expert.failure !== undefined ? <p className={css.memberFailure} role="status">{language === 'zh' ? copy(language, 'member.failure') : expert.failure.message}</p> : null}
    </section>
  )
}

function RosterPanel({ run, language, selectedMemberId, onSelect }: {
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
  selectedMemberId: string | null
  onSelect: (id: string | null) => void
}) {
  const selected = run.experts.find(expert => expert.id === selectedMemberId) ?? null
  return (
    <section className={css.roster} aria-labelledby="roster-title">
      <div className={css.sectionHeading}><div><span className={css.eyebrow}>{copy(language, 'roster.eyebrow')}</span><h3 id="roster-title">{copy(language, 'roster.title')}</h3></div><span className={css.topology}>{copy(language, 'roster.count', { active: run.expertCounts.active, planned: run.expertCounts.planned })}</span></div>
      <div className={css.rosterLayout}>
        <div className={css.memberList}>
          <div className={css.leadRow}><span className={css.memberAvatar} data-lead="true">{language === 'zh' ? '主' : 'L'}</span><div><strong>{collaborationRunParticipantName(run, run.lead.name, 'lead', language)}</strong><span>{collaborationDisplayText(run.lead.role, language)}</span></div><em>{copy(language, 'actor.role.lead')}</em></div>
          {run.experts.map((expert) => {
            const displayName = collaborationRunParticipantName(run, expert.name, 'expert', language)
            return (
              <button
                type="button"
                key={expert.id}
                className={css.memberRow}
                data-expert-attempt={expert.id}
                aria-pressed={selected?.id === expert.id}
                onClick={() => { onSelect(selected?.id === expert.id ? null : expert.id) }}
              >
                <span className={css.memberAvatar}>{displayName.slice(0, 1)}</span>
                <span><strong>{displayName}</strong></span>
                <em data-phase={expert.phase}>{copy(language, `member.phase.${expert.phase}`)}</em>
              </button>
            )
          })}
        </div>
        {selected === null
          ? <div className={css.memberPlaceholder}><IconBranchOutline16 size={22} aria-hidden="true" /><p>{copy(language, 'member.select')}</p></div>
          : <ExpertBinding expert={selected} language={language} />}
      </div>
    </section>
  )
}

function timelineEmptyCopy(run: CollaborationRunSnapshot, language: CollaborationLanguage): string {
  if (run.status === 'forming') return copy(language, 'timeline.empty.forming')
  if (run.status === 'team_formation_failed' || run.status === 'failed') return copy(language, 'timeline.empty.failed')
  return copy(language, 'timeline.empty')
}

function referenceLabels(references: CollaborationMessageReferences, language: CollaborationLanguage): string[] {
  const labels: string[] = []
  if (references.taskId !== undefined) labels.push(copy(language, 'timeline.reference.task', { id: references.taskId }))
  if (references.challengeId !== undefined) labels.push(copy(language, 'timeline.reference.challenge', { id: references.challengeId }))
  if (references.decisionId !== undefined) labels.push(copy(language, 'timeline.reference.decision', { id: references.decisionId }))
  if (references.artifactId !== undefined) labels.push(copy(language, 'timeline.reference.artifact', { id: references.artifactId }))
  return labels
}

function participantTone(run: CollaborationRunSnapshot, event: CollaborationTimelineEvent): string {
  if (event.author.role === 'lead') return 'lead'
  const rosterIndex = run.experts.findIndex(expert => (
    expert.id === event.author.memberId
    || expert.sessionId === event.author.sessionId
    || expert.name === event.author.name
  ))
  if (rosterIndex >= 0) return `expert-${String((rosterIndex % 8) + 1)}`
  const stableIndex = Array.from(event.author.name).reduce((total, value) => total + (value.codePointAt(0) ?? 0), 0) % 8
  return `expert-${String(stableIndex + 1)}`
}

function TimelineEvent({ event, run, language }: {
  event: CollaborationTimelineEvent
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
}) {
  const references = referenceLabels(event.references, language)
  const lead = event.author.role === 'lead'
  const finalDelivery = event.kind === 'final_delivery'
  const authorName = collaborationRunParticipantName(run, event.author.name, event.author.role, language)
  const sections = collaborationRunEventSections(event, run, language)
  const visibleTargets = event.targets.filter(target => !sameParticipant(event.author, target))
  return (
    <article
      className={css.chatMessage}
      data-collaboration-event={event.id}
      data-kind={event.kind}
      data-author-role={event.author.role}
      data-participant-tone={participantTone(run, event)}
      data-final-delivery={finalDelivery ? 'true' : undefined}
    >
      <span className={css.chatAvatar} data-lead={lead ? 'true' : undefined} aria-hidden="true">
        {lead ? (language === 'zh' ? '主' : 'L') : authorName.slice(0, 1)}
      </span>
      <div className={css.chatStack}>
        <header>
          <div><strong>{authorName}</strong><small>{copy(language, `actor.role.${event.author.role}`)}</small></div>
          <time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</time>
          <span className={css.eventKind} data-kind={event.kind}>{copy(language, `event.${event.kind}`)}</span>
        </header>
        <div className={css.chatBubble}>
          {visibleTargets.length > 0 ? <p className={css.chatTargets}>{copy(language, 'timeline.targets', { targets: visibleTargets.map(target => collaborationRunParticipantName(run, target.name, target.role, language)).join(language === 'zh' ? '、' : ', ') })}</p> : null}
          <div className={css.chatContent}>
            {sections.map((section, index) => (
              <section
                key={`${section.kind}-${String(index)}`}
                className={css.chatSection}
                data-message-section={section.kind}
              >
                {section.label === null ? null : <span className={css.chatSectionLabel}>{section.label}</span>}
                <p>{section.content}</p>
              </section>
            ))}
          </div>
          {references.length > 0 ? <footer>{references.map(label => <code key={label}>{label}</code>)}</footer> : null}
        </div>
      </div>
    </article>
  )
}

interface DiscussionStage {
  readonly task: CollaborationTask
  readonly events: readonly CollaborationTimelineEvent[]
}

function activeDiscussionTaskId(tasks: readonly CollaborationTask[]): string | null {
  return tasks.find(task => task.status === 'in_progress')?.id
    ?? tasks.find(task => task.status === 'pending')?.id
    ?? tasks[tasks.length - 1]?.id
    ?? null
}

function preferredKnownTaskId(
  taskIds: readonly string[] | undefined,
  knownTaskIds: ReadonlySet<string>,
  preferredTaskId: string | null,
): string | null {
  if (preferredTaskId !== null && taskIds?.includes(preferredTaskId) === true) return preferredTaskId
  return taskIds?.find(taskId => knownTaskIds.has(taskId)) ?? null
}

function buildDiscussionStages(run: CollaborationRunSnapshot): {
  readonly stages: readonly DiscussionStage[]
  readonly ungroupedEvents: readonly CollaborationTimelineEvent[]
  readonly activeTaskId: string | null
} {
  const events = [...run.timeline].sort((left, right) => left.cursor - right.cursor)
  if (run.tasks.length === 0) return { stages: [], ungroupedEvents: events, activeTaskId: null }

  const activeTaskId = activeDiscussionTaskId(run.tasks)
  const knownTaskIds = new Set(run.tasks.map(task => task.id))
  const eventsByTaskId = new Map(run.tasks.map(task => [task.id, [] as CollaborationTimelineEvent[]]))
  const taskIdByChallengeId = new Map<string, string>()

  for (const event of events) {
    const { challengeId, taskId } = event.references
    if (challengeId !== undefined && taskId !== undefined && knownTaskIds.has(taskId)) {
      taskIdByChallengeId.set(challengeId, taskId)
    }
  }

  for (const event of events) {
    const directTaskId = event.references.taskId
    const artifactTaskId = event.references.artifactId === undefined
      ? null
      : preferredKnownTaskId(
        run.artifacts.find(artifact => artifact.id === event.references.artifactId)?.taskIds,
        knownTaskIds,
        activeTaskId,
      )
    const decisionTaskId = event.references.decisionId === undefined
      ? null
      : preferredKnownTaskId(
        run.decisions.find(decision => decision.id === event.references.decisionId)?.taskIds,
        knownTaskIds,
        activeTaskId,
      )
    const challengeTaskId = event.references.challengeId === undefined
      ? null
      : (taskIdByChallengeId.get(event.references.challengeId) ?? null)
    const resolvedTaskId = directTaskId !== undefined && knownTaskIds.has(directTaskId)
      ? directTaskId
      : artifactTaskId ?? decisionTaskId ?? challengeTaskId ?? activeTaskId
    if (resolvedTaskId !== null) eventsByTaskId.get(resolvedTaskId)?.push(event)
  }

  return {
    stages: run.tasks.map(task => ({ task, events: eventsByTaskId.get(task.id) ?? [] })),
    ungroupedEvents: [],
    activeTaskId,
  }
}

function TimelinePanel({ run, language }: { run: CollaborationRunSnapshot; language: CollaborationLanguage }) {
  const { stages, ungroupedEvents, activeTaskId } = useMemo(() => buildDiscussionStages(run), [run])
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(activeTaskId)
  const active = ['forming', 'running', 'blocked', 'reviewing', 'reworking'].includes(run.status)

  useEffect(() => {
    setExpandedTaskId(activeTaskId)
  }, [activeTaskId, run.id])

  return (
    <section className={css.timeline} aria-labelledby="timeline-title">
      <h3 id="timeline-title" className={css.srOnly}>{copy(language, 'timeline.title')}</h3>
      <p className={css.publicNotice}>{copy(language, 'timeline.public')}</p>
      {run.timeline.length === 0
        ? <div className={css.executionEmpty}>{timelineEmptyCopy(run, language)}</div>
        : stages.length === 0
          ? <div className={css.chatList} role="log" aria-label={copy(language, 'timeline.title')}>
            {ungroupedEvents.map(event => <TimelineEvent key={event.id} event={event} run={run} language={language} />)}
          </div>
          : <div className={css.stageList} data-collaboration-discussion-stages="true">
            {stages.map((stage) => {
              const expanded = expandedTaskId === stage.task.id
              const current = activeTaskId === stage.task.id
              const title = collaborationDisplayText(stage.task.subject, language)
              const panelId = `collaboration-stage-panel-${stage.task.id}`
              return (
                <section
                  key={stage.task.id}
                  className={css.discussionStage}
                  data-collaboration-discussion-stage={stage.task.id}
                  data-current={current ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className={css.stageToggle}
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => { setExpandedTaskId(expanded ? null : stage.task.id) }}
                  >
                    <span className={css.stageHeading}>
                      {current ? <span className={css.stagePrefix}>{copy(language, 'timeline.discussing')}</span> : null}
                      <strong data-collaboration-stage-title={stage.task.id}>{title}</strong>
                    </span>
                    <span className={css.stageMeta}>
                      <span data-status={stage.task.status}>{copy(language, `tasks.status.${stage.task.status}`)}</span>
                      <small>{stage.events.length}</small>
                      <IconChevronRightOutline14 className={css.stageChevron} size={14} aria-hidden="true" />
                    </span>
                  </button>
                  <div id={panelId} className={css.stageBody} hidden={!expanded}>
                    {stage.events.length === 0
                      ? <p className={css.stageEmpty}>{copy(language, 'timeline.stage.empty')}</p>
                      : <div className={css.chatList} role="log" aria-label={title}>
                        {stage.events.map(event => <TimelineEvent key={event.id} event={event} run={run} language={language} />)}
                      </div>}
                  </div>
                </section>
              )
            })}
          </div>}
      {active ? <div className={css.teamTyping} role="status"><span aria-hidden="true"><i /><i /><i /></span>{copy(language, 'timeline.typing')}</div> : null}
    </section>
  )
}

function RunDetail({ run, language, tab, selectedMemberId, actions }: {
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
  tab: CollaborationViewTab
  selectedMemberId: string | null
  actions: CollaborationRootProps['actions']
}) {
  const invalidReadyTeam = ['running', 'blocked', 'reviewing', 'reworking', 'completed'].includes(run.status) && run.expertCounts.active < 3
  const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + delta + TABS.length) % TABS.length
    const nextTab = TABS[nextIndex] ?? 'timeline'
    actions.setTab(nextTab)
    const nextButton = event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(nextIndex)
    nextButton?.focus()
  }
  return (
    <section className={css.workspace} aria-labelledby="run-title">
      <header className={css.runHeader}>
        <div className={css.runHeading}>
          <h2 id="run-title" title={run.title}>{run.title}</h2>
        </div>
        {run.status === 'team_formation_failed' ? (
          <div className={css.formationFailure} role="alert">
            <strong>{copy(language, 'formation.failed.title')}</strong>
            <span>{language === 'zh' ? copy(language, 'formation.failed.body') : (run.failure?.message ?? copy(language, 'formation.failed.body'))}</span>
            <small>{copy(language, 'formation.failed.mainEntry')}</small>
          </div>
        ) : null}
        {invalidReadyTeam ? <div className={css.formationFailure} role="alert"><strong>{copy(language, 'formation.invalid.title')}</strong><span>{copy(language, 'formation.invalid.body')}</span></div> : null}
        {run.status === 'cancelled' ? <div className={css.cancelledNotice} role="status">{copy(language, 'cancelled.body')}</div> : null}
      </header>
      <div className={css.tabs} role="tablist" aria-label={copy(language, 'tabs.label')}>
        {TABS.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`collaboration-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`collaboration-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => { actions.setTab(value) }}
            onKeyDown={(event) => { selectAdjacentTab(event, index) }}
          >{copy(language, `tabs.${value}`)}</button>
        ))}
      </div>
      <div className={css.tabPanel} role="tabpanel" id={`collaboration-panel-${tab}`} aria-labelledby={`collaboration-tab-${tab}`}>
        {tab === 'protocol' ? <ProtocolPanel run={run} language={language} /> : null}
        {tab === 'timeline' ? <TimelinePanel run={run} language={language} /> : null}
        {tab === 'roster' ? <RosterPanel run={run} language={language} selectedMemberId={selectedMemberId} onSelect={actions.selectMember} /> : null}
      </div>
    </section>
  )
}

function Recovery({ catalog, language }: { catalog: CollaborationCatalogSnapshot; language: CollaborationLanguage }) {
  if (catalog.state === 'error') return <div className={css.recovery} role="alert"><strong>{copy(language, 'restore.error.title')}</strong><p>{language === 'zh' ? copy(language, 'restore.error.body') : catalog.error.message}</p></div>
  return <div className={css.recovery} aria-busy="true"><span className={css.recoveryPulse} /><strong>{copy(language, 'restore.loading')}</strong><p>{copy(language, 'restore.loading.body')}</p></div>
}

/** Sidebar entry that enters the dedicated collaboration workspace. */
export function CollaborationTrigger({ wide, enterCollaboration, t }: CollaborationTriggerProps) {
  return (
    <Tooltip label={t('trigger.aria')} disabled={wide}>
      <button type="button" className={wide ? css.trigger : css.railTrigger} aria-label={t('trigger.aria')} onClick={enterCollaboration}>
        <IconBranchOutline16 size={wide ? 16 : 18} aria-hidden="true" />
        {wide ? <span>{t('trigger')}</span> : null}
      </button>
    </Tooltip>
  )
}

/** Render the authoritative TeamRun workspace inside the shell's right dock. */
export function CollaborationRoot({
  open, useStore, actions, useCollaboration, refreshCollaboration, closeCollaboration, t,
}: CollaborationRootProps) {
  const state = useStore(value => value)
  const catalog = useCollaboration(value => value)
  // Task creation belongs to the independent center workspace, so this
  // observer always follows the newest authoritative run instead of retaining
  // a stale dock selection that the user can no longer switch from.
  const run = catalog.runs[0]
  const language = run?.language ?? detectCollaborationLanguage(t('title'))
  const refreshRef = useRef(refreshCollaboration)

  useEffect(() => {
    refreshRef.current = refreshCollaboration
  }, [refreshCollaboration])

  useEffect(() => {
    if (!open) return
    let busy = false
    let disposed = false
    const sync = (): void => {
      if (busy || disposed) return
      busy = true
      void refreshRef.current().finally(() => { busy = false })
    }
    sync()
    const timer = window.setInterval(sync, 1_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') closeCollaboration()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [closeCollaboration, open])

  return (
    <aside className={css.dock} aria-label={copy(language, 'title')} data-collaboration-dock="true">
      <header className={css.dockHeader}>
        <div className={css.dockTitle}>
          <span className={css.headerMark}><IconBranchOutline16 size={16} aria-hidden="true" /></span>
          <div>
            <h2>{copy(language, 'title')}</h2>
            {run === undefined ? null : <span className={css.headerStatus} data-tone={statusTone(run.status)} aria-live="polite">{copy(language, `status.${run.status}`)}</span>}
          </div>
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.iconButton} aria-label={copy(language, 'close')} onClick={closeCollaboration}>
            <IconCloseOutline16 size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className={css.dockBody} aria-busy={catalog.state === 'loading'}>
        {catalog.state !== 'ready'
          ? <Recovery catalog={catalog} language={language} />
          : run === undefined
            ? <section className={css.empty}><span><IconBranchOutline16 size={26} aria-hidden="true" /></span><h2>{copy(language, 'empty.title')}</h2><p>{copy(language, 'empty.body')}</p><small>{copy(language, 'empty.hint')}</small></section>
            : <RunDetail
              run={run}
              language={language}
              tab={state.tab}
              selectedMemberId={state.selectedMemberId}
              actions={actions}
            />}
      </main>
    </aside>
  )
}
