/** Strict deployment-boundary validation for ExpertBlueprint revisions. */
import type { ExpertBlueprint } from './types.ts';
/**
 * Validate and detach one configured immutable blueprint.
 * @param value - deployment configuration value.
 * @returns a deeply detached blueprint.
 */
export declare function parseBlueprint(value: unknown): ExpertBlueprint;
//# sourceMappingURL=validation.d.ts.map