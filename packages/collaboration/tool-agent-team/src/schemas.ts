/** Canonical compact JSON values returned by stable TeamRun model tools. */

import type {
  PublicCollaborationMessageKind,
  TeamRunPhase,
  TeamRunPublicStatus,
  TeamTaskAction,
} from '@deepseek-ai/dsh-agent-team'

/** Exact public message kinds accepted and returned by the model adapter. */
export const PUBLIC_MESSAGE_KINDS = [
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
] as const satisfies readonly PublicCollaborationMessageKind[]

/** Public statement kinds accepted by collaboration_send rather than an owning ledger operation. */
export const COLLABORATION_SEND_KINDS = [
  'task', 'inform', 'proposal', 'request_help', 'challenge', 'response', 'review',
  'handoff', 'blocked', 'completion_request', 'status',
] as const satisfies readonly PublicCollaborationMessageKind[]

/** Exact durable TeamRun phases returned by collaboration_get. */
export const TEAM_RUN_PHASES = [
  'profiling',
  'planning',
  'provisioning',
  'active',
  'completing',
  'completed',
  'formation_failed',
  'failed',
  'cancelled',
] as const satisfies readonly TeamRunPhase[]

/** Exact host-facing TeamRun statuses returned by collaboration_get. */
export const TEAM_RUN_PUBLIC_STATUSES = [
  'forming',
  'running',
  'blocked',
  'reviewing',
  'reworking',
  'completed',
  'team_formation_failed',
  'failed',
  'cancelled',
] as const satisfies readonly TeamRunPublicStatus[]

/** Exact task actions accepted by the model-facing compare-and-set command. */
export const TEAM_TASK_ACTIONS = [
  'assign', 'claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete',
] as const satisfies readonly TeamTaskAction[]

/** Product artifact kinds accepted by write tools. */
export const TEAM_ARTIFACT_KINDS = [
  'document', 'code', 'dataset', 'evidence', 'analysis', 'product_spec', 'design', 'test_report', 'final_delivery',
] as const

/** Product artifact review states. */
export const TEAM_ARTIFACT_STATUSES = ['draft', 'review', 'accepted', 'superseded'] as const

/** Lead arbitration outcomes. */
export const TEAM_DECISION_OUTCOMES = [
  'accepted', 'rejected', 'revise', 'unresolved', 'reassign', 'rework', 'replan',
] as const

const REQUIRED_STRING = { type: 'string', required: true } as const
const REQUIRED_STRING_ARRAY = {
  type: 'array',
  required: true,
  items: { type: 'string' },
} as const

/** Public structured failure result. */
export const FAILURE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
    retryable: { type: 'boolean', required: true },
    details: { type: 'object', required: true, additionalProperties: true },
  },
} as const

/** Compact expert-attempt result. */
export const MEMBER_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', required: true },
    attemptId: { type: 'string', required: true },
    attemptNumber: { type: 'integer', required: true },
    phase: { type: 'string', required: true, enum: ['provisioning', 'active', 'failed'] },
    protocolSlotId: { type: 'string' },
    failure: FAILURE_VALUE_SCHEMA,
  },
} as const

/** Safe artifact metadata result. */
export const ARTIFACT_METADATA_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: REQUIRED_STRING,
    version: { type: 'integer', required: true },
    kind: { type: 'string', required: true, enum: TEAM_ARTIFACT_KINDS },
    title: REQUIRED_STRING,
    status: { type: 'string', required: true, enum: TEAM_ARTIFACT_STATUSES },
    author: REQUIRED_STRING,
    taskIds: REQUIRED_STRING_ARRAY,
    mediaType: REQUIRED_STRING,
    updatedAt: { type: 'integer', required: true },
  },
} as const

/** Restricted complete artifact result. */
export const ARTIFACT_VALUE_SCHEMA = {
  ...ARTIFACT_METADATA_VALUE_SCHEMA,
  properties: { ...ARTIFACT_METADATA_VALUE_SCHEMA.properties, body: REQUIRED_STRING },
} as const

/** Independent Lead decision result. */
export const DECISION_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: REQUIRED_STRING,
    version: { type: 'integer', required: true },
    subject: REQUIRED_STRING,
    outcome: { type: 'string', required: true, enum: TEAM_DECISION_OUTCOMES },
    summary: REQUIRED_STRING,
    rationale: REQUIRED_STRING,
    taskIds: REQUIRED_STRING_ARRAY,
    artifactIds: REQUIRED_STRING_ARRAY,
    lead: REQUIRED_STRING,
    createdAt: { type: 'integer', required: true },
  },
} as const

/** Independent quality-gate result. */
export const QUALITY_GATE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: REQUIRED_STRING,
    version: { type: 'integer', required: true },
    name: REQUIRED_STRING,
    status: { type: 'string', required: true, enum: ['pending', 'passed', 'failed'] },
    reviewer: { type: 'string' },
    taskId: { type: 'string' },
    artifactId: { type: 'string' },
    summary: { type: 'string', required: true },
    updatedAt: { type: 'integer', required: true },
  },
} as const

