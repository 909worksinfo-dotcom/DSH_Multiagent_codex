/** Scoped model-facing tools over the single authoritative `ctx.teamRuns` service. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MAIN_TEAM_THREAD_ID,
  TeamArtifactId,
  TeamChallengeId,
  TeamDecisionId,
  TeamQualityGateId,
  TeamRunError,
  TeamTaskId,
  TeamThreadId,
  isTeamRunEvent,
} from '@deepseek-ai/dsh-agent-team'
import type {
  PublicCollaborationMessage,
  PublicCollaborationMessageKind,
  TeamActorRef,
  TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  MESSAGE_VALUE_SCHEMA,
  ARTIFACT_VALUE_SCHEMA,
  CONTROLLER_VALUE_SCHEMA,
  COLLABORATION_SEND_KINDS,
  DECISION_VALUE_SCHEMA,
  QUALITY_GATE_VALUE_SCHEMA,
  RUN_VALUE_SCHEMA,
  TASK_LIST_VALUE_SCHEMA,
  TEAM_TASK_ACTIONS,
  TEAM_ARTIFACT_KINDS,
  TEAM_ARTIFACT_STATUSES,
  TEAM_DECISION_OUTCOMES,
  TASK_VALUE_SCHEMA,
} from './schemas.ts'
import {
  artifactValue,
  decisionValue,
  messageValue,
  qualityGateValue,
  runValue,
  taskValue,
} from './values.ts'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the stable TeamRun model adapter. */
export const inject = ['agents', 'expertRuntime', 'teamRuns', 'tools', 'systemPrompt']

/** This thin adapter has no deployment tunables. */
export type Config = Record<never, never>

interface ExpertFollowupService {
  followup(
    lead: Agent,
    childId: Agent['id'],
    content: Array<{ type: 'text'; text: string }>,
    options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
  ): Promise<unknown>
}

/** Loader schema for the stable TeamRun model adapter. */
export const Config: z<Config> = z.object({})

const POLICY = `This session belongs to an explicit TeamRun governed by a sequential collaboration baton. The Lead owns the first turn. Only the current baton holder may execute work. Before every routed message, call collaboration_get and read the current task again, review the relevant public context, decide exactly one next action, compare the protocol-allowed recipients, and select exactly one best-suited recipient. Supply a concise user-safe context_summary, next_action, and selection_reason; never expose private chain-of-thought. collaboration_followup publishes exactly one public message, ends the sender's turn, and delivers the next turn only after the sender is idle. The recipient then owns the baton and must repeat the same context-review and next-step planning cycle. collaboration_send follows the same serial routing contract for compatibility.

Every public collaboration record must use the same dominant language as the user's TeamRun objective. The Lead coordinates through collaboration tools only; experts execute their assigned responsibilities with their mounted skills and plugins and may challenge, respond, review, or request help only when the protocol projection permits it. The Lead must not use Bash, web search, skill loading, or other everyday-session tools to perform expert work. Team Charter tasks are already materialized and must not be duplicated with collaboration_task_create. An expert task may be marked complete only after its owner has written a reviewable artifact covering that task. Every active expert must finish an artifact, route an artifact-linked handoff or review to the Lead, and have that artifact explicitly accepted before final delivery; a comment or direct assistant response is not a completed contribution. The Lead must read each submitted artifact, accept it before recording an accepted decision or passing a linked quality gate, and never describe a review-state artifact as accepted or complete. The Lead must explicitly delegate work, wait for each expert's artifact-backed return, resolve open challenges, accept owner-authored artifacts that cover every task, pass every quality gate, record an accepted artifact-linked decision for every task, publish one completion request to exactly one expert referencing that expert's accepted artifact, wait for that same expert's later review referencing the same task_id and artifact_id, and call collaboration_complete before returning the unified final response.

Every routed record is public to the user. A challenge and its response require the same explicit dispute thread_id, one explicit target, and the same challenge_id; answer an open round before starting another in that thread. Ordinary messages must omit challenge_id, may omit thread_id, and use main. Publish only concise task-relevant conclusions, evidence, questions, decisions, and handoffs. Never publish private reasoning or chain-of-thought. Re-read the latest task immediately before every compare-and-set update and use its current revision. If a collaboration tool reports stale state or a protocol error, refresh and correct the call instead of bypassing public collaboration. resource_scopes are advisory ownership labels, not locks or permission grants. Formation and expert activation belong to the runtime controller and are not model tools.`

