/** Scoped model-facing tools over the single authoritative `ctx.teamRuns` service. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MAIN_TEAM_THREAD_ID,
  TeamArtifactId,
  TeamChallengeId,
  TeamDecisionId,
  TeamMemberId,
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
  PARALLEL_MESSAGE_BATCH_VALUE_SCHEMA,
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
export const inject = ['agents', 'expertRuntime', 'teamOrchestrator', 'teamRuns', 'tools', 'systemPrompt']

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

interface OrchestrationPlanReader {
  get(lead: Agent): {
    readonly requestId?: unknown
    readonly plan?: {
      readonly taskDag: readonly { readonly id: string; readonly blockedBy: readonly string[] }[]
      readonly stages?: readonly {
        readonly id: string
        readonly order: number
        readonly mode: 'serial' | 'parallel'
        readonly workstreamIds: readonly string[]
      }[]
    }
  }
  replaceExpert?(
    lead: Agent,
    request: { readonly requestId: never; readonly failedMemberId: ReturnType<typeof TeamMemberId> },
    signal: AbortSignal,
  ): Promise<unknown>
}

/** Loader schema for the stable TeamRun model adapter. */
export const Config: z<Config> = z.object({})

const POLICY = `This session belongs to an explicit TeamRun governed by its committed Team Charter stages. The Lead owns the first turn. Serial stages keep the existing single collaboration baton: before every route, call collaboration_get and read the current task again, review the relevant public context, decide exactly one next action, compare the protocol-allowed recipients, and select exactly one best-suited recipient. Supply concise user-safe context_summary, next_action, and selection_reason; never expose private chain-of-thought. collaboration_followup publishes exactly one public message, ends the sender's turn, and delivers the next turn only after the sender is idle. collaboration_send follows the same serial routing contract for compatibility. Only when the committed Charter marks a stage parallel, the Lead must call collaboration_parallel_followup once with at least two ready, preassigned tasks from that exact stage. Those expert inboxes start concurrently; each admitted expert executes only its own task and returns to the Lead with collaboration_followup and the exact task_id. The Lead remains blocked until the batch joins, then receives one combined wake-up. Never use the parallel tool for a serial stage or infer parallelism outside the committed stage.

Every public collaboration record must use the same dominant language as the user's TeamRun objective. The Lead coordinates through collaboration tools only; experts execute their assigned responsibilities with their mounted skills and plugins and may challenge, respond, review, or request help only when the protocol projection permits it. The Lead must not use Bash, web search, skill loading, or other everyday-session tools to perform expert work. Team Charter tasks are already materialized and must not be duplicated with collaboration_task_create. An expert must never mark an enforced task complete. Every active expert must finish an artifact and route an artifact-linked handoff or review containing the exact task_id and artifact_id to the Lead; a comment or direct assistant response is not a completed contribution. The Lead must read and accept that exact owner-authored artifact, then use collaboration_task_update to confirm the task as completed. Before both operations succeed, the task remains in progress and must never be described as accepted or complete. The Lead must explicitly delegate work, wait for each expert's artifact-backed return, resolve open challenges, accept owner-authored artifacts that cover every task, confirm every task completion, pass every quality gate, record an accepted artifact-linked decision for every task, publish one completion request to exactly one expert referencing that expert's accepted artifact, wait for that same expert's later review referencing the same task_id and artifact_id, and call collaboration_complete before returning the unified final response.

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

interface ParallelRouteItem {
  readonly target: string
  readonly taskId: string
  readonly contextSummary: string
  readonly nextAction: string
  readonly selectionReason: string
  readonly content: string
}

interface ParallelRouteRequest {
  readonly stageId: string
  readonly items: readonly ParallelRouteItem[]
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
  readonly mode: 'sequential'
  ownerId: Agent['id']
  reservation: symbol | undefined
  pending: PendingSequentialDispatch | undefined
  delivering: boolean
}

interface PendingParallelLaunch {
  readonly token: symbol
  readonly sender: Agent
  readonly lead: Agent
  readonly stageId: string
  readonly threadId: ReturnType<typeof TeamThreadId>
  readonly dispatches: readonly PendingSequentialDispatch[]
}

type ExpertActorRef = Extract<TeamActorRef, { readonly role: 'expert' }>

interface ParallelRunState {
  readonly mode: 'parallel'
  readonly lead: Agent
  readonly stageId: string
  readonly threadId: ReturnType<typeof TeamThreadId>
  readonly participants: ReadonlyMap<Agent['id'], ExpertActorRef>
  readonly participantOrder: readonly Agent['id'][]
  readonly taskIdsByParticipant: ReadonlyMap<Agent['id'], ReturnType<typeof TeamTaskId>>
  readonly activeParticipantIds: Set<Agent['id']>
  readonly returnReservations: Set<Agent['id']>
  readonly pendingReturns: Map<Agent['id'], PendingSequentialDispatch>
  readonly completedReturns: Map<Agent['id'], PendingSequentialDispatch>
  readonly deliveryFailures: string[]
  readonly recoveringParticipantIds: Set<Agent['id']>
  launch: PendingParallelLaunch | undefined
  deliveringLaunch: boolean
  launchSettled: boolean
}

type CollaborationRunState = SequentialRunState | ParallelRunState

interface ResolvedExecutionStage {
  readonly id: string
  readonly mode: 'serial' | 'parallel'
  readonly taskIds: readonly ReturnType<typeof TeamTaskId>[]
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

/** Identify the durable audit thread reserved for one explicit parallel batch. */
function isParallelStageThread(threadId: ReturnType<typeof TeamThreadId>): boolean {
  return String(threadId).startsWith('parallel-stage/')
}

const PARALLEL_FAILURE_PREFIX_ZH = '并行任务未启动：'
const PARALLEL_FAILURE_PREFIX_EN = 'Parallel task did not start: '

/** Recover one public parallel-admission failure detail without treating arbitrary messages as control state. */
function parallelFailureDetail(content: string): string | undefined {
  if (content.startsWith(PARALLEL_FAILURE_PREFIX_ZH)) return content.slice(PARALLEL_FAILURE_PREFIX_ZH.length)
  if (content.startsWith(PARALLEL_FAILURE_PREFIX_EN)) return content.slice(PARALLEL_FAILURE_PREFIX_EN.length)
  return undefined
}

/** Decode only thread ids emitted by this adapter while keeping malformed historical input non-fatal. */
function parallelStageId(threadId: ReturnType<typeof TeamThreadId>): string {
  const encoded = String(threadId).split('/')[1] ?? 'parallel'
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Rebuild the exact private execution permit from durable public launch state. */
function parallelDeliveryText(
  chinese: boolean,
  stageId: string,
  task: { readonly subject: string; readonly description: string },
  publicContent: string,
): string {
  return chinese
    ? `${publicContent}\n\n并行阶段：${stageId}\n当前任务：${task.subject}\n任务说明：${task.description}\n你持有本并行批次中该任务的独立执行权。完成任务并形成资产后，使用 collaboration_followup 携带相同 task_id 回交主协调智能体；并行汇合前不要转交其他成员。`
    : `${publicContent}\n\nParallel stage: ${stageId}\nCurrent task: ${task.subject}\nTask description: ${task.description}\nYou hold an independent execution permit for this task in the parallel batch. After completing the task and its artifact, use collaboration_followup with the same task_id to return to the Lead; do not hand off to another member before the join.`
}

/**
 * Process-local scheduler for the durable sequential-handoff protocol.
 * Public messages remain the durable audit; this scheduler owns only live turn admission and delayed inbox delivery.
 */
class CollaborationRouter {
  private readonly states = new Map<Agent['id'], CollaborationRunState>()
  private readonly teamRecoveryAttempts = new Set<string>()
  private readonly teamRecoveryResults = new Map<string, Promise<boolean>>()
  private readonly sequentialRecoveryNotifications = new Set<string>()
  private readonly lifecycle = new AbortController()

  constructor(private readonly ctx: Context) {}

  /** Stop deferred deliveries during plugin disposal. */
  dispose(): void {
    this.lifecycle.abort(new Error('collaboration router disposed'))
    this.states.clear()
  }

  /** Reconcile durable member failure with any live or recovered parallel barrier. */
  onRunChanged(lead: Agent): void {
    let run: TeamRunSnapshot
    try {
      run = this.ctx.teamRuns.getRun(lead)
      this.recoverVacantExpertSlots(lead, run)
      const state = this.stateFor(run)
      if (state.mode === 'parallel') {
        this.reconcileParallelFailures(state, run)
      } else {
        this.reconcileSequentialFailures(lead, state, run)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `collaboration recovery deferred until every durable member is live: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
  }

  /** Return a failed serial baton to the Lead after team-level recovery has begun. */
  private reconcileSequentialFailures(lead: Agent, state: SequentialRunState, run: TeamRunSnapshot): void {
    const failedOwner = run.members.find(member => member.sessionId === state.ownerId && member.phase === 'failed')
    if (failedOwner !== undefined) {
      state.ownerId = run.lead.sessionId
      state.reservation = undefined
      state.pending = undefined
    }
    for (const member of run.members) {
      if (member.phase !== 'failed' || member.protocolSlotId === undefined) continue
      const recoveryKey = `${String(run.id)}:${String(member.protocolSlotId)}`
      const recovery = this.teamRecoveryResults.get(recoveryKey)
      if (recovery === undefined || this.sequentialRecoveryNotifications.has(recoveryKey)) continue
      this.sequentialRecoveryNotifications.add(recoveryKey)
      void recovery.then((succeeded) => {
        if (this.lifecycle.signal.aborted) return
        const chinese = /\p{Script=Han}/u.test(run.objective)
        lead.followup(createUserMessage({
          content: [{
            type: 'text',
            text: succeeded
              ? chinese
                ? `团队运行时已为失效的 ${member.name} 完成同席位补位。请刷新 collaboration_get；若未完成任务仍指向旧成员，先用 collaboration_control 的 reassign 交给补位专家，再继续执行。不得把旧成员未完成的任务视为成功。`
                : `The runtime restored the vacant slot for ${member.name}. Refresh collaboration_get; if unfinished work still targets the failed member, reassign it to the replacement with collaboration_control before continuing. Never treat the failed member's unfinished task as successful.`
              : chinese
                ? `团队运行时未能补位失效的 ${member.name}。请保留失败状态并由用户重试，不得按完整团队继续交付。`
                : `The runtime could not restore the vacant slot for ${member.name}. Preserve the failure state and request a user retry; do not continue as a complete team.`,
          }],
          source: { kind: 'plugin', plugin: name },
        }))
      })
    }
  }

  /** Restore vacant protocol slots before route-state recovery, which may still await cold child Agents. */
  private recoverVacantExpertSlots(lead: Agent, run: TeamRunSnapshot): void {
    if (run.phase !== 'active') return
    const orchestrator = this.ctx.get('teamOrchestrator') as OrchestrationPlanReader | undefined
    const snapshot = orchestrator?.get(lead)
    if (snapshot?.requestId === undefined || orchestrator?.replaceExpert === undefined) return
    const activeSlots = new Set(run.members.flatMap(member =>
      member.phase === 'active' && member.protocolSlotId !== undefined ? [String(member.protocolSlotId)] : []))
    const latestFailedBySlot = new Map<string, TeamRunSnapshot['members'][number]>()
    for (const member of run.members) {
      if (member.phase !== 'failed' || member.protocolSlotId === undefined) continue
      const slotId = String(member.protocolSlotId)
      const previous = latestFailedBySlot.get(slotId)
      if (previous === undefined || member.attemptNumber > previous.attemptNumber) {
        latestFailedBySlot.set(slotId, member)
      }
    }
    for (const [slotId, member] of latestFailedBySlot) {
      if (activeSlots.has(slotId)) continue
      const recoveryKey = `${String(run.id)}:${slotId}`
      if (this.teamRecoveryAttempts.has(recoveryKey)) continue
      this.teamRecoveryAttempts.add(recoveryKey)
      const recovery = orchestrator.replaceExpert(lead, {
        requestId: snapshot.requestId as never,
        failedMemberId: member.id,
      }, this.lifecycle.signal).then(() => true).catch((error: unknown) => {
        this.ctx.logger.error(
          `collaboration expert replacement failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      })
      this.teamRecoveryResults.set(recoveryKey, recovery)
    }
  }

  /** Return a localized denial while an agent does not own a current serial or parallel execution permit. */
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
    if (state.mode === 'sequential') {
      if (state.ownerId === agent.id && state.reservation === undefined && state.pending === undefined) return undefined
    } else if (state.activeParticipantIds.has(agent.id)
      && !state.returnReservations.has(agent.id)
      && !state.pendingReturns.has(agent.id)) {
      return undefined
    }
    return /\p{Script=Han}/u.test(run.objective)
      ? state.mode === 'parallel'
        ? '当前处于并行阶段，只有本批次尚未回交的专家持有执行权；其他成员请等待并行汇合'
        : '当前执行权属于另一位成员，请等待定向交接；不得并行执行或连续发送第二条消息'
      : state.mode === 'parallel'
        ? 'A parallel stage is active; only unfinished experts in this batch may execute until the join completes'
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
    if (state.mode === 'parallel') {
      return this.routeParallelReturn(state, caller, lead, target, request)
    }
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
    if (threadId !== undefined && isParallelStageThread(TeamThreadId(threadId))) {
      throw new TeamRunError('parallel-stage threads are reserved for collaboration_parallel_followup', 'TEAM_INVALID_ARGUMENT')
    }
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
      const parallelStage = this.explicitParallelStageForTask(lead, task.id)
      if (parallelStage !== undefined) {
        const readyCount = parallelStage.taskIds.filter((candidateId) => {
          const candidate = this.ctx.teamRuns.getTask(caller, candidateId)
          return candidate.ready && candidate.status === 'pending'
        }).length
        if (readyCount >= 2) {
          throw new TeamRunError(
            `task "${task.id}" belongs to explicit parallel stage "${parallelStage.id}"; dispatch the ready batch with collaboration_parallel_followup`,
            'TEAM_INVALID_ARGUMENT',
          )
        }
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

  /** Publish and schedule one bounded wave from an explicitly parallel Charter stage. */
  async routeParallel(
    caller: Agent,
    request: ParallelRouteRequest,
  ): Promise<{ readonly stageId: string; readonly messages: PublicCollaborationMessage[] }> {
    const run = this.ctx.teamRuns.getRun(caller)
    if (run.phase !== 'active') {
      throw new TeamRunError(`parallel routing requires an active TeamRun; current phase is ${run.phase}`, 'TEAM_INVALID_TRANSITION')
    }
    if (caller.id !== run.lead.sessionId) {
      throw new TeamRunError('parallel stage dispatch requires the TeamRun Lead', 'TEAM_LEAD_REQUIRED')
    }
    const lead = this.ctx.agents.get(run.lead.sessionId)
    if (lead === undefined) throw new TeamRunError('TeamRun Lead is unavailable', 'TEAM_MEMBER_NOT_FOUND')
    const state = this.stateFor(run)
    if (state.mode !== 'sequential'
      || state.ownerId !== caller.id
      || state.reservation !== undefined
      || state.pending !== undefined) {
      throw new TeamRunError('parallel dispatch requires one available Lead turn', 'RESOURCE_CONFLICT', { retryable: true })
    }
    const stageId = planningText(request.stageId, 'stage_id')
    const stage = this.executionStage(lead, stageId)
    if (stage.mode !== 'parallel') {
      throw new TeamRunError(`execution stage "${stage.id}" is serial`, 'TEAM_INVALID_ARGUMENT')
    }
    if (request.items.length < 2 || request.items.length > run.plannedExperts) {
      throw new TeamRunError(
        `parallel dispatch requires 2 through ${String(run.plannedExperts)} task messages`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
    const stageTaskIds = new Set(stage.taskIds.map(String))
    const seenTasks = new Set<string>()
    const seenTargets = new Set<Agent['id']>()
    const threadId = TeamThreadId(`parallel-stage/${encodeURIComponent(stage.id)}/${randomUUID()}`)
    const prepared = request.items.map((item) => {
      const taskId = TeamTaskId(planningText(item.taskId, 'task_id'))
      if (!stageTaskIds.has(String(taskId))) {
        throw new TeamRunError(`task "${taskId}" does not belong to parallel stage "${stage.id}"`, 'TEAM_INVALID_ARGUMENT')
      }
      if (seenTasks.has(String(taskId))) {
        throw new TeamRunError(`parallel dispatch repeats task "${taskId}"`, 'TEAM_INVALID_ARGUMENT')
      }
      seenTasks.add(String(taskId))
      const task = this.ctx.teamRuns.getTask(caller, taskId)
      if (!task.ready || task.status !== 'pending') {
        throw new TeamRunError(`parallel task "${task.id}" is not ready`, 'TEAM_TASK_BLOCKED')
      }
      const target = this.activeTarget(run, item.target)
      if (target.role !== 'expert') {
        throw new TeamRunError('parallel stage tasks require expert recipients', 'TEAM_TASK_UNAUTHORIZED')
      }
      if (seenTargets.has(target.sessionId)) {
        throw new TeamRunError(`parallel dispatch repeats expert "${target.name}"`, 'TEAM_INVALID_ARGUMENT')
      }
      seenTargets.add(target.sessionId)
      if (task.owner?.role !== 'expert' || task.owner.sessionId !== target.sessionId) {
        throw new TeamRunError(
          `parallel task "${task.id}" must be routed to its assigned expert`,
          'TEAM_TASK_UNAUTHORIZED',
        )
      }
      const contextSummary = planningText(item.contextSummary, 'context_summary')
      const nextAction = planningText(item.nextAction, 'next_action')
      const selectionReason = planningText(item.selectionReason, 'selection_reason')
      const content = planningText(item.content, 'content')
      const chinese = /\p{Script=Han}/u.test(run.objective)
      const publicContent = chinese
        ? `上下文摘要：${contextSummary}\n下一步：${nextAction}\n选择${target.name}：${selectionReason}\n消息：${content}`
        : `Context summary: ${contextSummary}\nNext action: ${nextAction}\nWhy ${target.name}: ${selectionReason}\nMessage: ${content}`
      const deliveryText = parallelDeliveryText(chinese, stage.id, task, publicContent)
      return { target, task, publicContent, deliveryText }
    })
    const token = Symbol(`parallel-route:${String(caller.id)}`)
    state.reservation = token
    try {
      const messages = await this.ctx.teamRuns.publishMessages(caller, prepared.map(item => ({
        kind: 'task',
        threadId,
        targets: [item.target.name],
        references: { taskId: item.task.id },
        content: item.publicContent,
      })))
      const dispatches = messages.map((message, index): PendingSequentialDispatch => {
        const item = prepared[index]
        if (item === undefined) throw new Error('parallel dispatch preparation is incomplete')
        return { token, sender: caller, lead, target: item.target, publicMessage: message, deliveryText: item.deliveryText }
      })
      const participants = new Map<Agent['id'], ExpertActorRef>(dispatches.map((value) => {
        if (value.target.role !== 'expert') throw new Error('parallel dispatch target must be an expert')
        return [actorSessionId(value.target), value.target]
      }))
      const parallelState: ParallelRunState = {
        mode: 'parallel',
        lead,
        stageId: stage.id,
        threadId,
        participants,
        participantOrder: dispatches.map(value => actorSessionId(value.target)),
        taskIdsByParticipant: new Map(dispatches.map((value, index) => {
          const task = prepared[index]?.task
          if (task === undefined) throw new Error('parallel task preparation is incomplete')
          return [actorSessionId(value.target), task.id]
        })),
        activeParticipantIds: new Set(),
        returnReservations: new Set(),
        pendingReturns: new Map(),
        completedReturns: new Map(),
        deliveryFailures: [],
        recoveringParticipantIds: new Set(),
        launch: { token, sender: caller, lead, stageId: stage.id, threadId, dispatches },
        deliveringLaunch: false,
        launchSettled: false,
      }
      this.states.set(run.lead.sessionId, parallelState)
      if (caller.status === 'idle') queueMicrotask(() => { this.onIdle(caller) })
      return { stageId: stage.id, messages }
    } catch (error: unknown) {
      if (state.reservation === token) state.reservation = undefined
      throw error
    }
  }

  /** Accept one expert return into the active parallel join without waking the Lead early. */
  private async routeParallelReturn(
    state: ParallelRunState,
    caller: Agent,
    lead: Agent,
    target: TeamActorRef,
    request: SequentialRouteRequest,
  ): Promise<PublicCollaborationMessage> {
    if (!state.activeParticipantIds.has(caller.id)) {
      throw new TeamRunError('the caller does not own an active parallel execution permit', 'RESOURCE_CONFLICT', { retryable: true })
    }
    if (target.role !== 'lead' || target.sessionId !== lead.id) {
      throw new TeamRunError('parallel task results must return to the Lead before the join', 'TEAM_PROTOCOL_TARGET_DENIED')
    }
    if (state.returnReservations.has(caller.id) || state.pendingReturns.has(caller.id)
      || state.completedReturns.has(caller.id)) {
      throw new TeamRunError('parallel participant already returned its batch result', 'RESOURCE_CONFLICT', { retryable: true })
    }
    const taskId = optionalText(request.taskId)
    const decisionId = optionalText(request.decisionId)
    const artifactId = optionalText(request.artifactId)
    const expectedTaskId = state.taskIdsByParticipant.get(caller.id)
    if (taskId === undefined || expectedTaskId === undefined || taskId !== String(expectedTaskId)) {
      throw new TeamRunError('parallel return requires the exact dispatched task_id', 'TEAM_INVALID_ARGUMENT')
    }
    const challengeId = optionalText(request.challengeId)
    if ((request.kind === 'challenge' || request.kind === 'response') && challengeId === undefined) {
      throw new TeamRunError('challenge and response require one explicit challenge id', 'TEAM_CHALLENGE_INVALID')
    }
    const contextSummary = planningText(request.contextSummary, 'context_summary')
    const nextAction = planningText(request.nextAction, 'next_action')
    const selectionReason = planningText(request.selectionReason, 'selection_reason')
    const content = planningText(request.content, 'content')
    const run = this.ctx.teamRuns.getRun(caller)
    const chinese = /\p{Script=Han}/u.test(run.objective)
    const publicContent = chinese
      ? `上下文摘要：${contextSummary}\n下一步：${nextAction}\n选择主协调智能体：${selectionReason}\n消息：${content}`
      : `Context summary: ${contextSummary}\nNext action: ${nextAction}\nWhy Lead: ${selectionReason}\nMessage: ${content}`
    const references = {
      taskId: expectedTaskId,
      ...challengeId === undefined ? {} : { challengeId: TeamChallengeId(challengeId) },
      ...decisionId === undefined ? {} : { decisionId: TeamDecisionId(decisionId) },
      ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
    }
    state.returnReservations.add(caller.id)
    try {
      const message = await this.ctx.teamRuns.publishMessage(caller, {
        kind: request.kind,
        threadId: state.threadId,
        targets: ['lead'],
        references,
        content: publicContent,
      })
      state.pendingReturns.set(caller.id, {
        token: Symbol(`parallel-return:${String(caller.id)}`),
        sender: caller,
        lead,
        target,
        publicMessage: message,
        deliveryText: publicContent,
      })
      state.returnReservations.delete(caller.id)
      if (caller.status === 'idle') queueMicrotask(() => { this.onIdle(caller) })
      return message
    } catch (error: unknown) {
      state.returnReservations.delete(caller.id)
      throw error
    }
  }

  /** Start one deferred delivery only after the exact sender entered idle. */
  onIdle(agent: Agent): void {
    const membership = this.ctx.teamRuns.tryMembership(agent)
    if (membership === undefined) return
    const state = this.stateFor(this.ctx.teamRuns.getRun(agent))
    if (state.mode === 'parallel') {
      if (state.launch?.sender === agent && !state.deliveringLaunch) {
        state.deliveringLaunch = true
        void this.deliverParallelLaunch(state, state.launch)
        return
      }
      const pendingReturn = state.pendingReturns.get(agent.id)
      if (pendingReturn !== undefined) this.settleParallelReturn(state, pendingReturn)
      else if (state.launchSettled && state.activeParticipantIds.size === 0
        && state.recoveringParticipantIds.size === 0) this.finishParallel(state)
      return
    }
    const pending = state.pending
    if (pending === undefined || pending.sender !== agent || state.delivering) return
    state.delivering = true
    void this.deliver(state, pending)
  }

  /** Admit every expert inbox concurrently, then expose only successfully admitted execution permits. */
  private async deliverParallelLaunch(state: ParallelRunState, launch: PendingParallelLaunch): Promise<void> {
    const expertRuntime = this.ctx.get('expertRuntime') as ExpertFollowupService | undefined
    const results = await Promise.allSettled(launch.dispatches.map(async (dispatch) => {
      this.lifecycle.signal.throwIfAborted()
      if (expertRuntime === undefined || dispatch.target.role !== 'expert') {
        throw new TeamRunError('expert runtime is unavailable', 'CAPABILITY_UNAVAILABLE')
      }
      await expertRuntime.followup(
        launch.lead,
        dispatch.target.sessionId,
        [{ type: 'text', text: dispatch.deliveryText }],
        { source: { kind: 'plugin', plugin: name }, signal: this.lifecycle.signal },
      )
      if (this.states.get(launch.lead.id) === state && state.launch?.token === launch.token) {
        state.activeParticipantIds.add(actorSessionId(dispatch.target))
      }
      return dispatch
    }))
    if (this.states.get(launch.lead.id) !== state || state.launch?.token !== launch.token) return
    const failed: PendingSequentialDispatch[] = []
    for (const [index, result] of results.entries()) {
      const dispatch = launch.dispatches[index]
      if (dispatch === undefined) continue
      if (result.status === 'rejected') {
        const failure = result.reason instanceof Error ? result.reason.message : String(result.reason)
        state.deliveryFailures.push(`${dispatch.target.name}: ${failure}`)
        failed.push(dispatch)
      }
    }
    if (failed.length > 0) {
      const chinese = /\p{Script=Han}/u.test(this.ctx.teamRuns.getRun(launch.lead).objective)
      try {
        await this.ctx.teamRuns.publishMessages(launch.lead, failed.map((dispatch, index) => ({
          kind: 'status',
          threadId: launch.threadId,
          references: dispatch.publicMessage.references.taskId === undefined
            ? {}
            : { taskId: dispatch.publicMessage.references.taskId },
          content: `${chinese ? PARALLEL_FAILURE_PREFIX_ZH : PARALLEL_FAILURE_PREFIX_EN}${state.deliveryFailures[index] ?? dispatch.target.name}`,
        })))
      } catch (error: unknown) {
        this.ctx.logger.error(`parallel admission failure audit could not be persisted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (this.states.get(launch.lead.id) !== state || state.launch.token !== launch.token) return
    state.launch = undefined
    state.deliveringLaunch = false
    state.launchSettled = true
    if (state.activeParticipantIds.size === 0 && state.recoveringParticipantIds.size === 0) this.finishParallel(state)
  }

  /** Record one returned expert only after its turn becomes idle, then close the barrier when all peers returned. */
  private settleParallelReturn(state: ParallelRunState, pending: PendingSequentialDispatch): void {
    const participantId = pending.sender.id
    if (state.pendingReturns.get(participantId) !== pending) return
    state.pendingReturns.delete(participantId)
    state.activeParticipantIds.delete(participantId)
    state.completedReturns.set(participantId, pending)
    if (state.launchSettled && state.activeParticipantIds.size === 0
      && state.recoveringParticipantIds.size === 0) this.finishParallel(state)
  }

  /** Restore the Lead once and deliver one deterministic join containing every admitted expert return. */
  private finishParallel(state: ParallelRunState): void {
    if (this.states.get(state.lead.id) !== state) return
    this.states.set(state.lead.id, {
      mode: 'sequential',
      ownerId: state.lead.id,
      reservation: undefined,
      pending: undefined,
      delivering: false,
    })
    const chinese = /\p{Script=Han}/u.test(this.ctx.teamRuns.getRun(state.lead).objective)
    const returned = state.participantOrder.flatMap((participantId) => {
      const value = state.completedReturns.get(participantId)
      return value === undefined ? [] : [value.deliveryText]
    })
    const failures = state.deliveryFailures.length === 0
      ? []
      : [chinese
        ? `未完成的并行任务：\n${state.deliveryFailures.join('\n')}`
        : `Parallel tasks that did not complete:\n${state.deliveryFailures.join('\n')}`]
    const header = chinese
      ? `并行阶段 ${state.stageId} 已完成汇合。请刷新 collaboration_get 与任务列表，逐项验收已回交资产。运行时控制器会先自动补位失效专家；如原任务仍指向失效成员，使用 collaboration_control 的 reassign 交给补位专家，不得将未完成任务视为成功。`
      : `Parallel stage ${state.stageId} has joined. Refresh collaboration_get and the task list, then review every returned artifact. The runtime controller first attempts to replace a failed expert automatically; if the unfinished task still targets the failed member, use collaboration_control with reassign for the replacement, and never treat unfinished work as successful.`
    try {
      state.lead.followup(createUserMessage({
        content: [{ type: 'text', text: [header, ...returned, ...failures].join('\n\n') }],
        source: { kind: 'plugin', plugin: name },
      }))
    } catch (error: unknown) {
      this.ctx.logger.error(`parallel collaboration join failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resolve failed participants as failed batch results so they cannot retain the parallel baton. */
  private reconcileParallelFailures(state: ParallelRunState, run: TeamRunSnapshot): void {
    for (const participantId of state.participantOrder) {
      if (state.completedReturns.has(participantId)) continue
      const pending = state.pendingReturns.get(participantId)
      if (pending !== undefined) {
        const member = run.members.find(candidate => candidate.sessionId === participantId)
        if (member?.phase !== 'failed') continue
        state.pendingReturns.delete(participantId)
        state.activeParticipantIds.delete(participantId)
        state.completedReturns.set(participantId, pending)
        continue
      }
      const target = state.participants.get(participantId)
      if (target === undefined) continue
      const member = run.members.find(candidate => candidate.id === target.memberId)
      if (member?.phase !== 'failed') continue
      state.activeParticipantIds.delete(participantId)
      state.returnReservations.delete(participantId)
      const detail = `${target.name}: ${member.failure?.message ?? 'expert execution failed'}`
      if (!state.deliveryFailures.includes(detail)) state.deliveryFailures.push(detail)
      const activeReplacement = run.members.some(candidate =>
        candidate.protocolSlotId === member.protocolSlotId && candidate.phase === 'active')
      if (!activeReplacement) this.replaceFailedParticipant(state, participantId, member.id)
    }
    if (state.launchSettled && state.activeParticipantIds.size === 0
      && state.recoveringParticipantIds.size === 0) this.finishParallel(state)
  }

  /** Ask the non-model runtime controller for one bounded slot replacement before waking the Lead. */
  private replaceFailedParticipant(
    state: ParallelRunState,
    participantId: Agent['id'],
    failedMemberId: ReturnType<typeof TeamMemberId>,
  ): void {
    if (state.recoveringParticipantIds.has(participantId)) return
    const orchestrator = this.ctx.get('teamOrchestrator') as OrchestrationPlanReader | undefined
    const snapshot = orchestrator?.get(state.lead)
    if (snapshot?.requestId === undefined || orchestrator?.replaceExpert === undefined) return
    state.recoveringParticipantIds.add(participantId)
    void orchestrator.replaceExpert(state.lead, {
      requestId: snapshot.requestId as never,
      failedMemberId,
    }, this.lifecycle.signal).catch((error: unknown) => {
      const target = state.participants.get(participantId)
      const detail = `${target?.name ?? String(participantId)} replacement: ${error instanceof Error ? error.message : String(error)}`
      if (!state.deliveryFailures.includes(detail)) state.deliveryFailures.push(detail)
    }).finally(() => {
      state.recoveringParticipantIds.delete(participantId)
      if (this.states.get(state.lead.id) === state && state.launchSettled
        && state.activeParticipantIds.size === 0 && state.recoveringParticipantIds.size === 0) {
        this.finishParallel(state)
      }
    })
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

  /** Resolve one exact active roster target without accepting aliases or inactive attempts. */
  private activeTarget(run: TeamRunSnapshot, requestedName: string): TeamActorRef {
    const targetName = planningText(requestedName, 'target')
    const member = run.members.find(candidate => candidate.phase === 'active' && candidate.name === targetName)
    if (member === undefined) {
      throw new TeamRunError(`active recipient "${targetName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    }
    return {
      role: 'expert',
      memberId: member.id,
      sessionId: member.sessionId,
      name: member.name,
    }
  }

  /** Bind one immutable Charter stage to the dependency-first TeamRun task identities. */
  private executionStage(lead: Agent, requestedStageId: string): ResolvedExecutionStage {
    const orchestrator = this.ctx.get('teamOrchestrator') as OrchestrationPlanReader | undefined
    const plan = orchestrator?.get(lead).plan
    if (plan === undefined || plan.stages === undefined) {
      throw new TeamRunError('committed Team Charter execution stages are unavailable', 'CAPABILITY_UNAVAILABLE')
    }
    const stage = plan.stages.find(candidate => candidate.id === requestedStageId)
    if (stage === undefined) {
      throw new TeamRunError(`execution stage "${requestedStageId}" not found`, 'TEAM_TASK_NOT_FOUND')
    }
    const byId = new Map(plan.taskDag.map(value => [value.id, value]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const ordered: Array<{ readonly id: string; readonly blockedBy: readonly string[] }> = []
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
    for (const workstream of plan.taskDag) visit(workstream.id)
    const tasks = this.ctx.teamRuns.listTasks(lead)
    if (tasks.length < ordered.length) {
      throw new TeamRunError('TeamRun task board is incomplete for the committed Team Charter', 'TEAM_TASK_NOT_FOUND')
    }
    const taskIdByWorkstream = new Map(ordered.map((workstream, index) => {
      const task = tasks[index]
      if (task === undefined) throw new TeamRunError('TeamRun task mapping is incomplete', 'TEAM_TASK_NOT_FOUND')
      return [workstream.id, task.id]
    }))
    return {
      id: stage.id,
      mode: stage.mode,
      taskIds: stage.workstreamIds.map((workstreamId) => {
        const taskId = taskIdByWorkstream.get(workstreamId)
        if (taskId === undefined) {
          throw new TeamRunError(
            `execution stage "${stage.id}" references missing workstream "${workstreamId}"`,
            'TEAM_TASK_NOT_FOUND',
          )
        }
        return taskId
      }),
    }
  }

  /** Return the explicit parallel stage containing one task, or undefined for legacy/unplanned runs. */
  private explicitParallelStageForTask(
    lead: Agent,
    taskId: ReturnType<typeof TeamTaskId>,
  ): ResolvedExecutionStage | undefined {
    const orchestrator = this.ctx.get('teamOrchestrator') as OrchestrationPlanReader | undefined
    const stages = orchestrator?.get(lead).plan?.stages
    if (stages === undefined) return undefined
    for (const stage of stages) {
      if (stage.mode !== 'parallel') continue
      const resolved = this.executionStage(lead, stage.id)
      if (resolved.taskIds.some(candidate => candidate === taskId)) return resolved
    }
    return undefined
  }

  private stateFor(run: TeamRunSnapshot): CollaborationRunState {
    const existing = this.states.get(run.lead.sessionId)
    if (existing !== undefined) {
      if (existing.mode === 'parallel') this.reconcileParallelFailures(existing, run)
      return this.states.get(run.lead.sessionId) ?? existing
    }
    const lastRoute = run.messages.findLast(message =>
      message.targets.length === 1
      && isSequentialRouteContent(message.content))
    if (lastRoute !== undefined && isParallelStageThread(lastRoute.threadId)) {
      const threadMessages = run.messages.filter(message => message.threadId === lastRoute.threadId)
      const launches = threadMessages.filter(message =>
        message.author.role === 'lead'
        && message.kind === 'task'
        && message.targets.length === 1
        && message.targets[0]?.role === 'expert'
        && message.references.taskId !== undefined)
      if (launches.length >= 2) {
        const lead = this.ctx.agents.get(run.lead.sessionId)
        if (lead === undefined) throw new TeamRunError('TeamRun Lead is unavailable', 'TEAM_MEMBER_NOT_FOUND')
        const participants = new Map<Agent['id'], ExpertActorRef>()
        const taskIdsByParticipant = new Map<Agent['id'], ReturnType<typeof TeamTaskId>>()
        for (const message of launches) {
          const target = message.targets[0]
          const taskId = message.references.taskId
          if (target?.role !== 'expert' || taskId === undefined) continue
          participants.set(target.sessionId, target)
          taskIdsByParticipant.set(target.sessionId, taskId)
        }
        const completedReturns = new Map<Agent['id'], PendingSequentialDispatch>()
        const launchesByParticipant = new Map<Agent['id'], PublicCollaborationMessage>()
        for (const message of launches) {
          const target = message.targets[0]
          if (target?.role === 'expert') launchesByParticipant.set(target.sessionId, message)
        }
        const failureMessages = threadMessages.filter(message =>
          message.author.role === 'lead'
          && message.kind === 'status'
          && message.targets.length === 0
          && message.references.taskId !== undefined
          && parallelFailureDetail(message.content) !== undefined)
        const failedTaskIds = new Set(failureMessages.flatMap(message =>
          message.references.taskId === undefined ? [] : [String(message.references.taskId)]))
        const failedParticipantDetails: string[] = []
        for (const [participantId, target] of participants) {
          const member = run.members.find(candidate => candidate.id === target.memberId)
          if (member?.phase !== 'failed') continue
          const taskId = taskIdsByParticipant.get(participantId)
          if (taskId !== undefined) failedTaskIds.add(String(taskId))
          failedParticipantDetails.push(`${target.name}: ${member.failure?.message ?? 'expert execution failed'}`)
        }
        for (const participantId of participants.keys()) {
          const taskId = taskIdsByParticipant.get(participantId)
          const returned = threadMessages.findLast(message =>
            message.author.sessionId === participantId
            && message.targets.length === 1
            && message.targets[0]?.role === 'lead'
            && message.references.taskId === taskId)
          if (returned === undefined) continue
          // The return is durable, while its sender Agent is only process-local.
          // finishParallel consumes the durable delivery text, so a cold sender
          // must never invalidate an already completed contribution.
          const sender = this.ctx.agents.get(participantId) ?? lead
          completedReturns.set(participantId, {
            token: Symbol(`recovered-parallel-return:${String(participantId)}`),
            sender,
            lead,
            target: run.lead,
            publicMessage: returned,
            deliveryText: returned.content,
          })
        }
        const stageId = parallelStageId(lastRoute.threadId)
        const activeParticipantIds = new Set<Agent['id']>()
        const recoveryToken = Symbol(`recovered-parallel-launch:${String(run.lead.sessionId)}`)
        const recoveryDispatches: PendingSequentialDispatch[] = []
        for (const [participantId, target] of participants) {
          const taskId = taskIdsByParticipant.get(participantId)
          if (completedReturns.has(participantId)
            || (taskId !== undefined && failedTaskIds.has(String(taskId)))) continue
          const liveParticipant = this.ctx.agents.get(participantId)
          if (liveParticipant?.status === 'running') {
            activeParticipantIds.add(participantId)
            continue
          }
          const launchMessage = launchesByParticipant.get(participantId)
          if (launchMessage === undefined || taskId === undefined) continue
          const task = this.ctx.teamRuns.getTask(lead, taskId)
          recoveryDispatches.push({
            token: recoveryToken,
            sender: lead,
            lead,
            target,
            publicMessage: launchMessage,
            deliveryText: parallelDeliveryText(
              /\p{Script=Han}/u.test(run.objective),
              stageId,
              task,
              launchMessage.content,
            ),
          })
        }
        const recovered: ParallelRunState = {
          mode: 'parallel',
          lead,
          stageId,
          threadId: lastRoute.threadId,
          participants,
          participantOrder: [...participants.keys()],
          taskIdsByParticipant,
          activeParticipantIds,
          returnReservations: new Set(),
          pendingReturns: new Map(),
          completedReturns,
          deliveryFailures: failureMessages.flatMap((message) => {
            const detail = parallelFailureDetail(message.content)
            return detail === undefined ? [] : [detail]
          }).concat(failedParticipantDetails).filter((value, index, values) => values.indexOf(value) === index),
          recoveringParticipantIds: new Set(),
          launch: recoveryDispatches.length === 0
            ? undefined
            : {
              token: recoveryToken,
              sender: lead,
              lead,
              stageId,
              threadId: lastRoute.threadId,
              dispatches: recoveryDispatches,
            },
          deliveringLaunch: false,
          launchSettled: recoveryDispatches.length === 0,
        }
        this.states.set(run.lead.sessionId, recovered)
        this.reconcileParallelFailures(recovered, run)
        if (recovered.launch !== undefined && lead.status === 'idle') {
          queueMicrotask(() => { this.onIdle(lead) })
        }
        return this.states.get(run.lead.sessionId) ?? recovered
      }
    }
    const ownerId = lastRoute?.targets[0] === undefined ? run.lead.sessionId : actorSessionId(lastRoute.targets[0])
    const created: SequentialRunState = {
      mode: 'sequential',
      ownerId,
      reservation: undefined,
      pending: undefined,
      delivering: false,
    }
    this.states.set(run.lead.sessionId, created)
    return created
  }

}

/** Register the complete collaboration adapter in one exact TeamRun member scope. */
function install(agent: Agent, ctx: Context, router: CollaborationRouter): () => void {
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
      name: 'collaboration_parallel_followup',
      description: 'Lead-only atomic dispatch for at least two ready tasks in one explicitly parallel Team Charter stage; starts expert inboxes concurrently and joins once.',
      parameters: {
        stage_id: { type: 'string', required: true, description: 'Exact id of one committed Team Charter stage whose mode is parallel.' },
        items: {
          type: 'array',
          required: true,
          description: 'Two or more distinct ready tasks, each addressed to its preassigned active expert.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: { type: 'string', required: true, description: 'Exact public name of the assigned active expert.' },
              task_id: { type: 'string', required: true, description: 'Exact ready task id in this stage.' },
              context_summary: { type: 'string', required: true, description: 'Concise user-safe public context for this task.' },
              next_action: { type: 'string', required: true, description: 'Exactly one action this expert should execute.' },
              selection_reason: { type: 'string', required: true, description: 'Why this preassigned expert owns this task.' },
              content: { type: 'string', required: true, description: 'Concise user-safe execution instruction.' },
            },
          },
        },
      },
      output: jsonOutput(PARALLEL_MESSAGE_BATCH_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const result = await router.routeParallel(
          callingAgent(exec.agent, 'collaboration_parallel_followup'),
          {
            stageId: args.stage_id,
            items: args.items.map(item => ({
              target: item.target,
              taskId: item.task_id,
              contextSummary: item.context_summary,
              nextAction: item.next_action,
              selectionReason: item.selection_reason,
              content: item.content,
            })),
          },
        )
        exec.concludeTurn()
        return { stageId: result.stageId, messages: result.messages.map(messageValue) }
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
      description: 'Compare-and-set one TeamRun task action using the latest task revision. In enforced runs only the Lead may confirm complete after accepting the owner artifact routed for that exact task.',
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
  const router = new CollaborationRouter(ctx)
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
  for (const agent of ctx.agents.list()) {
    if (ctx.teamRuns.tryMembership(agent)?.actor.role === 'lead') router.onRunChanged(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    reconcile(agent)
    // Cold restoration may announce an Agent before its durable TeamRun
    // membership projection is readable. Re-scan live Leads after every
    // member arrival so the final restored child closes that startup race.
    for (const candidate of ctx.agents.list()) {
      if (ctx.teamRuns.tryMembership(candidate)?.actor.role === 'lead') {
        queueMicrotask(() => { router.onRunChanged(candidate) })
      }
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') router.onIdle(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on('session/event', (session, event) => {
    if (!isTeamRunEvent(event)) return
    for (const agent of ctx.agents.list()) reconcile(agent)
    const lead = ctx.agents.get(session.id)
    if (lead !== undefined && ctx.teamRuns.tryMembership(lead)?.actor.role === 'lead') {
      queueMicrotask(() => { router.onRunChanged(lead) })
    }
  })
  ctx.effect(() => () => {
    router.dispose()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-agent-team.scopedTools()')
}
