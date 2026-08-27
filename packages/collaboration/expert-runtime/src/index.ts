/** ExpertBlueprint-bound continuable child provisioning over stable TeamRun transitions. */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  TeamRunError,
  TeamRunId,
  type CollaborationErrorCode,
  type TeamFailure,
  type TeamMemberSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import type { ResolvedExpertBinding } from '@deepseek-ai/dsh-expert-catalog'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-skill-marketplace'
import { foldSubagentDescriptor, type SubagentFollowupOptions } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import {
  countExpertTurns,
  findExpertBinding,
  foldExpertBindings,
  foldExpertChildDescriptor,
  hasExpertInitialPrompt,
  sameExpertDescriptor,
} from './fold.ts'
import { ExpertRuntimeEventId } from './ids.ts'
import { renderExpertInitialPrompt } from './prompt.ts'
import type {
  Config,
  ExpertBindingDescriptor,
  ExpertBindingEventData,
  ExpertChildDescriptorEventData,
  ExpertProvisionAttemptId,
  ProvisionedExpert,
  ProvisionExpertRequest,
  RecoveredExpert,
} from './types.ts'

type ProvisionAttemptIdType = ExpertBindingEventData['attemptId']

export type * from './types.ts'
export { ExpertRuntimeEventId } from './ids.ts'
export {
  countExpertTurns,
  findExpertBinding,
  foldExpertBindings,
  foldExpertChildDescriptor,
  hasExpertInitialPrompt,
  sameExpertDescriptor,
} from './fold.ts'
export { parseExpertBinding, parseExpertChildDescriptor } from './schema.ts'
export { renderExpertInitialPrompt } from './prompt.ts'

/** Stable child-visible name for one task-bound remote marketplace tool. */
export function marketplaceRemoteToolName(capabilityId: string, rawToolName: string): string {
  const identity = `${capabilityId}\0${rawToolName}`
  const normalized = `market__${capabilityId.replace(/^.*?:/u, '')}__${rawToolName}`.replaceAll(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    expertRuntime: ExpertRuntime
  }
}

/** Per-TeamRun operation serialization without retaining settled keys. */
class RunLock {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /**
   * Serialize one operation after earlier runtime operations for the same Lead.
   * @param leadId - TeamRun and Lead Session identity.
   * @param operation - critical section.
   * @returns the operation's exact settlement.
   */
  run<T>(leadId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(leadId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(leadId, tail)
    void tail.then(() => {
      if (this.tails.get(leadId) === tail) this.tails.delete(leadId)
    })
    return result
  }
}

/** User-safe single-line failure message. */
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 2_000) || 'expert provisioning failed'
}

/** Build a failure suitable for the P1 public roster audit. */
function teamFailure(error: unknown, signal?: AbortSignal): TeamFailure {
  const cancelled = signal?.aborted === true
  const code: CollaborationErrorCode = cancelled
    ? 'TEAM_CANCELLED'
    : error instanceof TeamRunError ? error.code as CollaborationErrorCode : 'CAPABILITY_UNAVAILABLE'
  return {
    code,
    message: cancelled ? 'expert provisioning was cancelled before initial prompt admission' : errorMessage(error),
    retryable: !cancelled && error instanceof TeamRunError ? error.retryable : false,
    details: {},
  }
}

/** Build the explicit immutable-revision refusal used on every activation path. */
function revisionMismatch(expected: string, actual: string, cause?: unknown): TeamRunError {
  return new TeamRunError(
    `expert capability binding changed: expected ${expected}, resolved ${actual}`,
    'BLUEPRINT_REVISION_MISMATCH',
    {
      retryable: false,
      details: { expectedDigest: expected, actualDigest: actual },
      ...cause === undefined ? {} : { cause },
    },
  )
}

/** Hash catalog identity together with runtime-resolved composition that the catalog cannot know. */
function compositionDigest(
  resolved: ResolvedExpertBinding,
  model: AgentOptions,
  subagentProvider: string,
  marketplaceSkills: ExpertBindingDescriptor['marketplaceSkills'],
): string {
  return createHash('sha256').update(JSON.stringify({
    catalogDigest: resolved.digest,
    subagentProvider,
    model,
    role: resolved.blueprint.role,
    persona: resolved.blueprint.persona,
    toolFilter: resolved.blueprint.tools,
    ...marketplaceSkills === undefined ? {} : { marketplaceSkills },
  })).digest('hex')
}

