import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBranchOutline16, IconChevronRightOutline14, IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationWorkspaceProps } from './contract.ts'
import { collaborationCopy as copy, detectCollaborationLanguage } from './language.ts'
import {
  collaborationDisplayText, collaborationRunEventContent, collaborationRunParticipantName,
} from './presentation.ts'
import type {
  CollaborationLanguage, CollaborationRunId, CollaborationRunSnapshot, CollaborationTask,
} from './types.ts'
import css from './CollaborationWorkspace.module.css'

const ACTIVE_STATUSES = new Set(['forming', 'running', 'blocked', 'reviewing', 'reworking'])
const MAX_TASK_DESCRIPTION_CHARACTERS = 60

function taskTitle(objective: string): string {
  const firstLine = objective.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ''
  const points = Array.from(firstLine)
  return points.length <= 48 ? firstLine : `${points.slice(0, 48).join('')}…`
}

/** Keep the task list scannable without mutating the authoritative task description. */
function compactTaskDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/gu, ' ')
  const characters = Array.from(normalized)
  if (characters.length <= MAX_TASK_DESCRIPTION_CHARACTERS) return normalized
  return `${characters.slice(0, MAX_TASK_DESCRIPTION_CHARACTERS - 1).join('')}…`
}

function runTone(run: CollaborationRunSnapshot): 'live' | 'success' | 'error' | 'neutral' {
  if (run.status === 'completed') return 'success'
  if (run.status === 'team_formation_failed' || run.status === 'failed') return 'error'
  if (ACTIVE_STATUSES.has(run.status)) return 'live'
  return 'neutral'
}

interface ExecutionStageView {
  readonly order: number
  readonly mode: 'serial' | 'parallel'
  readonly tasks: readonly CollaborationTask[]
}

function executionStageViews(tasks: readonly CollaborationTask[]): ExecutionStageView[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 1
    const task = byId.get(id)
    if (task === undefined) return 0
    visiting.add(id)
    const value = 1 + Math.max(0, ...task.blockedBy.map(depth))
    visiting.delete(id)
    depths.set(id, value)
    return value
  }
  const grouped = new Map<number, CollaborationTask[]>()
  for (const task of tasks) {
    const order = depth(task.id)
    grouped.set(order, [...grouped.get(order) ?? [], task])
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right).map(([order, stageTasks]) => ({
    order,
    mode: stageTasks.length > 1 ? 'parallel' : 'serial',
    tasks: stageTasks,
  }))
}

