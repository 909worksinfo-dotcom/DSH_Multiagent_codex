/** Public expert provisioning requests and durable binding records. */

import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  TeamMemberSnapshot,
  TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  ExpertBlueprintRef,
  ResolvedExpertBinding,
  ResolvedPresetBinding,
  ResolvedSkillBinding,
} from '@deepseek-ai/dsh-expert-catalog'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillMarketplaceCapability } from '@deepseek-ai/dsh-skill-marketplace'

type ExpertBindingDigestType = ResolvedExpertBinding['digest']
/** Public P2 view of the owning P1 provisioning-attempt identity. */
export type ExpertProvisionAttemptId = TeamMemberSnapshot['attemptId']
type TeamMemberIdType = TeamMemberSnapshot['id']
type TeamRunIdType = TeamRunSnapshot['id']
type TeamProtocolSlotIdType = NonNullable<TeamMemberSnapshot['protocolSlotId']>

/** Identifies one durable expert-binding or child-descriptor event. */
export type ExpertRuntimeEventId = Branded<'ExpertRuntimeEventId'>

/** Deployment configuration for exact child provisioning. */
export interface Config {
  /** Named continuable subagent provider used for new expert attempts. */
  readonly subagentProvider: string
  /** Maximum UTF-8 bytes in the generated initial expert prompt. */
  readonly maxInitialPromptBytes: number
}

/** Structured task assignment validated against the blueprint's input fields. */
export interface ExpertAssignment {
  /** User-safe expert task objective. */
  readonly objective: string
  /** User task language required for every public collaboration contribution. */
  readonly language?: 'zh' | 'en'
  /** Named string inputs declared by the blueprint revision. */
  readonly inputs: Readonly<Record<string, string>>
}

/** Input that reserves, binds, creates, and activates one expert child. */
export interface ProvisionExpertRequest {
  /** Current TeamRun revision used by P1 begin provisioning. */
  readonly expectedRevision: number
  /** Immutable roster identity. */
  readonly memberId: TeamMemberIdType
  /** Caller-reserved child Session identity. */
  readonly sessionId: SessionId
  /** Immutable attempt identity. */
  readonly attemptId: ExpertProvisionAttemptId
  /** Stable lower-kebab-case expert name. */
  readonly name: string
  /** Task-language public role selected by the deterministic team planner. */
  readonly role?: string
  /** Planned collaboration protocol slot, required by product TeamRun formation. */
  readonly protocolSlotId?: TeamProtocolSlotIdType
  /** Exact local blueprint revision. */
  readonly blueprint: ExpertBlueprintRef
  /** Optional task-reviewed local skill set replacing this attempt's blueprint defaults. */
  readonly localSkills?: readonly string[]
  /** Optional task-reviewed model route overriding blueprint and Lead defaults. */
  readonly modelSelection?: ModelSelection
  /** Trusted task-time marketplace capabilities selected for this expert. */
  readonly marketplaceSkills?: readonly SkillMarketplaceCapability[]
  /** Validated work supplied to the expert's first turn. */
  readonly assignment: ExpertAssignment
  /** Caller cancellation until initial prompt admission. */
  readonly signal: AbortSignal
}

