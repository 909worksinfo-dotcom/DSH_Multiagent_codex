/** Strict event replay and projection for the stable TeamRun domain. */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  expertsMissingAcceptedContribution,
  hasVerifiedCompletionReview,
  tasksMissingAcceptedOwnerEvidence,
} from './completion-evidence.ts'
import { expertName, requiredText, resourceScope, resourceScopesOverlap } from './validation.ts'
import { TeamRunId } from './ids.ts'
import { validatePlannedExperts, validatePolicy } from './policy.ts'
import {
  parseCurrentTeamRunEvent,
  parseTeamRunEventSelector,
} from './schema.ts'
import type { TeamRunEventType } from './schema.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import type {
  CollaborationEventId,
  CollaborationMessageId,
  PublicCollaborationMessage,
  TeamActorRef,
  TeamArtifactId,
  TeamArtifactRecord,
  TeamControllerSnapshot,
  TeamDecisionId,
  TeamDecisionRecord,
  TeamFailure,
  TeamMemberSnapshot,
  TeamRunCreatedEventData,
  TeamProtocolRecord,
  TeamProtocolSnapshot,
  TeamRunId as TeamRunIdType,
  TeamRunPhase,
  TeamRunPublicStatus,
  TeamRunSnapshot,
  TeamTaskId,
  TeamTaskSnapshot,
  TeamTaskView,
  TeamQualityGateId,
  TeamQualityGateRecord,
} from './types.ts'

/** Mutable replay state derived exclusively from one Lead Session log. */
export interface TeamRunFoldState {
  readonly id: TeamRunIdType
  created?: TeamRunCreatedEventData
  phase?: TeamRunPhase
  failure?: TeamFailure
  revision: number
  cursor: number
  readonly members: Map<import('./types.ts').TeamMemberId, TeamMemberSnapshot>
  readonly memberIdsByName: Map<string, import('./types.ts').TeamMemberId>
  readonly memberIdsByAttempt: Map<import('./types.ts').ProvisionAttemptId, import('./types.ts').TeamMemberId>
  readonly memberIdsBySession: Map<SessionId, import('./types.ts').TeamMemberId>
  readonly tasks: Map<TeamTaskId, TeamTaskSnapshot>
  readonly messages: Map<CollaborationMessageId, PublicCollaborationMessage>
  protocol?: TeamProtocolRecord
  readonly artifacts: Map<TeamArtifactId, TeamArtifactRecord>
  readonly decisions: Map<TeamDecisionId, TeamDecisionRecord>
  readonly qualityGates: Map<TeamQualityGateId, TeamQualityGateRecord>
  readonly taskActivityCursors: Map<TeamTaskId, number>
  readonly taskActivityTimes: Map<TeamTaskId, number>
  readonly eventSignatures: Map<CollaborationEventId, string>
  nextTaskNumber: number
  lastProgressAt: number
  nextQualityGateNumber: number
}

/** Collaboration event with its key and payload correlated by SessionEventMap. */
export type TeamRunSessionEvent = SessionEvent<TeamRunEventType>

/**
 * Construct an empty fold for one explicit TeamRun identity.
 * @param id - run whose records may be applied.
 * @returns mutable empty replay state.
 */
export function emptyTeamRunFoldState(id: TeamRunIdType): TeamRunFoldState {
  return {
    id,
    revision: 0,
    cursor: -1,
    members: new Map(),
    memberIdsByName: new Map(),
    memberIdsByAttempt: new Map(),
    memberIdsBySession: new Map(),
    tasks: new Map(),
    messages: new Map(),
    artifacts: new Map(),
    decisions: new Map(),
    qualityGates: new Map(),
    taskActivityCursors: new Map(),
    taskActivityTimes: new Map(),
    eventSignatures: new Map(),
    nextTaskNumber: 1,
    lastProgressAt: 0,
    nextQualityGateNumber: 1,
  }
}

/**
 * Test whether one Session event belongs to the stable TeamRun domain.
 * @param event - candidate Session event.
 * @returns whether the event has a `collaboration/*` TeamRun key.
 */
export function isTeamRunEvent(event: SessionEvent): event is TeamRunSessionEvent {
  return event.type === 'collaboration/run/created'
    || event.type === 'collaboration/run/phase'
    || event.type === 'collaboration/member'
    || event.type === 'collaboration/task'
    || event.type === 'collaboration/message'
    || event.type === 'collaboration/protocol'
    || event.type === 'collaboration/artifact'
    || event.type === 'collaboration/decision'
    || event.type === 'collaboration/quality-gate'
}

/** Return exact expert-only counts from retained attempt rows. */
function expertCounts(state: TeamRunFoldState): { provisioning: number; active: number; failed: number } {
  let provisioning = 0
  let active = 0
  let failed = 0
  for (const member of state.members.values()) {
    switch (member.phase) {
      case 'provisioning': provisioning += 1; break
      case 'active': active += 1; break
      case 'failed': failed += 1; break
    }
  }
  return { provisioning, active, failed }
}

/** Require creation and return the immutable run header. */
function requireCreated(state: TeamRunFoldState): TeamRunCreatedEventData {
  if (state.created === undefined || state.phase === undefined) {
    throw new Error(`TeamRun "${state.id}" has no creation event`)
  }
  return state.created
}

/** Require a contiguous semantic run revision. */
function assertRevision(state: TeamRunFoldState, revision: number): void {
  if (revision !== state.revision + 1) {
    throw new Error(`TeamRun "${state.id}" revision ${revision} is not contiguous after ${state.revision}`)
  }
}

