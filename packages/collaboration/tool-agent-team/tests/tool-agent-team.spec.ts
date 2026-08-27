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
  'collaboration_quality_update',
  'collaboration_send',
  'collaboration_complete',
  'collaboration_task_create',
  'collaboration_task_get',
  'collaboration_task_list',
  'collaboration_task_update',
].sort()

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
}> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TeamRunService)
  const followup = expertFollowupMock()
  ctx.provide('expertRuntime', { followup } as never)
  const fiber = await ctx.plugin(ToolAgentTeam)
  const lead = ctx.agentLoop.create(SessionId(`tool-collaboration-lead-${crypto.randomUUID()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, lead, fiber, followup }
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
    expect(prompt).toContain('Every collaboration_send record is public')
    expect(prompt).toContain('same explicit dispute thread_id')
    expect(prompt).toContain('answer an open round before starting another')
    expect(prompt).toContain('Every active expert must publish at least one concise public')
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
        render: (_args, value) => [{ type: 'text', text: String(value) }],
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
    const content = `large-caller-owned-content-${'x'.repeat(4_096)}`
    const result = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      task_id: task.id,
      content,
    })
    expect(result.isError).toBe(false)
    const receipt = JSON.parse(text(result)) as Record<string, unknown>
    expect(receipt).toMatchObject({
      runId: run.id,
      threadId: MAIN_TEAM_THREAD_ID,
      kind: 'proposal',
      author: 'lead',
      targets: [],
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

    const normalizedBlanks = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      thread_id: '',
      targets: ['', '  '],
      task_id: '',
      challenge_id: '',
      decision_id: '',
      artifact_id: '',
      content: 'Blank optional model fields must be omitted',
    })
    expect(normalizedBlanks.isError).toBe(false)
    expect(JSON.parse(text(normalizedBlanks))).toMatchObject({
      threadId: MAIN_TEAM_THREAD_ID,
      kind: 'proposal',
      targets: [],
      references: {},
    })

    const delegated = await execute(ctx, lead, 'collaboration_followup', {
      target: 'expert-one',
      task_id: task.id,
      content: 'Review the proposal and publish your response',
    })
    expect(delegated.isError).toBe(false)
    expect(JSON.parse(text(delegated))).toMatchObject({
      kind: 'task',
      author: 'lead',
      targets: ['expert-one'],
      references: { taskId: task.id },
    })
    expect(followup).toHaveBeenCalledOnce()
    const call = followup.mock.calls[0]
    expect(call?.[0]).toBe(lead)
    expect(call?.[1]).toBe(SessionId('tool-expert-one'))
    expect(call?.[2][0]?.type).toBe('text')
    expect(call?.[2][0]?.text).toContain('Review the proposal')
    expect(call?.[3]).toEqual({ source: { kind: 'plugin', plugin: 'tool-agent-team' }, signal: SIGNAL })

    const forgedChallengeReference = await execute(ctx, lead, 'collaboration_send', {
      kind: 'proposal',
      challenge_id: 'challenge-one',
      content: 'proposal cannot forge a challenge relationship',
    })
    expect(forgedChallengeReference.isError).toBe(true)
    expect(text(forgedChallengeReference)).toContain('proposal cannot reference a challenge')

    const privateMessage = await execute(ctx, lead, 'collaboration_send', {
      kind: 'private_reasoning',
      content: 'must be rejected before the TeamRun service',
    })
    expect(privateMessage.isError).toBe(true)
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
    const claimed = await execute(ctx, lead, 'collaboration_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'claim',
    })
    const claimedTask = JSON.parse(text(claimed)) as { revision: number }
    await execute(ctx, lead, 'collaboration_task_update', {
      task_id: task.id, expected_revision: claimedTask.revision, action: 'complete',
    })
    const artifactResult = await execute(ctx, lead, 'collaboration_artifact_write', {
      expected_version: 0,
      kind: 'document',
      title: 'Final artifact',
      body: 'Final artifact body',
      media_type: 'text/markdown',
      task_ids: [task.id],
      status: 'accepted',
    })
    const artifact = JSON.parse(text(artifactResult)) as { id: string }
    const readArtifact = await execute(ctx, lead, 'collaboration_artifact_read', { artifact_id: artifact.id })
    expect(JSON.parse(text(readArtifact))).toMatchObject({ id: artifact.id, body: 'Final artifact body' })
    await execute(ctx, lead, 'collaboration_quality_update', {
      gate_id: TeamQualityGateId('quality-gate-1'),
      expected_version: 1,
      status: 'passed',
      summary: 'Tool quality passed',
      task_id: task.id,
      artifact_id: artifact.id,
    })
    await execute(ctx, lead, 'collaboration_send', {
      kind: 'completion_request', task_id: task.id, artifact_id: artifact.id, content: 'Please complete',
    })
    await execute(ctx, lead, 'collaboration_send', {
      kind: 'review', task_id: task.id, artifact_id: artifact.id, content: 'Reviewed and accepted',
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
    expect(text(rejected)).toContain('every active expert requires a public contribution')

    await ctx.teamRuns.publishMessage(expert, {
      kind: 'review',
      threadId: MAIN_TEAM_THREAD_ID,
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
    const { ctx, lead } = await setup()
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

    const sent = await execute(ctx, expert, 'collaboration_send', {
      kind: 'inform',
      content: 'Public expert result',
    })
    expect(JSON.parse(text(sent))).toMatchObject({ author: 'expert-one', kind: 'inform', visibility: 'public' })

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
