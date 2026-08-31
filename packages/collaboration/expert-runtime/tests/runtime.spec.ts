import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  ProvisionAttemptId,
  TeamMemberId,
  type TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import TeamRunService from '@deepseek-ai/dsh-agent-team'
import {
  ExpertBindingDigest,
  ExpertBlueprintId,
  type ExpertBlueprint,
  type ResolvedExpertBinding,
} from '@deepseek-ai/dsh-expert-catalog'
import { createUserMessage, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillMarketplaceCapability } from '@deepseek-ai/dsh-skill-marketplace'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  type ContinuableStartSpec,
  type SubagentFollowupOptions,
} from '@deepseek-ai/dsh-subagent'
import ExpertRuntime, {
  ExpertRuntimeEventId,
  marketplaceRemoteToolName,
  renderExpertInitialPrompt,
  type ExpertBindingEventData,
  type ExpertChildDescriptorEventData,
} from '../src/index.ts'

interface PersistedChild {
  readonly header: SessionHeader
  readonly events: Session['events']
}

interface Harness {
  readonly ctx: Context
  readonly lead: Agent
  readonly resolved: ResolvedExpertBinding
  readonly order: string[]
  readonly starts: ContinuableStartSpec[]
  readonly followups: Array<{ childId: SessionId; content: ContentBlock[] }>
  readonly persisted: Map<SessionId, PersistedChild>
  readonly childDisposers: Map<SessionId, () => void | Promise<void>>
  readonly remoteTools: Map<string, ToolDefinition>
  readonly marketplaceExecute: ReturnType<typeof vi.fn>
  readonly catalogResolve: ReturnType<typeof vi.fn>
  failAfterActivation: boolean
  catalogValue: ResolvedExpertBinding
}

const contexts = new Set<Context>()
const digestA = 'a'.repeat(64)

afterEach(async () => {
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }
  vi.useRealTimers()
})

function blueprint(overrides: Partial<ExpertBlueprint> = {}): ExpertBlueprint {
  return {
    ref: { id: ExpertBlueprintId('researcher'), revision: 1 },
    role: 'Research analyst',
    objective: 'Find verifiable evidence and expose uncertainty',
    preset: 'research',
    skills: ['search'],
    plugins: ['@plugins/research'],
    tools: { allow: ['web_search'] },
    model: { provider: 'mock', model: 'expert-model', maxTokens: 4_096 },
    persona: 'Work as an evidence-first analyst',
    inputs: [{ name: 'question', description: 'Question to investigate', required: true }],
    outputs: [{ name: 'findings', description: 'Sourced findings', required: true }],
    acceptanceCriteria: ['Every material claim has evidence'],
    collaboration: { challenge: true, review: true, requestHelp: true },
    budget: { maxTurns: 2, maxTokens: 2_048, timeoutMs: 60_000 },
    ...overrides,
  }
}

describe('expert public-language instruction', () => {
  it('requires Chinese public collaboration for a Chinese user task', () => {
    const prompt = renderExpertInitialPrompt('researcher', blueprint(), {
      objective: '分析用户需求',
      language: 'zh',
      inputs: { question: '有哪些关键风险？' },
    })
    expect(prompt).toContain('Use Simplified Chinese for every public conclusion')
    expect(prompt).toContain('translate it into Chinese before publishing')
    expect(prompt).toContain('initial activation turn is setup-only')
    expect(prompt).toContain('Write a review-state artifact authored by you')
    expect(prompt).toContain('route exactly one artifact-linked public handoff or review')
    expect(prompt).toContain('Do not mark an enforced task complete yourself')
    expect(prompt).toContain('For ordinary routed messages, omit challenge_id')
    expect(prompt).toContain('use the latest revision')
  })

  it('requires English public collaboration for an English user task', () => {
    const prompt = renderExpertInitialPrompt('researcher', blueprint(), {
      objective: 'Analyze the user request',
      language: 'en',
      inputs: { question: 'What are the key risks?' },
    })
    expect(prompt).toContain('Use English for every public conclusion')
    expect(prompt).toContain('translate it into English before publishing')
  })
})

function resolvedBinding(configured = blueprint(), digest = digestA): ResolvedExpertBinding {
  return {
    blueprint: configured,
    blueprintDigest: digest,
    preset: { id: configured.preset, contentDigest: digest },
    skills: configured.skills.map(name => ({
      name,
      provider: 'filesystem',
      source: 'bundled',
      contentDigest: digest,
    })),
    plugins: configured.plugins,
    digest: ExpertBindingDigest(digest),
  }
}

