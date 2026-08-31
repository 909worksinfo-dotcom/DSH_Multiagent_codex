/** Public TeamRun identities, records, commands, and durable event payloads. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identifies one explicit Lead-owned collaboration run. */
export type TeamRunId = Branded<'TeamRunId'>

/** Identifies one immutable expert roster row. */
export type TeamMemberId = Branded<'TeamMemberId'>

/** Identifies one immutable expert provisioning attempt. */
export type ProvisionAttemptId = Branded<'ProvisionAttemptId'>

/** Identifies one TeamRun task. */
export type TeamTaskId = Branded<'TeamTaskId'>

/** Identifies one public collaboration thread. */
export type TeamThreadId = Branded<'TeamThreadId'>

/** Identifies one public collaboration message. */
export type CollaborationMessageId = Branded<'CollaborationMessageId'>

/** Idempotency identity for one durable TeamRun event. */
export type CollaborationEventId = Branded<'CollaborationEventId'>

/** Identifies one challenge referenced by public messages. */
export type TeamChallengeId = Branded<'TeamChallengeId'>

/** Identifies one decision referenced by public messages. */
export type TeamDecisionId = Branded<'TeamDecisionId'>

/** Identifies one artifact referenced by public messages. */
export type TeamArtifactId = Branded<'TeamArtifactId'>

/** Identifies one materialized quality gate. */
export type TeamQualityGateId = Branded<'TeamQualityGateId'>

/** Identifies one immutable planned protocol slot across expert replacements. */
export type TeamProtocolSlotId = Branded<'TeamProtocolSlotId'>

/** Product complexity classification that fixes the legal expert-count band. */
export type TeamRunComplexity = 'simple' | 'medium' | 'complex'

/** Exact internal TeamRun lifecycle persisted in the Lead Session. */
export type TeamRunPhase =
  | 'profiling'
  | 'planning'
  | 'provisioning'
  | 'active'
  | 'completing'
  | 'completed'
  | 'formation_failed'
  | 'failed'
  | 'cancelled'

/** Host-facing status derived from the exact internal lifecycle. */
export type TeamRunPublicStatus =
  | 'forming'
  | 'running'
  | 'blocked'
  | 'reviewing'
  | 'reworking'
  | 'completed'
  | 'team_formation_failed'
  | 'failed'
  | 'cancelled'

/** Stable failure categories initially owned by collaboration runtime packages. */
export type CollaborationErrorCode =
  | 'TEAM_MEMBER_LIMIT'
  | 'TEAM_PROVISION_ATTEMPT_LIMIT'
  | 'FORMATION_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'BLUEPRINT_REVISION_MISMATCH'
  | 'RESOURCE_CONFLICT'
  | 'STALE_REVISION'
  | 'DELIVERY_FAILED'
  | 'TEAM_INVALID_ARGUMENT'
  | 'TEAM_INVALID_CONFIG'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_NOT_MEMBER'
  | 'TEAM_LEAD_REQUIRED'
  | 'TEAM_MEMBER_NOT_FOUND'
  | 'TEAM_MEMBER_NAME_TAKEN'
  | 'TEAM_MEMBER_ID_TAKEN'
  | 'TEAM_ATTEMPT_ID_TAKEN'
  | 'TEAM_SESSION_ID_TAKEN'
  | 'TEAM_INVALID_TRANSITION'
  | 'TEAM_CANCELLED'
  | 'TEAM_TASK_LIMIT'
  | 'TEAM_TASK_NOT_FOUND'
  | 'TEAM_TASK_BLOCKED'
  | 'TEAM_TASK_UNAUTHORIZED'
  | 'TEAM_TASK_INVALID_TRANSITION'
  | 'TEAM_TASK_DEPENDENCY_CYCLE'
  | 'TEAM_TASK_HAS_DEPENDENTS'
  | 'TEAM_MESSAGE_LIMIT'
  | 'TEAM_MESSAGE_TOO_LARGE'
  | 'TEAM_PROTOCOL_REQUIRED'
  | 'TEAM_PROTOCOL_PERMISSION_DENIED'
  | 'TEAM_PROTOCOL_TARGET_DENIED'
  | 'TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED'
  | 'TEAM_CHALLENGE_INVALID'
  | 'TEAM_CHALLENGE_ROUND_LIMIT'
  | 'TEAM_ARTIFACT_LIMIT'
  | 'TEAM_ARTIFACT_NOT_FOUND'
  | 'TEAM_ARTIFACT_TOO_LARGE'
  | 'TEAM_ARTIFACT_UNAUTHORIZED'
  | 'TEAM_DECISION_NOT_FOUND'
  | 'TEAM_QUALITY_GATE_NOT_FOUND'
  | 'TEAM_CONTROL_INVALID_ACTION'

