/** Browser-safe collaboration RPC contract and allowlisted TeamRun projections. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** First-wave task domains selected automatically by Task Profiler. */
export type CollaborationTaskDomain = 'research_analysis' | 'product_solution' | 'software_development'

/** Product complexity with a strict expert-count band. */
export type CollaborationComplexity = 'simple' | 'medium' | 'complex'

/** Public run status visible to every client. */
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

/** Exact persisted orchestration phase. */
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

/** Legal collaboration topology selected for one complexity band. */
export type CollaborationTopology =
  | 'producer_reviewer'
  | 'centralized'
  | 'parallel'
  | 'hybrid'
  | 'grouped'

/** Public expert lifecycle including a planned seat not yet provisioned. */
export type CollaborationExpertPhase = 'planned' | 'provisioning' | 'active' | 'failed'

/** Scalar-only diagnostic values safe to cross the product boundary. */
export type CollaborationFailureDetailValue = string | number | boolean | null

/** Stable collaboration failure projected without private causes or paths. */
export interface CollaborationFailureView {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details: Readonly<Record<string, CollaborationFailureDetailValue>>
}

/** One normalized task-DAG node. */
export interface CollaborationWorkstreamView {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly blockedBy: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly resourceScopes: readonly string[]
}

/** Deterministic Task Profiler output. */
export interface CollaborationTaskProfileView {
  readonly domain: CollaborationTaskDomain
  readonly objective: string
  readonly successCriteria: readonly string[]
  readonly workstreams: readonly CollaborationWorkstreamView[]
  readonly riskSignals: readonly string[]
  readonly complexity: CollaborationComplexity
  readonly plannedExperts: number
  readonly metrics: {
    readonly workstreamCount: number
    readonly dependencyCount: number
    readonly independentWorkstreams: number
    readonly longestDependencyPath: number
    readonly capabilityCount: number
    readonly riskSignalCount: number
    readonly decomposable: boolean
    readonly toolDensity: 'low' | 'medium' | 'high'
    readonly risk: 'low' | 'medium' | 'high'
  }
}

/** Communication limits committed into the Team Charter. */
export interface CollaborationCommunicationView {
  readonly maxChallengeRounds: number
  readonly maxMessagesPerExpert: number
}

/** User-visible charter without prompts, chain-of-thought, or composition digests. */
export interface CollaborationCharterView {
  readonly objective: string
  readonly successCriteria: readonly string[]
  readonly topology: CollaborationTopology
  readonly taskDag: readonly CollaborationWorkstreamView[]
  readonly communication: CollaborationCommunicationView
  readonly qualityChecks: readonly string[]
  readonly budgets: readonly {
    readonly slotId: string
    readonly maxTurns: number
    readonly maxTokens: number
    readonly timeoutMs: number
  }[]
  readonly termination: {
    readonly success: 'all_tasks_completed_and_reviewed'
    readonly formationFailure: 'fail_closed'
  }
}

/** Allowlisted capability metadata; no paths, prompt bodies, configuration, or digests. */
export interface CollaborationCapabilityView {
  readonly id: string
  readonly label: string
}

/** Safe task-time marketplace mount metadata. */
export interface CollaborationMarketplaceCapabilityView extends CollaborationCapabilityView {
  readonly source: 'smithery' | 'composio' | 'skills_sh'
  readonly kind: 'remote_tool' | 'method_skill'
  readonly status: 'loaded' | 'connected' | 'authorization_required'
  readonly access?: 'public' | 'platform' | 'user'
}

/** Safe provider-level scan outcome retained even when no capability matched. */
export interface CollaborationMarketplaceProviderView {
  readonly source: 'smithery' | 'composio' | 'skills_sh'
  readonly state: 'ready' | 'authorization_required' | 'unavailable'
}

/** Safe immutable expert composition visible in the roster. */
export interface CollaborationExpertBindingView {
  readonly blueprint: { readonly id: string; readonly revision: number }
  readonly preset: CollaborationCapabilityView
  readonly skills: readonly CollaborationCapabilityView[]
  readonly marketplaceProviders?: readonly CollaborationMarketplaceProviderView[]
  readonly marketplaceSkills: readonly CollaborationMarketplaceCapabilityView[]
  readonly plugins: readonly CollaborationCapabilityView[]
}

