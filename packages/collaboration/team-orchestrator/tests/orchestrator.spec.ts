import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import TeamRunService, {
  CollaborationEventId,
  ProvisionAttemptId,
  TeamMemberId,
  TeamRunError,
  TeamRunId,
} from '@deepseek-ai/dsh-agent-team'
import { ExpertBlueprintId, type ExpertBlueprint } from '@deepseek-ai/dsh-expert-catalog'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SkillMarketplaceCapability } from '@deepseek-ai/dsh-skill-marketplace'
import TeamOrchestrator, { TeamOrchestrationRequestId, type Config } from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }
})

function blueprint(index: number): ExpertBlueprint {
  return {
    ref: { id: ExpertBlueprintId(`demo-expert-${String(index)}`), revision: 1 },
    role: `Demo expert ${String(index)}`,
    objective: 'Deliver one bounded part of the task',
    preset: 'standard',
    skills: ['demo-professional-skill', 'demo-peer-review-skill'],
    plugins: ['@plugins/demo-capability'],
    tools: {},
    model: {},
    inputs: [{ name: 'task', description: 'Task input', required: true }],
    outputs: [{ name: 'result', description: 'Task result', required: true }],
    acceptanceCriteria: ['Return a reviewable public result'],
    collaboration: {
      challenge: index % 2 === 1,
      review: index % 3 !== 0,
      requestHelp: index <= 4,
    },
    budget: { maxTurns: 2, maxTokens: 1_024, timeoutMs: 60_000 },
  }
}

function config(count = 8): Config {
  const blueprints = Array.from({ length: count }, (_, index) => blueprint(index + 1).ref)
  return {
    pools: [
      { domain: 'research_analysis', blueprints },
      { domain: 'product_solution', blueprints },
      { domain: 'software_development', blueprints },
    ],
    maxTextBytes: 16_384,
    maxWorkstreams: 16,
    maxListItems: 32,
    maxContextEntries: 32,
    maxEventBytes: 1_000_000,
    maxMarketplaceSkillsPerExpert: 3,
    communication: {
      simple: { maxChallengeRounds: 1, maxMessagesPerExpert: 4 },
      medium: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 },
      complex: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
    },
  }
}

function stubAgent(ctx: Context, session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'mock', model: 'mock' },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    ctx,
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => undefined),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent
}

