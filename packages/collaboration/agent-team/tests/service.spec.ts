import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TeamRunService, {
  MAIN_TEAM_THREAD_ID,
  ProvisionAttemptId,
  TeamMemberId,
  TeamChallengeId,
  TeamProtocolSlotId,
  TeamQualityGateId,
  TeamRunError,
  TeamTaskId,
} from '../src/index.ts'
import type { Config, TeamFailure, TeamRunSnapshot } from '../src/index.ts'
import { foldTeamRun, snapshotTeamRun } from '../src/fold.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    contexts.delete(ctx)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'TeamRun test cleanup failed')
})

async function setup(config: Config = {}): Promise<{ ctx: Context; lead: Agent }> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TeamRunService, config)
  return {
    ctx,
    lead: ctx.agentLoop.create(SessionId(`lead-${crypto.randomUUID()}`), { provider: 'mock', model: 'mock' }),
  }
}

async function enterProvisioning(ctx: Context, lead: Agent, complexity: 'simple' | 'medium' | 'complex', plannedExperts: number): Promise<TeamRunSnapshot> {
  let run = await ctx.teamRuns.createRun(lead, { objective: 'Deliver the user task', complexity, plannedExperts })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
  return ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
}

async function provision(
  ctx: Context,
  lead: Agent,
  name: string,
  settle: 'active' | 'failed' = 'active',
  protocolSlotId?: ReturnType<typeof TeamProtocolSlotId>,
): Promise<TeamRunSnapshot> {
  let run = ctx.teamRuns.getRun(lead)
  const attemptId = ProvisionAttemptId(`attempt-${name}`)
  await ctx.teamRuns.beginExpertProvision(lead, {
    expectedRevision: run.revision,
    memberId: TeamMemberId(`member-${name}`),
    sessionId: SessionId(`session-${name}`),
    attemptId,
    name,
    role: `${name} responsibility`,
    ...protocolSlotId === undefined ? {} : { protocolSlotId },
  })
  run = ctx.teamRuns.getRun(lead)
  if (settle === 'active') {
    await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
  } else {
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId,
      failure: failure('CAPABILITY_UNAVAILABLE', true),
    })
  }
  return ctx.teamRuns.getRun(lead)
}

function failure(code: TeamFailure['code'], retryable = false): TeamFailure {
  return { code, message: `${code} test failure`, retryable, details: { source: 'test' } }
}

async function activateSimple(ctx: Context, lead: Agent): Promise<TeamRunSnapshot> {
  await enterProvisioning(ctx, lead, 'simple', 1)
  let run = await provision(ctx, lead, 'expert-one')
  await ctx.teamRuns.createQualityGate(lead, { name: 'P5 delivery quality' })
  run = ctx.teamRuns.getRun(lead)
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
  return run
}