/** Complete immutable capability descriptor shared by Lead and child logs. */
export interface ExpertBindingDescriptor {
  /** Exact blueprint revision. */
  readonly blueprint: ExpertBlueprintRef
  /** Optional task-language role shown publicly; absent on bindings created before prompt-language localization. */
  readonly displayRole?: string
  /** SHA-256 of the exact blueprint configuration. */
  readonly blueprintDigest: string
  /** Exact mounted preset and source digest. */
  readonly preset: ResolvedPresetBinding
  /** Exact winning skill definitions and content digests. */
  readonly skills: readonly ResolvedSkillBinding[]
  /** Persisted task-time marketplace mounts; absent on bindings created before marketplace discovery. */
  readonly marketplaceSkills?: readonly SkillMarketplaceCapability[]
  /** Required enabled preset plugin rows. */
  readonly plugins: readonly string[]
  /** Digest covering the complete resolved binding. */
  readonly digest: ExpertBindingDigestType
  /** Effective child model route and output ceiling, including inherited Lead values. */
  readonly model: AgentOptions
  /**
   * Daily-agent infrastructure inherited by bindings created after the
   * collaboration foundation upgrade. Absence preserves legacy immutable
   * snapshots without retroactively changing their runtime contract.
   */
  readonly foundation?: {
    /** Initial mutable model selection installed for the expert session. */
    readonly modelSelection: ModelSelection
    /** Whether the expert keeps the preset's complete daily tool catalog. */
    readonly toolAccess: 'full_preset' | 'restricted'
    /** Effective permission state captured from the Lead at formation. */
    readonly permissions: {
      readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly approvalPolicy: 'ask' | 'never'
    }
  }
  /** SHA-256 of the catalog digest plus every runtime-derived composition field. */
  readonly compositionDigest: string
  /** Runtime limits fixed before the provisioning attempt begins. */
  readonly execution: {
    /** Maximum admitted expert turns. */
    readonly maxTurns: number
    /** Effective per-request output-token ceiling. */
    readonly maxTokens: number
    /** Absolute Unix epoch deadline for initial expert prompt admission. */
    readonly deadlineAt: number
  }
}

/** Durable Lead-side record written after P1 reserves an attempt and before child work. */
export interface ExpertBindingEventData {
  readonly version: 1
  readonly eventId: ExpertRuntimeEventId
  readonly runId: TeamRunIdType
  readonly memberId: TeamMemberIdType
  readonly sessionId: SessionId
  readonly attemptId: ExpertProvisionAttemptId
  readonly name: string
  readonly role: string
  readonly subagentProvider: string
  readonly descriptor: ExpertBindingDescriptor
  readonly initialPrompt: string
  readonly agentOptions: AgentOptions
  readonly persona?: string
  readonly toolFilter: {
    readonly allow?: readonly string[]
    readonly deny?: readonly string[]
  }
}

/** Durable child-side descriptor appended before publication. */
export interface ExpertChildDescriptorEventData {
  readonly version: 1
  readonly eventId: ExpertRuntimeEventId
  readonly runId: TeamRunIdType
  readonly memberId: TeamMemberIdType
  readonly sessionId: SessionId
  readonly attemptId: ExpertProvisionAttemptId
  readonly descriptor: ExpertBindingDescriptor
}

/** Successful provisioning result after the initial prompt is accepted. */
export interface ProvisionedExpert {
  /** P1 active member row. */
  readonly member: TeamMemberSnapshot
  /** Immutable Lead-side binding. */
  readonly binding: ExpertBindingEventData
  /** Accepted initial prompt identity. */
  readonly messageId: MessageId
}

/** Successful recovery of a provisioning attempt without duplicating accepted work. */
export interface RecoveredExpert {
  /** P1 active member row. */
  readonly member: TeamMemberSnapshot
  /** Immutable Lead-side binding. */
  readonly binding: ExpertBindingEventData
  /** Whether recovery created the missing child and admitted its retained initial prompt. */
  readonly started: boolean
  /** Initial message identity when recovery had to create the child. */
  readonly messageId?: MessageId
}

/** Exact child-validation authorization prepared before fresh creation or cold resume. */
export interface ExpertActivationAuthorization {
  /** Exact child Session. */
  readonly sessionId: SessionId
  /** Exact parent binding expected in the child descriptor. */
  readonly binding: ExpertBindingEventData
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Immutable Lead-side expert capability binding, required-on-read because
     * provisioning recovery and every child activation validate against it.
     */
    'collaboration/expert/binding': ExpertBindingEventData
    /**
     * Immutable child-side expert descriptor, required-on-read because cold
     * resume must reproduce and validate the exact original capability set.
     */
    'collaboration/expert/descriptor': ExpertChildDescriptorEventData
  }
}