/**
 * Declare compact canonical JSON output rendered verbatim for the model.
 * @param schema - canonical value schema.
 * @returns output declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  const render = (_args: unknown, value: InferValue<S>): [{ type: 'text'; text: string }] => [
    { type: 'text', text: JSON.stringify(value) },
  ]
  return { schema, render }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  const caller = agent
  if (caller === undefined) throw new Error(`scoped ${toolName} call has no Agent authority`)
  return caller
}

/** Treat blank optional model strings as omitted at the untrusted tool boundary. */
function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === '' ? undefined : normalized
}

/** Remove blank optional model strings and omit an empty resulting list. */
function optionalTexts(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const normalized = values.map(value => value.trim()).filter(value => value !== '')
  return normalized.length === 0 ? undefined : normalized
}

/** One user-safe routed message plus the planning facts required before dispatch. */
interface SequentialRouteRequest {
  readonly kind: PublicCollaborationMessageKind
  readonly target: string
  readonly threadId?: string
  readonly taskId?: string
  readonly challengeId?: string
  readonly decisionId?: string
  readonly artifactId?: string
  readonly contextSummary: string
  readonly nextAction: string
  readonly selectionReason: string
  readonly content: string
}

/** One accepted public handoff waiting for the sender's current turn to settle. */
interface PendingSequentialDispatch {
  readonly token: symbol
  readonly sender: Agent
  readonly lead: Agent
  readonly target: TeamActorRef
  readonly publicMessage: PublicCollaborationMessage
  readonly deliveryText: string
}

interface SequentialRunState {
  ownerId: Agent['id']
  reservation: symbol | undefined
  pending: PendingSequentialDispatch | undefined
  delivering: boolean
}

/** Validate a required planning field without requesting or retaining private reasoning. */
function planningText(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') {
    throw new TeamRunError(`${field} must be non-blank`, 'TEAM_INVALID_ARGUMENT')
  }
  if (Buffer.byteLength(normalized, 'utf8') > 4_096) {
    throw new TeamRunError(`${field} exceeds 4096 UTF-8 bytes`, 'TEAM_INVALID_ARGUMENT')
  }
  return normalized
}

/** Resolve a member's stable Session identity. */
function actorSessionId(actor: TeamActorRef): Agent['id'] {
  return actor.sessionId
}

/** Recognize both current structured routes and marker-prefixed legacy routes during live recovery. */
function isSequentialRouteContent(content: string): boolean {
  return content.startsWith('上下文摘要：')
    || content.startsWith('Context summary:')
    || content.includes('\n上下文摘要：')
    || content.includes('\nContext summary:')
}

/**
 * Process-local scheduler for the durable sequential-handoff protocol.
 * Public messages remain the durable audit; this scheduler owns only live turn admission and delayed inbox delivery.
 */
class SequentialCollaborationRouter {
  private readonly states = new Map<Agent['id'], SequentialRunState>()
  private readonly lifecycle = new AbortController()

  constructor(private readonly ctx: Context) {}

  /** Stop deferred deliveries during plugin disposal. */
  dispose(): void {
    this.lifecycle.abort(new Error('sequential collaboration router disposed'))
    this.states.clear()
  }

  /** Return a localized denial while an agent does not own the current collaboration baton. */
  denial(agent: Agent): string | undefined {
    const membership = this.ctx.teamRuns.tryMembership(agent)
    if (membership === undefined) return undefined
    const run = this.ctx.teamRuns.getRun(agent)
    if (run.phase !== 'active' && run.phase !== 'completing') {
      if (membership.actor.role === 'lead') return undefined
      return /\p{Script=Han}/u.test(run.objective)
        ? '团队尚在组建，专家请等待主协调智能体的唯一定向交接'
        : 'Team formation is still in progress; wait for one targeted handoff from the Lead'
    }
    const state = this.stateFor(run)
    if (state.ownerId === agent.id && state.reservation === undefined && state.pending === undefined) return undefined
    return /\p{Script=Han}/u.test(run.objective)
      ? '当前执行权属于另一位成员，请等待定向交接；不得并行执行或连续发送第二条消息'
      : 'Another member owns the collaboration baton; wait for a targeted handoff and do not execute in parallel or send a second message'
  }