function runtimeDigest(value: ResolvedExpertBinding, model: Agent['options'], provider = 'in-process'): string {
  return createHash('sha256').update(JSON.stringify({
    catalogDigest: value.digest,
    subagentProvider: provider,
    model,
    role: value.blueprint.role,
    persona: value.blueprint.persona,
    toolFilter: value.blueprint.tools,
  })).digest('hex')
}

function stubAgent(ctx: Context, session: Session, options: Agent['options'] = {}): Agent {
  return {
    id: session.id,
    session,
    options,
    status: 'idle',
    ctx,
    cancel: vi.fn(),
  } as unknown as Agent
}

function emitAgentStatus(ctx: Context, agent: Agent, status: Agent['status']): void {
  Object.assign(agent, { status })
  agentEvents(ctx, agent).emit('agent/status', { status })
}

async function setup(configured = blueprint()): Promise<Harness> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  const leadSession = ctx.sessions.create(SessionId(`lead-${crypto.randomUUID()}`))
  const lead = stubAgent(ctx, leadSession, { provider: 'mock', model: 'lead-model', maxTokens: 8_192 })
  ctx.agents.register(lead)
  await ctx.plugin(TeamRunService)

  const resolved = resolvedBinding(configured)
  const catalogResolve = vi.fn(async () => structuredClone(state.catalogValue))
  const state: Harness = {
    ctx,
    lead,
    resolved,
    catalogValue: resolved,
    order: [],
    starts: [],
    followups: [],
    persisted: new Map(),
    childDisposers: new Map(),
    remoteTools: new Map(),
    marketplaceExecute: vi.fn(async () => ({ content: [{ type: 'text', text: 'remote result' }] })),
    catalogResolve,
    failAfterActivation: false,
  }
  let setupContribution: ((childCtx: Context) => undefined | (() => void)) | undefined
  ctx.provide('expertCatalog', {
    resolve: catalogResolve,
  } as never)
  ctx.provide('tools', {
    register: vi.fn((definition: ToolDefinition) => {
      if (state.remoteTools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      state.remoteTools.set(definition.name, definition)
      return () => { state.remoteTools.delete(definition.name) }
    }),
  } as never)
  ctx.provide('skillMarketplace', { execute: state.marketplaceExecute } as never)
  ctx.provide('sessionPersistence', {
    listSnapshots: vi.fn(async () => [...state.persisted.values()].map(value => ({ header: value.header }))),
    inspect: vi.fn(async (id: SessionId) => {
      const value = state.persisted.get(id)
      if (value === undefined) throw new Error(`missing persisted child ${id}`)
      return { meta: structuredClone(value.header), events: structuredClone(value.events) }
    }),
  } as never)
  ctx.provide('subagents', {
    registerContinuableSetup: vi.fn((contribution: typeof setupContribution) => {
      setupContribution = contribution
      return () => { setupContribution = undefined }
    }),
    getProvider: vi.fn(() => ({ prepareContinuable: vi.fn() })),
    startContinuable: vi.fn(async (spec: ContinuableStartSpec) => {
      state.starts.push(spec)
      const childId = spec.childId ?? SessionId(`child-${crypto.randomUUID()}`)
      const childSession = ctx.sessions.prepare(childId, {
        meta: {
          parentSession: spec.request.parent.id,
          seedLength: 0,
          origin: 'subagent',
          delegationDepth: 1,
          ...spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset },
        },
      })
      const child = stubAgent(ctx, childSession, spec.request.agentOptions)
      childSession.append('subagent/descriptor', {
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: spec.provider,
        label: spec.label,
        ...spec.request.agentOptions?.provider === undefined ? {} : { agentProvider: spec.request.agentOptions.provider },
        ...spec.request.agentOptions?.model === undefined ? {} : { agentModel: spec.request.agentOptions.model },
        ...spec.request.agentOptions?.maxTokens === undefined ? {} : { agentMaxTokens: spec.request.agentOptions.maxTokens },
        ...spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset },
        ...spec.request.persona === undefined ? {} : { persona: spec.request.persona },
        ...spec.request.toolFilter === undefined ? {} : { toolFilter: spec.request.toolFilter },
      })
      setupContribution?.({ agent: child } as Context)
      const detachSession = ctx.sessions.enter(childSession)
      ctx.sessions.announce(childSession)
      const detachAgent = ctx.agents.register(child)
      state.childDisposers.set(childId, async () => {
        detachAgent()
        detachSession()
      })
      state.order.push(lead.session.events.some(event => event.type === 'collaboration/expert/binding')
        ? 'binding-before-publication'
        : 'published-without-binding')
      if (spec.beforeInitialPrompt !== undefined) await spec.beforeInitialPrompt()
      state.order.push(ctx.teamRuns.getRun(lead).members.some(member => member.sessionId === childId && member.phase === 'active')
        ? 'active-before-prompt'
        : 'prompt-before-active')
      if (state.failAfterActivation) throw new Error('synthetic inbox admission failure')
      childSession.append(
        'user/message',
        createUserMessage({ content: spec.request.prompt, source: { kind: 'user' } }),
        { surfaceOp: 'append' },
      )
      state.order.push('prompt-admitted')
      return { childId, messageId: MessageId(`initial-${childId}`) }
    }),
    followup: vi.fn(async (
      _parent: Agent,
      childId: SessionId,
      content: ContentBlock[],
      _options: SubagentFollowupOptions,
    ) => {
      state.followups.push({ childId, content: structuredClone(content) })
      const live = ctx.agents.get(childId)
      if (live === undefined) {
        const stored = state.persisted.get(childId)
        if (stored === undefined) throw new Error(`cannot cold resume ${childId}`)
        const cold = stubAgent(ctx, {
          id: childId,
          header: stored.header,
          events: stored.events,
        } as Session)
        setupContribution?.({ agent: cold } as Context)
      }
      return MessageId(`followup-${childId}-${String(state.followups.length)}`)
    }),
    drainContinuableChildren: vi.fn(async (_parent: Agent, childIds: readonly SessionId[]) => {
      for (const id of childIds) {
        const dispose = state.childDisposers.get(id)
        if (dispose !== undefined) await dispose()
        state.childDisposers.delete(id)
      }
    }),
  } as never)
  await ctx.plugin(ExpertRuntime, { subagentProvider: 'in-process', maxInitialPromptBytes: 64_000 })
  return state
}

