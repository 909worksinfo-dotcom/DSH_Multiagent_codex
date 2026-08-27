/** Strict JSON decoding for persisted collaboration event payloads. */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CollaborationEventId,
  CollaborationMessageId,
  ProvisionAttemptId,
  TeamArtifactId,
  TeamChallengeId,
  TeamDecisionId,
  TeamMemberId,
  TeamQualityGateId,
  TeamProtocolSlotId,
  TeamRunId,
  TeamTaskId,
  TeamThreadId,
} from './ids.ts'
import { COLLABORATION_ERROR_CODES } from './error.ts'
import type {
  StoredPublicCollaborationMessage,
  TeamActorRef,
  TeamFailure,
  TeamMemberSnapshot,
  TeamRunCreatedEventData,
  TeamRunArtifactEventData,
  TeamRunDecisionEventData,
  TeamRunQualityGateEventData,
  TeamRunId as TeamRunIdType,
  TeamRunMemberEventData,
  TeamRunMessageEventData,
  TeamRunProtocolEventData,
  TeamRunPhaseEventData,
  TeamRunPolicySnapshot,
  TeamRunTaskEventData,
  TeamTaskSnapshot,
} from './types.ts'

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveInteger = nonNegativeInteger.min(1)
const nonEmpty = z.string().min(1)
const sessionId = nonEmpty.transform(value => SessionId(value))
const runId = nonEmpty.transform(value => TeamRunId(value))
const memberId = nonEmpty.transform(value => TeamMemberId(value))
const attemptId = nonEmpty.transform(value => ProvisionAttemptId(value))
const taskId = nonEmpty.transform(value => TeamTaskId(value))
const threadId = nonEmpty.transform(value => TeamThreadId(value))
const messageId = nonEmpty.transform(value => CollaborationMessageId(value))
const eventId = nonEmpty.transform(value => CollaborationEventId(value))
const artifactId = nonEmpty.transform(value => TeamArtifactId(value))
const decisionId = nonEmpty.transform(value => TeamDecisionId(value))
const qualityGateId = nonEmpty.transform(value => TeamQualityGateId(value))
const protocolSlotId = nonEmpty.transform(value => TeamProtocolSlotId(value))

const failureCode = z.enum(COLLABORATION_ERROR_CODES)
const failureDetail = z.union([z.string(), z.number(), z.boolean(), z.null()])
const failure = z.object({
  code: failureCode,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), failureDetail),
}).strict() as z.ZodType<TeamFailure>

const currentPolicy = z.object({
  maxActiveExperts: positiveInteger,
  maxProvisionAttempts: positiveInteger,
  maxTasks: positiveInteger,
  maxPublicMessages: positiveInteger,
  maxPublicMessageBytes: positiveInteger,
  maxArtifacts: positiveInteger,
  maxArtifactBodyBytes: positiveInteger,
  taskStallCursorThreshold: positiveInteger,
}).strict() as z.ZodType<TeamRunPolicySnapshot>

// P0-P4 wrote version-one creation events before the P5 ledger/controller
// limits existed. Keep the compatibility values frozen here: replay must not
// depend on deployment configuration that may change after the event was
// committed.
const legacyPolicy = z.object({
  maxActiveExperts: positiveInteger,
  maxProvisionAttempts: positiveInteger,
  maxTasks: positiveInteger,
  maxPublicMessages: positiveInteger,
  maxPublicMessageBytes: positiveInteger,
}).strict().transform((value): TeamRunPolicySnapshot => ({
  ...value,
  maxArtifacts: 512,
  maxArtifactBodyBytes: 1_048_576,
  taskStallCursorThreshold: 20,
}))

const persistedPolicy = z.union([currentPolicy, legacyPolicy])

const leadActor = z.object({
  role: z.literal('lead'),
  sessionId,
  name: z.literal('lead'),
}).strict()
const expertActor = z.object({
  role: z.literal('expert'),
  memberId,
  sessionId,
  name: nonEmpty,
}).strict()
const actor = z.discriminatedUnion('role', [leadActor, expertActor]) as z.ZodType<TeamActorRef>

