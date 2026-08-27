/** Public profiling, planning, charter, and formation records for one TeamRun. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  TeamMemberSnapshot,
  TeamRunComplexity,
  TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import type {
  ExpertBlueprintRef,
  ExpertExecutionBudget,
} from '@deepseek-ai/dsh-expert-catalog'
import type {
  SkillMarketplaceCapability,
  SkillMarketplaceProviderResult,
} from '@deepseek-ai/dsh-skill-marketplace'

/** Idempotency identity for one user-requested orchestration. */
export type TeamOrchestrationRequestId = Branded<'TeamOrchestrationRequestId'>

/** Identity for one durable orchestration event. */
export type TeamOrchestrationEventId = Branded<'TeamOrchestrationEventId'>

/** Stable roster slot selected before any provider attempt starts. */
export type TeamPlanSlotId = Branded<'TeamPlanSlotId'>

/** Supported first-wave product domains. */
export type TeamTaskDomain = 'research_analysis' | 'product_solution' | 'software_development'

/** Legal collaboration topology selected for one complexity band. */
export type TeamTopology =
  | 'producer_reviewer'
  | 'centralized'
  | 'parallel'
  | 'hybrid'
  | 'grouped'

/** One normalized unit of work used by the profiler and durable task DAG. */
export interface TeamWorkstream {
  /** Stable lower-kebab-case identity within the request. */
  readonly id: string
  /** Concise user-safe title. */
  readonly subject: string
  /** Complete task objective and acceptance context. */
  readonly description: string
  /** Workstream ids that must complete first. */
  readonly blockedBy: readonly string[]
  /** Capabilities useful for selecting expert blueprints. */
  readonly requiredCapabilities: readonly string[]
  /** Advisory resource ownership prefixes. */
  readonly resourceScopes: readonly string[]
}

/** Caller input for automatic profiling, planning, and charter creation. */
export interface CreateTeamOrchestrationRequest {
  /** Idempotency identity retained in the Lead Session. */
  readonly requestId: TeamOrchestrationRequestId
  /** Optional failed orchestration replaced by this new Lead and TeamRun. */
  readonly retryOf?: TeamOrchestrationRequestId
  /** User task objective. */
  readonly objective: string
  /** Optional first-wave domain hint; absence lets the profiler infer it from the objective. */
  readonly domain?: TeamTaskDomain
  /** User-visible completion checks; absence derives one objective-level check. */
  readonly successCriteria?: readonly string[]
  /** Explicit work hints; absence profiles one indivisible workstream. */
  readonly workstreams?: readonly {
    readonly id: string
    readonly subject: string
    readonly description: string
    readonly blockedBy?: readonly string[]
    readonly requiredCapabilities?: readonly string[]
    readonly resourceScopes?: readonly string[]
  }[]
  /** User-safe risk facts used by the deterministic profiler. */
  readonly riskSignals?: readonly string[]
  /** Named assignment values; missing blueprint inputs receive the objective. */
  readonly context?: Readonly<Record<string, string>>
}

/** Deployment blueprint pool for one supported task domain. */
export interface TeamBlueprintPool {
  /** Domain selected by a task request. */
  readonly domain: TeamTaskDomain
  /** Ordered, immutable candidate revisions. */
  readonly blueprints: readonly ExpertBlueprintRef[]
}

/** Communication limits committed into each charter. */
export interface TeamCommunicationLimits {
  /** Maximum challenge-response rounds per disputed proposal. */
  readonly maxChallengeRounds: number
  /** Maximum public messages expected from one expert before Lead intervention. */
  readonly maxMessagesPerExpert: number
}

/** Cordis deployment configuration for profiling and planning bounds. */
export interface Config {
  /** Exact candidate revisions available to each supported domain. */
  readonly pools: readonly TeamBlueprintPool[]
  /** Maximum UTF-8 bytes in objective, criteria, workstream, risk, and context strings. */
  readonly maxTextBytes: number
  /** Maximum explicit workstreams retained in a profile. */
  readonly maxWorkstreams: number
  /** Maximum items in each criteria, risk, capability, dependency, or scope list. */
  readonly maxListItems: number
  /** Maximum named task-context fields. */
  readonly maxContextEntries: number
  /** Maximum UTF-8 bytes in one complete orchestration event payload. */
  readonly maxEventBytes: number
  /** Communication policy snapshotted by complexity. */
  readonly communication: Readonly<Record<TeamRunComplexity, TeamCommunicationLimits>>
  /** Maximum market-discovered capabilities retained for one expert. */
  readonly maxMarketplaceSkillsPerExpert: number
}

/** Durable market scan and selected capability mounts for one planned expert. */
export interface PlannedExpertSkillDiscovery {
  /** Provider readiness without credentials, endpoints, or raw failure details. */
  readonly providers: readonly Pick<SkillMarketplaceProviderResult, 'source' | 'state'>[]
  /** Bounded, trusted capabilities selected for this expert. */
  readonly mounts: readonly SkillMarketplaceCapability[]
}

