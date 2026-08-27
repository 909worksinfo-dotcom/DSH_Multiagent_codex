/** Deterministic JSON hashing for immutable expert capability records. */
/**
 * Hash one JSON-compatible value with canonical object-key ordering.
 * @param value - detached immutable value.
 * @returns lowercase SHA-256 hexadecimal text.
 */
export declare function digestJson(value: unknown): string;
/**
 * Hash exact UTF-8 text.
 * @param value - source text.
 * @returns lowercase SHA-256 hexadecimal text.
 */
export declare function digestText(value: string): string;
//# sourceMappingURL=digest.d.ts.map