/** Lossless JSON scalar values allowed in structured failure details. */
export type TeamFailureDetailValue = string | number | boolean | null

/** Structured failure committed as part of a terminal or failed-attempt event. */
export interface TeamFailure {
  /** Stable machine-readable failure category. */
  readonly code: CollaborationErrorCode
  /** User-safe explanation without private reasoning. */
  readonly message: string
  /** Whether the owning controller may retry the failed operation. */
  readonly retryable: boolean
  /** Bounded scalar diagnostics for host and UI projections. */
  readonly details: Readonly<Record<string, TeamFailureDetailValue>>
}

/** Deployment limits snapshotted into each new TeamRun for deterministic replay. */
export interface TeamRunPolicySnapshot {
  /** Maximum concurrent active plus provisioning experts; the Lead is excluded. */
  readonly maxActiveExperts: number
  /** Maximum immutable provisioning attempts retained by one run. */
  readonly maxProvisionAttempts: number
  /** Maximum current non-deleted tasks. */
  readonly maxTasks: number
  /** Maximum retained public collaboration messages. */
  readonly maxPublicMessages: number
  /** Maximum UTF-8 bytes in one public message content field. */
  readonly maxPublicMessageBytes: number
  /** Maximum retained first-class artifacts. */
  readonly maxArtifacts: number
  /** Maximum UTF-8 bytes in one artifact body. */
  readonly maxArtifactBodyBytes: number
  /** Cursor distance after which an unfinished task is reported as stalled. */
  readonly taskStallCursorThreshold: number
}

/** Cordis deployment configuration for the TeamRun service. */
export interface Config {
  /** Maximum concurrent active plus provisioning experts, from one through eight. */
  readonly maxActiveExperts?: number
  /** Maximum provisioning attempts retained by one run. */
  readonly maxProvisionAttempts?: number
  /** Maximum current non-deleted tasks. */
  readonly maxTasks?: number
  /** Maximum retained public messages. */
  readonly maxPublicMessages?: number
  /** Maximum UTF-8 bytes in one public message. */
  readonly maxPublicMessageBytes?: number
  /** Maximum retained first-class artifacts. */
  readonly maxArtifacts?: number
  /** Maximum UTF-8 bytes in one artifact body. */
  readonly maxArtifactBodyBytes?: number
  /** Cursor distance after which an unfinished task is reported as stalled. */
  readonly taskStallCursorThreshold?: number
}

/** Supported first-class artifact categories. */
export type TeamArtifactKind =
  | 'document'
  | 'code'
  | 'dataset'
  | 'evidence'
  | 'analysis'
  | 'product_spec'
  | 'design'
  | 'test_report'
  | 'final_delivery'

/** Review lifecycle for one versioned artifact. */
export type TeamArtifactStatus = 'draft' | 'review' | 'accepted' | 'superseded'

/** Safe artifact metadata included in compact run projections. */
export interface TeamArtifactSnapshot {
  readonly id: TeamArtifactId
  readonly version: number
  readonly kind: TeamArtifactKind
  readonly title: string
  readonly status: TeamArtifactStatus
  readonly author: TeamActorRef
  readonly taskIds: readonly TeamTaskId[]
  readonly mediaType: string
  readonly updatedAt: number
}

/** Complete artifact returned only by the restricted read operation. */
export interface TeamArtifactRecord extends TeamArtifactSnapshot {
  readonly body: string
}

/** Lead arbitration outcomes, including control actions. */
export type TeamDecisionOutcome =
  | 'accepted'
  | 'rejected'
  | 'revise'
  | 'unresolved'
  | 'reassign'
  | 'rework'
  | 'replan'

