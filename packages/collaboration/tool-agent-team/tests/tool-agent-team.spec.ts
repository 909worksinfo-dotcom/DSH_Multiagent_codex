import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TeamRunService, {
  MAIN_TEAM_THREAD_ID,
  ProvisionAttemptId,
  TeamArtifactId,
  TeamMemberId,
  TeamQualityGateId,
  TeamProtocolSlotId,
  TeamTaskId,
} from '@deepseek-ai/dsh-agent-team'
import type { TeamRunSnapshot } from '@deepseek-ai/dsh-agent-team'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  COLLABORATION_SEND_KINDS,
  PUBLIC_MESSAGE_KINDS,
  TEAM_RUN_PHASES,
  TEAM_RUN_PUBLIC_STATUSES,
} from '../src/schemas.ts'
import * as ToolAgentTeam from '../src/index.ts'

const SIGNAL = new AbortController().signal
const TOOL_NAMES = [
  'collaboration_artifact_read',
  'collaboration_artifact_write',
  'collaboration_get',
  'collaboration_control',
  'collaboration_controller_get',
  'collaboration_decision_write',
  'collaboration_followup',
  'collaboration_parallel_followup',
  'collaboration_quality_update',
  'collaboration_send',
  'collaboration_complete',
  'collaboration_task_create',
  'collaboration_task_get',
  'collaboration_task_list',
  'collaboration_task_update',
].sort()

interface TestExecutionPlan {
  readonly taskDag: readonly {
    readonly id: string
    readonly blockedBy: readonly string[]
  }[]
  readonly stages: readonly {
    readonly id: string
    readonly order: number
    readonly mode: 'serial' | 'parallel'
    readonly workstreamIds: readonly string[]
  }[]
}

const contexts = new Set<Context>()
let callNumber = 0

type ExpertFollowup = (
  lead: Agent,
  childId: SessionId,
  content: Array<{ type: 'text'; text: string }>,
  options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
) => Promise<MessageId>

function expertFollowupMock() {
  return vi.fn<ExpertFollowup>(() => Promise.resolve(MessageId('expert-followup-message')))
}

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
  if (failures.length > 0) throw new AggregateError(failures, 'tool adapter cleanup failed')
})