function ActiveRun({ run, language, onNew, onLeave }: {
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
  onNew: () => void
  onLeave: () => void
}) {
  const finalDelivery = [...run.timeline].reverse().find(event => event.kind === 'final_delivery')
  const leadUpdates = [...run.timeline]
    .filter(event => event.author.role === 'lead' && event.kind !== 'final_delivery')
    .sort((left, right) => left.cursor - right.cursor)
  const stages = executionStageViews(run.tasks)
  return (
    <main className={css.active} data-collaboration-workspace="active">
      <header className={css.activeHeader}>
        <div className={css.activeTitle}>
          <span className={css.mark}><IconBranchOutline16 size={18} aria-hidden="true" /></span>
          <div>
            <span className={css.kicker}>{copy(language, 'workspace.active.kicker')}</span>
            <h1>{run.title}</h1>
          </div>
        </div>
        <button type="button" className={css.quietButton} onClick={onLeave}>
          <IconCloseOutline16 size={15} aria-hidden="true" />
          {copy(language, 'workspace.daily')}
        </button>
      </header>

      <section className={css.activeBody}>
        <div className={css.transcript} aria-live="polite">
          <article className={css.userTurn} data-collaboration-center-author="user">
            <div className={css.turnLabel}>{copy(language, 'workspace.chat.user')}</div>
            <div className={css.userBubble}>{run.objective}</div>
          </article>

          <article className={css.leadTurn} data-collaboration-center-author="lead">
            <span className={css.leadAvatar} aria-hidden="true">{language === 'zh' ? '主' : 'L'}</span>
            <div className={css.leadStack}>
              <header className={css.leadHeader}>
                <div><strong>{copy(language, 'workspace.chat.lead')}</strong><span>{copy(language, 'workspace.active.title')}</span></div>
                <span className={css.status} data-tone={runTone(run)}>{copy(language, `status.${run.status}`)}</span>
              </header>

              <section className={css.taskPlan} aria-labelledby="workspace-task-plan-title">
                <header>
                  <h2 id="workspace-task-plan-title">{copy(language, 'workspace.plan.title')}</h2>
                  <span>{copy(language, 'workspace.plan.progress', { completed: run.progress.completed, total: run.progress.total })}</span>
                </header>
                {run.tasks.length === 0
                  ? <p className={css.planEmpty}>{copy(language, 'workspace.plan.empty')}</p>
                  : <div className={css.planStages}>{stages.map(stage => (
                    <section
                      className={css.planStage}
                      key={stage.order}
                      data-execution-stage={stage.order}
                      data-mode={stage.mode}
                    >
                      <header className={css.stageHeader}>
                        <span>{copy(language, 'workspace.plan.stage', { stage: stage.order })}</span>
                        <small data-mode={stage.mode}>{copy(language, `workspace.plan.${stage.mode}`)}</small>
                      </header>
                      <ol className={css.stageTasks}>{stage.tasks.map(task => (
                        <li
                          key={task.id}
                          data-collaboration-center-task={task.id}
                          data-status={task.status}
                          data-task-mode={stage.mode}
                        >
                          <span className={css.taskMark} aria-hidden="true">{task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '→' : '·'}</span>
                          <div className={css.taskContent}>
                            <div className={css.taskHeading} data-task-heading>
                              {task.status === 'completed'
                                ? <del>{collaborationDisplayText(task.subject, language)}</del>
                                : <strong>{collaborationDisplayText(task.subject, language)}</strong>}
                              <small data-task-status>{copy(language, `tasks.status.${task.status}`)}</small>
                            </div>
                            <p data-task-description>{compactTaskDescription(task.description)}</p>
                            <div className={css.taskMeta}>
                              <span className={css.taskMode} data-mode={stage.mode} data-task-mode-label>
                                {copy(language, `workspace.plan.${stage.mode}Task`)}
                              </span>
                              <span className={css.taskAgent} data-task-agent>
                                <span>{copy(language, 'workspace.plan.agent')}</span>
                                <b>{task.owner === null
                                  ? copy(language, 'workspace.plan.unassigned')
                                  : collaborationRunParticipantName(run, task.owner.name, task.owner.role, language)}</b>
                              </span>
                            </div>
                          </div>
                        </li>
                      ))}</ol>
                    </section>
                  ))}</div>}
              </section>

              <section className={css.leadUpdates} aria-labelledby="workspace-lead-updates-title">
                <h2 id="workspace-lead-updates-title">{copy(language, 'workspace.lead.updates')}</h2>
                {leadUpdates.length === 0 ? (
                  <div className={css.waitingUpdate}><span className={css.pulse} aria-hidden="true" /><p>{copy(language, 'workspace.lead.waiting')}</p></div>
                ) : (
                  <ol>{leadUpdates.map(event => (
                    <li key={event.id} data-center-lead-event={event.id} data-kind={event.kind}>
                      <span>{copy(language, `event.${event.kind}`)}</span>
                      <p>{collaborationRunEventContent(event, run, language)}</p>
                    </li>
                  ))}</ol>
                )}
              </section>
            </div>
          </article>

          {finalDelivery === undefined ? null : (
            <article className={css.leadTurn} data-collaboration-center-author="lead" data-final-delivery="true">
              <span className={css.leadAvatar} aria-hidden="true">{language === 'zh' ? '主' : 'L'}</span>
              <div className={css.leadStack}>
                <header className={css.leadHeader}><div><strong>{copy(language, 'workspace.chat.lead')}</strong><span>{copy(language, 'workspace.delivery.kicker')}</span></div></header>
                <section className={css.delivery} aria-labelledby="workspace-delivery-title">
                  <h2 id="workspace-delivery-title">{copy(language, 'workspace.delivery.title')}</h2>
                  <p>{collaborationRunEventContent(finalDelivery, run, language)}</p>
                </section>
              </div>
            </article>
          )}

          <div className={css.runFootnote}>
            <span>{copy(language, 'workspace.run.id', { id: run.id.slice(-8) })}</span>
          </div>
        </div>

        <div className={css.activeActions}>
          <button type="button" className={css.primaryButton} onClick={onNew}>{copy(language, 'workspace.new')}</button>
          <button type="button" className={css.secondaryButton} onClick={onLeave}>{copy(language, 'workspace.daily')}</button>
        </div>
      </section>
    </main>
  )
}