  /** Publish one message now, then defer its actual recipient wake-up until the sender becomes idle. */
  async route(caller: Agent, request: SequentialRouteRequest): Promise<PublicCollaborationMessage> {
    const run = this.ctx.teamRuns.getRun(caller)
    if (run.phase !== 'active') {
      throw new TeamRunError(`sequential routing requires an active TeamRun; current phase is ${run.phase}`, 'TEAM_INVALID_TRANSITION')
    }
    const lead = this.ctx.agents.get(run.lead.sessionId)
    if (lead === undefined) throw new TeamRunError('TeamRun Lead is unavailable', 'TEAM_MEMBER_NOT_FOUND')
    const targetName = request.target.trim()
    const target: TeamActorRef | undefined = targetName === 'lead'
      ? run.lead
      : run.members.find(member => member.phase === 'active' && member.name === targetName) === undefined
        ? undefined
        : (() => {
          const member = run.members.find(candidate => candidate.phase === 'active' && candidate.name === targetName)
          return member === undefined ? undefined : {
            role: 'expert' as const,
            memberId: member.id,
            sessionId: member.sessionId,
            name: member.name,
          }
        })()
    if (target === undefined) {
      throw new TeamRunError(`active recipient "${targetName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    }
    if (actorSessionId(target) === caller.id) {
      throw new TeamRunError('sequential routing cannot target the sender', 'TEAM_PROTOCOL_TARGET_DENIED')
    }
    const state = this.stateFor(run)
    if (state.ownerId !== caller.id || state.reservation !== undefined || state.pending !== undefined) {
      throw new TeamRunError('the caller does not own an available sequential collaboration turn', 'RESOURCE_CONFLICT', {
        retryable: true,
        details: { ownerSessionId: String(state.ownerId), callerSessionId: String(caller.id) },
      })
    }

    const contextSummary = planningText(request.contextSummary, 'context_summary')
    const nextAction = planningText(request.nextAction, 'next_action')
    const selectionReason = planningText(request.selectionReason, 'selection_reason')
    const content = planningText(request.content, 'content')
    const chinese = /\p{Script=Han}/u.test(run.objective)
    const targetLabel = target.role === 'lead' ? (chinese ? '主协调智能体' : 'Lead') : target.name
    const publicContent = chinese
      ? `上下文摘要：${contextSummary}\n下一步：${nextAction}\n选择${targetLabel}：${selectionReason}\n消息：${content}`
      : `Context summary: ${contextSummary}\nNext action: ${nextAction}\nWhy ${targetLabel}: ${selectionReason}\nMessage: ${content}`
    const threadId = optionalText(request.threadId)
    const taskId = optionalText(request.taskId)
    const challengeId = optionalText(request.challengeId)
    const decisionId = optionalText(request.decisionId)
    const artifactId = optionalText(request.artifactId)
    if ((request.kind === 'challenge' || request.kind === 'response')
      && (threadId === undefined || challengeId === undefined)) {
      throw new TeamRunError(
        'challenge and response require one explicit dispute thread, challenge id, and target',
        'TEAM_CHALLENGE_INVALID',
      )
    }
    if (request.kind === 'task') {
      if (taskId === undefined) {
        throw new TeamRunError('task routing requires the exact planned task_id', 'TEAM_INVALID_ARGUMENT')
      }
      const task = this.ctx.teamRuns.getTask(caller, TeamTaskId(taskId))
      if (!task.ready) {
        throw new TeamRunError(`planned task "${task.id}" is blocked by an earlier stage`, 'TEAM_TASK_BLOCKED')
      }
      if (task.status !== 'pending' && task.status !== 'in_progress') {
        throw new TeamRunError(`planned task "${task.id}" is not executable`, 'TEAM_TASK_INVALID_TRANSITION')
      }
      if (task.owner === undefined || task.owner.role !== 'expert'
        || task.owner.sessionId !== target.sessionId || target.role !== 'expert') {
        throw new TeamRunError(
          `planned task "${task.id}" must be routed to its assigned expert`,
          'TEAM_TASK_UNAUTHORIZED',
        )
      }
    }
    const references = {
      ...taskId === undefined ? {} : { taskId: TeamTaskId(taskId) },
      ...challengeId === undefined ? {} : { challengeId: TeamChallengeId(challengeId) },
      ...decisionId === undefined ? {} : { decisionId: TeamDecisionId(decisionId) },
      ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
    }
    const token = Symbol(`sequential-route:${String(caller.id)}`)
    state.reservation = token
    try {
      const message = await this.ctx.teamRuns.publishMessage(caller, {
        kind: request.kind,
        threadId: threadId === undefined ? MAIN_TEAM_THREAD_ID : TeamThreadId(threadId),
        targets: [target.name],
        ...Object.keys(references).length === 0 ? {} : { references },
        content: publicContent,
      })
      const task = taskId === undefined ? undefined : this.ctx.teamRuns.getTask(caller, TeamTaskId(taskId))
      const deliveryText = chinese
        ? `${publicContent}\n${task === undefined ? '' : `\n当前任务：${task.subject}\n任务说明：${task.description}\n`}你现在持有唯一执行权。请先刷新 collaboration_get 和当前任务，只执行上述下一步。本轮结束前，必须再次评估上下文并通过 collaboration_followup 向唯一最合适的下一位成员交接。`
        : `${publicContent}\n${task === undefined ? '' : `\nCurrent task: ${task.subject}\nTask description: ${task.description}\n`}You now hold the only execution baton. Refresh collaboration_get and the current task, then execute only the stated next action. Before this turn ends, reassess the context and use collaboration_followup to hand off to exactly one best-suited next member.`
      state.pending = { token, sender: caller, lead, target, publicMessage: message, deliveryText }
      state.reservation = undefined
      if (caller.status === 'idle') queueMicrotask(() => { this.onIdle(caller) })
      return message
    } catch (error: unknown) {
      if (state.reservation === token) state.reservation = undefined
      if (state.pending?.token === token) state.pending = undefined
      throw error
    }
  }

  /** Start one deferred delivery only after the exact sender entered idle. */
  onIdle(agent: Agent): void {
    const state = this.states.get(this.runIdFor(agent))
    const pending = state?.pending
    if (state === undefined || pending === undefined || pending.sender !== agent || state.delivering) return
    state.delivering = true
    void this.deliver(state, pending)
  }

  private async deliver(state: SequentialRunState, pending: PendingSequentialDispatch): Promise<void> {
    const expertRuntime = this.ctx.get('expertRuntime') as ExpertFollowupService | undefined
    try {
      this.lifecycle.signal.throwIfAborted()
      if (expertRuntime === undefined) {
        throw new TeamRunError('expert runtime is unavailable', 'CAPABILITY_UNAVAILABLE')
      }
      if (pending.target.role === 'lead') {
        if (pending.sender.id === pending.lead.id) {
          throw new TeamRunError('the Lead cannot route a turn to itself', 'TEAM_PROTOCOL_TARGET_DENIED')
        }
        pending.lead.followup(createUserMessage({
          content: [{ type: 'text', text: pending.deliveryText }],
          source: { kind: 'plugin', plugin: name },
        }))
      } else {
        await expertRuntime.followup(
          pending.lead,
          pending.target.sessionId,
          [{ type: 'text', text: pending.deliveryText }],
          { source: { kind: 'plugin', plugin: name }, signal: this.lifecycle.signal },
        )
      }
      if (state.pending?.token !== pending.token) return
      state.ownerId = actorSessionId(pending.target)
      state.pending = undefined
      state.delivering = false
    } catch (error: unknown) {
      if (state.pending?.token !== pending.token) return
      state.ownerId = pending.sender.id
      state.pending = undefined
      state.delivering = false
      if (this.lifecycle.signal.aborted) return
      this.ctx.logger.error(`sequential collaboration delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      await this.recoverSender(pending, error)
    }
  }

  /** Wake the previous sender with a bounded recovery turn after asynchronous inbox admission fails. */
  private async recoverSender(pending: PendingSequentialDispatch, error: unknown): Promise<void> {
    const chinese = /\p{Script=Han}/u.test(this.ctx.teamRuns.getRun(pending.lead).objective)
    const failure = error instanceof Error ? error.message : String(error)
    const text = chinese
      ? `上一次串行交接未能投递：${failure}。执行权已退回给你，请刷新 collaboration_get 后重新选择唯一接收者。`
      : `The previous sequential handoff was not delivered: ${failure}. The baton returned to you; refresh collaboration_get and select exactly one recipient again.`
    try {
      if (pending.sender.id === pending.lead.id) {
        pending.lead.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name },
        }))
        return
      }
      const expertRuntime = this.ctx.get('expertRuntime') as ExpertFollowupService | undefined
      if (expertRuntime === undefined) return
      await expertRuntime.followup(
        pending.lead,
        pending.sender.id,
        [{ type: 'text', text }],
        { source: { kind: 'plugin', plugin: name }, signal: this.lifecycle.signal },
      )
    } catch (recoveryError: unknown) {
      this.ctx.logger.error(`sequential collaboration recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`)
    }
  }

  private stateFor(run: TeamRunSnapshot): SequentialRunState {
    const existing = this.states.get(run.lead.sessionId)
    if (existing !== undefined) return existing
    const lastRoute = run.messages.findLast(message =>
      message.targets.length === 1
      && isSequentialRouteContent(message.content))
    const ownerId = lastRoute?.targets[0] === undefined ? run.lead.sessionId : actorSessionId(lastRoute.targets[0])
    const created = { ownerId, reservation: undefined, pending: undefined, delivering: false }
    this.states.set(run.lead.sessionId, created)
    return created
  }

  private runIdFor(agent: Agent): Agent['id'] {
    const membership = this.ctx.teamRuns.tryMembership(agent)
    return membership === undefined ? agent.id : this.ctx.teamRuns.getRun(agent).lead.sessionId
  }
}

