/** Deterministic task normalization, DAG analysis, and complexity classification. */

import { TeamRunError, type TeamRunComplexity } from '@deepseek-ai/dsh-agent-team'
import type {
  Config,
  CreateTeamOrchestrationRequest,
  TaskProfile,
  TeamWorkstream,
} from './types.ts'
import { TeamPlanSlotId } from './ids.ts'
import {
  collaborationObjectiveParts,
  normalizeCollaborationObjective,
  parseTeamPlanRequirements,
} from './requirements.ts'

const WORKSTREAM_ID = /^[a-z][a-z0-9-]{0,62}$/
const DOMAIN_SIGNALS: Readonly<Record<import('./types.ts').TeamTaskDomain, readonly RegExp[]>> = {
  research_analysis: [
    /research/iu, /analysis/iu, /benchmark/iu, /survey/iu,
    /acquisition/iu, /merger/iu, /strateg(?:y|ic)/iu, /pros? and cons?/iu, /trade-?offs?/iu,
    /valuation/iu, /antitrust/iu,
    /调研/u, /分析/u, /竞品/u, /市场/u, /文献/u, /研究/u,
    /收购/u, /并购/u, /战略/u, /利弊/u, /优劣/u, /综合判断/u, /估值/u, /反垄断/u,
  ],
  product_solution: [/\bprd\b/iu, /product/iu, /roadmap/iu, /user stor/iu, /产品/u, /需求/u, /原型/u, /方案/u],
  software_development: [
    /software/iu, /\bapi\b/iu, /frontend/iu, /backend/iu, /\bcode\b/iu,
    /开发(?!者)/u, /代码/u, /接口/u, /前端/u, /后端/u, /修复/u, /测试/u,
  ],
}
type TaskLanguage = 'zh' | 'en'

const ACTION_SIGNALS: readonly {
  readonly label: Readonly<Record<TaskLanguage, string>>
  readonly pattern: RegExp
  readonly capability: string
}[] = [
  { label: { zh: '调研', en: 'Research' }, pattern: /research|survey|benchmark|调研|检索|竞品/iu, capability: 'research' },
  { label: { zh: '分析', en: 'Analyze' }, pattern: /analy[sz]e|evaluate|分析|评估/iu, capability: 'analysis' },
  { label: { zh: '设计', en: 'Design' }, pattern: /design|prototype|设计|原型|方案/iu, capability: 'design' },
  { label: { zh: '规划', en: 'Plan' }, pattern: /plan|roadmap|\bprd\b|规划|需求/iu, capability: 'planning' },
  { label: { zh: '实现', en: 'Implement' }, pattern: /implement|\bdevelop(?:ment)?\b|build|code|开发(?!者)|实现|编码|前端|后端/iu, capability: 'implementation' },
  { label: { zh: '测试', en: 'Test' }, pattern: /\btest|testing|测试|验证/iu, capability: 'testing' },
  { label: { zh: '评审', en: 'Review' }, pattern: /review|audit|审查|评审|复核/iu, capability: 'review' },
  { label: { zh: '部署', en: 'Deploy' }, pattern: /deploy|release|launch|部署|发布|上线/iu, capability: 'deployment' },
]
const RISK_SIGNALS: readonly { readonly label: Readonly<Record<TaskLanguage, string>>; readonly pattern: RegExp }[] = [
  { label: { zh: '安全', en: 'security' }, pattern: /security|安全/iu },
  { label: { zh: '合规', en: 'compliance' }, pattern: /compliance|合规/iu },
  { label: { zh: '生产环境', en: 'production' }, pattern: /production|线上|生产/iu },
  { label: { zh: '迁移', en: 'migration' }, pattern: /migration|迁移/iu },
  { label: { zh: '高风险领域', en: 'high-stakes domain' }, pattern: /financial|medical|legal|金融|医疗|法律/iu },
]

function taskLanguage(request: CreateTeamOrchestrationRequest): TaskLanguage {
  const configured = request.context?.['productLanguage']?.trim().toLowerCase()
  if (configured === 'zh' || configured?.startsWith('zh-') === true) return 'zh'
  if (configured === 'en' || configured?.startsWith('en-') === true) return 'en'
  return /\p{Script=Han}/u.test(request.objective) ? 'zh' : 'en'
}