/** One planned seat or immutable provisioning attempt. */
export interface CollaborationExpertView {
  readonly id: string
  readonly sessionId: SessionId | null
  readonly name: string
  readonly role: string
  readonly phase: CollaborationExpertPhase
  readonly binding: CollaborationExpertBindingView
  readonly failure?: CollaborationFailureView
}

/** Browser-safe author or task owner. */
export type CollaborationActorView =
  | { readonly role: 'lead'; readonly sessionId: SessionId; readonly name: 'lead' }
  | {
    readonly role: 'expert'
    readonly memberId: string
    readonly sessionId: SessionId
    readonly name: string
  }

/** Current non-deleted task-board row. */
export interface CollaborationTaskView {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly owner: CollaborationActorView | null
  readonly blockedBy: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly ready: boolean
  readonly resourceConflicts: readonly string[]
}

/** Browser-safe artifact metadata; the body is available only from readArtifact. */
export interface CollaborationArtifactView {
  readonly id: string
  readonly version: number
  readonly kind: 'document' | 'code' | 'dataset' | 'evidence' | 'analysis' | 'product_spec' | 'design' | 'test_report' | 'final_delivery'
  readonly title: string
  readonly status: 'draft' | 'review' | 'accepted' | 'superseded'
  readonly author: CollaborationActorView
  readonly taskIds: readonly string[]
  readonly mediaType: string
  readonly updatedAt: number
}

/** Restricted complete artifact returned only by collaboration.readArtifact. */
export interface CollaborationArtifactRecordView extends CollaborationArtifactView {
  readonly body: string
}

/** Independent Lead arbitration ledger row. */
export interface CollaborationDecisionView {
  readonly id: string
  readonly version: number
  readonly subject: string
  readonly outcome: 'accepted' | 'rejected' | 'revise' | 'unresolved' | 'reassign' | 'rework' | 'replan'
  readonly summary: string
  readonly rationale: string
  readonly taskIds: readonly string[]
  readonly artifactIds: readonly string[]
  readonly lead: CollaborationActorView
  readonly createdAt: number
}

/** Independent materialized quality-gate ledger row. */
export interface CollaborationQualityGateView {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly status: 'pending' | 'passed' | 'failed'
  readonly reviewer?: CollaborationActorView
  readonly taskId?: string
  readonly artifactId?: string
  readonly summary: string
  readonly updatedAt: number
}

/** Deterministic Lead Controller projection. */
export interface CollaborationControllerView {
  readonly health: 'healthy' | 'attention' | 'stalled' | 'reworking' | 'ready'
  readonly lastProgressAt: number
  readonly stalledTaskIds: readonly string[]
  readonly duplicateWorkCount: number
  readonly qualityFailureCount: number
  readonly recommendedActions: readonly (
    'reassign' | 'rework' | 'replan' | 'replace_expert' | 'resolve_quality_failure'
  )[]
  readonly actionsTaken: readonly string[]
}

/** Runtime-enforced Team Charter protocol and authoritative usage projection. */
export interface CollaborationProtocolView {
  readonly mode: 'legacy' | 'enforced'
  readonly topology: CollaborationTopology | null
  readonly limits: CollaborationCommunicationView | null
  readonly members: readonly {
    readonly slotId: string
    readonly memberId: string | null
    readonly name: string
    readonly phase: 'provisioning' | 'active' | 'failed' | null
    readonly permissions: { readonly challenge: boolean; readonly review: boolean; readonly requestHelp: boolean }
    readonly allowedTargets: readonly string[]
    readonly usedMessages: number
    readonly remainingMessages: number
  }[]
  readonly challenges: readonly {
    readonly challengeId: string
    readonly threadId: string
    readonly round: number
    readonly challenger: string
    readonly target: string
    readonly status: 'open' | 'responded'
    readonly challengeMessageId: string
    readonly responseMessageId: string | null
  }[]
}

/** Typed public collaboration statement visible to users and peer agents. */
export type CollaborationPublicEventKind =
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

/** Optional stable relations carried by one public collaboration event. */
export interface CollaborationPublicReferencesView {
  readonly taskId?: string
  readonly challengeId?: string
  readonly decisionId?: string
  readonly artifactId?: string
}

/** One public-only collaboration event; private model reasoning has no representation. */
export interface CollaborationPublicEventView {
  readonly id: string
  readonly eventId: string
  readonly cursor: number
  readonly threadId: string
  readonly kind: CollaborationPublicEventKind
  readonly author: CollaborationActorView
  readonly targets: readonly CollaborationActorView[]
  readonly references: CollaborationPublicReferencesView
  readonly content: string
  readonly createdAt: number
  readonly visibility: 'public'
}