const member = z.object({
  id: memberId,
  sessionId,
  name: nonEmpty,
  role: nonEmpty,
  protocolSlotId: protocolSlotId.optional(),
  attemptId,
  attemptNumber: positiveInteger,
  phase: z.enum(['provisioning', 'active', 'failed']),
  failure: failure.optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

const task = z.object({
  id: taskId,
  revision: positiveInteger,
  subject: nonEmpty,
  description: nonEmpty,
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  owner: actor.optional(),
  blockedBy: z.array(taskId),
  resourceScopes: z.array(nonEmpty),
}).strict() as z.ZodType<TeamTaskSnapshot>

const references = z.object({
  taskId: taskId.optional(),
  challengeId: nonEmpty.transform(value => TeamChallengeId(value)).optional(),
  decisionId: nonEmpty.transform(value => TeamDecisionId(value)).optional(),
  artifactId: nonEmpty.transform(value => TeamArtifactId(value)).optional(),
}).strict()
const storedMessage = z.object({
  id: messageId,
  threadId,
  kind: z.enum([
    'task',
    'inform',
    'proposal',
    'request_help',
    'challenge',
    'response',
    'review',
    'decision',
    'handoff',
    'blocked',
    'completion_request',
    'artifact',
    'status',
    'final_delivery',
  ]),
  author: actor,
  targets: z.array(actor),
  references,
  content: nonEmpty,
  visibility: z.literal('public'),
}).strict() as z.ZodType<StoredPublicCollaborationMessage>

const selector = z.object({
  version: nonNegativeInteger,
  runId,
}).loose()

const created = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: z.literal(1),
  leadId: sessionId,
  objective: nonEmpty,
  complexity: z.enum(['simple', 'medium', 'complex']),
  plannedExperts: positiveInteger,
  policy: persistedPolicy,
}).strict() as z.ZodType<TeamRunCreatedEventData>

const phase = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  phase: z.enum([
    'planning',
    'provisioning',
    'active',
    'completing',
    'completed',
    'formation_failed',
    'failed',
    'cancelled',
  ]),
  failure: failure.optional(),
}).strict() as z.ZodType<TeamRunPhaseEventData>

const memberEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  member,
}).strict() as z.ZodType<TeamRunMemberEventData>

const taskEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  task,
}).strict() as z.ZodType<TeamRunTaskEventData>

const messageEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  message: storedMessage,
}).strict() as z.ZodType<TeamRunMessageEventData>

const protocolPermissions = z.object({
  challenge: z.boolean(),
  review: z.boolean(),
  requestHelp: z.boolean(),
}).strict()
const protocol = z.object({
  topology: z.enum(['producer_reviewer', 'centralized', 'parallel', 'hybrid', 'grouped']),
  maxChallengeRounds: positiveInteger,
  maxMessagesPerExpert: positiveInteger,
  experts: z.array(z.object({
    slotId: protocolSlotId,
    initialMemberId: memberId,
    name: nonEmpty,
    permissions: protocolPermissions,
    allowedTargetSlotIds: z.array(protocolSlotId),
  }).strict()).min(1).max(8),
}).strict()
const protocolEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  protocol,
}).strict() as z.ZodType<TeamRunProtocolEventData>

const artifact = z.object({
  id: artifactId,
  version: positiveInteger,
  kind: z.enum([
    'document', 'code', 'dataset', 'evidence', 'analysis', 'product_spec', 'design', 'test_report', 'final_delivery',
  ]),
  title: nonEmpty,
  status: z.enum(['draft', 'review', 'accepted', 'superseded']),
  author: actor,
  taskIds: z.array(taskId),
  mediaType: nonEmpty,
  body: nonEmpty,
}).strict()

const artifactEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  artifact,
}).strict() as z.ZodType<TeamRunArtifactEventData>

const decision = z.object({
  id: decisionId,
  version: positiveInteger,
  subject: nonEmpty,
  outcome: z.enum(['accepted', 'rejected', 'revise', 'unresolved', 'reassign', 'rework', 'replan']),
  summary: nonEmpty,
  rationale: nonEmpty,
  taskIds: z.array(taskId),
  artifactIds: z.array(artifactId),
  lead: leadActor,
}).strict()

const decisionEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  decision,
}).strict() as z.ZodType<TeamRunDecisionEventData>

const qualityGate = z.object({
  id: qualityGateId,
  version: positiveInteger,
  name: nonEmpty,
  status: z.enum(['pending', 'passed', 'failed']),
  reviewer: actor.optional(),
  taskId: taskId.optional(),
  artifactId: artifactId.optional(),
  summary: z.string(),
}).strict()

const qualityGateEvent = z.object({
  version: z.literal(1),
  runId,
  eventId,
  revision: positiveInteger,
  gate: qualityGate,
}).strict() as z.ZodType<TeamRunQualityGateEventData>

/** Supported persisted collaboration event keys. */
export type TeamRunEventType =
  | 'collaboration/run/created'
  | 'collaboration/run/phase'
  | 'collaboration/member'
  | 'collaboration/task'
  | 'collaboration/message'
  | 'collaboration/protocol'
  | 'collaboration/artifact'
  | 'collaboration/decision'
  | 'collaboration/quality-gate'

/** Minimal selector decoded before inherited-run filtering. */
export interface TeamRunEventSelector {
  readonly version: number
  readonly runId: TeamRunIdType
}

