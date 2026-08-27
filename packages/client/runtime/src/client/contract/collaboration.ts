/** Browser object-layer contract for authoritative multi-agent team formation. */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'

/** Product languages accepted by automatic team formation. */
export type CollaborationLanguage = 'zh' | 'en'
/** Stable browser identity for a Lead-owned TeamRun. */
export type CollaborationRunId = string
/** Runtime-enforced expert-count band selected by Task Profiler. */
export type CollaborationComplexity = 'simple' | 'medium' | 'complex'
/** Three-level profiler signal exposed without internal scoring weights. */
export type CollaborationLevel = 'low' | 'medium' | 'high'
/** Legal public collaboration topology selected for one complexity band. */
export type CollaborationTopology = 'producer_reviewer' | 'centralized' | 'parallel' | 'hybrid' | 'grouped'
/** Product lifecycle status derived from the durable TeamRun. */
export type CollaborationRunStatus =
  | 'forming' | 'running' | 'blocked' | 'reviewing' | 'reworking'
  | 'completed' | 'team_formation_failed' | 'failed' | 'cancelled'
/** Exact durable orchestration phase used for progress presentation. */
export type CollaborationRunPhase =
  | 'profiling' | 'planning' | 'provisioning' | 'active' | 'completing'
  | 'completed' | 'formation_failed' | 'failed' | 'cancelled'
/** Public lifecycle of one immutable expert attempt. */
export type CollaborationMemberPhase = 'planned' | 'provisioning' | 'active' | 'failed'
/** Public lifecycle of one materialized Team Charter workstream. */
export type CollaborationTaskStatus = 'pending' | 'in_progress' | 'completed'
/** Typed public statement categories rendered without private model reasoning. */
export type CollaborationPublicMessageKind =
  | 'task' | 'inform' | 'proposal' | 'request_help' | 'challenge' | 'response'
  | 'review' | 'decision' | 'handoff' | 'blocked' | 'completion_request'
  | 'artifact' | 'status' | 'final_delivery'

/** User-safe collaboration failure with no cause object or private configuration. */
export interface CollaborationFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: string
}

/** UI projection of Task Profiler output. */
export interface CollaborationTaskProfile {
  readonly complexity: CollaborationComplexity
  readonly decomposability: CollaborationLevel
  readonly toolDensity: CollaborationLevel
  readonly risk: CollaborationLevel
  readonly sequentialDependencies: boolean
  readonly rationale: string
}

/** UI projection of the committed Team Charter. */
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

/** Allowlisted capability identity safe to cross the browser boundary. */
export interface CollaborationSafeCapabilityMetadata {
  readonly id: string
  readonly label: string
}

/** Immutable expert composition without paths, prompts, configuration, or digests. */
export interface CollaborationSafeExpertBindingMetadata {
  readonly blueprint: { readonly id: string; readonly revision: number }
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

/** One planned or attempted expert retained in the public roster. */
export interface CollaborationExpertMember {
  readonly id: string
  readonly sessionId: string | null
  readonly name: string
  readonly role: string
  readonly phase: CollaborationMemberPhase
  readonly binding: CollaborationSafeExpertBindingMetadata
  readonly failure?: CollaborationFailure
}

/** Public Lead or expert identity attached to tasks and collaboration records. */
export interface CollaborationPublicActor {
  readonly role: 'lead' | 'expert'
  readonly memberId?: string
  readonly name: string
  readonly sessionId: string
}

/** One current task materialized from the durable Team Charter DAG. */
export interface CollaborationTask {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: CollaborationTaskStatus
  readonly owner: CollaborationPublicActor | null
  readonly blockedBy: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly ready: boolean
  readonly resourceConflicts: readonly string[]
}

/** Optional typed relations carried by one public collaboration record. */
export interface CollaborationPublicReferences {
  readonly taskId?: string
  readonly challengeId?: string
  readonly decisionId?: string
  readonly artifactId?: string
}

/** One cursor-addressed public record; private reasoning has no representation here. */
export interface CollaborationPublicMessage {
  readonly id: string
  readonly eventId: string
  readonly cursor: number
  readonly threadId: string
  readonly kind: CollaborationPublicMessageKind
  readonly author: CollaborationPublicActor
  readonly targets: readonly CollaborationPublicActor[]
  readonly references: CollaborationPublicReferences
  readonly content: string
  readonly createdAt: number
  readonly visibility: 'public'
}

/** Versioned deliverable category published on the authoritative Team Blackboard. */
export type CollaborationArtifactKind =
  | 'document' | 'code' | 'dataset' | 'evidence' | 'analysis'
  | 'product_spec' | 'design' | 'test_report' | 'final_delivery'

/** Review state of one immutable artifact version. */
export type CollaborationArtifactStatus = 'draft' | 'review' | 'accepted' | 'superseded'

/** Compact artifact metadata. The body is intentionally excluded from catalog snapshots. */
export interface CollaborationArtifact {
  readonly id: string
  readonly version: number
  readonly kind: CollaborationArtifactKind
  readonly title: string
  readonly status: CollaborationArtifactStatus
  readonly author: CollaborationPublicActor
  readonly taskIds: readonly string[]
  readonly mediaType: string
  readonly updatedAt: number
}

/** Lead decision state retained independently from public discussion messages. */
export type CollaborationDecisionOutcome =
  | 'accepted' | 'rejected' | 'revise' | 'unresolved'
  | 'reassign' | 'rework' | 'replan'

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
  readonly lead: CollaborationPublicActor
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
  readonly reviewer?: CollaborationPublicActor
  readonly taskId?: string
  readonly artifactId?: string
  readonly summary: string
  readonly updatedAt: number
}

