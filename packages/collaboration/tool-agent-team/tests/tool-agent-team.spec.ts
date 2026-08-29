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
    expect(prompt).toContain('sequential collaboration baton')
    expect(prompt).toContain('exactly one best-suited recipient')
    expect(prompt).toContain('delivers the next turn only after the sender is idle')
    expect(prompt).toContain('same explicit dispute thread_id')
    expect(prompt).toContain('answer an open round before starting another')
    expect(prompt).toContain('Every active expert must finish an artifact')
    expect(prompt).toContain('never describe a review-state artifact as accepted or complete')
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
    await ctx.teamRuns.updateTask(expert, {
      taskId: TeamTaskId(task.id), expectedRevision: claimed.revision, action: 'complete',
    })
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
