/** Languages supported by the collaboration console. */
export type CollaborationLanguage = 'zh' | 'en'

/** Stable TeamRun id. The TeamRun is also the lead session. */
export type CollaborationRunId = string

/** Authoritative lifecycle state reported by collaboration runtime. */
export type CollaborationRunStatus =
  | 'forming'
  | 'running'
  | 'blocked'
  | 'reviewing'
  | 'reworking'
  | 'completed'
  | 'team_formation_failed'
  | 'failed'
  | 'cancelled'

/** Current orchestration phase reported by collaboration runtime. */
export type CollaborationRunPhase =
  | 'profiling'
  | 'planning'
  | 'provisioning'
  | 'active'
  | 'completing'
  | 'completed'
  | 'formation_failed'
  | 'failed'
  | 'cancelled'

/** Runtime-enforced expert-count band. */
export type CollaborationComplexity = 'simple' | 'medium' | 'complex'
/** User-visible collaboration topology committed in the charter. */
export type CollaborationTopology = 'producer_reviewer' | 'centralized' | 'parallel' | 'hybrid' | 'grouped'
/** Public lifecycle of one roster member attempt. */
export type CollaborationMemberPhase = 'planned' | 'provisioning' | 'active' | 'failed'
/** Three-level profiler signal. */
export type CollaborationLevel = 'low' | 'medium' | 'high'

/** Public failure details safe to show outside the orchestration boundary. */
export interface CollaborationFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: string
}

/** Task Profiler output. */
export interface CollaborationTaskProfile {
  readonly complexity: CollaborationComplexity
  readonly decomposability: CollaborationLevel
  readonly toolDensity: CollaborationLevel
  readonly risk: CollaborationLevel
  readonly sequentialDependencies: boolean
  readonly rationale: string
}

/** Team Planner and Charter output. */
export interface CollaborationTeamCharter {
  readonly objective: string
  readonly successCriteria: readonly string[]
  readonly topology: CollaborationTopology
  readonly communicationRules: readonly string[]
  readonly qualityChecks: readonly string[]
  readonly budget: {
    readonly maxExperts: number
    readonly maxDiscussionRounds: number
    readonly maxTokens: number
  }
  readonly terminationPolicy: string
}

/** Capability metadata explicitly allowlisted for UI rendering. */
export interface CollaborationSafeCapabilityMetadata {
  readonly id: string
  readonly label: string
}

/** Immutable expert binding projected without paths, secrets, digests, or prompts. */
export interface CollaborationSafeExpertBindingMetadata {
  readonly blueprint: {
    readonly id: string
    readonly revision: number
  }
  readonly preset: CollaborationSafeCapabilityMetadata
  readonly skills: readonly CollaborationSafeCapabilityMetadata[]
  readonly marketplaceProviders?: readonly {
    readonly source: 'smithery' | 'composio' | 'skills_sh'
    readonly state: 'ready' | 'authorization_required' | 'unavailable'
  }[]
  readonly marketplaceSkills?: readonly (CollaborationSafeCapabilityMetadata & {
    readonly source: 'smithery' | 'composio' | 'skills_sh'
    readonly kind: 'remote_tool' | 'method_skill'
    readonly status: 'loaded' | 'connected' | 'authorization_required'
    readonly access?: 'public' | 'platform' | 'user'
  })[]
  readonly plugins: readonly CollaborationSafeCapabilityMetadata[]
}

/** Lead identity and product role shown in the roster. */
export interface CollaborationLeadMember {
  readonly sessionId: string
  readonly name: string
  readonly role: string
}

/** One immutable child provisioning attempt. Failed attempts remain visible. */
export interface CollaborationExpertMember {
  readonly id: string
  readonly sessionId: string | null
  readonly name: string
  readonly role: string
  readonly phase: CollaborationMemberPhase
  readonly binding: CollaborationSafeExpertBindingMetadata
  readonly failure?: CollaborationFailure
}

/** Aggregate expert counts derived from the authoritative roster. */
export interface CollaborationExpertCounts {
  readonly planned: number
  readonly provisioning: number
  readonly active: number
  readonly failed: number
  readonly attempts: number
}

/** Public identity projected for task ownership and collaboration messages. */
export interface CollaborationActor {
  readonly role: 'lead' | 'expert'
  readonly memberId?: string
  readonly name: string
  readonly sessionId: string
}

/** Mutable task-ledger entry materialized from the immutable Team Charter DAG. */
export interface CollaborationTask {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly owner: CollaborationActor | null
  readonly blockedBy: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly ready: boolean
  readonly resourceConflicts: readonly string[]
}

