/** TeamRun input normalization at model, config, and persistence entry points. */

import { TeamRunError } from './error.ts'

const EXPERT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Normalize required human-authored text.
 * @param value - raw text.
 * @param field - diagnostic field name.
 * @param maximum - maximum normalized character count.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: string, field: string, maximum: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamRunError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maximum) {
    throw new TeamRunError(`${field} exceeds ${maximum} characters`, 'TEAM_INVALID_ARGUMENT')
  }
  return text
}

/**
 * Validate one never-reused expert name.
 * @param value - model-facing expert name.
 * @returns the validated lower-kebab-case value.
 */
export function expertName(value: string): string {
  if (!EXPERT_NAME.test(value) || value.length > 64 || value === 'lead') {
    throw new TeamRunError(
      'expert name must be lower-kebab-case, at most 64 characters, and not "lead"',
      'TEAM_INVALID_ARGUMENT',
    )
  }
  return value
}

/**
 * Normalize a generic hierarchical advisory resource scope.
 * @param value - user-authored scope such as `document/requirements` or `repo/src`.
 * @returns a slash-delimited non-empty scope without control characters.
 */
export function resourceScope(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (normalized.length === 0 || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamRunError(`invalid resource scope ${JSON.stringify(value)}`, 'TEAM_INVALID_ARGUMENT')
  }
  return normalized
}

/**
 * Test hierarchical overlap without granting access or locking a resource.
 * @param left - normalized resource scope.
 * @param right - normalized resource scope.
 * @returns whether either scope contains the other on slash boundaries.
 */
export function resourceScopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
