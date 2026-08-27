/** Zero-cost constructors for ExpertBlueprint branded identities. */

import type { ExpertBindingDigest as Digest, ExpertBlueprintId as Id } from './types.ts'

/**
 * Brand a validated blueprint id.
 * @param value - raw blueprint identity.
 * @returns the same value branded as a blueprint id.
 */
export const ExpertBlueprintId = (value: string): Id => value as Id

/**
 * Brand a validated SHA-256 binding digest.
 * @param value - lowercase hexadecimal digest.
 * @returns the same value branded as an expert binding digest.
 */
export const ExpertBindingDigest = (value: string): Digest => value as Digest
