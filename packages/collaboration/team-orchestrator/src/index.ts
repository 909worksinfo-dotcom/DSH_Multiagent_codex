/** Durable automatic profiling, exact team planning, chartering, and fail-closed formation. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ProvisionAttemptId,
  TeamMemberId,
  TeamRunError,
  TeamRunId,
  TeamProtocolSlotId,
  TeamTaskId,
  type TeamFailure,
  type TeamRunPhase,
  type TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import type { ExpertBlueprint, ExpertBlueprintRef } from '@deepseek-ai/dsh-expert-catalog'
import { SessionId, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import type {
  SkillMarketplaceCapability,
  SkillMarketplaceProviderResult,
} from '@deepseek-ai/dsh-skill-marketplace'
import { digestJson } from './digest.ts'
import {
  applyTeamOrchestrationEvent,
  foldTeamOrchestration,
} from './fold.ts'
import {
  TeamOrchestrationEventId,
} from './ids.ts'
import { charterTeam, planTeam } from './plan.ts'
import { profileTask } from './profile.ts'
import type {
  CancelTeamOrchestrationRequest,
  Config,
  CreateTeamOrchestrationRequest,
  PlannedExpertSkillDiscovery,
  PlannedTeamWorkstream,
  ReplaceTeamExpertRequest,
  TeamCharterEventData,
  TeamOrchestrationCommand,
  TeamOrchestrationSnapshot,
  TeamPlanEventData,
  TeamProfileEventData,
} from './types.ts'

export type * from './types.ts'
export { TeamOrchestrationEventId, TeamOrchestrationRequestId, TeamPlanSlotId } from './ids.ts'
export { digestJson as digestTeamOrchestrationJson } from './digest.ts'
export {
  applyTeamOrchestrationEvent,
  emptyTeamOrchestrationFoldState,
  foldTeamOrchestration,
  isTeamOrchestrationEvent,
} from './fold.ts'
export { charterTeam, planTeam } from './plan.ts'
export { profileTask } from './profile.ts'
export {
  parseTeamCharterEvent,
  parseTeamPlanEvent,
  parseTeamProfileEvent,
} from './schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamOrchestrator: TeamOrchestrator
  }
}

type OrchestrationEventType =
  | 'collaboration/orchestration/profile'
  | 'collaboration/orchestration/plan'
  | 'collaboration/orchestration/charter'

type AppendOrchestrationEvent = <T extends OrchestrationEventType>(type: T, data: SessionEventMap[T]) => SessionEvent<T>

const TERMINAL_PHASES: ReadonlySet<TeamRunPhase> = new Set([
  'completed',
  'formation_failed',
  'failed',
  'cancelled',
])

/** Product invariant: every expert starts with a domain skill and an independent review skill. */
const MIN_LOCAL_SKILLS_PER_EXPERT = 2

type CompleteOrchestrationState = ReturnType<typeof foldTeamOrchestration> & {
  profile: TeamProfileEventData
  plan: TeamPlanEventData
  charter: TeamCharterEventData
}

class LeadLock {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /** @param leadId - exact Lead Session. @param operation - complete command. @returns command settlement. */
  async run<T>(leadId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(leadId) ?? Promise.resolve()
    const result = prior.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(leadId, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(leadId) === tail) this.tails.delete(leadId)
    }
  }

  /** @returns fulfillment after every currently queued command settles. */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()])
  }
}

function isTeamRunError(error: unknown, code?: string): error is TeamRunError {
  return error instanceof TeamRunError && (code === undefined || error.code === code)
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ').trim().slice(0, 2_000)
    || 'team formation failed'
}

function refKey(ref: ExpertBlueprintRef): string {
  return `${ref.id}@${String(ref.revision)}`
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const MARKETPLACE_QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'for', 'from', 'in', 'into', 'is',
  'of', 'on', 'or', 'please', 'the', 'to', 'using', 'with', 'without', 'would',
])

const MARKETPLACE_TASK_ENTITY_STOP_WORDS: ReadonlySet<string> = new Set([
  'ai', 'analysis', 'analyze', 'assess', 'build', 'compare', 'create', 'design', 'evaluate', 'explain',
  'give', 'please', 'provide', 'research', 'review', 'summarize',
])