async function enterProvisioning(harness: Harness): Promise<TeamRunSnapshot> {
  const { ctx, lead } = harness
  let run = await ctx.teamRuns.createRun(lead, {
    objective: 'Deliver researched findings',
    complexity: 'simple',
    plannedExperts: 1,
  })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
  return await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
}

async function provision(
  harness: Harness,
  suffix = 'one',
  role?: string,
  marketplaceSkills?: readonly SkillMarketplaceCapability[],
  localSkills?: readonly string[],
  modelSelection?: ModelSelection,
) {
  const run = await enterProvisioning(harness)
  return await harness.ctx.expertRuntime.provision(harness.lead, {
    expectedRevision: run.revision,
    memberId: TeamMemberId(`member-${suffix}`),
    sessionId: SessionId(`child-${suffix}`),
    attemptId: ProvisionAttemptId(`attempt-${suffix}`),
    name: `expert-${suffix}`,
    ...role === undefined ? {} : { role },
    blueprint: harness.resolved.blueprint.ref,
    ...localSkills === undefined ? {} : { localSkills },
    ...modelSelection === undefined ? {} : { modelSelection },
    ...marketplaceSkills === undefined ? {} : { marketplaceSkills },
    assignment: { objective: 'Investigate the question', inputs: { question: 'What changed?' } },
    signal: new AbortController().signal,
  })
}

function manualBinding(
  harness: Harness,
  identity: { member: string; child: string; attempt: string; name: string },
): ExpertBindingEventData {
  const value = harness.resolved
  const maxTokens = Math.min(value.blueprint.model.maxTokens ?? value.blueprint.budget.maxTokens, value.blueprint.budget.maxTokens)
  const provider = value.blueprint.model.provider ?? harness.lead.options.provider
  const model = value.blueprint.model.model ?? harness.lead.options.model
  const agentOptions = {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    maxTokens,
  }
  return {
    version: 1,
    eventId: ExpertRuntimeEventId(`event-${identity.attempt}`),
    runId: harness.ctx.teamRuns.getRun(harness.lead).id,
    memberId: TeamMemberId(identity.member),
    sessionId: SessionId(identity.child),
    attemptId: ProvisionAttemptId(identity.attempt),
    name: identity.name,
    role: value.blueprint.role,
    subagentProvider: 'in-process',
    descriptor: {
      blueprint: value.blueprint.ref,
      blueprintDigest: value.blueprintDigest,
      preset: value.preset,
      skills: value.skills,
      plugins: value.plugins,
      digest: value.digest,
      model: agentOptions,
      compositionDigest: runtimeDigest(value, agentOptions),
      execution: {
        maxTurns: value.blueprint.budget.maxTurns,
        maxTokens,
        deadlineAt: Date.now() + value.blueprint.budget.timeoutMs,
      },
    },
    initialPrompt: renderExpertInitialPrompt(identity.name, value.blueprint, {
      objective: 'Investigate the question',
      inputs: { question: 'What changed?' },
    }),
    agentOptions,
    ...value.blueprint.persona === undefined ? {} : { persona: value.blueprint.persona },
    toolFilter: value.blueprint.tools,
  }
}

