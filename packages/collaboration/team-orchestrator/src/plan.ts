/** Exact ExpertBlueprint selection, topology choice, and charter construction. */

import { TeamRunError } from '@deepseek-ai/dsh-agent-team'
import type { ExpertBlueprint, ExpertBlueprintRef } from '@deepseek-ai/dsh-expert-catalog'
import { TeamPlanSlotId } from './ids.ts'
import { collaborationObjectiveParts } from './requirements.ts'
import type {
  Config,
  CurrentTeamPlan,
  AssignedTeamWorkstream,
  PlannedExpert,
  TaskProfile,
  TeamBlueprintPool,
  TeamCharter,
  TeamExecutionStage,
  TeamPlan,
  TeamTopology,
  TeamWorkstream,
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

function inferredTaskDag(profile: TaskProfile, language: 'zh' | 'en'): TeamWorkstream[] {
  const description = collaborationObjectiveParts(profile.objective).objective
  if (profile.domain === 'research_analysis') {
    return [
      {
        id: 'verify-evidence',
        subject: language === 'zh' ? '核验事实与证据' : 'Verify facts and evidence',
        description: language === 'zh'
          ? `核验任务前提、关键事实、来源时效与不确定性：${description}`
          : `Verify premises, key facts, source recency, and uncertainty for: ${description}`,
        blockedBy: [], requiredCapabilities: ['evidence', 'research'], resourceScopes: ['evidence'],
      },
      {
        id: 'analyze-core',
        subject: language === 'zh' ? '开展多维分析' : 'Conduct multidimensional analysis',
        description: language === 'zh'
          ? `从任务相关的市场、产品、技术与利益相关方维度形成结构化分析：${description}`
          : `Build a structured market, product, technical, and stakeholder analysis for: ${description}`,
        blockedBy: [], requiredCapabilities: ['analysis', 'market', 'technical'], resourceScopes: ['analysis'],
      },
      {
        id: 'challenge-findings',
        subject: language === 'zh' ? '交叉质疑与风险复核' : 'Challenge findings and review risks',
        description: language === 'zh'
          ? '交叉检查证据与分析，指出矛盾、反例、风险边界和仍待确认的问题'
          : 'Cross-check the evidence and analysis, surfacing contradictions, counterexamples, risk boundaries, and open questions',
        blockedBy: ['verify-evidence', 'analyze-core'], requiredCapabilities: ['review', 'risk'], resourceScopes: ['review'],
      },
      {
        id: 'synthesize-delivery',
        subject: language === 'zh' ? '综合判断与交付' : 'Synthesize judgment and delivery',
        description: language === 'zh'
          ? '吸收交叉评审结论，形成完整、可追溯且明确不确定性的最终判断'
          : 'Incorporate the cross-review into a complete, traceable final judgment with explicit uncertainty',
        blockedBy: ['challenge-findings'], requiredCapabilities: ['synthesis'], resourceScopes: ['final-delivery'],
      },
    ]
  }
  if (profile.domain === 'product_solution') {
    return [
      {
        id: 'clarify-users', subject: language === 'zh' ? '澄清用户与问题' : 'Clarify users and problems',
        description: language === 'zh' ? `明确目标用户、关键场景、真实问题与成功标准：${description}` : `Clarify users, scenarios, problems, and success criteria for: ${description}`,
        blockedBy: [], requiredCapabilities: ['research', 'product'], resourceScopes: ['product-discovery'],
      },
      {
        id: 'assess-constraints', subject: language === 'zh' ? '评估约束与可行性' : 'Assess constraints and feasibility',
        description: language === 'zh' ? '评估业务、技术、数据、合规与交付约束' : 'Assess business, technical, data, compliance, and delivery constraints',
        blockedBy: [], requiredCapabilities: ['technical', 'risk'], resourceScopes: ['feasibility'],
      },
      {
        id: 'design-solution', subject: language === 'zh' ? '设计产品方案' : 'Design the product solution',
        description: language === 'zh' ? '基于用户问题和约束设计核心流程、能力边界与实施方案' : 'Design core flows, capability boundaries, and implementation approach from the validated problems and constraints',
        blockedBy: ['clarify-users', 'assess-constraints'], requiredCapabilities: ['design', 'planning'], resourceScopes: ['product-solution'],
      },
      {
        id: 'validate-solution', subject: language === 'zh' ? '评审方案与验收' : 'Review and accept the solution',
        description: language === 'zh' ? '用成功指标、边界场景和风险清单评审方案并形成可交付版本' : 'Review the solution against success metrics, edge cases, and risks, then produce the deliverable version',
        blockedBy: ['design-solution'], requiredCapabilities: ['review', 'testing'], resourceScopes: ['acceptance'],
      },
    ]
  }
  const fullStack = /frontend|backend|前端|后端/iu.test(profile.objective)
  const implementation = fullStack
    ? [
      {
        id: 'implement-frontend', subject: language === 'zh' ? '实现前端改造' : 'Implement frontend changes',
        description: language === 'zh' ? '按确认方案实现前端行为、状态和交互' : 'Implement the approved frontend behavior, state, and interactions',
        blockedBy: ['design-implementation'], requiredCapabilities: ['implementation', 'frontend'], resourceScopes: ['frontend'],
      },
      {
        id: 'implement-backend', subject: language === 'zh' ? '实现后端改造' : 'Implement backend changes',
        description: language === 'zh' ? '按确认方案实现后端契约、业务规则和持久化行为' : 'Implement the approved backend contracts, business rules, and persistence behavior',
        blockedBy: ['design-implementation'], requiredCapabilities: ['implementation', 'backend'], resourceScopes: ['backend'],
      },
    ]
    : [{
      id: 'implement-change', subject: language === 'zh' ? '实现代码改造' : 'Implement the code changes',
      description: language === 'zh' ? `按确认方案完成代码改造：${description}` : `Implement the approved code changes for: ${description}`,
      blockedBy: ['design-implementation'], requiredCapabilities: ['implementation'], resourceScopes: ['implementation'],
    }]
  return [
    {
      id: 'design-implementation', subject: language === 'zh' ? '确认需求与实现方案' : 'Confirm requirements and implementation design',
      description: language === 'zh' ? `确认行为边界、影响范围、接口契约和验收标准：${description}` : `Confirm behavior boundaries, affected scope, contracts, and acceptance criteria for: ${description}`,
      blockedBy: [], requiredCapabilities: ['planning', 'architecture'], resourceScopes: ['implementation-plan'],
    },
    ...implementation,
    {
      id: 'verify-integration', subject: language === 'zh' ? '联调与完整测试' : 'Integrate and test completely',
      description: language === 'zh' ? '完成语法、逻辑、正常输入、边界输入和异常输入验证' : 'Verify syntax, logic, normal inputs, boundary inputs, and failure paths',
      blockedBy: implementation.map(task => task.id), requiredCapabilities: ['testing'], resourceScopes: ['test-results'],
    },
    {
      id: 'review-delivery', subject: language === 'zh' ? '代码评审与交付' : 'Review and deliver',
      description: language === 'zh' ? '复核需求覆盖、回归风险和测试证据后完成交付' : 'Review requirement coverage, regression risk, and test evidence before delivery',
      blockedBy: ['verify-integration'], requiredCapabilities: ['review'], resourceScopes: ['delivery'],
    },
  ]
}

/** Derive the exact execution DAG while preserving caller-authored workstreams verbatim. */
export function executionTaskDag(profile: TaskProfile): TeamWorkstream[] {
  return profile.workstreamSource === 'inferred'
    ? inferredTaskDag(profile, discussionLanguage(profile))
    : profile.workstreams.map(task => structuredClone(task))
}

/** Group a valid task DAG into deterministic dependency layers. */
export function executionStages(taskDag: readonly TeamWorkstream[]): TeamExecutionStage[] {
  const byId = new Map(taskDag.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const depths = new Map<string, number>()
  const depth = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) throw new TeamRunError('planned task DAG contains a cycle', 'TEAM_TASK_DEPENDENCY_CYCLE')
    const task = byId.get(id)
    if (task === undefined) throw new TeamRunError(`planned task "${id}" is missing`, 'TEAM_TASK_NOT_FOUND')
    visiting.add(id)
    const value = 1 + Math.max(0, ...task.blockedBy.map(depth))
    visiting.delete(id)
    depths.set(id, value)
    return value
  }
  const grouped = new Map<number, string[]>()
  for (const task of taskDag) {
    const order = depth(task.id)
    grouped.set(order, [...grouped.get(order) ?? [], task.id])
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right).map(([order, workstreamIds]) => ({
    id: `stage-${String(order)}`,
    order,
    mode: workstreamIds.length > 1 ? 'parallel' : 'serial',
    workstreamIds,
  }))
}

