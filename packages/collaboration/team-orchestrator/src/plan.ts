/** Exact ExpertBlueprint selection, topology choice, and charter construction. */

import { TeamRunError } from '@deepseek-ai/dsh-agent-team'
import type { ExpertBlueprint, ExpertBlueprintRef } from '@deepseek-ai/dsh-expert-catalog'
import { TeamPlanSlotId } from './ids.ts'
import type {
  Config,
  PlannedExpert,
  TaskProfile,
  TeamBlueprintPool,
  TeamCharter,
  TeamPlan,
  TeamTopology,
} from './types.ts'

/** Catalog operations required by the deterministic planner. */
export interface PlannerCatalog {
  get(ref: ExpertBlueprintRef): ExpertBlueprint
}

const ZH_BLUEPRINT_TEXT = new Map<string, string>([
  ['Claims are traceable to evidence', '关键结论可追溯到证据'],
  ['Uncertainty and contradictions are explicit', '明确标注不确定性与矛盾'],
  ['Every proposal maps to a user problem', '每项方案均对应具体用户问题'],
  ['Failure and acceptance states are testable', '失败状态与验收状态均可测试'],
  ['The requested behavior is verified', '已验证用户要求的行为'],
  ['Failure and boundary behavior are covered', '已覆盖失败与边界行为'],
  ['Evidence Researcher', '证据研究专家'],
  ['Market Analyst', '市场分析专家'],
  ['Competitive Intelligence Analyst', '竞品情报专家'],
  ['Policy and Regulatory Analyst', '政策与监管专家'],
  ['Data Analyst', '数据分析专家'],
  ['Technical Analyst', '技术分析专家'],
  ['Research Risk Reviewer', '调研风险评审专家'],
  ['Synthesis Reviewer', '综合评审专家'],
  ['Product Solution Analyst', '产品方案专家'],
  ['User Researcher', '用户研究专家'],
  ['Product Strategist', '产品策略专家'],
  ['Interaction Designer', '交互设计专家'],
  ['Workflow Architect', '工作流架构专家'],
  ['Metrics Designer', '指标设计专家'],
  ['Technical Feasibility Reviewer', '技术可行性评审专家'],
  ['Risk and Acceptance Reviewer', '风险与验收专家'],
  ['Implementation Engineer', '实现工程师'],
  ['Test Engineer', '测试工程师'],
  ['System Architect', '系统架构师'],
  ['Security Reviewer', '安全评审专家'],
  ['Performance Engineer', '性能工程师'],
  ['Reliability Engineer', '可靠性工程师'],
  ['Frontend and Accessibility Reviewer', '前端与无障碍评审专家'],
  ['Code Quality Reviewer', '代码质量评审专家'],
])

function blueprintText(value: string, language: 'zh' | 'en'): string {
  return language === 'zh' ? ZH_BLUEPRINT_TEXT.get(value) ?? value : value
}

function refKey(ref: ExpertBlueprintRef): string {
  return `${ref.id}@${String(ref.revision)}`
}

function topology(profile: TaskProfile): TeamTopology {
  if (profile.complexity === 'simple') return 'producer_reviewer'
  if (profile.complexity === 'medium') {
    return profile.metrics.dependencyCount > 0 ? 'centralized' : 'parallel'
  }
  return profile.metrics.longestDependencyPath >= 3 ? 'grouped' : 'hybrid'
}

interface WeightedCapability {
  readonly value: string
  readonly weight: number
}

const SPECIALIST_CAPABILITY_SIGNALS: readonly {
  readonly capability: WeightedCapability
  readonly pattern: RegExp
}[] = [
  { capability: { value: 'market', weight: 4 }, pattern: /market|commercial|valuation|pricing|revenue|收购|并购|估值|商业|市场/iu },
  { capability: { value: 'regulatory', weight: 5 }, pattern: /regulat|antitrust|policy|compliance|监管|反垄断|政策|合规/iu },
  { capability: { value: 'technical', weight: 4 }, pattern: /technical|architecture|integration|hardware|model|open[- ]source|技术|架构|整合|硬件|模型|开源/iu },
  { capability: { value: 'competitive', weight: 4 }, pattern: /competitive|competitor|positioning|竞争|竞品/iu },
  { capability: { value: 'data', weight: 3 }, pattern: /quantitative|\bdata\b|metric|statistics|数据|量化|指标/iu },
  { capability: { value: 'risk', weight: 3 }, pattern: /risk|downside|conflict|culture|retention|弊端|风险|冲突|文化|流失/iu },
  { capability: { value: 'synthesis', weight: 2 }, pattern: /synthes|conclusion|judg|recommend|综合判断|结论|建议/iu },
  { capability: { value: 'evidence', weight: 2 }, pattern: /evidence|source|verify|fact|证据|来源|核验|事实/iu },
]