/** Public collaboration-message vocabulary. Private reasoning is never projected. */
export type CollaborationMessageKind =
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

/** Optional typed references carried by one public collaboration message. */
export interface CollaborationMessageReferences {
  readonly taskId?: string
  readonly challengeId?: string
  readonly decisionId?: string
  readonly artifactId?: string
}

/** One cursor-ordered, public-only collaboration event. */
export interface CollaborationTimelineEvent {
  readonly id: string
  readonly eventId: string
  readonly cursor: number
  readonly threadId: string
  readonly kind: CollaborationMessageKind
  readonly author: CollaborationActor
  readonly targets: readonly CollaborationActor[]
  readonly references: CollaborationMessageReferences
  readonly content: string
  readonly createdAt: number
  readonly visibility: 'public'
}

/** Versioned deliverable category published on the authoritative Team Blackboard. */
export type CollaborationArtifactKind =
  | 'document'
  | 'code'
  | 'dataset'
  | 'evidence'
  | 'analysis'
  | 'product_spec'
  | 'design'
  | 'test_report'
  | 'final_delivery'

/** Review state of one immutable artifact version. */
export type CollaborationArtifactStatus = 'draft' | 'review' | 'accepted' | 'superseded'

/** One versioned artifact metadata record. Artifact bodies are fetched through a separate read capability. */
export interface CollaborationArtifact {
  readonly id: string
  readonly version: number
  readonly kind: CollaborationArtifactKind
  readonly title: string
  readonly status: CollaborationArtifactStatus
  readonly author: CollaborationActor
  readonly taskIds: readonly string[]
  readonly mediaType: string
  readonly updatedAt: number
}

/** Lead decision state retained in the authoritative decision ledger. */
export type CollaborationDecisionOutcome =
  | 'accepted'
  | 'rejected'
  | 'revise'
  | 'unresolved'
  | 'reassign'
  | 'rework'
  | 'replan'

/** One versioned Lead decision and its task and artifact provenance. */
export interface CollaborationDecision {
  readonly id: string
  readonly version: number
  readonly subject: string
  readonly outcome: CollaborationDecisionOutcome
  readonly summary: string
  readonly rationale: string
  readonly taskIds: readonly string[]
  readonly artifactIds: readonly string[]
  readonly lead: CollaborationActor
  readonly createdAt: number
}

/** Quality-gate state retained independently from public discussion messages. */
export type CollaborationQualityGateStatus = 'pending' | 'passed' | 'failed'

/** One versioned review check and its authoritative task or artifact association. */
export interface CollaborationQualityGate {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly status: CollaborationQualityGateStatus
  readonly reviewer?: CollaborationActor
  readonly taskId?: string
  readonly artifactId?: string
  readonly summary: string
  readonly updatedAt: number
}

/** Lead controller health derived by orchestration, separate from actions already taken by Lead. */
export type CollaborationControllerHealth = 'healthy' | 'attention' | 'stalled' | 'reworking' | 'ready'

/** Bounded recovery action vocabulary emitted by the deterministic controller. */
export type CollaborationControllerRecommendedAction =
  | 'reassign' | 'rework' | 'replan' | 'replace_expert' | 'resolve_quality_failure'

/** Authoritative Lead coordination summary for health, interventions, and recovery guidance. */
export interface CollaborationController {
  readonly health: CollaborationControllerHealth
  readonly lastProgressAt: number
  readonly stalledTaskIds: readonly string[]
  readonly duplicateWorkCount: number
  readonly qualityFailureCount: number
  readonly recommendedActions: readonly CollaborationControllerRecommendedAction[]
  readonly actionsTaken: readonly string[]
}

/** Server-derived task and discussion progress. */
export interface CollaborationProgress {
  readonly total: number
  readonly ready: number
  readonly inProgress: number
  readonly completed: number
  readonly blocked: number
  readonly messageCount: number
  readonly artifactCount: number
  readonly decisionCount: number
  readonly qualityGatePending: number
  readonly qualityGatePassed: number
  readonly qualityGateFailed: number
}

/** Runtime-enforced public capabilities for one expert in the collaboration protocol. */
export interface CollaborationProtocolPermissions {
  readonly challenge: boolean
  readonly review: boolean
  readonly requestHelp: boolean
}

