/** Canonical JSON digests used to bind P3 durable records. */

import { createHash } from 'node:crypto'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

/**
 * Hash a JSON-compatible value independent of object property insertion order.
 * @param value - JSON-compatible value.
 * @returns lowercase SHA-256 of canonical JSON.
 */
export function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