function planningCapabilities(profile: TaskProfile): WeightedCapability[] {
  const weights = new Map<string, number>()
  for (const capability of profile.workstreams.flatMap(value => value.requiredCapabilities)) {
    weights.set(capability.toLowerCase(), Math.max(1, weights.get(capability.toLowerCase()) ?? 0))
  }
  const signalText = `${profile.context['productTitle'] ?? ''}\n${profile.objective}`
  for (const signal of SPECIALIST_CAPABILITY_SIGNALS) {
    if (!signal.pattern.test(signalText)) continue
    weights.set(
      signal.capability.value,
      Math.max(signal.capability.weight, weights.get(signal.capability.value) ?? 0),
    )
  }
  return [...weights].map(([value, weight]) => ({ value, weight }))
}

function relevance(blueprint: ExpertBlueprint, capabilities: readonly WeightedCapability[]): number {
  const corpus = [blueprint.role, blueprint.objective, ...blueprint.skills, ...blueprint.plugins].join(' ').toLowerCase()
  return capabilities.reduce((score, capability) => score + (corpus.includes(capability.value) ? capability.weight : 0), 0)
}

function poolFor(pools: readonly TeamBlueprintPool[], profile: TaskProfile): TeamBlueprintPool {
  const pool = pools.find(candidate => candidate.domain === profile.domain)
  if (pool === undefined) {
    throw new TeamRunError(`no ExpertBlueprint pool is configured for ${profile.domain}`, 'CAPABILITY_UNAVAILABLE')
  }
  return pool
}

/** Resolve the public discussion language from the browser-owned task context. */
function discussionLanguage(profile: TaskProfile): 'zh' | 'en' {
  const configured = profile.context['productLanguage']?.trim().toLowerCase()
  if (configured === 'zh' || configured?.startsWith('zh-') === true) return 'zh'
  if (configured === 'en' || configured?.startsWith('en-') === true) return 'en'
  return /\p{Script=Han}/u.test(profile.objective) ? 'zh' : 'en'
}

/**
 * Select exact immutable revisions and assignments for one durable team plan.
 * @param catalog - local immutable blueprint catalog.
 * @param config - exact domain pools and charter communication limits.
 * @param profile - committed automatic task profile.
 * @returns complete team plan.
 */
export function planTeam(catalog: PlannerCatalog, config: Config, profile: TaskProfile): TeamPlan {
  const pool = poolFor(config.pools, profile)
  const unique = new Set(pool.blueprints.map(refKey))
  if (unique.size !== pool.blueprints.length) {
    throw new TeamRunError(`ExpertBlueprint pool for ${profile.domain} contains duplicate revisions`, 'TEAM_INVALID_CONFIG')
  }
  const capabilities = planningCapabilities(profile)
  const candidates = pool.blueprints.map((ref, index) => ({
    ref,
    index,
    blueprint: catalog.get(ref),
  })).sort((left, right) => relevance(right.blueprint, capabilities) - relevance(left.blueprint, capabilities)
    || left.index - right.index)
  if (candidates.length < profile.plannedExperts) {
    throw new TeamRunError(
      `${profile.domain} requires ${String(profile.plannedExperts)} experts but only ${String(candidates.length)} exact blueprint revisions are available`,
      'CAPABILITY_UNAVAILABLE',
    )
  }
  const language = discussionLanguage(profile)
  const roster = candidates.slice(0, profile.plannedExperts).map(({ blueprint }, index): PlannedExpert => {
    const inputs = Object.fromEntries(blueprint.inputs.flatMap((field) => {
      const supplied = profile.context[field.name]
      if (supplied !== undefined) return [[field.name, supplied]]
      return field.required ? [[field.name, profile.objective]] : []
    }))
    return {
      slotId: TeamPlanSlotId(`slot-${String(index + 1)}`),
      name: `expert-${String(index + 1)}`,
      role: blueprintText(blueprint.role, language),
      blueprint: structuredClone(blueprint.ref),
      assignment: { objective: profile.objective, language, inputs },
      acceptanceCriteria: blueprint.acceptanceCriteria.map(value => blueprintText(value, language)),
      budget: structuredClone(blueprint.budget),
      skillDiscovery: { providers: [], mounts: [] },
    }
  })
  return { topology: topology(profile), roster, taskDag: structuredClone(profile.workstreams) }
}

/**
 * Materialize the Lead-readable charter without consulting mutable catalog state.
 * @param profile - committed task profile.
 * @param plan - committed exact blueprint plan.
 * @param config - communication policy to snapshot.
 * @returns complete durable team charter.
 */
export function charterTeam(profile: TaskProfile, plan: TeamPlan, config: Config): TeamCharter {
  return {
    objective: profile.objective,
    successCriteria: [...profile.successCriteria],
    topology: plan.topology,
    roster: plan.roster.map(({ slotId, name, role, blueprint }) => ({ slotId, name, role, blueprint: structuredClone(blueprint) })),
    taskDag: structuredClone(plan.taskDag),
    communication: structuredClone(config.communication[profile.complexity]),
    qualityChecks: [...new Set([
      ...profile.successCriteria,
      ...plan.roster.flatMap(expert => expert.acceptanceCriteria),
    ])],
    budgets: plan.roster.map(expert => ({ slotId: expert.slotId, execution: structuredClone(expert.budget) })),
    termination: {
      success: 'all_tasks_completed_and_reviewed',
      formationFailure: 'fail_closed',
    },
  }
}