/** Deterministic Lead Controller projection. */
export const CONTROLLER_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    health: { type: 'string', required: true, enum: ['healthy', 'attention', 'stalled', 'reworking', 'ready'] },
    lastProgressAt: { type: 'integer', required: true },
    stalledTaskIds: REQUIRED_STRING_ARRAY,
    duplicateWorkCount: { type: 'integer', required: true },
    qualityFailureCount: { type: 'integer', required: true },
    recommendedActions: REQUIRED_STRING_ARRAY,
    actionsTaken: REQUIRED_STRING_ARRAY,
  },
} as const

/** Authoritative collaboration protocol, route usage, and challenge state. */
export const PROTOCOL_VALUE_SCHEMA = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, enum: ['legacy', 'enforced'] },
    topology: {
      required: true,
      oneOf: [{ type: 'string', enum: ['producer_reviewer', 'centralized', 'parallel', 'hybrid', 'grouped'] }, { type: 'null' }],
    },
    limits: {
      required: true,
      oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          maxChallengeRounds: { type: 'integer', required: true },
          maxMessagesPerExpert: { type: 'integer', required: true },
        },
      }, { type: 'null' }],
    },
    members: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slotId: REQUIRED_STRING,
          memberId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          name: REQUIRED_STRING,
          phase: { required: true, oneOf: [{ type: 'string', enum: ['provisioning', 'active', 'failed'] }, { type: 'null' }] },
          permissions: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              challenge: { type: 'boolean', required: true },
              review: { type: 'boolean', required: true },
              requestHelp: { type: 'boolean', required: true },
            },
          },
          allowedTargets: REQUIRED_STRING_ARRAY,
          usedMessages: { type: 'integer', required: true },
          remainingMessages: { type: 'integer', required: true },
        },
      },
    },
    challenges: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          challengeId: REQUIRED_STRING,
          threadId: REQUIRED_STRING,
          round: { type: 'integer', required: true },
          challenger: REQUIRED_STRING,
          target: REQUIRED_STRING,
          status: { type: 'string', required: true, enum: ['open', 'responded'] },
          challengeMessageId: REQUIRED_STRING,
          responseMessageId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
} as const

/** Compact TeamRun read result. */
export const RUN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        revision: { type: 'integer', required: true },
        phase: { type: 'string', required: true, enum: TEAM_RUN_PHASES },
        status: { type: 'string', required: true, enum: TEAM_RUN_PUBLIC_STATUSES },
        objective: { type: 'string', required: true },
        complexity: { type: 'string', required: true, enum: ['simple', 'medium', 'complex'] },
        plannedExperts: { type: 'integer', required: true },
        leadSessionId: { type: 'string', required: true },
        counts: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            planned: { type: 'integer', required: true },
            provisioning: { type: 'integer', required: true },
            active: { type: 'integer', required: true },
            failed: { type: 'integer', required: true },
            attempts: { type: 'integer', required: true },
            availableSlots: { type: 'integer', required: true },
          },
        },
        members: { type: 'array', required: true, items: MEMBER_VALUE_SCHEMA },
        artifacts: { type: 'array', required: true, items: ARTIFACT_METADATA_VALUE_SCHEMA },
        decisions: { type: 'array', required: true, items: DECISION_VALUE_SCHEMA },
        qualityGates: { type: 'array', required: true, items: QUALITY_GATE_VALUE_SCHEMA },
        controller: { ...CONTROLLER_VALUE_SCHEMA, required: true },
        protocol: PROTOCOL_VALUE_SCHEMA,
        failure: FAILURE_VALUE_SCHEMA,
      },
    },
  },
} as const

/** Compact TeamRun task result. */
export const TASK_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: REQUIRED_STRING,
    revision: { type: 'integer', required: true },
    subject: REQUIRED_STRING,
    description: REQUIRED_STRING,
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    owner: { type: 'string' },
    blockedBy: REQUIRED_STRING_ARRAY,
    resourceScopes: REQUIRED_STRING_ARRAY,
    ready: { type: 'boolean', required: true },
    resourceConflicts: REQUIRED_STRING_ARRAY,
  },
} as const

/** Task-list result. */
export const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VALUE_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/** Compact receipt for one committed public collaboration message. */
export const MESSAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    eventId: { type: 'string', required: true },
    sequence: { type: 'integer', required: true },
    runId: { type: 'string', required: true },
    threadId: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: PUBLIC_MESSAGE_KINDS },
    author: { type: 'string', required: true },
    targets: { type: 'array', required: true, items: { type: 'string' } },
    references: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        taskId: { type: 'string' },
        challengeId: { type: 'string' },
        decisionId: { type: 'string' },
        artifactId: { type: 'string' },
      },
    },
    createdAt: { type: 'integer', required: true },
    visibility: { type: 'string', required: true, const: 'public' },
  },
} as const

/** Compact receipt for one explicitly parallel stage dispatch. */
export const PARALLEL_MESSAGE_BATCH_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stageId: { type: 'string', required: true },
    messages: { type: 'array', required: true, items: MESSAGE_VALUE_SCHEMA },
  },
} as const
