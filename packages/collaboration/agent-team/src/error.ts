/** Typed failures raised by the stable TeamRun domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CollaborationErrorCode, TeamFailureDetailValue } from './types.ts'

/** Complete stable error-code set used by runtime validation and persisted schemas. */
export const COLLABORATION_ERROR_CODES = [
  'TEAM_MEMBER_LIMIT',
  'TEAM_PROVISION_ATTEMPT_LIMIT',
  'FORMATION_FAILED',
  'CAPABILITY_UNAVAILABLE',
  'BLUEPRINT_REVISION_MISMATCH',
  'RESOURCE_CONFLICT',
  'STALE_REVISION',
  'DELIVERY_FAILED',
  'TEAM_INVALID_ARGUMENT',
  'TEAM_INVALID_CONFIG',
  'TEAM_NOT_FOUND',
  'TEAM_NOT_MEMBER',
  'TEAM_LEAD_REQUIRED',
  'TEAM_MEMBER_NOT_FOUND',
  'TEAM_MEMBER_NAME_TAKEN',
  'TEAM_MEMBER_ID_TAKEN',
  'TEAM_ATTEMPT_ID_TAKEN',
  'TEAM_SESSION_ID_TAKEN',
  'TEAM_INVALID_TRANSITION',
  'TEAM_CANCELLED',
  'TEAM_TASK_LIMIT',
  'TEAM_TASK_NOT_FOUND',
  'TEAM_TASK_BLOCKED',
  'TEAM_TASK_UNAUTHORIZED',
  'TEAM_TASK_INVALID_TRANSITION',
  'TEAM_TASK_DEPENDENCY_CYCLE',
  'TEAM_TASK_HAS_DEPENDENTS',
  'TEAM_MESSAGE_LIMIT',
  'TEAM_MESSAGE_TOO_LARGE',
  'TEAM_PROTOCOL_REQUIRED',
  'TEAM_PROTOCOL_PERMISSION_DENIED',
  'TEAM_PROTOCOL_TARGET_DENIED',
  'TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED',
  'TEAM_CHALLENGE_INVALID',
  'TEAM_CHALLENGE_ROUND_LIMIT',
  'TEAM_ARTIFACT_LIMIT',
  'TEAM_ARTIFACT_NOT_FOUND',
  'TEAM_ARTIFACT_TOO_LARGE',
  'TEAM_ARTIFACT_UNAUTHORIZED',
  'TEAM_DECISION_NOT_FOUND',
  'TEAM_QUALITY_GATE_NOT_FOUND',
  'TEAM_CONTROL_INVALID_ACTION',
] as const satisfies readonly CollaborationErrorCode[]

const COLLABORATION_ERROR_CODE_SET: ReadonlySet<string> = new Set(COLLABORATION_ERROR_CODES)

/**
 * Test an untyped runtime value against the stable collaboration error set.
 * @param value - candidate code from a queued, tool, or wire input.
 * @returns whether the value is a stable collaboration error code.
 */
export function isCollaborationErrorCode(value: unknown): value is CollaborationErrorCode {
  return typeof value === 'string' && COLLABORATION_ERROR_CODE_SET.has(value)
}

/** Caller-visible TeamRun failure with retryability and structured diagnostics. */
export class TeamRunError extends HarnessError {
  /** Whether the caller may retry without changing product intent. */
  readonly retryable: boolean
  /** Structured scalar diagnostics safe for host transport. */
  readonly details: Readonly<Record<string, TeamFailureDetailValue>>

  /**
   * @param message - user-safe failure explanation.
   * @param code - stable collaboration failure category.
   * @param options - retryability, diagnostics, and optional causal error.
   */
  constructor(
    message: string,
    code: CollaborationErrorCode,
    options: {
      readonly retryable?: boolean
      readonly details?: Readonly<Record<string, TeamFailureDetailValue>>
      readonly cause?: unknown
    } = {},
  ) {
    super(message, code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TeamRunError'
    this.retryable = options.retryable ?? false
    this.details = options.details ?? {}
  }
}
