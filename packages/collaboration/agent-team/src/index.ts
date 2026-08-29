/** Stable TeamRun service over one authoritative Lead Session event log. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveActorByName, resolveMembership } from './authority.ts'
import {
  expertsMissingAcceptedContribution,
  hasVerifiedCompletionReview,
  tasksMissingAcceptedOwnerEvidence,
} from './completion-evidence.ts'
import { isCollaborationErrorCode, TeamRunError } from './error.ts'
import { snapshotTeamRun } from './fold.ts'
import type { TeamRunFoldState } from './fold.ts'
import {
  CollaborationEventId,
  CollaborationMessageId,
  TeamArtifactId,
  TeamDecisionId,
  TeamQualityGateId,
  TeamProtocolSlotId,
  TeamRunId,
  MAIN_TEAM_THREAD_ID,
} from './ids.ts'
import { TeamRunJournal } from './journal.ts'
import {
  DEFAULT_MAX_PROVISION_ATTEMPTS,
  PRODUCT_MAX_ACTIVE_EXPERTS,
  validatePlannedExperts,
  validatePolicy,
} from './policy.ts'
import { TeamRunTaskBoard } from './task-board.ts'
import type {
  BeginExpertProvisionRequest,
  ChangeTeamRunPhaseRequest,
  CompleteTeamRunRequest,
  Config,
  CreateTeamRunRequest,
  CreateTeamTaskRequest,
  FailExpertProvisionRequest,
  MaterializeTeamProtocolRequest,
  PublicCollaborationMessage,
  PublishCollaborationMessageRequest,
  SucceedExpertProvisionRequest,
  TeamActorRef,
  TeamArtifactRecord,
  TeamControlRequest,
  TeamDecisionRecord,
  TeamFailure,
  TeamMemberSnapshot,
  TeamMembership,
  TeamRunPolicySnapshot,
  TeamRunSnapshot,
  TeamTaskView,
  TeamQualityGateRecord,
  TerminateTeamRunRequest,
  UpdateTeamTaskRequest,
  UpdateTeamQualityGateRequest,
  WriteTeamArtifactRequest,
  WriteTeamDecisionRequest,
  CreateTeamQualityGateRequest,
} from './types.ts'
import { expertName, requiredText } from './validation.ts'

export type * from './types.ts'
export { TEAM_TASK_ACTIONS } from './types.ts'
export type { TeamRunFoldState } from './fold.ts'
export {
  CollaborationEventId,
  CollaborationMessageId,
  ProvisionAttemptId,
  TeamArtifactId,
  TeamChallengeId,
  TeamDecisionId,
  TeamMemberId,
  TeamRunId,
  TeamTaskId,
  TeamThreadId,
  TeamQualityGateId,
  TeamProtocolSlotId,
  MAIN_TEAM_THREAD_ID,
} from './ids.ts'
export { COLLABORATION_ERROR_CODES, isCollaborationErrorCode, TeamRunError } from './error.ts'
export {
  applyTeamRunEvent,
  emptyTeamRunFoldState,
  foldTeamRun,
  isTeamRunEvent,
  projectTeamTask,
  snapshotTeamRun,
} from './fold.ts'
export {
  DEFAULT_MAX_PROVISION_ATTEMPTS,
  PRODUCT_MAX_ACTIVE_EXPERTS,
  TEAM_COMPLEXITY_BANDS,
  validatePlannedExperts,
} from './policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamRuns: TeamRunService
  }
}

const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PUBLIC_MESSAGES = 4_096
const DEFAULT_MAX_PUBLIC_MESSAGE_BYTES = 65_536
const DEFAULT_MAX_ARTIFACTS = 512
const DEFAULT_MAX_ARTIFACT_BODY_BYTES = 1_048_576
const DEFAULT_TASK_STALL_CURSOR_THRESHOLD = 20

/** Fail closed when a just-committed value cannot be recovered from replay. */
function committedValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`committed ${description} is missing from TeamRun replay`)
  return value
}

/** Stable TeamRun service; `ctx.teamRuns` is independent from experimental `ctx.agentTeams`. */
export class TeamRunService extends Service {
  static inject = ['agents', 'sessions']

  /** Loader validation for deployment-owned TeamRun limits. */
  static Config: z<Config> = z.object({
    maxActiveExperts: z.number().step(1).min(1).max(PRODUCT_MAX_ACTIVE_EXPERTS)
      .default(PRODUCT_MAX_ACTIVE_EXPERTS),
    maxProvisionAttempts: z.number().step(1).min(1).default(DEFAULT_MAX_PROVISION_ATTEMPTS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPublicMessages: z.number().step(1).min(1).default(DEFAULT_MAX_PUBLIC_MESSAGES),
    maxPublicMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_PUBLIC_MESSAGE_BYTES),
    maxArtifacts: z.number().step(1).min(1).default(DEFAULT_MAX_ARTIFACTS),
    maxArtifactBodyBytes: z.number().step(1).min(1).default(DEFAULT_MAX_ARTIFACT_BODY_BYTES),
    taskStallCursorThreshold: z.number().step(1).min(1).default(DEFAULT_TASK_STALL_CURSOR_THRESHOLD),
  })

  private readonly policy: TeamRunPolicySnapshot
  private readonly journal: TeamRunJournal
  private readonly tasks: TeamRunTaskBoard

  /**
   * @param ctx - Cordis context with Agent and Session services.
   * @param config - deployment limits snapshotted into each subsequently created run.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'teamRuns')
    this.policy = validatePolicy({
      maxActiveExperts: config.maxActiveExperts ?? PRODUCT_MAX_ACTIVE_EXPERTS,
      maxProvisionAttempts: config.maxProvisionAttempts ?? DEFAULT_MAX_PROVISION_ATTEMPTS,
      maxTasks: config.maxTasks ?? DEFAULT_MAX_TASKS,
      maxPublicMessages: config.maxPublicMessages ?? DEFAULT_MAX_PUBLIC_MESSAGES,
      maxPublicMessageBytes: config.maxPublicMessageBytes ?? DEFAULT_MAX_PUBLIC_MESSAGE_BYTES,
      maxArtifacts: config.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
      maxArtifactBodyBytes: config.maxArtifactBodyBytes ?? DEFAULT_MAX_ARTIFACT_BODY_BYTES,
      taskStallCursorThreshold: config.taskStallCursorThreshold ?? DEFAULT_TASK_STALL_CURSOR_THRESHOLD,
    })
    this.journal = new TeamRunJournal(ctx)
    this.tasks = new TeamRunTaskBoard(this.journal)
  }

  /**
   * Atomically establish one explicit TeamRun before expert work begins.
   * @param lead - exact live initiating Agent, retained as the implicit Lead outside expert capacity.
   * @param request - objective, complexity, and exact planned expert target.
   * @returns authoritative profiling snapshot at revision one.
   */
  async createRun(lead: Agent, request: CreateTeamRunRequest): Promise<TeamRunSnapshot> {
    this.assertLive(lead)
    if (this.tryMembership(lead)?.actor.role === 'expert') {
      throw new TeamRunError('an expert cannot create a nested TeamRun', 'TEAM_LEAD_REQUIRED')
    }
    return this.journal.transact(lead.id, async () => {
      const state = this.journal.state(lead)
      if (state.created !== undefined) throw new TeamRunError(`TeamRun "${state.id}" already exists`, 'TEAM_INVALID_TRANSITION')
      const plannedExperts = validatePlannedExperts(
        request.complexity,
        request.plannedExperts,
        this.policy.maxActiveExperts,
      )
      await this.journal.appendAndFlush(lead, 'collaboration/run/created', {
        version: 1,
        runId: TeamRunId(lead.id),
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: 1,
        leadId: lead.id,
        objective: requiredText(request.objective, 'objective', 16_384),
        complexity: request.complexity,
        plannedExperts,
        policy: this.policy,
      })
      return snapshotTeamRun(this.journal.state(lead))
    })
  }