function assertText(value: string, label: string, maxBytes: number): string {
  const normalized = value.trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new TeamRunError(`${label} must be non-blank and at most ${String(maxBytes)} UTF-8 bytes`, 'TEAM_INVALID_ARGUMENT')
  }
  return normalized
}

function textList(values: readonly string[] | undefined, label: string, config: Config): string[] {
  if ((values?.length ?? 0) > config.maxListItems) {
    throw new TeamRunError(`${label} exceeds ${String(config.maxListItems)} items`, 'TEAM_INVALID_ARGUMENT')
  }
  const normalized = (values ?? []).map((value, index) => assertText(value, `${label}[${String(index)}]`, config.maxTextBytes))
  if (new Set(normalized).size !== normalized.length) {
    throw new TeamRunError(`${label} contains duplicate values`, 'TEAM_INVALID_ARGUMENT')
  }
  return normalized
}

function normalizeWorkstreams(
  request: CreateTeamOrchestrationRequest,
  config: Config,
  signalText: string,
  language: TaskLanguage,
): TeamWorkstream[] {
  let candidates = request.workstreams
  if (candidates?.length === 0 || candidates === undefined) {
    const segments = request.objective.split(/(?:\r?\n|[;；])+/u)
      .map(value => value.replace(/^\s*(?:[-*]|\d+[.)、])\s*/u, '').trim())
      .filter(Boolean)
    const actions = ACTION_SIGNALS.filter(signal => signal.pattern.test(signalText))
    const count = Math.min(config.maxWorkstreams, Math.max(1, segments.length, actions.length))
    candidates = Array.from({ length: count }, (_, index) => ({
      id: `objective-part-${String(index + 1)}`,
      subject: actions[index]?.label[language]
        ?? (language === 'zh' ? `目标分段 ${String(index + 1)}` : `Objective part ${String(index + 1)}`),
      description: segments[index] ?? request.objective,
      requiredCapabilities: actions[index] === undefined ? [] : [actions[index].capability],
    }))
  }
  if (candidates.length > config.maxWorkstreams) {
    throw new TeamRunError(`workstreams exceed ${String(config.maxWorkstreams)} items`, 'TEAM_INVALID_ARGUMENT')
  }
  const workstreams = candidates.map((candidate, index): TeamWorkstream => {
    if (!WORKSTREAM_ID.test(candidate.id)) {
      throw new TeamRunError(`workstreams[${String(index)}].id must be lower-kebab-case`, 'TEAM_INVALID_ARGUMENT')
    }
    return {
      id: candidate.id,
      subject: assertText(candidate.subject, `workstreams[${String(index)}].subject`, config.maxTextBytes),
      description: assertText(candidate.description, `workstreams[${String(index)}].description`, config.maxTextBytes),
      blockedBy: textList(candidate.blockedBy, `workstreams[${String(index)}].blockedBy`, config),
      requiredCapabilities: textList(candidate.requiredCapabilities, `workstreams[${String(index)}].requiredCapabilities`, config),
      resourceScopes: textList(candidate.resourceScopes, `workstreams[${String(index)}].resourceScopes`, config),
    }
  })
  const ids = new Set(workstreams.map(value => value.id))
  if (ids.size !== workstreams.length) {
    throw new TeamRunError('workstream ids must be unique', 'TEAM_INVALID_ARGUMENT')
  }
  for (const workstream of workstreams) {
    if (workstream.blockedBy.includes(workstream.id)
      || workstream.blockedBy.some(blocker => !ids.has(blocker))) {
      throw new TeamRunError(`workstream "${workstream.id}" has an invalid dependency`, 'TEAM_INVALID_ARGUMENT')
    }
  }
  return workstreams
}