/** Independent Lead-owned decision ledger row. */
export interface TeamDecisionRecord {
  readonly id: TeamDecisionId
  readonly version: number
  readonly subject: string
  readonly outcome: TeamDecisionOutcome
  readonly summary: string
  readonly rationale: string
  readonly taskIds: readonly TeamTaskId[]
  readonly artifactIds: readonly TeamArtifactId[]
  readonly lead: Extract<TeamActorRef, { readonly role: 'lead' }>
  readonly createdAt: number
}

/** Materialized quality-gate lifecycle. */
export type TeamQualityGateStatus = 'pending' | 'passed' | 'failed'

/** Independent quality-gate ledger row. */
export interface TeamQualityGateRecord {
  readonly id: TeamQualityGateId
  readonly version: number
  readonly name: string
  readonly status: TeamQualityGateStatus
  readonly reviewer?: TeamActorRef
  readonly taskId?: TeamTaskId
  readonly artifactId?: TeamArtifactId
  readonly summary: string
  readonly updatedAt: number
}

/** One deterministic Lead Controller recommendation. */
export type TeamControllerRecommendedAction =
  | 'reassign'
  | 'rework'
  | 'replan'
  | 'replace_expert'
  | 'resolve_quality_failure'

/** Deterministic controller projection derived only from the durable log and run policy. */
export interface TeamControllerSnapshot {
  readonly health: 'healthy' | 'attention' | 'stalled' | 'reworking' | 'ready'
  readonly lastProgressAt: number
  readonly stalledTaskIds: readonly TeamTaskId[]
  readonly duplicateWorkCount: number
  readonly qualityFailureCount: number
  readonly recommendedActions: readonly TeamControllerRecommendedAction[]
  readonly actionsTaken: readonly TeamDecisionId[]
}

/** Immutable actor reference stored in tasks and public messages. */
export type TeamActorRef =
  | { readonly role: 'lead'; readonly sessionId: SessionId; readonly name: 'lead' }
  | {
    readonly role: 'expert'
    readonly memberId: TeamMemberId
    readonly sessionId: SessionId
    readonly name: string
  }

/** Durable lifecycle of one expert provisioning attempt. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Complete immutable-identity expert row retained for audit after failure. */
export interface TeamMemberSnapshot {
  /** Stable roster identity. */
  readonly id: TeamMemberId
  /** Stable child Session identity reserved before provider work begins. */
  readonly sessionId: SessionId
  /** Stable model-facing expert name. */
  readonly name: string
  /** User-safe expert responsibility. */
  readonly role: string
  /** Planned protocol slot retained across replacement attempts. */
  readonly protocolSlotId?: TeamProtocolSlotId
  /** Immutable provisioning attempt identity. */
  readonly attemptId: ProvisionAttemptId
  /** Contiguous one-based attempt number. */
  readonly attemptNumber: number
  /** Current attempt lifecycle. */
  readonly phase: TeamMemberPhase
  /** Required failure for a failed attempt. */
  readonly failure?: TeamFailure
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Complete task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  /** Team-local task identity. */
  readonly id: TeamTaskId
  /** One-based compare-and-set revision. */
  readonly revision: number
  /** Concise user-safe task title. */
  readonly subject: string
  /** Complete task objective and acceptance information. */
  readonly description: string
  /** Current task lifecycle. */
  readonly status: TeamTaskStatus
  /** Current owner, absent while unclaimed. */
  readonly owner?: TeamActorRef
  /** Tasks that must complete before this task becomes ready. */
  readonly blockedBy: readonly TeamTaskId[]
  /** Generic advisory resource ownership prefixes. */
  readonly resourceScopes: readonly string[]
}

/** Task projection with readiness and advisory conflict diagnostics. */
export interface TeamTaskView extends TeamTaskSnapshot {
  /** Whether a pending task has no incomplete dependency. */
  readonly ready: boolean
  /** Current in-progress tasks whose generic resource scopes overlap. */
  readonly resourceConflicts: readonly TeamTaskId[]
}

/** Typed public statement categories visible to users and peer agents. */
export type PublicCollaborationMessageKind =
  | 'task'
  | 'inform'
  | 'proposal'
  | 'request_help'
  | 'challenge'
  | 'response'
  | 'review'
  | 'decision'
  | 'handoff'
  | 'blocked'
  | 'completion_request'
  | 'artifact'
  | 'status'
  | 'final_delivery'

