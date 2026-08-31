/** Collaboration request and response schemas with strict browser-safe projections. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const domainSchema = z.enum(['research_analysis', 'product_solution', 'software_development'])
const complexitySchema = z.enum(['simple', 'medium', 'complex'])
const topologySchema = z.enum(['producer_reviewer', 'centralized', 'parallel', 'hybrid', 'grouped'])
const phaseSchema = z.enum([
  'profiling', 'planning', 'provisioning', 'active', 'completing', 'completed',
  'formation_failed', 'failed', 'cancelled',
])
const statusSchema = z.enum([
  'forming', 'running', 'blocked', 'reviewing', 'reworking', 'completed',
  'team_formation_failed', 'failed', 'cancelled',
])
const levelSchema = z.enum(['low', 'medium', 'high'])
const nonBlank = z.string().trim().min(1)
const cursorSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const publicKindSchema = z.enum([
  'task', 'inform', 'proposal', 'request_help', 'challenge', 'response', 'review',
  'decision', 'handoff', 'blocked', 'completion_request', 'artifact', 'status', 'final_delivery',
])

const failureSchema = z.object({
  code: nonBlank,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})

const workstreamSchema = z.object({
  id: nonBlank,
  subject: nonBlank,
  description: nonBlank,
  blockedBy: z.array(nonBlank),
  requiredCapabilities: z.array(nonBlank),
  resourceScopes: z.array(nonBlank),
  assigneeSlotId: nonBlank.optional(),
})

const profileSchema = z.object({
  domain: domainSchema,
  objective: nonBlank,
  successCriteria: z.array(nonBlank),
  workstreams: z.array(workstreamSchema),
  riskSignals: z.array(nonBlank),
  complexity: complexitySchema,
  plannedExperts: z.number().int().min(1).max(8),
  metrics: z.object({
    workstreamCount: z.number().int().nonnegative(),
    dependencyCount: z.number().int().nonnegative(),
    independentWorkstreams: z.number().int().nonnegative(),
    longestDependencyPath: z.number().int().nonnegative(),
    capabilityCount: z.number().int().nonnegative(),
    riskSignalCount: z.number().int().nonnegative(),
    decomposable: z.boolean(),
    toolDensity: levelSchema,
    risk: levelSchema,
  }),
})

const capabilitySchema = z.object({ id: nonBlank, label: nonBlank })
const bindingSchema = z.object({
  blueprint: z.object({ id: nonBlank, revision: z.number().int().positive() }),
  preset: capabilitySchema,
  skills: z.array(capabilitySchema),
  marketplaceProviders: z.array(z.object({
    source: z.enum(['smithery', 'composio', 'skills_sh']),
    state: z.enum(['ready', 'authorization_required', 'unavailable']),
  })).optional(),
  marketplaceSkills: z.array(z.object({
    id: nonBlank,
    label: nonBlank,
    source: z.enum(['smithery', 'composio', 'skills_sh']),
    kind: z.enum(['remote_tool', 'method_skill']),
    status: z.enum(['loaded', 'connected', 'authorization_required']),
    access: z.enum(['public', 'platform', 'user']).optional(),
  })).optional(),
  plugins: z.array(capabilitySchema),
  foundation: z.object({
    model: z.object({
      mode: z.enum(['inherit_lead', 'selected']),
      provider: nonBlank.optional(),
      model: nonBlank.optional(),
      reasoningEffort: nonBlank.optional(),
      maxTokens: z.number().int().positive(),
    }).strict(),
    tools: z.object({
      access: z.enum(['full_preset', 'restricted']),
      allow: z.array(nonBlank),
      deny: z.array(nonBlank),
    }).strict(),
    permissions: z.object({
      sandboxMode: z.enum(['inherit_lead', 'read-only', 'workspace-write', 'danger-full-access']),
      approvalPolicy: z.enum(['inherit_lead', 'ask', 'never']),
    }).strict(),
  }).strict().optional(),
})

const charterSchema = z.object({
  objective: nonBlank,
  successCriteria: z.array(nonBlank),
  topology: topologySchema,
  taskDag: z.array(workstreamSchema),
  communication: z.object({
    maxChallengeRounds: z.number().int().positive(),
    maxMessagesPerExpert: z.number().int().positive(),
  }),
  qualityChecks: z.array(nonBlank),
  budgets: z.array(z.object({
    slotId: nonBlank,
    maxTurns: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  })),
  termination: z.object({
    success: z.literal('all_tasks_completed_and_reviewed'),
    formationFailure: z.literal('fail_closed'),
  }),
})

const leadActorSchema = z.object({
  role: z.literal('lead'),
  sessionId: nonBlank,
  name: z.literal('lead'),
}).strict()
const expertActorSchema = z.object({
  role: z.literal('expert'),
  memberId: nonBlank,
  sessionId: nonBlank,
  name: nonBlank,
}).strict()
const actorSchema = z.discriminatedUnion('role', [leadActorSchema, expertActorSchema])
const referencesSchema = z.object({
  taskId: nonBlank.optional(),
  challengeId: nonBlank.optional(),
  decisionId: nonBlank.optional(),
  artifactId: nonBlank.optional(),
}).strict()
const taskSchema = z.object({
  id: nonBlank,
  revision: z.number().int().positive(),
  subject: nonBlank,
  description: nonBlank,
  status: z.enum(['pending', 'in_progress', 'completed']),
  owner: actorSchema.nullable(),
  blockedBy: z.array(nonBlank),
  resourceScopes: z.array(nonBlank),
  ready: z.boolean(),
  resourceConflicts: z.array(nonBlank),
})
const artifactMetadataSchema = z.object({
  id: nonBlank,
  version: z.number().int().positive(),
  kind: z.enum(['document', 'code', 'dataset', 'evidence', 'analysis', 'product_spec', 'design', 'test_report', 'final_delivery']),
  title: nonBlank,
  status: z.enum(['draft', 'review', 'accepted', 'superseded']),
  author: actorSchema,
  taskIds: z.array(nonBlank),
  mediaType: nonBlank,
  updatedAt: z.number().nonnegative(),
}).strict()
const artifactRecordSchema = artifactMetadataSchema.extend({ body: nonBlank }).strict()
const decisionSchema = z.object({
  id: nonBlank,
  version: z.number().int().positive(),
  subject: nonBlank,
  outcome: z.enum(['accepted', 'rejected', 'revise', 'unresolved', 'reassign', 'rework', 'replan']),
  summary: nonBlank,
  rationale: nonBlank,
  taskIds: z.array(nonBlank),
  artifactIds: z.array(nonBlank),
  lead: actorSchema,
  createdAt: z.number().nonnegative(),
}).strict()
const qualityGateSchema = z.object({
  id: nonBlank,
  version: z.number().int().positive(),
  name: nonBlank,
  status: z.enum(['pending', 'passed', 'failed']),
  reviewer: actorSchema.optional(),
  taskId: nonBlank.optional(),
  artifactId: nonBlank.optional(),
  summary: z.string(),
  updatedAt: z.number().nonnegative(),
}).strict()
const controllerSchema = z.object({
  health: z.enum(['healthy', 'attention', 'stalled', 'reworking', 'ready']),
  lastProgressAt: z.number().nonnegative(),
  stalledTaskIds: z.array(nonBlank),
  duplicateWorkCount: z.number().int().nonnegative(),
  qualityFailureCount: z.number().int().nonnegative(),
  recommendedActions: z.array(z.enum([
    'reassign', 'rework', 'replan', 'replace_expert', 'resolve_quality_failure',
  ])),
  actionsTaken: z.array(nonBlank),
}).strict()
const protocolMemberSchema = z.object({
  slotId: nonBlank,
  memberId: nonBlank.nullable(),
  name: nonBlank,
  phase: z.enum(['provisioning', 'active', 'failed']).nullable(),
  permissions: z.object({
    challenge: z.boolean(),
    review: z.boolean(),
    requestHelp: z.boolean(),
  }).strict(),
  allowedTargets: z.array(nonBlank),
  usedMessages: z.number().int().nonnegative(),
  remainingMessages: z.number().int().nonnegative(),
}).strict()
const protocolChallengeSchema = z.object({
  challengeId: nonBlank,
  threadId: nonBlank,
  round: z.number().int().positive(),
  challenger: nonBlank,
  target: nonBlank,
  status: z.enum(['open', 'responded']),
  challengeMessageId: nonBlank,
  responseMessageId: nonBlank.nullable(),
}).strict()
const protocolSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('legacy'),
    topology: z.null(),
    limits: z.null(),
    members: z.array(z.never()).length(0),
    challenges: z.array(z.never()).length(0),
  }).strict(),
  z.object({
    mode: z.literal('enforced'),
    topology: topologySchema,
    limits: z.object({
      maxChallengeRounds: z.number().int().positive(),
      maxMessagesPerExpert: z.number().int().positive(),
    }).strict(),
    members: z.array(protocolMemberSchema).min(1).max(8),
    challenges: z.array(protocolChallengeSchema),
  }).strict(),
])
const publicEventSchema = z.object({
  id: nonBlank,
  eventId: nonBlank,
  cursor: cursorSchema,
  threadId: nonBlank,
  kind: publicKindSchema,
  author: actorSchema,
  targets: z.array(actorSchema),
  references: referencesSchema,
  content: nonBlank,
  createdAt: z.number().nonnegative(),
  visibility: z.literal('public'),
})

/** Complete collaboration.run value schema shared by every collaboration response. */
export const collaborationRunValueSchema = z.object({
  id: nonBlank,
  requestId: nonBlank,
  retryOf: nonBlank.optional(),
  title: nonBlank,
  objective: nonBlank,
  language: z.enum(['zh', 'en']),
  createdAt: z.number().nonnegative(),
  status: statusSchema,
  phase: phaseSchema,
  cursor: cursorSchema,
  profile: profileSchema,
  charter: charterSchema.nullable(),
  lead: z.object({
    sessionId: nonBlank,
    name: z.literal('lead'),
    role: z.literal('Lead Agent'),
    modelSelection: z.object({
      provider: nonBlank,
      model: nonBlank,
      reasoningEffort: nonBlank.optional(),
    }).strict().optional(),
  }).strict(),
  experts: z.array(z.object({
    id: nonBlank,
    sessionId: nonBlank.nullable(),
    name: nonBlank,
    role: nonBlank,
    phase: z.enum(['planned', 'provisioning', 'active', 'failed']),
    binding: bindingSchema,
    failure: failureSchema.optional(),
  })).max(8),
  expertCounts: z.object({
    planned: z.number().int().min(1).max(8),
    provisioning: z.number().int().min(0).max(8),
    active: z.number().int().min(0).max(8),
    failed: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    availableSlots: z.number().int().min(0).max(8),
  }),
  tasks: z.array(taskSchema),
  artifacts: z.array(artifactMetadataSchema),
  decisions: z.array(decisionSchema),
  qualityGates: z.array(qualityGateSchema),
  controller: controllerSchema,
  protocol: protocolSchema,
  progress: z.object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    qualityGatePending: z.number().int().nonnegative(),
    qualityGatePassed: z.number().int().nonnegative(),
    qualityGateFailed: z.number().int().nonnegative(),
  }),
  failure: failureSchema.optional(),
}) as unknown as z.ZodType<Wire<ResponseValue<'collaboration.get'>>>