/**
 * Decode the event selector required for version and fork filtering.
 * @param type - durable collaboration event key.
 * @param value - persisted payload.
 * @returns validated selector fields.
 */
export function parseTeamRunEventSelector(type: TeamRunEventType, value: unknown): TeamRunEventSelector {
  try {
    return selector.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted TeamRun ${type} selector is invalid`, { cause: error })
  }
}

/**
 * Decode one complete current-version payload.
 * @param type - durable collaboration event key.
 * @param value - persisted payload.
 * @returns the validated payload correlated with `type`.
 */
export function parseCurrentTeamRunEvent(
  type: 'collaboration/run/created',
  value: unknown,
): TeamRunCreatedEventData
/**
 * Decode one current lifecycle payload.
 * @param type - lifecycle event key.
 * @param value - persisted payload.
 * @returns validated lifecycle payload.
 */
export function parseCurrentTeamRunEvent(
  type: 'collaboration/run/phase',
  value: unknown,
): TeamRunPhaseEventData
/**
 * Decode one current member payload.
 * @param type - member event key.
 * @param value - persisted payload.
 * @returns validated member payload.
 */
export function parseCurrentTeamRunEvent(
  type: 'collaboration/member',
  value: unknown,
): TeamRunMemberEventData
/**
 * Decode one current task payload.
 * @param type - task event key.
 * @param value - persisted payload.
 * @returns validated task payload.
 */
export function parseCurrentTeamRunEvent(
  type: 'collaboration/task',
  value: unknown,
): TeamRunTaskEventData
/**
 * Decode one current public-message payload.
 * @param type - public-message event key.
 * @param value - persisted payload.
 * @returns validated public-message payload.
 */
export function parseCurrentTeamRunEvent(
  type: 'collaboration/message',
  value: unknown,
): TeamRunMessageEventData
/**
 * Decode one current collaboration-protocol payload.
 * @param type - collaboration-protocol event key.
 * @param value - persisted payload.
 * @returns validated collaboration-protocol payload.
 */
export function parseCurrentTeamRunEvent(type: 'collaboration/protocol', value: unknown): TeamRunProtocolEventData
/**
 * Decode one current artifact payload.
 * @param type - artifact event key.
 * @param value - persisted payload.
 * @returns validated artifact payload.
 */
export function parseCurrentTeamRunEvent(type: 'collaboration/artifact', value: unknown): TeamRunArtifactEventData
/**
 * Decode one current decision payload.
 * @param type - decision event key.
 * @param value - persisted payload.
 * @returns validated decision payload.
 */
export function parseCurrentTeamRunEvent(type: 'collaboration/decision', value: unknown): TeamRunDecisionEventData
/**
 * Decode one current quality-gate payload.
 * @param type - quality-gate event key.
 * @param value - persisted payload.
 * @returns validated quality-gate payload.
 */
export function parseCurrentTeamRunEvent(type: 'collaboration/quality-gate', value: unknown): TeamRunQualityGateEventData
/**
 * Decode one current payload selected by a dynamic TeamRun event key.
 * @param type - durable collaboration event key.
 * @param value - persisted payload.
 * @returns validated payload for the supplied event key.
 */
export function parseCurrentTeamRunEvent(
  type: TeamRunEventType,
  value: unknown,
):
  | TeamRunCreatedEventData
  | TeamRunPhaseEventData
  | TeamRunMemberEventData
  | TeamRunTaskEventData
  | TeamRunMessageEventData
  | TeamRunProtocolEventData
  | TeamRunArtifactEventData
  | TeamRunDecisionEventData
  | TeamRunQualityGateEventData
export function parseCurrentTeamRunEvent(type: TeamRunEventType, value: unknown):
  | TeamRunCreatedEventData
  | TeamRunPhaseEventData
  | TeamRunMemberEventData
  | TeamRunTaskEventData
  | TeamRunMessageEventData
  | TeamRunProtocolEventData
  | TeamRunArtifactEventData
  | TeamRunDecisionEventData
  | TeamRunQualityGateEventData {
  try {
    switch (type) {
      case 'collaboration/run/created': return created.parse(value)
      case 'collaboration/run/phase': return phase.parse(value)
      case 'collaboration/member': return memberEvent.parse(value)
      case 'collaboration/task': return taskEvent.parse(value)
      case 'collaboration/message': return messageEvent.parse(value)
      case 'collaboration/protocol': return protocolEvent.parse(value)
      case 'collaboration/artifact': return artifactEvent.parse(value)
      case 'collaboration/decision': return decisionEvent.parse(value)
      case 'collaboration/quality-gate': return qualityGateEvent.parse(value)
    }
  } catch (error: unknown) {
    throw new Error(`persisted TeamRun ${type} payload is invalid`, { cause: error })
  }
}