/** Optional typed references carried by a public collaboration message. */
export interface PublicCollaborationReferences {
  /** Related task. */
  readonly taskId?: TeamTaskId
  /** Related challenge. */
  readonly challengeId?: TeamChallengeId
  /** Related decision. */
  readonly decisionId?: TeamDecisionId
  /** Related artifact. */
  readonly artifactId?: TeamArtifactId
}

/** Complete user-visible collaboration message derived from one durable event. */
export interface PublicCollaborationMessage {
  /** Stable public message identity. */
  readonly id: CollaborationMessageId
  /** Idempotent durable event identity. */
  readonly eventId: CollaborationEventId
  /** Session-log sequence used as the reconnect cursor. */
  readonly sequence: number
  /** Owning TeamRun. */
  readonly runId: TeamRunId
  /** Public discussion thread. */
  readonly threadId: TeamThreadId
  /** Message category. */
  readonly kind: PublicCollaborationMessageKind
  /** Author validated against the current roster. */
  readonly author: TeamActorRef
  /** Explicit public recipients; an empty list addresses the whole team. */
  readonly targets: readonly TeamActorRef[]
  /** Optional typed relations to collaboration records. */
  readonly references: PublicCollaborationReferences
  /** User-safe public content; private reasoning has no representation in this type. */
  readonly content: string
  /** Unix epoch milliseconds from the durable event envelope. */
  readonly createdAt: number
  /** Visibility fixed before persistence. */
  readonly visibility: 'public'
}

/** Collaboration topology fixed by the durable Team Charter. */
export type TeamCollaborationTopology =
  | 'producer_reviewer'
  | 'centralized'
  | 'parallel'
  | 'hybrid'
  | 'grouped'

/** Runtime-enforced public collaboration capabilities for one planned expert slot. */
export interface TeamProtocolPermissions {
  readonly challenge: boolean
  readonly review: boolean
  readonly requestHelp: boolean
}

/** Immutable protocol rule committed for one planned expert slot. */
export interface TeamProtocolExpertRule {
  readonly slotId: TeamProtocolSlotId
  readonly initialMemberId: TeamMemberId
  readonly name: string
  readonly permissions: TeamProtocolPermissions
  readonly allowedTargetSlotIds: readonly TeamProtocolSlotId[]
}

/** Exact protocol input persisted before a product TeamRun becomes active. */
export interface TeamProtocolRecord {
  readonly topology: TeamCollaborationTopology
  readonly maxChallengeRounds: number
  readonly maxMessagesPerExpert: number
  readonly experts: readonly TeamProtocolExpertRule[]
}

/** Authoritative per-member protocol usage and routing projection. */
export interface TeamProtocolMemberView {
  readonly slotId: TeamProtocolSlotId
  readonly memberId: TeamMemberId | null
  readonly name: string
  readonly phase: TeamMemberPhase | null
  readonly permissions: TeamProtocolPermissions
  readonly allowedTargets: readonly string[]
  readonly usedMessages: number
  readonly remainingMessages: number
}

/** Deterministic public state of one challenge-response pair. */
export interface TeamChallengeView {
  readonly challengeId: TeamChallengeId
  readonly threadId: TeamThreadId
  readonly round: number
  readonly challenger: string
  readonly target: string
  readonly status: 'open' | 'responded'
  readonly challengeMessageId: CollaborationMessageId
  readonly responseMessageId: CollaborationMessageId | null
}

/** Stable protocol projection; legacy runs retain their original unbounded admission behavior. */
export interface TeamProtocolSnapshot {
  readonly mode: 'legacy' | 'enforced'
  readonly topology: TeamCollaborationTopology | null
  readonly limits: {
    readonly maxChallengeRounds: number
    readonly maxMessagesPerExpert: number
  } | null
  readonly members: readonly TeamProtocolMemberView[]
  readonly challenges: readonly TeamChallengeView[]
}

