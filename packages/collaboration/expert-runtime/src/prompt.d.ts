/** Deterministic initial expert assignment rendering. */
import type { ExpertBlueprint } from '@deepseek-ai/dsh-expert-catalog';
import type { ExpertAssignment } from './types.ts';
/**
 * Render the logged initial prompt for one blueprint-bound expert.
 * @param name - stable roster name.
 * @param blueprint - exact immutable definition.
 * @param assignment - validated task inputs.
 * @returns user-safe prompt with no private reasoning request.
 */
export declare function renderExpertInitialPrompt(name: string, blueprint: ExpertBlueprint, assignment: ExpertAssignment): string;
//# sourceMappingURL=prompt.d.ts.map