/** Apply exact reviewed task instructions before dependency-stage mutations can change visible stage numbering. */
export function applyTaskRequirements(taskDag: readonly TeamWorkstream[], profile: TaskProfile): TeamWorkstream[] {
  const adjusted = taskDag.map(task => structuredClone(task))
  const originalStages = executionStages(adjusted)
  for (const requirement of profile.planRequirements?.taskInstructions ?? []) {
    const index = requirement.taskOrder - 1
    const task = adjusted[index]
    if (task === undefined) {
      throw new TeamRunError(`requested task ${String(requirement.taskOrder)} does not exist`, 'TEAM_INVALID_ARGUMENT')
    }
    if (requirement.stageOrder !== undefined) {
      const stage = originalStages.find(candidate => candidate.workstreamIds.includes(task.id))
      if (stage === undefined) throw new Error(`planned task "${task.id}" is missing from dependency stages`)
      if (stage.order !== requirement.stageOrder) {
        throw new TeamRunError(
          `task ${String(requirement.taskOrder)} belongs to stage ${String(stage.order)} instead of requested stage ${String(requirement.stageOrder)}`,
          'TEAM_INVALID_ARGUMENT',
        )
      }
    }
    const language = discussionLanguage(profile)
    const label = language === 'zh' ? '输出要求：' : 'Delivery requirement: '
    const visibleInstruction = `${label}${requirement.instruction}`
    const documentCapabilities = /(?:飞书|lark|feishu).*(?:文档|doc)|(?:文档|doc).*(?:飞书|lark|feishu)/iu.test(requirement.instruction)
      ? ['document-delivery', 'lark-doc']
      : []
    adjusted[index] = {
      ...task,
      description: task.description.includes(visibleInstruction)
        ? task.description
        : `${task.description}\n${visibleInstruction}`,
      requiredCapabilities: [...new Set([...task.requiredCapabilities, ...documentCapabilities])],
      resourceScopes: [...new Set([
        ...task.resourceScopes,
        ...(documentCapabilities.length === 0 ? [] : ['deliverable:lark-doc']),
      ])],
    }
  }
  return adjusted
}