/** Authoritative per-expert message allowance and target policy. */
export interface CollaborationProtocolMember {
  readonly slotId: string
  readonly memberId: string | null
  readonly name: string
  readonly phase: 'provisioning' | 'active' | 'failed' | null
  readonly permissions: CollaborationProtocolPermissions
  readonly allowedTargets: readonly string[]
  readonly usedMessages: number
  readonly remainingMessages: number
}

/** Lifecycle of one bounded public challenge thread. */
export type CollaborationChallengeStatus = 'open' | 'responded'

/** Authoritative challenge-thread state projected without message-body inference. */
export interface CollaborationChallengeThread {
  readonly challengeId: string
  readonly threadId: string
  readonly round: number
  readonly challenger: string
  readonly target: string
  readonly status: CollaborationChallengeStatus
  readonly challengeMessageId: string
  readonly responseMessageId: string | null
}

/** Public runtime collaboration protocol and its current usage counters. */
export interface CollaborationProtocol {
  readonly mode: 'legacy' | 'enforced'
  readonly topology: CollaborationTopology | null
  readonly limits: {
    readonly maxChallengeRounds: number
    readonly maxMessagesPerExpert: number
  } | null
  readonly members: readonly CollaborationProtocolMember[]
  readonly challenges: readonly CollaborationChallengeThread[]
}

/** One authoritative collaboration view. Business state is never persisted by UI. */
export interface CollaborationRunSnapshot {
  readonly id: CollaborationRunId
  readonly title: string
  readonly objective: string
  readonly language: CollaborationLanguage
  readonly status: CollaborationRunStatus
  readonly phase: CollaborationRunPhase
  readonly createdAt: number
  readonly cursor: number
  readonly profile: CollaborationTaskProfile | null
  readonly charter: CollaborationTeamCharter | null
  readonly lead: CollaborationLeadMember
  readonly experts: readonly CollaborationExpertMember[]
  readonly expertCounts: CollaborationExpertCounts
  readonly tasks: readonly CollaborationTask[]
  readonly timeline: readonly CollaborationTimelineEvent[]
  readonly artifacts: readonly CollaborationArtifact[]
  readonly decisions: readonly CollaborationDecision[]
  readonly qualityGates: readonly CollaborationQualityGate[]
  readonly controller: CollaborationController
  readonly progress: CollaborationProgress
  /** Missing on pre-P6 TeamRuns; the UI must not reconstruct it from discussion prose. */
  readonly protocol?: CollaborationProtocol
  readonly failure?: CollaborationFailure
}

/** Runtime catalog state consumed by selector Hooks. */
export type CollaborationCatalogSnapshot =
  | { readonly state: 'loading'; readonly runs: readonly CollaborationRunSnapshot[] }
  | { readonly state: 'ready'; readonly runs: readonly CollaborationRunSnapshot[] }
  | { readonly state: 'error'; readonly runs: readonly CollaborationRunSnapshot[]; readonly error: CollaborationFailure }

/** Task-composer payload accepted by automatic formation. */
export interface CreateCollaborationRunRequest {
  readonly title: string
  readonly objective: string
  readonly language: CollaborationLanguage
}

/** Framework-neutral observable used by the slot renderer to bind a selector Hook. */
export interface CollaborationSnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Runtime-facing collaboration port. */
export interface CollaborationPort {
  readonly source: CollaborationSnapshotSource<CollaborationCatalogSnapshot>
  createRun(request: CreateCollaborationRunRequest): Promise<CollaborationRunId>
  /** Create a fresh TeamRun; the failed run remains immutable for audit. */
  retryFormation(runId: CollaborationRunId): Promise<CollaborationRunId>
  terminate(runId: CollaborationRunId): Promise<void>
}

/** Display status projected for the legacy session agent overlay. */
export type CollaborationAgentStatus = 'waiting' | 'working' | 'completed'

/** One dialogue message shown in the legacy session agent overlay. */
export interface CollaborationAgentDialogue {
  readonly id: string
  readonly speaker: string
  readonly content: string
  readonly time: number
}

/** Durable work and dialogue loaded for one child session. */
export interface CollaborationAgentDetail {
  readonly work: string
  readonly dialogue: readonly CollaborationAgentDialogue[]
  readonly omittedCount: number
  readonly languageMismatch: boolean
}

/** One child session projected by the legacy session agent overlay. */
export interface CollaborationAgent {
  readonly id: string
  readonly name: string
  readonly avatar: string
  readonly responsibility: string
  readonly status: CollaborationAgentStatus
  readonly sessionId: string | null
  readonly work: string
  readonly dialogue: readonly CollaborationAgentDialogue[]
}
