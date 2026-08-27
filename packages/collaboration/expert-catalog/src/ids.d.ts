/** Zero-cost constructors for ExpertBlueprint branded identities. */
import type { ExpertBindingDigest as Digest, ExpertBlueprintId as Id } from './types.ts';
/**
 * Brand a validated blueprint id.
 * @param value - raw blueprint identity.
 * @returns the same value branded as a blueprint id.
 */
export declare const ExpertBlueprintId: (value: string) => Id;
/**
 * Brand a validated SHA-256 binding digest.
 * @param value - lowercase hexadecimal digest.
 * @returns the same value branded as an expert binding digest.
 */
export declare const ExpertBindingDigest: (value: string) => Digest;
//# sourceMappingURL=ids.d.ts.map