/** Expert child provisioning, recovery, drift enforcement, and execution-budget owner. */
export class ExpertRuntime extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'teamRuns', 'expertCatalog', 'subagents']

  /** Loader validation for provider selection and complete-prompt bounds. */
  static Config: schema<Config> = schema.object({
    subagentProvider: schema.string().required(),
    maxInitialPromptBytes: schema.number().step(1).min(1).required(),
  })

  private readonly locks = new RunLock()
  private readonly pending = new Map<SessionId, ExpertBindingEventData>()
  private readonly authorizations = new Map<SessionId, {
    readonly binding: ExpertBindingEventData
    readonly tokens: Set<symbol>
  }>()
  private readonly deadlines = new Map<SessionId, ReturnType<typeof setTimeout>>()

  /**
   * @param ctx - Cordis context carrying TeamRun, catalog, Session, Agent, persistence, and subagent services.
   * @param config - exact provider and initial-prompt byte limit.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'expertRuntime')
    if (config.subagentProvider.trim() === '') {
      throw new TeamRunError('expert runtime subagentProvider must be non-blank', 'TEAM_INVALID_CONFIG')
    }
    if (!Number.isSafeInteger(config.maxInitialPromptBytes) || config.maxInitialPromptBytes < 1) {
      throw new TeamRunError('expert runtime maxInitialPromptBytes must be a positive safe integer', 'TEAM_INVALID_CONFIG')
    }
    ctx.subagents.registerContinuableSetup(childCtx => this.setupChild(childCtx.agent as Agent))
    ctx.on('agent/created', ({ agent }) => { this.installDeadline(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.clearDeadline(agent.id) })
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const descriptor = foldExpertChildDescriptor(agent.session)
      if (descriptor === undefined) return next()
      try {
        if (this.parentRunIsTerminal(agent)) {
          throw new TeamRunError('expert cannot enter a model step after its TeamRun is terminal', 'TEAM_INVALID_TRANSITION')
        }
        await this.assertCurrentBinding(agent, descriptor, signal)
        if (countExpertTurns(agent.session) > descriptor.descriptor.execution.maxTurns) {
          throw new TeamRunError(
            `expert turn budget ${String(descriptor.descriptor.execution.maxTurns)} exhausted`,
            'TEAM_CANCELLED',
          )
        }
        if (Date.now() >= descriptor.descriptor.execution.deadlineAt) {
          throw new TeamRunError('expert execution deadline reached', 'TEAM_CANCELLED')
        }
      } catch (error: unknown) {
        if (!this.parentRunIsTerminal(agent)) {
          try {
            await this.failFromChild(agent, descriptor, error)
          } catch (failureError: unknown) {
            this.ctx.logger.warn(`expert "${agent.id}" failure record was rejected: ${errorMessage(failureError)}`)
          }
        }
        throw error
      }
      return next()
    })
    ctx.effect(() => () => {
      for (const timer of this.deadlines.values()) clearTimeout(timer)
      this.deadlines.clear()
      this.pending.clear()
      this.authorizations.clear()
    }, 'expertRuntime.lifecycle()')
    for (const agent of ctx.agents.list()) this.installDeadline(agent)
  }

  /**
   * Resolve, reserve, durably bind, create, and activate one real expert child.
   * P1 success commits after child publication and before the initial prompt enters its inbox.
   * @param lead - exact live TeamRun Lead.
   * @param request - identities, blueprint revision, assignment, CAS revision, and cancellation.
   * @returns active P1 member, immutable binding, and accepted initial message id.
   */
  provision(lead: Agent, request: ProvisionExpertRequest): Promise<ProvisionedExpert> {
    return this.locks.run(lead.id, async () => {
      const resolved = await this.ctx.expertCatalog.resolve(request.blueprint, {
        ...lead.session.header.cwd === undefined ? {} : { cwd: lead.session.header.cwd },
        signal: request.signal,
      })
      this.assertProvider(this.config.subagentProvider)
      const marketplaceSkills = structuredClone(request.marketplaceSkills ?? [])
      const initialPrompt = renderExpertInitialPrompt(request.name, resolved.blueprint, request.assignment, marketplaceSkills)
      this.assertPromptBytes(initialPrompt)
      const agentOptions = this.agentOptions(resolved, lead.options)
      const publicRole = request.role?.trim() || resolved.blueprint.role
      const descriptor = this.bindingDescriptor(resolved, agentOptions, publicRole, marketplaceSkills)

      let began = false
      let binding: ExpertBindingEventData | undefined
      try {
        await this.ctx.teamRuns.beginExpertProvision(lead, {
          expectedRevision: request.expectedRevision,
          memberId: request.memberId,
          sessionId: request.sessionId,
          attemptId: request.attemptId,
          name: request.name,
          role: publicRole,
          ...request.protocolSlotId === undefined ? {} : { protocolSlotId: request.protocolSlotId },
        })
        began = true
        binding = {
          version: 1,
          eventId: ExpertRuntimeEventId(`expert-runtime-event-${randomUUID()}`),
          runId: TeamRunId(lead.id),
          memberId: request.memberId,
          sessionId: request.sessionId,
          attemptId: request.attemptId,
          name: request.name,
          role: publicRole,
          subagentProvider: this.config.subagentProvider,
          descriptor,
          initialPrompt,
          agentOptions,
          ...resolved.blueprint.persona === undefined ? {} : { persona: resolved.blueprint.persona },
          toolFilter: structuredClone(resolved.blueprint.tools),
        }
        await this.appendBinding(lead, binding)
        const started = await this.startBoundChild(lead, binding, request.signal)
        return {
          member: this.member(lead, request.attemptId, 'active'),
          binding: structuredClone(binding),
          messageId: started,
        }
      } catch (error: unknown) {
        if (began) await this.compensateFailure(lead, request.attemptId, request.sessionId, error, request.signal)
        throw error
      }
    })
  }

  /**
   * Recover one P1 provisioning attempt without replaying a prompt already accepted by a persisted child.
   * @param lead - exact live TeamRun Lead.
   * @param attemptId - existing immutable provisioning attempt.
   * @param signal - caller cancellation through inspection or missing-child creation.
   * @returns active P1 member plus whether a missing child had to start.
   */
  recoverProvisioning(
    lead: Agent,
    attemptId: ExpertProvisionAttemptId,
    signal: AbortSignal,
  ): Promise<RecoveredExpert> {
    return this.locks.run(lead.id, async () => {
      const binding = this.requireBinding(lead, attemptId)
      const current = this.member(lead, attemptId, 'provisioning', 'active')
      try {
        this.assertPromptBytes(binding.initialPrompt)
        await this.assertResolvedBinding(binding, lead.session.header.cwd, signal)
        this.assertProvider(binding.subagentProvider)
        const live = this.ctx.sessions.get(binding.sessionId)
        const existing = await this.inspectChild(binding.sessionId, signal)
        if (existing !== undefined) {
          const descriptor = foldExpertChildDescriptor(existing)
          if (descriptor === undefined || !sameExpertDescriptor(binding, descriptor)) {
            throw revisionMismatch(binding.descriptor.digest, descriptor?.descriptor.digest ?? 'missing')
          }
          this.assertSubagentComposition(existing, binding)
          const member = current.phase === 'active' ? current : await this.activateAttempt(lead, attemptId)
          if (live === undefined && !hasExpertInitialPrompt(existing, binding.initialPrompt)) {
            const messageId = await this.followupBoundChild(lead, binding, signal)
            return { member, binding, started: true, messageId }
          }
          return { member, binding, started: false }
        }
        if (current.phase === 'active') {
          throw revisionMismatch(binding.descriptor.digest, 'active-child-missing')
        }
        const messageId = await this.startBoundChild(lead, binding, signal)
        return {
          member: this.member(lead, attemptId, 'active'),
          binding,
          started: true,
          messageId,
        }
      } catch (error: unknown) {
        await this.compensateFailure(lead, attemptId, binding.sessionId, error, signal)
        throw error
      }
    })
  }

  /**
   * Deliver a later expert message after validating current catalog content and the durable parent/child descriptor pair.
   * @param lead - exact live TeamRun Lead.
   * @param childId - exact expert child Session.
   * @param content - user-role content to enqueue.
   * @param options - durable attribution and pre-acceptance cancellation.
   * @returns accepted inbox message id.
   */
  async followup(
    lead: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    const run = this.ctx.teamRuns.getRun(lead)
    if (run.phase !== 'active') {
      throw new TeamRunError(`expert followup requires an active TeamRun; current phase is ${run.phase}`, 'TEAM_INVALID_TRANSITION')
    }
    const inspected = await this.requireInspectedChild(childId, options.signal)
    const descriptor = foldExpertChildDescriptor(inspected)
    if (descriptor === undefined) throw new TeamRunError(`child "${childId}" is not an expert runtime child`, 'TEAM_MEMBER_NOT_FOUND')
    const binding = this.requireBinding(lead, descriptor.attemptId)
    try {
      if (!sameExpertDescriptor(binding, descriptor)) {
        throw revisionMismatch(binding.descriptor.digest, descriptor.descriptor.digest)
      }
      this.assertSubagentComposition(inspected, binding)
      await this.assertResolvedBinding(binding, lead.session.header.cwd, options.signal)
      const token = this.authorize(childId, binding)
      try {
        return await this.ctx.subagents.followup(lead, childId, content, options)
      } finally {
        this.releaseAuthorization(childId, token)
      }
    } catch (error: unknown) {
      if (error instanceof TeamRunError && error.code === 'BLUEPRINT_REVISION_MISMATCH') {
        await this.compensateFailure(lead, binding.attemptId, childId, error, options.signal)
      }
      throw error
    }
  }

  /**
   * List immutable bindings owned by one live Lead.
   * @param lead - exact live TeamRun Lead.
   * @returns detached records in append order.
   */
  listBindings(lead: Agent): ExpertBindingEventData[] {
    this.ctx.teamRuns.getRun(lead)
    return structuredClone(foldExpertBindings(TeamRunId(lead.id), lead.session.events))
  }

  /** Prepare one binding descriptor and execution budget. */
  private bindingDescriptor(
    resolved: ResolvedExpertBinding,
    model: AgentOptions,
    displayRole: string,
    marketplaceSkills: NonNullable<ExpertBindingDescriptor['marketplaceSkills']>,
  ): ExpertBindingDescriptor {
    const budget = resolved.blueprint.budget
    const maxTokens = Math.min(resolved.blueprint.model.maxTokens ?? budget.maxTokens, budget.maxTokens)
    const deadlineAt = Date.now() + budget.timeoutMs
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new TeamRunError('ExpertBlueprint timeout exceeds the supported absolute deadline range', 'TEAM_INVALID_CONFIG')
    }
    return {
      blueprint: structuredClone(resolved.blueprint.ref),
      displayRole,
      blueprintDigest: resolved.blueprintDigest,
      preset: structuredClone(resolved.preset),
      skills: structuredClone(resolved.skills),
      marketplaceSkills: structuredClone(marketplaceSkills),
      plugins: structuredClone(resolved.plugins),
      digest: resolved.digest,
      model: structuredClone(model),
      compositionDigest: compositionDigest(resolved, model, this.config.subagentProvider, marketplaceSkills),
      execution: {
        maxTurns: budget.maxTurns,
        maxTokens,
        deadlineAt,
      },
    }
  }

  /** Resolve exact child Agent options, including the enforced effective token ceiling. */
  private agentOptions(
    resolved: ResolvedExpertBinding,
    inherited: AgentOptions = {},
  ): NonNullable<ExpertBindingEventData['agentOptions']> {
    const maxTokens = Math.min(
      resolved.blueprint.model.maxTokens ?? resolved.blueprint.budget.maxTokens,
      resolved.blueprint.budget.maxTokens,
    )
    const provider = resolved.blueprint.model.provider ?? inherited.provider
    const model = resolved.blueprint.model.model ?? inherited.model
    return {
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      maxTokens,
    }
  }

  /** Ensure the selected provider can establish continuable children before consuming an attempt. */
  private assertProvider(name: string): void {
    const provider = this.ctx.subagents.getProvider(name)
    if (provider?.prepareContinuable === undefined) {
      throw new TeamRunError(`continuable subagent provider "${name}" is unavailable`, 'CAPABILITY_UNAVAILABLE')
    }
  }

  /** Enforce the complete rendered prompt bound at the point its bytes are known. */
  private assertPromptBytes(prompt: string): void {
    const bytes = Buffer.byteLength(prompt, 'utf8')
    if (bytes > this.config.maxInitialPromptBytes) {
      throw new TeamRunError(
        `expert initial prompt uses ${String(bytes)} UTF-8 bytes; limit is ${String(this.config.maxInitialPromptBytes)}`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
  }

  /** Append and flush the immutable Lead binding before any child work starts. */
  private async appendBinding(lead: Agent, binding: ExpertBindingEventData): Promise<void> {
    if (findExpertBinding(binding.runId, lead.session.events, binding.attemptId) !== undefined) {
      throw new TeamRunError(`expert attempt "${binding.attemptId}" already has a binding`, 'TEAM_ATTEMPT_ID_TAKEN')
    }
    lead.session.append('collaboration/expert/binding', binding)
    await this.ctx.sessions.flush(lead.session)
  }

  /** Start one child and commit P1 activation immediately before initial prompt admission. */
  private async startBoundChild(
    lead: Agent,
    binding: ExpertBindingEventData,
    signal: AbortSignal,
  ): Promise<MessageId> {
    if (this.pending.has(binding.sessionId)) {
      throw new TeamRunError(`expert child "${binding.sessionId}" is already provisioning`, 'TEAM_SESSION_ID_TAKEN')
    }
    this.pending.set(binding.sessionId, binding)
    try {
      const started = await this.ctx.subagents.startContinuable({
        provider: binding.subagentProvider,
        label: binding.name,
        childId: binding.sessionId,
        agentPreset: binding.descriptor.preset.id,
        request: {
          parent: lead,
          prompt: [{ type: 'text', text: binding.initialPrompt }],
          agentOptions: binding.agentOptions,
          ...binding.persona === undefined ? {} : { persona: binding.persona },
          toolFilter: binding.toolFilter,
        },
        beforeInitialPrompt: async () => {
          if (Date.now() >= binding.descriptor.execution.deadlineAt) {
            throw new TeamRunError('expert execution deadline reached before initial prompt admission', 'TEAM_CANCELLED')
          }
          await this.activateAttempt(lead, binding.attemptId)
        },
        signal,
      })
      return started.messageId
    } finally {
      this.pending.delete(binding.sessionId)
    }
  }

  /** Cold-resume one persisted child and deliver a retained prompt under an exact one-call authorization. */
  private async followupBoundChild(
    lead: Agent,
    binding: ExpertBindingEventData,
    signal: AbortSignal,
  ): Promise<MessageId> {
    const token = this.authorize(binding.sessionId, binding)
    try {
      return await this.ctx.subagents.followup(
        lead,
        binding.sessionId,
        [{ type: 'text', text: binding.initialPrompt }],
        { source: { kind: 'user' }, signal },
      )
    } finally {
      this.releaseAuthorization(binding.sessionId, token)
    }
  }

  /** Add one independent activation token without allowing competing descriptors. */
  private authorize(childId: SessionId, binding: ExpertBindingEventData): symbol {
    const token = Symbol(childId)
    const current = this.authorizations.get(childId)
    if (current === undefined) {
      this.authorizations.set(childId, { binding, tokens: new Set([token]) })
      return token
    }
    if (!sameExpertDescriptor(current.binding, binding)) {
      throw revisionMismatch(current.binding.descriptor.digest, binding.descriptor.digest)
    }
    current.tokens.add(token)
    return token
  }

  /** Release only the caller's authorization token, preserving concurrent cold activations. */
  private releaseAuthorization(childId: SessionId, token: symbol): void {
    const current = this.authorizations.get(childId)
    if (current === undefined) return
    current.tokens.delete(token)
    if (current.tokens.size === 0) this.authorizations.delete(childId)
  }

  /** Append or verify the child-side descriptor inside the unpublished setup window. */
  private setupChild(child: Agent): () => void {
    const existing = foldExpertChildDescriptor(child.session)
    const pending = this.pending.get(child.id)
    const authorized = this.authorizations.get(child.id)?.binding
    if (existing === undefined && pending === undefined) return () => undefined
    const expected = pending ?? authorized
    if (expected === undefined) {
      throw revisionMismatch(existing?.descriptor.digest ?? 'missing', 'activation-not-authorized')
    }
    this.assertParentBinding(child, expected)
    this.assertSubagentComposition(child.session, expected)
    if (existing !== undefined) {
      if (!sameExpertDescriptor(expected, existing)) {
        throw revisionMismatch(expected.descriptor.digest, existing.descriptor.digest)
      }
      return this.mountMarketplaceSkills(child, expected.descriptor.marketplaceSkills ?? [])
    }
    const descriptor: ExpertChildDescriptorEventData = {
      version: 1,
      eventId: ExpertRuntimeEventId(`expert-runtime-event-${randomUUID()}`),
      runId: expected.runId,
      memberId: expected.memberId,
      sessionId: expected.sessionId,
      attemptId: expected.attemptId,
      descriptor: structuredClone(expected.descriptor),
    }
    child.session.append('collaboration/expert/descriptor', descriptor)
    return this.mountMarketplaceSkills(child, expected.descriptor.marketplaceSkills ?? [])
  }

  /** Register persisted method guidance and connected remote tools inside the exact expert scope. */
  private mountMarketplaceSkills(
    child: Agent,
    capabilities: NonNullable<ExpertBindingDescriptor['marketplaceSkills']>,
  ): () => void {
    const loaded = capabilities.filter(capability => capability.status === 'loaded' && capability.kind === 'method_skill')
    const connected = capabilities.filter(capability => capability.status === 'connected'
      && capability.kind === 'remote_tool' && capability.connection !== undefined)
    if (loaded.length === 0 && connected.length === 0) return () => undefined
    const skills = child.ctx.get('skills')
    if (loaded.length > 0 && skills === undefined) {
      throw new TeamRunError('loaded marketplace skills require the skill registry in the expert preset', 'CAPABILITY_UNAVAILABLE')
    }
    const marketplace = child.ctx.get('skillMarketplace')
    if (connected.length > 0 && marketplace === undefined) {
      throw new TeamRunError('connected marketplace tools require the marketplace runtime in the expert preset', 'CAPABILITY_UNAVAILABLE')
    }
    const tools = child.ctx.get('tools')
    if (connected.length > 0 && tools === undefined) {
      throw new TeamRunError('connected marketplace tools require the tool registry in the expert preset', 'CAPABILITY_UNAVAILABLE')
    }
    const disposers = loaded.flatMap((capability) => {
      if (capability.status !== 'loaded' || capability.kind !== 'method_skill'
        || capability.instructions === undefined || capability.skillName === undefined || skills === undefined) return []
      return [skills.register({
        name: capability.skillName,
        description: capability.description,
        whenToUse: `Use for the assigned ${capability.name} responsibility`,
        content: capability.instructions,
        source: 'marketplace',
        provider: capability.source,
        resourceBase: { kind: 'opaque', description: `Remote marketplace entry ${capability.id}` },
        invocation: { modelInvocable: true, userInvocable: false },
      })]
    })
    for (const capability of connected) {
      const connection = capability.connection
      if (connection === undefined) continue
      for (const rawToolName of connection.toolNames) {
        if (tools === undefined) continue
        disposers.push(tools.register({
          name: marketplaceRemoteToolName(capability.id, rawToolName),
          description: `${capability.description} Task-bound capability: ${capability.name}.`,
          parameters: { type: 'object', additionalProperties: true },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args, exec) {
            if (args === null || typeof args !== 'object' || Array.isArray(args)) {
              throw new TypeError(`marketplace tool "${rawToolName}" arguments must be an object`)
            }
            if (marketplace === undefined) throw new Error('marketplace runtime became unavailable')
            return marketplace.execute(capability, {
              tool: rawToolName,
              arguments: args as Readonly<Record<string, unknown>>,
            }, exec.signal) as Promise<JsonValue>
          },
        }))
      }
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  /** Match the independent subagent v3 route/composition snapshot to the P2 Lead binding. */
  private assertSubagentComposition(
    session: Pick<Session, 'events' | 'header'>,
    expected: ExpertBindingEventData,
  ): void {
    const descriptor = foldSubagentDescriptor(session.events.slice(session.header.seedLength ?? 0))
    const options = expected.agentOptions
    if (descriptor?.mode !== 'continuable'
      || descriptor.provider !== expected.subagentProvider
      || descriptor.label !== expected.name
      || descriptor.agentProvider !== options.provider
      || descriptor.agentModel !== options.model
      || descriptor.agentMaxTokens !== options.maxTokens
      || descriptor.agentPreset !== expected.descriptor.preset.id
      || descriptor.persona !== expected.persona
      || JSON.stringify(descriptor.toolFilter) !== JSON.stringify(expected.toolFilter)) {
      throw revisionMismatch(expected.descriptor.digest, 'subagent-composition-mismatch')
    }
  }

  /** Compare one child against its exact live parent and Lead binding. */
  private assertParentBinding(child: Agent, expected: ExpertBindingEventData): void {
    if (child.id !== expected.sessionId || String(child.session.header.parentSession) !== String(expected.runId)) {
      throw revisionMismatch(expected.descriptor.digest, 'child-identity-mismatch')
    }
    const parent = this.ctx.sessions.get(expected.runId as unknown as SessionId)
    if (parent === undefined) throw revisionMismatch(expected.descriptor.digest, 'lead-session-unavailable')
    const durable = findExpertBinding(expected.runId, parent.events, expected.attemptId)
    if (durable === undefined || !sameExpertDescriptor(durable, expected)) {
      throw revisionMismatch(expected.descriptor.digest, durable?.descriptor.digest ?? 'missing')
    }
  }

  /** Re-resolve catalog, preset, and skill content and compare the complete immutable binding. */
  private async assertResolvedBinding(
    binding: ExpertBindingEventData,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    let resolved: ResolvedExpertBinding
    try {
      resolved = await this.ctx.expertCatalog.resolve(binding.descriptor.blueprint, {
        ...cwd === undefined ? {} : { cwd },
        ...signal === undefined ? {} : { signal },
      })
    } catch (cause: unknown) {
      signal?.throwIfAborted()
      throw revisionMismatch(binding.descriptor.digest, 'unavailable', cause)
    }
    signal?.throwIfAborted()
    const maxTokens = Math.min(
      resolved.blueprint.model.maxTokens ?? resolved.blueprint.budget.maxTokens,
      resolved.blueprint.budget.maxTokens,
    )
    const expectedOptions = this.agentOptions(resolved, binding.descriptor.model)
    const displayRole = binding.descriptor.displayRole
    const expectedDescriptor: ExpertBindingDescriptor = {
      blueprint: structuredClone(resolved.blueprint.ref),
      ...displayRole === undefined ? {} : { displayRole },
      blueprintDigest: resolved.blueprintDigest,
      preset: structuredClone(resolved.preset),
      skills: structuredClone(resolved.skills),
      ...binding.descriptor.marketplaceSkills === undefined
        ? {}
        : { marketplaceSkills: structuredClone(binding.descriptor.marketplaceSkills) },
      plugins: structuredClone(resolved.plugins),
      digest: resolved.digest,
      model: structuredClone(expectedOptions),
      compositionDigest: compositionDigest(
        resolved,
        expectedOptions,
        binding.subagentProvider,
        binding.descriptor.marketplaceSkills,
      ),
      execution: {
        maxTurns: resolved.blueprint.budget.maxTurns,
        maxTokens,
        deadlineAt: binding.descriptor.execution.deadlineAt,
      },
    }
    const expectedPersona = resolved.blueprint.persona
    if (JSON.stringify(binding.descriptor) !== JSON.stringify(expectedDescriptor)
      || binding.role !== (displayRole ?? resolved.blueprint.role)
      || JSON.stringify(binding.agentOptions) !== JSON.stringify(expectedOptions)
      || binding.persona !== expectedPersona
      || JSON.stringify(binding.toolFilter) !== JSON.stringify(resolved.blueprint.tools)) {
      throw revisionMismatch(binding.descriptor.digest, `resolved-content:${resolved.digest}`)
    }
  }

  /** Validate a live expert at the final pre-model extension point. */
  private async assertCurrentBinding(
    child: Agent,
    descriptor: ExpertChildDescriptorEventData,
    signal: AbortSignal,
  ): Promise<void> {
    const parentId = child.session.header.parentSession
    const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (lead === undefined) throw revisionMismatch(descriptor.descriptor.digest, 'lead-agent-unavailable')
    const binding = this.requireBinding(lead, descriptor.attemptId)
    if (!sameExpertDescriptor(binding, descriptor)) {
      throw revisionMismatch(binding.descriptor.digest, descriptor.descriptor.digest)
    }
    this.assertSubagentComposition(child.session, binding)
    await this.assertResolvedBinding(binding, child.session.header.cwd, signal)
  }

  /** Commit P1 success with the latest revision after locating the exact provisioning row. */
  private async activateAttempt(lead: Agent, attemptId: ProvisionAttemptIdType): Promise<TeamMemberSnapshot> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = this.member(lead, attemptId, 'provisioning', 'active')
      if (current.phase === 'active') return current
      const revision = this.ctx.teamRuns.getRun(lead).revision
      try {
        return await this.ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: revision, attemptId })
      } catch (error: unknown) {
        if (!(error instanceof TeamRunError) || error.code !== 'STALE_REVISION') throw error
      }
    }
    throw new TeamRunError(`expert attempt "${attemptId}" could not settle after concurrent TeamRun writes`, 'RESOURCE_CONFLICT')
  }

  /** Locate one exact member and require one of the allowed phases. */
  private member(
    lead: Agent,
    attemptId: ProvisionAttemptIdType,
    ...phases: readonly TeamMemberSnapshot['phase'][]
  ): TeamMemberSnapshot {
    const member = this.ctx.teamRuns.getRun(lead).members.find(value => value.attemptId === attemptId)
    if (member === undefined) throw new TeamRunError(`expert attempt "${attemptId}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    if (!phases.includes(member.phase)) {
      throw new TeamRunError(`expert attempt "${attemptId}" is ${member.phase}`, 'TEAM_INVALID_TRANSITION')
    }
    return member
  }

  /** Resolve one exact immutable Lead binding. */
  private requireBinding(lead: Agent, attemptId: ProvisionAttemptIdType): ExpertBindingEventData {
    const runId = TeamRunId(lead.id)
    const binding = findExpertBinding(runId, lead.session.events, attemptId)
    if (binding === undefined) {
      throw new TeamRunError(`expert attempt "${attemptId}" has no durable capability binding`, 'BLUEPRINT_REVISION_MISMATCH')
    }
    return structuredClone(binding)
  }

  /** Inspect a live or persisted child, returning undefined only when no durable identity exists. */
  private async inspectChild(
    childId: SessionId,
    signal?: AbortSignal,
  ): Promise<Pick<Session, 'events' | 'header'> | undefined> {
    const live = this.ctx.sessions.get(childId)
    if (live !== undefined) return live
    const listed = await this.ctx.sessionPersistence.listSnapshots(signal)
    if (!listed.some(candidate => candidate.header.id === childId)) return undefined
    const inspected = await this.ctx.sessionPersistence.inspect(childId, signal)
    return { events: inspected.events, header: inspected.meta }
  }

  /** Inspect one required child. */
  private async requireInspectedChild(
    childId: SessionId,
    signal?: AbortSignal,
  ): Promise<Pick<Session, 'events' | 'header'>> {
    const child = await this.inspectChild(childId, signal)
    if (child === undefined) throw new TeamRunError(`expert child "${childId}" is unavailable`, 'TEAM_MEMBER_NOT_FOUND')
    return child
  }

  /** Roll back a failed provider/admission path to a P1 failed attempt after reaching child quiescence. */
  private async compensateFailure(
    lead: Agent,
    attemptId: ProvisionAttemptIdType,
    childId: SessionId,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.ctx.subagents.drainContinuableChildren(lead, [childId])
    } catch (cause: unknown) {
      failures.push(cause)
    } finally {
      this.clearDeadline(childId)
    }
    try {
      await this.settleFailure(lead, attemptId, error, signal)
    } catch (cause: unknown) {
      failures.push(cause)
    }
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'expert provisioning failed and compensation did not reach a clean failed state')
    }
  }

  /** Retry P1 failure settlement across unrelated concurrent TeamRun revisions. */
  private async settleFailure(
    lead: Agent,
    attemptId: ProvisionAttemptIdType,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const run = this.ctx.teamRuns.getRun(lead)
      const member = run.members.find(value => value.attemptId === attemptId)
      if (member === undefined || member.phase === 'failed') return
      try {
        await this.ctx.teamRuns.failExpertProvision(lead, {
          expectedRevision: run.revision,
          attemptId,
          failure: teamFailure(error, signal),
        })
        return
      } catch (failure: unknown) {
        if (!(failure instanceof TeamRunError) || failure.code !== 'STALE_REVISION') throw failure
      }
    }
    throw new TeamRunError(
      `expert attempt "${attemptId}" failure could not settle after concurrent TeamRun writes`,
      'RESOURCE_CONFLICT',
    )
  }

  /** Mark an active child failed when activation validation or budgets reject its next model step. */
  private async failFromChild(
    child: Agent,
    descriptor: ExpertChildDescriptorEventData,
    error: unknown,
  ): Promise<void> {
    const parentId = child.session.header.parentSession
    const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (lead === undefined) return
    if (this.parentRunIsTerminal(child)) {
      this.authorizations.delete(child.id)
      this.clearDeadline(child.id)
      return
    }
    try {
      await this.settleFailure(lead, descriptor.attemptId, error)
    } finally {
      this.authorizations.delete(child.id)
      this.clearDeadline(child.id)
    }
  }

  /** Install the persisted absolute deadline for one published expert Activation. */
  private installDeadline(agent: Agent): void {
    const descriptor = foldExpertChildDescriptor(agent.session)
    if (descriptor === undefined) return
    this.clearDeadline(agent.id)
    const delay = Math.max(0, descriptor.descriptor.execution.deadlineAt - Date.now())
    const timerDelay = Math.min(delay, 2_147_483_647)
    const timer = setTimeout(() => {
      this.deadlines.delete(agent.id)
      if (Date.now() < descriptor.descriptor.execution.deadlineAt) {
        this.installDeadline(agent)
        return
      }
      if (this.parentRunIsTerminal(agent)) return
      agent.cancel({ kind: 'hook', reason: 'expert execution deadline reached' })
      void this.failFromChild(
        agent,
        descriptor,
        new TeamRunError('expert execution deadline reached', 'TEAM_CANCELLED'),
      ).catch((error: unknown) => {
        this.ctx.logger.warn(`expert "${agent.id}" deadline cleanup failed: ${errorMessage(error)}`)
      })
    }, timerDelay)
    this.deadlines.set(agent.id, timer)
  }

  /** Clear one child deadline timer. */
  private clearDeadline(childId: SessionId): void {
    const timer = this.deadlines.get(childId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.deadlines.delete(childId)
  }

  /** Whether the exact live parent TeamRun has reached an irreversible terminal phase. */
  private parentRunIsTerminal(child: Agent): boolean {
    const parentId = child.session.header.parentSession
    const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (lead === undefined) return false
    const phase = this.ctx.teamRuns.getRun(lead).phase
    return phase === 'completed'
      || phase === 'formation_failed'
      || phase === 'failed'
      || phase === 'cancelled'
  }
}

export default ExpertRuntime
