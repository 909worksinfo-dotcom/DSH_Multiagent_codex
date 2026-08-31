/** Strict deployment-boundary validation for ExpertBlueprint revisions. */

import { z } from 'zod'
import { ExpertBlueprintId } from './ids.ts'
import type { ExpertBlueprint } from './types.ts'

const id = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const text = (maximum: number) => z.string().trim().min(1).max(maximum)
const uniqueStrings = (label: string, maximum: number) => z.array(text(maximum)).max(128).superRefine((values, ctx) => {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) ctx.addIssue({ code: 'custom', message: `duplicate ${label} ${JSON.stringify(value)}`, path: [index] })
    seen.add(value)
  }
})
const fields = z.array(z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  description: text(1_000),
  required: z.boolean(),
}).strict()).max(64).superRefine((values, ctx) => {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value.name)) ctx.addIssue({ code: 'custom', message: `duplicate field ${JSON.stringify(value.name)}`, path: [index, 'name'] })
    seen.add(value.name)
  }
})
const toolPolicy = z.object({
  allow: uniqueStrings('allowed tool', 200).optional(),
  deny: uniqueStrings('denied tool', 200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.allow === undefined && value.deny === undefined) {
    ctx.addIssue({ code: 'custom', message: 'tools must declare allow and/or deny' })
    return
  }
  const allowed = new Set(value.allow ?? [])
  for (const denied of value.deny ?? []) {
    if (allowed.has(denied)) ctx.addIssue({ code: 'custom', message: `tool ${JSON.stringify(denied)} cannot be both allowed and denied` })
  }
})
const blueprint = z.object({
  ref: z.object({
    id: id.transform(ExpertBlueprintId),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  role: text(200),
  objective: text(8_192),
  preset: id,
  skills: uniqueStrings('skill', 200),
  plugins: uniqueStrings('plugin', 500),
  tools: toolPolicy,
  model: z.object({
    provider: text(200).optional(),
    model: text(200).optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  persona: text(16_384).optional(),
  inputs: fields,
  outputs: fields,
  acceptanceCriteria: uniqueStrings('acceptance criterion', 2_000).min(1).max(64),
  collaboration: z.object({
    challenge: z.boolean(),
    review: z.boolean(),
    requestHelp: z.boolean(),
  }).strict(),
  budget: z.object({
    maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict()

/**
 * Validate and detach one configured immutable blueprint.
 * @param value - deployment configuration value.
 * @returns a deeply detached blueprint.
 */
export function parseBlueprint(value: unknown): ExpertBlueprint {
  return blueprint.parse(value) as ExpertBlueprint
}