/** Extract bounded marketplace terms without sending a long multilingual prompt to search providers. */
function marketplaceQueryTerms(value: string): string[] {
  return (value.match(/[A-Za-z][A-Za-z0-9.+#_-]*/gu) ?? [])
    .filter(token => token.length > 1 && !MARKETPLACE_QUERY_STOP_WORDS.has(token.toLowerCase()))
}

/** Build one deterministic provider-friendly query from role capability and task entity terms. */
function marketplaceSearchQuery(role: string, capabilityObjective: string, taskObjective: string): string {
  const terms = [
    ...marketplaceQueryTerms(role),
    ...marketplaceQueryTerms(capabilityObjective.replaceAll('_', ' ')),
    ...marketplaceQueryTerms(taskObjective),
  ]
  const seen = new Set<string>()
  const unique = terms.filter((term) => {
    const key = term.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return Array.from(unique.join(' ')).slice(0, 240).join('')
}

/** Extract likely product, company, protocol, or proper-name terms from one task prompt. */
function marketplaceTaskEntityTerms(taskObjective: string): string[] {
  return marketplaceQueryTerms(taskObjective).filter((term) => {
    const lower = term.toLowerCase()
    if (MARKETPLACE_TASK_ENTITY_STOP_WORDS.has(lower)) return false
    return term.includes('-') || term.includes('.') || /^[A-Z][A-Za-z0-9]+$/u.test(term) || /^[A-Z0-9]{2,}$/u.test(term)
  })
}

/** Whether safe capability metadata directly names at least one task entity term. */
function capabilityMatchesTaskEntity(
  capability: { readonly name: string; readonly description: string },
  entityTerms: readonly string[],
): boolean {
  const compact = `${capability.name} ${capability.description}`.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
  return entityTerms.some((term) => {
    const needle = term.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
    return needle.length >= 3 && compact.includes(needle)
  })
}

const REMOTE_TOOL_ACTIONS = [
  /\b(?:access|authenticate|authorize|call|connect|invoke|use|using|via)\b/iu,
  /\b(?:create|delete|download|export|fetch|import|manage|publish|query|read|send|sync|update|upload|write)\b/iu,
  /(?:使用|调用|通过|连接|接入|授权|登录)/u,
  /(?:同步|导入|导出|上传|下载|创建|新建|修改|更新|删除|发送|发布|写入|读取|查询|管理)/u,
] as const
const REMOTE_TOOL_SURFACE = /(?:\b(?:api|connector|integration|mcp|plugin|server|tool)\b|接口|连接器|集成|插件|工具|远程服务)/iu
const REMOTE_TOOL_INTENT_RADIUS = 40

/**
 * A topical entity mention is not permission to bind a third-party tool. Require an explicit
 * nearby operation or integration surface so ordinary research continues through the Agent's
 * built-in web foundation without producing an unrelated authorization step.
 */
function taskExplicitlyRequestsRemoteCapability(
  taskObjective: string,
  capability: { readonly name: string; readonly description: string },
  entityTerms: readonly string[],
): boolean {
  const lowerObjective = taskObjective.toLocaleLowerCase()
  const lowerCapability = `${capability.name} ${capability.description}`.toLocaleLowerCase()
  const needles = [capability.name, ...entityTerms.filter(term => lowerCapability.includes(term.toLocaleLowerCase()))]
    .map(value => value.trim().toLocaleLowerCase())
    .filter((value, index, values) => value.length >= 3 && values.indexOf(value) === index)
  for (const needle of needles) {
    let offset = lowerObjective.indexOf(needle)
    while (offset >= 0) {
      const before = taskObjective.slice(Math.max(0, offset - REMOTE_TOOL_INTENT_RADIUS), offset)
      const after = taskObjective.slice(
        offset + needle.length,
        Math.min(taskObjective.length, offset + needle.length + REMOTE_TOOL_INTENT_RADIUS),
      )
      if (REMOTE_TOOL_ACTIONS.some(pattern => pattern.test(before) || pattern.test(after))
        || REMOTE_TOOL_SURFACE.test(before) || REMOTE_TOOL_SURFACE.test(after)) return true
      offset = lowerObjective.indexOf(needle, offset + needle.length)
    }
  }
  return false
}

interface ExpertSkillSearch {
  readonly blueprint: ExpertBlueprint
  readonly providers: readonly Pick<SkillMarketplaceProviderResult, 'source' | 'state'>[]
  readonly candidates: readonly SkillMarketplaceCapability[]
}

function capabilityReadiness(value: SkillMarketplaceCapability): number {
  return value.status === 'loaded' ? 0 : value.status === 'connected' ? 1 : 2
}

/** Stable candidate order: executable method guidance, then connected tools, then authorization-gated tools. */
function compareMarketplaceCapabilities(
  left: SkillMarketplaceCapability,
  right: SkillMarketplaceCapability,
): number {
  return (left.kind === 'method_skill' ? 0 : 1) - (right.kind === 'method_skill' ? 0 : 1)
    || capabilityReadiness(left) - capabilityReadiness(right)
    || (right.popularity ?? 0) - (left.popularity ?? 0)
    || left.id.localeCompare(right.id)
}

const CAPABILITY_ROLE_STOP_WORDS: ReadonlySet<string> = new Set([
  ...MARKETPLACE_QUERY_STOP_WORDS,
  ...MARKETPLACE_TASK_ENTITY_STOP_WORDS,
  'agent', 'capability', 'expert', 'intelligence', 'method', 'specialist', 'tool',
])

function normalizedCapabilityTerms(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
    .map(term => term.length > 4 && term.endsWith('s') ? term.slice(0, -1) : term)
    .filter(term => term.length >= 3 && !CAPABILITY_ROLE_STOP_WORDS.has(term)))
}

const CAPABILITY_ROLE_AFFINITIES: readonly {
  readonly capability: RegExp
  readonly role: RegExp
  readonly weight: number
}[] = [
  { capability: /model|architecture|code|developer|repository|hugging/iu, role: /technical|engineering|scientific/iu, weight: 8 },
  { capability: /dataset|metric|statistics|quantitative/iu, role: /data|quantitative/iu, weight: 8 },
  { capability: /market|commercial|pricing|revenue|valuation/iu, role: /market|commercial/iu, weight: 8 },
  { capability: /policy|regulat|compliance|legal|antitrust/iu, role: /policy|regulat|compliance|legal/iu, weight: 8 },
  { capability: /paper|source|evidence|literature/iu, role: /evidence|researcher|literature/iu, weight: 6 },
]

/** Prefer the expert whose immutable role and objective most directly describe one entity tool. */
function capabilityRoleRelevance(blueprint: ExpertBlueprint, capability: SkillMarketplaceCapability): number {
  const role = normalizedCapabilityTerms(blueprint.role)
  const objective = normalizedCapabilityTerms(blueprint.objective.replaceAll('_', ' '))
  const capabilityTerms = normalizedCapabilityTerms(`${capability.name} ${capability.description}`)
  let score = 0
  for (const term of capabilityTerms) {
    if (role.has(term)) score += 3
    if (objective.has(term)) score += 2
  }
  const capabilityCorpus = `${capability.name} ${capability.description}`
  const roleCorpus = `${blueprint.role} ${blueprint.objective.replaceAll('_', ' ')}`
  for (const affinity of CAPABILITY_ROLE_AFFINITIES) {
    if (affinity.capability.test(capabilityCorpus) && affinity.role.test(roleCorpus)) score += affinity.weight
  }
  return score
}

/** P3 owner for one TeamRun's automatic team formation records. */
export class TeamOrchestrator extends Service {
  static inject = ['agents', 'sessions', 'teamRuns', 'expertCatalog', 'expertRuntime']

  /** Loader validation; constructor performs exact nested and cross-field validation. */
  static Config: schema<Config> = schema.object({
    pools: schema.array(schema.any()).required(),
    maxTextBytes: schema.number().step(1).min(1).required(),
    maxWorkstreams: schema.number().step(1).min(1).required(),
    maxListItems: schema.number().step(1).min(1).required(),
    maxContextEntries: schema.number().step(1).min(1).required(),
    maxEventBytes: schema.number().step(1).min(1).required(),
    communication: schema.any().required(),
    maxMarketplaceSkillsPerExpert: schema.number().step(1).min(1).max(12).required(),
  }) as schema<Config>

  private readonly locks = new LeadLock()
  private readonly formations = new Map<SessionId, AbortController>()
  /** Detached and deeply frozen deployment policy used by every later command. */
  readonly config: Config

  /**
   * @param ctx - Cordis context with live Agents, Sessions, P1 TeamRuns, P2 catalog, and P2 runtime.
   * @param config - exact domain pools, admission bounds, and charter communication policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'teamOrchestrator')
    this.validateConfig(config)
    this.config = deepFreeze(structuredClone(config))
    ctx.effect(() => async () => {
      for (const controller of this.formations.values()) controller.abort('TeamOrchestrator disposed')
      await this.locks.drain()
      this.formations.clear()
    }, 'teamOrchestrator.lifecycle()')
  }

  /**
   * Create or resume the unique profile, plan, and charter for one live Lead.
   * @param lead - exact live top-level Agent whose Session owns the TeamRun.
   * @param request - idempotency id, task text, optional domain/decomposition hints, and assignment context.
   * @returns planning snapshot with an exact immutable roster and charter.
   */
  create(lead: Agent, request: CreateTeamOrchestrationRequest): Promise<TeamOrchestrationSnapshot> {
    return this.locks.run(lead.id, async () => {
      this.assertLead(lead)
      let profile = profileTask(request, this.config)
      let run = this.tryRun(lead)
      let state = foldTeamOrchestration(TeamRunId(lead.id), lead.session.events)
      // Pre-upgrade TeamRuns with no P3 profile keep their original exact
      // roster when recovered. New runs always retain the profiler's >=3 plan.
      const legacyUnprofiledRun = state.profile === undefined && run !== undefined
        && run.objective === profile.objective
        && run.complexity === profile.complexity
        && ((run.complexity === 'simple' && run.plannedExperts === 1 && profile.plannedExperts === 3)
          || (run.complexity === 'medium' && run.plannedExperts === 2 && profile.plannedExperts === 3))
      if (legacyUnprofiledRun && run !== undefined) profile = { ...profile, plannedExperts: run.plannedExperts }
      const requestDigest = digestJson({
        requestId: request.requestId,
        retryOf: request.retryOf ?? null,
        profile,
      })
      let ownsRun = state.profile?.requestDigest === requestDigest
      if (state.profile !== undefined && state.profile.requestDigest !== requestDigest) {
        throw new TeamRunError('Lead Session already owns a different orchestration request', 'TEAM_INVALID_TRANSITION')
      }
      try {
        if (run === undefined) {
          run = await this.ctx.teamRuns.createRun(lead, {
            objective: profile.objective,
            complexity: profile.complexity,
            plannedExperts: profile.plannedExperts,
          })
          ownsRun = true
        } else if (run.objective !== profile.objective
          || run.complexity !== profile.complexity
          || run.plannedExperts !== profile.plannedExperts) {
          throw new TeamRunError('existing TeamRun does not match the profiled request', 'TEAM_INVALID_TRANSITION')
        } else if (state.profile === undefined) {
          ownsRun = true
        }
        if (TERMINAL_PHASES.has(run.phase)) throw this.terminalError(run)
        if (state.profile === undefined) {
          const data: TeamProfileEventData = {
            version: 1,
            eventId: TeamOrchestrationEventId(`orchestration-event-${randomUUID()}`),
            runId: run.id,
            requestId: request.requestId,
            ...request.retryOf === undefined ? {} : { retryOf: request.retryOf },
            requestDigest,
            revision: 1,
            profile,
          }
          await this.append(lead, 'collaboration/orchestration/profile', data)
          state = foldTeamOrchestration(run.id, lead.session.events)
        }
        const profiled = state.profile
        if (profiled === undefined) throw new Error('committed task profile is missing from replay')
        run = await this.advance(lead, 'planning')
        if (state.plan === undefined) {
          const basePlan = planTeam(this.ctx.expertCatalog, this.config, profiled.profile)
          const skillDiscoveries = await this.discoverTeamExpertSkills(
            basePlan.roster.map(expert => expert.blueprint),
            profiled.profile.objective,
          )
          const plan = {
            ...basePlan,
            roster: basePlan.roster.map((expert, index) => {
              const skillDiscovery = skillDiscoveries[index]
              if (skillDiscovery === undefined) throw new Error('expert skill discovery count does not match the planned roster')
              return { ...expert, skillDiscovery }
            }),
          }
          await this.requireResolvablePlanLocalSkills(lead, plan)
          this.requirePlanSkills(profiled.profile, plan)
          const planDigest = digestJson(plan)
          const data: TeamPlanEventData = {
            version: 1,
            eventId: TeamOrchestrationEventId(`orchestration-event-${randomUUID()}`),
            runId: run.id,
            requestId: profiled.requestId,
            requestDigest: profiled.requestDigest,
            revision: 2,
            planDigest,
            plan,
          }
          await this.append(lead, 'collaboration/orchestration/plan', data)
          state = foldTeamOrchestration(run.id, lead.session.events)
        }
        const planned = state.plan
        if (planned === undefined) throw new Error('committed team plan is missing from replay')
        if (state.charter === undefined) {
          const charter = charterTeam(profiled.profile, planned.plan, this.config)
          const data: TeamCharterEventData = {
            version: 1,
            eventId: TeamOrchestrationEventId(`orchestration-event-${randomUUID()}`),
            runId: run.id,
            requestId: profiled.requestId,
            requestDigest: profiled.requestDigest,
            revision: 3,
            planDigest: planned.planDigest,
            charterDigest: digestJson(charter),
            charter,
          }
          await this.append(lead, 'collaboration/orchestration/charter', data)
        }
        return this.get(lead)
      } catch (error: unknown) {
        if (ownsRun && this.tryRun(lead) !== undefined && !isTeamRunError(error, 'TEAM_CANCELLED')) {
          await this.finishFormationFailure(lead, error)
        }
        throw error
      }
    })
  }

  /**
   * Provision or recover every exact planned slot and activate only at full strength.
   * @param lead - exact live Lead.
   * @param command - matching durable request id.
   * @param signal - cancellation through catalog resolution and initial prompt admission.
   * @returns active, exactly staffed TeamRun snapshot.
   */
  form(lead: Agent, command: TeamOrchestrationCommand, signal: AbortSignal): Promise<TeamOrchestrationSnapshot> {
    return this.locks.run(lead.id, async () => {
      this.assertLead(lead)
      this.assertRequest(lead, command.requestId)
      const controller = new AbortController()
      this.formations.set(lead.id, controller)
      const formationSignal = AbortSignal.any([signal, controller.signal])
      try {
        formationSignal.throwIfAborted()
        let run = await this.advance(lead, 'provisioning')
        const state = this.requireCompleteState(lead)
        await this.materializeProtocol(lead, state)
        await this.materializeTaskDag(lead, state.charter.charter.taskDag)
        await this.materializeQualityGates(lead, state.charter.charter.qualityChecks)
        run = this.ctx.teamRuns.getRun(lead)
        for (const [index, planned] of state.plan.plan.roster.entries()) {
          formationSignal.throwIfAborted()
          this.requireMinimumExpertSkills(planned.blueprint, planned.localSkills)
          const identities = this.attemptIdentities(state.profile.requestDigest, index)
          const existing = run.members.find(member => member.attemptId === identities.attemptId)
          if (existing?.phase === 'failed') {
            throw new TeamRunError(`planned slot "${planned.slotId}" has a failed provisioning attempt`, 'FORMATION_FAILED')
          }
          if (existing === undefined) {
            await this.provisionWithCas(lead, {
              ...identities,
              protocolSlotId: TeamProtocolSlotId(planned.slotId),
              name: planned.name,
              role: planned.role,
              blueprint: planned.blueprint,
              ...planned.localSkills === undefined ? {} : { localSkills: planned.localSkills },
              ...planned.modelSelection === undefined ? {} : { modelSelection: planned.modelSelection },
              marketplaceSkills: planned.skillDiscovery?.mounts ?? [],
              assignment: planned.assignment,
              signal: formationSignal,
            })
          } else {
            await this.ctx.expertRuntime.recoverProvisioning(lead, existing.attemptId, formationSignal)
          }
          run = this.ctx.teamRuns.getRun(lead)
        }
        if (run.phase === 'provisioning') {
          await this.materializeTaskAssignments(lead, state.charter.charter.taskDag)
          run = this.ctx.teamRuns.getRun(lead)
        }
        run = await this.advance(lead, 'active')
        return this.snapshot(lead, run)
      } catch (error: unknown) {
        const current = this.tryRun(lead)
        if (current !== undefined && TERMINAL_PHASES.has(current.phase)) throw this.terminalError(current)
        if (formationSignal.aborted) {
          const reason = formationSignal.reason === undefined
            ? 'team formation was cancelled'
            : safeMessage(formationSignal.reason)
          await this.finishCancellation(lead, reason)
          throw new TeamRunError('team formation was cancelled', 'TEAM_CANCELLED', { cause: error })
        }
        const executionFailure = current?.phase === 'active' || current?.phase === 'completing'
        await this.finishFormationFailure(lead, error)
        if (executionFailure) {
          throw error instanceof TeamRunError
            ? error
            : new TeamRunError('task-DAG recovery failed for an active TeamRun', 'DELIVERY_FAILED', { cause: error })
        }
        throw isTeamRunError(error, 'FORMATION_FAILED')
          ? error
          : new TeamRunError('team formation failed without reaching the planned expert count', 'FORMATION_FAILED', {
            details: { causeCode: error instanceof TeamRunError ? error.code : 'UNKNOWN' },
            cause: error,
          })
      } finally {
        if (this.formations.get(lead.id) === controller) this.formations.delete(lead.id)
      }
    })
  }

  /**
   * Create, plan, charter, and fully form one team through the product one-click path.
   * @param lead - exact live Lead.
   * @param request - automatic orchestration request.
   * @param signal - formation cancellation.
   * @returns active, exactly staffed team.
   */
  async orchestrate(
    lead: Agent,
    request: CreateTeamOrchestrationRequest,
    signal: AbortSignal,
  ): Promise<TeamOrchestrationSnapshot> {
    await this.create(lead, request)
    return this.form(lead, { requestId: request.requestId }, signal)
  }

  /** Discover verified candidates for one role without causing authorization or connection side effects. */
  private async discoverExpertSkillCandidates(
    blueprintRef: ExpertBlueprintRef,
    taskObjective: string,
  ): Promise<ExpertSkillSearch> {
    const blueprint = this.requireMinimumExpertSkills(blueprintRef)
    const marketplace = this.ctx.get('skillMarketplace')
    if (marketplace === undefined) {
      return {
        blueprint,
        providers: [
          { source: 'smithery', state: 'unavailable' },
          { source: 'composio', state: 'unavailable' },
          { source: 'skills_sh', state: 'unavailable' },
        ],
        candidates: [],
      }
    }
    const query = marketplaceSearchQuery(blueprint.role, blueprint.objective, taskObjective)
    const result = await marketplace.search(query)
    const candidates = result.providers
      .flatMap(provider => provider.capabilities)
      .filter(capability => capability.verified)
      .sort(compareMarketplaceCapabilities)
    return {
      blueprint,
      providers: result.providers.map(({ source, state }) => ({ source, state })),
      candidates,
    }
  }

  /** Refuse a roster slot that cannot satisfy the product's executable local-skill floor. */
  private requireMinimumExpertSkills(
    blueprintRef: ExpertBlueprintRef,
    localSkills?: readonly string[],
  ): ExpertBlueprint {
    const blueprint = this.ctx.expertCatalog.get(blueprintRef)
    const skillCount = new Set(localSkills ?? blueprint.skills).size
    if (skillCount < MIN_LOCAL_SKILLS_PER_EXPERT) {
      throw new TeamRunError(
        `ExpertBlueprint "${String(blueprintRef.id)}" must declare at least ${String(MIN_LOCAL_SKILLS_PER_EXPERT)} distinct local skills`,
        'CAPABILITY_UNAVAILABLE',
        {
          retryable: false,
          details: {
            blueprintId: String(blueprintRef.id),
            requiredSkills: MIN_LOCAL_SKILLS_PER_EXPERT,
            declaredSkills: skillCount,
          },
        },
      )
    }
    return blueprint
  }

  /** Resolve every task-reviewed local-skill override before publishing a confirmable plan. */
  private async requireResolvablePlanLocalSkills(
    lead: Agent,
    plan: TeamPlanEventData['plan'],
  ): Promise<void> {
    for (const expert of plan.roster) {
      const blueprint = this.ctx.expertCatalog.get(expert.blueprint)
      const localSkills = expert.localSkills ?? blueprint.skills
      if (JSON.stringify(localSkills) === JSON.stringify(blueprint.skills)) continue
      await this.ctx.expertCatalog.resolve(expert.blueprint, {
        ...lead.session.header.cwd === undefined ? {} : { cwd: lead.session.header.cwd },
        skills: localSkills,
      })
    }
  }

  /** Refuse a review draft whose visible executable skill mounts miss the user's explicit floor. */
  private requirePlanSkills(profile: TeamProfileEventData['profile'], plan: TeamPlanEventData['plan']): void {
    const minimum = Math.max(MIN_LOCAL_SKILLS_PER_EXPERT, profile.planRequirements?.minimumSkillsPerExpert ?? 0)
    for (const expert of plan.roster) {
      const blueprint = this.ctx.expertCatalog.get(expert.blueprint)
      const mounted = new Set(expert.localSkills ?? blueprint.skills)
      for (const capability of expert.skillDiscovery?.mounts ?? []) {
        if (capability.status === 'loaded' || capability.status === 'connected') mounted.add(capability.id)
      }
      if (mounted.size >= minimum) continue
      throw new TeamRunError(
        `planned expert "${expert.role}" requires ${String(minimum)} mounted skills but only ${String(mounted.size)} are executable`,
        'CAPABILITY_UNAVAILABLE',
        {
          retryable: false,
          details: {
            blueprintId: String(expert.blueprint.id),
            requiredSkills: minimum,
            mountedSkills: mounted.size,
          },
        },
      )
    }
  }

  /** Select per-role methods and team-wide entity tools before preparing only the final mounts. */
  private selectTeamExpertSkillMounts(
    searches: readonly ExpertSkillSearch[],
    taskObjective: string,
  ): SkillMarketplaceCapability[][] {
    const mounts = searches.map(() => [] as SkillMarketplaceCapability[])
    const names = searches.map(() => new Set<string>())
    const hasCapacity = (index: number): boolean => (mounts[index]?.length ?? this.config.maxMarketplaceSkillsPerExpert)
      < this.config.maxMarketplaceSkillsPerExpert
    const add = (index: number, capability: SkillMarketplaceCapability): boolean => {
      const targetMounts = mounts[index]
      const targetNames = names[index]
      if (targetMounts === undefined || targetNames === undefined) return false
      const key = capability.name.toLocaleLowerCase()
      if (!hasCapacity(index) || targetNames.has(key)) return false
      targetNames.add(key)
      targetMounts.push(capability)
      return true
    }

    // Method skills are role-scoped guidance and may legitimately be shared by several experts.
    searches.forEach((search, index) => {
      for (const capability of search.candidates) {
        if (capability.kind !== 'method_skill') continue
        add(index, capability)
      }
    })

    const entityTerms = marketplaceTaskEntityTerms(taskObjective)
    const remoteIntentOccurrences = new Map<string, { readonly index: number; readonly capability: SkillMarketplaceCapability }[]>()
    searches.forEach((search, index) => {
      for (const capability of search.candidates) {
        if (capability.kind !== 'remote_tool'
          || !capabilityMatchesTaskEntity(capability, entityTerms)
          || !taskExplicitlyRequestsRemoteCapability(taskObjective, capability, entityTerms)) continue
        const occurrences = remoteIntentOccurrences.get(capability.id) ?? []
        occurrences.push({ index, capability })
        remoteIntentOccurrences.set(capability.id, occurrences)
      }
    })

    // An entity-specific tool is a shared team resource. Give it to the best-fitting role once,
    // instead of attaching the same topical integration to every expert who searched the task text.
    for (const occurrences of remoteIntentOccurrences.values()) {
      const ranked = occurrences
        .filter(({ index, capability }) => hasCapacity(index)
          && names[index]?.has(capability.name.toLocaleLowerCase()) !== true)
        .sort((left, right) => {
          const rightSearch = searches[right.index]
          const leftSearch = searches[left.index]
          const relevance = (rightSearch === undefined ? 0 : capabilityRoleRelevance(rightSearch.blueprint, right.capability))
            - (leftSearch === undefined ? 0 : capabilityRoleRelevance(leftSearch.blueprint, left.capability))
          return relevance
            || (mounts[left.index]?.length ?? 0) - (mounts[right.index]?.length ?? 0)
            || left.index - right.index
        })
      const owner = ranked[0]
      if (owner !== undefined) add(owner.index, owner.capability)
    }
    return mounts
  }

  /** Prepare a bounded, already allocated set and project honest provider readiness. */
  private async prepareExpertSkillDiscovery(
    search: ExpertSkillSearch,
    mounts: readonly SkillMarketplaceCapability[],
  ): Promise<PlannedExpertSkillDiscovery> {
    const marketplace = this.ctx.get('skillMarketplace')
    if (marketplace === undefined) {
      return {
        providers: search.providers.map(provider => ({ source: provider.source, state: 'unavailable' })),
        mounts: [],
      }
    }
    const preparedCandidates = await Promise.all(mounts.map(async (capability) => {
      try {
        return await marketplace.prepare(capability)
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `task-selected marketplace capability "${capability.id}" could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        )
        return capability
      }
    }))
    const preparedMounts = preparedCandidates.filter(capability =>
      capability.status === 'loaded' || capability.status === 'connected')
    return {
      providers: search.providers.map(({ source }) => {
        const selected = preparedCandidates.filter(capability => capability.source === source)
        const state = selected.some(capability => capability.status === 'loaded' || capability.status === 'connected')
          ? 'ready' as const
          : selected.some(capability => capability.status === 'authorization_required')
            ? 'authorization_required' as const
            : 'unavailable' as const
        return { source, state }
      }),
      mounts: preparedMounts,
    }
  }

  /** Discover in parallel, allocate at team scope, then prepare only selected task capabilities. */
  private async discoverTeamExpertSkills(
    blueprintRefs: readonly ExpertBlueprintRef[],
    taskObjective: string,
  ): Promise<PlannedExpertSkillDiscovery[]> {
    const searches = await Promise.all(blueprintRefs.map(ref => this.discoverExpertSkillCandidates(ref, taskObjective)))
    const mounts = this.selectTeamExpertSkillMounts(searches, taskObjective)
    return Promise.all(searches.map((search, index) => this.prepareExpertSkillDiscovery(search, mounts[index] ?? [])))
  }

  /**
   * Idempotently continue a non-terminal provisioning run after a local interruption.
   * @param lead - exact live Lead.
   * @param command - matching durable request id.
   * @param signal - recovery cancellation.
   * @returns active snapshot, or the same active snapshot on repeat.
   */
  retry(lead: Agent, command: TeamOrchestrationCommand, signal: AbortSignal): Promise<TeamOrchestrationSnapshot> {
    return this.form(lead, command, signal)
  }

  /**
   * Idempotently replace one failed active-run expert from its durable planned slot.
   * @param lead - exact live TeamRun Lead.
   * @param request - matching request and failed immutable member identity.
   * @param signal - provider cancellation propagated through recovery and provisioning.
   * @returns active orchestration with the replacement settled successfully.
   */
  replaceExpert(
    lead: Agent,
    request: ReplaceTeamExpertRequest,
    signal: AbortSignal,
  ): Promise<TeamOrchestrationSnapshot> {
    return this.locks.run(lead.id, async () => {
      this.assertLead(lead)
      this.assertRequest(lead, request.requestId)
      signal.throwIfAborted()
      const state = this.requireCompleteState(lead)
      let run = this.ctx.teamRuns.getRun(lead)
      if (run.phase !== 'active') {
        throw new TeamRunError('expert replacement requires an active TeamRun', 'TEAM_INVALID_TRANSITION')
      }
      const failed = run.members.find(member => member.id === request.failedMemberId)
      if (failed === undefined) {
        throw new TeamRunError(`failed member "${request.failedMemberId}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      }
      if (failed.phase !== 'failed') {
        throw new TeamRunError(`member "${request.failedMemberId}" is not failed`, 'TEAM_INVALID_TRANSITION')
      }
      const slot = this.resolvePlannedSlot(state.profile.requestDigest, state.plan.plan.roster.length, run, failed.attemptId)
      const planned = state.plan.plan.roster[slot.index]
      if (planned === undefined) throw new Error(`planned replacement slot ${String(slot.index + 1)} is missing`)
      const identities = this.replacementAttemptIdentities(
        state.profile.requestDigest,
        slot.index,
        slot.generation + 1,
      )
      const existing = run.members.find(member => member.attemptId === identities.attemptId)
      if (existing?.phase === 'failed') {
        throw new TeamRunError(
          `replacement attempt "${existing.attemptId}" already failed`,
          existing.failure?.code ?? 'CAPABILITY_UNAVAILABLE',
          { retryable: existing.failure?.retryable ?? false },
        )
      }
      if (existing?.phase === 'active') return this.snapshot(lead, run)
      if (existing === undefined) {
        await this.provisionWithCas(lead, {
          ...identities,
          protocolSlotId: TeamProtocolSlotId(planned.slotId),
          name: `expert-${String(slot.index + 1)}-replacement-${String(slot.generation + 1)}`,
          role: planned.role,
          blueprint: planned.blueprint,
          ...planned.localSkills === undefined ? {} : { localSkills: planned.localSkills },
          ...planned.modelSelection === undefined ? {} : { modelSelection: planned.modelSelection },
          marketplaceSkills: planned.skillDiscovery?.mounts ?? [],
          assignment: planned.assignment,
          signal,
        })
      } else {
        await this.ctx.expertRuntime.recoverProvisioning(lead, existing.attemptId, signal)
      }
      run = this.ctx.teamRuns.getRun(lead)
      const replacement = run.members.find(member => member.attemptId === identities.attemptId)
      if (replacement?.phase !== 'active') {
        throw new TeamRunError('expert replacement did not settle active', 'CAPABILITY_UNAVAILABLE')
      }
      return this.snapshot(lead, run)
    })
  }

  /**
   * Cancel a non-terminal orchestration and preserve its current durable audit.
   * @param lead - exact live Lead.
   * @param request - matching request id and user-safe reason.
   * @returns cancelled snapshot.
   */
  cancel(lead: Agent, request: CancelTeamOrchestrationRequest): Promise<TeamOrchestrationSnapshot> {
    this.assertLead(lead)
    this.assertRequest(lead, request.requestId)
    const reason = this.boundedText(request.reason, 'cancellation reason')
    this.formations.get(lead.id)?.abort(reason)
    return this.locks.run(lead.id, async () => {
      this.assertLead(lead)
      this.assertRequest(lead, request.requestId)
      const run = this.ctx.teamRuns.getRun(lead)
      if (run.phase === 'cancelled') return this.get(lead)
      if (TERMINAL_PHASES.has(run.phase)) throw this.terminalError(run)
      await this.finishCancellation(lead, reason)
      return this.get(lead)
    })
  }

  /**
   * Read one live Lead's P3 projection, including a partial plan after explicit formation failure.
   * @param lead - exact live Lead.
   * @returns detached orchestration and authoritative P1 snapshot.
   */
  get(lead: Agent): TeamOrchestrationSnapshot {
    this.assertLead(lead)
    return this.snapshot(lead, this.ctx.teamRuns.getRun(lead))
  }

  /**
   * List P3 projections for current live top-level Leads in Agent registration order.
   * @returns detached snapshots; unrelated Agents and pre-profile crash gaps are absent.
   */
  list(): TeamOrchestrationSnapshot[] {
    const snapshots: TeamOrchestrationSnapshot[] = []
    for (const lead of this.ctx.agents.roots()) {
      const state = foldTeamOrchestration(TeamRunId(lead.id), lead.session.events)
      if (state.profile !== undefined) snapshots.push(this.snapshot(lead, this.ctx.teamRuns.getRun(lead)))
    }
    return snapshots
  }

  private snapshot(lead: Agent, run: TeamRunSnapshot): TeamOrchestrationSnapshot {
    const state = foldTeamOrchestration(run.id, lead.session.events)
    if (state.profile === undefined || state.createdAt === undefined) {
      throw new TeamRunError('TeamRun does not contain a durable task profile', 'TEAM_NOT_FOUND')
    }
    const legacyQualityGateGap = this.isLegacyQualityGateGap(lead, run)
    if (run.protocol.mode === 'enforced') {
      this.assertProtocolProjection(state, run)
    }
    if ((run.phase === 'active' || run.phase === 'completing' || run.phase === 'completed')
      && state.charter !== undefined
      && !legacyQualityGateGap
      && digestJson(run.qualityGates.map(gate => gate.name)) !== digestJson(state.charter.charter.qualityChecks)) {
      throw new TeamRunError('active TeamRun quality gates diverge from the durable Team Charter', 'DELIVERY_FAILED')
    }
    return structuredClone({
      requestId: state.profile.requestId,
      ...state.profile.retryOf === undefined ? {} : { retryOf: state.profile.retryOf },
      createdAt: state.createdAt,
      run,
      profile: state.profile.profile,
      ...state.plan === undefined ? {} : { plan: state.plan.plan },
      ...state.charter === undefined ? {} : { charter: state.charter.charter },
    })
  }

  /** Recognize only the exact pre-P5 empty-gate shape for read compatibility. */
  private isLegacyQualityGateGap(lead: Agent, run: TeamRunSnapshot): boolean {
    if (run.qualityGates.length !== 0) return false
    const creation = lead.session.events.find((event) => {
      if (event.type !== 'collaboration/run/created') return false
      const value: unknown = event.data
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>)['runId'] === run.id
    })
    if (creation === undefined) return false
    const data = creation.data as unknown as Record<string, unknown>
    const policy = data['policy']
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return false
    const fields = policy as Record<string, unknown>
    return !Object.hasOwn(fields, 'maxArtifacts')
      && !Object.hasOwn(fields, 'maxArtifactBodyBytes')
      && !Object.hasOwn(fields, 'taskStallCursorThreshold')
  }

  private protocolFromState(state: CompleteOrchestrationState) {
    const slots = state.plan.plan.roster.map(row => TeamProtocolSlotId(row.slotId))
    return {
      topology: state.charter.charter.topology,
      maxChallengeRounds: state.charter.charter.communication.maxChallengeRounds,
      maxMessagesPerExpert: state.charter.charter.communication.maxMessagesPerExpert,
      experts: state.plan.plan.roster.map((planned, index) => {
        const slotId = slots[index]
        if (slotId === undefined) throw new Error(`protocol slot ${String(index)} is missing`)
        return {
          slotId,
          initialMemberId: this.attemptIdentities(state.profile.requestDigest, index).memberId,
          name: planned.name,
          permissions: structuredClone(this.ctx.expertCatalog.get(planned.blueprint).collaboration),
          allowedTargetSlotIds: this.allowedTargetSlots(state.plan.plan.topology, slots, index),
        }
      }),
    }
  }

  private allowedTargetSlots(
    topology: import('./types.ts').TeamTopology,
    slots: readonly ReturnType<typeof TeamProtocolSlotId>[],
    index: number,
  ): ReturnType<typeof TeamProtocolSlotId>[] {
    switch (topology) {
      case 'centralized':
      case 'parallel':
        return []
      case 'producer_reviewer':
        return slots.filter((_slot, candidate) => candidate !== index)
      case 'hybrid':
        return slots.filter((_slot, candidate) => candidate !== index && Math.abs(candidate - index) === 1)
      case 'grouped': {
        const groupStart = Math.floor(index / 2) * 2
        return slots.filter((_slot, candidate) => candidate !== index && Math.floor(candidate / 2) * 2 === groupStart)
      }
    }
  }

  private async materializeProtocol(lead: Agent, state: CompleteOrchestrationState): Promise<void> {
    const protocol = this.protocolFromState(state)
    while (true) {
      const run = this.ctx.teamRuns.getRun(lead)
      try {
        await this.ctx.teamRuns.materializeProtocol(lead, { expectedRevision: run.revision, ...protocol })
        return
      } catch (error: unknown) {
        if (!(error instanceof TeamRunError) || error.code !== 'STALE_REVISION') throw error
      }
    }
  }

  private assertProtocolProjection(state: ReturnType<typeof foldTeamOrchestration>, run: TeamRunSnapshot): void {
    if (state.profile === undefined || state.plan === undefined || state.charter === undefined
      || run.protocol.mode !== 'enforced' || run.protocol.limits === null) {
      throw new TeamRunError('active TeamRun protocol lacks its durable Team Charter inputs', 'TEAM_PROTOCOL_REQUIRED')
    }
    const expected = this.protocolFromState(state as CompleteOrchestrationState)
    if (run.protocol.topology !== expected.topology
      || run.protocol.limits.maxChallengeRounds !== expected.maxChallengeRounds
      || run.protocol.limits.maxMessagesPerExpert !== expected.maxMessagesPerExpert
      || run.protocol.members.length !== expected.experts.length) {
      throw new TeamRunError('active TeamRun protocol diverges from the durable Team Charter', 'TEAM_PROTOCOL_REQUIRED')
    }
    for (const rule of expected.experts) {
      const view = run.protocol.members.find(candidate => candidate.slotId === rule.slotId)
      const allowedTargets = ['lead', ...rule.allowedTargetSlotIds.flatMap((slotId) => {
        const member = [...run.members].filter(candidate => candidate.protocolSlotId === slotId).at(-1)
        return member?.phase === 'active' ? [member.name] : []
      })]
      if (view === undefined || digestJson(view.permissions) !== digestJson(rule.permissions)
        || digestJson(view.allowedTargets) !== digestJson(allowedTargets)) {
        throw new TeamRunError(`protocol slot "${rule.slotId}" diverges from the durable catalog or topology`, 'TEAM_PROTOCOL_REQUIRED')
      }
    }
  }

  private requireCompleteState(lead: Agent) {
    const state = foldTeamOrchestration(TeamRunId(lead.id), lead.session.events)
    if (state.profile === undefined || state.plan === undefined || state.charter === undefined) {
      throw new TeamRunError('team formation requires a complete durable profile, plan, and charter', 'TEAM_INVALID_TRANSITION')
    }
    return state as typeof state & { profile: TeamProfileEventData; plan: TeamPlanEventData; charter: TeamCharterEventData }
  }

  private assertRequest(lead: Agent, requestId: import('./types.ts').TeamOrchestrationRequestId): void {
    const state = foldTeamOrchestration(TeamRunId(lead.id), lead.session.events)
    if (state.profile?.requestId !== requestId) {
      throw new TeamRunError(`orchestration request "${requestId}" not found for Lead`, 'TEAM_NOT_FOUND')
    }
  }

  private attemptIdentities(requestDigest: string, index: number) {
    const suffix = digestJson({ requestDigest, slot: index + 1 }).slice(0, 24)
    return {
      memberId: TeamMemberId(`orchestrated-member-${suffix}`),
      sessionId: SessionId(`orchestrated-expert-${suffix}`),
      attemptId: ProvisionAttemptId(`orchestrated-attempt-${suffix}`),
    }
  }

  private replacementAttemptIdentities(requestDigest: string, index: number, generation: number) {
    const suffix = digestJson({ requestDigest, slot: index + 1, replacement: generation }).slice(0, 24)
    return {
      memberId: TeamMemberId(`orchestrated-replacement-member-${suffix}`),
      sessionId: SessionId(`orchestrated-replacement-expert-${suffix}`),
      attemptId: ProvisionAttemptId(`orchestrated-replacement-attempt-${suffix}`),
    }
  }

  private resolvePlannedSlot(
    requestDigest: string,
    slotCount: number,
    run: TeamRunSnapshot,
    attemptId: import('@deepseek-ai/dsh-agent-team').TeamMemberSnapshot['attemptId'],
  ): { readonly index: number; readonly generation: number } {
    for (let index = 0; index < slotCount; index++) {
      if (this.attemptIdentities(requestDigest, index).attemptId === attemptId) return { index, generation: 0 }
      for (let generation = 1; generation <= run.members.length; generation++) {
        if (this.replacementAttemptIdentities(requestDigest, index, generation).attemptId === attemptId) {
          return { index, generation }
        }
      }
    }
    throw new TeamRunError(`failed attempt "${attemptId}" is not bound to the durable team plan`, 'TEAM_INVALID_TRANSITION')
  }

  /**
   * Materialize the immutable Charter DAG as an exact P1 task-board prefix.
   * Dependencies may point to later Charter rows, so a stable dependency-first walk fixes
   * the generated task ids. A crash may leave any exact prefix; drift fails closed instead
   * of silently attaching the plan to unrelated mutable tasks.
   */
  private async materializeTaskDag(
    lead: Agent,
    taskDag: readonly PlannedTeamWorkstream[],
  ): Promise<void> {
    const ordered = this.orderedTaskDag(taskDag)
    const ids = new Map(ordered.map((value, index) => [value.id, TeamTaskId(`task-${String(index + 1)}`)]))
    const expected = ordered.map((value, index) => ({
      id: TeamTaskId(`task-${String(index + 1)}`),
      subject: value.subject,
      description: value.description,
      blockedBy: value.blockedBy.map((id) => {
        const taskId = ids.get(id)
        if (taskId === undefined) throw new Error(`ordered workstream blocker "${id}" is missing`)
        return taskId
      }),
      resourceScopes: [...value.resourceScopes],
    }))
    const current = this.ctx.teamRuns.listTasks(lead)
    if (current.length > expected.length) {
      throw new TeamRunError('existing TeamRun tasks exceed the committed Team Charter DAG', 'TEAM_INVALID_TRANSITION')
    }
    for (const [index, task] of current.entries()) {
      const planned = expected[index]
      if (planned === undefined
        || task.id !== planned.id
        || task.subject !== planned.subject
        || task.description !== planned.description
        || task.status === 'deleted'
        || digestJson(task.blockedBy) !== digestJson(planned.blockedBy)
        || digestJson(task.resourceScopes) !== digestJson(planned.resourceScopes)) {
        throw new TeamRunError(
          `existing TeamRun task prefix diverges at position ${String(index + 1)}`,
          'TEAM_INVALID_TRANSITION',
        )
      }
    }
    for (let index = current.length; index < expected.length; index++) {
      const planned = expected[index]
      if (planned === undefined) throw new Error('materialized Team Charter task is missing')
      const created = await this.ctx.teamRuns.createTask(lead, {
        subject: planned.subject,
        description: planned.description,
        blockedBy: planned.blockedBy,
        resourceScopes: planned.resourceScopes,
      })
      if (created.id !== planned.id || created.revision !== 1) {
        throw new TeamRunError(
          `materialized TeamRun task identity diverges at position ${String(index + 1)}`,
          'TEAM_INVALID_TRANSITION',
        )
      }
    }
  }

  /** Return one stable dependency-first view of the immutable execution plan. */
  private orderedTaskDag(taskDag: readonly PlannedTeamWorkstream[]): PlannedTeamWorkstream[] {
    const byId = new Map(taskDag.map(value => [value.id, value]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const ordered: PlannedTeamWorkstream[] = []
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        throw new TeamRunError('committed Team Charter task DAG contains a cycle', 'TEAM_TASK_DEPENDENCY_CYCLE')
      }
      const workstream = byId.get(id)
      if (workstream === undefined) {
        throw new TeamRunError(`committed Team Charter blocker "${id}" is missing`, 'TEAM_TASK_NOT_FOUND')
      }
      visiting.add(id)
      for (const blocker of workstream.blockedBy) visit(blocker)
      visiting.delete(id)
      visited.add(id)
      ordered.push(workstream)
    }
    for (const workstream of taskDag) visit(workstream.id)
    return ordered
  }

  /** Bind every immutable plan step to its provisioned expert without starting blocked work. */
  private async materializeTaskAssignments(
    lead: Agent,
    taskDag: readonly PlannedTeamWorkstream[],
  ): Promise<void> {
    const ordered = this.orderedTaskDag(taskDag)
    for (const [index, planned] of ordered.entries()) {
      if (planned.assigneeSlotId === undefined) continue
      const task = this.ctx.teamRuns.listTasks(lead)[index]
      if (task === undefined) throw new Error(`materialized task ${String(index + 1)} is missing`)
      const member = this.ctx.teamRuns.getRun(lead).members.find(candidate =>
        candidate.phase === 'active' && String(candidate.protocolSlotId) === String(planned.assigneeSlotId))
      if (member === undefined) {
        throw new TeamRunError(
          `planned task "${planned.id}" has no active expert in slot "${planned.assigneeSlotId}"`,
          'FORMATION_FAILED',
        )
      }
      if (task.owner === undefined) {
        await this.ctx.teamRuns.updateTask(lead, {
          taskId: task.id,
          expectedRevision: task.revision,
          action: 'assign',
          owner: member.name,
        })
        continue
      }
      if (task.owner.role !== 'expert' || task.owner.memberId !== member.id) {
        throw new TeamRunError(
          `materialized task "${task.id}" diverges from planned expert slot "${planned.assigneeSlotId}"`,
          'TEAM_INVALID_TRANSITION',
        )
      }
    }
  }

  /** Materialize the Charter quality checks as one exact idempotent gate prefix. */
  private async materializeQualityGates(lead: Agent, qualityChecks: readonly string[]): Promise<void> {
    const current = this.ctx.teamRuns.getRun(lead).qualityGates
    if (current.length > qualityChecks.length) {
      throw new TeamRunError('existing TeamRun quality gates exceed the committed Team Charter', 'TEAM_INVALID_TRANSITION')
    }
    for (const [index, gate] of current.entries()) {
      if (gate.name !== qualityChecks[index]) {
        throw new TeamRunError(
          `materialized TeamRun quality gate diverges at position ${String(index + 1)}`,
          'TEAM_INVALID_TRANSITION',
        )
      }
    }
    for (const name of qualityChecks.slice(current.length)) {
      await this.ctx.teamRuns.createQualityGate(lead, { name })
    }
    const materialized = this.ctx.teamRuns.getRun(lead).qualityGates
    if (materialized.length !== qualityChecks.length
      || materialized.some((gate, index) => gate.name !== qualityChecks[index])) {
      throw new Error('materialized Team Charter quality gates are missing or divergent')
    }
  }

  private async provisionWithCas(
    lead: Agent,
    request: Omit<import('@deepseek-ai/dsh-expert-runtime').ProvisionExpertRequest, 'expectedRevision'>,
  ): Promise<void> {
    while (true) {
      const run = this.ctx.teamRuns.getRun(lead)
      const existing = run.members.find(member => member.attemptId === request.attemptId)
      if (existing !== undefined) {
        if (existing.phase === 'failed') throw new TeamRunError(`attempt "${existing.attemptId}" failed`, 'FORMATION_FAILED')
        await this.ctx.expertRuntime.recoverProvisioning(lead, existing.attemptId, request.signal)
        return
      }
      try {
        await this.ctx.expertRuntime.provision(lead, { ...request, expectedRevision: run.revision })
        return
      } catch (error: unknown) {
        if (!isTeamRunError(error, 'STALE_REVISION')) throw error
      }
    }
  }

  private async advance(lead: Agent, target: 'planning' | 'provisioning' | 'active'): Promise<TeamRunSnapshot> {
    while (true) {
      const run = this.ctx.teamRuns.getRun(lead)
      if (run.phase === target || (target === 'planning' && run.phase === 'provisioning') || (target !== 'active' && run.phase === 'active')) {
        return run
      }
      if (TERMINAL_PHASES.has(run.phase)) throw this.terminalError(run)
      try {
        return await this.ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: target })
      } catch (error: unknown) {
        if (!isTeamRunError(error, 'STALE_REVISION')) throw error
      }
    }
  }

  private async finishFormationFailure(lead: Agent, cause: unknown): Promise<void> {
    const phase = this.tryRun(lead)?.phase
    const executionFailure = phase === 'active' || phase === 'completing'
    const failure: TeamFailure = {
      code: executionFailure ? 'DELIVERY_FAILED' : 'FORMATION_FAILED',
      message: safeMessage(cause),
      retryable: false,
      details: { causeCode: cause instanceof TeamRunError ? cause.code : 'UNKNOWN' },
    }
    await this.terminate(lead, executionFailure ? 'failed' : 'formation_failed', failure)
    await this.stopChildren(lead)
  }

  private async finishCancellation(lead: Agent, reason: string): Promise<void> {
    await this.terminate(lead, 'cancelled', {
      code: 'TEAM_CANCELLED',
      message: reason || 'team formation was cancelled',
      retryable: false,
      details: {},
    })
    await this.stopChildren(lead)
  }

  private async stopChildren(lead: Agent): Promise<void> {
    const run = this.tryRun(lead)
    if (run === undefined) return
    const children = run.members.flatMap((member) => {
      const child = this.ctx.agents.get(member.sessionId)
      return child === undefined ? [] : [child]
    })
    for (const child of children) child.cancel({ kind: 'parent' })
    const settled = await Promise.allSettled(children.map(child => child.whenIdle()))
    for (const result of settled) {
      if (result.status === 'rejected') this.ctx.logger.warn(`expert cancellation did not reach idle: ${safeMessage(result.reason)}`)
    }
  }

  private async terminate(
    lead: Agent,
    terminalPhase: 'formation_failed' | 'failed' | 'cancelled',
    failure: TeamFailure,
  ): Promise<void> {
    while (true) {
      const run = this.tryRun(lead)
      if (run === undefined || TERMINAL_PHASES.has(run.phase)) return
      try {
        await this.ctx.teamRuns.terminateRun(lead, { expectedRevision: run.revision, terminalPhase, failure })
        return
      } catch (error: unknown) {
        if (!isTeamRunError(error, 'STALE_REVISION')) throw error
      }
    }
  }

  private async append<T extends OrchestrationEventType>(lead: Agent, type: T, data: SessionEventMap[T]): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > this.config.maxEventBytes) {
      throw new TeamRunError(`orchestration event exceeds ${String(this.config.maxEventBytes)} UTF-8 bytes`, 'TEAM_INVALID_ARGUMENT')
    }
    const candidate = { type, data, seq: lead.session.events.length, time: Date.now() } as SessionEvent<T>
    applyTeamOrchestrationEvent(foldTeamOrchestration(TeamRunId(lead.id), lead.session.events), candidate)
    const append = lead.session.append.bind(lead.session) as unknown as AppendOrchestrationEvent
    append(type, data)
    await this.ctx.sessions.flush(lead.session)
  }

  private tryRun(lead: Agent): TeamRunSnapshot | undefined {
    if (!lead.session.events.some(event => event.type === 'collaboration/run/created')) return undefined
    try {
      return this.ctx.teamRuns.getRun(lead)
    } catch (error: unknown) {
      if (isTeamRunError(error, 'TEAM_NOT_FOUND')) return undefined
      throw error
    }
  }

  private terminalError(run: TeamRunSnapshot): TeamRunError {
    return new TeamRunError(
      `TeamRun is already ${run.phase}`,
      run.phase === 'formation_failed' ? 'FORMATION_FAILED'
        : run.phase === 'cancelled' ? 'TEAM_CANCELLED' : 'TEAM_INVALID_TRANSITION',
      { details: { phase: run.phase } },
    )
  }

  private assertLead(lead: Agent): void {
    if (this.ctx.agents.get(lead.id) !== lead || lead.session.header.parentSession !== undefined) {
      throw new TeamRunError('team orchestration requires the exact live top-level Lead Agent', 'TEAM_LEAD_REQUIRED')
    }
  }

  private boundedText(value: string, label: string): string {
    const normalized = value.trim()
    if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > this.config.maxTextBytes) {
      throw new TeamRunError(`${label} must be non-blank and bounded`, 'TEAM_INVALID_ARGUMENT')
    }
    return normalized
  }

  private validateConfig(config: Config): void {
    const integers = [
      config.maxTextBytes,
      config.maxWorkstreams,
      config.maxListItems,
      config.maxContextEntries,
      config.maxEventBytes,
      config.maxMarketplaceSkillsPerExpert,
    ]
    if (integers.some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new TeamRunError('TeamOrchestrator limits must be positive safe integers', 'TEAM_INVALID_CONFIG')
    }
    const domains = ['research_analysis', 'product_solution', 'software_development'] as const
    const pools: unknown = config.pools
    if (!Array.isArray(pools) || pools.length !== domains.length
      || domains.some(domain => pools.filter((pool: unknown) => {
        return pool !== null && typeof pool === 'object'
          && (pool as { domain?: unknown }).domain === domain
      }).length !== 1)) {
      throw new TeamRunError('TeamOrchestrator requires exactly one blueprint pool for each supported domain', 'TEAM_INVALID_CONFIG')
    }
    for (const candidate of pools) {
      if (candidate === null || typeof candidate !== 'object') {
        throw new TeamRunError('ExpertBlueprint pool is invalid', 'TEAM_INVALID_CONFIG')
      }
      const pool = candidate as { domain?: unknown; blueprints?: unknown }
      if (typeof pool.domain !== 'string' || !Array.isArray(pool.blueprints) || pool.blueprints.length === 0
        || pool.blueprints.some((ref: unknown) => ref === null || typeof ref !== 'object'
          || typeof (ref as { id?: unknown }).id !== 'string'
          || (ref as { id: string }).id.trim() === ''
          || !Number.isSafeInteger((ref as { revision?: unknown }).revision)
          || Number((ref as { revision?: unknown }).revision) < 1)) {
        throw new TeamRunError(`ExpertBlueprint pool for ${String(pool.domain)} is empty or invalid`, 'TEAM_INVALID_CONFIG')
      }
      const keys = pool.blueprints.map((ref: unknown) => refKey(ref as ExpertBlueprintRef))
      if (new Set(keys).size !== keys.length) {
        throw new TeamRunError(`ExpertBlueprint pool for ${pool.domain} contains duplicate revisions`, 'TEAM_INVALID_CONFIG')
      }
    }
    const communication: unknown = config.communication
    if (communication === null || typeof communication !== 'object') {
      throw new TeamRunError('TeamOrchestrator communication limits are invalid', 'TEAM_INVALID_CONFIG')
    }
    for (const complexity of ['simple', 'medium', 'complex'] as const) {
      const limits: unknown = (communication as Record<string, unknown>)[complexity]
      if (limits === undefined || limits === null || typeof limits !== 'object'
        || !Number.isSafeInteger((limits as { maxChallengeRounds?: unknown }).maxChallengeRounds)
        || Number((limits as { maxChallengeRounds?: unknown }).maxChallengeRounds) < 1
        || !Number.isSafeInteger((limits as { maxMessagesPerExpert?: unknown }).maxMessagesPerExpert)
        || Number((limits as { maxMessagesPerExpert?: unknown }).maxMessagesPerExpert) < 1) {
        throw new TeamRunError(`communication limits for ${complexity} are invalid`, 'TEAM_INVALID_CONFIG')
      }
    }
  }
}

export default TeamOrchestrator