/** Derived expert counts that always exclude the Lead. */
export interface TeamExpertCounts {
  /** Exact expert target selected within the complexity band. */
  readonly planned: number
  /** Current provisioning attempts occupying capacity. */
  readonly provisioning: number
  /** Current active experts occupying capacity. */
  readonly active: number
  /** Failed attempts retained for audit but not capacity. */
  readonly failed: number
  /** Total immutable provisioning attempts. */
  readonly attempts: number
  /** Remaining active-plus-provisioning capacity. */
  readonly availableSlots: number
}

/** Authoritative TeamRun projection reconstructed from the Lead Session log. */
export interface TeamRunSnapshot {
  /** Explicit run identity. */
  readonly id: TeamRunId
  /** Monotonic semantic revision, excluding idempotent duplicate events. */
  readonly revision: number
  /** Session-log cursor of the last applicable physical event. */
  readonly cursor: number
  /** Authoritative Lead, which never appears in {@link members}. */
  readonly lead: Extract<TeamActorRef, { readonly role: 'lead' }>
  /** User task objective. */
  readonly objective: string
  /** Complexity that fixes the legal expert target band. */
  readonly complexity: TeamRunComplexity
  /** Exact number of active experts required before execution. */
  readonly plannedExperts: number
  /** Limits fixed when the run was created. */
  readonly policy: TeamRunPolicySnapshot
  /** Exact durable lifecycle. */
  readonly phase: TeamRunPhase
  /** Host-facing lifecycle projection. */
  readonly status: TeamRunPublicStatus
  /** Immutable expert attempts in provisioning order. */
  readonly members: readonly TeamMemberSnapshot[]
  /** Current non-deleted tasks in creation order. */
  readonly tasks: readonly TeamTaskView[]
  /** Complete retained public collaboration timeline. */
  readonly messages: readonly PublicCollaborationMessage[]
  /** Authoritative protocol limits, routes, usage, and challenge state. */
  readonly protocol: TeamProtocolSnapshot
  /** Artifact metadata only; bodies require the restricted read operation. */
  readonly artifacts: readonly TeamArtifactSnapshot[]
  /** Independent Lead decision ledger. */
  readonly decisions: readonly TeamDecisionRecord[]
  /** Independent materialized quality-gate ledger. */
  readonly qualityGates: readonly TeamQualityGateRecord[]
  /** Deterministic Lead Controller health and recommendations. */
  readonly controller: TeamControllerSnapshot
  /** Expert-only capacity and audit counts. */
  readonly expertCounts: TeamExpertCounts
  /** Terminal failure or cancellation, when present. */
  readonly failure?: TeamFailure
}

/** Caller identity resolved against one exact live TeamRun. */
export interface TeamMembership {
  /** Owning TeamRun. */
  readonly runId: TeamRunId
  /** Current actor reference. */
  readonly actor: TeamActorRef
}

/** Input that creates a TeamRun before any expert work begins. */
export interface CreateTeamRunRequest {
  /** User task objective. */
  readonly objective: string
  /** Product complexity classification. */
  readonly complexity: TeamRunComplexity
  /** Exact expert count selected inside the classification band. */
  readonly plannedExperts: number
}

/** Input that reserves one immutable provisioning attempt before provider work. */
export interface BeginExpertProvisionRequest {
  /** Current run revision used as a compare-and-set precondition. */
  readonly expectedRevision: number
  /** Roster identity reserved before starting the child. */
  readonly memberId: TeamMemberId
  /** Child Session identity reserved before starting the child. */
  readonly sessionId: SessionId
  /** Unique immutable attempt identity. */
  readonly attemptId: ProvisionAttemptId
  /** Stable lower-kebab-case expert name. */
  readonly name: string
  /** User-safe expert responsibility. */
  readonly role: string
  /** Planned protocol slot, required when an enforced protocol exists. */
  readonly protocolSlotId?: TeamProtocolSlotId
}

/** Lead-owned input that materializes the exact Team Charter protocol once. */
export interface MaterializeTeamProtocolRequest extends TeamProtocolRecord {
  readonly expectedRevision: number
}

/** Input that settles one provisioning attempt as active. */
export interface SucceedExpertProvisionRequest {
  /** Current run revision used as a compare-and-set precondition. */
  readonly expectedRevision: number
  /** Attempt being settled. */
  readonly attemptId: ProvisionAttemptId
}

/** Input that settles one provisioning attempt or active runtime expert as failed. */
export interface FailExpertProvisionRequest extends SucceedExpertProvisionRequest {
  /** Structured provider, recovery, or active-runtime failure. */
  readonly failure: TeamFailure
}