function dependencyMetrics(workstreams: readonly TeamWorkstream[]): {
  readonly dependencyCount: number
  readonly independentWorkstreams: number
  readonly longestDependencyPath: number
} {
  const byId = new Map(workstreams.map(value => [value.id, value]))
  const visiting = new Set<string>()
  const lengths = new Map<string, number>()
  const visit = (id: string): number => {
    const known = lengths.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) throw new TeamRunError('workstream dependencies contain a cycle', 'TEAM_INVALID_ARGUMENT')
    visiting.add(id)
    const workstream = byId.get(id)
    if (workstream === undefined) throw new Error(`normalized workstream "${id}" is missing`)
    const length = 1 + Math.max(0, ...workstream.blockedBy.map(visit))
    visiting.delete(id)
    lengths.set(id, length)
    return length
  }
  return {
    dependencyCount: workstreams.reduce((sum, value) => sum + value.blockedBy.length, 0),
    independentWorkstreams: workstreams.filter(value => value.blockedBy.length === 0).length,
    longestDependencyPath: Math.max(...workstreams.map(value => visit(value.id))),
  }
}

function complexity(
  workstreamCount: number,
  capabilityCount: number,
  riskSignalCount: number,
  longestDependencyPath: number,
): TeamRunComplexity {
  if (workstreamCount >= 5 || capabilityCount >= 6 || riskSignalCount >= 4 || longestDependencyPath >= 4) {
    return 'complex'
  }
  if (workstreamCount === 1 && capabilityCount <= 2 && riskSignalCount <= 1 && longestDependencyPath === 1) {
    return 'simple'
  }
  return 'medium'
}

/**
 * Normalize one task and derive its exact legal expert-count band.
 * @param request - typed user task and optional decomposition hints.
 * @param config - deployment input bounds.
 * @returns complete durable task profile.
 */