/** Deterministic metrics retained with an automatic complexity decision. */
export interface TaskProfileMetrics {
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

/** Complete durable task profile and normalized planning input. */
export interface TaskProfile {
  readonly domain: TeamTaskDomain
  readonly objective: string
  readonly successCriteria: readonly string[]
  readonly workstreams: readonly TeamWorkstream[]
  readonly riskSignals: readonly string[]
  readonly context: Readonly<Record<string, string>>
  readonly complexity: TeamRunComplexity
  readonly plannedExperts: number
  readonly metrics: TaskProfileMetrics
}

/** One exact blueprint selected for a stable planned roster slot. */
export interface PlannedExpert {
  readonly slotId: TeamPlanSlotId
  readonly name: string
  readonly role: string
  readonly blueprint: ExpertBlueprintRef
  readonly assignment: {
    readonly objective: string
    /** Public collaboration language inherited from the user task. */
    readonly language?: 'zh' | 'en'
    readonly inputs: Readonly<Record<string, string>>
  }
  readonly acceptanceCriteria: readonly string[]
  readonly budget: ExpertExecutionBudget
  /** Task-time market scan; absent only on plans persisted before marketplace discovery existed. */
  readonly skillDiscovery?: PlannedExpertSkillDiscovery
}

/** Complete immutable plan selected from the local ExpertBlueprint catalog. */
export interface TeamPlan {
  readonly topology: TeamTopology
  readonly roster: readonly PlannedExpert[]
  readonly taskDag: readonly TeamWorkstream[]
}

/** Lead-readable collaboration charter committed before child provisioning. */
export interface TeamCharter {
  readonly objective: string
  readonly successCriteria: readonly string[]
  readonly topology: TeamTopology
  readonly roster: readonly {
    readonly slotId: TeamPlanSlotId
    readonly name: string
    readonly role: string
    readonly blueprint: ExpertBlueprintRef
  }[]
  readonly taskDag: readonly TeamWorkstream[]
  readonly communication: TeamCommunicationLimits
  readonly qualityChecks: readonly string[]
  readonly budgets: readonly {
    readonly slotId: TeamPlanSlotId
    readonly execution: ExpertExecutionBudget
  }[]
  readonly termination: {
    readonly success: 'all_tasks_completed_and_reviewed'
    readonly formationFailure: 'fail_closed'
  }
}

/** Complete current P3 projection reconstructed from the Lead Session. */
export interface TeamOrchestrationSnapshot {
  readonly requestId: TeamOrchestrationRequestId
  readonly retryOf?: TeamOrchestrationRequestId
  readonly createdAt: number
  readonly run: TeamRunSnapshot
  readonly profile: TaskProfile
  readonly plan?: TeamPlan
  readonly charter?: TeamCharter
}

/** Input that addresses an already-created orchestration. */
export interface TeamOrchestrationCommand {
  readonly requestId: TeamOrchestrationRequestId
}

/** Lead-owned request to replace one durable failed expert attempt in its original planned slot. */
export interface ReplaceTeamExpertRequest extends TeamOrchestrationCommand {
  readonly failedMemberId: TeamMemberSnapshot['id']
}

/** Input that cancels a non-terminal orchestration. */
export interface CancelTeamOrchestrationRequest extends TeamOrchestrationCommand {
  readonly reason: string
}

/** Durable profile payload. */
export interface TeamProfileEventData {
  readonly version: 1
  readonly eventId: TeamOrchestrationEventId
  readonly runId: TeamRunSnapshot['id']
  readonly requestId: TeamOrchestrationRequestId
  readonly retryOf?: TeamOrchestrationRequestId
  readonly requestDigest: string
  readonly revision: 1
  readonly profile: TaskProfile
}

/** Durable exact team plan payload. */
export interface TeamPlanEventData {
  readonly version: 1
  readonly eventId: TeamOrchestrationEventId
  readonly runId: TeamRunSnapshot['id']
  readonly requestId: TeamOrchestrationRequestId
  readonly requestDigest: string
  readonly revision: 2
  readonly planDigest: string
  readonly plan: TeamPlan
}

/** Durable charter payload. */
export interface TeamCharterEventData {
  readonly version: 1
  readonly eventId: TeamOrchestrationEventId
  readonly runId: TeamRunSnapshot['id']
  readonly requestId: TeamOrchestrationRequestId
  readonly requestDigest: string
  readonly revision: 3
  readonly planDigest: string
  readonly charterDigest: string
  readonly charter: TeamCharter
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the automatic task profile and normalized planning input in the owning Lead Session. */
    'collaboration/orchestration/profile': TeamProfileEventData
    /** Records the exact immutable blueprint roster and task DAG selected before formation. */
    'collaboration/orchestration/plan': TeamPlanEventData
    /** Records the Lead-readable collaboration rules and budgets committed before formation. */
    'collaboration/orchestration/charter': TeamCharterEventData
  }
}