/** Input that advances the non-terminal TeamRun lifecycle. */
export interface ChangeTeamRunPhaseRequest {
  /** Current run revision used as a compare-and-set precondition. */
  readonly expectedRevision: number
  /** Next non-terminal or successful terminal lifecycle. */
  readonly phase: 'planning' | 'provisioning' | 'active' | 'completing' | 'completed'
}

/** Lead-owned atomic completion request. */
export interface CompleteTeamRunRequest {
  /** Public thread receiving the final delivery. */
  readonly threadId: TeamThreadId
  /** Optional typed records summarized by the final delivery. */
  readonly references?: PublicCollaborationReferences
  /** User-safe complete output returned to the user. */
  readonly content: string
}

/** Create or compare-and-set one first-class artifact version. */
export interface WriteTeamArtifactRequest {
  readonly artifactId?: TeamArtifactId
  /** Zero creates; a positive value must equal the current artifact version. */
  readonly expectedVersion: number
  readonly kind: TeamArtifactKind
  readonly title: string
  readonly body: string
  readonly mediaType: string
  readonly taskIds?: readonly TeamTaskId[]
  readonly status: TeamArtifactStatus
}

/** Create or compare-and-set one Lead decision. */
export interface WriteTeamDecisionRequest {
  readonly decisionId?: TeamDecisionId
  readonly expectedVersion: number
  readonly subject: string
  readonly outcome: TeamDecisionOutcome
  readonly summary: string
  readonly rationale: string
  readonly taskIds?: readonly TeamTaskId[]
  readonly artifactIds?: readonly TeamArtifactId[]
}

/** Materialize one pending quality gate before execution. */
export interface CreateTeamQualityGateRequest {
  readonly name: string
}

/** Compare-and-set one formal quality result. */
export interface UpdateTeamQualityGateRequest {
  readonly gateId: TeamQualityGateId
  readonly expectedVersion: number
  readonly status: 'passed' | 'failed'
  readonly summary: string
  readonly taskId?: TeamTaskId
  readonly artifactId?: TeamArtifactId
}

/** Atomic Lead Controller action over one current task. */
export interface TeamControlRequest {
  readonly expectedRevision: number
  readonly taskId: TeamTaskId
  readonly expectedTaskRevision: number
  readonly action: 'reassign' | 'rework' | 'replan'
  readonly owner?: string
  readonly description?: string
  readonly rationale: string
}

/** Input that terminates formation, execution, or the complete run. */
export interface TerminateTeamRunRequest {
  /** Current run revision used as a compare-and-set precondition. */
  readonly expectedRevision: number
  /** Exact terminal lifecycle selected by the owning controller. */
  readonly terminalPhase: 'formation_failed' | 'failed' | 'cancelled'
  /** Structured terminal cause. */
  readonly failure: TeamFailure
}

/** Input for one unowned pending task. */
export interface CreateTeamTaskRequest {
  /** Task title. */
  readonly subject: string
  /** Task objective and acceptance information. */
  readonly description: string
  /** Existing non-deleted blockers. */
  readonly blockedBy?: readonly TeamTaskId[]
  /** Generic advisory ownership prefixes. */
  readonly resourceScopes?: readonly string[]
}

/** Supported compare-and-set task mutations. */
export const TEAM_TASK_ACTIONS = [
  'assign',
  'claim',
  'release',
  'edit',
  'set_dependencies',
  'complete',
  'reopen',
  'reassign',
  'delete',
] as const

/** One supported compare-and-set task mutation. */
export type TeamTaskAction = typeof TEAM_TASK_ACTIONS[number]

/** Input for one compare-and-set task mutation. */
export interface UpdateTeamTaskRequest {
  /** Task being changed. */
  readonly taskId: TeamTaskId
  /** Current task revision used as the compare-and-set precondition. */
  readonly expectedRevision: number
  /** Requested task transition. */
  readonly action: TeamTaskAction
  /** Replacement title for `edit`. */
  readonly subject?: string
  /** Replacement description for `edit`. */
  readonly description?: string
  /** Complete replacement dependencies for `set_dependencies`. */
  readonly blockedBy?: readonly TeamTaskId[]
  /** Complete replacement scopes for `edit`. */
  readonly resourceScopes?: readonly string[]
  /** Member name, `lead`, or empty to clear ownership for `reassign`; required by `assign`. */
  readonly owner?: string
}

