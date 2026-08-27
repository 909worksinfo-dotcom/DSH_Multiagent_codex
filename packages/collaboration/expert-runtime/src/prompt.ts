/** Deterministic initial expert assignment rendering. */

import type { ExpertBlueprint } from '@deepseek-ai/dsh-expert-catalog'
import type { SkillMarketplaceCapability } from '@deepseek-ai/dsh-skill-marketplace'
import type { ExpertAssignment } from './types.ts'

/** Validate task inputs against one immutable blueprint. */
function validateInputs(blueprint: ExpertBlueprint, assignment: ExpertAssignment): void {
  if (assignment.objective.trim() === '') throw new TypeError('expert assignment objective must be non-blank')
  const declared = new Map(blueprint.inputs.map(field => [field.name, field]))
  for (const field of blueprint.inputs) {
    if (field.required && assignment.inputs[field.name]?.trim() === undefined) {
      throw new TypeError(`expert assignment requires input "${field.name}"`)
    }
  }
  for (const [name, value] of Object.entries(assignment.inputs)) {
    if (!declared.has(name)) throw new TypeError(`expert assignment contains undeclared input "${name}"`)
    if (value.trim() === '') throw new TypeError(`expert assignment input "${name}" must be non-blank`)
  }
}

/** Render one field list in stable blueprint order. */
function renderFields(
  heading: string,
  fields: readonly { readonly name: string; readonly description: string; readonly required: boolean }[],
  values?: Readonly<Record<string, string>>,
): string[] {
  return [
    heading,
    ...fields.map(field => `- ${field.name}${field.required ? ' (required)' : ''}: ${values?.[field.name] ?? field.description}`),
  ]
}

/**
 * Render the logged initial prompt for one blueprint-bound expert.
 * @param name - stable roster name.
 * @param blueprint - exact immutable definition.
 * @param assignment - validated task inputs.
 * @param marketplaceSkills - persisted task-time capabilities selected for this expert.
 * @returns user-safe prompt with no private reasoning request.
 */
export function renderExpertInitialPrompt(
  name: string,
  blueprint: ExpertBlueprint,
  assignment: ExpertAssignment,
  marketplaceSkills: readonly SkillMarketplaceCapability[] = [],
): string {
  validateInputs(blueprint, assignment)
  const languageRequirement = assignment.language === undefined
    ? []
    : assignment.language === 'zh'
      ? [
        '',
        'Language requirement:',
        '- Use Simplified Chinese for every public conclusion, question, challenge, response, review, artifact, and deliverable.',
        '- If a source or tool returns another language, summarize or translate it into Chinese before publishing.',
        '- In public text, refer to the Lead as “主协调智能体” and every expert by the full assigned role name in the Team Charter (for example, “市场分析专家”); never use expert-N or “专家N”. Keep internal identifiers only in tool arguments.',
        '- Except for user-provided proper nouns and necessary technical abbreviations, avoid English role names and interface terms.',
      ]
      : [
        '',
        'Language requirement:',
        '- Use English for every public conclusion, question, challenge, response, review, artifact, and deliverable.',
        '- If a source or tool returns another language, summarize or translate it into English before publishing.',
        '- Refer to every expert by the full assigned role name from the Team Charter in public text; never expose expert-N identifiers.',
      ]
  return [
    `You are expert "${name}" in a Lead-coordinated collaboration team.`,
    '',
    `Role: ${blueprint.role}`,
    `Responsibility: ${blueprint.objective}`,
    `Assignment: ${assignment.objective.trim()}`,
    ...languageRequirement,
    '',
    ...renderFields('Inputs:', blueprint.inputs, assignment.inputs),
    '',
    ...renderFields('Required outputs:', blueprint.outputs),
    '',
    'Acceptance criteria:',
    ...blueprint.acceptanceCriteria.map(value => `- ${value}`),
    '',
    'Required skills:',
    ...blueprint.skills.map(value => `- ${value}`),
    ...marketplaceSkills.filter(value => value.status === 'loaded').map(value => `- ${value.skillName ?? value.name} (${value.name}, skills.sh)`),
    '',
    'Discovered remote capabilities:',
    ...marketplaceSkills.filter(value => value.kind === 'remote_tool').map(value => `- ${value.name} (${value.source}, ${value.status})`),
    '',
    'Load the required skills through the available skill capability before relying on them. ',
    'Before returning your final assistant response, publish at least one concise public inform, proposal, review, challenge, response, or completion_request through collaboration_send. A direct assistant response alone does not count as a team contribution. ',
    'For ordinary public messages, omit challenge_id. Only challenge and response may include challenge_id, and both require the same explicit dispute thread_id and exactly one target. ',
    'Immediately before a compare-and-set task update, call collaboration_get or collaboration_task_get again and use the latest revision. ',
    'Publish task-relevant conclusions, questions, challenges, reviews, and artifacts through the collaboration tools. ',
    'Never publish private chain-of-thought or hidden reasoning.',
  ].join('\n')
}
