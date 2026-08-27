/** Actor resolution against one authoritative TeamRun replay state. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamRunError } from './error.ts'
import type { TeamRunFoldState } from './fold.ts'
import type { TeamActorRef, TeamMembership } from './types.ts'

/**
 * Return the authoritative Lead actor.
 * @param state - created TeamRun replay state.
 * @returns stable Lead actor reference.
 */
export function leadActor(state: TeamRunFoldState): Extract<TeamActorRef, { readonly role: 'lead' }> {
  const leadId = state.created?.leadId
  if (leadId === undefined) throw new TeamRunError(`TeamRun "${state.id}" not found`, 'TEAM_NOT_FOUND')
  return { role: 'lead', sessionId: leadId, name: 'lead' }
}

/**
 * Resolve one active actor by model-facing name.
 * @param state - current TeamRun replay state.
 * @param rawName - `lead` or an active expert name.
 * @returns authoritative actor reference.
 */
export function resolveActorByName(state: TeamRunFoldState, rawName: string): TeamActorRef {
  const name = rawName.trim()
  if (name === 'lead') return leadActor(state)
  const memberId = state.memberIdsByName.get(name)
  const member = memberId === undefined ? undefined : state.members.get(memberId)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamRunError(`active expert "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  return { role: 'expert', memberId: member.id, sessionId: member.sessionId, name: member.name }
}

/**
 * Resolve one live Session identity as a TeamRun actor.
 * @param state - current TeamRun replay state.
 * @param sessionId - exact live Agent Session identity.
 * @returns membership for the Lead or an active expert.
 */
export function resolveMembership(state: TeamRunFoldState, sessionId: SessionId): TeamMembership {
  const lead = leadActor(state)
  if (sessionId === lead.sessionId) return { runId: state.id, actor: lead }
  const memberId = state.memberIdsBySession.get(sessionId)
  const member = memberId === undefined ? undefined : state.members.get(memberId)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamRunError(`agent "${sessionId}" is not an active TeamRun member`, 'TEAM_NOT_MEMBER')
  }
  return {
    runId: state.id,
    actor: { role: 'expert', memberId: member.id, sessionId: member.sessionId, name: member.name },
  }
}

/**
 * Test stable actor identity without comparing detached record references.
 * @param left - first actor.
 * @param right - second actor.
 * @returns whether both records identify the same Lead or expert.
 */
export function sameActor(left: TeamActorRef, right: TeamActorRef): boolean {
  return left.role === right.role
    && (left.role === 'lead'
      ? left.sessionId === right.sessionId
      : right.role === 'expert' && left.memberId === right.memberId)
}