/** Apply reviewed stage-mode constraints to the task DAG so generation and durable replay share one canonical value. */
export function applyStageRequirements(taskDag: readonly TeamWorkstream[], profile: TaskProfile): TeamWorkstream[] {
  const adjusted = taskDag.map(task => structuredClone(task))
  const originalStages = executionStages(adjusted)
  for (const requirement of profile.planRequirements?.stageModes ?? []) {
    const stage = originalStages.find(value => value.order === requirement.order)
    if (stage === undefined) {
      throw new TeamRunError(`requested stage ${String(requirement.order)} does not exist`, 'TEAM_INVALID_ARGUMENT')
    }
    if (requirement.mode === 'parallel') {
      if (stage.workstreamIds.length < 2) {
        throw new TeamRunError(
          `requested stage ${String(requirement.order)} cannot be parallel because it contains fewer than two tasks`,
          'TEAM_INVALID_ARGUMENT',
        )
      }
      continue
    }
    for (let index = 1; index < stage.workstreamIds.length; index += 1) {
      const currentId = stage.workstreamIds[index]
      const previousId = stage.workstreamIds[index - 1]
      const current = adjusted.find(task => task.id === currentId)
      if (current === undefined || previousId === undefined) {
        throw new Error('reviewed stage references a missing task')
      }
      const blockedBy = [...new Set([...current.blockedBy, previousId])]
      adjusted[adjusted.indexOf(current)] = { ...current, blockedBy }
    }
  }
  return adjusted
}

function assignTaskDag(
  taskDag: readonly TeamWorkstream[],
  roster: readonly PlannedExpert[],
  blueprints: readonly ExpertBlueprint[],
): AssignedTeamWorkstream[] {
  const usage = new Map(roster.map(expert => [expert.slotId, 0]))
  return taskDag.map((task): AssignedTeamWorkstream => {
    const signals = task.requiredCapabilities.map(value => value.toLowerCase())
    const ranked = roster.map((expert, index) => {
      const blueprint = blueprints[index]
      if (blueprint === undefined) throw new Error(`planned expert blueprint ${String(index)} is missing`)
      const corpus = [blueprint.role, blueprint.objective, ...blueprint.skills, ...blueprint.plugins].join(' ').toLowerCase()
      const match = signals.reduce((score, signal) => score + (corpus.includes(signal) ? 10 : 0), 0)
      const used = usage.get(expert.slotId) ?? 0
      return { expert, index, score: match + (used === 0 ? 100 : 0) - used }
    }).sort((left, right) => right.score - left.score || left.index - right.index)
    const assignee = ranked[0]?.expert
    if (assignee === undefined) throw new TeamRunError('execution plan has no expert assignee', 'CAPABILITY_UNAVAILABLE')
    usage.set(assignee.slotId, (usage.get(assignee.slotId) ?? 0) + 1)
    return { ...structuredClone(task), assigneeSlotId: assignee.slotId }
  })
}