async function reserveBinding(harness: Harness, binding: ExpertBindingEventData): Promise<void> {
  const run = harness.ctx.teamRuns.getRun(harness.lead)
  await harness.ctx.teamRuns.beginExpertProvision(harness.lead, {
    expectedRevision: run.revision,
    memberId: binding.memberId,
    sessionId: binding.sessionId,
    attemptId: binding.attemptId,
    name: binding.name,
    role: binding.role,
  })
  harness.lead.session.append('collaboration/expert/binding', binding)
  await harness.ctx.sessions.flush(harness.lead.session)
}

function persistedDescriptor(binding: ExpertBindingEventData, withPrompt: boolean): PersistedChild {
  const descriptor: ExpertChildDescriptorEventData = {
    version: 1,
    eventId: ExpertRuntimeEventId(`child-event-${binding.attemptId}`),
    runId: binding.runId,
    memberId: binding.memberId,
    sessionId: binding.sessionId,
    attemptId: binding.attemptId,
    descriptor: binding.descriptor,
  }
  const events: Session['events'] = [
    {
      seq: 0,
      time: 0,
      type: 'subagent/descriptor',
      data: {
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: binding.subagentProvider,
        label: binding.name,
        ...binding.agentOptions.provider === undefined ? {} : { agentProvider: binding.agentOptions.provider },
        ...binding.agentOptions.model === undefined ? {} : { agentModel: binding.agentOptions.model },
        ...binding.agentOptions.maxTokens === undefined ? {} : { agentMaxTokens: binding.agentOptions.maxTokens },
        agentPreset: binding.descriptor.preset.id,
        ...binding.persona === undefined ? {} : { persona: binding.persona },
        toolFilter: binding.toolFilter,
      },
    },
    { seq: 1, time: 1, type: 'collaboration/expert/descriptor', data: descriptor },
    ...withPrompt
      ? [{
        seq: 2,
        time: 2,
        type: 'user/message' as const,
        surfaceOp: 'append' as const,
        data: createUserMessage({
          content: [{ type: 'text', text: binding.initialPrompt }],
          source: { kind: 'user' },
        }),
      }]
      : [],
  ]
  return {
    header: {
      version: 0,
      id: binding.sessionId,
      createdAt: Date.now(),
      parentSession: SessionId(binding.runId),
      seedLength: 0,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: binding.descriptor.preset.id,
    },
    events,
  }
}