  /**
   * Resolve one exact live Agent's TeamRun role.
   * @param agent - exact live Lead or active expert.
   * @returns current run and actor authority.
   */
  membership(agent: Agent): TeamMembership {
    const resolved = this.tryMembership(agent)
    if (resolved === undefined) {
      throw new TeamRunError(`agent "${agent.id}" is not an active TeamRun member`, 'TEAM_NOT_MEMBER')
    }
    return resolved
  }

  /**
   * Resolve membership without throwing for scoped installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns membership, or undefined for an unrostered, inactive, stale, or malformed Agent.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const own = this.journal.state(agent)
      if (own.created !== undefined) return resolveMembership(own, agent.id)
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return undefined
      const lead = this.ctx.agents.get(parentId)
      if (lead === undefined) return undefined
      return resolveMembership(this.journal.state(lead), agent.id)
    } catch {
      return undefined
    }
  }

  /**
   * Read the authoritative run visible to one exact live member.
   * @param caller - exact live Lead or active expert.
   * @returns detached current TeamRun snapshot.
   */
  getRun(caller: Agent): TeamRunSnapshot {
    const { lead } = this.authority(caller)
    return snapshotTeamRun(this.journal.state(lead))
  }

  /**
   * Advance profiling, planning, formation, execution, or completion with run-level CAS.
   * @param caller - exact live Lead.
   * @param request - expected revision and next non-failure phase.
   * @returns committed TeamRun snapshot.
   */
  async changePhase(caller: Agent, request: ChangeTeamRunPhaseRequest): Promise<TeamRunSnapshot> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      this.assertRunRevision(state, request.expectedRevision)
      this.assertPhaseChange(state, request.phase)
      await this.journal.appendAndFlush(initial.lead, 'collaboration/run/phase', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        phase: request.phase,
      })
      return snapshotTeamRun(this.journal.state(initial.lead))
    })
  }

  /**
   * Idempotently commit the exact Team Charter collaboration protocol before activation.
   * @param caller - exact live TeamRun Lead.
   * @param request - run CAS plus topology, limits, immutable slots, permissions, and routes.
   * @returns authoritative snapshot containing the enforced protocol projection.
   */
  async materializeProtocol(caller: Agent, request: MaterializeTeamProtocolRequest): Promise<TeamRunSnapshot> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      const protocol = this.validateProtocol(state, request)
      if (state.protocol !== undefined) {
        if (JSON.stringify(state.protocol) !== JSON.stringify(protocol)) {
          throw new TeamRunError('materialized collaboration protocol diverges from the Team Charter', 'TEAM_PROTOCOL_REQUIRED')
        }
        return snapshotTeamRun(state)
      }
      this.assertRunRevision(state, request.expectedRevision)
      await this.journal.appendAndFlush(initial.lead, 'collaboration/protocol', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        protocol,
      })
      return snapshotTeamRun(this.journal.state(initial.lead))
    })
  }

  /**
   * Reserve one immutable expert attempt before P2 starts provider work, during formation or active replacement.
   * @param caller - exact live Lead.
   * @param request - run CAS, reserved ids, name, and role.
   * @returns committed provisioning attempt.
   */
  async beginExpertProvision(
    caller: Agent,
    request: BeginExpertProvisionRequest,
  ): Promise<TeamMemberSnapshot> {
    return this.transactLeadRevision(caller, request.expectedRevision, async (lead, state) => {
      if (state.phase !== 'provisioning' && state.phase !== 'active') {
        throw new TeamRunError(
          'experts can provision only while TeamRun is provisioning or replacing an active expert',
          'TEAM_INVALID_TRANSITION',
        )
      }
      const snapshot = snapshotTeamRun(state)
      if (snapshot.expertCounts.attempts >= snapshot.policy.maxProvisionAttempts) {
        throw new TeamRunError(
          `TeamRun provisioning attempt limit ${snapshot.policy.maxProvisionAttempts} reached`,
          'TEAM_PROVISION_ATTEMPT_LIMIT',
        )
      }
      if (snapshot.expertCounts.active + snapshot.expertCounts.provisioning >= snapshot.policy.maxActiveExperts
        || snapshot.expertCounts.active + snapshot.expertCounts.provisioning >= snapshot.plannedExperts) {
        throw new TeamRunError('TeamRun active plus provisioning expert capacity reached', 'TEAM_MEMBER_LIMIT')
      }
      if (state.protocol !== undefined) {
        const rule = state.protocol.experts.find(candidate => candidate.slotId === request.protocolSlotId)
        if (rule === undefined) {
          throw new TeamRunError('expert provisioning requires a planned collaboration protocol slot', 'TEAM_PROTOCOL_REQUIRED')
        }
        const attempts = [...state.members.values()].filter(candidate => candidate.protocolSlotId === rule.slotId)
        if ((attempts.length === 0 && request.memberId !== rule.initialMemberId)
          || attempts.some(candidate => candidate.phase !== 'failed')) {
          throw new TeamRunError(`collaboration protocol slot "${rule.slotId}" cannot admit this attempt`, 'TEAM_PROTOCOL_REQUIRED')
        }
      } else if (request.protocolSlotId !== undefined) {
        throw new TeamRunError('cannot bind a protocol slot before protocol materialization', 'TEAM_PROTOCOL_REQUIRED')
      }
      const member: TeamMemberSnapshot = {
        id: request.memberId,
        sessionId: request.sessionId,
        name: expertName(request.name),
        role: requiredText(request.role, 'expert role', 200),
        ...request.protocolSlotId === undefined ? {} : { protocolSlotId: request.protocolSlotId },
        attemptId: request.attemptId,
        attemptNumber: state.members.size + 1,
        phase: 'provisioning',
      }
      this.assertUniqueAttempt(state, member)
      await this.appendMember(lead, state, member)
      return structuredClone(committedValue(
        this.journal.state(lead).members.get(member.id),
        `expert "${member.id}"`,
      ))
    })
  }

  /**
   * Record one expert as active after P2 reports provider success.
   * @param caller - exact live Lead.
   * @param request - run CAS and immutable attempt identity.
   * @returns committed active expert row.
   */
  async succeedExpertProvision(
    caller: Agent,
    request: SucceedExpertProvisionRequest,
  ): Promise<TeamMemberSnapshot> {
    return this.settleExpert(caller, request, undefined)
  }

  /**
   * Mark a provisioning attempt or active runtime expert failed while retaining audit and releasing capacity.
   * @param caller - exact live Lead.
   * @param request - run CAS, immutable attempt identity, and structured failure.
   * @returns committed failed expert row.
   */
  async failExpertProvision(
    caller: Agent,
    request: FailExpertProvisionRequest,
  ): Promise<TeamMemberSnapshot> {
    return this.settleExpert(caller, request, request.failure)
  }

  /**
   * Commit an explicit formation failure, execution failure, or cancellation.
   * @param caller - exact live Lead.
   * @param request - run CAS, exact terminal phase, and structured cause.
   * @returns committed terminal TeamRun snapshot.
   */
  async terminateRun(caller: Agent, request: TerminateTeamRunRequest): Promise<TeamRunSnapshot> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      this.assertRunRevision(state, request.expectedRevision)
      const failure = this.assertTermination(state, request)
      await this.journal.appendAndFlush(initial.lead, 'collaboration/run/phase', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        phase: request.terminalPhase,
        failure,
      })
      return snapshotTeamRun(this.journal.state(initial.lead))
    })
  }

  /**
   * Create one TeamRun task through the single Lead-log authority.
   * @param caller - exact live Lead or active expert.
   * @param request - task text, blockers, and generic resource scopes.
   * @returns committed revision-one task.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { lead } = this.authority(caller)
    return this.tasks.create(lead, request)
  }

  /**
   * Read one current task, including a deleted tombstone.
   * @param caller - exact live Lead or active expert.
   * @param taskId - Team-local task identity.
   * @returns detached task view.
   */
  getTask(caller: Agent, taskId: import('./types.ts').TeamTaskId): TeamTaskView {
    const { lead } = this.authority(caller)
    return this.tasks.get(this.journal.state(lead), taskId)
  }

  /**
   * List current non-deleted TeamRun tasks.
   * @param caller - exact live Lead or active expert.
   * @returns detached task views in creation order.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    const { lead } = this.authority(caller)
    return this.tasks.list(this.journal.state(lead))
  }

  /**
   * Compare-and-set one authorized TeamRun task mutation.
   * @param caller - exact live Lead or active expert.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    const { lead, membership } = this.authority(caller)
    return this.tasks.update(lead, membership.actor, request)
  }

  /**
   * Publish one public-only structured collaboration message.
   * @param caller - exact live Lead or active expert author.
   * @param request - kind, thread, targets, references, and user-safe content.
   * @returns committed public message with event cursor and creation time.
   */
  async publishMessage(
    caller: Agent,
    request: PublishCollaborationMessageRequest,
  ): Promise<PublicCollaborationMessage> {
    const initial = this.authority(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      const targets = (request.targets ?? []).map(name => resolveActorByName(state, name))
      this.assertMessageAdmission(state, initial.membership.actor, request, targets)
      const id = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      const eventId = CollaborationEventId(`collaboration-event-${randomUUID()}`)
      await this.journal.appendAndFlush(initial.lead, 'collaboration/message', {
        version: 1,
        runId: state.id,
        eventId,
        revision: state.revision + 1,
        message: {
          id,
          threadId: request.threadId,
          kind: request.kind,
          author: initial.membership.actor,
          targets,
          references: structuredClone(request.references ?? {}),
          content: requiredText(request.content, 'public message content', Number.MAX_SAFE_INTEGER),
          visibility: 'public',
        },
      })
      return structuredClone(committedValue(
        this.journal.state(initial.lead).messages.get(id),
        `public message "${id}"`,
      ))
    })
  }

  /**
   * Write one complete artifact version and a body-free public receipt atomically.
   * @param caller - exact live Lead or active expert author.
   * @param request - artifact CAS, metadata, task relations, status, and bounded body.
   * @returns complete artifact to the authorized caller.
   */
  async writeArtifact(caller: Agent, request: WriteTeamArtifactRequest): Promise<TeamArtifactRecord> {
    const initial = this.authority(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      if (state.phase !== 'active' && state.phase !== 'completing') {
        throw new TeamRunError(`artifact cannot be written while TeamRun is ${String(state.phase)}`, 'TEAM_INVALID_TRANSITION')
      }
      const id = request.artifactId ?? TeamArtifactId(`artifact-${randomUUID()}`)
      const prior = state.artifacts.get(id)
      if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0
        || request.expectedVersion !== (prior?.version ?? 0)) {
        throw new TeamRunError(
          `stale artifact "${id}" version ${String(request.expectedVersion)}; current version is ${String(prior?.version ?? 0)}`,
          'STALE_REVISION',
          { retryable: true, details: { artifactId: id, expected: request.expectedVersion, actual: prior?.version ?? 0 } },
        )
      }
      if (prior === undefined && state.artifacts.size >= snapshotTeamRun(state).policy.maxArtifacts) {
        throw new TeamRunError(`TeamRun artifact limit ${snapshotTeamRun(state).policy.maxArtifacts} reached`, 'TEAM_ARTIFACT_LIMIT')
      }
      if (prior !== undefined && initial.membership.actor.role !== 'lead'
        && JSON.stringify(prior.author) !== JSON.stringify(initial.membership.actor)) {
        throw new TeamRunError('artifact update requires its author or TeamRun Lead', 'TEAM_ARTIFACT_UNAUTHORIZED')
      }
      if ((request.status === 'accepted' || request.status === 'superseded')
        && initial.membership.actor.role !== 'lead') {
        throw new TeamRunError('only the TeamRun Lead can accept or supersede an artifact', 'TEAM_LEAD_REQUIRED')
      }
      const body = requiredText(request.body, 'artifact body', Number.MAX_SAFE_INTEGER)
      if (Buffer.byteLength(body, 'utf8') > snapshotTeamRun(state).policy.maxArtifactBodyBytes) {
        throw new TeamRunError(
          `artifact body exceeds ${snapshotTeamRun(state).policy.maxArtifactBodyBytes} UTF-8 bytes`,
          'TEAM_ARTIFACT_TOO_LARGE',
        )
      }
      const taskIds = this.recordTaskIds(state, request.taskIds ?? [])
      this.assertGeneratedMessageCapacity(state)
      const version = (prior?.version ?? 0) + 1
      const artifact = {
        id,
        version,
        kind: request.kind,
        title: requiredText(request.title, 'artifact title', 200),
        status: request.status,
        author: prior?.author ?? initial.membership.actor,
        taskIds,
        mediaType: requiredText(request.mediaType, 'artifact media type', 200),
        body,
      } satisfies Omit<TeamArtifactRecord, 'updatedAt'>
      const messageId = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      const receiptContent = `Artifact "${artifact.title}" is ${artifact.status} at version ${String(version)}.`
      const receiptReferences = {
        artifactId: id,
        ...taskIds[0] === undefined ? {} : { taskId: taskIds[0] },
      }
      const leadTarget = { role: 'lead', sessionId: snapshotTeamRun(state).lead.sessionId, name: 'lead' } as const
      const receiptTargets: readonly TeamActorRef[] = initial.membership.actor.role === 'expert'
        ? [leadTarget]
        : artifact.author.role === 'expert'
          ? [artifact.author]
          : []
      this.assertProtocolAdmission(state, initial.membership.actor, {
        kind: 'artifact',
        threadId: MAIN_TEAM_THREAD_ID,
        targets: receiptTargets.map(target => target.name),
        references: receiptReferences,
        content: receiptContent,
      }, receiptTargets)
      await this.journal.appendBatchAndFlush(initial.lead, [
        {
          type: 'collaboration/artifact',
          data: {
            version: 1,
            runId: state.id,
            eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
            revision: state.revision + 1,
            artifact,
          },
        },
        this.publicLedgerMessage(
          state,
          state.revision + 2,
          initial.membership.actor,
          messageId,
          'artifact',
          receiptReferences,
          receiptContent,
          receiptTargets,
        ),
      ])
      return structuredClone(committedValue(this.journal.state(initial.lead).artifacts.get(id), `artifact "${id}"`))
    })
  }

  /**
   * Read one complete artifact through current TeamRun membership authority.
   * @param caller - exact live Lead or active expert.
   * @param artifactId - artifact identity.
   * @returns complete current artifact including its body.
   */
  readArtifact(caller: Agent, artifactId: import('./types.ts').TeamArtifactId): TeamArtifactRecord {
    const { lead } = this.authority(caller)
    const artifact = this.journal.state(lead).artifacts.get(artifactId)
    if (artifact === undefined) throw new TeamRunError(`artifact "${artifactId}" not found`, 'TEAM_ARTIFACT_NOT_FOUND')
    return structuredClone(artifact)
  }

  /**
   * Write one Lead arbitration row and its public decision record atomically.
   * @param caller - exact live Lead.
   * @param request - decision CAS, outcome, safe rationale, and ledger relations.
   * @returns committed decision.
   */
  async writeDecision(caller: Agent, request: WriteTeamDecisionRequest): Promise<TeamDecisionRecord> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      if (state.phase !== 'active' && state.phase !== 'completing') {
        throw new TeamRunError(`decision cannot be written while TeamRun is ${String(state.phase)}`, 'TEAM_INVALID_TRANSITION')
      }
      const id = request.decisionId ?? TeamDecisionId(`decision-${randomUUID()}`)
      const prior = state.decisions.get(id)
      this.assertLedgerVersion('decision', id, request.expectedVersion, prior?.version ?? 0)
      const taskIds = this.recordTaskIds(state, request.taskIds ?? [])
      const artifactIds = this.recordArtifactIds(state, request.artifactIds ?? [])
      if (state.protocol !== undefined && request.outcome === 'accepted') {
        if (taskIds.length === 0 || artifactIds.length === 0) {
          throw new TeamRunError(
            'an accepted decision requires explicit task and artifact evidence',
            'DELIVERY_FAILED',
          )
        }
        const referencedArtifacts = artifactIds.map(id => committedValue(
          state.artifacts.get(id),
          `artifact "${id}"`,
        ))
        if (referencedArtifacts.some(artifact => artifact.status !== 'accepted')) {
          throw new TeamRunError(
            'an accepted decision cannot reference an artifact that is still under review',
            'DELIVERY_FAILED',
          )
        }
        if (taskIds.some(taskId => !referencedArtifacts.some(artifact => artifact.taskIds.includes(taskId)))) {
          throw new TeamRunError(
            'every task in an accepted decision requires one referenced accepted artifact',
            'DELIVERY_FAILED',
          )
        }
      }
      this.assertGeneratedMessageCapacity(state)
      const decision = {
        id,
        version: (prior?.version ?? 0) + 1,
        subject: requiredText(request.subject, 'decision subject', 200),
        outcome: request.outcome,
        summary: requiredText(request.summary, 'decision summary', 4_096),
        rationale: requiredText(request.rationale, 'decision rationale', 4_096),
        taskIds,
        artifactIds,
        lead: initial.actor,
      } satisfies Omit<TeamDecisionRecord, 'createdAt'>
      const messageId = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      await this.journal.appendBatchAndFlush(initial.lead, [
        {
          type: 'collaboration/decision',
          data: {
            version: 1,
            runId: state.id,
            eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
            revision: state.revision + 1,
            decision,
          },
        },
        this.publicLedgerMessage(state, state.revision + 2, initial.actor, messageId, 'decision', {
          decisionId: id,
          ...taskIds[0] === undefined ? {} : { taskId: taskIds[0] },
          ...artifactIds[0] === undefined ? {} : { artifactId: artifactIds[0] },
        }, `${decision.subject}: ${decision.summary}`),
      ])
      return structuredClone(committedValue(this.journal.state(initial.lead).decisions.get(id), `decision "${id}"`))
    })
  }

  /**
   * Materialize one pending quality gate before activation.
   * @param caller - exact live Lead.
   * @param request - immutable gate name.
   * @returns committed pending gate.
   */
  async createQualityGate(caller: Agent, request: CreateTeamQualityGateRequest): Promise<TeamQualityGateRecord> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      const id = TeamQualityGateId(`quality-gate-${String(state.nextQualityGateNumber)}`)
      const gate = {
        id,
        version: 1,
        name: requiredText(request.name, 'quality gate name', 200),
        status: 'pending' as const,
        summary: '',
      }
      await this.journal.appendAndFlush(initial.lead, 'collaboration/quality-gate', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        gate,
      })
      return structuredClone(committedValue(this.journal.state(initial.lead).qualityGates.get(id), `quality gate "${id}"`))
    })
  }

  /**
   * Commit one formal quality result and its public review atomically.
   * @param caller - exact live Lead reviewer.
   * @param request - gate CAS, result, safe summary, and optional relations.
   * @returns committed quality gate.
   */
  async updateQualityGate(caller: Agent, request: UpdateTeamQualityGateRequest): Promise<TeamQualityGateRecord> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      const prior = state.qualityGates.get(request.gateId)
      if (prior === undefined) throw new TeamRunError(`quality gate "${request.gateId}" not found`, 'TEAM_QUALITY_GATE_NOT_FOUND')
      this.assertLedgerVersion('quality gate', request.gateId, request.expectedVersion, prior.version)
      const taskIds = request.taskId === undefined ? [] : this.recordTaskIds(state, [request.taskId])
      const artifactIds = request.artifactId === undefined ? [] : this.recordArtifactIds(state, [request.artifactId])
      if (state.protocol !== undefined && request.status === 'passed') {
        const task = request.taskId === undefined ? undefined : state.tasks.get(request.taskId)
        const artifact = request.artifactId === undefined ? undefined : state.artifacts.get(request.artifactId)
        if (task === undefined || artifact === undefined) {
          throw new TeamRunError(
            'a passed quality gate requires explicit task and artifact evidence',
            'DELIVERY_FAILED',
          )
        }
        if (task.status !== 'completed'
          || artifact.status !== 'accepted'
          || !artifact.taskIds.includes(task.id)) {
          throw new TeamRunError(
            'a quality gate cannot pass until its task is completed and its linked artifact is accepted',
            'DELIVERY_FAILED',
          )
        }
      }
      this.assertGeneratedMessageCapacity(state)
      const gate: Omit<TeamQualityGateRecord, 'updatedAt'> = {
        id: prior.id,
        version: prior.version + 1,
        name: prior.name,
        status: request.status,
        reviewer: initial.actor,
        summary: requiredText(request.summary, 'quality gate summary', 4_096),
        ...taskIds[0] === undefined ? {} : { taskId: taskIds[0] },
        ...artifactIds[0] === undefined ? {} : { artifactId: artifactIds[0] },
      }
      const messageId = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      await this.journal.appendBatchAndFlush(initial.lead, [
        {
          type: 'collaboration/quality-gate',
          data: {
            version: 1,
            runId: state.id,
            eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
            revision: state.revision + 1,
            gate,
          },
        },
        this.publicLedgerMessage(state, state.revision + 2, initial.actor, messageId, 'review', {
          ...gate.taskId === undefined ? {} : { taskId: gate.taskId },
          ...gate.artifactId === undefined ? {} : { artifactId: gate.artifactId },
        }, `Quality gate "${gate.name}" ${gate.status}: ${gate.summary}`),
      ])
      return structuredClone(committedValue(
        this.journal.state(initial.lead).qualityGates.get(request.gateId),
        `quality gate "${request.gateId}"`,
      ))
    })
  }

  /**
   * Apply one Lead-only task correction with decision and public evidence in one batch.
   * @param caller - exact live Lead Controller authority.
   * @param request - run/task CAS, correction, and safe rationale.
   * @returns committed run snapshot.
   */
  async control(caller: Agent, request: TeamControlRequest): Promise<TeamRunSnapshot> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      this.assertRunRevision(state, request.expectedRevision)
      const taskRequest: UpdateTeamTaskRequest = request.action === 'reassign'
        ? {
          taskId: request.taskId,
          expectedRevision: request.expectedTaskRevision,
          action: 'reassign',
          ...request.owner === undefined ? {} : { owner: request.owner },
        }
        : request.action === 'rework'
          ? { taskId: request.taskId, expectedRevision: request.expectedTaskRevision, action: 'reopen' }
          : request.description === undefined
            ? (() => { throw new TeamRunError('replan requires description', 'TEAM_CONTROL_INVALID_ACTION') })()
            : {
              taskId: request.taskId,
              expectedRevision: request.expectedTaskRevision,
              action: 'edit',
              description: request.description,
            }
      const task = this.tasks.planUpdate(state, initial.actor, taskRequest)
      this.assertGeneratedMessageCapacity(state)
      const decisionId = TeamDecisionId(`decision-${randomUUID()}`)
      const rationale = requiredText(request.rationale, 'control rationale', 4_096)
      const decision: Omit<TeamDecisionRecord, 'createdAt'> = {
        id: decisionId,
        version: 1,
        subject: `${request.action} task ${task.id}`,
        outcome: request.action,
        summary: `Lead Controller applied ${request.action} to "${task.subject}".`,
        rationale,
        taskIds: [task.id],
        artifactIds: [],
        lead: initial.actor,
      }
      const messageId = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      await this.journal.appendBatchAndFlush(initial.lead, [
        {
          type: 'collaboration/task',
          data: {
            version: 1,
            runId: state.id,
            eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
            revision: state.revision + 1,
            task,
          },
        },
        {
          type: 'collaboration/decision',
          data: {
            version: 1,
            runId: state.id,
            eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
            revision: state.revision + 2,
            decision,
          },
        },
        this.publicLedgerMessage(
          state,
          state.revision + 3,
          initial.actor,
          messageId,
          'decision',
          { taskId: task.id, decisionId },
          `${decision.summary} ${rationale}`,
        ),
      ])
      return snapshotTeamRun(this.journal.state(initial.lead))
    })
  }

  /**
   * Atomically close one fully completed and publicly reviewed run with a Lead delivery.
   * @param caller - exact live TeamRun Lead.
   * @param request - public thread, optional typed references, and final user delivery.
   * @returns committed completed snapshot containing the final delivery.
   */
  async completeRun(caller: Agent, request: CompleteTeamRunRequest): Promise<TeamRunSnapshot> {
    const initial = this.requireLead(caller)
    return this.journal.transact(initial.lead.id, async () => {
      const state = this.journal.state(initial.lead)
      const snapshot = snapshotTeamRun(state)
      if (state.phase !== 'active') {
        throw new TeamRunError(`TeamRun cannot complete while it is ${String(state.phase)}`, 'TEAM_INVALID_TRANSITION')
      }
      if (snapshot.protocol.mode === 'enforced'
        && snapshot.protocol.challenges.some(challenge => challenge.status === 'open')) {
        throw new TeamRunError('every public challenge requires a response before final delivery', 'DELIVERY_FAILED')
      }
      if (state.protocol !== undefined) {
        const incompleteExperts = expertsMissingAcceptedContribution(state)
        if (incompleteExperts.length > 0) {
          throw new TeamRunError(
            `every active expert requires an accepted artifact and routed completion evidence before final delivery: ${incompleteExperts.map(member => member.name).join(', ')}`,
            'DELIVERY_FAILED',
          )
        }
        const incompleteTasks = tasksMissingAcceptedOwnerEvidence(state)
        if (snapshot.tasks.length === 0 || incompleteTasks.length > 0) {
          throw new TeamRunError(
            `every TeamRun task requires an expert owner and that owner's accepted routed artifact before final delivery: ${incompleteTasks.map(task => task.id).join(', ')}`,
            'DELIVERY_FAILED',
          )
        }
      } else {
        const silentExperts = snapshot.members.filter(member => member.phase === 'active'
          && !snapshot.messages.some(message => message.author.role === 'expert'
            && message.author.memberId === member.id))
        if (silentExperts.length > 0) {
          throw new TeamRunError(
            `every active expert requires a public contribution before final delivery: ${silentExperts.map(member => member.name).join(', ')}`,
            'DELIVERY_FAILED',
          )
        }
        if (snapshot.tasks.length === 0 || snapshot.tasks.some(task => task.status !== 'completed')) {
          throw new TeamRunError('every TeamRun task must be completed before final delivery', 'DELIVERY_FAILED')
        }
      }
      if (snapshot.tasks.some(task => !snapshot.artifacts.some(artifact =>
        artifact.status === 'accepted' && artifact.taskIds.includes(task.id)))) {
        throw new TeamRunError('every TeamRun task requires an accepted artifact before final delivery', 'DELIVERY_FAILED')
      }
      if (state.protocol !== undefined && !hasVerifiedCompletionReview(state)) {
        throw new TeamRunError(
          'final delivery requires a completion request and a later artifact-backed review from its sole expert target',
          'DELIVERY_FAILED',
        )
      } else if (state.protocol === undefined
        && (!snapshot.messages.some(message => message.kind === 'completion_request')
          || !snapshot.messages.some(message => message.kind === 'review'))) {
        throw new TeamRunError('final delivery requires both public completion-request and review evidence', 'DELIVERY_FAILED')
      }
      if (snapshot.qualityGates.length === 0 || snapshot.qualityGates.some(gate => gate.status !== 'passed')) {
        throw new TeamRunError(
          'at least one materialized quality gate is required and every gate must pass before final delivery',
          'DELIVERY_FAILED',
        )
      }
      if (snapshot.tasks.some(task => !snapshot.decisions.some(decision =>
        decision.outcome === 'accepted'
        && decision.taskIds.includes(task.id)
        && decision.artifactIds.some(artifactId => snapshot.artifacts.some(artifact =>
          artifact.id === artifactId
          && artifact.status === 'accepted'
          && artifact.taskIds.includes(task.id)))))) {
        throw new TeamRunError(
          'every task requires an accepted Lead decision linked to one accepted task artifact',
          'DELIVERY_FAILED',
        )
      }
      if (snapshot.messages.length >= snapshot.policy.maxPublicMessages) {
        throw new TeamRunError(
          `TeamRun public message limit ${snapshot.policy.maxPublicMessages} reached`,
          'TEAM_MESSAGE_LIMIT',
        )
      }
      const content = requiredText(request.content, 'final delivery content', Number.MAX_SAFE_INTEGER)
      if (Buffer.byteLength(content, 'utf8') > snapshot.policy.maxPublicMessageBytes) {
        throw new TeamRunError(
          `final delivery exceeds ${snapshot.policy.maxPublicMessageBytes} UTF-8 bytes`,
          'TEAM_MESSAGE_TOO_LARGE',
        )
      }
      const messageId = CollaborationMessageId(`collaboration-message-${randomUUID()}`)
      const completingEventId = CollaborationEventId(`collaboration-event-${randomUUID()}`)
      const messageEventId = CollaborationEventId(`collaboration-event-${randomUUID()}`)
      const completedEventId = CollaborationEventId(`collaboration-event-${randomUUID()}`)
      await this.journal.appendBatchAndFlush(initial.lead, [
        {
          type: 'collaboration/run/phase',
          data: {
            version: 1,
            runId: state.id,
            eventId: completingEventId,
            revision: state.revision + 1,
            phase: 'completing',
          },
        },
        {
          type: 'collaboration/message',
          data: {
            version: 1,
            runId: state.id,
            eventId: messageEventId,
            revision: state.revision + 2,
            message: {
              id: messageId,
              threadId: request.threadId,
              kind: 'final_delivery',
              author: initial.actor,
              targets: [],
              references: structuredClone(request.references ?? {}),
              content,
              visibility: 'public',
            },
          },
        },
        {
          type: 'collaboration/run/phase',
          data: {
            version: 1,
            runId: state.id,
            eventId: completedEventId,
            revision: state.revision + 3,
            phase: 'completed',
          },
        },
      ])
      return snapshotTeamRun(this.journal.state(initial.lead))
    })
  }

  /** Validate a generic ledger CAS value with one stable stale-revision error. */
  private assertLedgerVersion(kind: string, id: string, expected: number, actual: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== actual) {
      throw new TeamRunError(
        `stale ${kind} "${id}" version ${String(expected)}; current version is ${String(actual)}`,
        'STALE_REVISION',
        { retryable: true, details: { id, expected, actual } },
      )
    }
  }

  /** Validate and de-duplicate current task relations. */
  private recordTaskIds(state: TeamRunFoldState, values: readonly import('./types.ts').TeamTaskId[]): import('./types.ts').TeamTaskId[] {
    const ids = [...new Set(values)]
    if (ids.length !== values.length) throw new TeamRunError('task relations must be unique', 'TEAM_INVALID_ARGUMENT')
    for (const id of ids) {
      const task = state.tasks.get(id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamRunError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
    }
    return ids
  }

  /** Validate and de-duplicate current artifact relations. */
  private recordArtifactIds(
    state: TeamRunFoldState,
    values: readonly import('./types.ts').TeamArtifactId[],
  ): import('./types.ts').TeamArtifactId[] {
    const ids = [...new Set(values)]
    if (ids.length !== values.length) throw new TeamRunError('artifact relations must be unique', 'TEAM_INVALID_ARGUMENT')
    for (const id of ids) {
      if (!state.artifacts.has(id)) throw new TeamRunError(`artifact "${id}" not found`, 'TEAM_ARTIFACT_NOT_FOUND')
    }
    return ids
  }

  /** Reserve one public-record slot before staging a formal ledger write. */
  private assertGeneratedMessageCapacity(state: TeamRunFoldState): void {
    const snapshot = snapshotTeamRun(state)
    if (snapshot.messages.length >= snapshot.policy.maxPublicMessages) {
      throw new TeamRunError(`TeamRun public message limit ${snapshot.policy.maxPublicMessages} reached`, 'TEAM_MESSAGE_LIMIT')
    }
  }

  /** Build one compact public evidence event without ledger bodies or private reasoning. */
  private publicLedgerMessage(
    state: TeamRunFoldState,
    revision: number,
    author: TeamActorRef,
    id: import('./types.ts').CollaborationMessageId,
    kind: 'artifact' | 'decision' | 'review',
    references: import('./types.ts').PublicCollaborationReferences,
    rawContent: string,
    targets: readonly TeamActorRef[] = [],
  ) {
    const content = requiredText(rawContent, 'public ledger message', Number.MAX_SAFE_INTEGER)
    if (targets.some(target => this.actorKey(target) === this.actorKey(author))) {
      throw new TeamRunError('a public ledger message cannot target its author', 'TEAM_PROTOCOL_TARGET_DENIED')
    }
    const maximum = snapshotTeamRun(state).policy.maxPublicMessageBytes
    if (Buffer.byteLength(content, 'utf8') > maximum) {
      throw new TeamRunError(`public ledger message exceeds ${maximum} UTF-8 bytes`, 'TEAM_MESSAGE_TOO_LARGE')
    }
    return {
      type: 'collaboration/message' as const,
      data: {
        version: 1 as const,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision,
        message: {
          id,
          threadId: MAIN_TEAM_THREAD_ID,
          kind,
          author,
          targets,
          references,
          content,
          visibility: 'public' as const,
        },
      },
    }
  }

  /** Settle one provisioning row, or record one active runtime expert failure before terminal delivery. */
  private async settleExpert(
    caller: Agent,
    request: SucceedExpertProvisionRequest,
    failure: TeamFailure | undefined,
  ): Promise<TeamMemberSnapshot> {
    return this.transactLeadRevision(caller, request.expectedRevision, async (lead, state) => {
      const memberId = state.memberIdsByAttempt.get(request.attemptId)
      const current = memberId === undefined ? undefined : state.members.get(memberId)
      if (current === undefined) {
        throw new TeamRunError(`provisioning attempt "${request.attemptId}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      }
      const providerSettlement = (state.phase === 'provisioning' || state.phase === 'active')
        && current.phase === 'provisioning'
      const runtimeFailure = failure !== undefined
        && (state.phase === 'provisioning' || state.phase === 'active' || state.phase === 'completing')
        && current.phase === 'active'
      if (!providerSettlement && !runtimeFailure) {
        throw new TeamRunError(`attempt "${request.attemptId}" is already ${current.phase}`, 'TEAM_INVALID_TRANSITION')
      }
      const member: TeamMemberSnapshot = {
        ...current,
        phase: failure === undefined ? 'active' : 'failed',
        ...failure === undefined ? {} : { failure: this.failure(failure) },
      }
      await this.appendMember(lead, state, member)
      return structuredClone(committedValue(
        this.journal.state(lead).members.get(member.id),
        `expert "${member.id}"`,
      ))
    })
  }

  /** Serialize one Lead-only command and enforce its run-level CAS inside the queue. */
  private async transactLeadRevision<T>(
    caller: Agent,
    expectedRevision: number,
    operation: (lead: Agent, state: TeamRunFoldState) => Promise<T>,
  ): Promise<T> {
    const { lead } = this.requireLead(caller)
    return this.journal.transact(lead.id, async () => {
      const state = this.journal.state(lead)
      this.assertRunRevision(state, expectedRevision)
      return operation(lead, state)
    })
  }

  /** Append one full member value after command-level validation. */
  private async appendMember(lead: Agent, state: TeamRunFoldState, member: TeamMemberSnapshot): Promise<void> {
    await this.journal.appendAndFlush(lead, 'collaboration/member', {
      version: 1,
      runId: state.id,
      eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
      revision: state.revision + 1,
      member,
    })
  }

  /** Resolve the exact live Lead and caller membership. */
  private authority(caller: Agent): { lead: Agent; membership: TeamMembership } {
    this.assertLive(caller)
    const ownState = this.journal.state(caller)
    if (ownState.created !== undefined) {
      return { lead: caller, membership: resolveMembership(ownState, caller.id) }
    }
    const parentId = caller.session.header.parentSession
    const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (lead === undefined) throw new TeamRunError(`TeamRun for agent "${caller.id}" not found`, 'TEAM_NOT_FOUND')
    return { lead, membership: resolveMembership(this.journal.state(lead), caller.id) }
  }

  /** Resolve and require the exact live Lead. */
  private requireLead(caller: Agent): {
    lead: Agent
    actor: Extract<TeamActorRef, { readonly role: 'lead' }>
  } {
    const { lead, membership } = this.authority(caller)
    if (membership.actor.role !== 'lead') {
      throw new TeamRunError('operation requires the TeamRun Lead', 'TEAM_LEAD_REQUIRED')
    }
    return { lead, actor: membership.actor }
  }

  /** Reject stale Agent instances used as authority credentials. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new TeamRunError(`agent "${agent.id}" is not the exact live Agent`, 'TEAM_NOT_MEMBER')
    }
  }

  /** Require run-level compare-and-set revision equality. */
  private assertRunRevision(state: TeamRunFoldState, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
      throw new TeamRunError(
        `stale TeamRun revision ${expectedRevision}; current revision is ${state.revision}`,
        'STALE_REVISION',
        { retryable: true, details: { expected: expectedRevision, actual: state.revision } },
      )
    }
  }

  /** Validate one non-terminal lifecycle command before append. */
  private assertPhaseChange(state: TeamRunFoldState, phase: ChangeTeamRunPhaseRequest['phase']): void {
    const snapshot = snapshotTeamRun(state)
    const exactReady = snapshot.expertCounts.active === snapshot.plannedExperts
      && snapshot.expertCounts.provisioning === 0
    const allowed = (state.phase === 'profiling' && phase === 'planning')
      || (state.phase === 'planning' && phase === 'provisioning')
      || (state.phase === 'provisioning' && phase === 'active' && exactReady)
      || (state.phase === 'active' && phase === 'completing' && exactReady)
      || (state.phase === 'completing' && phase === 'completed' && exactReady)
    if (!allowed) {
      throw new TeamRunError(
        `invalid TeamRun ${String(state.phase)} -> ${phase} transition with ${snapshot.expertCounts.active}/${snapshot.plannedExperts} active experts`,
        'TEAM_INVALID_TRANSITION',
      )
    }
  }

  /** Validate one explicit terminal command and its phase-specific failure code. */
  private assertTermination(state: TeamRunFoldState, request: TerminateTeamRunRequest): TeamFailure {
    const phase = state.phase
    const snapshot = snapshotTeamRun(state)
    const failure = this.failure(request.failure)
    const formationPhase = phase === 'profiling' || phase === 'planning' || phase === 'provisioning'
    const allowed = request.terminalPhase === 'formation_failed'
      ? formationPhase && snapshot.expertCounts.active < snapshot.plannedExperts
      : request.terminalPhase === 'failed'
        ? phase === 'active' || phase === 'completing'
        : phase !== 'completed' && phase !== 'formation_failed' && phase !== 'failed' && phase !== 'cancelled'
    const correctCode = request.terminalPhase === 'formation_failed'
      ? failure.code === 'FORMATION_FAILED'
      : request.terminalPhase === 'cancelled'
        ? failure.code === 'TEAM_CANCELLED'
        : failure.code !== 'FORMATION_FAILED' && failure.code !== 'TEAM_CANCELLED'
    if (!allowed || !correctCode) {
      throw new TeamRunError(
        `invalid TeamRun ${String(phase)} -> ${request.terminalPhase} terminal transition or failure code`,
        'TEAM_INVALID_TRANSITION',
      )
    }
    return failure
  }

  /** Validate public-message bounds, lifecycle, references, and Lead-only delivery. */
  private assertMessageAdmission(
    state: TeamRunFoldState,
    author: TeamActorRef,
    request: PublishCollaborationMessageRequest,
    targets: readonly TeamActorRef[],
  ): void {
    const snapshot = snapshotTeamRun(state)
    if (snapshot.messages.length >= snapshot.policy.maxPublicMessages) {
      throw new TeamRunError(
        `TeamRun public message limit ${snapshot.policy.maxPublicMessages} reached`,
        'TEAM_MESSAGE_LIMIT',
      )
    }
    const content = requiredText(request.content, 'public message content', Number.MAX_SAFE_INTEGER)
    if (Buffer.byteLength(content, 'utf8') > snapshot.policy.maxPublicMessageBytes) {
      throw new TeamRunError(
        `public message exceeds ${snapshot.policy.maxPublicMessageBytes} UTF-8 bytes`,
        'TEAM_MESSAGE_TOO_LARGE',
      )
    }
    const executionMessage = request.kind !== 'status'
    if ((executionMessage && state.phase !== 'active' && state.phase !== 'completing')
      || state.phase === 'completed' || state.phase === 'formation_failed'
      || state.phase === 'failed' || state.phase === 'cancelled') {
      throw new TeamRunError(
        `${request.kind} cannot publish while TeamRun is ${String(state.phase)}`,
        'TEAM_INVALID_TRANSITION',
      )
    }
    if (request.kind === 'final_delivery' && (author.role !== 'lead' || state.phase !== 'completing')) {
      throw new TeamRunError('final_delivery requires the Lead during completing', 'TEAM_LEAD_REQUIRED')
    }
    if (author.role === 'expert'
      && (request.kind === 'decision' || request.kind === 'artifact' || request.kind === 'final_delivery')) {
      throw new TeamRunError(`${request.kind} is owned by the TeamRun Lead ledger`, 'TEAM_LEAD_REQUIRED')
    }
    if (request.kind === 'decision' || request.kind === 'artifact' || request.kind === 'final_delivery') {
      throw new TeamRunError(`${request.kind} must be emitted by its authoritative ledger operation`, 'TEAM_INVALID_ARGUMENT')
    }
    if (request.kind !== 'status' && targets.length !== 1) {
      throw new TeamRunError(
        `${request.kind} requires exactly one explicit recipient`,
        'TEAM_PROTOCOL_TARGET_DENIED',
      )
    }
    if (targets.some(target => this.actorKey(target) === this.actorKey(author))) {
      throw new TeamRunError('a public collaboration message cannot target its author', 'TEAM_PROTOCOL_TARGET_DENIED')
    }
    this.assertProtocolAdmission(state, author, request, targets)
    const taskId = request.references?.taskId
    if (taskId !== undefined) {
      const task = state.tasks.get(taskId)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamRunError(`referenced task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
    }
  }

  /** Enforce the persisted expert budget, capabilities, topology, and challenge state. */
  private assertProtocolAdmission(
    state: TeamRunFoldState,
    author: TeamActorRef,
    request: PublishCollaborationMessageRequest,
    targets: readonly TeamActorRef[],
  ): void {
    const protocol = state.protocol
    if (protocol === undefined) return
    const leadId = snapshotTeamRun(state).lead.sessionId
    const member = author.role === 'expert' ? state.members.get(author.memberId) : undefined
    const rule = protocol.experts.find(candidate => candidate.slotId === member?.protocolSlotId)
    if (author.role === 'expert') {
      if (rule === undefined) throw new TeamRunError('expert is not bound to the collaboration protocol', 'TEAM_PROTOCOL_REQUIRED')
      const used = [...state.messages.values()].filter(message =>
        message.author.role === 'expert' && message.author.memberId === author.memberId).length
      if (used >= protocol.maxMessagesPerExpert) {
        throw new TeamRunError(
          `expert "${author.name}" exhausted its ${String(protocol.maxMessagesPerExpert)} public messages`,
          'TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED',
          { details: { memberId: author.memberId, used, limit: protocol.maxMessagesPerExpert } },
        )
      }
      const allowedKind = request.kind === 'challenge' ? rule.permissions.challenge
        : request.kind === 'review' ? rule.permissions.review
          : request.kind === 'request_help' ? rule.permissions.requestHelp : true
      if (!allowedKind) {
        throw new TeamRunError(`expert "${author.name}" cannot publish ${request.kind}`, 'TEAM_PROTOCOL_PERMISSION_DENIED')
      }
      const allowed = new Set<string>([`lead:${leadId}`])
      for (const slotId of rule.allowedTargetSlotIds) {
        const target = [...state.members.values()].filter(candidate => candidate.protocolSlotId === slotId).at(-1)
        if (target?.phase === 'active') allowed.add(`expert:${target.id}`)
      }
      const addressed = targets.length > 0 ? targets : [
        { role: 'lead', sessionId: leadId, name: 'lead' } as const,
        ...[...state.members.values()].filter(candidate => candidate.phase === 'active' && candidate.id !== author.memberId)
          .map(candidate => ({ role: 'expert' as const, memberId: candidate.id, sessionId: candidate.sessionId, name: candidate.name })),
      ]
      if (addressed.some(target => !allowed.has(this.actorKey(target)))) {
        throw new TeamRunError(`expert "${author.name}" addressed a target denied by ${protocol.topology}`, 'TEAM_PROTOCOL_TARGET_DENIED')
      }
    }
    const challengeId = request.references?.challengeId
    if (request.kind !== 'challenge' && request.kind !== 'response') {
      if (challengeId !== undefined) {
        throw new TeamRunError(`${request.kind} cannot reference a challenge`, 'TEAM_CHALLENGE_INVALID')
      }
      return
    }
    const [target] = targets
    if (challengeId === undefined || targets.length !== 1 || target === undefined) {
      throw new TeamRunError(`${request.kind} requires one challenge id and one explicit target`, 'TEAM_CHALLENGE_INVALID')
    }
    const challenge = [...state.messages.values()].find(message =>
      message.kind === 'challenge' && message.references.challengeId === challengeId)
    if (request.kind === 'challenge') {
      const priorInThread = [...state.messages.values()].filter(message =>
        message.kind === 'challenge' && message.threadId === request.threadId).at(-1)
      if (priorInThread !== undefined && ![...state.messages.values()].some(message =>
        message.kind === 'response' && message.references.challengeId === priorInThread.references.challengeId)) {
        throw new TeamRunError('the prior challenge round must be answered before another begins', 'TEAM_CHALLENGE_INVALID')
      }
      const round = [...state.messages.values()].filter(message =>
        message.kind === 'challenge' && message.threadId === request.threadId).length + 1
      if (round > protocol.maxChallengeRounds) {
        throw new TeamRunError(`challenge thread reached ${String(protocol.maxChallengeRounds)} rounds`, 'TEAM_CHALLENGE_ROUND_LIMIT')
      }
      if (challenge !== undefined || this.actorKey(author) === this.actorKey(target)) {
        throw new TeamRunError('challenge id is reused or targets its author', 'TEAM_CHALLENGE_INVALID')
      }
      return
    }
    const responded = [...state.messages.values()].some(message =>
      message.kind === 'response' && message.references.challengeId === challengeId)
    if (challenge === undefined || challenge.threadId !== request.threadId || responded) {
      throw new TeamRunError('response does not match one open challenge and its participants', 'TEAM_CHALLENGE_INVALID')
    }
    const [challengeTarget] = challenge.targets
    if (challengeTarget === undefined || this.actorKey(author) !== this.actorKey(challengeTarget)
      || this.actorKey(target) !== this.actorKey(challenge.author)) {
      throw new TeamRunError('response does not match one open challenge and its participants', 'TEAM_CHALLENGE_INVALID')
    }
  }

  private actorKey(actor: TeamActorRef): string {
    return actor.role === 'lead' ? `lead:${actor.sessionId}` : `expert:${actor.memberId}`
  }

  private validateProtocol(state: TeamRunFoldState, request: MaterializeTeamProtocolRequest) {
    if (state.protocol === undefined && state.phase !== 'planning' && state.phase !== 'provisioning') {
      throw new TeamRunError(`protocol cannot materialize while TeamRun is ${String(state.phase)}`, 'TEAM_INVALID_TRANSITION')
    }
    if (!Number.isSafeInteger(request.maxChallengeRounds) || request.maxChallengeRounds < 1
      || !Number.isSafeInteger(request.maxMessagesPerExpert) || request.maxMessagesPerExpert < 1
      || request.experts.length !== state.created?.plannedExperts) {
      throw new TeamRunError('protocol limits and expert count must match the TeamRun plan', 'TEAM_INVALID_ARGUMENT')
    }
    const experts = request.experts.map(rule => ({
      slotId: TeamProtocolSlotId(requiredText(rule.slotId, 'protocol slot id', 100)),
      initialMemberId: rule.initialMemberId,
      name: expertName(rule.name),
      permissions: structuredClone(rule.permissions),
      allowedTargetSlotIds: [...rule.allowedTargetSlotIds],
    }))
    const slots = new Set(experts.map(rule => rule.slotId))
    if (slots.size !== experts.length
      || new Set(experts.map(rule => rule.initialMemberId)).size !== experts.length
      || new Set(experts.map(rule => rule.name)).size !== experts.length
      || experts.some(rule => new Set(rule.allowedTargetSlotIds).size !== rule.allowedTargetSlotIds.length
        || rule.allowedTargetSlotIds.includes(rule.slotId)
        || rule.allowedTargetSlotIds.some(slotId => !slots.has(slotId)))) {
      throw new TeamRunError('protocol expert identities and routes must be unique and closed over the roster', 'TEAM_INVALID_ARGUMENT')
    }
    return {
      topology: request.topology,
      maxChallengeRounds: request.maxChallengeRounds,
      maxMessagesPerExpert: request.maxMessagesPerExpert,
      experts,
    }
  }

  /** Reject reused immutable attempt identities with stable codes. */
  private assertUniqueAttempt(state: TeamRunFoldState, member: TeamMemberSnapshot): void {
    if (state.memberIdsByName.has(member.name)) {
      throw new TeamRunError(`expert name "${member.name}" was already used`, 'TEAM_MEMBER_NAME_TAKEN')
    }
    if (state.members.has(member.id)) {
      throw new TeamRunError(`expert member id "${member.id}" was already used`, 'TEAM_MEMBER_ID_TAKEN')
    }
    if (state.memberIdsByAttempt.has(member.attemptId)) {
      throw new TeamRunError(`attempt id "${member.attemptId}" was already used`, 'TEAM_ATTEMPT_ID_TAKEN')
    }
    if (state.memberIdsBySession.has(member.sessionId)) {
      throw new TeamRunError(`expert Session "${member.sessionId}" was already used`, 'TEAM_SESSION_ID_TAKEN')
    }
  }

  /** Normalize and detach a structured failure before persistence. */
  private failure(failure: TeamFailure): TeamFailure {
    const value: unknown = failure
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TeamRunError('failure must be a structured object', 'TEAM_INVALID_ARGUMENT')
    }
    const record = value as Record<string, unknown>
    if (!isCollaborationErrorCode(record['code'])
      || typeof record['message'] !== 'string'
      || typeof record['retryable'] !== 'boolean'
      || record['details'] === null
      || typeof record['details'] !== 'object'
      || Array.isArray(record['details'])) {
      throw new TeamRunError('failure has an invalid code, message, retryable flag, or details object', 'TEAM_INVALID_ARGUMENT')
    }
    const details = Object.entries(record['details'] as Record<string, unknown>)
    if (details.length > 64 || details.some(([key, detail]) => key.length === 0 || key.length > 128
      || (detail !== null && typeof detail !== 'string' && typeof detail !== 'number' && typeof detail !== 'boolean')
      || (typeof detail === 'number' && !Number.isFinite(detail)))) {
      throw new TeamRunError('failure details must contain at most 64 bounded scalar entries', 'TEAM_INVALID_ARGUMENT')
    }
    return {
      code: record['code'],
      message: requiredText(record['message'], 'failure message', 4_096),
      retryable: record['retryable'],
      details: Object.fromEntries(details) as Record<string, import('./types.ts').TeamFailureDetailValue>,
    }
  }
}

export default TeamRunService