async function activateEnforcedPair(
  ctx: Context,
  lead: Agent,
  options: {
    topology: 'centralized' | 'producer_reviewer'
    maxChallengeRounds?: number
    maxMessagesPerExpert?: number
    firstPermissions?: { challenge: boolean; review: boolean; requestHelp: boolean }
  },
): Promise<{ run: TeamRunSnapshot; first: Agent; second: Agent }> {
  await enterProvisioning(ctx, lead, 'medium', 2)
  let run = ctx.teamRuns.getRun(lead)
  const firstSlot = TeamProtocolSlotId('slot-1')
  const secondSlot = TeamProtocolSlotId('slot-2')
  const peerRoutes = options.topology === 'producer_reviewer'
  await ctx.teamRuns.materializeProtocol(lead, {
    expectedRevision: run.revision,
    topology: options.topology,
    maxChallengeRounds: options.maxChallengeRounds ?? 2,
    maxMessagesPerExpert: options.maxMessagesPerExpert ?? 8,
    experts: [
      {
        slotId: firstSlot,
        initialMemberId: TeamMemberId('member-expert-one'),
        name: 'expert-one',
        permissions: options.firstPermissions ?? { challenge: true, review: true, requestHelp: true },
        allowedTargetSlotIds: peerRoutes ? [secondSlot] : [],
      },
      {
        slotId: secondSlot,
        initialMemberId: TeamMemberId('member-expert-two'),
        name: 'expert-two',
        permissions: { challenge: true, review: true, requestHelp: true },
        allowedTargetSlotIds: peerRoutes ? [firstSlot] : [],
      },
    ],
  })
  await provision(ctx, lead, 'expert-one', 'active', firstSlot)
  run = await provision(ctx, lead, 'expert-two', 'active', secondSlot)
  await ctx.teamRuns.createQualityGate(lead, { name: 'Enforced delivery quality' })
  run = ctx.teamRuns.getRun(lead)
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
  const first = (await ctx.agents.create({
    sessionId: SessionId('session-expert-one'),
    meta: { parentSession: lead.id },
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  const second = (await ctx.agents.create({
    sessionId: SessionId('session-expert-two'),
    meta: { parentSession: lead.id },
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  return { run, first, second }
}

describe('TeamRun formation and lifecycle', () => {
  it('enforces every complexity band and excludes the Lead from expert capacity', async () => {
    const invalid = [
      ['simple', 0], ['simple', 2],
      ['medium', 1], ['medium', 5],
      ['complex', 4], ['complex', 9],
    ] as const
    for (const [complexity, plannedExperts] of invalid) {
      const { ctx, lead } = await setup()
      await expect(ctx.teamRuns.createRun(lead, { objective: 'invalid band', complexity, plannedExperts }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    }
    const abnormal = await setup()
    await expect(abnormal.ctx.teamRuns.createRun(abnormal.lead, {
      objective: 'unknown complexity',
      complexity: 'unknown' as unknown as 'simple',
      plannedExperts: 1,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })

    const { ctx, lead } = await setup()
    const run = await ctx.teamRuns.createRun(lead, {
      objective: 'simple always has one expert',
      complexity: 'simple',
      plannedExperts: 1,
    })
    expect(run.lead.sessionId).toBe(lead.id)
    expect(run.members).toEqual([])
    expect(run.expertCounts).toMatchObject({ planned: 1, active: 0, provisioning: 0, attempts: 0 })
  })

  it('cannot activate or complete below the exact plan and completes only after one active expert record', async () => {
    const { ctx, lead } = await setup()
    let run = await enterProvisioning(ctx, lead, 'simple', 1)
    await expect(ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })
    await expect(ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'completed' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })

    run = await provision(ctx, lead, 'required-expert')
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'completing' })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'completed' })
    expect(run).toMatchObject({ phase: 'completed', status: 'completed' })
    expect(run.expertCounts).toMatchObject({ active: 1, planned: 1, availableSlots: 0 })
  })

  it('compensates an activated expert that fails before formation finishes', async () => {
    const { ctx, lead } = await setup()
    let run = await enterProvisioning(ctx, lead, 'simple', 1)
    const attemptId = ProvisionAttemptId('attempt-pre-prompt')
    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('member-pre-prompt'),
      sessionId: SessionId('session-pre-prompt'),
      attemptId,
      name: 'pre-prompt',
      role: 'Expert whose first prompt has not been admitted',
    })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'provisioning', status: 'forming' })
    expect(run.expertCounts).toMatchObject({ active: 1, failed: 0 })

    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId,
      failure: failure('CAPABILITY_UNAVAILABLE', true),
    })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'provisioning', status: 'forming' })
    expect(run.expertCounts).toMatchObject({ active: 0, failed: 1, availableSlots: 1 })
  })

  it('retains failed audit rows, releases capacity, and never reuses names or ids', async () => {
    const { ctx, lead } = await setup({ maxProvisionAttempts: 4 })
    await enterProvisioning(ctx, lead, 'simple', 1)
    let run = await provision(ctx, lead, 'failed-one', 'failed')
    expect(run.expertCounts).toMatchObject({ active: 0, provisioning: 0, failed: 1, attempts: 1, availableSlots: 1 })

    const duplicateCases = [
      {
        expected: 'TEAM_MEMBER_NAME_TAKEN',
        memberId: TeamMemberId('member-new-name'),
        sessionId: SessionId('session-new-name'),
        attemptId: ProvisionAttemptId('attempt-new-name'),
        name: 'failed-one',
      },
      {
        expected: 'TEAM_MEMBER_ID_TAKEN',
        memberId: TeamMemberId('member-failed-one'),
        sessionId: SessionId('session-new-member'),
        attemptId: ProvisionAttemptId('attempt-new-member'),
        name: 'new-member',
      },
      {
        expected: 'TEAM_ATTEMPT_ID_TAKEN',
        memberId: TeamMemberId('member-new-attempt'),
        sessionId: SessionId('session-new-attempt'),
        attemptId: ProvisionAttemptId('attempt-failed-one'),
        name: 'new-attempt',
      },
      {
        expected: 'TEAM_SESSION_ID_TAKEN',
        memberId: TeamMemberId('member-new-session'),
        sessionId: SessionId('session-failed-one'),
        attemptId: ProvisionAttemptId('attempt-new-session'),
        name: 'new-session',
      },
    ] as const
    for (const candidate of duplicateCases) {
      run = ctx.teamRuns.getRun(lead)
      await expect(ctx.teamRuns.beginExpertProvision(lead, {
        expectedRevision: run.revision,
        memberId: candidate.memberId,
        sessionId: candidate.sessionId,
        attemptId: candidate.attemptId,
        name: candidate.name,
        role: 'replacement',
      })).rejects.toMatchObject({ code: candidate.expected })
    }
    run = await provision(ctx, lead, 'replacement')
    expect(run.expertCounts).toMatchObject({ active: 1, failed: 1, attempts: 2 })
  })

  it('blocks an active run while a failed expert is replaced and revokes the failed membership', async () => {
    const { ctx, lead } = await setup({ maxProvisionAttempts: 4 })
    let run = await activateSimple(ctx, lead)
    const failedSessionId = SessionId('session-expert-one')
    const { agent: failedAgent } = await ctx.agents.create({
      sessionId: failedSessionId,
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.teamRuns.membership(failedAgent).actor).toMatchObject({ role: 'expert', name: 'expert-one' })

    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('attempt-expert-one'),
      failure: failure('CAPABILITY_UNAVAILABLE', true),
    })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'active', status: 'blocked' })
    expect(run.expertCounts).toMatchObject({ active: 0, failed: 1, availableSlots: 1 })
    expect(run.controller).toMatchObject({ health: 'attention' })
    expect(run.controller.recommendedActions).toContain('replace_expert')
    expect(() => ctx.teamRuns.membership(failedAgent))
      .toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    await expect(ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('replacement-reused-name'),
      sessionId: SessionId('replacement-reused-name'),
      attemptId: ProvisionAttemptId('replacement-reused-name'),
      name: 'expert-one',
      role: 'must not reuse a failed identity',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })

    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('member-expert-two'),
      sessionId: SessionId('session-expert-two'),
      attemptId: ProvisionAttemptId('attempt-expert-two'),
      name: 'expert-two',
      role: 'Replace the unavailable expert',
    })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'active', status: 'blocked' })
    expect(run.expertCounts).toMatchObject({ active: 0, provisioning: 1, availableSlots: 0 })

    await ctx.teamRuns.succeedExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('attempt-expert-two'),
    })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'active', status: 'running' })
    expect(run.expertCounts).toMatchObject({ active: 1, failed: 1, provisioning: 0, attempts: 2 })
    expect(run.controller.recommendedActions).not.toContain('replace_expert')

    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'completing' })
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('attempt-expert-two'),
      failure: failure('CAPABILITY_UNAVAILABLE'),
    })
    run = ctx.teamRuns.getRun(lead)
    expect(run).toMatchObject({ phase: 'completing', status: 'reviewing' })
    expect(run.expertCounts).toMatchObject({ active: 0, failed: 2, availableSlots: 1 })
    await expect(ctx.teamRuns.changePhase(lead, {
      expectedRevision: run.revision,
      phase: 'completed',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })
    await expect(ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('member-too-late'),
      sessionId: SessionId('session-too-late'),
      attemptId: ProvisionAttemptId('attempt-too-late'),
      name: 'too-late',
      role: 'cannot change the roster while completing',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })
    run = await ctx.teamRuns.terminateRun(lead, {
      expectedRevision: run.revision,
      terminalPhase: 'failed',
      failure: failure('CAPABILITY_UNAVAILABLE'),
    })
    expect(run).toMatchObject({ phase: 'failed', status: 'failed' })
  })

  it('rejects attempt 13 with a stable code after twelve retained failed attempts', async () => {
    const { ctx, lead } = await setup()
    await enterProvisioning(ctx, lead, 'simple', 1)
    for (let index = 1; index <= 12; index += 1) {
      await provision(ctx, lead, `failed-${index}`, 'failed')
    }
    const run = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('member-thirteen'),
      sessionId: SessionId('session-thirteen'),
      attemptId: ProvisionAttemptId('attempt-thirteen'),
      name: 'attempt-thirteen',
      role: 'must be rejected',
    })).rejects.toMatchObject({ code: 'TEAM_PROVISION_ATTEMPT_LIMIT' })
  })

  it('makes formation failure, execution failure, and cancellation explicit and irreversible', async () => {
    const formation = await setup()
    let formationRun = await formation.ctx.teamRuns.createRun(formation.lead, {
      objective: 'cannot form', complexity: 'simple', plannedExperts: 1,
    })
    formationRun = await formation.ctx.teamRuns.terminateRun(formation.lead, {
      expectedRevision: formationRun.revision,
      terminalPhase: 'formation_failed',
      failure: failure('FORMATION_FAILED'),
    })
    expect(formationRun.status).toBe('team_formation_failed')
    await expect(formation.ctx.teamRuns.changePhase(formation.lead, {
      expectedRevision: formationRun.revision, phase: 'planning',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })

    const cancelled = await setup()
    let cancelledRun = await cancelled.ctx.teamRuns.createRun(cancelled.lead, {
      objective: 'cancelled by user', complexity: 'simple', plannedExperts: 1,
    })
    cancelledRun = await cancelled.ctx.teamRuns.terminateRun(cancelled.lead, {
      expectedRevision: cancelledRun.revision,
      terminalPhase: 'cancelled',
      failure: failure('TEAM_CANCELLED'),
    })
    expect(cancelledRun.phase).toBe('cancelled')

    const malformed = await setup()
    const malformedRun = await malformed.ctx.teamRuns.createRun(malformed.lead, {
      objective: 'malformed failure input', complexity: 'simple', plannedExperts: 1,
    })
    await expect(malformed.ctx.teamRuns.terminateRun(malformed.lead, {
      expectedRevision: malformedRun.revision,
      terminalPhase: 'cancelled',
      failure: {
        code: 'UNKNOWN', message: 'bad', retryable: 'yes', details: null,
      } as unknown as TeamFailure,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })

    const execution = await setup()
    let executionRun = await activateSimple(execution.ctx, execution.lead)
    executionRun = await execution.ctx.teamRuns.terminateRun(execution.lead, {
      expectedRevision: executionRun.revision,
      terminalPhase: 'failed',
      failure: failure('DELIVERY_FAILED'),
    })
    expect(executionRun.phase).toBe('failed')
    await expect(execution.ctx.teamRuns.terminateRun(execution.lead, {
      expectedRevision: executionRun.revision,
      terminalPhase: 'cancelled',
      failure: failure('TEAM_CANCELLED'),
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_TRANSITION' })
  })

  it('serializes same-revision commands so exactly one phase transition commits', async () => {
    const { ctx, lead } = await setup()
    const run = await ctx.teamRuns.createRun(lead, {
      objective: 'serialize commands', complexity: 'simple', plannedExperts: 1,
    })
    const results = await Promise.allSettled([
      ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' }),
      ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') throw new Error('one same-revision command must be rejected')
    expect(rejected.reason).toBeInstanceOf(TeamRunError)
    if (!(rejected.reason instanceof TeamRunError)) throw new Error('rejection must use TeamRunError')
    expect(rejected.reason.code).toBe('STALE_REVISION')
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({ revision: run.revision + 1, phase: 'planning' })
    expect(lead.session.events.filter(event => event.type === 'collaboration/run/phase')).toHaveLength(1)
  })
})

describe('TeamRun tasks and public collaboration', () => {
  it('publishes a public message batch atomically when a later row is invalid', async () => {
    const { ctx, lead } = await setup()
    await activateEnforcedPair(ctx, lead, { topology: 'centralized' })
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length

    await expect(ctx.teamRuns.publishMessages(lead, [
      {
        kind: 'inform', threadId: MAIN_TEAM_THREAD_ID,
        targets: ['expert-one'], content: 'This staged row must not leak',
      },
      {
        kind: 'inform', threadId: MAIN_TEAM_THREAD_ID,
        targets: ['missing-expert'], content: 'This invalid row aborts the complete batch',
      },
    ])).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('lets the Lead preassign every planned task without starting blocked work early', async () => {
    const { ctx, lead } = await setup()
    const { first, second } = await activateEnforcedPair(ctx, lead, { topology: 'centralized' })
    const blocker = await ctx.teamRuns.createTask(lead, {
      subject: 'Evidence', description: 'Establish the evidence base',
    })
    const dependent = await ctx.teamRuns.createTask(lead, {
      subject: 'Synthesis', description: 'Synthesize only after evidence', blockedBy: [blocker.id],
    })

    const assignedBlocker = await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'assign', owner: 'expert-one',
    })
    const assignedDependent = await ctx.teamRuns.updateTask(lead, {
      taskId: dependent.id, expectedRevision: dependent.revision, action: 'assign', owner: 'expert-two',
    })
    expect(assignedBlocker).toMatchObject({ status: 'pending', owner: { name: 'expert-one' }, ready: true })
    expect(assignedDependent).toMatchObject({ status: 'pending', owner: { name: 'expert-two' }, ready: false })
    await expect(ctx.teamRuns.updateTask(second, {
      taskId: dependent.id, expectedRevision: assignedDependent.revision, action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const claimedBlocker = await ctx.teamRuns.updateTask(first, {
      taskId: blocker.id, expectedRevision: assignedBlocker.revision, action: 'claim',
    })
    const blockerArtifact = await ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'evidence',
      title: 'Evidence result',
      body: 'Reviewable evidence for the dependent task',
      mediaType: 'text/markdown',
      status: 'review',
      taskIds: [blocker.id],
    })
    await ctx.teamRuns.publishMessage(first, {
      kind: 'handoff',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: blocker.id, artifactId: blockerArtifact.id },
      content: 'The blocking evidence is ready for Lead acceptance.',
    })
    await ctx.teamRuns.writeArtifact(lead, {
      artifactId: blockerArtifact.id,
      expectedVersion: blockerArtifact.version,
      kind: blockerArtifact.kind,
      title: blockerArtifact.title,
      body: blockerArtifact.body,
      mediaType: blockerArtifact.mediaType,
      taskIds: blockerArtifact.taskIds,
      status: 'accepted',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: claimedBlocker.revision, action: 'complete',
    })
    await expect(ctx.teamRuns.updateTask(second, {
      taskId: dependent.id, expectedRevision: assignedDependent.revision, action: 'claim',
    })).resolves.toMatchObject({ status: 'in_progress', owner: { name: 'expert-two' } })
  })

  it('enforces one persisted expert message budget without leaving a rejected event', async () => {
    const { ctx, lead } = await setup()
    await enterProvisioning(ctx, lead, 'simple', 1)
    let run = ctx.teamRuns.getRun(lead)
    const protocolService = ctx.teamRuns as TeamRunService & {
      materializeProtocol(caller: Agent, request: {
        expectedRevision: number
        topology: 'producer_reviewer'
        maxChallengeRounds: number
        maxMessagesPerExpert: number
        experts: readonly [{
          slotId: ReturnType<typeof TeamProtocolSlotId>
          initialMemberId: ReturnType<typeof TeamMemberId>
          name: string
          permissions: { challenge: boolean; review: boolean; requestHelp: boolean }
          allowedTargetSlotIds: readonly ReturnType<typeof TeamProtocolSlotId>[]
        }]
      }): Promise<unknown>
    }
    const slotId = TeamProtocolSlotId
    await protocolService.materializeProtocol(lead, {
      expectedRevision: run.revision,
      topology: 'producer_reviewer',
      maxChallengeRounds: 1,
      maxMessagesPerExpert: 1,
      experts: [{
        slotId: slotId('slot-1'),
        initialMemberId: TeamMemberId('member-expert-one'),
        name: 'expert-one',
        permissions: { challenge: true, review: true, requestHelp: true },
        allowedTargetSlotIds: [],
      }],
    })
    run = await provision(ctx, lead, 'expert-one', 'active', slotId('slot-1'))
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
    const expert = (await ctx.agents.create({
      sessionId: SessionId('session-expert-one'),
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    await ctx.teamRuns.publishMessage(expert, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['lead'], content: 'first and only expert message',
    })
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length

    await expect(ctx.teamRuns.publishMessage(expert, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['lead'], content: 'must be rejected',
    })).rejects.toMatchObject({ code: 'TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('enforces permissions and centralized routes while routing artifact receipts to a valid counterparty atomically', async () => {
    const { ctx, lead } = await setup()
    const { first } = await activateEnforcedPair(ctx, lead, {
      topology: 'centralized',
      maxMessagesPerExpert: 1,
      firstPermissions: { challenge: false, review: false, requestHelp: false },
    })
    const assertUnchanged = async (operation: Promise<unknown>, code: string): Promise<void> => {
      const before = ctx.teamRuns.getRun(lead)
      const eventCount = lead.session.events.length
      await expect(operation).rejects.toMatchObject({ code })
      expect(ctx.teamRuns.getRun(lead)).toEqual(before)
      expect(lead.session.events).toHaveLength(eventCount)
    }
    await assertUnchanged(ctx.teamRuns.publishMessage(first, {
      kind: 'request_help', threadId: MAIN_TEAM_THREAD_ID, targets: ['lead'], content: 'denied help request',
    }), 'TEAM_PROTOCOL_PERMISSION_DENIED')
    await assertUnchanged(ctx.teamRuns.publishMessage(first, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-two'], content: 'denied peer route',
    }), 'TEAM_PROTOCOL_TARGET_DENIED')
    await assertUnchanged(ctx.teamRuns.publishMessage(first, {
      kind: 'decision', threadId: MAIN_TEAM_THREAD_ID, targets: ['lead'], content: 'spoofed ledger decision',
    }), 'TEAM_LEAD_REQUIRED')
    await assertUnchanged(ctx.teamRuns.publishMessage(lead, {
      kind: 'decision', threadId: MAIN_TEAM_THREAD_ID, content: 'bypass the decision ledger',
    }), 'TEAM_INVALID_ARGUMENT')
    await assertUnchanged(ctx.teamRuns.publishMessage(lead, {
      kind: 'artifact', threadId: MAIN_TEAM_THREAD_ID, content: 'bypass the artifact ledger',
    }), 'TEAM_INVALID_ARGUMENT')
    await assertUnchanged(ctx.teamRuns.publishMessage(lead, {
      kind: 'final_delivery', threadId: MAIN_TEAM_THREAD_ID, content: 'bypass the delivery transaction',
    }), 'TEAM_LEAD_REQUIRED')

    const artifact = await ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Expert finding',
      body: 'A bounded result routed to Lead',
      mediaType: 'text/markdown',
      status: 'review',
    })
    expect(artifact.author).toMatchObject({ role: 'expert', name: 'expert-one' })
    expect(ctx.teamRuns.getRun(lead).protocol.members.find(member => member.name === 'expert-one'))
      .toMatchObject({ usedMessages: 1, remainingMessages: 0 })
    expect(ctx.teamRuns.getRun(lead).messages.at(-1)?.targets).toEqual([
      { role: 'lead', sessionId: lead.id, name: 'lead' },
    ])
    const accepted = await ctx.teamRuns.writeArtifact(lead, {
      artifactId: artifact.id,
      expectedVersion: artifact.version,
      kind: artifact.kind,
      title: artifact.title,
      body: artifact.body,
      mediaType: artifact.mediaType,
      status: 'accepted',
    })
    expect(accepted.author).toEqual(artifact.author)
    expect(ctx.teamRuns.getRun(lead).messages.at(-1)).toMatchObject({
      author: { role: 'lead', sessionId: lead.id },
      targets: [{
        role: 'expert',
        memberId: TeamMemberId('member-expert-one'),
        sessionId: SessionId('session-expert-one'),
        name: 'expert-one',
      }],
    })

    const leadArtifact = await ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Lead-owned synthesis',
      body: 'A Lead-owned ledger result has no conversational recipient',
      mediaType: 'text/markdown',
      status: 'accepted',
    })
    expect(leadArtifact.author).toMatchObject({ role: 'lead', sessionId: lead.id })
    expect(ctx.teamRuns.getRun(lead).messages.at(-1)).toMatchObject({
      author: { role: 'lead', sessionId: lead.id },
      targets: [],
    })
    expect(ctx.teamRuns.getRun(lead).messages.every(message => message.targets.every(target =>
      target.role !== message.author.role || target.sessionId !== message.author.sessionId))).toBe(true)
    await assertUnchanged(ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Over budget finding',
      body: 'Must leave no artifact or receipt',
      mediaType: 'text/markdown',
      status: 'review',
    }), 'TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED')
  })

  it('serializes linked challenge rounds and rejects orphan, parallel, wrong-party, and excess responses without residue', async () => {
    const { ctx, lead } = await setup()
    const { first, second } = await activateEnforcedPair(ctx, lead, {
      topology: 'producer_reviewer',
      maxChallengeRounds: 2,
      maxMessagesPerExpert: 8,
    })
    const threadId = MAIN_TEAM_THREAD_ID
    const firstChallengeId = TeamChallengeId('challenge-1')
    await ctx.teamRuns.publishMessage(first, {
      kind: 'challenge', threadId, targets: ['expert-two'], references: { challengeId: firstChallengeId },
      content: 'Challenge the first proposal',
    })
    expect(ctx.teamRuns.getRun(lead).protocol.challenges).toEqual([
      expect.objectContaining({ challengeId: firstChallengeId, round: 1, status: 'open', challenger: 'expert-one', target: 'expert-two' }),
    ])
    const rejectUnchanged = async (
      caller: Agent,
      request: Parameters<typeof ctx.teamRuns.publishMessage>[1],
      code: string,
    ): Promise<void> => {
      const before = ctx.teamRuns.getRun(lead)
      const eventCount = lead.session.events.length
      await expect(ctx.teamRuns.publishMessage(caller, request)).rejects.toMatchObject({ code })
      expect(ctx.teamRuns.getRun(lead)).toEqual(before)
      expect(lead.session.events).toHaveLength(eventCount)
    }
    await rejectUnchanged(first, {
      kind: 'challenge', threadId, targets: ['expert-two'], references: { challengeId: TeamChallengeId('parallel') },
      content: 'Cannot open a parallel round',
    }, 'TEAM_CHALLENGE_INVALID')
    await rejectUnchanged(second, {
      kind: 'response', threadId, targets: ['expert-one'], references: { challengeId: TeamChallengeId('orphan') },
      content: 'Orphan response',
    }, 'TEAM_CHALLENGE_INVALID')
    await rejectUnchanged(lead, {
      kind: 'response', threadId, targets: ['expert-one'], references: { challengeId: firstChallengeId },
      content: 'Wrong responder',
    }, 'TEAM_CHALLENGE_INVALID')
    await ctx.teamRuns.publishMessage(second, {
      kind: 'response', threadId, targets: ['expert-one'], references: { challengeId: firstChallengeId },
      content: 'Answer the first challenge',
    })
    const secondChallengeId = TeamChallengeId('challenge-2')
    await ctx.teamRuns.publishMessage(first, {
      kind: 'challenge', threadId, targets: ['expert-two'], references: { challengeId: secondChallengeId },
      content: 'Challenge the revised proposal',
    })
    await ctx.teamRuns.publishMessage(second, {
      kind: 'response', threadId, targets: ['expert-one'], references: { challengeId: secondChallengeId },
      content: 'Answer the second challenge',
    })
    expect(ctx.teamRuns.getRun(lead).protocol.challenges.map(challenge => ({ round: challenge.round, status: challenge.status })))
      .toEqual([{ round: 1, status: 'responded' }, { round: 2, status: 'responded' }])
    await rejectUnchanged(first, {
      kind: 'challenge', threadId, targets: ['expert-two'], references: { challengeId: TeamChallengeId('challenge-3') },
      content: 'Third round exceeds the Charter',
    }, 'TEAM_CHALLENGE_ROUND_LIMIT')

    const current = ctx.teamRuns.getRun(lead)
    const serializedEvents = JSON.parse(JSON.stringify(lead.session.events)) as SessionEvent[]
    expect(snapshotTeamRun(foldTeamRun(current.id, serializedEvents)).protocol).toEqual(current.protocol)
  })

  it('keeps an enforced task in progress until its owner routes evidence and the Lead accepts it', async () => {
    const { ctx, lead } = await setup()
    const { first } = await activateEnforcedPair(ctx, lead, { topology: 'centralized' })
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Evidence-backed expert task',
      description: 'The owner must produce an artifact before this task can complete',
    })
    const claimed = await ctx.teamRuns.updateTask(first, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const before = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.updateTask(first, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)

    const reviewArtifact = await ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Owner evidence',
      body: 'The expert completed the assigned analysis.',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'review',
    })
    await expect(ctx.teamRuns.updateTask(first, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })

    await ctx.teamRuns.publishMessage(first, {
      kind: 'handoff',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: task.id, artifactId: reviewArtifact.id },
      content: 'The owner finished execution and returned the review artifact.',
    })
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })

    await ctx.teamRuns.writeArtifact(lead, {
      artifactId: reviewArtifact.id,
      expectedVersion: reviewArtifact.version,
      kind: reviewArtifact.kind,
      title: reviewArtifact.title,
      body: reviewArtifact.body,
      mediaType: reviewArtifact.mediaType,
      taskIds: reviewArtifact.taskIds,
      status: 'accepted',
    })
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).resolves.toMatchObject({ status: 'completed', owner: { name: 'expert-one' } })
  })

  it('rejects accepted decisions and passed gates while their artifact is still under review', async () => {
    const { ctx, lead } = await setup()
    const { first } = await activateEnforcedPair(ctx, lead, { topology: 'centralized' })
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Unaccepted evidence', description: 'Do not announce completion before acceptance',
    })
    await ctx.teamRuns.updateTask(first, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const artifact = await ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Pending review',
      body: 'This output has not been accepted yet.',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'review',
    })
    const beforeDecision = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Premature acceptance',
      outcome: 'accepted',
      summary: 'Must not be recorded',
      rationale: 'The referenced artifact is still under review',
      taskIds: [task.id],
      artifactIds: [artifact.id],
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(beforeDecision)

    const beforeGate = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 1,
      status: 'passed',
      summary: 'Must remain pending until the artifact is accepted',
      taskId: task.id,
      artifactId: artifact.id,
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(beforeGate)
  })

  it('rejects final delivery when an active expert only comments without an accepted artifact contribution', async () => {
    const { ctx, lead } = await setup()
    const { first, second } = await activateEnforcedPair(ctx, lead, { topology: 'centralized' })
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Verified expert delivery', description: 'Every active expert must finish auditable work',
    })
    const claimed = await ctx.teamRuns.updateTask(first, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const reviewArtifact = await ctx.teamRuns.writeArtifact(first, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'First expert output',
      body: 'Evidence-backed result from the assigned owner.',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'review',
    })
    await ctx.teamRuns.publishMessage(first, {
      kind: 'handoff',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: task.id, artifactId: reviewArtifact.id },
      content: 'The owner completed the task and submitted its artifact.',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      artifactId: reviewArtifact.id,
      expectedVersion: reviewArtifact.version,
      kind: reviewArtifact.kind,
      title: reviewArtifact.title,
      body: reviewArtifact.body,
      mediaType: reviewArtifact.mediaType,
      taskIds: reviewArtifact.taskIds,
      status: 'accepted',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 1,
      status: 'passed',
      summary: 'The owner artifact passed review',
      taskId: task.id,
      artifactId: artifact.id,
    })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Accept owner artifact',
      outcome: 'accepted',
      summary: 'The assigned owner completed auditable work',
      rationale: 'The accepted artifact covers the completed task',
      taskIds: [task.id],
      artifactIds: [artifact.id],
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-two'],
      references: { taskId: task.id, artifactId: artifact.id },
      content: 'Review the proposed completion.',
    })
    await ctx.teamRuns.publishMessage(second, {
      kind: 'review',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: task.id, artifactId: artifact.id },
      content: 'I commented on the first expert output but produced no artifact of my own.',
    })

    const before = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID, content: 'Must wait for every expert output',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
  })

  it('commits completion and final delivery together only after every P5 ledger gate', async () => {
    const { ctx, lead } = await setup()
    await enterProvisioning(ctx, lead, 'simple', 1)
    let formation = ctx.teamRuns.getRun(lead)
    const slotId = TeamProtocolSlotId('delivery-slot')
    await ctx.teamRuns.materializeProtocol(lead, {
      expectedRevision: formation.revision,
      topology: 'producer_reviewer',
      maxChallengeRounds: 1,
      maxMessagesPerExpert: 4,
      experts: [{
        slotId,
        initialMemberId: TeamMemberId('member-expert-one'),
        name: 'expert-one',
        permissions: { challenge: true, review: true, requestHelp: true },
        allowedTargetSlotIds: [],
      }],
    })
    formation = await provision(ctx, lead, 'expert-one', 'active', slotId)
    await ctx.teamRuns.createQualityGate(lead, { name: 'P5 delivery quality' })
    formation = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.changePhase(lead, { expectedRevision: formation.revision, phase: 'active' })
    const expert = (await ctx.agents.create({
      sessionId: SessionId('session-expert-one'),
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Deliver result', description: 'Produce and review the complete result',
    })
    const claimed = await ctx.teamRuns.updateTask(expert, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })

    const before = ctx.teamRuns.getRun(lead)
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID, content: 'Final reviewed delivery',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events.filter(event => event.type === 'collaboration/run/phase')).toHaveLength(3)

    const reviewArtifact = await ctx.teamRuns.writeArtifact(expert, {
      expectedVersion: 0,
      kind: 'document',
      title: 'Reviewed result',
      body: 'Complete final artifact body',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'review',
    })
    await ctx.teamRuns.publishMessage(expert, {
      kind: 'handoff',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: task.id, artifactId: reviewArtifact.id },
      content: 'The task owner completed the artifact and requests Lead review.',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      artifactId: reviewArtifact.id,
      expectedVersion: reviewArtifact.version,
      kind: reviewArtifact.kind,
      title: reviewArtifact.title,
      body: reviewArtifact.body,
      mediaType: reviewArtifact.mediaType,
      taskIds: reviewArtifact.taskIds,
      status: 'accepted',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 1,
      status: 'passed',
      summary: 'All acceptance checks passed',
      taskId: task.id,
      artifactId: artifact.id,
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-one'],
      references: { taskId: task.id, artifactId: artifact.id },
      content: 'Request Lead completion review',
    })
    await ctx.teamRuns.publishMessage(expert, {
      kind: 'review',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: task.id, artifactId: artifact.id },
      content: 'The targeted completion review confirms the accepted artifact is ready.',
    })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Accept final delivery',
      outcome: 'accepted',
      summary: 'Artifact meets the task acceptance criteria',
      rationale: 'The quality result and public review are complete',
      taskIds: [task.id],
      artifactIds: [artifact.id],
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({
      status: 'reviewing',
      controller: { health: 'ready' },
    })
    const deliveryChallengeId = TeamChallengeId('delivery-challenge')
    await ctx.teamRuns.publishMessage(expert, {
      kind: 'challenge',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { challengeId: deliveryChallengeId },
      content: 'Resolve this delivery concern before closing',
    })
    const openChallenge = ctx.teamRuns.getRun(lead)
    const openChallengeEventCount = lead.session.events.length
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID,
      content: 'Must not close over an open challenge',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(openChallenge)
    expect(lead.session.events).toHaveLength(openChallengeEventCount)
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'response',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-one'],
      references: { challengeId: deliveryChallengeId },
      content: 'The delivery concern is resolved',
    })
    const completed = await ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID,
      references: { taskId: task.id },
      content: 'Final reviewed delivery',
    })
    expect(completed).toMatchObject({ phase: 'completed', status: 'completed' })
    expect(completed.messages.at(-1)).toMatchObject({
      kind: 'final_delivery', content: 'Final reviewed delivery', author: { role: 'lead' }, visibility: 'public',
    })
    expect(lead.session.events.slice(-3).map(event => event.type)).toEqual([
      'collaboration/run/phase', 'collaboration/message', 'collaboration/run/phase',
    ])
  })

  it('rejects completion missing one quality result with zero aggregate side effects', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Atomic delivery', description: 'Prove a missing gate cannot partially complete',
    })
    const claimed = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'test_report',
      title: 'Atomic gate report',
      body: 'The accepted body cannot compensate for a pending quality gate',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'accepted',
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Please complete',
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'review', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Reviewed',
    })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Accept artifact',
      outcome: 'accepted',
      summary: 'Artifact is accepted independently',
      rationale: 'The quality result is intentionally missing',
      taskIds: [task.id],
      artifactIds: [artifact.id],
    })
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID, content: 'Must not commit',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('rejects an unrelated accepted decision without mutating any delivery state', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Traceable delivery', description: 'Require a task-to-artifact acceptance chain',
    })
    const claimed = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'document',
      title: 'Accepted task artifact',
      body: 'The task artifact is accepted but the decision below does not reference it',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'accepted',
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 1,
      status: 'passed',
      summary: 'The materialized quality gate passed',
      taskId: task.id,
      artifactId: artifact.id,
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Request final completion',
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'review', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Public review is complete',
    })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Accept an unrelated observation',
      outcome: 'accepted',
      summary: 'This acceptance intentionally has no task or artifact relation',
      rationale: 'It must not unlock final delivery',
      taskIds: [],
      artifactIds: [],
    })
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length
    expect(before.controller.health).not.toBe('ready')
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID, content: 'Must remain uncommitted',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('rejects completion when no quality gate was materialized', async () => {
    const { ctx, lead } = await setup()
    await enterProvisioning(ctx, lead, 'simple', 1)
    let run = await provision(ctx, lead, 'expert-one')
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Ungated delivery', description: 'Prove an empty quality ledger fails closed',
    })
    const claimed = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'test_report',
      title: 'Ungated artifact',
      body: 'All other delivery evidence exists except the materialized quality ledger',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'accepted',
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Request completion',
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'review', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Review is present',
    })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Accept the traceable artifact',
      outcome: 'accepted',
      summary: 'The task and artifact relation is complete',
      rationale: 'Only the required quality ledger is absent',
      taskIds: [task.id],
      artifactIds: [artifact.id],
    })
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length
    await expect(ctx.teamRuns.completeRun(lead, {
      threadId: MAIN_TEAM_THREAD_ID, content: 'Must fail closed',
    })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('rejects an oversized multibyte artifact body without leaving metadata or events', async () => {
    const { ctx, lead } = await setup({ maxArtifactBodyBytes: 3 })
    await activateSimple(ctx, lead)
    const before = ctx.teamRuns.getRun(lead)
    const eventCount = lead.session.events.length
    await expect(ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'evidence',
      title: 'Too large',
      body: 'éé',
      mediaType: 'text/plain',
      status: 'draft',
    })).rejects.toMatchObject({ code: 'TEAM_ARTIFACT_TOO_LARGE' })
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(lead.session.events).toHaveLength(eventCount)
  })

  it('enforces artifact CAS and atomically records Lead Controller corrections', async () => {
    const { ctx, lead } = await setup({ taskStallCursorThreshold: 1 })
    await activateSimple(ctx, lead)
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Controller task', description: 'Original execution plan',
    })
    const artifact = await ctx.teamRuns.writeArtifact(lead, {
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Analysis',
      body: 'Version one',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'draft',
    })
    await expect(ctx.teamRuns.writeArtifact(lead, {
      artifactId: artifact.id,
      expectedVersion: 0,
      kind: 'analysis',
      title: 'Analysis',
      body: 'Stale overwrite',
      mediaType: 'text/markdown',
      taskIds: [task.id],
      status: 'review',
    })).rejects.toMatchObject({ code: 'STALE_REVISION' })

    expect(ctx.teamRuns.getRun(lead).controller.stalledTaskIds).not.toContain(task.id)
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Unrelated chatter does not advance the task',
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({
      status: 'blocked',
      controller: { health: 'stalled', stalledTaskIds: [task.id] },
    })

    const before = ctx.teamRuns.getRun(lead)
    const controlled = await ctx.teamRuns.control(lead, {
      expectedRevision: before.revision,
      taskId: task.id,
      expectedTaskRevision: task.revision,
      action: 'replan',
      description: 'Replanned execution with explicit evidence',
      rationale: 'Duplicate work was detected from the durable task ledger',
    })
    expect(controlled.tasks[0]).toMatchObject({ revision: 2, description: 'Replanned execution with explicit evidence' })
    expect(controlled.decisions.at(-1)).toMatchObject({ outcome: 'replan', taskIds: [task.id] })
    expect(controlled.messages.at(-1)).toMatchObject({ kind: 'decision', references: { taskId: task.id } })
    expect(controlled.controller.actionsTaken).toContain(controlled.decisions.at(-1)?.id)
    expect(controlled.revision).toBe(before.revision + 3)
    expect(controlled.status).toBe('running')
  })

  it('does not report dependency-blocked pending tasks as stalled', async () => {
    const { ctx, lead } = await setup({ taskStallCursorThreshold: 1 })
    await activateSimple(ctx, lead)
    const blocker = await ctx.teamRuns.createTask(lead, {
      subject: 'Collect evidence', description: 'Collect the evidence before synthesis',
    })
    const dependent = await ctx.teamRuns.createTask(lead, {
      subject: 'Synthesize findings',
      description: 'Wait for the evidence task before producing the synthesis',
      blockedBy: [blocker.id],
    })

    await ctx.teamRuns.publishMessage(lead, {
      kind: 'inform',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-one'],
      references: { taskId: blocker.id },
      content: 'The ready evidence task is still making progress',
    })

    const run = ctx.teamRuns.getRun(lead)
    expect(run.tasks.find(task => task.id === dependent.id)).toMatchObject({ ready: false, status: 'pending' })
    expect(run.controller.stalledTaskIds).not.toContain(dependent.id)
    expect(run).toMatchObject({ status: 'running', controller: { health: 'healthy' } })
  })

  it('projects quality blocking and rework states and deterministically recovers them', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Recover controller state', description: 'Exercise quality and rework state recovery',
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 1,
      status: 'failed',
      summary: 'Evidence is incomplete',
      taskId: task.id,
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({
      status: 'blocked',
      controller: { health: 'attention', qualityFailureCount: 1 },
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 2,
      status: 'passed',
      summary: 'Evidence was corrected',
      taskId: task.id,
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({
      status: 'running',
      controller: { health: 'healthy', qualityFailureCount: 0 },
    })

    const claimed = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completed = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 3,
      status: 'failed',
      summary: 'The completed draft exposed a new quality regression',
      taskId: task.id,
    })
    let run = ctx.teamRuns.getRun(lead)
    run = await ctx.teamRuns.control(lead, {
      expectedRevision: run.revision,
      taskId: task.id,
      expectedTaskRevision: completed.revision,
      action: 'rework',
      rationale: 'The Lead requires one additional revision',
    })
    expect(run).toMatchObject({ status: 'reworking', controller: { health: 'reworking' } })
    await ctx.teamRuns.updateQualityGate(lead, {
      gateId: TeamQualityGateId('quality-gate-1'),
      expectedVersion: 4,
      status: 'passed',
      summary: 'The rework resolved the quality regression',
      taskId: task.id,
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({ status: 'reworking', controller: { health: 'reworking' } })
    await ctx.teamRuns.writeDecision(lead, {
      expectedVersion: 0,
      subject: 'Rework acknowledged',
      outcome: 'unresolved',
      summary: 'The replacement task is ready to continue',
      rationale: 'A later non-rework decision clears the transient controller presentation',
    })
    expect(ctx.teamRuns.getRun(lead)).toMatchObject({ status: 'running', controller: { health: 'healthy' } })
  })

  it('enforces task CAS and DAG while reporting generic resource conflicts as advisory', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const first = await ctx.teamRuns.createTask(lead, {
      subject: 'Requirements', description: 'Draft requirements', resourceScopes: ['document/requirements'],
    })
    const second = await ctx.teamRuns.createTask(lead, {
      subject: 'Document', description: 'Edit the complete document', resourceScopes: ['document'],
    })
    const claimedFirst = await ctx.teamRuns.updateTask(lead, {
      taskId: first.id, expectedRevision: first.revision, action: 'claim',
    })
    const claimedSecond = await ctx.teamRuns.updateTask(lead, {
      taskId: second.id, expectedRevision: second.revision, action: 'claim',
    })
    expect(ctx.teamRuns.getTask(lead, claimedSecond.id).resourceConflicts).toEqual([claimedFirst.id])
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: first.id, expectedRevision: first.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'STALE_REVISION', retryable: true })
    await expect(ctx.teamRuns.createTask(lead, {
      subject: 'Missing blocker', description: 'invalid DAG', blockedBy: [TeamTaskId('missing')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })

    const blocker = await ctx.teamRuns.createTask(lead, {
      subject: 'Blocker', description: 'Complete before the dependent',
    })
    const dependent = await ctx.teamRuns.createTask(lead, {
      subject: 'Dependent', description: 'Must remain blocked', blockedBy: [blocker.id],
    })
    const claimedBlocker = await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    const completedBlocker = await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: claimedBlocker.revision, action: 'complete',
    })
    const claimedDependent = await ctx.teamRuns.updateTask(lead, {
      taskId: dependent.id, expectedRevision: dependent.revision, action: 'claim',
    })
    await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: completedBlocker.revision, action: 'reopen',
    })
    await expect(ctx.teamRuns.updateTask(lead, {
      taskId: dependent.id, expectedRevision: claimedDependent.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
  })

  it('persists only typed public messages and rejects missing task references', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const eventCount = lead.session.events.length
    for (const targets of [undefined, ['expert-one', 'lead'], ['lead']] as const) {
      await expect(ctx.teamRuns.publishMessage(lead, {
        kind: 'proposal',
        threadId: MAIN_TEAM_THREAD_ID,
        ...targets === undefined ? {} : { targets },
        content: 'Invalid serial recipient set',
      })).rejects.toMatchObject({ code: 'TEAM_PROTOCOL_TARGET_DENIED' })
    }
    expect(lead.session.events).toHaveLength(eventCount)
    const proposal = await ctx.teamRuns.publishMessage(lead, {
      kind: 'proposal', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'Adopt the reviewed approach',
    })
    expect(proposal).toMatchObject({ visibility: 'public', kind: 'proposal', author: { role: 'lead' } })
    expect(proposal.sequence).toBeGreaterThanOrEqual(0)
    await expect(ctx.teamRuns.publishMessage(lead, {
      kind: 'review',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-one'],
      references: { taskId: TeamTaskId('missing') },
      content: 'This reference must fail',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
  })

  it('returns stable message byte and count limit codes', async () => {
    const bytes = await setup({ maxPublicMessageBytes: 3, maxPublicMessages: 10 })
    await activateSimple(bytes.ctx, bytes.lead)
    await expect(bytes.ctx.teamRuns.publishMessage(bytes.lead, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'éé',
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })

    const count = await setup({ maxPublicMessages: 1 })
    await activateSimple(count.ctx, count.lead)
    await count.ctx.teamRuns.publishMessage(count.lead, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'first',
    })
    await expect(count.ctx.teamRuns.publishMessage(count.lead, {
      kind: 'inform', threadId: MAIN_TEAM_THREAD_ID, targets: ['expert-one'], content: 'second',
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_LIMIT' })
  })
})
