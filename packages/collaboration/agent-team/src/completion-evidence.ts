/** Cross-ledger evidence checks used by task completion, review, and final delivery. */

import { sameActor } from './authority.ts'
import type { TeamRunFoldState } from './fold.ts'
import type {
  PublicCollaborationMessage,
  TeamActorRef,
  TeamArtifactRecord,
  TeamMemberSnapshot,
  TeamTaskSnapshot,
} from './types.ts'

const EXPERT_DELIVERY_KINDS = new Set<PublicCollaborationMessage['kind']>([
  'handoff',
  'review',
  'response',
])

/** Whether one artifact is authored by the exact actor and covers the task. */
function actorArtifact(
  artifact: TeamArtifactRecord,
  actor: TeamActorRef,
  task: TeamTaskSnapshot,
  statuses: ReadonlySet<TeamArtifactRecord['status']>,
): boolean {
  return statuses.has(artifact.status)
    && sameActor(artifact.author, actor)
    && artifact.taskIds.includes(task.id)
}

/** Whether a public expert route returns the exact task/artifact evidence to the Lead. */
function routedToLead(
  state: TeamRunFoldState,
  actor: Extract<TeamActorRef, { readonly role: 'expert' }>,
  task: TeamTaskSnapshot,
  artifact: TeamArtifactRecord,
): boolean {
  return [...state.messages.values()].some(message =>
    EXPERT_DELIVERY_KINDS.has(message.kind)
    && sameActor(message.author, actor)
    && message.targets.length === 1
    && message.targets[0]?.role === 'lead'
    && message.references.taskId === task.id
    && message.references.artifactId === artifact.id)
}

/** Find an owner-authored artifact that is available for review but not necessarily completion. */
export function reviewableOwnerArtifact(
  state: TeamRunFoldState,
  task: TeamTaskSnapshot,
): TeamArtifactRecord | undefined {
  const owner = task.owner
  if (owner === undefined) return undefined
  const reviewable = new Set<TeamArtifactRecord['status']>(['review', 'accepted'])
  return [...state.artifacts.values()].find(artifact => actorArtifact(artifact, owner, task, reviewable))
}

/** Find accepted owner evidence, including the expert's explicit routed completion when applicable. */
export function acceptedOwnerArtifact(
  state: TeamRunFoldState,
  task: TeamTaskSnapshot,
): TeamArtifactRecord | undefined {
  const owner = task.owner
  if (owner === undefined) return undefined
  const accepted = new Set<TeamArtifactRecord['status']>(['accepted'])
  return [...state.artifacts.values()].find((artifact) => {
    if (!actorArtifact(artifact, owner, task, accepted)) return false
    return owner.role !== 'expert' || routedToLead(state, owner, task, artifact)
  })
}

/** Active experts whose own accepted artifact was never explicitly routed back to the Lead. */
export function expertsMissingAcceptedContribution(state: TeamRunFoldState): TeamMemberSnapshot[] {
  return [...state.members.values()].filter(member => member.phase === 'active' && ![...state.tasks.values()].some((task) => {
    if (task.status === 'deleted') return false
    const actor = {
      role: 'expert' as const,
      memberId: member.id,
      sessionId: member.sessionId,
      name: member.name,
    }
    return [...state.artifacts.values()].some(artifact =>
      artifact.status === 'accepted'
      && sameActor(artifact.author, actor)
      && artifact.taskIds.includes(task.id)
      && routedToLead(state, actor, task, artifact))
  }))
}

/** Completed enforced tasks that lack an expert owner and an accepted owner-authored routed artifact. */
export function tasksMissingAcceptedOwnerEvidence(state: TeamRunFoldState): TeamTaskSnapshot[] {
  return [...state.tasks.values()].filter(task => task.status !== 'deleted'
    && (task.status !== 'completed'
      || (state.protocol !== undefined && task.owner?.role !== 'expert')
      || acceptedOwnerArtifact(state, task) === undefined))
}

/** Whether a Lead completion request received a later, artifact-backed review from its sole target. */
export function hasVerifiedCompletionReview(state: TeamRunFoldState): boolean {
  const messages = [...state.messages.values()]
  return messages.some((request) => {
    const target = request.targets[0]
    const taskId = request.references.taskId
    const artifactId = request.references.artifactId
    if (request.kind !== 'completion_request'
      || request.author.role !== 'lead'
      || request.targets.length !== 1
      || target?.role !== 'expert'
      || taskId === undefined
      || artifactId === undefined) return false
    const task = state.tasks.get(taskId)
    const artifact = state.artifacts.get(artifactId)
    if (task === undefined || artifact === undefined
      || artifact.status !== 'accepted'
      || !artifact.taskIds.includes(task.id)
      || !sameActor(artifact.author, target)) return false
    return messages.some(message => message.sequence > request.sequence
      && message.kind === 'review'
      && sameActor(message.author, target)
      && message.targets.length === 1
      && message.targets[0]?.role === 'lead'
      && message.references.taskId === task.id
      && message.references.artifactId === artifact.id)
  })
}
