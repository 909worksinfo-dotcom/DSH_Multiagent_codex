/** Public ExpertBlueprint configuration and resolved capability records. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable locally configured blueprint identity. */
export type ExpertBlueprintId = Branded<'ExpertBlueprintId'>

/** SHA-256 digest of one complete resolved expert binding. */
export type ExpertBindingDigest = Branded<'ExpertBindingDigest'>

/** Exact immutable blueprint revision selector. */
export interface ExpertBlueprintRef {
  /** Stable blueprint identity. */
  readonly id: ExpertBlueprintId
  /** Positive immutable revision. */
  readonly revision: number
}

/** Named input or output field in an expert assignment. */
export interface ExpertFieldDefinition {
  /** Stable lower-camel-case field name. */
  readonly name: string
  /** User-safe field meaning. */
  readonly description: string
  /** Whether the field must be present. */
  readonly required: boolean
}

/** Tools made visible to the expert after preset composition. */
export interface ExpertToolPolicy {
  /** Optional complete allowlist. */
  readonly allow?: readonly string[]
  /** Optional denylist intersected with the allowlist and preset visibility. */
  readonly deny?: readonly string[]
}

/** Model route declared by an expert blueprint. */
export interface ExpertModelPolicy {
  /** Optional provider override; absence inherits the Lead route. */
  readonly provider?: string
  /** Optional model override; absence inherits the Lead route. */
  readonly model?: string
  /** Optional per-activation output-token ceiling. */
  readonly maxTokens?: number
}

/** Public collaboration operations one expert may perform. */
export interface ExpertCollaborationPermissions {
  /** Whether this role may challenge another member's public proposal. */
  readonly challenge: boolean
  /** Whether this role may publish a review. */
  readonly review: boolean
  /** Whether this role may request help from peers. */
  readonly requestHelp: boolean
}

/** Per-expert execution budgets fixed by the blueprint revision. */
export interface ExpertExecutionBudget {
  /** Maximum model turns assigned to the expert. */
  readonly maxTurns: number
  /** Maximum output tokens allowed for each expert model request. */
  readonly maxTokens: number
  /** Wall-clock ceiling for each active expert execution interval in milliseconds. */
  readonly timeoutMs: number
}

/** One locally configured immutable expert definition. */
export interface ExpertBlueprint {
  /** Exact immutable selector. */
  readonly ref: ExpertBlueprintRef
  /** Human-readable expert role. */
  readonly role: string
  /** Stable responsibility and operating objective. */
  readonly objective: string
  /** Agent preset mounted for fresh creation and cold resume. */
  readonly preset: string
  /** Model-invocable skills that must resolve within the preset composition. */
  readonly skills: readonly string[]
  /** Enabled plugin module rows that must occur in the preset composition. */
  readonly plugins: readonly string[]
  /** Runtime-enforced tool visibility policy. */
  readonly tools: ExpertToolPolicy
  /** Optional model route overrides. */
  readonly model: ExpertModelPolicy
  /** Optional child-specific persona section. */
  readonly persona?: string
  /** Structured assignment inputs. */
  readonly inputs: readonly ExpertFieldDefinition[]
  /** Structured assignment outputs. */
  readonly outputs: readonly ExpertFieldDefinition[]
  /** Completion conditions supplied to the expert. */
  readonly acceptanceCriteria: readonly string[]
  /** Public collaboration permissions. */
  readonly collaboration: ExpertCollaborationPermissions
  /** Execution limits retained with the revision. */
  readonly budget: ExpertExecutionBudget
}

/** Deployment-owned local catalog configuration. */
export interface Config {
  /** Complete set of immutable revisions available in this process. */
  readonly blueprints?: ExpertBlueprint[]
}

/** Resolved preset identity and exact source digest. */
export interface ResolvedPresetBinding {
  /** Preset id. */
  readonly id: string
  /** SHA-256 of the composition file used for capability resolution. */
  readonly contentDigest: string
}

/** Resolved skill identity without copying its model-visible body. */
export interface ResolvedSkillBinding {
  /** Skill name from the blueprint. */
  readonly name: string
  /** Winning skill provider. */
  readonly provider: string
  /** Winning discovery source. */
  readonly source: string
  /** SHA-256 of the exact loaded skill definition. */
  readonly contentDigest: string
  /** Provider path when one exists. */
  readonly path?: string
}

/** Exact capability binding used to create and later validate an expert child. */
export interface ResolvedExpertBinding {
  /** Detached immutable blueprint. */
  readonly blueprint: ExpertBlueprint
  /** SHA-256 of the blueprint configuration. */
  readonly blueprintDigest: string
  /** Exact preset source. */
  readonly preset: ResolvedPresetBinding
  /** Exact winning skill definitions. */
  readonly skills: readonly ResolvedSkillBinding[]
  /** Required enabled preset plugin rows. */
  readonly plugins: readonly string[]
  /** SHA-256 of every field above. */
  readonly digest: ExpertBindingDigest
}

/** Call-scoped capability resolution inputs. */
export interface ResolveExpertBindingOptions {
  /** Workspace used by cwd-sensitive skill providers. */
  readonly cwd?: string
  /** Task-reviewed local skill names replacing the blueprint defaults for this binding only. */
  readonly skills?: readonly string[]
  /** Caller cancellation forwarded to skill discovery. */
  readonly signal?: AbortSignal
}
