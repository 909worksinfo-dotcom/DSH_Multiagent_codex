import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBranchOutline16, IconChevronRightOutline14, IconCloseOutline16, IconPlusOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationWorkspaceProps } from './contract.ts'
import { collaborationCopy as copy, detectCollaborationLanguage } from './language.ts'
import {
  collaborationDisplayText, collaborationRunEventContent, collaborationRunParticipantName,
} from './presentation.ts'
import type {
  CollaborationExpertModelSelection, CollaborationExternalCredential, CollaborationExternalCredentialRef,
  CollaborationLanguage, CollaborationModelCatalog,
  CollaborationPlannedTask, CollaborationRunId, CollaborationRunSnapshot, CollaborationSkillOption,
} from './types.ts'
import { zh } from './locales.ts'
import { preferredActiveCollaborationRun } from './run-selection.ts'
import css from './CollaborationWorkspace.module.css'

const ACTIVE_STATUSES = new Set(['forming', 'running', 'blocked', 'reviewing', 'reworking'])
const MIN_REVIEWED_EXPERT_SKILLS = 2

const EXTERNAL_CAPABILITIES = [
  { source: 'smithery', ref: 'SMITHERY_API_KEY', label: zh['workspace.review.external.smithery'] },
  { source: 'composio', ref: 'COMPOSIO_API_KEY', label: zh['workspace.review.external.composio'] },
] as const satisfies readonly {
  readonly source: 'smithery' | 'composio'
  readonly ref: CollaborationExternalCredentialRef
  readonly label: string
}[]

function taskTitle(objective: string): string {
  const firstLine = objective.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ''
  const points = Array.from(firstLine)
  return points.length <= 48 ? firstLine : `${points.slice(0, 48).join('')}…`
}

const PLAN_ADJUSTMENT_MARKER = /(?:^|\n)\s*协作方案调整要求\s*[:：]\s*/gu

/** Collapse legacy repeated adjustment blocks into one cumulative review request. */
function revisedCollaborationObjective(objective: string, nextAdjustment: string): string {
  const parts = objective.split(PLAN_ADJUSTMENT_MARKER)
  const base = (parts[0] ?? objective).trim()
  const adjustments = [...parts.slice(1), nextAdjustment]
    .flatMap(value => value.split(/\r?\n/gu))
    .map(value => value.trim())
    .filter(Boolean)
  const unique = [...new Set(adjustments)]
  return `${base}\n\n协作方案调整要求：\n${unique.join('\n')}`
}

/** Normalize wrapping whitespace while preserving every authoritative task detail. */
function taskDescription(description: string): string {
  return description.trim().replace(/\s+/gu, ' ')
}

function runTone(run: CollaborationRunSnapshot): 'live' | 'success' | 'error' | 'neutral' {
  if (run.status === 'completed') return 'success'
  if (run.status === 'team_formation_failed' || run.status === 'failed') return 'error'
  if (ACTIVE_STATUSES.has(run.status)) return 'live'
  return 'neutral'
}

interface ExecutionStageView<T> {
  readonly order: number
  readonly mode: 'serial' | 'parallel'
  readonly tasks: readonly T[]
}

function executionStageViews<T extends { readonly id: string; readonly blockedBy: readonly string[] }>(
  tasks: readonly T[],
): ExecutionStageView<T>[] {
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
  const grouped = new Map<number, T[]>()
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

function dynamicCapabilityLabels(expert: CollaborationRunSnapshot['experts'][number]): readonly string[] {
  return (expert.binding.marketplaceSkills ?? [])
    .filter(skill => skill.status === 'loaded' || skill.status === 'connected')
    .map(skill => skill.label)
}

/** Show task authorization only for remote marketplace sources selected by this reviewed plan. */
function selectedExternalCapabilities(run: CollaborationRunSnapshot): typeof EXTERNAL_CAPABILITIES[number][] {
  return EXTERNAL_CAPABILITIES.filter(capability => run.experts.some(expert =>
    expert.binding.marketplaceProviders?.some(provider =>
      provider.source === capability.source && provider.state !== 'unavailable') === true
    || expert.binding.marketplaceSkills?.some(skill =>
      skill.source === capability.source && skill.kind === 'remote_tool') === true))
}

const CHINESE_SKILL_COUNTS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
])

/** Keep the editor aligned with an explicit skill floor already retained in the objective. */
function reviewedSkillFloor(objective: string): number {
  const values = [...objective.matchAll(
    /每(?:个|名)专家(?:\s*(?:agent|智能体))?[^\n。；;]{0,32}?(?:挂载|配置|绑定|拥有)[^\n。；;]{0,16}?([1-9]\d*|[一二两三四五六七八九十]+)\s*个?\s*技能/giu,
  )].map((match) => {
    const token = match[1] ?? ''
    return /^\d+$/u.test(token) ? Number(token) : CHINESE_SKILL_COUNTS.get(token) ?? 0
  })
  return Math.max(MIN_REVIEWED_EXPERT_SKILLS, ...values)
}

function initialExpertSkills(run: CollaborationRunSnapshot): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(run.experts.map(expert => [expert.id, expert.binding.skills.map(skill => skill.id)]))
}

function sameSkillSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function skillReplacementRequirement(
  run: CollaborationRunSnapshot,
  selections: Readonly<Record<string, readonly string[]>>,
): string {
  return run.experts.flatMap((expert) => {
    const current = expert.binding.skills.map(skill => skill.id)
    const selected = selections[expert.id] ?? current
    if (sameSkillSelection(current, selected)) return []
    const expertName = collaborationRunParticipantName(run, expert.name, 'expert', 'zh')
    return [`将${expertName}的技能修改为 ${selected.map(skill => `\`${skill}\``).join('、')}`]
  }).join('\n')
}

type ExpertModelSelections = Readonly<Record<string, CollaborationExpertModelSelection['selection']>>

function selectedLeadModel(run: CollaborationRunSnapshot): CollaborationExpertModelSelection['selection'] | undefined {
  return run.lead.modelSelection === undefined ? undefined : { ...run.lead.modelSelection }
}

function selectedExpertModels(run: CollaborationRunSnapshot): readonly CollaborationExpertModelSelection[] {
  return run.experts.flatMap((expert, index) => {
    const model = expert.binding.foundation?.model
    if (model?.mode !== 'selected' || model.provider === undefined || model.model === undefined) return []
    return [{
      slotId: `slot-${String(index + 1)}`,
      selection: {
        provider: model.provider,
        model: model.model,
        ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
      },
    }]
  })
}

function initialExpertModels(
  run: CollaborationRunSnapshot,
  catalog: CollaborationModelCatalog,
): ExpertModelSelections {
  return Object.fromEntries(run.experts.map((expert) => {
    const model = expert.binding.foundation?.model
    return [expert.id, model?.mode === 'selected' && model.provider !== undefined && model.model !== undefined
      ? {
        provider: model.provider,
        model: model.model,
        ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
      }
      : { ...catalog.current }]
  }))
}

function sameModelSelection(
  left: CollaborationExpertModelSelection['selection'],
  right: CollaborationExpertModelSelection['selection'],
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function advertisedModel(
  catalog: CollaborationModelCatalog | null,
  selection: CollaborationExpertModelSelection['selection'],
): boolean {
  return catalog?.groups.some(group => group.id === selection.provider
    && group.models.some(model => model.id === selection.model)) ?? false
}

function PlanReview({
  run, action, revision, error, onRevision, onConfirm, onRegenerate, onApplySkills, onApplyModels,
  onBack, onLeave, loadSkills, loadModels, describeCredentials, saveCredential,
}: {
  run: CollaborationRunSnapshot
  action: 'confirming' | 'revising' | 'back' | null
  revision: string
  error: string | null
  onRevision: (value: string) => void
  onConfirm: () => void
  onRegenerate: () => void
  onApplySkills: (requirement: string) => void
  onApplyModels: (
    leadModel: CollaborationExpertModelSelection['selection'],
    models: readonly CollaborationExpertModelSelection[],
  ) => void
  onBack: () => void
  onLeave: () => void
  loadSkills: (runId: CollaborationRunId) => Promise<readonly CollaborationSkillOption[]>
  loadModels: (runId: CollaborationRunId) => Promise<CollaborationModelCatalog>
  describeCredentials: () => Promise<readonly CollaborationExternalCredential[]>
  saveCredential: (ref: CollaborationExternalCredentialRef, value: string) => Promise<void>
}) {
  const tasks = run.charter?.tasks ?? []
  const stages = executionStageViews(tasks)
  const expertsBySlot = new Map(run.experts.map(expert => [expert.id, expert]))
  const busy = action !== null
  const skillFloor = reviewedSkillFloor(run.objective)
  const authoritativeSkillSignature = JSON.stringify(run.experts.map(expert => [
    expert.id,
    expert.binding.skills.map(skill => skill.id),
  ]))
  const authoritativeSkillsRef = useRef({
    signature: authoritativeSkillSignature,
    values: initialExpertSkills(run),
  })
  // The run snapshot may refresh every second; keep local GUI edits until the authoritative skill ids change.
  if (authoritativeSkillsRef.current.signature !== authoritativeSkillSignature) {
    authoritativeSkillsRef.current = {
      signature: authoritativeSkillSignature,
      values: initialExpertSkills(run),
    }
  }
  const authoritativeSkills = authoritativeSkillsRef.current.values
  const [skillSelections, setSkillSelections] = useState<Readonly<Record<string, readonly string[]>>>(authoritativeSkills)
  const [editingExpertId, setEditingExpertId] = useState<string | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillOptions, setSkillOptions] = useState<readonly CollaborationSkillOption[]>([])
  const [skillCatalogState, setSkillCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [modelCatalog, setModelCatalog] = useState<CollaborationModelCatalog | null>(null)
  const [modelCatalogState, setModelCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [leadModelSelection, setLeadModelSelection] = useState<CollaborationExpertModelSelection['selection'] | null>(null)
  const [modelSelections, setModelSelections] = useState<ExpertModelSelections>({})
  const [credentials, setCredentials] = useState<readonly CollaborationExternalCredential[]>([])
  const [credentialState, setCredentialState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [credentialInputs, setCredentialInputs] = useState<Readonly<Partial<Record<CollaborationExternalCredentialRef, string>>>>({})
  const [savingCredential, setSavingCredential] = useState<CollaborationExternalCredentialRef | null>(null)
  const initialLeadModelRef = useRef<CollaborationExpertModelSelection['selection'] | null>(null)
  const initialModelsRef = useRef<ExpertModelSelections>({})
  const externalCapabilities = selectedExternalCapabilities(run)
  const externalCredentialSignature = externalCapabilities.map(capability => capability.ref).join(',')

  useEffect(() => {
    setSkillSelections(authoritativeSkillsRef.current.values)
    setEditingExpertId(null)
    setSkillQuery('')
  }, [authoritativeSkillSignature])

  useEffect(() => {
    if (externalCredentialSignature === '') {
      setCredentials([])
      setCredentialState('ready')
      return
    }
    let disposed = false
    setSkillCatalogState('loading')
    void loadSkills(run.id).then(
      (options) => {
        if (disposed) return
        setSkillOptions(options)
        setSkillCatalogState('ready')
      },
      () => {
        if (disposed) return
        setSkillOptions([])
        setSkillCatalogState('error')
      },
    )
    return () => { disposed = true }
  }, [loadSkills, run.id])

  useEffect(() => {
    let disposed = false
    setModelCatalogState('loading')
    void loadModels(run.id).then(
      (catalog) => {
        if (disposed) return
        const initial = initialExpertModels(run, catalog)
        const initialLead = selectedLeadModel(run) ?? { ...catalog.current }
        initialLeadModelRef.current = initialLead
        setLeadModelSelection(initialLead)
        initialModelsRef.current = initial
        setModelSelections(initial)
        setModelCatalog(catalog)
        setModelCatalogState('ready')
      },
      () => {
        if (disposed) return
        initialLeadModelRef.current = null
        setLeadModelSelection(null)
        initialModelsRef.current = {}
        setModelSelections({})
        setModelCatalog(null)
        setModelCatalogState('error')
      },
    )
    return () => { disposed = true }
  }, [loadModels, run.id])

  useEffect(() => {
    let disposed = false
    setCredentialState('loading')
    void describeCredentials().then(
      (value) => {
        if (disposed) return
        setCredentials(value)
        setCredentialState('ready')
      },
      () => {
        if (disposed) return
        setCredentials([])
        setCredentialState('error')
      },
    )
    return () => { disposed = true }
  }, [describeCredentials, externalCredentialSignature, run.id])

  const skillRequirement = skillReplacementRequirement(run, skillSelections)
  const hasSkillChanges = skillRequirement !== ''
  const hasLeadModelChanges = leadModelSelection !== null
    && initialLeadModelRef.current !== null
    && !sameModelSelection(leadModelSelection, initialLeadModelRef.current)
  const hasModelChanges = hasLeadModelChanges || run.experts.some((expert) => {
    const selected = modelSelections[expert.id]
    const initial = initialModelsRef.current[expert.id]
    return selected !== undefined && initial !== undefined && !sameModelSelection(selected, initial)
  })
  const setExpertSkills = (expertId: string, skills: readonly string[]): void => {
    setSkillSelections(current => ({ ...current, [expertId]: skills }))
  }
  const leadModelGroup = modelCatalog?.groups.find(group => group.id === leadModelSelection?.provider)
  const leadModelInfo = leadModelGroup?.models.find(model => model.id === leadModelSelection?.model)
  const storeCredential = async (ref: CollaborationExternalCredentialRef): Promise<void> => {
    const value = credentialInputs[ref]?.trim() ?? ''
    if (value === '' || savingCredential !== null) return
    setSavingCredential(ref)
    try {
      await saveCredential(ref, value)
      setCredentialInputs(current => ({ ...current, [ref]: '' }))
    } catch {
      setCredentialState('error')
    } finally {
      setSavingCredential(null)
    }
  }
  return (
    <main className={css.review} data-collaboration-workspace="review">
      <header className={css.activeHeader}>
        <div className={css.activeTitle}>
          <span className={css.mark}><IconBranchOutline16 size={18} aria-hidden="true" /></span>
          <div><span className={css.kicker}>{zh['workspace.review.kicker']}</span><h1>{run.title}</h1></div>
        </div>
        <button type="button" className={css.quietButton} disabled={busy} onClick={onLeave}>
          <IconCloseOutline16 size={15} aria-hidden="true" />{zh['workspace.daily']}
        </button>
      </header>

      <section className={css.reviewBody} aria-busy={busy}>
        <header className={css.reviewIntro}>
          <div><span>{zh['workspace.review.kicker']}</span><h1>{zh['workspace.review.title']}</h1></div>
          <p>{zh['workspace.review.subtitle']}</p>
        </header>

        <section className={css.reviewObjective}>
          <h2>{zh['workspace.review.objective']}</h2><p>{run.objective}</p>
        </section>

        <section className={css.reviewSection} aria-labelledby="review-task-title">
          <header><div><span>01</span><h2 id="review-task-title">{zh['workspace.review.tasks']}</h2></div><small>{copy('zh', 'workspace.review.tasks.count', { count: tasks.length })}</small></header>
          <div className={css.reviewPlan}>{stages.map(stage => (
            <section className={css.reviewStage} key={stage.order} data-review-stage={stage.order} data-mode={stage.mode}>
              <header><strong>{copy('zh', 'workspace.plan.stage', { stage: stage.order })}</strong><span data-mode={stage.mode}>{copy('zh', `workspace.plan.${stage.mode}`)}</span></header>
              <ol>{stage.tasks.map((task: CollaborationPlannedTask) => {
                const owner = task.assigneeSlotId === null ? undefined : expertsBySlot.get(task.assigneeSlotId)
                const ownerName = owner === undefined
                  ? zh['workspace.plan.unassigned']
                  : collaborationRunParticipantName(run, owner.name, 'expert', 'zh')
                return <li key={task.id} data-review-task={task.id}>
                  <span className={css.reviewTaskIndex}>{String(tasks.indexOf(task) + 1).padStart(2, '0')}</span>
                  <div><strong>{task.subject}</strong><p>{taskDescription(task.description)}</p><span className={css.reviewOwner}>{zh['workspace.plan.agent']}<b>{ownerName}</b></span></div>
                </li>
              })}</ol>
            </section>
          ))}</div>
        </section>

        <section className={css.reviewSection} aria-labelledby="review-team-title">
          <header><div><span>02</span><h2 id="review-team-title">{zh['workspace.review.team']}</h2></div><small>{copy('zh', 'workspace.review.team.count', { count: run.experts.length })}</small></header>
          <article className={css.leadModelCard} data-review-lead-model>
            <div><span>Lead</span><strong>{zh['workspace.chat.lead']}</strong><p>{zh['workspace.review.models.lead.help']}</p></div>
            <div className={css.modelControls}>
              {modelCatalogState === 'ready' && leadModelSelection !== null
                ? <>
                  <select
                    aria-label={copy('zh', 'workspace.review.models.select', { expert: zh['workspace.chat.lead'] })}
                    value={`${leadModelSelection.provider}\u0000${leadModelSelection.model}`}
                    disabled={busy}
                    onChange={(event) => {
                      const [provider, model] = event.currentTarget.value.split('\u0000')
                      const info = modelCatalog?.groups.find(group => group.id === provider)?.models.find(value => value.id === model)
                      if (provider === undefined || model === undefined) return
                      setLeadModelSelection({
                        provider,
                        model,
                        ...info?.reasoning?.defaultEffort === undefined
                          ? {}
                          : { reasoningEffort: info.reasoning.defaultEffort },
                      })
                    }}
                  >
                    {advertisedModel(modelCatalog, leadModelSelection) ? null : <optgroup label={zh['workspace.review.models.current']}>
                      <option value={`${leadModelSelection.provider}\u0000${leadModelSelection.model}`}>{leadModelSelection.provider} / {leadModelSelection.model}</option>
                    </optgroup>}
                    {modelCatalog?.groups.map(group => <optgroup key={group.id} label={group.name}>
                      {group.models.map(model => <option key={`${group.id}:${model.id}`} value={`${group.id}\u0000${model.id}`}>{model.name}</option>)}
                    </optgroup>)}
                  </select>
                  {leadModelInfo?.reasoning === undefined ? null : <select
                    aria-label={copy('zh', 'workspace.review.models.effort', { expert: zh['workspace.chat.lead'] })}
                    value={leadModelSelection.reasoningEffort ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const reasoningEffort = event.currentTarget.value || undefined
                      const { reasoningEffort: _previousEffort, ...route } = leadModelSelection
                      setLeadModelSelection({
                        ...route,
                        ...reasoningEffort === undefined ? {} : { reasoningEffort },
                      })
                    }}
                  >{leadModelInfo.reasoning.defaultEffort === undefined ? <option value="">{zh['workspace.review.models.effort.default']}</option> : null}
                    {leadModelInfo.reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                  </select>}
                </>
                : <span className={modelCatalogState === 'error' ? css.modelCatalogError : css.modelCatalogHint}>{modelCatalogState === 'error' ? zh['workspace.review.models.error'] : zh['workspace.review.models.loading']}</span>}
            </div>
          </article>
          <div className={css.reviewRoster}>{run.experts.map((expert, index) => {
            const skills = skillSelections[expert.id] ?? expert.binding.skills.map(skill => skill.id)
            const dynamicSkills = dynamicCapabilityLabels(expert)
            const foundation = expert.binding.foundation
            const expertName = collaborationRunParticipantName(run, expert.name, 'expert', 'zh')
            const selectedModel = modelSelections[expert.id]
            const selectedGroup = modelCatalog?.groups.find(group => group.id === selectedModel?.provider)
            const selectedModelInfo = selectedGroup?.models.find(model => model.id === selectedModel?.model)
            const reasoning = selectedModelInfo?.reasoning
            const normalizedQuery = skillQuery.trim().toLocaleLowerCase()
            const availableOptions = skillOptions.filter((option) => {
              if (skills.includes(option.id)) return false
              if (normalizedQuery === '') return true
              const display = collaborationDisplayText(option.label, 'zh')
              return `${option.id} ${display} ${option.description}`.toLocaleLowerCase().includes(normalizedQuery)
            }).slice(0, 8)
            return <article key={expert.id} data-review-expert={expert.id}>
              <header><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{expertName}</h3><p>{collaborationDisplayText(expert.role, 'zh')}</p></div></header>
              <dl>
                <div><dt>{zh['workspace.review.expert.preset']}</dt><dd><span>{expert.binding.preset.label}</span></dd></div>
                <div><dt>{zh['workspace.review.expert.model']}</dt><dd className={css.modelControls}>
                  {modelCatalogState === 'ready' && selectedModel !== undefined
                    ? <>
                      <select
                        aria-label={copy('zh', 'workspace.review.models.select', { expert: expertName })}
                        value={`${selectedModel.provider}\u0000${selectedModel.model}`}
                        disabled={busy}
                        onChange={(event) => {
                          const [provider, model] = event.currentTarget.value.split('\u0000')
                          const info = modelCatalog?.groups.find(group => group.id === provider)?.models.find(value => value.id === model)
                          if (provider === undefined || model === undefined) return
                          setModelSelections(current => ({
                            ...current,
                            [expert.id]: {
                              provider,
                              model,
                              ...info?.reasoning?.defaultEffort === undefined
                                ? {}
                                : { reasoningEffort: info.reasoning.defaultEffort },
                            },
                          }))
                        }}
                      >
                        {advertisedModel(modelCatalog, selectedModel) ? null : <optgroup label={zh['workspace.review.models.current']}>
                          <option value={`${selectedModel.provider}\u0000${selectedModel.model}`}>{selectedModel.provider} / {selectedModel.model}</option>
                        </optgroup>}
                        {modelCatalog?.groups.map(group => <optgroup key={group.id} label={group.name}>
                          {group.models.map(model => <option key={`${group.id}:${model.id}`} value={`${group.id}\u0000${model.id}`}>{model.name}</option>)}
                        </optgroup>)}</select>
                      {reasoning === undefined ? null : <select
                        aria-label={copy('zh', 'workspace.review.models.effort', { expert: expertName })}
                        value={selectedModel.reasoningEffort ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const reasoningEffort = event.currentTarget.value || undefined
                          const { reasoningEffort: _previousEffort, ...route } = selectedModel
                          setModelSelections(current => ({
                            ...current,
                            [expert.id]: {
                              ...route,
                              ...reasoningEffort === undefined ? {} : { reasoningEffort },
                            },
                          }))
                        }}
                      >{reasoning.defaultEffort === undefined ? <option value="">{zh['workspace.review.models.effort.default']}</option> : null}
                        {reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                      </select>}
                    </>
                    : <span>{modelCatalogState === 'loading'
                      ? zh['workspace.review.models.loading']
                      : modelCatalogState === 'error'
                        ? zh['workspace.review.models.error']
                        : foundation === undefined
                          ? zh['workspace.review.expert.legacy']
                          : foundation.model.mode === 'inherit_lead'
                            ? zh['workspace.review.expert.model.inherit']
                            : `${foundation.model.provider ?? '—'} / ${foundation.model.model ?? '—'}`}</span>}
                </dd></div>
                <div><dt>{zh['workspace.review.expert.tools']}</dt><dd><span>{foundation === undefined
                  ? zh['workspace.review.expert.legacy']
                  : foundation.tools.access === 'full_preset'
                    ? zh['workspace.review.expert.tools.full']
                    : zh['workspace.review.expert.tools.restricted']}</span></dd></div>
                <div><dt>{zh['workspace.review.expert.permissions']}</dt><dd><span>{foundation === undefined
                  ? zh['workspace.review.expert.legacy']
                  : foundation.permissions.sandboxMode === 'inherit_lead'
                    ? zh['workspace.review.expert.permissions.inherit']
                    : `${foundation.permissions.sandboxMode} · ${foundation.permissions.approvalPolicy === 'ask'
                      ? zh['workspace.review.expert.approval.ask']
                      : zh['workspace.review.expert.approval.never']}`}</span></dd></div>
                <div><dt>{zh['workspace.review.expert.skills']}</dt><dd className={css.editableSkills}>{skills.map(skill => (
                  <span className={css.skillChip} key={skill} data-review-skill={skill}>
                    <span title={skill}>{collaborationDisplayText(skill, 'zh')}</span>
                    <button
                      type="button"
                      disabled={busy || skills.length <= skillFloor}
                      aria-label={copy('zh', 'workspace.review.skills.remove', { skill: collaborationDisplayText(skill, 'zh'), expert: expertName })}
                      title={skills.length <= skillFloor ? copy('zh', 'workspace.review.skills.minimum', { count: skillFloor }) : zh['workspace.review.skills.remove.short']}
                      onClick={() => { setExpertSkills(expert.id, skills.filter(value => value !== skill)) }}
                    ><IconCloseOutline16 size={10} aria-hidden="true" /></button>
                  </span>
                ))}<button
                  type="button"
                  className={css.addSkillButton}
                  disabled={busy || skillCatalogState === 'error'}
                  aria-expanded={editingExpertId === expert.id}
                  onClick={() => {
                    setEditingExpertId(current => current === expert.id ? null : expert.id)
                    setSkillQuery('')
                  }}
                ><IconPlusOutline16 size={10} aria-hidden="true" />{zh['workspace.review.skills.add']}</button></dd></div>
                {dynamicSkills.length === 0 ? null : <div><dt>{zh['workspace.review.expert.dynamicSkills']}</dt><dd>{dynamicSkills.map(skill => <span key={skill}>{collaborationDisplayText(skill, 'zh')}</span>)}</dd></div>}
                <div><dt>{zh['workspace.review.expert.plugins']}</dt><dd>{expert.binding.plugins.length === 0 ? <span>{zh['workspace.review.expert.none']}</span> : expert.binding.plugins.map(plugin => <span key={plugin.id}>{plugin.label}</span>)}</dd></div>
              </dl>
              {editingExpertId !== expert.id ? null : <section className={css.skillEditor} aria-label={copy('zh', 'workspace.review.skills.editor', { expert: expertName })}>
                <label htmlFor={`skill-search-${expert.id}`}>{zh['workspace.review.skills.search']}</label>
                <div className={css.skillSearch}><IconSearchOutline16 size={13} aria-hidden="true" /><input
                  id={`skill-search-${expert.id}`}
                  type="search"
                  value={skillQuery}
                  autoComplete="off"
                  placeholder={zh['workspace.review.skills.search.placeholder']}
                  onChange={(event) => { setSkillQuery(event.currentTarget.value) }}
                /></div>
                {skillCatalogState === 'loading' ? <p className={css.skillHint}>{zh['workspace.review.skills.loading']}</p> : null}
                {skillCatalogState === 'error' ? <p className={css.skillCatalogError} role="alert">{zh['workspace.review.skills.error']}</p> : null}
                {skillCatalogState !== 'ready' ? null : availableOptions.length === 0
                  ? <p className={css.skillHint}>{zh['workspace.review.skills.empty']}</p>
                  : <ul className={css.skillResults}>{availableOptions.map(option => <li key={option.id}><button
                    type="button"
                    disabled={busy}
                    onClick={() => { setExpertSkills(expert.id, [...skills, option.id]); setSkillQuery('') }}
                  ><span><strong>{collaborationDisplayText(option.label, 'zh')}</strong><small>{option.id}</small></span><p>{option.description}</p><IconPlusOutline16 size={12} aria-hidden="true" /></button></li>)}</ul>}
              </section>}
            </article>
          })}</div>
          <div className={css.skillChangeBar} data-dirty={hasSkillChanges}>
            <div><strong>{hasSkillChanges ? zh['workspace.review.skills.changed'] : zh['workspace.review.skills.ready']}</strong><p>{copy('zh', 'workspace.review.skills.help', { count: skillFloor })}</p></div>
            <button type="button" className={css.secondaryButton} disabled={busy || !hasSkillChanges} onClick={() => { onApplySkills(skillRequirement) }}>{action === 'revising' ? zh['workspace.review.skills.applying'] : zh['workspace.review.skills.apply']}</button>
          </div>
          <div className={css.modelChangeBar} data-dirty={hasModelChanges}>
            <div><strong>{hasModelChanges ? zh['workspace.review.models.changed'] : zh['workspace.review.models.ready']}</strong><p>{zh['workspace.review.models.help']}</p></div>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={busy || !hasModelChanges || modelCatalogState !== 'ready'}
              onClick={() => {
                if (leadModelSelection === null) return
                onApplyModels(leadModelSelection, run.experts.flatMap((expert, index) => {
                  const selection = modelSelections[expert.id]
                  return selection === undefined ? [] : [{ slotId: `slot-${String(index + 1)}`, selection }]
                }))
              }}
            >{action === 'revising' ? zh['workspace.review.models.applying'] : zh['workspace.review.models.apply']}</button>
          </div>
        </section>

        {externalCapabilities.length === 0 ? null : <section className={css.reviewSection} aria-labelledby="review-external-title">
          <header><div><span>03</span><h2 id="review-external-title">{zh['workspace.review.external']}</h2></div><small>{zh['workspace.review.external.help']}</small></header>
          <div className={css.externalReadiness} data-state={credentialState}>
            {externalCapabilities.map((capability) => {
              const credential = credentials.find(value => value.ref === capability.ref)
              const configured = credential?.configured === true
              const writable = credential?.writable === true
              const value = credentialInputs[capability.ref] ?? ''
              return <article key={capability.ref} data-external-capability={capability.ref} data-configured={configured}>
                <div className={css.externalIdentity}>
                  <span aria-hidden="true">{configured ? '✓' : '·'}</span>
                  <div><strong>{capability.label}</strong><small>{zh['workspace.review.external.selected']}</small></div>
                </div>
                <span className={css.externalStatus} data-ready={configured}>{credentialState === 'loading'
                  ? zh['workspace.review.external.loading']
                  : credentialState === 'error'
                    ? zh['workspace.review.external.error']
                    : configured
                      ? zh['workspace.review.external.ready']
                      : writable
                        ? zh['workspace.review.external.missing']
                        : zh['workspace.review.external.unavailable']}</span>
                {configured || !writable ? null : <div className={css.credentialEditor}>
                  <input
                    type="password"
                    autoComplete="off"
                    aria-label={`${capability.label} ${zh['workspace.review.external.secret']}`}
                    placeholder={zh['workspace.review.external.secret']}
                    value={value}
                    disabled={busy || savingCredential !== null}
                    onChange={(event) => {
                      setCredentialInputs(current => ({ ...current, [capability.ref]: event.currentTarget.value }))
                    }}
                  />
                  <button
                    type="button"
                    className={css.secondaryButton}
                    disabled={busy || savingCredential !== null || value.trim() === ''}
                    onClick={() => { void storeCredential(capability.ref) }}
                  >{savingCredential === capability.ref ? zh['workspace.review.external.saving'] : zh['workspace.review.external.save']}</button>
                </div>}
                {capability.ref === 'COMPOSIO_API_KEY' ? <p>{zh['workspace.review.external.composio.help']}</p> : null}
              </article>
            })}
          </div>
        </section>}

        <section className={css.revisionBox}>
          <label htmlFor="collaboration-revision">{zh['workspace.review.revision']}</label>
          <textarea id="collaboration-revision" rows={3} value={revision} disabled={busy} placeholder={zh['workspace.review.revision.placeholder']} onChange={(event) => { onRevision(event.currentTarget.value) }} />
          <button type="button" className={css.secondaryButton} disabled={busy || revision.trim() === ''} onClick={onRegenerate}>{action === 'revising' ? zh['workspace.review.regenerating'] : zh['workspace.review.regenerate']}</button>
        </section>
        {error === null ? null : <p className={css.error} role="alert">{error}</p>}
        <footer className={css.reviewActions}>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={onBack}>{action === 'back' ? '正在返回…' : zh['workspace.review.back']}</button>
          <button type="button" className={css.primaryButton} disabled={busy || hasSkillChanges || hasModelChanges || tasks.length === 0 || run.experts.length < 3} onClick={onConfirm}>{action === 'confirming' ? zh['workspace.review.confirming'] : zh['workspace.review.confirm']}</button>
        </footer>
      </section>
    </main>
  )
}

function ActiveRun({ run, language, startError, confirming, onRetryStart, onOpenPanel, onNew, onLeave }: {
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
  startError: string | null
  confirming: boolean
  onRetryStart: () => void
  onOpenPanel: () => void
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
        {startError === null ? null : (
          <div className={css.executionError} role="alert">
            <p>{startError}</p>
            <button type="button" className={css.secondaryButton} disabled={confirming} onClick={onRetryStart}>
              {confirming ? zh['workspace.review.confirming'] : '重试启动主协调智能体'}
            </button>
          </div>
        )}
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
                            <p data-task-description>{taskDescription(task.description)}</p>
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
          <button type="button" className={css.secondaryButton} onClick={onOpenPanel}>{copy(language, 'workspace.panel.open')}</button>
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
  listCollaborationSkills,
  listCollaborationModels,
  describeCollaborationCredentials,
  setCollaborationCredential,
  startCollaboration,
  confirmCollaboration,
  cancelCollaboration,
  refreshCollaboration,
  openCollaboration,
  prepareNewCollaboration,
  leaveCollaboration,
}: CollaborationWorkspaceProps) {
  const catalog = useCollaboration(value => value)
  const [objective, setObjective] = useState('')
  const [activeRunId, setActiveRunId] = useState<CollaborationRunId | null>(null)
  const [starting, setStarting] = useState(false)
  const [reviewAction, setReviewAction] = useState<'confirming' | 'revising' | 'back' | null>(null)
  const [revision, setRevision] = useState('')
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef(refreshCollaboration)
  const recoveredCatalogRef = useRef(false)
  const recoveredActiveRunRef = useRef<CollaborationRunId | null>(null)
  refreshRef.current = refreshCollaboration
  const activeRun = useMemo(
    () => activeRunId === null ? undefined : catalog.runs.find(run => run.id === activeRunId),
    [activeRunId, catalog.runs],
  )

  useEffect(() => {
    if (recoveredCatalogRef.current || catalog.state === 'loading') return
    recoveredCatalogRef.current = true
    const recovered = preferredActiveCollaborationRun(catalog.runs)
    if (recovered === undefined) return
    if (recovered.phase !== 'planning') recoveredActiveRunRef.current = recovered.id
    setActiveRunId(recovered.id)
  }, [catalog.runs, catalog.state])

  useEffect(() => {
    if (activeRun === undefined || recoveredActiveRunRef.current !== activeRun.id) return
    recoveredActiveRunRef.current = null
    openCollaboration()
  }, [activeRun, openCollaboration])

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
      setError(zh['workspace.error'])
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

  const confirm = async (): Promise<void> => {
    if (activeRun === undefined || reviewAction !== null) return
    setReviewAction('confirming')
    setError(null)
    try {
      await confirmCollaboration(activeRun.id)
    } catch {
      setError(zh['workspace.review.error'])
    } finally {
      setReviewAction(null)
    }
  }

  const replaceDraft = async (
    revisedObjective: string,
    leadModel: CollaborationExpertModelSelection['selection'] | undefined,
    expertModels: readonly CollaborationExpertModelSelection[],
  ): Promise<void> => {
    if (activeRun === undefined || reviewAction !== null) return
    setReviewAction('revising')
    setError(null)
    try {
      const runId = await startCollaboration({
        title: taskTitle(revisedObjective.split(PLAN_ADJUSTMENT_MARKER)[0] ?? revisedObjective),
        objective: revisedObjective,
        language: activeRun.language,
        ...leadModel === undefined ? {} : { leadModel },
        expertModels,
      })
      try {
        await cancelCollaboration(activeRun.id)
      } catch (error: unknown) {
        try {
          await cancelCollaboration(runId)
        } catch (rollbackError: unknown) {
          console.error('[ui-collaboration] failed to cancel replacement draft after original cancellation failed:', rollbackError)
        }
        throw error
      }
      setActiveRunId(runId)
      setRevision('')
    } catch {
      setError(zh['workspace.review.error'])
    } finally {
      setReviewAction(null)
    }
  }

  const regenerateFrom = async (adjustment: string): Promise<void> => {
    if (activeRun === undefined || reviewAction !== null || adjustment.trim() === '') return
    await replaceDraft(
      revisedCollaborationObjective(activeRun.objective, adjustment.trim()),
      selectedLeadModel(activeRun),
      selectedExpertModels(activeRun),
    )
  }

  const regenerate = async (): Promise<void> => {
    await regenerateFrom(revision)
  }

  const backToObjective = async (): Promise<void> => {
    if (activeRun === undefined || reviewAction !== null) return
    setReviewAction('back')
    setError(null)
    try {
      await cancelCollaboration(activeRun.id)
      prepareNewCollaboration()
      setObjective(activeRun.objective)
      setActiveRunId(null)
      setRevision('')
    } catch {
      setError(zh['workspace.review.error'])
    } finally {
      setReviewAction(null)
    }
  }

  if (activeRun !== undefined) {
    if (activeRun.phase === 'planning' || reviewAction === 'revising' || reviewAction === 'back') {
      return (
        <PlanReview
          run={activeRun}
          action={reviewAction}
          revision={revision}
          error={error}
          onRevision={(value) => { setRevision(value); setError(null) }}
          onConfirm={() => { void confirm() }}
          onRegenerate={() => { void regenerate() }}
          onApplySkills={(requirement) => { void regenerateFrom(requirement) }}
          onApplyModels={(leadModel, models) => { void replaceDraft(activeRun.objective, leadModel, models) }}
          onBack={() => { void backToObjective() }}
          onLeave={leaveCollaboration}
          loadSkills={listCollaborationSkills}
          loadModels={listCollaborationModels}
          describeCredentials={describeCollaborationCredentials}
          saveCredential={async (ref, value) => {
            await setCollaborationCredential(ref, value)
            await replaceDraft(
              activeRun.objective,
              selectedLeadModel(activeRun),
              selectedExpertModels(activeRun),
            )
          }}
        />
      )
    }
    return (
      <ActiveRun
        run={activeRun}
        language={activeRun.language}
        startError={error}
        confirming={reviewAction === 'confirming'}
        onRetryStart={() => { void confirm() }}
        onOpenPanel={openCollaboration}
        onNew={newTask}
        onLeave={leaveCollaboration}
      />
    )
  }

  return (
    <main className={css.launcher} data-collaboration-workspace="launcher">
      <header className={css.launcherHeader}>
        <button type="button" className={css.quietButton} onClick={leaveCollaboration}>
          <IconCloseOutline16 size={15} aria-hidden="true" />
          {zh['workspace.daily']}
        </button>
      </header>
      <section className={css.launcherBody}>
        <div className={css.intro}>
          <span className={css.badge}><IconBranchOutline16 size={14} aria-hidden="true" />{zh['workspace.badge']}</span>
          <h1>{zh['workspace.title']}</h1>
          <p>{zh['workspace.subtitle']}</p>
        </div>

        <div className={css.composer}>
          <label htmlFor="collaboration-objective">{zh['workspace.objective']}</label>
          <textarea
            id="collaboration-objective"
            value={objective}
            rows={7}
            maxLength={12_000}
            placeholder={zh['workspace.placeholder']}
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
            <span>{zh['workspace.shortcut']}</span>
            <button type="button" className={css.primaryButton} disabled={objective.trim() === '' || starting} onClick={() => { void start() }}>
              {starting ? zh['workspace.starting'] : zh['workspace.start']}
              {!starting ? <IconChevronRightOutline14 size={14} aria-hidden="true" /> : null}
            </button>
          </div>
          {error === null ? null : <p className={css.error} role="alert">{error}</p>}
        </div>

        <div className={css.examples} aria-label={zh['workspace.examples']}>
          <span>{zh['workspace.examples']}</span>
          {[zh['workspace.example.research'], zh['workspace.example.product'], zh['workspace.example.development']].map(example => (
            <button type="button" key={example} onClick={() => { setObjective(example); setError(null) }}>{example}</button>
          ))}
        </div>

        <section className={css.guarantees} aria-label={zh['workspace.guarantees']}>
          <article><span>01</span><div><strong>{zh['workspace.guarantee.team']}</strong><p>{zh['workspace.guarantee.team.body']}</p></div></article>
          <article><span>02</span><div><strong>{zh['workspace.guarantee.binding']}</strong><p>{zh['workspace.guarantee.binding.body']}</p></div></article>
          <article><span>03</span><div><strong>{zh['workspace.guarantee.public']}</strong><p>{zh['workspace.guarantee.public.body']}</p></div></article>
        </section>
      </section>
    </main>
  )
}