async function setup(options: {
  readonly count?: number
  readonly failProvision?: boolean
  readonly failReplacement?: boolean
  readonly blockProvision?: boolean
  readonly discoverMarketplaceSkills?: boolean
} = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TeamRunService, { maxProvisionAttempts: 16 })
  const lead = stubAgent(ctx, ctx.sessions.create(SessionId(`lead-${crypto.randomUUID()}`)))
  ctx.agents.register(lead)
  const catalog = new Map(Array.from({ length: options.count ?? 8 }, (_, index) => {
    const value = blueprint(index + 1)
    return [`${value.ref.id}@${String(value.ref.revision)}`, value]
  }))
  ctx.provide('expertCatalog', {
    get: vi.fn((ref: ExpertBlueprint['ref']) => {
      const value = catalog.get(`${ref.id}@${String(ref.revision)}`)
      if (value === undefined) throw new TeamRunError('missing blueprint', 'CAPABILITY_UNAVAILABLE')
      return structuredClone(value)
    }),
  } as never)
  const provision = vi.fn(async (owner: Agent, request: {
    expectedRevision: number
    memberId: import('@deepseek-ai/dsh-agent-team').TeamMemberSnapshot['id']
    sessionId: SessionId
    attemptId: import('@deepseek-ai/dsh-agent-team').TeamMemberSnapshot['attemptId']
    name: string
    protocolSlotId?: NonNullable<import('@deepseek-ai/dsh-agent-team').TeamMemberSnapshot['protocolSlotId']>
    blueprint: ExpertBlueprint['ref']
    marketplaceSkills?: readonly SkillMarketplaceCapability[]
    signal: AbortSignal
  }) => {
    const value = catalog.get(`${request.blueprint.id}@${String(request.blueprint.revision)}`)
    if (value === undefined) throw new TeamRunError('missing blueprint', 'CAPABILITY_UNAVAILABLE')
    await ctx.teamRuns.beginExpertProvision(owner, {
      expectedRevision: request.expectedRevision,
      memberId: request.memberId,
      sessionId: request.sessionId,
      attemptId: request.attemptId,
      name: request.name,
      role: value.role,
      ...request.protocolSlotId === undefined ? {} : { protocolSlotId: request.protocolSlotId },
    })
    let run = ctx.teamRuns.getRun(owner)
    if (options.blockProvision === true) {
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error(String(request.signal.reason ?? 'cancelled')))
        }, { once: true })
      }).catch(async (error: unknown) => {
        run = ctx.teamRuns.getRun(owner)
        await ctx.teamRuns.failExpertProvision(owner, {
          expectedRevision: run.revision,
          attemptId: request.attemptId,
          failure: { code: 'TEAM_CANCELLED', message: 'provider cancelled', retryable: false, details: {} },
        })
        throw error
      })
    }
    if (options.failProvision === true
      || (options.failReplacement === true && request.name.includes('-replacement-'))) {
      await ctx.teamRuns.failExpertProvision(owner, {
        expectedRevision: run.revision,
        attemptId: request.attemptId,
        failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'provider unavailable', retryable: false, details: {} },
      })
      throw new TeamRunError('provider unavailable', 'CAPABILITY_UNAVAILABLE')
    }
    await ctx.teamRuns.succeedExpertProvision(owner, {
      expectedRevision: run.revision,
      attemptId: request.attemptId,
    })
    run = ctx.teamRuns.getRun(owner)
    const childSession = ctx.sessions.create(request.sessionId, {
      meta: { parentSession: owner.id, origin: 'subagent', seedLength: 0 },
    })
    ctx.agents.register(stubAgent(ctx, childSession))
    return { member: run.members.find(member => member.attemptId === request.attemptId) } as never
  })
  const recoverProvisioning = vi.fn(async () => ({} as never))
  ctx.provide('expertRuntime', { provision, recoverProvisioning } as never)
  if (options.discoverMarketplaceSkills === true) {
    ctx.provide('skillMarketplace', {
      prepare: vi.fn(async (capability: SkillMarketplaceCapability) => capability),
      search: vi.fn(async () => ({
        query: 'demo expert',
        providers: [
          {
            source: 'skills_sh',
            state: 'ready',
            capabilities: [{
              id: 'skills.sh:trusted/research-method',
              name: 'Research method',
              description: 'Apply a bounded evidence-first research method.',
              source: 'skills_sh',
              kind: 'method_skill',
              status: 'loaded',
              verified: true,
              popularity: 100,
              skillName: 'market-trusted-research-method',
              instructions: 'Apply a bounded evidence-first research method.',
            }],
          },
          {
            source: 'smithery',
            state: 'authorization_required',
            capabilities: [{
              id: 'smithery:trusted/search',
              name: 'Remote search',
              description: 'Search external sources after authorization.',
              source: 'smithery',
              kind: 'remote_tool',
              status: 'authorization_required',
              verified: true,
              popularity: 10,
            }],
          },
          { source: 'composio', state: 'authorization_required', capabilities: [] },
        ],
      })),
    } as never)
  }
  const fiber = await ctx.plugin(TeamOrchestrator, config(options.count))
  return { ctx, lead, fiber, provision, recoverProvisioning }
}

