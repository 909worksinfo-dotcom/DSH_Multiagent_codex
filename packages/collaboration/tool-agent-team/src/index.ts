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

const POLICY = `This session belongs to an explicit TeamRun. Use collaboration_get before acting on stale state, including protocol limits, remaining message budget, allowed targets, and challenge status. Every public collaboration record must use the same dominant language as the user's TeamRun objective. The Lead coordinates through collaboration tools only; experts execute their assigned responsibilities with their mounted skills and plugins and may challenge, respond, review, or request help only when the protocol projection permits it. The Lead must not use Bash, web search, skill loading, or other everyday-session tools to perform expert work. Team Charter tasks are already materialized and must not be duplicated with collaboration_task_create. Every active expert must publish at least one concise public collaboration_send contribution before final delivery; a direct assistant response is not a team contribution. Use collaboration_followup whenever a public delegation, review request, challenge-response request, or help request requires an expert to take another model turn; collaboration_send alone records a message but does not wake a settled expert. The Lead must explicitly delegate work, request or receive expert review, resolve open challenges, accept artifacts that cover every task, pass every quality gate, record an accepted artifact-linked decision for every task, publish completion-request and review evidence, and call collaboration_complete before returning the unified final response.

Every collaboration_send record is public to the user. A challenge and its response require the same explicit dispute thread_id, one explicit target, and the same challenge_id; answer an open round before starting another in that thread. Ordinary messages must omit challenge_id, may omit thread_id, and use main. Publish only concise task-relevant conclusions, evidence, questions, decisions, and handoffs. Never publish private reasoning or chain-of-thought. Re-read the latest task immediately before every compare-and-set update and use its current revision. If a collaboration tool reports stale state or a protocol error, refresh and correct the call instead of bypassing public collaboration. resource_scopes are advisory ownership labels, not locks or permission grants. Formation and expert activation belong to the runtime controller and are not model tools.`

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