describe('ExpertRuntime', () => {
  it('binds before publication, activates before prompt admission, and snapshots the effective token ceiling', async () => {
    const harness = await setup()
    const result = await provision(harness)
    expect(result.member.phase).toBe('active')
    expect(harness.order).toEqual(['binding-before-publication', 'active-before-prompt', 'prompt-admitted'])
    expect(harness.starts).toHaveLength(1)
    expect(harness.starts[0]).toMatchObject({ agentPreset: 'research' })
    expect(harness.starts[0]?.request.agentOptions).toMatchObject({
      provider: 'mock', model: 'expert-model', maxTokens: 2_048,
    })
    expect(result.binding.descriptor.execution).toMatchObject({ maxTurns: 2, maxTokens: 2_048 })
    const child = harness.ctx.sessions.get(result.member.sessionId)
    expect(child?.events.map(event => event.type)).toContain('collaboration/expert/descriptor')
  })

  it('retains a task-language public role while validating the immutable blueprint role', async () => {
    const harness = await setup()
    const result = await provision(harness, 'localized', '研究分析专家')

    expect(result.member).toMatchObject({ phase: 'active', role: '研究分析专家' })
    expect(result.binding).toMatchObject({
      role: '研究分析专家',
      descriptor: { displayRole: '研究分析专家', blueprint: { id: 'researcher', revision: 1 } },
    })
  })

  it('binds the task-reviewed local skills forwarded by the team plan', async () => {
    const harness = await setup()
    const localSkills = ['search', 'technical-review', 'risk-analysis']
    harness.catalogValue = resolvedBinding(blueprint({ skills: localSkills }), 'c'.repeat(64))

    const result = await provision(harness, 'reviewed-skills', undefined, undefined, localSkills)

    expect(harness.catalogResolve).toHaveBeenCalledWith(
      harness.resolved.blueprint.ref,
      expect.objectContaining({ skills: localSkills }),
    )
    expect(result.binding.descriptor.skills.map(skill => skill.name)).toEqual(localSkills)
    expect(result.binding.initialPrompt).toContain('Required skills:\n- search\n- technical-review\n- risk-analysis')
  })

  it('mounts one selected skills.sh method inside the expert skill registry and records its visible name', async () => {
    const harness = await setup()
    const method: SkillMarketplaceCapability = {
      id: 'skills.sh:trusted/skills/research',
      name: 'research',
      description: 'Evidence-led research method',
      source: 'skills_sh',
      kind: 'method_skill',
      status: 'loaded',
      verified: true,
      skillName: 'market-trusted-skills-research',
      instructions: 'Use primary sources and identify uncertainty',
    }

    const result = await provision(harness, 'market', undefined, [method])

    expect(result.binding.descriptor.marketplaceSkills).toEqual([method])
    expect(result.binding.initialPrompt).toContain('market-trusted-skills-research (research, skills.sh)')
    await expect(harness.ctx.skills.get('market-trusted-skills-research')).resolves.toMatchObject({
      provider: 'skills_sh',
      content: 'Use primary sources and identify uncertainty',
      invocation: { modelInvocable: true, userInvocable: false },
    })
  })

  it('mounts only connected task-selected remote tools and executes through the marketplace service', async () => {
    const harness = await setup()
    const remote: SkillMarketplaceCapability = {
      id: 'smithery:huggingface',
      name: 'Hugging Face',
      description: 'Search model and dataset metadata',
      source: 'smithery',
      kind: 'remote_tool',
      status: 'connected',
      access: 'public',
      verified: true,
      connection: { connectionId: 'huggingface', toolNames: ['hub_repo_search'] },
    }

    await provision(harness, 'remote-market', undefined, [remote])

    const publicName = marketplaceRemoteToolName(remote.id, 'hub_repo_search')
    const definition = harness.remoteTools.get(publicName)
    expect(definition).toMatchObject({ name: publicName })
    await expect(definition?.execute({ query: 'agents' }, {
      signal: new AbortController().signal,
    } as never)).resolves.toEqual({ content: [{ type: 'text', text: 'remote result' }] })
    expect(harness.marketplaceExecute).toHaveBeenCalledWith(remote, {
      tool: 'hub_repo_search', arguments: { query: 'agents' },
    }, expect.any(AbortSignal))
  })

  it('compensates an admission failure after activation into a visible failed roster row', async () => {
    const harness = await setup()
    harness.failAfterActivation = true
    await expect(provision(harness)).rejects.toThrow('synthetic inbox admission failure')
    const member = harness.ctx.teamRuns.getRun(harness.lead).members[0]
    expect(member).toMatchObject({ phase: 'failed', failure: { code: 'CAPABILITY_UNAVAILABLE' } })
    expect(harness.ctx.agents.get(SessionId('child-one'))).toBeUndefined()
  })

  it('settles an active expert as failed when its model execution reports an upstream error', async () => {
    const harness = await setup()
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')

    agentEvents(harness.ctx, child).emit('agent/error', {
      turn: 1,
      step: 1,
      error: Object.assign(new Error('no healthy upstream'), { code: 'PI_AI_ERROR' }),
    })

    await vi.waitFor(() => {
      expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({
        phase: 'failed',
        failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'no healthy upstream' },
      })
    })
    expect(harness.ctx.teamRuns.tryMembership(child)).toBeUndefined()
  })

  it('refuses a new handoff to an expert whose latest persisted turn already failed', async () => {
    const harness = await setup()
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    child.session.append('turn/start', { turn: 1 })
    child.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'no healthy upstream', code: 'PI_AI_ERROR' } },
    })
    const current = harness.ctx.teamRuns.getRun(harness.lead)
    await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: current.revision, phase: 'active' })

    await expect(harness.ctx.expertRuntime.followup(
      harness.lead,
      result.member.sessionId,
      [{ type: 'text', text: 'Execute the next serialized task' }],
      { source: { kind: 'user' }, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })

    expect(harness.followups).toHaveLength(0)
    const failed = harness.ctx.teamRuns.getRun(harness.lead).members[0]
    expect(failed).toMatchObject({ phase: 'failed', failure: { code: 'CAPABILITY_UNAVAILABLE' } })
    expect(failed?.failure?.message).toContain('no healthy upstream')
  })

  it('reconciles an active roster member whose persisted expert turn was interrupted before Lead restoration', async () => {
    const harness = await setup()
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    child.session.append('turn/start', { turn: 1 })
    child.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'interrupted' },
    })
    const current = harness.ctx.teamRuns.getRun(harness.lead)
    await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: current.revision, phase: 'active' })

    harness.ctx.emit('agent/created', { agent: harness.lead })

    await vi.waitFor(() => {
      const failed = harness.ctx.teamRuns.getRun(harness.lead).members[0]
      expect(failed).toMatchObject({ phase: 'failed', failure: { code: 'CAPABILITY_UNAVAILABLE' } })
      expect(failed?.failure?.message).toContain('process stopped before the expert turn completed')
    })
  })

  it('recovers a missing child once, but cold-resumes a descriptor without replaying already logged initial work', async () => {
    const missing = await setup()
    await enterProvisioning(missing)
    const binding = manualBinding(missing, {
      member: 'member-recover', child: 'child-recover', attempt: 'attempt-recover', name: 'recoverer',
    })
    await reserveBinding(missing, binding)
    const recreated = await missing.ctx.expertRuntime.recoverProvisioning(
      missing.lead,
      binding.attemptId,
      new AbortController().signal,
    )
    expect(recreated).toMatchObject({ started: true, member: { phase: 'active' } })
    expect(missing.starts).toHaveLength(1)

    const cold = await setup()
    await enterProvisioning(cold)
    const coldBinding = manualBinding(cold, {
      member: 'member-cold', child: 'child-cold', attempt: 'attempt-cold', name: 'cold-reader',
    })
    await reserveBinding(cold, coldBinding)
    cold.persisted.set(coldBinding.sessionId, persistedDescriptor(coldBinding, false))
    const resumed = await cold.ctx.expertRuntime.recoverProvisioning(
      cold.lead,
      coldBinding.attemptId,
      new AbortController().signal,
    )
    expect(resumed).toMatchObject({ started: true, member: { phase: 'active' } })
    expect(cold.starts).toHaveLength(0)
    expect(cold.followups).toEqual([{
      childId: coldBinding.sessionId,
      content: [{ type: 'text', text: coldBinding.initialPrompt }],
    }])

    const logged = await setup()
    await enterProvisioning(logged)
    const loggedBinding = manualBinding(logged, {
      member: 'member-logged', child: 'child-logged', attempt: 'attempt-logged', name: 'logged-reader',
    })
    await reserveBinding(logged, loggedBinding)
    const revision = logged.ctx.teamRuns.getRun(logged.lead).revision
    await logged.ctx.teamRuns.succeedExpertProvision(logged.lead, {
      expectedRevision: revision,
      attemptId: loggedBinding.attemptId,
    })
    logged.persisted.set(loggedBinding.sessionId, persistedDescriptor(loggedBinding, true))
    const existing = await logged.ctx.expertRuntime.recoverProvisioning(
      logged.lead,
      loggedBinding.attemptId,
      new AbortController().signal,
    )
    expect(existing).toMatchObject({ started: false, member: { phase: 'active' } })
    expect(logged.starts).toHaveLength(0)
    expect(logged.followups).toHaveLength(0)
  })

  it('fails closed and settles the member when current catalog content or a durable outer binding field is tampered', async () => {
    const harness = await setup()
    const result = await provision(harness)
    let run = harness.ctx.teamRuns.getRun(harness.lead)
    run = await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: run.revision, phase: 'active' })
    harness.catalogValue = resolvedBinding({
      ...harness.resolved.blueprint,
      plugins: ['@plugins/research', '@plugins/changed'],
    }, 'c'.repeat(64))
    await expect(harness.ctx.expertRuntime.followup(
      harness.lead,
      result.member.sessionId,
      [{ type: 'text', text: 'Continue' }],
      { source: { kind: 'user' }, signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'BLUEPRINT_REVISION_MISMATCH' })
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({
      phase: 'failed', failure: { code: 'BLUEPRINT_REVISION_MISMATCH' },
    })

    const tampered = await setup()
    await enterProvisioning(tampered)
    const binding = manualBinding(tampered, {
      member: 'member-tampered', child: 'child-tampered', attempt: 'attempt-tampered', name: 'tampered-reader',
    })
    await reserveBinding(tampered, { ...binding, role: 'Injected role' })
    await expect(tampered.ctx.expertRuntime.recoverProvisioning(
      tampered.lead,
      binding.attemptId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'BLUEPRINT_REVISION_MISMATCH' })

    const oversized = await setup()
    await enterProvisioning(oversized)
    const normal = manualBinding(oversized, {
      member: 'member-oversized', child: 'child-oversized', attempt: 'attempt-oversized', name: 'oversized-reader',
    })
    const oversizedBinding = { ...normal, initialPrompt: 'x'.repeat(64_001) }
    await reserveBinding(oversized, oversizedBinding)
    await expect(oversized.ctx.expertRuntime.recoverProvisioning(
      oversized.lead,
      normal.attemptId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(oversized.ctx.teamRuns.getRun(oversized.lead).members[0]).toMatchObject({ phase: 'failed' })

    const subagentDrift = await setup()
    await enterProvisioning(subagentDrift)
    const driftBinding = manualBinding(subagentDrift, {
      member: 'member-subagent-drift',
      child: 'child-subagent-drift',
      attempt: 'attempt-subagent-drift',
      name: 'subagent-drift-reader',
    })
    await reserveBinding(subagentDrift, driftBinding)
    const stored = structuredClone(persistedDescriptor(driftBinding, true))
    const subagentEvent = stored.events[0]
    if (subagentEvent?.type !== 'subagent/descriptor' || subagentEvent.data.mode !== 'continuable') {
      throw new Error('subagent descriptor missing')
    }
    subagentDrift.persisted.set(driftBinding.sessionId, {
      ...stored,
      events: [{ ...subagentEvent, data: { ...subagentEvent.data, agentModel: 'tampered-model' } }, ...stored.events.slice(1)],
    })
    await expect(subagentDrift.ctx.expertRuntime.recoverProvisioning(
      subagentDrift.lead,
      driftBinding.attemptId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'BLUEPRINT_REVISION_MISMATCH' })
    expect(subagentDrift.ctx.teamRuns.getRun(subagentDrift.lead).members[0]).toMatchObject({ phase: 'failed' })
  })

  it('enforces own-turn budgets before model entry and revokes TeamRun membership', async () => {
    const harness = await setup(blueprint({ budget: { maxTurns: 1, maxTokens: 2_048, timeoutMs: 60_000 } }))
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    child.session.append('turn/start', { turn: 40 })
    child.session.append('turn/start', { turn: 41 })
    await expect(agentEvents(harness.ctx, child).waterfall(
      'agent/pre-step',
      { messages: [], turn: 41, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )).rejects.toMatchObject({ code: 'TEAM_CANCELLED' })
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'failed' })
    expect(harness.ctx.teamRuns.tryMembership(child)).toBeUndefined()
  })

  it('snapshots an inherited Lead route and preserves it through a cold recovery', async () => {
    const configured = blueprint({ model: { maxTokens: 4_096 } })
    const harness = await setup(configured)
    await enterProvisioning(harness)
    const binding = manualBinding(harness, {
      member: 'member-inherited', child: 'child-inherited', attempt: 'attempt-inherited', name: 'inherited-reader',
    })
    expect(binding.agentOptions).toEqual({ provider: 'mock', model: 'lead-model', maxTokens: 2_048 })
    expect(binding.descriptor.model).toEqual(binding.agentOptions)
    await reserveBinding(harness, binding)
    harness.persisted.set(binding.sessionId, persistedDescriptor(binding, false))
    const recovered = await harness.ctx.expertRuntime.recoverProvisioning(
      harness.lead,
      binding.attemptId,
      new AbortController().signal,
    )
    expect(recovered).toMatchObject({ started: true, member: { phase: 'active' } })
    expect(harness.followups).toHaveLength(1)

    const corrupted = await setup(configured)
    await enterProvisioning(corrupted)
    const original = manualBinding(corrupted, {
      member: 'member-corrupt-route',
      child: 'child-corrupt-route',
      attempt: 'attempt-corrupt-route',
      name: 'corrupt-route-reader',
    })
    const changedModel = { provider: 'tampered', model: 'tampered-model', maxTokens: 2_048 }
    const tampered = {
      ...original,
      agentOptions: changedModel,
      descriptor: { ...original.descriptor, model: changedModel },
    }
    await reserveBinding(corrupted, tampered)
    await expect(corrupted.ctx.expertRuntime.recoverProvisioning(
      corrupted.lead,
      original.attemptId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'BLUEPRINT_REVISION_MISMATCH' })
  })

  it('inherits the Lead current model selection instead of its stale creation route', async () => {
    const configured = blueprint({ model: { maxTokens: 4_096 } })
    const harness = await setup(configured)
    installModelSelection(harness.lead.ctx, {
      current: { provider: 'selected-provider', model: 'selected-model' },
      assembled: undefined,
    })

    const result = await provision(harness, 'selected-route')

    expect(result.binding.agentOptions).toEqual({
      provider: 'selected-provider',
      model: 'selected-model',
      maxTokens: 2_048,
    })
    expect(harness.starts[0]?.request.agentOptions).toEqual(result.binding.agentOptions)
  })

  it('uses the reviewed expert model route from the first child turn', async () => {
    const configured = blueprint({ model: { provider: 'blueprint', model: 'blueprint-model', maxTokens: 4_096 } })
    const harness = await setup(configured)
    installModelSelection(harness.lead.ctx, {
      current: { provider: 'lead-provider', model: 'lead-model' },
      assembled: undefined,
    })

    const result = await provision(
      harness,
      'reviewed-route',
      undefined,
      undefined,
      undefined,
      { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' as never },
    )

    expect(result.binding.agentOptions).toEqual({ provider: 'openai', model: 'gpt-5', maxTokens: 2_048 })
    expect(result.binding.descriptor.foundation?.modelSelection).toEqual({
      provider: 'openai', model: 'gpt-5', reasoningEffort: 'high',
    })
    expect(harness.starts[0]?.request.agentOptions).toEqual(result.binding.agentOptions)
  })

  it('does not spend the execution timeout while an expert waits idle for the serial baton', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const harness = await setup(blueprint({ budget: { maxTurns: 2, maxTokens: 2_048, timeoutMs: 50 } }))
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    const cancel = vi.spyOn(child, 'cancel')

    await vi.advanceTimersByTimeAsync(500)
    expect(cancel).not.toHaveBeenCalled()
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'active' })

    const run = await harness.ctx.teamRuns.changePhase(harness.lead, {
      expectedRevision: harness.ctx.teamRuns.getRun(harness.lead).revision,
      phase: 'active',
    })
    expect(run.phase).toBe('active')
    await expect(harness.ctx.expertRuntime.followup(
      harness.lead,
      result.member.sessionId,
      [{ type: 'text', text: 'Review the next serialized handoff' }],
      { source: { kind: 'user' }, signal: new AbortController().signal },
    )).resolves.toBeDefined()
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'active' })
  })

  it('settles the roster and cancels the child when its active execution window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const harness = await setup(blueprint({ budget: { maxTurns: 2, maxTokens: 2_048, timeoutMs: 50 } }))
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    const cancel = vi.spyOn(child, 'cancel')
    emitAgentStatus(harness.ctx, child, 'running')
    await vi.advanceTimersByTimeAsync(51)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'expert active execution deadline reached' })
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({
      phase: 'failed', failure: { code: 'TEAM_CANCELLED' },
    })
    expect(harness.ctx.teamRuns.tryMembership(child)).toBeUndefined()
  })

  it('pauses the active execution deadline while the expert waits for user approval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const harness = await setup(blueprint({ budget: { maxTurns: 2, maxTokens: 2_048, timeoutMs: 50 } }))
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    const cancel = vi.spyOn(child, 'cancel')
    emitAgentStatus(harness.ctx, child, 'running')
    await vi.advanceTimersByTimeAsync(20)

    const approvalId = ApprovalRequestId('expert-runtime-approval')
    child.session.append('approval/asked', { id: approvalId, toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(500)
    expect(cancel).not.toHaveBeenCalled()
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'active' })

    child.session.append('approval/decided', { id: approvalId, outcome: 'allowed-once' })
    await vi.advanceTimersByTimeAsync(29)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'expert active execution deadline reached' })
  })

  it('clears a late deadline without mutating a terminal run and rejects later model entry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const harness = await setup(blueprint({ budget: { maxTurns: 2, maxTokens: 2_048, timeoutMs: 50 } }))
    const result = await provision(harness)
    const child = harness.ctx.agents.get(result.member.sessionId)
    if (child === undefined) throw new Error('child missing')
    const cancel = vi.spyOn(child, 'cancel')
    emitAgentStatus(harness.ctx, child, 'running')
    let run = harness.ctx.teamRuns.getRun(harness.lead)
    run = await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: run.revision, phase: 'active' })
    run = await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: run.revision, phase: 'completing' })
    await harness.ctx.teamRuns.changePhase(harness.lead, { expectedRevision: run.revision, phase: 'completed' })
    await vi.advanceTimersByTimeAsync(51)
    expect(cancel).not.toHaveBeenCalled()
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'active' })

    child.session.append('turn/start', { turn: 1 })
    await expect(agentEvents(harness.ctx, child).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )).rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })
    expect(harness.ctx.teamRuns.getRun(harness.lead).members[0]).toMatchObject({ phase: 'active' })
  })
})
