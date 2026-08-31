/** Strict folds for immutable Lead bindings and child descriptors. */

import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { parseExpertBinding, parseExpertChildDescriptor } from './schema.ts'
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from './types.ts'

type ProvisionAttemptIdType = ExpertBindingEventData['attemptId']
type TeamRunIdType = ExpertBindingEventData['runId']

/**
 * Whether two records carry the same immutable identity and capability digest.
 * @param left - first Lead binding or child descriptor.
 * @param right - second Lead binding or child descriptor.
 * @returns whether every durable identity and descriptor field is equal.
 */
export function sameExpertDescriptor(
  left: ExpertBindingEventData | ExpertChildDescriptorEventData,
  right: ExpertBindingEventData | ExpertChildDescriptorEventData,
): boolean {
  return left.runId === right.runId
    && left.memberId === right.memberId
    && left.sessionId === right.sessionId
    && left.attemptId === right.attemptId
    && left.descriptor.digest === right.descriptor.digest
    && left.descriptor.blueprint.id === right.descriptor.blueprint.id
    && left.descriptor.blueprint.revision === right.descriptor.blueprint.revision
    && JSON.stringify(left.descriptor) === JSON.stringify(right.descriptor)
}

/**
 * Fold every exact TeamRun binding while rejecting identity reuse.
 * @param runId - owning TeamRun.
 * @param events - Lead Session events.
 * @returns immutable bindings in append order.
 */
export function foldExpertBindings(runId: TeamRunIdType, events: readonly SessionEvent[]): ExpertBindingEventData[] {
  const found: ExpertBindingEventData[] = []
  const attempts = new Set<ProvisionAttemptIdType>()
  const sessions = new Set<SessionId>()
  for (const event of events) {
    if (event.type !== 'collaboration/expert/binding') continue
    const value = parseExpertBinding(event.data)
    if (value.runId !== runId) continue
    if (attempts.has(value.attemptId) || sessions.has(value.sessionId)) {
      throw new Error(`persisted expert binding reuses attempt "${value.attemptId}" or session "${value.sessionId}"`)
    }
    attempts.add(value.attemptId)
    sessions.add(value.sessionId)
    found.push(value)
  }
  return found
}

/**
 * Resolve one exact Lead binding.
 * @param runId - owning TeamRun.
 * @param events - Lead Session events.
 * @param attemptId - immutable attempt selector.
 * @returns the exact binding, or undefined.
 */
export function findExpertBinding(
  runId: TeamRunIdType,
  events: readonly SessionEvent[],
  attemptId: ProvisionAttemptIdType,
): ExpertBindingEventData | undefined {
  return foldExpertBindings(runId, events).find(value => value.attemptId === attemptId)
}

/**
 * Fold one child Session's own immutable expert descriptor.
 * @param session - child Session or inspection result carrying seed length.
 * @returns the own descriptor, or undefined for a non-expert child.
 */
export function foldExpertChildDescriptor(
  session: Pick<Session, 'events' | 'header'>,
): ExpertChildDescriptorEventData | undefined {
  const own = session.events.slice(session.header.seedLength ?? 0)
  let found: ExpertChildDescriptorEventData | undefined
  for (const event of own) {
    if (event.type !== 'collaboration/expert/descriptor') continue
    const value = parseExpertChildDescriptor(event.data)
    if (found !== undefined) throw new Error('persisted expert child has more than one descriptor')
    found = value
  }
  return found
}

/**
 * Count expert turns owned by this child after its descriptor, excluding inherited fork turns.
 * @param session - child Session carrying the durable seed boundary.
 * @returns number of own admitted turn-start records after the expert descriptor.
 */
export function countExpertTurns(session: Pick<Session, 'events' | 'header'>): number {
  const own = session.events.slice(session.header.seedLength ?? 0)
  const descriptorIndex = own.findIndex(event => event.type === 'collaboration/expert/descriptor')
  if (descriptorIndex < 0) return 0
  return own.slice(descriptorIndex + 1).filter(event => event.type === 'turn/start').length
}

/**
 * Whether the retained initial expert prompt already entered this child's durable own log.
 * @param session - child Session or inspection result carrying the seed boundary.
 * @param prompt - exact retained initial prompt.
 * @returns whether one own user message contains exactly that prompt.
 */
export function hasExpertInitialPrompt(
  session: Pick<Session, 'events' | 'header'>,
  prompt: string,
): boolean {
  return session.events.slice(session.header.seedLength ?? 0).some(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && event.data.content.length === 1
    && event.data.content[0]?.type === 'text'
    && event.data.content[0].text === prompt)
}