describe('TeamOrchestrator lifecycle', () => {
  it('fails closed before provisioning when any planned expert declares fewer than two skills', async () => {
    const { ctx, lead, provision } = await setup()
    const validGet = vi.mocked(ctx.expertCatalog.get).getMockImplementation()
    vi.mocked(ctx.expertCatalog.get).mockImplementation((ref) => {
      const resolved = validGet?.(ref)
      if (resolved === undefined) throw new Error('missing test blueprint')
      return String(ref.id) === 'demo-expert-1'
        ? { ...resolved, skills: ['demo-professional-skill'] }
        : resolved
    })

    await expect(ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('insufficient-local-skills'),
      objective: 'Summarize the evidence',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(ctx.teamOrchestrator.get(lead).run.phase).toBe('formation_failed')
    expect(provision).not.toHaveBeenCalled()
  })

  it('keeps pre-P5 active runs readable when their charter predates quality-gate materialization', async () => {
    const { ctx, lead } = await setup()
    const runId = TeamRunId(lead.id)
    lead.session.append('collaboration/run/created', {
      version: 1,
      runId,
      eventId: CollaborationEventId('legacy-created'),
      revision: 1,
      leadId: lead.id,
      objective: 'Summarize the evidence',
      complexity: 'simple',
      plannedExperts: 1,
      policy: {
        maxActiveExperts: 8,
        maxProvisionAttempts: 16,
        maxTasks: 256,
        maxPublicMessages: 4_096,
        maxPublicMessageBytes: 65_536,
      },
    } as never)
    await ctx.teamOrchestrator.create(lead, {
      requestId: TeamOrchestrationRequestId('legacy-quality-gates'),
      objective: 'Summarize the evidence',
    })
    let run = ctx.teamRuns.getRun(lead)
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
    const attemptId = ProvisionAttemptId('legacy-attempt')
    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('legacy-member'),
      sessionId: SessionId('legacy-expert'),
      attemptId,
      name: 'expert-1',
      role: 'Demo expert 1',
    })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })

    const listed = ctx.teamOrchestrator.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.run.phase).toBe('active')
    expect(listed[0]?.run.qualityGates).toEqual([])
  })

  it('one-click forms three real rostered children and retry does not duplicate accepted work', async () => {
    const { ctx, lead, provision, recoverProvisioning } = await setup()
    const requestId = TeamOrchestrationRequestId('simple-one-click')
    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId,
      objective: 'Summarize the evidence',
    }, new AbortController().signal)
    expect(formed).toMatchObject({ requestId, run: { phase: 'active', plannedExperts: 3 } })
    expect(formed.createdAt).toBeGreaterThan(0)
    expect(formed.plan?.roster).toHaveLength(3)
    expect(formed.plan?.stages?.map(stage => stage.mode)).toEqual(['parallel', 'serial', 'serial'])
    expect(formed.run.tasks).toHaveLength(4)
    expect(formed.run.tasks.every(task => task.owner?.role === 'expert' && task.status === 'pending')).toBe(true)
    expect(formed.run.tasks.filter(task => task.ready)).toHaveLength(2)
    for (const [index, task] of formed.run.tasks.entries()) {
      const planned = formed.plan?.taskDag[index]
      const member = formed.run.members.find(candidate => candidate.protocolSlotId === planned?.assigneeSlotId)
      expect(task.owner?.name).toBe(member?.name)
    }
    expect(formed.run.qualityGates.map(gate => gate.name)).toEqual(formed.charter?.qualityChecks)
    expect(formed.run.qualityGates.every(gate => gate.status === 'pending')).toBe(true)
    expect(ctx.agents.get(formed.run.members[0]!.sessionId)?.session.header.parentSession).toBe(lead.id)
    expect(provision).toHaveBeenCalledTimes(3)

    const repeated = await ctx.teamOrchestrator.retry(lead, { requestId }, new AbortController().signal)
    expect(repeated.run.phase).toBe('active')
    expect(provision).toHaveBeenCalledTimes(3)
    expect(recoverProvisioning).toHaveBeenCalledTimes(3)
    expect(ctx.teamOrchestrator.list()).toHaveLength(1)
    expect(repeated.run.qualityGates.map(gate => gate.id)).toEqual(formed.run.qualityGates.map(gate => gate.id))
  })

  it('persists selected market skills in the plan and passes the exact mounts to expert provisioning', async () => {
    const { ctx, lead, provision } = await setup({ discoverMarketplaceSkills: true })
    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('marketplace-mounts'),
      objective: 'Summarize the evidence',
    }, new AbortController().signal)
    const expectedMounts = [
      expect.objectContaining({
        id: 'skills.sh:trusted/research-method',
        name: 'Research method',
        status: 'loaded',
      }),
      expect.objectContaining({
        id: 'smithery:trusted/search',
        name: 'Remote search',
        status: 'authorization_required',
      }),
    ]
    expect(formed.plan?.roster).toHaveLength(3)
    for (const expert of formed.plan?.roster ?? []) {
      expect(expert.skillDiscovery).toMatchObject({
        providers: [
          { source: 'skills_sh', state: 'ready' },
          { source: 'smithery', state: 'authorization_required' },
          { source: 'composio', state: 'unavailable' },
        ],
        mounts: expectedMounts,
      })
    }
    expect(lead.session.events.filter(event => event.type === 'collaboration/orchestration/plan')).toHaveLength(1)
    expect(ctx.skillMarketplace.search).toHaveBeenCalledWith(expect.stringMatching(/^Demo expert .*Summarize evidence$/u))
    for (const call of provision.mock.calls) {
      expect(call[1]).toMatchObject({ marketplaceSkills: expectedMounts })
    }
  })

  it('uses a bounded provider-friendly query for a long multilingual task', async () => {
    const { ctx, lead } = await setup({ discoverMarketplaceSkills: true })
    await ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('marketplace-query-compaction'),
      objective: '请分析英伟达收购 Hugging Face 的战略利弊，并评估 AI 生态、监管与社区风险。请分点论述并给出综合判断。',
    }, new AbortController().signal)

    const queries = vi.mocked(ctx.skillMarketplace.search).mock.calls.map(call => call[0])
    expect(queries).toHaveLength(3)
    for (const query of queries) {
      expect(Array.from(query).length).toBeLessThanOrEqual(240)
      expect(query).toMatch(/^Demo expert Deliver one bounded part task/u)
      expect(query).toContain('Hugging Face AI')
      expect(query).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it('prepares only the bounded selected mounts and promotes their provider to ready', async () => {
    const { ctx, lead, provision } = await setup({ discoverMarketplaceSkills: true })
    vi.mocked(ctx.skillMarketplace.prepare).mockImplementation(async capability => capability.source === 'smithery'
      ? {
        ...capability,
        access: 'public',
        status: 'connected',
        connection: { connectionId: 'trusted-search', toolNames: ['search'] },
      }
      : capability)

    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('marketplace-task-prepare'),
      objective: 'Summarize evidence',
    }, new AbortController().signal)

    expect(ctx.skillMarketplace.prepare).toHaveBeenCalledTimes(6)
    for (const expert of formed.plan?.roster ?? []) {
      expect(expert.skillDiscovery?.providers).toContainEqual({ source: 'smithery', state: 'ready' })
      expect(expert.skillDiscovery?.mounts).toContainEqual(expect.objectContaining({
        id: 'smithery:trusted/search', status: 'connected', access: 'public',
      }))
    }
    for (const call of provision.mock.calls) {
      expect(call[1]).toMatchObject({ marketplaceSkills: expect.arrayContaining([
        expect.objectContaining({ status: 'connected' }),
      ]) })
    }
  })

  it('keeps research methods for every expert and assigns an entity tool to only one expert', async () => {
    const { ctx, lead, provision } = await setup({ discoverMarketplaceSkills: true })
    const specialists = [
      ['Market Analyst', 'market_research commercial_analysis valuation and market sizing evidence'],
      ['Policy and Regulatory Analyst', 'policy_research regulatory_research compliance_review and jurisdictional evidence'],
      ['Technical Analyst', 'technical_analysis engineering_analysis scientific_research and feasibility evidence'],
    ] as const
    vi.mocked(ctx.expertCatalog.get).mockImplementation((ref) => {
      const index = Number(String(ref.id).split('-').at(-1))
      const specialist = specialists[index - 1]
      return specialist === undefined ? blueprint(index) : { ...blueprint(index), role: specialist[0], objective: specialist[1] }
    })
    vi.mocked(ctx.skillMarketplace.search).mockResolvedValue({
      query: 'Policy Regulatory Analyst Hugging Face',
      providers: [{
        source: 'smithery',
        state: 'authorization_required',
        capabilities: [{
          id: 'smithery:cannabis-regulatory',
          name: 'Cannabis Regulatory Intelligence',
          description: 'Regulatory intelligence for cannabis markets.',
          source: 'smithery',
          kind: 'remote_tool',
          status: 'authorization_required',
          verified: true,
          popularity: 100_000,
        }, {
          id: 'smithery:huggingface',
          name: 'Hugging Face',
          description: 'Search Hugging Face models, datasets, and papers.',
          source: 'smithery',
          kind: 'remote_tool',
          status: 'authorization_required',
          verified: true,
          popularity: 10,
        }],
      }, { source: 'composio', state: 'authorization_required', capabilities: [] }, {
        source: 'skills_sh',
        state: 'ready',
        capabilities: [{
          id: 'skills.sh:trusted/research-analysis',
          name: 'Research Analysis',
          description: 'Apply evidence-led research and analysis methods.',
          source: 'skills_sh',
          kind: 'method_skill',
          status: 'loaded',
          verified: true,
          popularity: 1_000,
          skillName: 'market-trusted-research-analysis',
          instructions: 'Apply evidence-led research and analysis methods.',
        }],
      }],
    })

    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('marketplace-task-entity-filter'),
      objective: '请评估 Hugging Face 并购的监管与市场影响',
    }, new AbortController().signal)

    const discoveries = formed.plan?.roster.map(expert => expert.skillDiscovery?.mounts.map(value => value.name)) ?? []
    expect(discoveries).toHaveLength(3)
    expect(discoveries.every(names => names?.[0] === 'Research Analysis')).toBe(true)
    expect(discoveries.filter(names => names?.includes('Hugging Face')).length).toBe(1)
    expect(discoveries.flat()).not.toContain('Cannabis Regulatory Intelligence')
    expect(formed.plan?.roster.find(expert => String(expert.blueprint.id) === 'demo-expert-3')
      ?.skillDiscovery?.mounts.map(value => value.name)).toContain('Hugging Face')
    for (const expert of formed.plan?.roster ?? []) {
      const selectedSources = new Set(expert.skillDiscovery?.mounts.map(value => value.source))
      for (const provider of expert.skillDiscovery?.providers ?? []) {
        if (!selectedSources.has(provider.source)) expect(provider.state).toBe('unavailable')
      }
    }
    expect(formed.plan?.roster.filter(expert => expert.skillDiscovery?.providers
      .some(provider => provider.source === 'smithery' && provider.state === 'authorization_required'))).toHaveLength(1)
    expect(provision.mock.calls.filter(call => call[1].marketplaceSkills
      ?.some(capability => capability.name === 'Hugging Face')).length).toBe(1)
  })

  it('forms the complex upper bound of eight experts without counting the Lead', async () => {
    const { ctx, lead, provision } = await setup()
    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId: TeamOrchestrationRequestId('complex-eight'),
      objective: 'Research; analyze; design; plan; implement; test; review; deploy',
      domain: 'software_development',
      workstreams: Array.from({ length: 8 }, (_, index) => ({
        id: `stage-${String(index + 1)}`,
        subject: `Stage ${String(index + 1)}`,
        description: `Deliver stage ${String(index + 1)}`,
        blockedBy: index === 0 ? [] : [`stage-${String(index)}`],
        requiredCapabilities: [`capability-${String(index + 1)}`],
      })),
    }, new AbortController().signal)
    expect(formed.run).toMatchObject({ complexity: 'complex', plannedExperts: 8, phase: 'active' })
    expect(formed.run.expertCounts).toMatchObject({ active: 8, planned: 8 })
    expect(formed.plan?.roster).toHaveLength(8)
    expect(formed.charter).toMatchObject({
      topology: 'grouped',
      communication: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
    })
    expect(formed.run.protocol).toMatchObject({
      mode: 'enforced',
      topology: 'grouped',
      limits: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
    })
    expect(formed.run.protocol.members).toHaveLength(8)
    for (const [index, member] of formed.run.protocol.members.entries()) {
      const partner = index % 2 === 0 ? index + 2 : index
      expect(member).toMatchObject({
        slotId: `slot-${String(index + 1)}`,
        name: `expert-${String(index + 1)}`,
        phase: 'active',
        permissions: blueprint(index + 1).collaboration,
        allowedTargets: ['lead', `expert-${String(partner)}`],
        usedMessages: 0,
        remainingMessages: 12,
      })
    }
    expect(provision).toHaveBeenCalledTimes(8)
  })

  it('replaces one failed active expert from its durable slot exactly once', async () => {
    const { ctx, lead, provision } = await setup()
    const requestId = TeamOrchestrationRequestId('replace-active-expert')
    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId,
      objective: 'Summarize the evidence',
    }, new AbortController().signal)
    const original = formed.run.members[0]
    if (original === undefined) throw new Error('formed expert is missing')
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: formed.run.revision,
      attemptId: original.attemptId,
      failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'runtime failed', retryable: true, details: {} },
    })
    expect(ctx.teamRuns.getRun(lead).controller.recommendedActions).toContain('replace_expert')

    const replaced = await ctx.teamOrchestrator.replaceExpert(lead, {
      requestId,
      failedMemberId: original.id,
    }, new AbortController().signal)
    expect(replaced.run).toMatchObject({ phase: 'active', status: 'running' })
    expect(replaced.run.expertCounts).toMatchObject({ active: 3, failed: 1, attempts: 4 })
    expect(replaced.run.members.find(member => member.id === original.id)?.phase).toBe('failed')
    expect(replaced.run.members.filter(member => member.phase === 'active')).toContainEqual(
      expect.objectContaining({ name: 'expert-1-replacement-1' }),
    )
    expect(provision).toHaveBeenCalledTimes(4)

    const repeated = await ctx.teamOrchestrator.replaceExpert(lead, {
      requestId,
      failedMemberId: original.id,
    }, new AbortController().signal)
    expect(repeated.run.members).toEqual(replaced.run.members)
    expect(provision).toHaveBeenCalledTimes(4)
  })

  it('preserves a failed replacement audit and never reports false recovery', async () => {
    const { ctx, lead, provision } = await setup({ failReplacement: true })
    const requestId = TeamOrchestrationRequestId('failed-active-replacement')
    const formed = await ctx.teamOrchestrator.orchestrate(lead, {
      requestId,
      objective: 'Summarize the evidence',
    }, new AbortController().signal)
    const original = formed.run.members[0]
    if (original === undefined) throw new Error('formed expert is missing')
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: formed.run.revision,
      attemptId: original.attemptId,
      failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'runtime failed', retryable: true, details: {} },
    })

    await expect(ctx.teamOrchestrator.replaceExpert(lead, {
      requestId,
      failedMemberId: original.id,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    const failed = ctx.teamRuns.getRun(lead)
    expect(failed).toMatchObject({ phase: 'active', status: 'blocked' })
    expect(failed.expertCounts).toMatchObject({ active: 2, failed: 2, attempts: 4 })
    expect(failed.members.filter(member => member.phase === 'active')).toHaveLength(2)
    await expect(ctx.teamOrchestrator.replaceExpert(lead, {
      requestId,
      failedMemberId: original.id,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(provision).toHaveBeenCalledTimes(4)
    expect(ctx.teamRuns.getRun(lead).members).toHaveLength(4)
  })

  it('recovers a materialized DAG prefix and creates future-listed dependencies exactly once before activation', async () => {
    const { ctx, lead } = await setup()
    const requestId = TeamOrchestrationRequestId('recover-task-prefix')
    await ctx.teamOrchestrator.create(lead, {
      requestId,
      objective: 'Research the evidence and write the dependent analysis',
      domain: 'research_analysis',
      workstreams: [
        {
          id: 'analysis',
          subject: 'Analyze evidence',
          description: 'Write the analysis after research completes',
          blockedBy: ['research'],
          resourceScopes: ['reports/analysis'],
        },
        {
          id: 'research',
          subject: 'Research evidence',
          description: 'Collect the source evidence',
          resourceScopes: ['reports/research'],
        },
      ],
    })
    const prefix = await ctx.teamRuns.createTask(lead, {
      subject: 'Research evidence',
      description: 'Collect the source evidence',
      resourceScopes: ['reports/research'],
    })
    expect(prefix.id).toBe('task-1')

    const formed = await ctx.teamOrchestrator.form(lead, { requestId }, new AbortController().signal)
    expect(formed.run.phase).toBe('active')
    expect(formed.run.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        revision: 2,
        subject: 'Research evidence',
        blockedBy: [],
        status: 'pending',
      }),
      expect.objectContaining({
        id: 'task-2',
        revision: 2,
        subject: 'Analyze evidence',
        blockedBy: ['task-1'],
        status: 'pending',
      }),
    ])
    expect(formed.run.tasks.every(task => task.owner?.role === 'expert')).toBe(true)

    const repeated = await ctx.teamOrchestrator.retry(lead, { requestId }, new AbortController().signal)
    expect(repeated.run.tasks.map(task => task.id)).toEqual(['task-1', 'task-2'])
  })

  it('fails closed before planning when the exact domain pool cannot staff the profile', async () => {
    const { ctx, lead } = await setup({ count: 1 })
    const requestId = TeamOrchestrationRequestId('insufficient-pool')
    await expect(ctx.teamOrchestrator.create(lead, {
      requestId,
      objective: 'Research two sources and analyze a product proposal',
      workstreams: [
        { id: 'research', subject: 'Research', description: 'Research sources' },
        { id: 'analysis', subject: 'Analysis', description: 'Analyze results' },
      ],
      domain: 'research_analysis',
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    const failed = ctx.teamOrchestrator.get(lead)
    expect(failed.run).toMatchObject({ phase: 'formation_failed', status: 'team_formation_failed' })
    expect(failed.profile.plannedExperts).toBe(3)
    expect(failed.plan).toBeUndefined()
    expect(failed.charter).toBeUndefined()
  })

  it('compensates a failed provider attempt and never activates below the exact plan', async () => {
    const { ctx, lead } = await setup({ failProvision: true })
    const requestId = TeamOrchestrationRequestId('provider-failure')
    await ctx.teamOrchestrator.create(lead, { requestId, objective: 'Summarize the evidence' })
    await expect(ctx.teamOrchestrator.form(lead, { requestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'FORMATION_FAILED' })
    const run = ctx.teamRuns.getRun(lead)
    expect(run.phase).toBe('formation_failed')
    expect(run.expertCounts).toMatchObject({ active: 0, failed: 1 })
  })

  it('cancels an admitted plan and rejects terminal retry', async () => {
    const { ctx, lead } = await setup()
    const requestId = TeamOrchestrationRequestId('cancelled-plan')
    await ctx.teamOrchestrator.create(lead, { requestId, objective: 'Summarize the evidence' })
    const controller = new AbortController()
    controller.abort('user stopped formation')
    await expect(ctx.teamOrchestrator.form(lead, { requestId }, controller.signal))
      .rejects.toMatchObject({ code: 'TEAM_CANCELLED' })
    expect(ctx.teamOrchestrator.get(lead).run.phase).toBe('cancelled')
    await expect(ctx.teamOrchestrator.retry(lead, { requestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'TEAM_CANCELLED' })
  })

  it('lets the cancel command interrupt an in-flight formation before taking the Lead lock', async () => {
    const { ctx, lead, provision } = await setup({ blockProvision: true })
    const requestId = TeamOrchestrationRequestId('concurrent-cancel')
    await ctx.teamOrchestrator.create(lead, { requestId, objective: 'Summarize the evidence' })
    const forming = ctx.teamOrchestrator.form(lead, { requestId }, new AbortController().signal)
    await vi.waitFor(() => { expect(provision).toHaveBeenCalledTimes(1) })
    const cancellation = ctx.teamOrchestrator.cancel(lead, { requestId, reason: 'user stopped formation' })
    await expect(forming).rejects.toMatchObject({ code: 'TEAM_CANCELLED' })
    await expect(cancellation).resolves.toMatchObject({ run: { phase: 'cancelled' } })
  })

  it('removes the service when its providing fiber disposes', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.get('teamOrchestrator')).toBeInstanceOf(TeamOrchestrator)
    await fiber.dispose()
    expect(ctx.get('teamOrchestrator')).toBeUndefined()
  })
})
