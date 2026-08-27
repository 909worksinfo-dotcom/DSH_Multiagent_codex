/** Deterministic JSON hashing for immutable expert capability records. */

import { createHash } from 'node:crypto'

/** Encode objects with lexical keys while preserving array order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('expert digest values must contain only finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('expert digest values must be JSON-compatible')
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

/**
 * Hash one JSON-compatible value with canonical object-key ordering.
 * @param value - detached immutable value.
 * @returns lowercase SHA-256 hexadecimal text.
 */
export function digestJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Hash exact UTF-8 text.
 * @param value - source text.
 * @returns lowercase SHA-256 hexadecimal text.
 */
export function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
