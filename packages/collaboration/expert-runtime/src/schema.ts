/** Strict decoding for persisted expert binding and child descriptor events. */

import { z } from 'zod'
import {
  ProvisionAttemptId,
  TeamMemberId,
  TeamRunId,
} from '@deepseek-ai/dsh-agent-team'
import { ExpertBindingDigest, ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExpertRuntimeEventId } from './ids.ts'
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from './types.ts'

const nonEmpty = z.string().min(1)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const ref = z.object({
  id: nonEmpty.transform(ExpertBlueprintId),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const skill = z.object({
  name: nonEmpty,
  provider: nonEmpty,
  source: nonEmpty,
  contentDigest: digest,
  path: nonEmpty.optional(),
}).strict()
const marketplaceSkill = z.object({
  id: nonEmpty,
  name: nonEmpty,
  description: nonEmpty,
  source: z.enum(['smithery', 'composio', 'skills_sh']),
  kind: z.enum(['remote_tool', 'method_skill']),
  status: z.enum(['loaded', 'connected', 'authorization_required']),
  access: z.enum(['public', 'platform', 'user']).optional(),
  verified: z.boolean(),
  popularity: z.number().nonnegative().optional(),
  skillName: nonEmpty.optional(),
  instructions: nonEmpty.optional(),
  connection: z.object({
    connectionId: nonEmpty,
    toolNames: z.array(nonEmpty).min(1),
  }).strict().optional(),
}).strict()
const agentOptions = z.object({
  provider: nonEmpty.optional(),
  model: nonEmpty.optional(),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
const descriptor = z.object({
  blueprint: ref,
  displayRole: nonEmpty.optional(),
  blueprintDigest: digest,
  preset: z.object({ id: nonEmpty, contentDigest: digest }).strict(),
  skills: z.array(skill),
  marketplaceSkills: z.array(marketplaceSkill).max(12).optional(),
  plugins: z.array(nonEmpty),
  digest: digest.transform(ExpertBindingDigest),
  model: agentOptions,
  foundation: z.object({
    modelSelection: z.object({
      provider: nonEmpty,
      model: nonEmpty,
      reasoningEffort: nonEmpty.transform(ReasoningEffortId).optional(),
    }).strict(),
    toolAccess: z.enum(['full_preset', 'restricted']),
    permissions: z.object({
      sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
      approvalPolicy: z.enum(['ask', 'never']),
    }).strict(),
  }).strict().optional(),
  compositionDigest: digest,
  execution: z.object({
    maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict()
const toolFilter = z.object({
  allow: z.array(nonEmpty).optional(),
  deny: z.array(nonEmpty).optional(),
}).strict()
const common = {
  version: z.literal(1),
  eventId: nonEmpty.transform(ExpertRuntimeEventId),
  runId: nonEmpty.transform(TeamRunId),
  memberId: nonEmpty.transform(TeamMemberId),
  sessionId: nonEmpty.transform(SessionId),
  attemptId: nonEmpty.transform(ProvisionAttemptId),
  descriptor,
} as const
const binding = z.object({
  ...common,
  name: nonEmpty,
  role: nonEmpty,
  subagentProvider: nonEmpty,
  initialPrompt: nonEmpty,
  agentOptions,
  persona: nonEmpty.optional(),
  toolFilter,
}).strict() as z.ZodType<ExpertBindingEventData>
const child = z.object(common).strict() as z.ZodType<ExpertChildDescriptorEventData>

/**
 * Decode one Lead-side binding from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version binding.
 */
export function parseExpertBinding(value: unknown): ExpertBindingEventData {
  try {
    return binding.parse(value)
  } catch (cause: unknown) {
    throw new Error('persisted expert binding payload is invalid', { cause })
  }
}

/**
 * Decode one child-side descriptor from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version descriptor.
 */
export function parseExpertChildDescriptor(value: unknown): ExpertChildDescriptorEventData {
  try {
    return child.parse(value)
  } catch (cause: unknown) {
    throw new Error('persisted expert child descriptor payload is invalid', { cause })
  }
}