/** Register the complete collaboration adapter in one exact TeamRun member scope. */
function install(agent: Agent, ctx: Context, router: SequentialCollaborationRouter): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  const disposeAll = (): void => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      if (dispose !== undefined) void dispose()
    }
  }
  try {
    register(scoped.tools.guard((exec) => {
      const membership = ctx.teamRuns.membership(agent)
      const objective = ctx.teamRuns.getRun(agent).objective
      const chinese = /\p{Script=Han}/u.test(objective)
      const serialDenial = router.denial(agent)
      if (serialDenial !== undefined) return serialDenial
      if (membership.actor.role !== 'lead') return undefined
      if (exec.name === 'think') return undefined
      if (!exec.name.startsWith('collaboration_')) {
        return chinese
          ? 'Lead 只能使用 collaboration_* 工具协调团队；请把专业执行委派给已挂载技能和插件的专家'
          : 'The Lead may only coordinate with collaboration_* tools; delegate specialist execution to experts with mounted skills and plugins'
      }
      if (exec.name === 'collaboration_task_create'
        && agent.session.events.some(event => ['collaboration/orchestration/charter'].includes(event.type))) {
        return chinese
          ? 'Team Charter 已经创建权威任务列表；请委派或重规划现有任务，不要重复创建任务'
          : 'The Team Charter already created the authoritative task list; delegate or replan existing tasks instead of duplicating them'
      }
      return undefined
    }))

    register(scoped.systemPrompt.section({
      name: 'collaboration:policy',
      order: 60,
      text: () => {
        const membership = ctx.teamRuns.membership(agent)
        return `${POLICY}\n\nYour TeamRun role is ${membership.actor.role}; your public name is ${membership.actor.name}; TeamRun id is ${membership.runId}.`
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_get',
      description: 'Read the authoritative TeamRun lifecycle, plan count, roster attempts, capacity, and failure.',
      parameters: {},
      output: jsonOutput(RUN_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(runValue(ctx.teamRuns.getRun(callingAgent(exec.agent, 'collaboration_get'))))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_artifact_write',
      description: 'Write one bounded versioned artifact and publish only body-free metadata to the public timeline.',
      parameters: {
        artifact_id: { type: 'string', description: 'Existing artifact id for an update; omit to create.' },
        expected_version: { type: 'integer', required: true, description: 'Zero to create or the current version to update.' },
        kind: { type: 'string', required: true, enum: TEAM_ARTIFACT_KINDS },
        title: { type: 'string', required: true },
        body: { type: 'string', required: true, description: 'Complete artifact body; never included in collaboration_get.' },
        media_type: { type: 'string', required: true },
        task_ids: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', required: true, enum: TEAM_ARTIFACT_STATUSES },
      },
      output: jsonOutput(ARTIFACT_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const artifactId = optionalText(args.artifact_id)
        return artifactValue(await ctx.teamRuns.writeArtifact(
          callingAgent(exec.agent, 'collaboration_artifact_write'),
          {
            ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
            expectedVersion: args.expected_version,
            kind: args.kind,
            title: args.title,
            body: args.body,
            mediaType: args.media_type,
            ...args.task_ids === undefined ? {} : { taskIds: args.task_ids.map(TeamTaskId) },
            status: args.status,
          },
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_artifact_read',
      description: 'Read one complete artifact body through current TeamRun membership authority.',
      parameters: { artifact_id: { type: 'string', required: true } },
      output: jsonOutput(ARTIFACT_VALUE_SCHEMA),
      execute(args, exec) {
        return Promise.resolve(artifactValue(ctx.teamRuns.readArtifact(
          callingAgent(exec.agent, 'collaboration_artifact_read'),
          TeamArtifactId(args.artifact_id),
        )))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_decision_write',
      description: 'Lead-only arbitration. An accepted decision requires explicit tasks and already-accepted covering artifacts.',
      parameters: {
        decision_id: { type: 'string', description: 'Existing decision id for an update; omit to create.' },
        expected_version: { type: 'integer', required: true },
        subject: { type: 'string', required: true },
        outcome: { type: 'string', required: true, enum: TEAM_DECISION_OUTCOMES },
        summary: { type: 'string', required: true },
        rationale: { type: 'string', required: true, description: 'Concise user-safe rationale, never private reasoning.' },
        task_ids: { type: 'array', items: { type: 'string' } },
        artifact_ids: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput(DECISION_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const decisionId = optionalText(args.decision_id)
        return decisionValue(await ctx.teamRuns.writeDecision(
          callingAgent(exec.agent, 'collaboration_decision_write'),
          {
            ...decisionId === undefined ? {} : { decisionId: TeamDecisionId(decisionId) },
            expectedVersion: args.expected_version,
            subject: args.subject,
            outcome: args.outcome,
            summary: args.summary,
            rationale: args.rationale,
            ...args.task_ids === undefined ? {} : { taskIds: args.task_ids.map(TeamTaskId) },
            ...args.artifact_ids === undefined ? {} : { artifactIds: args.artifact_ids.map(TeamArtifactId) },
          },
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_quality_update',
      description: 'Lead-only formal quality result. Passing requires a completed task and an already-accepted covering artifact.',
      parameters: {
        gate_id: { type: 'string', required: true },
        expected_version: { type: 'integer', required: true },
        status: { type: 'string', required: true, enum: ['passed', 'failed'] },
        summary: { type: 'string', required: true },
        task_id: { type: 'string' },
        artifact_id: { type: 'string' },
      },
      output: jsonOutput(QUALITY_GATE_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const taskId = optionalText(args.task_id)
        const artifactId = optionalText(args.artifact_id)
        return qualityGateValue(await ctx.teamRuns.updateQualityGate(
          callingAgent(exec.agent, 'collaboration_quality_update'),
          {
            gateId: TeamQualityGateId(args.gate_id),
            expectedVersion: args.expected_version,
            status: args.status,
            summary: args.summary,
            ...taskId === undefined ? {} : { taskId: TeamTaskId(taskId) },
            ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
          },
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_controller_get',
      description: 'Read deterministic health, stalled tasks, duplicate work, quality failures, and recommended Lead actions.',
      parameters: {},
      output: jsonOutput(CONTROLLER_VALUE_SCHEMA),
      execute(_args, exec) {
        const controller = ctx.teamRuns.getRun(callingAgent(exec.agent, 'collaboration_controller_get')).controller
        return Promise.resolve({
          ...structuredClone(controller),
          stalledTaskIds: controller.stalledTaskIds.map(String),
          recommendedActions: [...controller.recommendedActions],
          actionsTaken: controller.actionsTaken.map(String),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_control',
      description: 'Lead-only atomic reassign, rework, or replan action with task CAS, decision ledger, and public evidence.',
      parameters: {
        expected_revision: { type: 'integer', required: true },
        task_id: { type: 'string', required: true },
        expected_task_revision: { type: 'integer', required: true },
        action: { type: 'string', required: true, enum: ['reassign', 'rework', 'replan'] },
        owner: { type: 'string' },
        description: { type: 'string' },
        rationale: { type: 'string', required: true, description: 'Concise user-safe correction rationale.' },
      },
      output: jsonOutput(RUN_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return runValue(await ctx.teamRuns.control(callingAgent(exec.agent, 'collaboration_control'), {
          expectedRevision: args.expected_revision,
          taskId: TeamTaskId(args.task_id),
          expectedTaskRevision: args.expected_task_revision,
          action: args.action,
          ...args.owner === undefined ? {} : { owner: args.owner },
          ...args.description === undefined ? {} : { description: args.description },
          rationale: args.rationale,
        }))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_send',
      description: 'Compatibility route for one planned public message to exactly one recipient; ends this turn and wakes the recipient only after sender idle.',
      parameters: {
        kind: { type: 'string', required: true, enum: COLLABORATION_SEND_KINDS, description: 'Public statement category; ledger receipts use their owning tools.' },
        thread_id: { type: 'string', description: 'Required explicit dispute thread for challenge/response; ordinary messages default to main.' },
        targets: { type: 'array', required: true, items: { type: 'string' }, description: 'Exactly one protocol-allowed recipient name or lead.' },
        task_id: { type: 'string', description: 'Required for task messages; must identify a ready task assigned to the one recipient.' },
        challenge_id: { type: 'string', description: 'Optional challenge reference.' },
        decision_id: { type: 'string', description: 'Optional decision reference.' },
        artifact_id: { type: 'string', description: 'Optional artifact reference.' },
        context_summary: { type: 'string', required: true, description: 'Concise user-safe summary of relevant public context; never private reasoning.' },
        next_action: { type: 'string', required: true, description: 'Exactly one action the recipient should execute next.' },
        selection_reason: { type: 'string', required: true, description: 'Concise user-safe reason this recipient is the best protocol-allowed fit.' },
        content: { type: 'string', required: true, description: 'Concise user-safe public content.' },
      },
      output: jsonOutput(MESSAGE_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const targets = optionalTexts(args.targets)
        if (targets?.length !== 1 || targets[0] === undefined) {
          throw new TeamRunError('collaboration_send requires exactly one explicit recipient', 'TEAM_PROTOCOL_TARGET_DENIED')
        }
        const message = await router.route(callingAgent(exec.agent, 'collaboration_send'), {
          kind: args.kind,
          target: targets[0],
          ...args.thread_id === undefined ? {} : { threadId: args.thread_id },
          ...args.task_id === undefined ? {} : { taskId: args.task_id },
          ...args.challenge_id === undefined ? {} : { challengeId: args.challenge_id },
          ...args.decision_id === undefined ? {} : { decisionId: args.decision_id },
          ...args.artifact_id === undefined ? {} : { artifactId: args.artifact_id },
          contextSummary: args.context_summary,
          nextAction: args.next_action,
          selectionReason: args.selection_reason,
          content: args.content,
        })
        exec.concludeTurn()
        return messageValue(message)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_followup',
      description: 'Route exactly one planned public message to the best next member; ends this turn and wakes the recipient only after sender idle.',
      parameters: {
        kind: { type: 'string', required: true, enum: COLLABORATION_SEND_KINDS, description: 'Public message category for this one routed turn.' },
        target: { type: 'string', required: true, description: 'Exact public name of one active expert, or lead when an expert returns the baton.' },
        thread_id: { type: 'string', description: 'Required explicit dispute thread for challenge/response; ordinary messages default to main.' },
        task_id: { type: 'string', description: 'Required for task messages; must identify a ready task assigned to the target expert.' },
        challenge_id: { type: 'string', description: 'Required only for challenge/response.' },
        decision_id: { type: 'string', description: 'Optional decision reference.' },
        artifact_id: { type: 'string', description: 'Optional artifact reference.' },
        context_summary: { type: 'string', required: true, description: 'Concise user-safe summary of relevant public context; never private reasoning.' },
        next_action: { type: 'string', required: true, description: 'Exactly one action the recipient should execute next.' },
        selection_reason: { type: 'string', required: true, description: 'Concise user-safe reason this recipient is the best protocol-allowed fit.' },
        content: { type: 'string', required: true, description: 'Concise user-safe public instruction or request.' },
      },
      output: jsonOutput(MESSAGE_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const message = await router.route(callingAgent(exec.agent, 'collaboration_followup'), {
          kind: args.kind,
          target: args.target,
          ...args.thread_id === undefined ? {} : { threadId: args.thread_id },
          ...args.task_id === undefined ? {} : { taskId: args.task_id },
          ...args.challenge_id === undefined ? {} : { challengeId: args.challenge_id },
          ...args.decision_id === undefined ? {} : { decisionId: args.decision_id },
          ...args.artifact_id === undefined ? {} : { artifactId: args.artifact_id },
          contextSummary: args.context_summary,
          nextAction: args.next_action,
          selectionReason: args.selection_reason,
          content: args.content,
        })
        exec.concludeTurn()
        return messageValue(message)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_complete',
      description: 'Lead-only atomic completion after every expert has an accepted routed artifact and the completion request receives its targeted artifact-backed review.',
      parameters: {
        thread_id: { type: 'string', description: 'Public delivery thread id. Defaults to main.' },
        task_id: { type: 'string', description: 'Optional completed task summarized by the delivery.' },
        decision_id: { type: 'string', description: 'Optional public decision summarized by the delivery.' },
        artifact_id: { type: 'string', description: 'Optional public artifact delivered to the user.' },
        content: { type: 'string', required: true, description: 'Complete user-safe final delivery.' },
      },
      output: jsonOutput(RUN_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const threadId = optionalText(args.thread_id)
        const taskId = optionalText(args.task_id)
        const decisionId = optionalText(args.decision_id)
        const artifactId = optionalText(args.artifact_id)
        const references = {
          ...taskId === undefined ? {} : { taskId: TeamTaskId(taskId) },
          ...decisionId === undefined ? {} : { decisionId: TeamDecisionId(decisionId) },
          ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
        }
        const run = await ctx.teamRuns.completeRun(callingAgent(exec.agent, 'collaboration_complete'), {
          threadId: threadId === undefined ? MAIN_TEAM_THREAD_ID : TeamThreadId(threadId),
          ...Object.keys(references).length === 0 ? {} : { references },
          content: args.content,
        })
        return runValue(run)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_task_create',
      description: 'Create one unowned pending task with dependencies and generic advisory resource scopes.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete objective and acceptance information.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing task ids that must complete first.' },
        resource_scopes: { type: 'array', items: { type: 'string' }, description: 'Generic advisory ownership prefixes.' },
      },
      output: jsonOutput(TASK_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const task = await ctx.teamRuns.createTask(callingAgent(exec.agent, 'collaboration_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.resource_scopes === undefined ? {} : { resourceScopes: args.resource_scopes },
        })
        return taskValue(task)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_task_list',
      description: 'List current TeamRun tasks with revisions, readiness, dependencies, ownership, and advisory conflicts.',
      parameters: {
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          throw new TeamRunError('cursor must be a non-negative safe integer', 'TEAM_INVALID_ARGUMENT')
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new TeamRunError('limit must be an integer from 1 through 100', 'TEAM_INVALID_ARGUMENT')
        }
        const tasks = ctx.teamRuns.listTasks(callingAgent(exec.agent, 'collaboration_task_list')).map(taskValue)
        return Promise.resolve({
          tasks: tasks.slice(cursor, cursor + limit),
          ...(cursor + limit < tasks.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_task_get',
      description: 'Read one complete latest TeamRun task value before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'TeamRun task id.' },
      },
      output: jsonOutput(TASK_VALUE_SCHEMA),
      execute(args, exec) {
        const task = ctx.teamRuns.getTask(
          callingAgent(exec.agent, 'collaboration_task_get'),
          TeamTaskId(args.task_id),
        )
        return Promise.resolve(taskValue(task))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_task_update',
      description: 'Compare-and-set one TeamRun task action using the latest task revision.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'TeamRun task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision.' },
        action: {
          type: 'string',
          required: true,
          enum: TEAM_TASK_ACTIONS,
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        resource_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory scopes for edit.' },
        owner: { type: 'string', description: 'Member name, lead, or empty for Lead-only reassign.' },
      },
      output: jsonOutput(TASK_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const blockedBy = args.blocked_by?.map(TeamTaskId)
        const task = await ctx.teamRuns.updateTask(callingAgent(exec.agent, 'collaboration_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.owner === undefined ? {} : { owner: args.owner },
          ...blockedBy === undefined ? {} : { blockedBy },
          ...args.resource_scopes === undefined ? {} : { resourceScopes: args.resource_scopes },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.subject === undefined ? {} : { subject: args.subject },
        })
        return taskValue(task)
      },
    })))
  } catch (error: unknown) {
    disposeAll()
    throw error
  }
  return disposeAll
}

/**
 * Install stable collaboration tools in every current and subsequently admitted TeamRun member scope.
 * @param ctx - Cordis context carrying the TeamRun service and scoped registries.
 * @param _config - empty adapter configuration reserved for Loader symmetry.
 */
export function apply(ctx: Context, _config: Config = {}): void {
  const router = new SequentialCollaborationRouter(ctx)
  const installed = new Map<Agent, () => void>()
  const reconcile = (agent: Agent): void => {
    if (ctx.teamRuns.tryMembership(agent) === undefined) {
      installed.get(agent)?.()
      installed.delete(agent)
      return
    }
    if (installed.has(agent)) return
    installed.set(agent, install(agent, ctx, router))
  }
  for (const agent of ctx.agents.list()) reconcile(agent)
  ctx.on('agent/created', ({ agent }) => { reconcile(agent) })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') router.onIdle(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on('session/event', (_session, event) => {
    if (!isTeamRunEvent(event)) return
    for (const agent of ctx.agents.list()) reconcile(agent)
  })
  ctx.effect(() => () => {
    router.dispose()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-agent-team.scopedTools()')
}