async function setup(): Promise<{
  ctx: Context
  lead: Agent
  fiber: Awaited<ReturnType<Context['plugin']>>
  followup: ReturnType<typeof expertFollowupMock>
  replaceExpert: ReturnType<typeof vi.fn>
  setPlan: (plan: TestExecutionPlan | undefined) => void
}> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TeamRunService)
  const followup = expertFollowupMock()
  const replaceExpert = vi.fn(async () => ({}))
  ctx.provide('expertRuntime', { followup } as never)
  let executionPlan: TestExecutionPlan | undefined
  ctx.provide('teamOrchestrator', {
    get: (lead: Agent) => ({
      requestId: 'tool-agent-team-request',
      run: ctx.teamRuns.getRun(lead),
      plan: executionPlan,
    }),
    replaceExpert,
  } as never)
  const fiber = await ctx.plugin(ToolAgentTeam)
  const lead = ctx.agentLoop.create(SessionId(`tool-collaboration-lead-${crypto.randomUUID()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, lead, fiber, followup, replaceExpert, setPlan: (plan) => { executionPlan = plan } }
}

async function activateParallel(ctx: Context, lead: Agent): Promise<{
  experts: readonly Agent[]
  tasks: readonly { readonly id: ReturnType<typeof TeamTaskId>; readonly revision: number }[]
}> {
  let run = await ctx.teamRuns.createRun(lead, {
    objective: 'Run two explicitly parallel tasks',
    complexity: 'medium',
    plannedExperts: 3,
  })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
  const rows = [
    { name: 'expert-one', sessionId: SessionId('parallel-expert-one'), slotId: TeamProtocolSlotId('parallel-slot-one') },
    { name: 'expert-two', sessionId: SessionId('parallel-expert-two'), slotId: TeamProtocolSlotId('parallel-slot-two') },
    { name: 'expert-three', sessionId: SessionId('parallel-expert-three'), slotId: TeamProtocolSlotId('parallel-slot-three') },
  ] as const
  await ctx.teamRuns.materializeProtocol(lead, {
    expectedRevision: run.revision,
    topology: 'parallel',
    maxChallengeRounds: 2,
    maxMessagesPerExpert: 32,
    experts: rows.map((row, index) => ({
      slotId: row.slotId,
      initialMemberId: TeamMemberId(`parallel-member-${String(index + 1)}`),
      name: row.name,
      permissions: { challenge: true, review: true, requestHelp: true },
      allowedTargetSlotIds: rows.filter(candidate => candidate !== row).map(candidate => candidate.slotId),
    })),
  })
  const experts: Agent[] = []
  for (const [index, row] of rows.entries()) {
    run = ctx.teamRuns.getRun(lead)
    const attemptId = ProvisionAttemptId(`parallel-attempt-${String(index + 1)}`)
    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId(`parallel-member-${String(index + 1)}`),
      sessionId: row.sessionId,
      attemptId,
      name: row.name,
      role: `Execute parallel responsibility ${String(index + 1)}`,
      protocolSlotId: row.slotId,
    })
    const { agent } = await ctx.agents.create({
      sessionId: row.sessionId,
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    experts.push(agent)
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
  }
  await ctx.teamRuns.createQualityGate(lead, { name: 'Parallel delivery quality' })
  run = ctx.teamRuns.getRun(lead)
  await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
  const first = await ctx.teamRuns.createTask(lead, {
    subject: 'Parallel finding one', description: 'Produce the first independent finding',
  })
  const second = await ctx.teamRuns.createTask(lead, {
    subject: 'Parallel finding two', description: 'Produce the second independent finding',
  })
  return {
    experts,
    tasks: [
      await ctx.teamRuns.updateTask(lead, {
        taskId: first.id, expectedRevision: first.revision, action: 'assign', owner: 'expert-one',
      }),
      await ctx.teamRuns.updateTask(lead, {
        taskId: second.id, expectedRevision: second.revision, action: 'assign', owner: 'expert-two',
      }),
    ],
  }
}

async function activateSimple(ctx: Context, lead: Agent): Promise<TeamRunSnapshot> {
  let run = await ctx.teamRuns.createRun(lead, {
    objective: 'Exercise stable collaboration tools',
    complexity: 'simple',
    plannedExperts: 1,
  })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
  run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
  const protocolSlotId = TeamProtocolSlotId('tool-slot-one')
  await ctx.teamRuns.materializeProtocol(lead, {
    expectedRevision: run.revision,
    topology: 'producer_reviewer',
    maxChallengeRounds: 2,
    maxMessagesPerExpert: 32,
    experts: [{
      slotId: protocolSlotId,
      initialMemberId: TeamMemberId('tool-member-one'),
      name: 'expert-one',
      permissions: { challenge: true, review: true, requestHelp: true },
      allowedTargetSlotIds: [],
    }],
  })
  run = ctx.teamRuns.getRun(lead)
  const attemptId = ProvisionAttemptId('tool-attempt-one')
  await ctx.teamRuns.beginExpertProvision(lead, {
    expectedRevision: run.revision,
    memberId: TeamMemberId('tool-member-one'),
    sessionId: SessionId('tool-expert-one'),
    attemptId,
    name: 'expert-one',
    role: 'Test the stable adapter',
    protocolSlotId,
  })
  run = ctx.teamRuns.getRun(lead)
  await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
  run = ctx.teamRuns.getRun(lead)
  await ctx.teamRuns.createQualityGate(lead, { name: 'Tool delivery quality' })
  run = ctx.teamRuns.getRun(lead)
  return ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`collaboration-call-${++callNumber}`),
    name,
    arguments: args,
    signal: SIGNAL,
    agent,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

describe('stable TeamRun model tools', () => {
  it('installs only after TeamRun creation and exposes the public-only collaboration contract', async () => {
    const { ctx, lead } = await setup()
    expect((await assembly(ctx, lead)).tools.map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)))
      .toEqual([])

    await activateSimple(ctx, lead)
    await vi.waitFor(async () => {
      const names = (await assembly(ctx, lead)).tools.map(tool => tool.name)
        .filter(name => TOOL_NAMES.includes(name)).sort()
      expect(names).toEqual(TOOL_NAMES)
    })
    const assembled = await assembly(ctx, lead)
    const prompt = renderPrompt(assembled)
    expect(prompt).toContain('single collaboration baton')
    expect(prompt).toContain('collaboration_parallel_followup')
    expect(prompt).toContain('exactly one best-suited recipient')
    expect(prompt).toContain('delivers the next turn only after the sender is idle')
    expect(prompt).toContain('same explicit dispute thread_id')
    expect(prompt).toContain('answer an open round before starting another')
    expect(prompt).toContain('Every active expert must finish an artifact')
    expect(prompt).toContain('An expert must never mark an enforced task complete')
    expect(prompt).toContain('The Lead must read and accept that exact owner-authored artifact')
    expect(prompt).toContain('the task remains in progress')
    expect(prompt).toContain('call collaboration_complete before returning the unified final response')
    expect(prompt).toContain('Ordinary messages must omit challenge_id')
    expect(prompt).toContain('refresh and correct the call instead of bypassing public collaboration')
    expect(prompt).toContain('Never publish private reasoning or chain-of-thought')
    expect(prompt).toContain('Formation and expert activation belong to the runtime controller')
    expect(prompt).toContain('Your TeamRun role is lead')
    expect(assembled.tools.map(tool => tool.name)).not.toContain('collaboration_provision_expert')

    const sendSchema = assembled.tools.find(tool => tool.name === 'collaboration_send')
    expect(sendSchema?.parameters).toMatchObject({
      properties: { kind: { enum: COLLABORATION_SEND_KINDS } },
    })
    expect(COLLABORATION_SEND_KINDS).not.toEqual(PUBLIC_MESSAGE_KINDS)
    expect(COLLABORATION_SEND_KINDS).not.toContain('decision')
    expect(COLLABORATION_SEND_KINDS).not.toContain('artifact')
    expect(COLLABORATION_SEND_KINDS).not.toContain('final_delivery')
    expect(PUBLIC_MESSAGE_KINDS).toEqual(expect.arrayContaining(['decision', 'artifact', 'final_delivery']))
    expect(PUBLIC_MESSAGE_KINDS).not.toContain('private_reasoning' as never)
    expect(TEAM_RUN_PHASES).toEqual([
      'profiling', 'planning', 'provisioning', 'active', 'completing', 'completed',
      'formation_failed', 'failed', 'cancelled',
    ])
    expect(TEAM_RUN_PUBLIC_STATUSES).toEqual([
      'forming', 'running', 'blocked', 'reviewing', 'reworking', 'completed',
      'team_formation_failed', 'failed', 'cancelled',
    ])
  })

  it('returns canonical run data and adapts task CAS with bounded pagination', async () => {
    const { ctx, lead } = await setup()
    const run = await activateSimple(ctx, lead)
    const read = await execute(ctx, lead, 'collaboration_get', {})
    expect(read.isError).toBe(false)
    expect(JSON.parse(text(read))).toMatchObject({
      run: {
        id: run.id,
        revision: run.revision,
        phase: 'active',
        status: 'running',
        counts: { planned: 1, active: 1, provisioning: 0, availableSlots: 0 },
        protocol: {
          mode: 'enforced',
          topology: 'producer_reviewer',
          limits: { maxChallengeRounds: 2, maxMessagesPerExpert: 32 },
          members: [{ name: 'expert-one', allowedTargets: ['lead'], usedMessages: 0, remainingMessages: 32 }],
          challenges: [],
        },
      },
    })

    const createdValues: Array<{ id: string; revision: number }> = []
    for (const subject of ['first', 'second', 'third']) {
      const created = await execute(ctx, lead, 'collaboration_task_create', {
        subject,
        description: `${subject} task description`,
        resource_scopes: [`packages/${subject}`],
      })
      expect(created.isError).toBe(false)
      createdValues.push(JSON.parse(text(created)) as { id: string; revision: number })
    }

    const firstPage = await execute(ctx, lead, 'collaboration_task_list', { cursor: 0, limit: 2 })
    expect(JSON.parse(text(firstPage))).toMatchObject({
      tasks: [{ id: createdValues[0]!.id }, { id: createdValues[1]!.id }],
      nextCursor: 2,
    })
    const secondPage = await execute(ctx, lead, 'collaboration_task_list', { cursor: 2 })
    expect(JSON.parse(text(secondPage))).toEqual({
      tasks: [expect.objectContaining({ id: createdValues[2]!.id })],
    })

    for (const args of [{ cursor: -1 }, { cursor: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 101 }]) {
      const rejected = await execute(ctx, lead, 'collaboration_task_list', args)
      expect(rejected.isError).toBe(true)
      if (rejected.isError) expect(rejected.error.info?.code).toBe('TEAM_INVALID_ARGUMENT')
    }

    const readTask = await execute(ctx, lead, 'collaboration_task_get', { task_id: createdValues[0]!.id })
    expect(JSON.parse(text(readTask))).toMatchObject({
      id: createdValues[0]!.id,
      revision: 1,
      resourceScopes: ['packages/first'],
    })
    const updated = await execute(ctx, lead, 'collaboration_task_update', {
      task_id: createdValues[0]!.id,
      expected_revision: createdValues[0]!.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(updated))).toMatchObject({
      id: createdValues[0]!.id,
      revision: 2,
      status: 'in_progress',
      owner: 'lead',
    })
  })

  it('keeps the Lead inside collaboration tools and rejects duplicate Charter task creation', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const bash = vi.fn(() => Promise.resolve('should not run'))
    lead.ctx.tools.register({
      name: 'bash',
      description: 'Synthetic general-purpose tool',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: bash,
    })

    const blockedBash = await execute(ctx, lead, 'bash', {})
    expect(blockedBash.isError).toBe(true)
    expect(text(blockedBash)).toContain('only coordinate with collaboration_* tools')
    expect(bash).not.toHaveBeenCalled()

    lead.session.append('collaboration/orchestration/charter', {
      version: 1,
      eventId: 'test-charter-event',
      runId: lead.id,
      requestId: 'test-charter-request',
      requestDigest: 'test-request-digest',
      revision: 3,
      planDigest: 'test-plan-digest',
      charterDigest: 'test-charter-digest',
      charter: {},
    } as never)
    const duplicate = await execute(ctx, lead, 'collaboration_task_create', {
      subject: 'Duplicate Charter task',
      description: 'Must be rejected before mutation',
    })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('Team Charter already created the authoritative task list')
    expect(ctx.teamRuns.getRun(lead).tasks).toHaveLength(0)
  })

  it('publishes an exact compact public receipt with a valid task reference but never echoes content', async () => {
    const { ctx, lead, followup } = await setup()
    const run = await activateSimple(ctx, lead)
    const created = await execute(ctx, lead, 'collaboration_task_create', {
      subject: 'Referenced task',
      description: 'Receive a typed public message reference',
    })
    const task = JSON.parse(text(created)) as { id: string }
    const content = `large-caller-owned-content-${'x'.repeat(1_024)}`
    const result = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      targets: ['expert-one'],
      task_id: task.id,
      context_summary: 'The task is ready for one focused proposal review',
      next_action: 'Review the proposal and identify the strongest correction',
      selection_reason: 'expert-one is the only active protocol-allowed reviewer',
      content,
    })
    expect(result.isError).toBe(false)
    const receipt = JSON.parse(text(result)) as Record<string, unknown>
    expect(receipt).toMatchObject({
      runId: run.id,
      threadId: MAIN_TEAM_THREAD_ID,
      kind: 'proposal',
      author: 'lead',
      targets: ['expert-one'],
      references: {
        taskId: task.id,
      },
      visibility: 'public',
    })
    expect(typeof receipt['id']).toBe('string')
    expect(typeof receipt['eventId']).toBe('string')
    expect(typeof receipt['sequence']).toBe('number')
    expect(typeof receipt['createdAt']).toBe('number')
    expect(receipt).not.toHaveProperty('content')
    expect(text(result)).not.toContain(content)

    expect(result.concludesTurn).toBe(true)
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
    const call = followup.mock.calls[0]
    expect(call?.[0]).toBe(lead)
    expect(call?.[1]).toBe(SessionId('tool-expert-one'))
    expect(call?.[2][0]?.text).toContain('Next action: Review the proposal')
    expect(call?.[2][0]?.text).not.toContain('Sequential collaboration handoff')
    const published = ctx.teamRuns.getRun(lead).messages.at(-1)
    expect(published?.content).toMatch(/^Context summary:/u)
    expect(published?.content).not.toContain('Sequential collaboration handoff')

    const normalizedBlanks = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      thread_id: '',
      targets: ['', '  '],
      task_id: '',
      challenge_id: '',
      decision_id: '',
      artifact_id: '',
      context_summary: 'Context',
      next_action: 'Action',
      selection_reason: 'Reason',
      content: 'Blank optional model fields must be omitted',
    })
    expect(normalizedBlanks.isError).toBe(true)
    expect(text(normalizedBlanks)).toContain('Another member owns the collaboration baton')

    const forgedChallengeReference = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      targets: ['expert-one'],
      challenge_id: 'challenge-one',
      context_summary: 'Context',
      next_action: 'Action',
      selection_reason: 'Reason',
      content: 'proposal cannot forge a challenge relationship',
    })
    expect(forgedChallengeReference.isError).toBe(true)
    expect(text(forgedChallengeReference)).toContain('Another member owns the collaboration baton')

    const privateMessage = await execute(ctx, lead, 'collaboration_send', {
      kind: 'private_reasoning',
      targets: ['expert-one'],
      context_summary: 'Context',
      next_action: 'Action',
      selection_reason: 'Reason',
      content: 'must be rejected before the TeamRun service',
    })
    expect(privateMessage.isError).toBe(true)
  })

  it('holds one routed message until the sender is idle and rejects a second route in the same turn', async () => {
    const { ctx, lead, followup } = await setup()
    await activateSimple(ctx, lead)
    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Focused finding', description: 'Produce one bounded expert finding',
    })
    const assigned = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'assign', owner: 'expert-one',
    })
    let status: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => status })

    const routed = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task',
      target: 'expert-one',
      task_id: assigned.id,
      context_summary: 'The TeamRun is active and no earlier routed turn is outstanding',
      next_action: 'Produce one bounded expert finding',
      selection_reason: 'expert-one is the only active expert and owns this responsibility',
      content: 'Investigate the assigned question and return one evidence-backed finding',
    })
    expect(routed.isError).toBe(false)
    expect(routed.concludesTurn).toBe(true)
    await Promise.resolve()
    expect(followup).not.toHaveBeenCalled()

    const duplicate = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task',
      target: 'expert-one',
      context_summary: 'Attempt a duplicate route',
      next_action: 'Must not run',
      selection_reason: 'Must not be evaluated',
      content: 'This second message must be rejected',
    })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('Another member owns the collaboration baton')

    status = 'idle'
    ctx.emit('agent/status', { agent: lead, status })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
  })

  it('restores a failed expert during a serial handoff and returns the baton to the Lead', async () => {
    const { ctx, lead, followup, replaceExpert } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    let leadStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    Object.defineProperty(experts[0]!, 'status', { configurable: true, get: () => 'running' })
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})

    const routed = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task', target: 'expert-one', task_id: tasks[0]!.id,
      context_summary: 'The first serial task is ready', next_action: 'Execute the first task',
      selection_reason: 'expert-one owns the first task', content: 'Run the assigned task',
    })
    expect(routed.isError).toBe(false)
    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })

    const run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('parallel-attempt-1'),
      failure: {
        code: 'TEAM_CANCELLED',
        message: 'expert active execution deadline reached',
        retryable: true,
        details: {},
      },
    })

    await vi.waitFor(() => {
      expect(replaceExpert).toHaveBeenCalledWith(
        lead,
        { requestId: 'tool-agent-team-request', failedMemberId: TeamMemberId('parallel-member-1') },
        expect.any(AbortSignal),
      )
      expect(leadWake).toHaveBeenCalledOnce()
    })
    const wakeContent = leadWake.mock.calls[0]?.[0].content[0]
    expect(wakeContent?.type).toBe('text')
    if (wakeContent?.type !== 'text') throw new Error('serial recovery must wake the Lead with text')
    expect(wakeContent.text).toContain('restored the vacant slot')
    const leadRead = await execute(ctx, lead, 'collaboration_get', {})
    expect(leadRead.isError).toBe(false)
  })

  it('restarts recovery from the latest failed generation in a vacant expert slot', async () => {
    const { ctx, lead, fiber, replaceExpert } = await setup()
    await activateParallel(ctx, lead)
    await fiber.dispose()

    let run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('parallel-attempt-1'),
      failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'original failed', retryable: true, details: {} },
    })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('parallel-member-1-replacement-1'),
      sessionId: SessionId('parallel-expert-one-replacement-1'),
      attemptId: ProvisionAttemptId('parallel-attempt-1-replacement-1'),
      name: 'expert-one-replacement-1',
      role: 'Execute parallel responsibility 1',
      protocolSlotId: TeamProtocolSlotId('parallel-slot-one'),
    })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.succeedExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('parallel-attempt-1-replacement-1'),
    })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('parallel-attempt-1-replacement-1'),
      failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'replacement failed', retryable: true, details: {} },
    })
    replaceExpert.mockClear()

    await ctx.plugin(ToolAgentTeam)

    await vi.waitFor(() => { expect(replaceExpert).toHaveBeenCalledOnce() })
    expect(replaceExpert.mock.calls[0]?.[1]).toEqual({
      requestId: 'tool-agent-team-request',
      failedMemberId: TeamMemberId('parallel-member-1-replacement-1'),
    })
  })

  it('starts every explicitly parallel task before either inbox admission settles and joins once', async () => {
    const { ctx, lead, followup, setPlan } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    let leadStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    const expertStatuses: Agent['status'][] = ['running', 'running']
    for (const [index, expert] of experts.slice(0, 2).entries()) {
      Object.defineProperty(expert, 'status', { configurable: true, get: () => expertStatuses[index] })
    }
    const admissions: Array<() => void> = []
    followup.mockImplementation(() => new Promise((resolve) => {
      admissions.push(() => { resolve(MessageId(`parallel-admission-${String(admissions.length)}`)) })
    }))
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})

    const dispatched = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'Both independent findings are ready',
          next_action: 'Produce the first finding',
          selection_reason: 'expert-one owns the first parallel task',
          content: 'Execute the first independent task',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'Both independent findings are ready',
          next_action: 'Produce the second finding',
          selection_reason: 'expert-two owns the second parallel task',
          content: 'Execute the second independent task',
        },
      ],
    })
    expect(dispatched.isError).toBe(false)
    expect(dispatched.concludesTurn).toBe(true)
    expect(JSON.parse(text(dispatched))).toMatchObject({
      stageId: 'stage-1',
      messages: [
        { targets: ['expert-one'], references: { taskId: tasks[0]!.id } },
        { targets: ['expert-two'], references: { taskId: tasks[1]!.id } },
      ],
    })
    expect(followup).not.toHaveBeenCalled()

    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
    expect(admissions).toHaveLength(2)
    admissions[0]?.()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    const firstReturn = await execute(ctx, experts[0]!, 'collaboration_followup', {
      kind: 'handoff', target: 'lead', task_id: tasks[0]!.id,
      context_summary: 'The first parallel task is complete',
      next_action: 'Join the first result with the parallel stage',
      selection_reason: 'The Lead owns the parallel join',
      content: 'First parallel result',
    })
    expect(firstReturn.isError).toBe(false)
    expertStatuses[0] = 'idle'
    ctx.emit('agent/status', { agent: experts[0]!, status: 'idle' })
    await Promise.resolve()
    expect(leadWake).not.toHaveBeenCalled()

    admissions[1]?.()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    const secondReturn = await execute(ctx, experts[1]!, 'collaboration_followup', {
      kind: 'handoff', target: 'lead', task_id: tasks[1]!.id,
      context_summary: 'The second parallel task is complete',
      next_action: 'Join the second result with the parallel stage',
      selection_reason: 'The Lead owns the parallel join',
      content: 'Second parallel result',
    })
    expect(secondReturn.isError).toBe(false)
    expertStatuses[1] = 'idle'
    ctx.emit('agent/status', { agent: experts[1]!, status: 'idle' })
    await vi.waitFor(() => { expect(leadWake).toHaveBeenCalledOnce() })
    const joined = leadWake.mock.calls[0]?.[0].content[0]
    expect(joined?.type).toBe('text')
    if (joined?.type !== 'text') throw new Error('parallel join must wake the Lead with text')
    expect(joined.text).toContain('First parallel result')
    expect(joined.text).toContain('Second parallel result')
  })

  it('rejects parallel dispatch for a Charter stage that is explicitly serial', async () => {
    const { ctx, lead, followup, setPlan } = await setup()
    const { tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'serial-work-one', blockedBy: [] },
        { id: 'serial-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'serial',
        workstreamIds: ['serial-work-one', 'serial-work-two'],
      }],
    })
    const before = ctx.teamRuns.getRun(lead)
    const rejected = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'The stage is serial', next_action: 'Must not run',
          selection_reason: 'The request is intentionally invalid', content: 'Do not dispatch',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'The stage is serial', next_action: 'Must not run',
          selection_reason: 'The request is intentionally invalid', content: 'Do not dispatch',
        },
      ],
    })
    expect(rejected.isError).toBe(true)
    if (rejected.isError) expect(rejected.error.info?.code).toBe('TEAM_INVALID_ARGUMENT')
    expect(ctx.teamRuns.getRun(lead)).toEqual(before)
    expect(followup).not.toHaveBeenCalled()
  })

  it('refuses to serialize one task when its explicit parallel stage has multiple ready owners', async () => {
    const { ctx, lead, followup, setPlan } = await setup()
    const { tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    const rejected = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task', target: 'expert-one', task_id: tasks[0]!.id,
      context_summary: 'Two tasks are ready in the parallel stage',
      next_action: 'Attempt one serial dispatch',
      selection_reason: 'expert-one owns this task',
      content: 'This must use the parallel batch tool',
    })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('collaboration_parallel_followup')
    expect(ctx.teamRuns.getRun(lead).messages).toHaveLength(0)
    expect(followup).not.toHaveBeenCalled()
  })

  it('joins successful parallel participants once and reports an initial inbox failure', async () => {
    const { ctx, lead, fiber, followup, setPlan } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    let leadStatus: Agent['status'] = 'running'
    let firstStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    Object.defineProperty(experts[0]!, 'status', { configurable: true, get: () => firstStatus })
    followup.mockImplementation((_lead, childId) => childId === experts[1]!.id
      ? Promise.reject(new Error('second inbox unavailable'))
      : Promise.resolve(MessageId('first-inbox-admitted')))
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})

    const dispatched = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'Two independent tasks are ready', next_action: 'Execute task one',
          selection_reason: 'expert-one owns task one', content: 'Run task one',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'Two independent tasks are ready', next_action: 'Execute task two',
          selection_reason: 'expert-two owns task two', content: 'Run task two',
        },
      ],
    })
    expect(dispatched.isError).toBe(false)
    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => {
      expect(ctx.teamRuns.getRun(lead).messages.at(-1)).toMatchObject({
        kind: 'status', targets: [], references: { taskId: tasks[1]!.id },
      })
    })
    expect(ctx.teamRuns.getRun(lead).messages.at(-1)?.content).toContain('expert-two: second inbox unavailable')
    await fiber.dispose()
    await ctx.plugin(ToolAgentTeam)

    const returned = await execute(ctx, experts[0]!, 'collaboration_followup', {
      kind: 'handoff', target: 'lead', task_id: tasks[0]!.id,
      context_summary: 'The admitted task is complete', next_action: 'Join the available result',
      selection_reason: 'The Lead owns the join', content: 'Successful parallel result',
    })
    expect(returned.isError).toBe(false)
    firstStatus = 'idle'
    ctx.emit('agent/status', { agent: experts[0]!, status: firstStatus })
    await vi.waitFor(() => { expect(leadWake).toHaveBeenCalledOnce() })
    const joined = leadWake.mock.calls[0]?.[0].content[0]
    expect(joined?.type).toBe('text')
    if (joined?.type !== 'text') throw new Error('partial parallel join must wake the Lead with text')
    expect(joined.text).toContain('Successful parallel result')
    expect(joined.text).toContain('expert-two: second inbox unavailable')
  })

  it('releases a failed parallel participant and returns control to the Lead for replacement', async () => {
    const { ctx, lead, followup, replaceExpert, setPlan } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    let leadStatus: Agent['status'] = 'running'
    let firstStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    Object.defineProperty(experts[0]!, 'status', { configurable: true, get: () => firstStatus })
    Object.defineProperty(experts[1]!, 'status', { configurable: true, get: () => 'running' })
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})

    const dispatched = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task one',
          selection_reason: 'expert-one owns task one', content: 'Run task one',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task two',
          selection_reason: 'expert-two owns task two', content: 'Run task two',
        },
      ],
    })
    expect(dispatched.isError).toBe(false)
    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })

    const returned = await execute(ctx, experts[0]!, 'collaboration_followup', {
      kind: 'handoff', target: 'lead', task_id: tasks[0]!.id,
      context_summary: 'Task one is complete', next_action: 'Join the available result',
      selection_reason: 'The Lead owns the join', content: 'Completed result from expert one',
    })
    expect(returned.isError).toBe(false)
    firstStatus = 'idle'
    ctx.emit('agent/status', { agent: experts[0]!, status: firstStatus })
    expect(leadWake).not.toHaveBeenCalled()

    const run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId: ProvisionAttemptId('parallel-attempt-2'),
      failure: {
        code: 'TEAM_CANCELLED',
        message: 'expert active execution deadline reached',
        retryable: true,
        details: {},
      },
    })

    await vi.waitFor(() => { expect(leadWake).toHaveBeenCalledOnce() })
    expect(replaceExpert).toHaveBeenCalledWith(
      lead,
      { requestId: 'tool-agent-team-request', failedMemberId: TeamMemberId('parallel-member-2') },
      expect.any(AbortSignal),
    )
    const joined = leadWake.mock.calls[0]?.[0].content[0]
    expect(joined?.type).toBe('text')
    if (joined?.type !== 'text') throw new Error('failed parallel join must wake the Lead with text')
    expect(joined.text).toContain('expert-two')
    expect(joined.text).toContain('collaboration_control')

    const controller = await execute(ctx, lead, 'collaboration_controller_get', {})
    expect(controller.isError).toBe(false)
  })

  it('reserves parallel-stage thread identities for the atomic parallel dispatcher', async () => {
    const { ctx, lead, followup } = await setup()
    await activateSimple(ctx, lead)
    const rejected = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'inform', target: 'expert-one', thread_id: 'parallel-stage/forged/thread',
      context_summary: 'Attempt to forge an internal batch thread', next_action: 'Must not run',
      selection_reason: 'The request is intentionally invalid', content: 'Do not dispatch',
    })
    expect(rejected.isError).toBe(true)
    if (rejected.isError) expect(rejected.error.info?.code).toBe('TEAM_INVALID_ARGUMENT')
    expect(ctx.teamRuns.getRun(lead).messages).toHaveLength(0)
    expect(followup).not.toHaveBeenCalled()
  })

  it('recovers a fully returned parallel batch after every expert Agent becomes cold', async () => {
    const { ctx, lead, fiber, followup, setPlan } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    let leadStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    for (const expert of experts.slice(0, 2)) {
      Object.defineProperty(expert, 'status', { configurable: true, get: () => 'running' })
    }
    const dispatched = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task one',
          selection_reason: 'expert-one owns task one', content: 'Run task one',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task two',
          selection_reason: 'expert-two owns task two', content: 'Run task two',
        },
      ],
    })
    expect(dispatched.isError).toBe(false)
    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    for (const [index, expert] of experts.slice(0, 2).entries()) {
      const returned = await execute(ctx, expert, 'collaboration_followup', {
        kind: 'handoff', target: 'lead', task_id: tasks[index]!.id,
        context_summary: `Parallel result ${String(index + 1)} is complete`,
        next_action: 'Join the recovered batch', selection_reason: 'The Lead owns the join',
        content: `Recovered result ${String(index + 1)}`,
      })
      expect(returned.isError).toBe(false)
    }
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})
    await fiber.dispose()
    const originalGet = ctx.agents.get.bind(ctx.agents)
    const coldIds = new Set(experts.map(expert => expert.id))
    const getAgent = vi.spyOn(ctx.agents, 'get').mockImplementation(id => (
      coldIds.has(id) ? undefined : originalGet(id)
    ))
    try {
      await ctx.plugin(ToolAgentTeam)
      ctx.emit('agent/status', { agent: lead, status: 'idle' })

      await vi.waitFor(() => { expect(leadWake).toHaveBeenCalledOnce() })
      const joined = leadWake.mock.calls[0]?.[0].content[0]
      expect(joined?.type).toBe('text')
      if (joined?.type !== 'text') throw new Error('recovered parallel join must wake the Lead with text')
      expect(joined.text).toContain('Recovered result 1')
      expect(joined.text).toContain('Recovered result 2')
    } finally {
      getAgent.mockRestore()
    }
  })

  it('redispatches only an unfinished parallel task when its expert Agent becomes cold', async () => {
    const { ctx, lead, fiber, followup, setPlan } = await setup()
    const { experts, tasks } = await activateParallel(ctx, lead)
    setPlan({
      taskDag: [
        { id: 'parallel-work-one', blockedBy: [] },
        { id: 'parallel-work-two', blockedBy: [] },
      ],
      stages: [{
        id: 'stage-1', order: 1, mode: 'parallel',
        workstreamIds: ['parallel-work-one', 'parallel-work-two'],
      }],
    })
    let leadStatus: Agent['status'] = 'running'
    Object.defineProperty(lead, 'status', { configurable: true, get: () => leadStatus })
    for (const expert of experts.slice(0, 2)) {
      Object.defineProperty(expert, 'status', { configurable: true, get: () => 'running' })
    }
    const dispatched = await execute(ctx, lead, 'collaboration_parallel_followup', {
      stage_id: 'stage-1',
      items: [
        {
          target: 'expert-one', task_id: tasks[0]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task one',
          selection_reason: 'expert-one owns task one', content: 'Run task one',
        },
        {
          target: 'expert-two', task_id: tasks[1]!.id,
          context_summary: 'Both tasks are ready', next_action: 'Execute task two',
          selection_reason: 'expert-two owns task two', content: 'Run task two',
        },
      ],
    })
    expect(dispatched.isError).toBe(false)
    leadStatus = 'idle'
    ctx.emit('agent/status', { agent: lead, status: leadStatus })
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(2) })

    const returned = await execute(ctx, experts[0]!, 'collaboration_followup', {
      kind: 'handoff', target: 'lead', task_id: tasks[0]!.id,
      context_summary: 'Task one is complete', next_action: 'Join after task two returns',
      selection_reason: 'The Lead owns the join', content: 'Durable result from expert one',
    })
    expect(returned.isError).toBe(false)
    await fiber.dispose()
    followup.mockClear()
    const originalGet = ctx.agents.get.bind(ctx.agents)
    const coldIds = new Set(experts.map(expert => expert.id))
    const getAgent = vi.spyOn(ctx.agents, 'get').mockImplementation(id => (
      coldIds.has(id) ? undefined : originalGet(id)
    ))
    try {
      await ctx.plugin(ToolAgentTeam)
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
      const recoveryCall = followup.mock.calls[0]
      expect(recoveryCall?.[0]).toBe(lead)
      expect(recoveryCall?.[1]).toBe(experts[1]!.id)
      expect(recoveryCall?.[3].signal).toBeInstanceOf(AbortSignal)
      const recoveryText = recoveryCall?.[2][0]?.text ?? ''
      expect(recoveryText).toContain('Run task two')
      expect(recoveryText).toContain('Parallel stage: stage-1')
      expect(recoveryText).not.toContain('Run task one')
    } finally {
      getAgent.mockRestore()
    }
  })

  it('rejects a planned downstream task until every earlier-stage blocker completes', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const blocker = await ctx.teamRuns.createTask(lead, {
      subject: 'Evidence', description: 'Complete the evidence stage',
    })
    const downstream = await ctx.teamRuns.createTask(lead, {
      subject: 'Synthesis', description: 'Wait for the evidence stage', blockedBy: [blocker.id],
    })
    const assignedBlocker = await ctx.teamRuns.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'assign', owner: 'expert-one',
    })
    const assignedDownstream = await ctx.teamRuns.updateTask(lead, {
      taskId: downstream.id, expectedRevision: downstream.revision, action: 'assign', owner: 'expert-one',
    })

    const rejected = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task', target: 'expert-one', task_id: assignedDownstream.id,
      context_summary: 'The synthesis is planned after evidence',
      next_action: 'Start synthesis before evidence is complete',
      selection_reason: 'The planned owner is expert-one',
      content: 'Attempt to skip the earlier stage',
    })
    expect(rejected.isError).toBe(true)
    if (rejected.isError) expect(rejected.error.info?.code).toBe('TEAM_TASK_BLOCKED')
    expect(ctx.teamRuns.getRun(lead).messages).toHaveLength(0)

    const accepted = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task', target: 'expert-one', task_id: assignedBlocker.id,
      context_summary: 'The evidence task is the first ready stage',
      next_action: 'Complete the evidence stage',
      selection_reason: 'expert-one is the preassigned owner',
      content: 'Execute the ready evidence task',
    })
    expect(accepted.isError).toBe(false)
  })

  it('lets only the Lead atomically deliver after task completion and public review', async () => {
    const { ctx, lead } = await setup()
    await activateSimple(ctx, lead)
    const { agent: expert } = await ctx.agents.create({
      sessionId: SessionId('tool-expert-one'),
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const created = await execute(ctx, lead, 'collaboration_task_create', {
      subject: 'Final result', description: 'Complete and review the result',
    })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const claimed = await ctx.teamRuns.updateTask(expert, {
      taskId: TeamTaskId(task.id), expectedRevision: task.revision, action: 'claim',
    })
    const reviewArtifact = await ctx.teamRuns.writeArtifact(expert, {
      expectedVersion: 0,
      kind: 'document',
      title: 'Final artifact',
      body: 'Final artifact body',
      mediaType: 'text/markdown',
      taskIds: [TeamTaskId(task.id)],
      status: 'review',
    })
    await expect(ctx.teamRuns.updateTask(expert, {
      taskId: TeamTaskId(task.id), expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await ctx.teamRuns.publishMessage(expert, {
      kind: 'handoff',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: TeamTaskId(task.id), artifactId: reviewArtifact.id },
      content: 'The assigned expert completed and routed the artifact.',
    })
    const artifactResult = await execute(ctx, lead, 'collaboration_artifact_write', {
      artifact_id: reviewArtifact.id,
      expected_version: reviewArtifact.version,
      kind: reviewArtifact.kind,
      title: reviewArtifact.title,
      body: reviewArtifact.body,
      media_type: reviewArtifact.mediaType,
      task_ids: reviewArtifact.taskIds,
      status: 'accepted',
    })
    const artifact = JSON.parse(text(artifactResult)) as { id: string }
    const readArtifact = await execute(ctx, lead, 'collaboration_artifact_read', { artifact_id: artifact.id })
    expect(JSON.parse(text(readArtifact))).toMatchObject({ id: artifact.id, body: 'Final artifact body' })
    const completedTask = await execute(ctx, lead, 'collaboration_task_update', {
      task_id: task.id,
      expected_revision: claimed.revision,
      action: 'complete',
    })
    expect(JSON.parse(text(completedTask))).toMatchObject({ status: 'completed' })
    await execute(ctx, lead, 'collaboration_quality_update', {
      gate_id: TeamQualityGateId('quality-gate-1'),
      expected_version: 1,
      status: 'passed',
      summary: 'Tool quality passed',
      task_id: task.id,
      artifact_id: artifact.id,
    })
    await ctx.teamRuns.publishMessage(lead, {
      kind: 'completion_request',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['expert-one'],
      references: { taskId: TeamTaskId(task.id), artifactId: TeamArtifactId(artifact.id) },
      content: 'Please complete',
    })
    await execute(ctx, lead, 'collaboration_decision_write', {
      expected_version: 0,
      subject: 'Accept delivery',
      outcome: 'accepted',
      summary: 'Delivery is accepted',
      rationale: 'Artifact and quality evidence are complete',
      task_ids: [task.id],
      artifact_ids: [artifact.id],
    })

    const rejected = await execute(ctx, lead, 'collaboration_complete', {
      task_id: task.id, artifact_id: artifact.id, content: 'Must wait for the expert',
    })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('later artifact-backed review')

    await ctx.teamRuns.publishMessage(expert, {
      kind: 'review',
      threadId: MAIN_TEAM_THREAD_ID,
      targets: ['lead'],
      references: { taskId: TeamTaskId(task.id), artifactId: TeamArtifactId(artifact.id) },
      content: 'Expert review confirms the result is ready',
    })
    const delivery = await execute(ctx, lead, 'collaboration_complete', {
      task_id: task.id, artifact_id: artifact.id, content: 'Final user delivery',
    })
    expect(delivery.isError).toBe(false)
    expect(JSON.parse(text(delivery))).toMatchObject({
      run: { phase: 'completed', status: 'completed' },
    })
    expect(ctx.teamRuns.getRun(lead).messages.at(-1)).toMatchObject({
      kind: 'final_delivery', content: 'Final user delivery',
    })
  })

  it('installs for a live active expert and revokes tools when that roster identity fails', async () => {
    const { ctx, lead, followup } = await setup()
    let run = await ctx.teamRuns.createRun(lead, {
      objective: 'Verify active expert scoped authority',
      complexity: 'simple',
      plannedExperts: 1,
    })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
    const expertSessionId = SessionId('scoped-expert-child')
    const attemptId = ProvisionAttemptId('scoped-expert-attempt')
    await ctx.teamRuns.beginExpertProvision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('scoped-expert-member'),
      sessionId: expertSessionId,
      attemptId,
      name: 'expert-one',
      role: 'Exercise the parent-session authority path',
    })
    const { agent: expert } = await ctx.agents.create({
      sessionId: expertSessionId,
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect((await assembly(ctx, expert)).tools.map(tool => tool.name).some(name => TOOL_NAMES.includes(name)))
      .toBe(false)

    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: run.revision, attemptId })
    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'active' })
    await vi.waitFor(async () => {
      const names = (await assembly(ctx, expert)).tools.map(tool => tool.name)
        .filter(name => TOOL_NAMES.includes(name)).sort()
      expect(names).toEqual(TOOL_NAMES)
    })
    expect(renderPrompt(await assembly(ctx, expert))).toContain('Your TeamRun role is expert; your public name is expert-one')
    const leadWake = vi.spyOn(lead, 'followup').mockImplementation(() => {})

    const task = await ctx.teamRuns.createTask(lead, {
      subject: 'Scoped collaboration authority', description: 'Verify the scoped collaboration authority',
    })
    const assigned = await ctx.teamRuns.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'assign', owner: 'expert-one',
    })
    const delegated = await execute(ctx, lead, 'collaboration_followup', {
      kind: 'task',
      target: 'expert-one',
      task_id: assigned.id,
      context_summary: 'The expert scope is active and ready for verification',
      next_action: 'Publish one verification result back to the Lead',
      selection_reason: 'expert-one owns the active verification responsibility',
      content: 'Verify the scoped collaboration authority',
    })
    expect(delegated.isError).toBe(false)
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })

    const sent = await execute(ctx, expert, 'collaboration_send', {
      kind: 'inform',
      targets: ['lead'],
      context_summary: 'The scoped collaboration tools are present and executable',
      next_action: 'Review the expert verification result',
      selection_reason: 'The Lead owns final verification and arbitration',
      content: 'Public expert result',
    })
    expect(JSON.parse(text(sent))).toMatchObject({ author: 'expert-one', kind: 'inform', visibility: 'public' })
    await vi.waitFor(() => { expect(leadWake).toHaveBeenCalledOnce() })
    const leadContent = leadWake.mock.calls[0]?.[0].content[0]
    expect(leadContent?.type).toBe('text')
    if (leadContent?.type !== 'text') throw new Error('Lead wake must carry one text handoff')
    expect(leadContent.text).toContain('Why Lead: The Lead owns final verification')

    const unrostered = (await ctx.agents.create({
      sessionId: SessionId('unrostered-child'),
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    expect((await assembly(ctx, unrostered)).tools.map(tool => tool.name).some(name => TOOL_NAMES.includes(name)))
      .toBe(false)
    expect(() => ctx.teamRuns.membership(unrostered)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    run = ctx.teamRuns.getRun(lead)
    await ctx.teamRuns.failExpertProvision(lead, {
      expectedRevision: run.revision,
      attemptId,
      failure: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'expert stopped during execution',
        retryable: true,
        details: { source: 'test' },
      },
    })
    await vi.waitFor(async () => {
      expect((await assembly(ctx, expert)).tools.map(tool => tool.name).some(name => TOOL_NAMES.includes(name)))
        .toBe(false)
    })
    expect(() => ctx.teamRuns.membership(expert)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
  })

  it('removes and reinstalls scoped registrations across HMR without mutating TeamRun state', async () => {
    const { ctx, lead, fiber } = await setup()
    await activateSimple(ctx, lead)
    const revision = ctx.teamRuns.getRun(lead).revision

    await fiber.dispose()
    expect((await assembly(ctx, lead)).tools.map(tool => tool.name).some(name => TOOL_NAMES.includes(name)))
      .toBe(false)
    expect(ctx.teamRuns.getRun(lead).revision).toBe(revision)

    const replacement = await ctx.plugin(ToolAgentTeam)
    expect((await assembly(ctx, lead)).tools.map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect(ctx.teamRuns.getRun(lead).revision).toBe(revision)
    await replacement.dispose()
  })
})