/** Whether a phase rejects every later mutation. */
function isTerminal(phase: TeamRunPhase): boolean {
  return phase === 'completed' || phase === 'formation_failed' || phase === 'failed' || phase === 'cancelled'
}

/** Resolve and validate one stored actor against the authoritative roster. */
function assertActor(state: TeamRunFoldState, actor: TeamActorRef): void {
  const created = requireCreated(state)
  if (actor.role === 'lead') {
    if (actor.sessionId !== created.leadId) {
      throw new Error('public actor does not match the authoritative TeamRun Lead')
    }
    return
  }
  const member = state.members.get(actor.memberId)
  if (member === undefined || member.phase !== 'active'
    || member.sessionId !== actor.sessionId || member.name !== actor.name) {
    throw new Error(`public actor "${actor.name}" is not an active TeamRun expert`)
  }
}

/** Enforce immutable attempt identity and capacity transitions. */
function applyMember(state: TeamRunFoldState, member: TeamMemberSnapshot): void {
  const created = requireCreated(state)
  const prior = state.members.get(member.id)
  if (prior === undefined) {
    if (state.phase !== 'provisioning' && state.phase !== 'active') {
      throw new Error(`expert attempt cannot begin while TeamRun is ${state.phase}`)
    }
    if (member.phase !== 'provisioning') throw new Error(`expert "${member.name}" must begin provisioning`)
    if (member.failure !== undefined) throw new Error('a provisioning expert cannot carry a failure')
    expertName(member.name)
    if (requiredText(member.role, 'expert role', 200) !== member.role) {
      throw new Error(`expert "${member.name}" has an invalid role`)
    }
    if (member.sessionId === created.leadId) throw new Error('the TeamRun Lead cannot occupy an expert slot')
    if (state.memberIdsByName.has(member.name)) throw new Error(`expert name "${member.name}" was reused`)
    if (state.memberIdsByAttempt.has(member.attemptId)) throw new Error(`attempt id "${member.attemptId}" was reused`)
    if (state.memberIdsBySession.has(member.sessionId)) throw new Error(`expert Session "${member.sessionId}" was reused`)
    if (member.attemptNumber !== state.members.size + 1) throw new Error('expert attempt numbers must be contiguous')
    if (member.attemptNumber > created.policy.maxProvisionAttempts) {
      throw new Error(`TeamRun provisioning attempt limit ${created.policy.maxProvisionAttempts} exceeded`)
    }
    if (state.protocol !== undefined) {
      const slotId = member.protocolSlotId
      const rule = slotId === undefined ? undefined : state.protocol.experts.find(candidate => candidate.slotId === slotId)
      if (rule === undefined) throw new Error(`expert "${member.name}" has no collaboration protocol slot`)
      const priorSlotAttempts = [...state.members.values()].filter(candidate => candidate.protocolSlotId === slotId)
      if (priorSlotAttempts.length === 0 && member.id !== rule.initialMemberId) {
        throw new Error(`initial expert for protocol slot "${slotId}" has the wrong member id`)
      }
      if (priorSlotAttempts.some(candidate => candidate.phase !== 'failed')) {
        throw new Error(`protocol slot "${slotId}" is already occupied`)
      }
    } else if (member.protocolSlotId !== undefined) {
      throw new Error('legacy TeamRun member cannot claim a protocol slot')
    }
    const counts = expertCounts(state)
    if (counts.active + counts.provisioning >= created.policy.maxActiveExperts
      || counts.active + counts.provisioning >= created.plannedExperts) {
      throw new Error('TeamRun active plus provisioning expert capacity exceeded')
    }
    state.memberIdsByName.set(member.name, member.id)
    state.memberIdsByAttempt.set(member.attemptId, member.id)
    state.memberIdsBySession.set(member.sessionId, member.id)
    state.members.set(member.id, member)
    return
  }

  if (prior.name !== member.name || prior.role !== member.role || prior.sessionId !== member.sessionId
    || prior.attemptId !== member.attemptId || prior.attemptNumber !== member.attemptNumber
    || prior.protocolSlotId !== member.protocolSlotId) {
    throw new Error(`expert "${member.id}" changed immutable attempt fields`)
  }
  const providerSettlement = (state.phase === 'provisioning' || state.phase === 'active')
    && prior.phase === 'provisioning'
    && member.phase !== 'provisioning'
  const runtimeFailure = (state.phase === 'provisioning' || state.phase === 'active' || state.phase === 'completing')
    && prior.phase === 'active'
    && member.phase === 'failed'
  if (!providerSettlement && !runtimeFailure) {
    throw new Error(`expert "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
  }
  if (member.phase === 'failed' && member.failure === undefined) {
    throw new Error(`failed expert "${member.name}" requires a structured failure`)
  }
  if (member.phase === 'active' && member.failure !== undefined) {
    throw new Error(`active expert "${member.name}" cannot carry a failure`)
  }
  state.members.set(member.id, member)
}

/** Enforce the exact internal lifecycle and no-solo activation rule. */
function applyPhase(state: TeamRunFoldState, phase: Exclude<TeamRunPhase, 'profiling'>, failure?: TeamFailure): void {
  const created = requireCreated(state)
  const current = state.phase
  if (current === undefined || isTerminal(current)) throw new Error(`TeamRun cannot transition from ${String(current)}`)
  const counts = expertCounts(state)
  const exactTeamReady = counts.active === created.plannedExperts && counts.provisioning === 0
  let allowed = false
  switch (phase) {
    case 'planning': allowed = current === 'profiling'; break
    case 'provisioning': allowed = current === 'planning'; break
    case 'active': allowed = current === 'provisioning' && exactTeamReady; break
    case 'completing': allowed = current === 'active' && exactTeamReady; break
    case 'completed': allowed = current === 'completing' && exactTeamReady; break
    case 'formation_failed':
      allowed = (current === 'profiling' || current === 'planning' || current === 'provisioning')
        && counts.active < created.plannedExperts
      break
    case 'failed': allowed = current === 'active' || current === 'completing'; break
    case 'cancelled': allowed = true; break
  }
  if (!allowed) {
    throw new Error(
      `invalid TeamRun ${current} -> ${phase} transition with ${counts.active}/${created.plannedExperts} active experts and ${counts.provisioning} provisioning`,
    )
  }
  const requiresFailure = phase === 'formation_failed' || phase === 'failed' || phase === 'cancelled'
  if (requiresFailure !== (failure !== undefined)) {
    throw new Error(`${phase} ${requiresFailure ? 'requires' : 'cannot carry'} a structured failure`)
  }
  if (phase === 'formation_failed' && failure?.code !== 'FORMATION_FAILED') {
    throw new Error('formation_failed requires the FORMATION_FAILED code')
  }
  if (phase === 'cancelled' && failure?.code !== 'TEAM_CANCELLED') {
    throw new Error('cancelled requires the TEAM_CANCELLED code')
  }
  state.phase = phase
  if (failure === undefined) delete state.failure
  else state.failure = failure
}

/** Enforce task revision, ownership, scope, and complete-DAG relations. */
function applyTask(state: TeamRunFoldState, task: TeamTaskSnapshot): void {
  requireCreated(state)
  if (state.phase === undefined || state.phase === 'profiling' || isTerminal(state.phase)) {
    throw new Error(`TeamRun task cannot change while run is ${String(state.phase)}`)
  }
  const prior = state.tasks.get(task.id)
  if (requiredText(task.subject, 'task subject', 200) !== task.subject
    || requiredText(task.description, 'task description', 16_384) !== task.description) {
    throw new Error(`team task "${task.id}" text is not normalized`)
  }
  if ((prior === undefined && task.revision !== 1)
    || (prior !== undefined && task.revision !== prior.revision + 1)) {
    throw new Error(`team task "${task.id}" revision is not contiguous`)
  }
  if ((task.status === 'in_progress' || task.status === 'completed') && task.owner === undefined) {
    throw new Error(`${task.status} task "${task.id}" requires an owner`)
  }
  if (task.owner !== undefined) assertActor(state, task.owner)
  const normalizedScopes = task.resourceScopes.map(resourceScope)
  if (new Set(normalizedScopes).size !== normalizedScopes.length
    || normalizedScopes.some((scope, index) => scope !== task.resourceScopes[index])) {
    throw new Error(`team task "${task.id}" has invalid or duplicate resource scopes`)
  }
  assertTaskGraphCandidate(state.tasks, task)
  const numeric = /^task-(\d+)$/u.exec(task.id)
  if (numeric !== null) {
    const number = Number(numeric[1])
    if (!Number.isSafeInteger(number)) throw new Error(`team task "${task.id}" has an unsafe numeric suffix`)
    state.nextTaskNumber = Math.max(state.nextTaskNumber, number === Number.MAX_SAFE_INTEGER ? number : number + 1)
  }
  state.tasks.set(task.id, task)
}

/** Enforce public-only collaboration records and active-roster authorship. */
function applyMessage(
  state: TeamRunFoldState,
  event: TeamRunSessionEvent & { readonly type: 'collaboration/message' },
  data: import('./types.ts').TeamRunMessageEventData,
): void {
  const created = requireCreated(state)
  if (state.phase === undefined || isTerminal(state.phase)) {
    throw new Error(`public collaboration message cannot be added while run is ${String(state.phase)}`)
  }
  if (data.message.kind !== 'status' && state.phase !== 'active' && state.phase !== 'completing') {
    throw new Error(`${data.message.kind} messages require an active TeamRun`)
  }
  if (state.messages.size >= created.policy.maxPublicMessages) throw new Error('TeamRun public message limit exceeded')
  if (state.messages.has(data.message.id)) throw new Error(`public message "${data.message.id}" was reused`)
  if (Buffer.byteLength(data.message.content, 'utf8') > created.policy.maxPublicMessageBytes) {
    throw new Error('TeamRun public message byte limit exceeded')
  }
  if (requiredText(data.message.content, 'public message content', Number.MAX_SAFE_INTEGER) !== data.message.content) {
    throw new Error('TeamRun public message content is not normalized')
  }
  const referencedTaskId = data.message.references.taskId
  if (referencedTaskId !== undefined) {
    const referencedTask = state.tasks.get(referencedTaskId)
    if (referencedTask === undefined || referencedTask.status === 'deleted') {
      throw new Error(`public message references missing or deleted task "${referencedTaskId}"`)
    }
  }
  assertActor(state, data.message.author)
  const targetKeys = new Set<string>()
  for (const target of data.message.targets) {
    assertActor(state, target)
    const key = target.role === 'lead' ? `lead:${target.sessionId}` : `expert:${target.memberId}`
    if (targetKeys.has(key)) throw new Error('public message repeats one target')
    targetKeys.add(key)
  }
  assertProtocolMessage(state, data.message)
  if (data.message.kind === 'final_delivery'
    && (data.message.author.role !== 'lead' || state.phase !== 'completing')) {
    throw new Error('final_delivery requires the Lead during completing')
  }
  state.messages.set(data.message.id, {
    ...data.message,
    eventId: data.eventId,
    sequence: event.seq,
    runId: state.id,
    createdAt: event.time,
  })
}

function actorKey(actor: TeamActorRef): string {
  return actor.role === 'lead' ? `lead:${actor.sessionId}` : `expert:${actor.memberId}`
}

function memberForSlot(state: TeamRunFoldState, slotId: import('./types.ts').TeamProtocolSlotId): TeamMemberSnapshot | undefined {
  return [...state.members.values()].filter(member => member.protocolSlotId === slotId).at(-1)
}

function protocolRuleForActor(state: TeamRunFoldState, actor: TeamActorRef) {
  if (actor.role === 'lead' || state.protocol === undefined) return undefined
  const member = state.members.get(actor.memberId)
  return state.protocol.experts.find(rule => rule.slotId === member?.protocolSlotId)
}

function assertProtocolMessage(state: TeamRunFoldState, message: import('./types.ts').StoredPublicCollaborationMessage): void {
  const protocol = state.protocol
  if (protocol === undefined) return
  const rule = protocolRuleForActor(state, message.author)
  if (message.author.role === 'expert') {
    const authorMemberId = message.author.memberId
    if (rule === undefined) throw new Error('expert author is not bound to the collaboration protocol')
    const used = [...state.messages.values()].filter(candidate =>
      candidate.author.role === 'expert' && candidate.author.memberId === authorMemberId).length
    if (used >= protocol.maxMessagesPerExpert) throw new Error('expert public message budget exceeded')
    if ((message.kind === 'challenge' && !rule.permissions.challenge)
      || (message.kind === 'review' && !rule.permissions.review)
      || (message.kind === 'request_help' && !rule.permissions.requestHelp)) {
      throw new Error(`expert protocol permission denies ${message.kind}`)
    }
    if (message.kind === 'decision' || message.kind === 'final_delivery') {
      throw new Error(`${message.kind} is owned by the TeamRun Lead ledger`)
    }
    const allowed = new Set<string>([`lead:${requireCreated(state).leadId}`])
    for (const slotId of rule.allowedTargetSlotIds) {
      const target = memberForSlot(state, slotId)
      if (target?.phase === 'active') allowed.add(`expert:${target.id}`)
    }
    const addressed = message.targets.length > 0
      ? message.targets
      : [
        { role: 'lead', sessionId: requireCreated(state).leadId, name: 'lead' } as const,
        ...[...state.members.values()].filter(member => member.phase === 'active' && member.id !== authorMemberId)
          .map(member => ({ role: 'expert' as const, memberId: member.id, sessionId: member.sessionId, name: member.name })),
      ]
    if (addressed.some(target => !allowed.has(actorKey(target)))) throw new Error('expert target is denied by topology')
  }
  const challengeId = message.references.challengeId
  if (message.kind !== 'challenge' && message.kind !== 'response') {
    if (challengeId !== undefined) throw new Error(`${message.kind} cannot carry a challenge id`)
    return
  }
  const [messageTarget] = message.targets
  if (challengeId === undefined || message.targets.length !== 1 || messageTarget === undefined) {
    throw new Error(`${message.kind} requires one challenge id and one explicit target`)
  }
  const priorChallenge = [...state.messages.values()].find(candidate =>
    candidate.kind === 'challenge' && candidate.references.challengeId === challengeId)
  if (message.kind === 'challenge') {
    const priorInThread = [...state.messages.values()].filter(candidate =>
      candidate.kind === 'challenge' && candidate.threadId === message.threadId).at(-1)
    if (priorInThread !== undefined && ![...state.messages.values()].some(candidate =>
      candidate.kind === 'response' && candidate.references.challengeId === priorInThread.references.challengeId)) {
      throw new Error('the prior challenge round is still open')
    }
    if (priorChallenge !== undefined || actorKey(message.author) === actorKey(messageTarget)) {
      throw new Error('challenge id was reused or targets its author')
    }
    const round = [...state.messages.values()].filter(candidate =>
      candidate.kind === 'challenge' && candidate.threadId === message.threadId).length + 1
    if (round > protocol.maxChallengeRounds) throw new Error('challenge round limit exceeded')
    return
  }
  if (priorChallenge === undefined || priorChallenge.threadId !== message.threadId) {
    throw new Error('response references no challenge in its thread')
  }
  const priorResponse = [...state.messages.values()].some(candidate =>
    candidate.kind === 'response' && candidate.references.challengeId === challengeId)
  const [challengeTarget] = priorChallenge.targets
  if (priorResponse
    || challengeTarget === undefined
    || actorKey(message.author) !== actorKey(challengeTarget)
    || actorKey(messageTarget) !== actorKey(priorChallenge.author)) {
    throw new Error('response participants do not match the open challenge')
  }
}

function applyProtocol(state: TeamRunFoldState, protocol: TeamProtocolRecord): void {
  const created = requireCreated(state)
  if (state.protocol !== undefined) throw new Error('TeamRun collaboration protocol was materialized twice')
  if (state.phase !== 'planning' && state.phase !== 'provisioning') {
    throw new Error(`collaboration protocol cannot materialize while run is ${String(state.phase)}`)
  }
  if (!Number.isSafeInteger(protocol.maxChallengeRounds) || protocol.maxChallengeRounds < 1
    || !Number.isSafeInteger(protocol.maxMessagesPerExpert) || protocol.maxMessagesPerExpert < 1
    || protocol.experts.length !== created.plannedExperts) {
    throw new Error('collaboration protocol limits or expert count are invalid')
  }
  const slots = new Set(protocol.experts.map(rule => rule.slotId))
  const memberIds = new Set(protocol.experts.map(rule => rule.initialMemberId))
  const names = new Set(protocol.experts.map(rule => rule.name))
  if (slots.size !== protocol.experts.length || memberIds.size !== protocol.experts.length || names.size !== protocol.experts.length) {
    throw new Error('collaboration protocol expert identities must be unique')
  }
  for (const rule of protocol.experts) {
    if (new Set(rule.allowedTargetSlotIds).size !== rule.allowedTargetSlotIds.length
      || rule.allowedTargetSlotIds.includes(rule.slotId)
      || rule.allowedTargetSlotIds.some(slotId => !slots.has(slotId))) {
      throw new Error(`collaboration protocol routes for "${rule.slotId}" are invalid`)
    }
  }
  state.protocol = structuredClone(protocol)
}

/** Apply one complete artifact version after limits, references, and CAS validation. */
function applyArtifact(
  state: TeamRunFoldState,
  event: TeamRunSessionEvent & { readonly type: 'collaboration/artifact' },
  data: import('./types.ts').TeamRunArtifactEventData,
): void {
  const created = requireCreated(state)
  if (state.phase !== 'active' && state.phase !== 'completing') {
    throw new Error(`artifact cannot be written while run is ${String(state.phase)}`)
  }
  const artifact = data.artifact
  const prior = state.artifacts.get(artifact.id)
  if (prior === undefined && state.artifacts.size >= created.policy.maxArtifacts) {
    throw new Error('TeamRun artifact limit exceeded')
  }
  if (artifact.version !== (prior?.version ?? 0) + 1) throw new Error(`artifact "${artifact.id}" version is not contiguous`)
  if (prior !== undefined && JSON.stringify(prior.author) !== JSON.stringify(artifact.author)) {
    throw new Error(`artifact "${artifact.id}" author cannot change`)
  }
  assertActor(state, artifact.author)
  if (requiredText(artifact.title, 'artifact title', 200) !== artifact.title) throw new Error('artifact title is not normalized')
  if (requiredText(artifact.mediaType, 'artifact media type', 200) !== artifact.mediaType) {
    throw new Error('artifact media type is not normalized')
  }
  if (requiredText(artifact.body, 'artifact body', Number.MAX_SAFE_INTEGER) !== artifact.body) {
    throw new Error('artifact body is not normalized')
  }
  if (Buffer.byteLength(artifact.body, 'utf8') > created.policy.maxArtifactBodyBytes) {
    throw new Error('TeamRun artifact body byte limit exceeded')
  }
  if (new Set(artifact.taskIds).size !== artifact.taskIds.length) throw new Error('artifact repeats one task')
  for (const taskId of artifact.taskIds) {
    const task = state.tasks.get(taskId)
    if (task === undefined || task.status === 'deleted') throw new Error(`artifact references missing task "${taskId}"`)
  }
  state.artifacts.set(artifact.id, { ...structuredClone(artifact), updatedAt: event.time })
}

/** Apply one independent Lead arbitration row. */
function applyDecision(
  state: TeamRunFoldState,
  event: TeamRunSessionEvent & { readonly type: 'collaboration/decision' },
  data: import('./types.ts').TeamRunDecisionEventData,
): void {
  if (state.phase !== 'active' && state.phase !== 'completing') {
    throw new Error(`decision cannot be written while run is ${String(state.phase)}`)
  }
  const decision = data.decision
  const prior = state.decisions.get(decision.id)
  if (decision.version !== (prior?.version ?? 0) + 1) throw new Error(`decision "${decision.id}" version is not contiguous`)
  if (decision.lead.sessionId !== requireCreated(state).leadId) throw new Error('decision arbitrator is not the TeamRun Lead')
  for (const taskId of decision.taskIds) {
    const task = state.tasks.get(taskId)
    if (task === undefined || task.status === 'deleted') throw new Error(`decision references missing task "${taskId}"`)
  }
  for (const artifactId of decision.artifactIds) {
    if (!state.artifacts.has(artifactId)) throw new Error(`decision references missing artifact "${artifactId}"`)
  }
  if (requiredText(decision.subject, 'decision subject', 200) !== decision.subject
    || requiredText(decision.summary, 'decision summary', 4_096) !== decision.summary
    || requiredText(decision.rationale, 'decision rationale', 4_096) !== decision.rationale) {
    throw new Error('decision text is not normalized')
  }
  state.decisions.set(decision.id, {
    ...structuredClone(decision),
    createdAt: prior?.createdAt ?? event.time,
  })
}

/** Apply one materialized gate or formal Lead review result. */
function applyQualityGate(
  state: TeamRunFoldState,
  event: TeamRunSessionEvent & { readonly type: 'collaboration/quality-gate' },
  data: import('./types.ts').TeamRunQualityGateEventData,
): void {
  const gate = data.gate
  const prior = state.qualityGates.get(gate.id)
  if (gate.version !== (prior?.version ?? 0) + 1) throw new Error(`quality gate "${gate.id}" version is not contiguous`)
  if (prior === undefined) {
    if (gate.status !== 'pending' || gate.reviewer !== undefined || gate.summary !== '') {
      throw new Error('a quality gate must materialize as pending without a reviewer')
    }
    if (state.phase !== 'planning' && state.phase !== 'provisioning') {
      throw new Error(`quality gate cannot materialize while run is ${String(state.phase)}`)
    }
    const match = /^quality-gate-(\d+)$/u.exec(gate.id)
    if (match === null || Number(match[1]) !== state.nextQualityGateNumber) {
      throw new Error(`quality gate "${gate.id}" is not the next generated identity`)
    }
    state.nextQualityGateNumber += 1
  } else {
    if (state.phase !== 'active' && state.phase !== 'completing') {
      throw new Error(`quality result cannot be written while run is ${String(state.phase)}`)
    }
    if (gate.name !== prior.name || gate.status === 'pending' || gate.reviewer?.role !== 'lead') {
      throw new Error('formal quality result requires the Lead and immutable gate name')
    }
  }
  if (gate.taskId !== undefined) {
    const task = state.tasks.get(gate.taskId)
    if (task === undefined || task.status === 'deleted') throw new Error(`quality gate references missing task "${gate.taskId}"`)
  }
  if (gate.artifactId !== undefined && !state.artifacts.has(gate.artifactId)) {
    throw new Error(`quality gate references missing artifact "${gate.artifactId}"`)
  }
  if (requiredText(gate.name, 'quality gate name', 200) !== gate.name) throw new Error('quality gate name is not normalized')
  if (gate.summary.length > 4_096 || gate.summary.trim() !== gate.summary) throw new Error('quality gate summary is not normalized')
  state.qualityGates.set(gate.id, { ...structuredClone(gate), updatedAt: event.time })
}

/** Record progress only for explicit typed task relations. */
function markTaskActivity(
  state: TeamRunFoldState,
  taskIds: readonly TeamTaskId[],
  event: TeamRunSessionEvent,
): void {
  for (const taskId of taskIds) {
    state.taskActivityCursors.set(taskId, event.seq)
    state.taskActivityTimes.set(taskId, event.time)
  }
}

/**
 * Apply one collaboration event with strict validation and idempotent event ids.
 * @param state - mutable fold selected by one TeamRun id.
 * @param event - next contiguous Session event.
 */
export function applyTeamRunEvent(state: TeamRunFoldState, event: SessionEvent): void {
  if (!isTeamRunEvent(event)) return
  const selector = parseTeamRunEventSelector(event.type, event.data)
  if (selector.version !== 1) {
    if (selector.runId !== state.id) return
    throw new Error(`unsupported TeamRun event version ${selector.version}`)
  }
  const data = parseCurrentTeamRunEvent(event.type, event.data)
  if (data.runId !== state.id) return
  state.cursor = event.seq
  const signature = `${event.type}:${JSON.stringify(data)}`
  const priorSignature = state.eventSignatures.get(data.eventId)
  if (priorSignature !== undefined) {
    if (priorSignature !== signature) throw new Error(`collaboration event id "${data.eventId}" was reused`)
    return
  }

  if (event.type === 'collaboration/run/created') {
    const created = parseCurrentTeamRunEvent(event.type, event.data)
    if (state.created !== undefined) throw new Error(`TeamRun "${state.id}" was created twice`)
    if (created.runId !== TeamRunId(created.leadId)) throw new Error('TeamRun id must equal its authoritative Lead Session id')
    validatePolicy(created.policy)
    validatePlannedExperts(created.complexity, created.plannedExperts, created.policy.maxActiveExperts)
    if (requiredText(created.objective, 'objective', 16_384) !== created.objective) {
      throw new Error('TeamRun objective is not normalized')
    }
    state.created = created
    state.phase = 'profiling'
  } else {
    assertRevision(state, data.revision)
    switch (event.type) {
      case 'collaboration/run/phase': {
        const phase = parseCurrentTeamRunEvent(event.type, event.data)
        applyPhase(state, phase.phase, phase.failure)
        break
      }
      case 'collaboration/member':
        applyMember(state, parseCurrentTeamRunEvent(event.type, event.data).member)
        break
      case 'collaboration/task':
        applyTask(state, parseCurrentTeamRunEvent(event.type, event.data).task)
        break
      case 'collaboration/message':
        applyMessage(state, event, parseCurrentTeamRunEvent(event.type, event.data))
        break
      case 'collaboration/protocol':
        applyProtocol(state, parseCurrentTeamRunEvent(event.type, event.data).protocol)
        break
      case 'collaboration/artifact':
        applyArtifact(state, event, parseCurrentTeamRunEvent(event.type, event.data))
        break
      case 'collaboration/decision':
        applyDecision(state, event, parseCurrentTeamRunEvent(event.type, event.data))
        break
      case 'collaboration/quality-gate':
        applyQualityGate(state, event, parseCurrentTeamRunEvent(event.type, event.data))
        break
    }
  }
  if (event.type !== 'collaboration/message') state.lastProgressAt = event.time
  switch (event.type) {
    case 'collaboration/task':
      markTaskActivity(state, [parseCurrentTeamRunEvent(event.type, event.data).task.id], event)
      break
    case 'collaboration/message': {
      const taskId = parseCurrentTeamRunEvent(event.type, event.data).message.references.taskId
      if (taskId !== undefined) {
        markTaskActivity(state, [taskId], event)
        state.lastProgressAt = event.time
      }
      break
    }
    case 'collaboration/artifact':
      markTaskActivity(state, parseCurrentTeamRunEvent(event.type, event.data).artifact.taskIds, event)
      break
    case 'collaboration/decision':
      markTaskActivity(state, parseCurrentTeamRunEvent(event.type, event.data).decision.taskIds, event)
      break
    case 'collaboration/quality-gate': {
      const taskId = parseCurrentTeamRunEvent(event.type, event.data).gate.taskId
      if (taskId !== undefined) markTaskActivity(state, [taskId], event)
      break
    }
    case 'collaboration/run/created':
    case 'collaboration/run/phase':
    case 'collaboration/member':
    case 'collaboration/protocol':
      break
  }
  state.revision = data.revision
  state.eventSignatures.set(data.eventId, signature)
}

/**
 * Replay a complete Lead Session log into one TeamRun state.
 * @param id - TeamRun identity selecting applicable events.
 * @param events - complete contiguous Session log, including any inherited prefix.
 * @returns mutable replay state at the end of the log.
 */
export function foldTeamRun(id: TeamRunIdType, events: readonly SessionEvent[]): TeamRunFoldState {
  const state = emptyTeamRunFoldState(id)
  for (const event of events) applyTeamRunEvent(state, event)
  return state
}

/** Map lifecycle and deterministic controller state onto the frozen Host status set. */
function publicStatus(
  phase: TeamRunPhase,
  exactTeamReady: boolean,
  controller: TeamControllerSnapshot,
): TeamRunPublicStatus {
  switch (phase) {
    case 'profiling':
    case 'planning':
    case 'provisioning': return 'forming'
    case 'active':
      if (!exactTeamReady) return 'blocked'
      if (controller.health === 'reworking') return 'reworking'
      if (controller.stalledTaskIds.length > 0 || controller.qualityFailureCount > 0) return 'blocked'
      if (controller.health === 'ready') return 'reviewing'
      return 'running'
    case 'completing': return 'reviewing'
    case 'completed': return 'completed'
    case 'formation_failed': return 'team_formation_failed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

/** Derive controller health from only replayed cursor/time data and snapshotted policy. */
function controllerSnapshot(state: TeamRunFoldState): TeamControllerSnapshot {
  const created = requireCreated(state)
  const counts = expertCounts(state)
  const current = [...state.tasks.values()].filter(task => task.status !== 'deleted')
  const stalledTaskIds = current
    .filter(task => (task.status === 'in_progress'
      || (task.status === 'pending'
        && task.blockedBy.every(blockerId => state.tasks.get(blockerId)?.status === 'completed')))
      && state.cursor - (state.taskActivityCursors.get(task.id) ?? state.cursor) >= created.policy.taskStallCursorThreshold)
    .map(task => task.id)
  let duplicateWorkCount = 0
  for (const [index, task] of current.entries()) {
    const normalized = task.subject.trim().toLocaleLowerCase()
    for (const other of current.slice(index + 1)) {
      if (other.subject.trim().toLocaleLowerCase() === normalized) duplicateWorkCount += 1
    }
  }
  const failed = [...state.qualityGates.values()].filter(gate => gate.status === 'failed').length
  const missingActiveExperts = state.phase === 'active' && counts.active < created.plannedExperts
  const unfilledExpertSlots = missingActiveExperts && counts.active + counts.provisioning < created.plannedExperts
  const recommended = new Set<import('./types.ts').TeamControllerRecommendedAction>()
  if (stalledTaskIds.length > 0) recommended.add('reassign')
  if (duplicateWorkCount > 0) recommended.add('replan')
  if (unfilledExpertSlots) recommended.add('replace_expert')
  if (failed > 0) {
    recommended.add('resolve_quality_failure')
    recommended.add('rework')
  }
  const actionsTaken = [...state.decisions.values()]
    .filter(decision => decision.outcome === 'reassign' || decision.outcome === 'rework' || decision.outcome === 'replan')
    .map(decision => decision.id)
  const lastAction = [...state.decisions.values()].at(-1)?.outcome
  const acceptedCoverage = current.every(task => [...state.decisions.values()].some(decision =>
    decision.outcome === 'accepted'
    && decision.taskIds.includes(task.id)
    && decision.artifactIds.some((artifactId) => {
      const artifact = state.artifacts.get(artifactId)
      return artifact?.status === 'accepted' && artifact.taskIds.includes(task.id)
    })))
  const collaborationEvidenceReady = state.protocol === undefined
    ? current.every(task => task.status === 'completed')
      && [...state.messages.values()].some(message => message.kind === 'completion_request')
      && [...state.messages.values()].some(message => message.kind === 'review')
    : tasksMissingAcceptedOwnerEvidence(state).length === 0
      && expertsMissingAcceptedContribution(state).length === 0
      && hasVerifiedCompletionReview(state)
  const ready = current.length > 0
    && collaborationEvidenceReady
    && current.every(task => [...state.artifacts.values()].some(artifact =>
      artifact.status === 'accepted' && artifact.taskIds.includes(task.id)))
    && state.qualityGates.size > 0
    && [...state.qualityGates.values()].every(gate => gate.status === 'passed')
    && acceptedCoverage
  return {
    health: ready
      ? 'ready'
      : missingActiveExperts
        ? 'attention'
        : lastAction === 'rework'
          ? 'reworking'
          : stalledTaskIds.length > 0
            ? 'stalled'
            : failed > 0 || duplicateWorkCount > 0
              ? 'attention'
              : 'healthy',
    lastProgressAt: state.lastProgressAt,
    stalledTaskIds,
    duplicateWorkCount,
    qualityFailureCount: failed,
    recommendedActions: [...recommended],
    actionsTaken,
  }
}

/**
 * Build a detached task projection with readiness and advisory resource conflicts.
 * @param state - current replay state containing dependencies and peer tasks.
 * @param task - task snapshot to project, including a deleted tombstone when requested directly.
 * @returns detached task view.
 */
export function projectTeamTask(state: TeamRunFoldState, task: TeamTaskSnapshot): TeamTaskView {
  const conflicts = new Set<TeamTaskId>()
  for (const other of state.tasks.values()) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.resourceScopes.some(left => other.resourceScopes.some(right => resourceScopesOverlap(left, right)))) {
      conflicts.add(other.id)
    }
  }
  return {
    ...structuredClone(task),
    ready: task.status === 'pending'
      && task.blockedBy.every(blockerId => state.tasks.get(blockerId)?.status === 'completed'),
    resourceConflicts: [...conflicts],
  }
}

/**
 * Project one created fold into the authoritative public TeamRun snapshot.
 * @param state - replayed TeamRun state.
 * @returns detached snapshot with the Lead excluded from expert counts and rows.
 */
export function snapshotTeamRun(state: TeamRunFoldState): TeamRunSnapshot {
  const created = requireCreated(state)
  const phase = state.phase
  if (phase === undefined) throw new Error(`TeamRun "${state.id}" has no lifecycle`)
  const counts = expertCounts(state)
  const exactTeamReady = counts.active === created.plannedExperts && counts.provisioning === 0
  const controller = controllerSnapshot(state)
  return {
    id: state.id,
    revision: state.revision,
    cursor: state.cursor,
    lead: { role: 'lead', sessionId: created.leadId, name: 'lead' },
    objective: created.objective,
    complexity: created.complexity,
    plannedExperts: created.plannedExperts,
    policy: structuredClone(created.policy),
    phase,
    status: publicStatus(phase, exactTeamReady, controller),
    members: structuredClone([...state.members.values()]),
    tasks: [...state.tasks.values()]
      .filter(task => task.status !== 'deleted')
      .map(task => projectTeamTask(state, task)),
    messages: structuredClone([...state.messages.values()]),
    protocol: protocolSnapshot(state),
    artifacts: [...state.artifacts.values()].map(({ body: _body, ...metadata }) => structuredClone(metadata)),
    decisions: structuredClone([...state.decisions.values()]),
    qualityGates: structuredClone([...state.qualityGates.values()]),
    controller,
    expertCounts: {
      planned: created.plannedExperts,
      ...counts,
      attempts: state.members.size,
      availableSlots: created.plannedExperts - counts.active - counts.provisioning,
    },
    ...state.failure === undefined ? {} : { failure: structuredClone(state.failure) },
  }
}

function protocolSnapshot(state: TeamRunFoldState): TeamProtocolSnapshot {
  const protocol = state.protocol
  if (protocol === undefined) {
    return { mode: 'legacy', topology: null, limits: null, members: [], challenges: [] }
  }
  const messages = [...state.messages.values()]
  const members = protocol.experts.map((rule) => {
    const member = memberForSlot(state, rule.slotId)
    const usedMessages = member === undefined ? 0 : messages.filter(message =>
      message.author.role === 'expert' && message.author.memberId === member.id).length
    const allowedTargets = ['lead', ...rule.allowedTargetSlotIds.flatMap((slotId) => {
      const target = memberForSlot(state, slotId)
      return target?.phase === 'active' ? [target.name] : []
    })]
    return {
      slotId: rule.slotId,
      memberId: member?.id ?? null,
      name: member?.name ?? rule.name,
      phase: member?.phase ?? null,
      permissions: structuredClone(rule.permissions),
      allowedTargets,
      usedMessages,
      remainingMessages: Math.max(0, protocol.maxMessagesPerExpert - usedMessages),
    }
  })
  const challenges = messages.filter(message => message.kind === 'challenge').map((challenge) => {
    const challengeId = challenge.references.challengeId
    if (challengeId === undefined) throw new Error('persisted challenge has no challenge id')
    const [target] = challenge.targets
    if (target === undefined) throw new Error('persisted challenge has no target')
    const response = messages.find(message => message.kind === 'response'
      && message.references.challengeId === challengeId)
    const round = messages.filter(message => message.kind === 'challenge'
      && message.threadId === challenge.threadId && message.sequence <= challenge.sequence).length
    return {
      challengeId,
      threadId: challenge.threadId,
      round,
      challenger: challenge.author.name,
      target: target.name,
      status: response === undefined ? 'open' as const : 'responded' as const,
      challengeMessageId: challenge.id,
      responseMessageId: response?.id ?? null,
    }
  })
  return {
    mode: 'enforced',
    topology: protocol.topology,
    limits: {
      maxChallengeRounds: protocol.maxChallengeRounds,
      maxMessagesPerExpert: protocol.maxMessagesPerExpert,
    },
    members,
    challenges,
  }
}