/** Independent task launcher that never reuses the everyday conversation composer. */
export function CollaborationWorkspace({
  useCollaboration,
  startCollaboration,
  refreshCollaboration,
  prepareNewCollaboration,
  leaveCollaboration,
  t,
}: CollaborationWorkspaceProps) {
  const catalog = useCollaboration(value => value)
  const [objective, setObjective] = useState('')
  const [activeRunId, setActiveRunId] = useState<CollaborationRunId | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef(refreshCollaboration)
  refreshRef.current = refreshCollaboration
  const activeRun = useMemo(
    () => activeRunId === null ? undefined : catalog.runs.find(run => run.id === activeRunId),
    [activeRunId, catalog.runs],
  )

  useEffect(() => {
    if (activeRunId === null) return
    let busy = false
    let disposed = false
    const sync = (): void => {
      if (busy || disposed) return
      busy = true
      void refreshRef.current(activeRunId).finally(() => { busy = false })
    }
    sync()
    const timer = window.setInterval(sync, 1_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [activeRunId])

  const start = async (): Promise<void> => {
    const normalized = objective.trim()
    if (normalized === '' || starting) return
    setStarting(true)
    setError(null)
    const taskLanguage = detectCollaborationLanguage(normalized)
    try {
      const runId = await startCollaboration({
        title: taskTitle(normalized),
        objective: normalized,
        language: taskLanguage,
      })
      setActiveRunId(runId)
    } catch {
      setError(copy(taskLanguage, 'workspace.error'))
    } finally {
      setStarting(false)
    }
  }

  const newTask = (): void => {
    prepareNewCollaboration()
    setActiveRunId(null)
    setObjective('')
    setError(null)
  }

  if (activeRun !== undefined) {
    return <ActiveRun run={activeRun} language={activeRun.language} onNew={newTask} onLeave={leaveCollaboration} />
  }

  return (
    <main className={css.launcher} data-collaboration-workspace="launcher">
      <header className={css.launcherHeader}>
        <button type="button" className={css.quietButton} onClick={leaveCollaboration}>
          <IconCloseOutline16 size={15} aria-hidden="true" />
          {t('workspace.daily')}
        </button>
      </header>
      <section className={css.launcherBody}>
        <div className={css.intro}>
          <span className={css.badge}><IconBranchOutline16 size={14} aria-hidden="true" />{t('workspace.badge')}</span>
          <h1>{t('workspace.title')}</h1>
          <p>{t('workspace.subtitle')}</p>
        </div>

        <div className={css.composer}>
          <label htmlFor="collaboration-objective">{t('workspace.objective')}</label>
          <textarea
            id="collaboration-objective"
            value={objective}
            rows={7}
            maxLength={12_000}
            placeholder={t('workspace.placeholder')}
            disabled={starting}
            onChange={(event) => { setObjective(event.currentTarget.value); setError(null) }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void start()
              }
            }}
          />
          <div className={css.composerFooter}>
            <span>{t('workspace.shortcut')}</span>
            <button type="button" className={css.primaryButton} disabled={objective.trim() === '' || starting} onClick={() => { void start() }}>
              {starting ? t('workspace.starting') : t('workspace.start')}
              {!starting ? <IconChevronRightOutline14 size={14} aria-hidden="true" /> : null}
            </button>
          </div>
          {error === null ? null : <p className={css.error} role="alert">{error}</p>}
        </div>

        <div className={css.examples} aria-label={t('workspace.examples')}>
          <span>{t('workspace.examples')}</span>
          {[t('workspace.example.research'), t('workspace.example.product'), t('workspace.example.development')].map(example => (
            <button type="button" key={example} onClick={() => { setObjective(example); setError(null) }}>{example}</button>
          ))}
        </div>

        <section className={css.guarantees} aria-label={t('workspace.guarantees')}>
          <article><span>01</span><div><strong>{t('workspace.guarantee.team')}</strong><p>{t('workspace.guarantee.team.body')}</p></div></article>
          <article><span>02</span><div><strong>{t('workspace.guarantee.binding')}</strong><p>{t('workspace.guarantee.binding.body')}</p></div></article>
          <article><span>03</span><div><strong>{t('workspace.guarantee.public')}</strong><p>{t('workspace.guarantee.public.body')}</p></div></article>
        </section>
      </section>
    </main>
  )
}