/** Deterministic Lead-controller health derived from durable collaboration ledgers. */
export type CollaborationControllerHealth = 'healthy' | 'attention' | 'stalled' | 'reworking' | 'ready'

/** Bounded recovery action vocabulary emitted by the deterministic controller. */
export type CollaborationControllerRecommendedAction =
  | 'reassign' | 'rework' | 'replan' | 'replace_expert' | 'resolve_quality_failure'

/** Lead coordination summary without private model reasoning. */
export interface CollaborationController {
  readonly health: CollaborationControllerHealth
  readonly lastProgressAt: number
  readonly stalledTaskIds: readonly string[]
  readonly duplicateWorkCount: number
  readonly qualityFailureCount: number
  readonly recommendedActions: readonly CollaborationControllerRecommendedAction[]
  readonly actionsTaken: readonly string[]
}

/** Compact Lead progress ledger derived from the authoritative task board and event log. */
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

/** Runtime compatibility mode for one authoritative collaboration protocol. */
export type CollaborationProtocolMode = 'legacy' | 'enforced'

/** Runtime permissions committed for one expert roster slot. */
export interface CollaborationProtocolPermissions {
  readonly challenge: boolean
  readonly review: boolean
  readonly requestHelp: boolean
}

/** Per-member protocol route and persisted public-message budget. */
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

/** One persisted challenge-response thread and its current bounded round. */
export interface CollaborationProtocolChallenge {
  readonly challengeId: string
  readonly threadId: string
  readonly round: number
  readonly challenger: string
  readonly target: string
  readonly status: 'open' | 'responded'
  readonly challengeMessageId: string
  readonly responseMessageId: string | null
}

/** Authoritative protocol projection. Legacy runs never infer policy from presentation data. */
export interface CollaborationProtocol {
  readonly mode: CollaborationProtocolMode
  readonly topology: CollaborationTopology | null
  readonly limits: {
    readonly maxChallengeRounds: number
    readonly maxMessagesPerExpert: number
  } | null
  readonly members: readonly CollaborationProtocolMember[]
  readonly challenges: readonly CollaborationProtocolChallenge[]
}

/** Authoritative browser snapshot of one automatic team-formation run. */
export interface CollaborationRunSnapshot {
  readonly id: CollaborationRunId
  readonly title: string
  readonly objective: string
  readonly language: CollaborationLanguage
  readonly status: CollaborationRunStatus
  readonly phase: CollaborationRunPhase
  readonly createdAt: number
  /** Latest authoritative TeamRun cursor, including non-message state events. */
  readonly cursor: number
  readonly profile: CollaborationTaskProfile | null
  readonly charter: CollaborationTeamCharter | null
  readonly lead: { readonly sessionId: string; readonly name: string; readonly role: string }
  readonly experts: readonly CollaborationExpertMember[]
  readonly tasks: readonly CollaborationTask[]
  readonly timeline: readonly CollaborationPublicMessage[]
  readonly artifacts: readonly CollaborationArtifact[]
  readonly decisions: readonly CollaborationDecision[]
  readonly qualityGates: readonly CollaborationQualityGate[]
  readonly controller: CollaborationController
  readonly progress: CollaborationProgress
  /** Absent only on the local pre-commit placeholder; every Host snapshot supplies a mode. */
  readonly protocol?: CollaborationProtocol
  readonly expertCounts: {
    readonly planned: number
    readonly provisioning: number
    readonly active: number
    readonly failed: number
    readonly attempts: number
  }
  readonly failure?: CollaborationFailure
}

/** Loading, ready, or failed catalog state while preserving the last known runs. */
export type CollaborationCatalogSnapshot =
  | { readonly state: 'loading'; readonly runs: readonly CollaborationRunSnapshot[] }
  | { readonly state: 'ready'; readonly runs: readonly CollaborationRunSnapshot[] }
  | {
    readonly state: 'error'
    readonly runs: readonly CollaborationRunSnapshot[]
    readonly error: CollaborationFailure
  }

/** User-authored fields accepted by the product creation command. */
export interface CreateCollaborationRunRequest {
  readonly title: string
  readonly objective: string
  readonly language: CollaborationLanguage
}

/** Outward collaboration service consumed by presentation plugins. */
export interface ICollaboration {
  readonly source: ObservableSnapshot<CollaborationCatalogSnapshot>
  /** Reconcile the complete task catalog, including a newly started main-session TeamRun. */
  refresh(): Promise<void>
  /** Refresh one known TeamRun and its public collaboration timeline. */
  refreshRun(runId: CollaborationRunId): Promise<void>
  createRun(request: CreateCollaborationRunRequest): Promise<CollaborationRunId>
  retryFormation(runId: CollaborationRunId): Promise<CollaborationRunId>
  terminate(runId: CollaborationRunId): Promise<void>
}

/**
 * Allocate a fresh top-level Lead identity at the browser request boundary.
 * @returns Collision-resistant Session identity reserved for a new TeamRun.
 */
export function collaborationLeadSessionId(): SessionId {
  return `collaboration-lead-${crypto.randomUUID()}` as SessionId
}

/** Identify Lead sessions owned by the independent collaboration workspace. */
export function isCollaborationLeadSessionId(sessionId: SessionId): boolean {
  return String(sessionId).startsWith('collaboration-lead-')
}