/** Complete browser-facing P4 snapshot with compact execution progress. */
export interface CollaborationRunView {
  readonly id: SessionId
  readonly requestId: string
  readonly retryOf?: string
  readonly title: string
  readonly objective: string
  readonly language: 'zh' | 'en'
  readonly createdAt: number
  readonly status: CollaborationRunStatus
  readonly phase: CollaborationRunPhase
  /** Session-log cursor for snapshot/event pagination reconciliation. */
  readonly cursor: number
  readonly profile: CollaborationTaskProfileView
  readonly charter: CollaborationCharterView | null
  readonly lead: { readonly sessionId: SessionId; readonly name: 'lead'; readonly role: 'Lead Agent' }
  readonly experts: readonly CollaborationExpertView[]
  readonly expertCounts: {
    readonly planned: number
    readonly provisioning: number
    readonly active: number
    readonly failed: number
    readonly attempts: number
    readonly availableSlots: number
  }
  readonly tasks: readonly CollaborationTaskView[]
  readonly artifacts: readonly CollaborationArtifactView[]
  readonly decisions: readonly CollaborationDecisionView[]
  readonly qualityGates: readonly CollaborationQualityGateView[]
  readonly controller: CollaborationControllerView
  readonly protocol: CollaborationProtocolView
  readonly progress: {
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
  readonly failure?: CollaborationFailureView
}

/** Optional explicit decomposition accepted by the advanced/demo API. */
export interface CollaborationWorkstreamInput {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly string[]
  readonly requiredCapabilities?: readonly string[]
  readonly resourceScopes?: readonly string[]
}

/** Collaboration-domain unary methods. */
export interface CollaborationApi {
  /** Create, profile, plan, charter, and fully form a task team for an existing blank Lead Session. */
  create(request: RpcRequest<{
    leadSessionId: SessionId
    requestId: string
    retryOf?: string
    title: string
    objective: string
    language: 'zh' | 'en'
    domain?: CollaborationTaskDomain
    successCriteria?: readonly string[]
    workstreams?: readonly CollaborationWorkstreamInput[]
    riskSignals?: readonly string[]
  }>, signal: AbortSignal): Promise<RpcResponse<CollaborationRunView>>

  /** List every recoverable local TeamRun, resuming cold Leads when required. */
  list(request: RpcRequest<Record<never, never>>): Promise<RpcResponse<{ runs: CollaborationRunView[] }>>

  /** Read one exact TeamRun, resuming its cold Lead when required. */
  get(request: RpcRequest<{ runId: SessionId }>): Promise<RpcResponse<CollaborationRunView>>

  /** Read one complete artifact body after exact live TeamRun authority recovery. */
  readArtifact(request: RpcRequest<{ runId: SessionId; artifactId: string }>):
  Promise<RpcResponse<CollaborationArtifactRecordView>>

  /** Page public typed collaboration events after one exclusive Session cursor. */
  events(request: RpcRequest<{
    runId: SessionId
    afterCursor?: number
    limit?: number
  }>): Promise<RpcResponse<{
    events: readonly CollaborationPublicEventView[]
    hasMore: boolean
    nextCursor: number
  }>>

  /** Publish a public typed statement as the run's exact live Lead. */
  send(request: RpcRequest<{
    runId: SessionId
    kind: CollaborationPublicEventKind
    threadId: string
    targets?: readonly string[]
    references?: CollaborationPublicReferencesView
    content: string
  }>): Promise<RpcResponse<CollaborationPublicEventView>>

  /** Atomically review-close the run and publish its final Lead delivery. */
  complete(request: RpcRequest<{
    runId: SessionId
    threadId: string
    references?: CollaborationPublicReferencesView
    content: string
  }>): Promise<RpcResponse<CollaborationRunView>>

  /** Continue a non-terminal interrupted provisioning transaction idempotently. */
  retryFormation(request: RpcRequest<{ runId: SessionId; requestId: string }>, signal: AbortSignal):
  Promise<RpcResponse<CollaborationRunView>>

  /** Cancel a non-terminal orchestration while retaining its durable audit. */
  cancel(request: RpcRequest<{ runId: SessionId; requestId: string; reason: string }>):
  Promise<RpcResponse<CollaborationRunView>>
}