const workstreamInputSchema = z.object({
  id: nonBlank,
  subject: nonBlank,
  description: nonBlank,
  blockedBy: z.array(nonBlank).optional(),
  requiredCapabilities: z.array(nonBlank).optional(),
  resourceScopes: z.array(nonBlank).optional(),
})

/** collaboration.create request payload. */
export const collaborationCreateRequestSchema = z.object({
  leadSessionId: nonBlank,
  requestId: nonBlank,
  retryOf: nonBlank.optional(),
  title: nonBlank,
  objective: nonBlank,
  language: z.enum(['zh', 'en']),
  domain: domainSchema.optional(),
  successCriteria: z.array(nonBlank).optional(),
  workstreams: z.array(workstreamInputSchema).optional(),
  riskSignals: z.array(nonBlank).optional(),
  leadModel: z.object({
    provider: nonBlank,
    model: nonBlank,
    reasoningEffort: nonBlank.optional(),
  }).strict().optional(),
  expertModels: z.array(z.object({
    slotId: nonBlank,
    selection: z.object({
      provider: nonBlank,
      model: nonBlank,
      reasoningEffort: nonBlank.optional(),
    }).strict(),
  }).strict()).max(8).optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'collaboration.create'>>>

/** collaboration.create response value. */
export const collaborationCreateValueSchema: z.ZodType<Wire<ResponseValue<'collaboration.create'>>> =
  collaborationRunValueSchema

/** collaboration.confirm request payload. */
export const collaborationConfirmRequestSchema = z.object({
  runId: nonBlank,
  requestId: nonBlank,
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.confirm'>>>

/** collaboration.confirm response value. */
export const collaborationConfirmValueSchema: z.ZodType<Wire<ResponseValue<'collaboration.confirm'>>> =
  collaborationRunValueSchema

/** collaboration.list request payload. */
export const collaborationListRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.list'>>>

/** collaboration.list response value. */
export const collaborationListValueSchema = z.object({
  runs: z.array(collaborationRunValueSchema),
}) as unknown as z.ZodType<Wire<ResponseValue<'collaboration.list'>>>

/** collaboration.get request payload. */
export const collaborationGetRequestSchema = z.object({ runId: nonBlank }) as unknown as z.ZodType<Wire<RequestPayload<'collaboration.get'>>>

/** collaboration.get response value. */
export const collaborationGetValueSchema: z.ZodType<Wire<ResponseValue<'collaboration.get'>>> =
  collaborationRunValueSchema

/** collaboration.readArtifact request payload; unknown/private fields are rejected. */
export const collaborationReadArtifactRequestSchema = z.object({
  runId: nonBlank,
  artifactId: nonBlank,
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.readArtifact'>>>

/** collaboration.readArtifact restricted complete value schema. */
export const collaborationReadArtifactValueSchema = artifactRecordSchema as unknown as
z.ZodType<Wire<ResponseValue<'collaboration.readArtifact'>>>

/** collaboration.events request payload. */
export const collaborationEventsRequestSchema = z.object({
  runId: nonBlank,
  afterCursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.events'>>>

/** collaboration.events response value. */
export const collaborationEventsValueSchema = z.object({
  events: z.array(publicEventSchema),
  hasMore: z.boolean(),
  nextCursor: cursorSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'collaboration.events'>>>

/** collaboration.send request payload; unknown/private fields are rejected. */
export const collaborationSendRequestSchema = z.object({
  runId: nonBlank,
  kind: publicKindSchema,
  threadId: nonBlank,
  targets: z.array(nonBlank).optional(),
  references: referencesSchema.optional(),
  content: nonBlank,
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.send'>>>

/** collaboration.send response value. */
export const collaborationSendValueSchema = publicEventSchema as unknown as
z.ZodType<Wire<ResponseValue<'collaboration.send'>>>

/** collaboration.complete request payload. */
export const collaborationCompleteRequestSchema = z.object({
  runId: nonBlank,
  threadId: nonBlank,
  references: referencesSchema.optional(),
  content: nonBlank,
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'collaboration.complete'>>>

/** collaboration.complete response value. */
export const collaborationCompleteValueSchema: z.ZodType<Wire<ResponseValue<'collaboration.complete'>>> =
  collaborationRunValueSchema

/** collaboration.retryFormation request payload. */
export const collaborationRetryFormationRequestSchema = z.object({
  runId: nonBlank,
  requestId: nonBlank,
}) as unknown as z.ZodType<Wire<RequestPayload<'collaboration.retryFormation'>>>

/** collaboration.retryFormation response value. */
export const collaborationRetryFormationValueSchema:
z.ZodType<Wire<ResponseValue<'collaboration.retryFormation'>>> = collaborationRunValueSchema

/** collaboration.cancel request payload. */
export const collaborationCancelRequestSchema = z.object({
  runId: nonBlank,
  requestId: nonBlank,
  reason: nonBlank,
}) as unknown as z.ZodType<Wire<RequestPayload<'collaboration.cancel'>>>

/** collaboration.cancel response value. */
export const collaborationCancelValueSchema: z.ZodType<Wire<ResponseValue<'collaboration.cancel'>>> =
  collaborationRunValueSchema
