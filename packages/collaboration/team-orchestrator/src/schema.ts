/** Strict decoding for persisted profile, plan, and charter payloads. */

import { z } from 'zod'
import { TeamRunId } from '@deepseek-ai/dsh-agent-team'
import { ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  TeamOrchestrationEventId,
  TeamOrchestrationRequestId,
  TeamPlanSlotId,
} from './ids.ts'
import type {
  TeamCharterEventData,
  TeamPlanEventData,
  TeamProfileEventData,
} from './types.ts'

const nonEmpty = z.string().min(1)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = nonEmpty.transform(TeamOrchestrationRequestId)
const eventId = nonEmpty.transform(TeamOrchestrationEventId)
const runId = nonEmpty.transform(TeamRunId)
const slotId = nonEmpty.transform(TeamPlanSlotId)
const modelSelection = z.object({
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
}).strict().transform(value => value as ModelSelection)
const domain = z.enum(['research_analysis', 'product_solution', 'software_development'])
const complexity = z.enum(['simple', 'medium', 'complex'])
const topology = z.enum(['producer_reviewer', 'centralized', 'parallel', 'hybrid', 'grouped'])
const ref = z.object({
  id: nonEmpty.transform(ExpertBlueprintId),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const workstream = z.object({
  id: nonEmpty,
  subject: nonEmpty,
  description: nonEmpty,
  blockedBy: z.array(nonEmpty),
  requiredCapabilities: z.array(nonEmpty),
  resourceScopes: z.array(nonEmpty),
}).strict()
const plannedWorkstream = workstream.extend({ assigneeSlotId: slotId.optional() }).strict()
const executionStage = z.object({
  id: nonEmpty,
  order: z.number().int().positive(),
  mode: z.enum(['serial', 'parallel']),
  workstreamIds: z.array(nonEmpty).min(1),
}).strict()
const budget = z.object({
  maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const marketplaceSource = z.enum(['smithery', 'composio', 'skills_sh'])
const marketplaceCapability = z.object({
  id: nonEmpty,
  name: nonEmpty,
  description: nonEmpty,
  source: marketplaceSource,
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
const profile = z.object({
  domain,
  objective: nonEmpty,
  successCriteria: z.array(nonEmpty).min(1),
  workstreams: z.array(workstream).min(1),
  workstreamSource: z.enum(['explicit', 'inferred']).optional(),
  riskSignals: z.array(nonEmpty),
  context: z.record(z.string(), nonEmpty),
  complexity,
  plannedExperts: z.number().int().min(1).max(8),
  leadModelSelection: modelSelection.optional(),
  planRequirements: z.object({
    minimumSkillsPerExpert: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    expertSkills: z.array(z.object({
      target: nonEmpty,
      operation: z.enum(['replace', 'add', 'remove']),
      skills: z.array(nonEmpty).min(1).max(200),
    }).strict()).max(32).optional(),
    stageModes: z.array(z.object({
      order: z.number().int().positive(),
      mode: z.enum(['serial', 'parallel']),
    }).strict()).optional(),
    taskInstructions: z.array(z.object({
      stageOrder: z.number().int().positive().optional(),
      taskOrder: z.number().int().positive(),
      instruction: nonEmpty,
    }).strict()).max(64).optional(),
    expertModels: z.array(z.object({
      slotId,
      selection: modelSelection,
    }).strict()).max(8).optional(),
  }).strict().optional(),
  metrics: z.object({
    workstreamCount: z.number().int().positive(),
    dependencyCount: z.number().int().nonnegative(),
    independentWorkstreams: z.number().int().positive(),
    longestDependencyPath: z.number().int().positive(),
    capabilityCount: z.number().int().nonnegative(),
    riskSignalCount: z.number().int().nonnegative(),
    decomposable: z.boolean(),
    toolDensity: z.enum(['low', 'medium', 'high']),
    risk: z.enum(['low', 'medium', 'high']),
  }).strict(),
}).strict()
const plannedExpert = z.object({
  slotId,
  name: nonEmpty,
  role: nonEmpty,
  blueprint: ref,
  modelSelection: modelSelection.optional(),
  localSkills: z.array(nonEmpty).min(1).max(200).optional(),
  assignment: z.object({
    objective: nonEmpty,
    language: z.enum(['zh', 'en']).optional(),
    inputs: z.record(z.string(), z.string()),
  }).strict(),
  acceptanceCriteria: z.array(nonEmpty),
  budget,
  skillDiscovery: z.object({
    providers: z.array(z.object({
      source: marketplaceSource,
      state: z.enum(['ready', 'authorization_required', 'unavailable']),
    }).strict()).max(3),
    mounts: z.array(marketplaceCapability).max(12),
  }).strict().optional(),
}).strict()
const plan = z.object({
  topology,
  roster: z.array(plannedExpert).min(1).max(8),
  taskDag: z.array(plannedWorkstream).min(1),
  stages: z.array(executionStage).min(1).optional(),
}).strict()
const charter = z.object({
  objective: nonEmpty,
  successCriteria: z.array(nonEmpty).min(1),
  topology,
  roster: z.array(z.object({ slotId, name: nonEmpty, role: nonEmpty, blueprint: ref }).strict()).min(1).max(8),
  taskDag: z.array(plannedWorkstream).min(1),
  stages: z.array(executionStage).min(1).optional(),
  communication: z.object({
    maxChallengeRounds: z.number().int().positive(),
    maxMessagesPerExpert: z.number().int().positive(),
  }).strict(),
  qualityChecks: z.array(nonEmpty).min(1),
  budgets: z.array(z.object({ slotId, execution: budget }).strict()).min(1).max(8),
  termination: z.object({
    success: z.literal('all_tasks_completed_and_reviewed'),
    formationFailure: z.literal('fail_closed'),
  }).strict(),
}).strict()
const common = {
  version: z.literal(1),
  eventId,
  runId,
  requestId,
  requestDigest: digest,
} as const
const profileEvent = z.object({
  ...common,
  retryOf: requestId.optional(),
  revision: z.literal(1),
  profile,
}).strict() as z.ZodType<TeamProfileEventData>
const planEvent = z.object({
  ...common,
  revision: z.literal(2),
  planDigest: digest,
  plan,
}).strict() as z.ZodType<TeamPlanEventData>
const charterEvent = z.object({
  ...common,
  revision: z.literal(3),
  planDigest: digest,
  charterDigest: digest,
  charter,
}).strict() as z.ZodType<TeamCharterEventData>

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value)
  } catch (cause: unknown) {
    throw new Error(`persisted ${label} payload is invalid`, { cause })
  }
}

/**
 * Decode one persisted task-profile event.
 * @param value - persisted payload.
 * @returns detached current-version profile event.
 */
export const parseTeamProfileEvent = (value: unknown): TeamProfileEventData => parse(profileEvent, value, 'team profile')

/**
 * Decode one persisted team-plan event.
 * @param value - persisted payload.
 * @returns detached current-version plan event.
 */
export const parseTeamPlanEvent = (value: unknown): TeamPlanEventData => parse(planEvent, value, 'team plan')

/**
 * Decode one persisted team-charter event.
 * @param value - persisted payload.
 * @returns detached current-version charter event.
 */
export const parseTeamCharterEvent = (value: unknown): TeamCharterEventData => parse(charterEvent, value, 'team charter')
