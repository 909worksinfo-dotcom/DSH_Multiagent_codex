/** Pure conversion from TeamRun domain projections to compact tool JSON. */

import type {
  PublicCollaborationMessage,
  TeamActorRef,
  TeamArtifactRecord,
  TeamArtifactSnapshot,
  TeamDecisionRecord,
  TeamFailure,
  TeamMemberSnapshot,
  TeamRunSnapshot,
  TeamTaskView,
  TeamQualityGateRecord,
} from '@deepseek-ai/dsh-agent-team'

/** Convert one actor reference to its stable model-facing name. */
function actorName(actor: TeamActorRef): string {
  return actor.name
}

/** Convert a structured failure without exposing Error instances. */
function failureValue(failure: TeamFailure): {
  code: string
  message: string
  retryable: boolean
  details: Record<string, string | number | boolean | null>
} {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    details: structuredClone(failure.details),
  }
}

/** Convert one immutable expert audit row. */
function memberValue(member: TeamMemberSnapshot): {
  id: string
  sessionId: string
  name: string
  role: string
  attemptId: string
  attemptNumber: number
  phase: TeamMemberSnapshot['phase']
  failure?: ReturnType<typeof failureValue>
  protocolSlotId?: string
} {
  return {
    id: member.id,
    sessionId: member.sessionId,
    name: member.name,
    role: member.role,
    attemptId: member.attemptId,
    attemptNumber: member.attemptNumber,
    phase: member.phase,
    ...member.protocolSlotId === undefined ? {} : { protocolSlotId: String(member.protocolSlotId) },
    ...member.failure === undefined ? {} : { failure: failureValue(member.failure) },
  }
}

/**
 * Convert the authoritative run to the compact model read value.
 * @param run - authoritative TeamRun snapshot.
 * @returns compact JSON record without duplicating task or timeline data.
 */
export function runValue(run: TeamRunSnapshot): {
  run: {
    id: string
    revision: number
    phase: TeamRunSnapshot['phase']
    status: TeamRunSnapshot['status']
    objective: string
    complexity: TeamRunSnapshot['complexity']
    plannedExperts: number
    leadSessionId: string
    counts: TeamRunSnapshot['expertCounts']
    members: ReturnType<typeof memberValue>[]
    artifacts: ReturnType<typeof artifactMetadataValue>[]
    decisions: ReturnType<typeof decisionValue>[]
    qualityGates: ReturnType<typeof qualityGateValue>[]
    controller: {
      health: TeamRunSnapshot['controller']['health']
      lastProgressAt: number
      stalledTaskIds: string[]
      duplicateWorkCount: number
      qualityFailureCount: number
      recommendedActions: string[]
      actionsTaken: string[]
    }
    protocol: {
      mode: TeamRunSnapshot['protocol']['mode']
      topology: TeamRunSnapshot['protocol']['topology']
      limits: TeamRunSnapshot['protocol']['limits']
      members: Array<{
        slotId: string
        memberId: string | null
        name: string
        phase: import('@deepseek-ai/dsh-agent-team').TeamMemberPhase | null
        permissions: import('@deepseek-ai/dsh-agent-team').TeamProtocolPermissions
        allowedTargets: string[]
        usedMessages: number
        remainingMessages: number
      }>
      challenges: Array<{
        challengeId: string
        threadId: string
        round: number
        challenger: string
        target: string
        status: 'open' | 'responded'
        challengeMessageId: string
        responseMessageId: string | null
      }>
    }
    failure?: ReturnType<typeof failureValue>
  }
} {
  return {
    run: {
      id: run.id,
      revision: run.revision,
      phase: run.phase,
      status: run.status,
      objective: run.objective,
      complexity: run.complexity,
      plannedExperts: run.plannedExperts,
      leadSessionId: run.lead.sessionId,
      counts: structuredClone(run.expertCounts),
      members: run.members.map(memberValue),
      artifacts: run.artifacts.map(artifactMetadataValue),
      decisions: run.decisions.map(decisionValue),
      qualityGates: run.qualityGates.map(qualityGateValue),
      controller: {
        ...structuredClone(run.controller),
        stalledTaskIds: run.controller.stalledTaskIds.map(String),
        recommendedActions: [...run.controller.recommendedActions],
        actionsTaken: run.controller.actionsTaken.map(String),
      },
      protocol: {
        mode: run.protocol.mode,
        topology: run.protocol.topology,
        limits: structuredClone(run.protocol.limits),
        members: run.protocol.members.map(member => ({
          ...structuredClone(member),
          slotId: String(member.slotId),
          memberId: member.memberId === null ? null : String(member.memberId),
          allowedTargets: [...member.allowedTargets],
        })),
        challenges: run.protocol.challenges.map(challenge => ({
          ...structuredClone(challenge),
          challengeId: String(challenge.challengeId),
          threadId: String(challenge.threadId),
          challengeMessageId: String(challenge.challengeMessageId),
          responseMessageId: challenge.responseMessageId === null ? null : String(challenge.responseMessageId),
        })),
      },
      ...run.failure === undefined ? {} : { failure: failureValue(run.failure) },
    },
  }
}

