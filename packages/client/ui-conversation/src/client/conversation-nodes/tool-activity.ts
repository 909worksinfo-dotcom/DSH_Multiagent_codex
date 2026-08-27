/** Interaction tools that must remain in ordinary Chat flow. */
const STANDALONE_TOOL_NAMES = new Set([
  'ask_user_question',
  'exit_plan_mode',
])

const SUMMARIZED_TOOL_NAMES = new Set([
  'edit',
  'glob',
  'grep',
  'write',
])

/**
 * Whether one tool belongs to the compact execution-activity presentation.
 * @param name - stable tool registry name, when recoverable from history.
 * @returns true for execution tools whose rows belong to the bounded process flow.
 */
export function isCompactToolActivity(name: string | undefined): boolean {
  return name !== undefined && !STANDALONE_TOOL_NAMES.has(name)
}

/**
 * Whether completed calls collapse into the concise per-turn count row.
 * @param name - stable tool registry name, when recoverable from history.
 * @returns true when individual completed rows add no distinct detail surface.
 */
export function isSummarizedToolActivity(name: string | undefined): boolean {
  return name !== undefined && SUMMARIZED_TOOL_NAMES.has(name)
}
