/** Product expert-count bands and deterministic TeamRun policy validation. */

import { TeamRunError } from './error.ts'
import type { TeamRunComplexity, TeamRunPolicySnapshot } from './types.ts'

/** Fixed product expert-count bands; the Lead is excluded from both bounds. */
export const TEAM_COMPLEXITY_BANDS: Readonly<Record<TeamRunComplexity, {
  readonly minimum: number
  readonly maximum: number
}>> = {
  simple: { minimum: 3, maximum: 3 },
  medium: { minimum: 3, maximum: 4 },
  complex: { minimum: 5, maximum: 8 },
}

/** Maximum product expert capacity across every TeamRun complexity. */
export const PRODUCT_MAX_ACTIVE_EXPERTS = 8
/** Default immutable provisioning-attempt budget. */
export const DEFAULT_MAX_PROVISION_ATTEMPTS = 12

/**
 * Validate one exact planned expert count against its product complexity.
 * @param complexity - selected product complexity.
 * @param plannedExperts - exact active expert target.
 * @param maxActiveExperts - deployment capacity excluding the Lead.
 * @returns the validated exact target.
 */
export function validatePlannedExperts(
  complexity: TeamRunComplexity,
  plannedExperts: number,
  maxActiveExperts: number,
): number {
  const bands: Readonly<Partial<Record<string, { readonly minimum: number; readonly maximum: number }>>> =
    TEAM_COMPLEXITY_BANDS
  const band = bands[complexity]
  if (band === undefined) {
    throw new TeamRunError(
      `unknown TeamRun complexity ${JSON.stringify(complexity)}`,
      'TEAM_INVALID_ARGUMENT',
      { details: { complexity } },
    )
  }
  // Counts from the pre-three-expert product remain replayable so upgrading
  // cannot corrupt local audit history. Automatic creation never selects
  // these legacy counts; the current product bands above are authoritative.
  const legacyCount = (complexity === 'simple' && plannedExperts === 1)
    || (complexity === 'medium' && plannedExperts === 2)
  if (!Number.isSafeInteger(plannedExperts)
    || (!legacyCount && (plannedExperts < band.minimum || plannedExperts > band.maximum))) {
    throw new TeamRunError(
      `${complexity} TeamRun requires ${band.minimum} through ${band.maximum} planned experts`,
      'TEAM_INVALID_ARGUMENT',
      { details: { complexity, plannedExperts, minimum: band.minimum, maximum: band.maximum } },
    )
  }
  if (plannedExperts > maxActiveExperts) {
    throw new TeamRunError(
      `planned expert count ${plannedExperts} exceeds deployment capacity ${maxActiveExperts}`,
      'TEAM_MEMBER_LIMIT',
      { details: { plannedExperts, maxActiveExperts } },
    )
  }
  return plannedExperts
}

/**
 * Validate a complete replay policy snapshot.
 * @param policy - policy persisted by TeamRun creation.
 * @returns the same policy after numeric validation.
 */
export function validatePolicy(policy: TeamRunPolicySnapshot): TeamRunPolicySnapshot {
  const limits: Array<[keyof TeamRunPolicySnapshot, number, number]> = [
    ['maxActiveExperts', policy.maxActiveExperts, PRODUCT_MAX_ACTIVE_EXPERTS],
    ['maxProvisionAttempts', policy.maxProvisionAttempts, Number.MAX_SAFE_INTEGER],
    ['maxTasks', policy.maxTasks, Number.MAX_SAFE_INTEGER],
    ['maxPublicMessages', policy.maxPublicMessages, Number.MAX_SAFE_INTEGER],
    ['maxPublicMessageBytes', policy.maxPublicMessageBytes, Number.MAX_SAFE_INTEGER],
    ['maxArtifacts', policy.maxArtifacts, Number.MAX_SAFE_INTEGER],
    ['maxArtifactBodyBytes', policy.maxArtifactBodyBytes, Number.MAX_SAFE_INTEGER],
    ['taskStallCursorThreshold', policy.taskStallCursorThreshold, Number.MAX_SAFE_INTEGER],
  ]
  for (const [name, value, maximum] of limits) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TeamRunError(
        `${name} must be a positive safe integer${maximum === Number.MAX_SAFE_INTEGER ? '' : ` no greater than ${maximum}`}`,
        'TEAM_INVALID_CONFIG',
        { details: { name, value, maximum } },
      )
    }
  }
  return policy
}