/**
 * Convert safe artifact metadata without its body.
 * @param artifact - authoritative metadata.
 * @returns compact body-free artifact value.
 */
export function artifactMetadataValue(artifact: TeamArtifactSnapshot): {
  id: string
  version: number
  kind: TeamArtifactSnapshot['kind']
  title: string
  status: TeamArtifactSnapshot['status']
  author: string
  taskIds: string[]
  mediaType: string
  updatedAt: number
} {
  return {
    id: String(artifact.id),
    version: artifact.version,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status,
    author: actorName(artifact.author),
    taskIds: artifact.taskIds.map(String),
    mediaType: artifact.mediaType,
    updatedAt: artifact.updatedAt,
  }
}

/**
 * Convert one restricted full artifact read.
 * @param artifact - authorized complete artifact.
 * @returns compact artifact including its body.
 */
export function artifactValue(artifact: TeamArtifactRecord): ReturnType<typeof artifactMetadataValue> & { body: string } {
  return { ...artifactMetadataValue(artifact), body: artifact.body }
}

/**
 * Convert one independent decision ledger row.
 * @param decision - authoritative Lead decision.
 * @returns compact decision value.
 */
export function decisionValue(decision: TeamDecisionRecord): {
  id: string
  version: number
  subject: string
  outcome: TeamDecisionRecord['outcome']
  summary: string
  rationale: string
  taskIds: string[]
  artifactIds: string[]
  lead: string
  createdAt: number
} {
  return {
    id: String(decision.id),
    version: decision.version,
    subject: decision.subject,
    outcome: decision.outcome,
    summary: decision.summary,
    rationale: decision.rationale,
    taskIds: decision.taskIds.map(String),
    artifactIds: decision.artifactIds.map(String),
    lead: actorName(decision.lead),
    createdAt: decision.createdAt,
  }
}

/**
 * Convert one independent quality-gate ledger row.
 * @param gate - authoritative quality-gate record.
 * @returns compact quality-gate value.
 */
export function qualityGateValue(gate: TeamQualityGateRecord): {
  id: string
  version: number
  name: string
  status: TeamQualityGateRecord['status']
  reviewer?: string
  taskId?: string
  artifactId?: string
  summary: string
  updatedAt: number
} {
  return {
    id: String(gate.id),
    version: gate.version,
    name: gate.name,
    status: gate.status,
    ...gate.reviewer === undefined ? {} : { reviewer: actorName(gate.reviewer) },
    ...gate.taskId === undefined ? {} : { taskId: String(gate.taskId) },
    ...gate.artifactId === undefined ? {} : { artifactId: String(gate.artifactId) },
    summary: gate.summary,
    updatedAt: gate.updatedAt,
  }
}

/**
 * Convert one current task view to compact JSON.
 * @param task - authoritative task projection.
 * @returns compact task value.
 */
export function taskValue(task: TeamTaskView): {
  id: string
  revision: number
  subject: string
  description: string
  status: TeamTaskView['status']
  owner?: string
  blockedBy: string[]
  resourceScopes: string[]
  ready: boolean
  resourceConflicts: string[]
} {
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...task.owner === undefined ? {} : { owner: actorName(task.owner) },
    blockedBy: [...task.blockedBy],
    resourceScopes: [...task.resourceScopes],
    ready: task.ready,
    resourceConflicts: [...task.resourceConflicts],
  }
}

/**
 * Convert one committed public message to compact JSON.
 * @param message - authoritative public collaboration record.
 * @returns compact public message value.
 */
export function messageValue(message: PublicCollaborationMessage): {
  id: string
  eventId: string
  sequence: number
  runId: string
  threadId: string
  kind: PublicCollaborationMessage['kind']
  author: string
  targets: string[]
  references: {
    taskId?: string
    challengeId?: string
    decisionId?: string
    artifactId?: string
  }
  createdAt: number
  visibility: 'public'
} {
  return {
    id: message.id,
    eventId: message.eventId,
    sequence: message.sequence,
    runId: message.runId,
    threadId: message.threadId,
    kind: message.kind,
    author: actorName(message.author),
    targets: message.targets.map(actorName),
    references: structuredClone(message.references),
    createdAt: message.createdAt,
    visibility: 'public',
  }
}