function expertIdentity(value: string): string {
  return value.toLowerCase().replace(/[\s·_.—-]+/gu, '').replace(/(?:agent|智能体)$/u, '')
}

/** Apply ordered review-time local-skill mutations to exact planned roster slots. */
function applyExpertSkillRequirements(
  roster: readonly PlannedExpert[],
  blueprints: readonly ExpertBlueprint[],
  profile: TaskProfile,
): PlannedExpert[] {
  const adjusted = roster.map((expert, index): PlannedExpert => {
    const blueprint = blueprints[index]
    if (blueprint === undefined) throw new Error(`planned expert blueprint ${String(index)} is missing`)
    return { ...expert, localSkills: [...new Set(blueprint.skills)] }
  })
  for (const requirement of profile.planRequirements?.expertSkills ?? []) {
    const matches = requirement.target === 'all'
      ? adjusted.map((_expert, index) => index)
      : adjusted.flatMap((expert, index) => {
        const blueprint = blueprints[index]
        if (blueprint === undefined) throw new Error(`planned expert blueprint ${String(index)} is missing`)
        const aliases = [
          expert.role,
          expert.name,
          blueprint.role,
          String(blueprint.ref.id),
          `expert-${String(index + 1)}`,
          `专家${String(index + 1)}`,
          `第${String(index + 1)}位专家`,
        ].map(expertIdentity)
        return aliases.includes(expertIdentity(requirement.target)) ? [index] : []
      })
    if (matches.length === 0) {
      throw new TeamRunError(`requested expert skill target "${requirement.target}" is not in the planned roster`, 'TEAM_INVALID_ARGUMENT')
    }
    if (requirement.target !== 'all' && matches.length > 1) {
      throw new TeamRunError(`requested expert skill target "${requirement.target}" is ambiguous`, 'TEAM_INVALID_ARGUMENT')
    }
    for (const index of matches) {
      const expert = adjusted[index]
      if (expert === undefined) throw new Error(`planned expert ${String(index)} is missing`)
      const current = expert.localSkills ?? []
      const localSkills = requirement.operation === 'replace'
        ? [...requirement.skills]
        : requirement.operation === 'add'
          ? [...new Set([...current, ...requirement.skills])]
          : current.filter(skill => !requirement.skills.includes(skill))
      if (localSkills.length === 0) {
        throw new TeamRunError(`requested expert "${expert.role}" cannot have an empty local skill set`, 'TEAM_INVALID_ARGUMENT')
      }
      adjusted[index] = { ...expert, localSkills }
    }
  }
  return adjusted
}

/** Apply validated review-time model routes to exact deterministic roster slots. */
function applyExpertModelRequirements(
  roster: readonly PlannedExpert[],
  profile: TaskProfile,
): PlannedExpert[] {
  const selected = new Map(
    (profile.planRequirements?.expertModels ?? []).map(entry => [entry.slotId, entry.selection]),
  )
  return roster.map((expert) => {
    const modelSelection = selected.get(expert.slotId)
    return modelSelection === undefined
      ? expert
      : { ...expert, modelSelection: structuredClone(modelSelection) }
  })
}

/**
 * Select exact immutable revisions and assignments for one durable team plan.
 * @param catalog - local immutable blueprint catalog.
 * @param config - exact domain pools and charter communication limits.
 * @param profile - committed automatic task profile.
 * @returns complete team plan.
 */
export function planTeam(catalog: PlannerCatalog, config: Config, profile: TaskProfile): CurrentTeamPlan {
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
  const selected = candidates.slice(0, profile.plannedExperts)
  const baseRoster = selected.map(({ blueprint }, index): PlannedExpert => {
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
  const roster = applyExpertModelRequirements(
    applyExpertSkillRequirements(
      baseRoster,
      selected.map(value => value.blueprint),
      profile,
    ),
    profile,
  )
  const taskDag = assignTaskDag(
    applyStageRequirements(applyTaskRequirements(executionTaskDag(profile), profile), profile),
    roster,
    selected.map(value => value.blueprint),
  )
  return { topology: topology(profile), roster, taskDag, stages: executionStages(taskDag) }
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
    stages: structuredClone(plan.stages ?? executionStages(plan.taskDag)),
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