/** Register the complete collaboration adapter in one exact TeamRun member scope. */
function install(agent: Agent, ctx: Context): () => void {
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
      if (membership.actor.role !== 'lead') return undefined
      const objective = ctx.teamRuns.getRun(agent).objective
      const chinese = /\p{Script=Han}/u.test(objective)
      if (exec.name === 'think') return undefined
      if (!exec.name.startsWith('collaboration_')) {
        return chinese
          ? 'Lead 只能使用 collaboration_* 工具协调团队；请把专业执行委派给已挂载技能和插件的专家'
          : 'The Lead may only coordinate with collaboration_* tools; delegate specialist execution to experts with mounted skills and plugins'
      }
      if (exec.name === 'collaboration_task_create'
        && agent.session.events.some(event => String(event.type) === 'collaboration/orchestration/charter')) {
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
      description: 'Lead-only compare-and-set arbitration that atomically publishes a public decision record.',
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
      description: 'Lead-only formal quality result over one materialized Charter gate.',
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
      description: 'Publish one typed public TeamRun message. This never accepts private reasoning or chain-of-thought.',
      parameters: {
        kind: { type: 'string', required: true, enum: COLLABORATION_SEND_KINDS, description: 'Public statement category; ledger receipts use their owning tools.' },
        thread_id: { type: 'string', description: 'Required explicit dispute thread for challenge/response; ordinary messages default to main.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Exactly one explicit participant for challenge/response; otherwise protocol-allowed names or lead.' },
        task_id: { type: 'string', description: 'Optional current non-deleted task reference.' },
        challenge_id: { type: 'string', description: 'Optional challenge reference.' },
        decision_id: { type: 'string', description: 'Optional decision reference.' },
        artifact_id: { type: 'string', description: 'Optional artifact reference.' },
        content: { type: 'string', required: true, description: 'Concise user-safe public content.' },
      },
      output: jsonOutput(MESSAGE_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const threadId = optionalText(args.thread_id)
        const targets = optionalTexts(args.targets)
        const taskId = optionalText(args.task_id)
        const challengeId = optionalText(args.challenge_id)
        const decisionId = optionalText(args.decision_id)
        const artifactId = optionalText(args.artifact_id)
        if ((args.kind === 'challenge' || args.kind === 'response')
          && (threadId === undefined || challengeId === undefined || targets?.length !== 1)) {
          throw new TeamRunError(
            'challenge and response require one explicit dispute thread, challenge id, and target',
            'TEAM_CHALLENGE_INVALID',
          )
        }
        const references = {
          ...taskId === undefined ? {} : { taskId: TeamTaskId(taskId) },
          ...challengeId === undefined ? {} : { challengeId: TeamChallengeId(challengeId) },
          ...decisionId === undefined ? {} : { decisionId: TeamDecisionId(decisionId) },
          ...artifactId === undefined ? {} : { artifactId: TeamArtifactId(artifactId) },
        }
        const message = await ctx.teamRuns.publishMessage(callingAgent(exec.agent, 'collaboration_send'), {
          kind: args.kind,
          threadId: threadId === undefined ? MAIN_TEAM_THREAD_ID : TeamThreadId(threadId),
          ...targets === undefined ? {} : { targets },
          ...Object.keys(references).length === 0 ? {} : { references },
          content: args.content,
        })
        return messageValue(message)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_followup',
      description: 'Publish one targeted public delegation or help request and wake that active expert for another bounded turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Exact public name of one active expert.' },
        task_id: { type: 'string', description: 'Optional current non-deleted task reference.' },
        content: { type: 'string', required: true, description: 'Concise user-safe public instruction or request.' },
      },
      output: jsonOutput(MESSAGE_VALUE_SCHEMA),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const caller = callingAgent(exec.agent, 'collaboration_followup')
        const membership = ctx.teamRuns.membership(caller)
        const run = ctx.teamRuns.getRun(caller)
        const targetName = args.target.trim()
        const target = run.members.find(member => member.phase === 'active' && member.name === targetName)
        if (target === undefined) {
          throw new TeamRunError(`active expert "${targetName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
        }
        const lead = membership.actor.role === 'lead' ? caller : ctx.agents.get(run.lead.sessionId)
        if (lead === undefined) throw new TeamRunError('TeamRun Lead is unavailable', 'TEAM_MEMBER_NOT_FOUND')
        const expertRuntime = ctx.get('expertRuntime') as ExpertFollowupService | undefined
        if (expertRuntime === undefined) {
          throw new TeamRunError('expert runtime is unavailable', 'CAPABILITY_UNAVAILABLE')
        }
        const taskId = optionalText(args.task_id)
        const message = await ctx.teamRuns.publishMessage(caller, {
          kind: membership.actor.role === 'lead' ? 'task' : 'request_help',
          threadId: MAIN_TEAM_THREAD_ID,
          targets: [targetName],
          ...taskId === undefined ? {} : { references: { taskId: TeamTaskId(taskId) } },
          content: args.content,
        })
        await expertRuntime.followup(
          lead,
          target.sessionId,
          [{
            type: 'text',
            text: `A public TeamRun follow-up from ${membership.actor.name} requires your next turn:\n\n${args.content}\n\nRefresh collaboration_get and the referenced task before acting. Publish your updated conclusion, challenge, response, review, or handoff through the collaboration tools in the user's language.`,
          }],
          { source: { kind: 'plugin', plugin: name }, signal: exec.signal },
        )
        return messageValue(message)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'collaboration_complete',
      description: 'Lead-only atomic completion after all tasks and public review evidence are complete.',
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
  const installed = new Map<Agent, () => void>()
  const reconcile = (agent: Agent): void => {
    if (ctx.teamRuns.tryMembership(agent) === undefined) {
      installed.get(agent)?.()
      installed.delete(agent)
      return
    }
    if (installed.has(agent)) return
    installed.set(agent, install(agent, ctx))
  }
  for (const agent of ctx.agents.list()) reconcile(agent)
  ctx.on('agent/created', ({ agent }) => { reconcile(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on('session/event', (_session, event) => {
    if (!isTeamRunEvent(event)) return
    for (const agent of ctx.agents.list()) reconcile(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-agent-team.scopedTools()')
}