export function profileTask(request: CreateTeamOrchestrationRequest, config: Config): TaskProfile {
  const submittedObjective = assertText(request.objective, 'objective', config.maxTextBytes)
  const objective = normalizeCollaborationObjective(submittedObjective)
  const planningObjective = collaborationObjectiveParts(objective).objective
  const language = taskLanguage({ ...request, objective })
  const signalText = `${request.context?.['productTitle'] ?? ''}\n${planningObjective}`
  const requestId = assertText(String(request.requestId), 'requestId', config.maxTextBytes)
  if (requestId !== request.requestId) throw new TeamRunError('requestId cannot contain surrounding whitespace', 'TEAM_INVALID_ARGUMENT')
  if (request.retryOf !== undefined) assertText(String(request.retryOf), 'retryOf', config.maxTextBytes)
  const workstreams = normalizeWorkstreams({ ...request, objective: planningObjective }, config, signalText, language)
  const successCriteria = request.successCriteria === undefined || request.successCriteria.length === 0
    ? [language === 'zh' ? '完成并评审用户提出的任务目标' : 'Complete and review the stated objective']
    : textList(request.successCriteria, 'successCriteria', config)
  const inferredRisks = RISK_SIGNALS.filter(signal => signal.pattern.test(signalText)).map(signal => signal.label[language])
  const riskSignals = textList([...new Set([...(request.riskSignals ?? []), ...inferredRisks])], 'riskSignals', config)
  const contextEntries = Object.entries(request.context ?? {})
  if (contextEntries.length > config.maxContextEntries) {
    throw new TeamRunError(`context exceeds ${String(config.maxContextEntries)} entries`, 'TEAM_INVALID_ARGUMENT')
  }
  const context = Object.fromEntries(contextEntries.sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [
    assertText(key, 'context key', config.maxTextBytes),
    assertText(value, `context.${key}`, config.maxTextBytes),
  ]))
  if (Object.keys(context).length !== contextEntries.length) {
    throw new TeamRunError('context keys must remain unique after normalization', 'TEAM_INVALID_ARGUMENT')
  }
  const dependency = dependencyMetrics(workstreams)
  const capabilities = new Set([
    ...workstreams.flatMap(value => value.requiredCapabilities.map(capability => capability.toLowerCase())),
    ...ACTION_SIGNALS.filter(signal => signal.pattern.test(signalText)).map(signal => signal.capability),
  ])
  const selectedComplexity = complexity(
    workstreams.length,
    capabilities.size,
    riskSignals.length,
    dependency.longestDependencyPath,
  )
  const plannedExperts = selectedComplexity === 'simple'
    ? 3
    : selectedComplexity === 'medium'
      ? Math.min(4, Math.max(3, workstreams.length))
      : Math.min(8, Math.max(5, workstreams.length, capabilities.size))
  const parsedPlanRequirements = parseTeamPlanRequirements(objective)
  const leadModelSelection = request.leadModel === undefined
    ? undefined
    : {
      provider: assertText(request.leadModel.provider, 'leadModel.provider', config.maxTextBytes),
      model: assertText(request.leadModel.model, 'leadModel.model', config.maxTextBytes),
      ...request.leadModel.reasoningEffort === undefined
        ? {}
        : {
          reasoningEffort: assertText(
            String(request.leadModel.reasoningEffort),
            'leadModel.reasoningEffort',
            config.maxTextBytes,
          ) as typeof request.leadModel.reasoningEffort,
        },
    }
  const expertModels = (request.expertModels ?? []).map((entry, index) => {
    const match = /^slot-([1-8])$/u.exec(entry.slotId)
    const slot = match === null ? Number.NaN : Number(match[1])
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > plannedExperts) {
      throw new TeamRunError(
        `expertModels[${String(index)}].slotId must address one planned roster slot`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
    const provider = assertText(entry.selection.provider, `expertModels[${String(index)}].provider`, config.maxTextBytes)
    const model = assertText(entry.selection.model, `expertModels[${String(index)}].model`, config.maxTextBytes)
    const reasoningEffort = entry.selection.reasoningEffort === undefined
      ? undefined
      : assertText(String(entry.selection.reasoningEffort), `expertModels[${String(index)}].reasoningEffort`, config.maxTextBytes)
    return {
      slotId: TeamPlanSlotId(entry.slotId),
      selection: {
        provider,
        model,
        ...reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as typeof entry.selection.reasoningEffort },
      },
    }
  })
  if (new Set(expertModels.map(entry => entry.slotId)).size !== expertModels.length) {
    throw new TeamRunError('expertModels contains duplicate roster slots', 'TEAM_INVALID_ARGUMENT')
  }
  const planRequirements = parsedPlanRequirements === undefined && expertModels.length === 0
    ? undefined
    : {
      ...parsedPlanRequirements,
      ...expertModels.length === 0 ? {} : { expertModels },
    }
  const rankedDomains = (Object.entries(DOMAIN_SIGNALS) as Array<[
    import('./types.ts').TeamTaskDomain,
    readonly RegExp[],
  ]>).map(([domain, patterns]) => ({ domain, score: patterns.filter(pattern => pattern.test(signalText)).length }))
    .sort((left, right) => right.score - left.score
      || ['software_development', 'product_solution', 'research_analysis'].indexOf(left.domain)
      - ['software_development', 'product_solution', 'research_analysis'].indexOf(right.domain))
  const inferredDomain = request.domain ?? (rankedDomains[0]?.score === 0
    ? 'research_analysis'
    : rankedDomains[0]?.domain ?? 'research_analysis')
  return {
    domain: inferredDomain,
    objective,
    successCriteria,
    workstreams,
    workstreamSource: request.workstreams === undefined || request.workstreams.length === 0 ? 'inferred' : 'explicit',
    riskSignals,
    context,
    complexity: selectedComplexity,
    plannedExperts,
    ...leadModelSelection === undefined ? {} : { leadModelSelection },
    ...planRequirements === undefined ? {} : { planRequirements },
    metrics: {
      workstreamCount: workstreams.length,
      dependencyCount: dependency.dependencyCount,
      independentWorkstreams: dependency.independentWorkstreams,
      longestDependencyPath: dependency.longestDependencyPath,
      capabilityCount: capabilities.size,
      riskSignalCount: riskSignals.length,
      decomposable: workstreams.length > 1,
      toolDensity: capabilities.size >= 6 ? 'high' : capabilities.size >= 3 ? 'medium' : 'low',
      risk: riskSignals.length >= 4 ? 'high' : riskSignals.length >= 2 ? 'medium' : 'low',
    },
  }
}