/** Input for one public collaboration message. */
export interface PublishCollaborationMessageRequest {
  /** Public message category. */
  readonly kind: PublicCollaborationMessageKind
  /** Discussion thread. */
  readonly threadId: TeamThreadId
  /** Exactly one member name or `lead`; only runtime status may omit a recipient. */
  readonly targets?: readonly string[]
  /** Optional typed record references. */
  readonly references?: PublicCollaborationReferences
  /** User-safe public content. */
  readonly content: string
}

/** Durable TeamRun creation payload. */
export interface TeamRunCreatedEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: 1
  readonly leadId: SessionId
  readonly objective: string
  readonly complexity: TeamRunComplexity
  readonly plannedExperts: number
  readonly policy: TeamRunPolicySnapshot
}

/** Durable TeamRun lifecycle payload. */
export interface TeamRunPhaseEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly phase: Exclude<TeamRunPhase, 'profiling'>
  readonly failure?: TeamFailure
}

/** Durable full expert-attempt payload. */
export interface TeamRunMemberEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly member: TeamMemberSnapshot
}

/** Durable full task payload. */
export interface TeamRunTaskEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly task: TeamTaskSnapshot
}

/** Public message fields stored before envelope sequence and time are known. */
export interface StoredPublicCollaborationMessage {
  readonly id: CollaborationMessageId
  readonly threadId: TeamThreadId
  readonly kind: PublicCollaborationMessageKind
  readonly author: TeamActorRef
  readonly targets: readonly TeamActorRef[]
  readonly references: PublicCollaborationReferences
  readonly content: string
  readonly visibility: 'public'
}

/** Durable public collaboration message payload. */
export interface TeamRunMessageEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly message: StoredPublicCollaborationMessage
}

/** Durable exact Team Charter collaboration protocol. */
export interface TeamRunProtocolEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly protocol: TeamProtocolRecord
}

/** Durable complete artifact value; the body never enters compact projections. */
export interface TeamRunArtifactEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly artifact: Omit<TeamArtifactRecord, 'updatedAt'>
}

/** Durable independent decision ledger value. */
export interface TeamRunDecisionEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly decision: Omit<TeamDecisionRecord, 'createdAt'>
}

/** Durable complete quality-gate ledger value. */
export interface TeamRunQualityGateEventData {
  readonly version: 1
  readonly runId: TeamRunId
  readonly eventId: CollaborationEventId
  readonly revision: number
  readonly gate: Omit<TeamQualityGateRecord, 'updatedAt'>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Establishes one explicit TeamRun and its authoritative Lead before expert work;
     * required-on-read because every later collaboration record depends on this policy snapshot.
     */
    'collaboration/run/created': TeamRunCreatedEventData
    /**
     * Commits one exact TeamRun lifecycle transition and optional terminal cause;
     * required-on-read because it controls command admission and completion.
     */
    'collaboration/run/phase': TeamRunPhaseEventData
    /**
     * Commits one complete provisioning, active, or failed expert-attempt value;
     * required-on-read because roster capacity and authority derive from it.
     */
    'collaboration/member': TeamRunMemberEventData
    /**
     * Commits one complete compare-and-set task value; required-on-read because task revisions and the dependency DAG derive from it.
     */
    'collaboration/task': TeamRunTaskEventData
    /**
     * Commits one user-visible public collaboration message after visibility selection;
     * required-on-read because reconnect and delivery projections derive from it.
     */
    'collaboration/message': TeamRunMessageEventData
    /** Commits the exact runtime-enforced Team Charter protocol before activation. */
    'collaboration/protocol': TeamRunProtocolEventData
    /** Commits one complete versioned artifact, including its restricted body. */
    'collaboration/artifact': TeamRunArtifactEventData
    /** Commits one independent Lead decision. */
    'collaboration/decision': TeamRunDecisionEventData
    /** Commits one materialized quality gate or formal result. */
    'collaboration/quality-gate': TeamRunQualityGateEventData
  }
}
