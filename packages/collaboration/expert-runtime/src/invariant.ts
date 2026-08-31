/** Package-owned relational checks for durable expert capability bindings. */

import type { Context } from '@deepseek-ai/cordis'
import { TeamRunId, foldTeamRun } from '@deepseek-ai/dsh-agent-team'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { findExpertBinding, foldExpertBindings, sameExpertDescriptor } from './fold.ts'
import { parseExpertBinding, parseExpertChildDescriptor } from './schema.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-expert-runtime'

/** Cordis companion plugin name. */
export const name = 'expert-runtime-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Validate a new Lead-side binding against the already-committed P1 roster row. */
function validateBinding(session: Session, event: SessionEvent): void {
  const binding = parseExpertBinding(event.data)
  const owner = TeamRunId(session.id)
  if (binding.runId !== owner) throw new Error(`expert binding belongs to "${binding.runId}" instead of Lead "${session.id}"`)
  const state = foldTeamRun(owner, session.events)
  const member = state.members.get(binding.memberId)
  if (member === undefined
    || member.sessionId !== binding.sessionId
    || member.attemptId !== binding.attemptId
    || member.name !== binding.name
    || member.role !== binding.role
    || (member.phase !== 'provisioning' && member.phase !== 'active')) {
    throw new Error(`expert binding attempt "${binding.attemptId}" does not match a provisioned P1 roster row`)
  }
  foldExpertBindings(owner, [...session.events, event])
}

/** Validate a new child descriptor against its exact parent Session and Lead binding. */
function validateChild(ctx: Context, session: Session, event: SessionEvent): void {
  const descriptor = parseExpertChildDescriptor(event.data)
  if (descriptor.sessionId !== session.id) {
    throw new Error(`expert descriptor belongs to child "${descriptor.sessionId}" instead of Session "${session.id}"`)
  }
  const parentId = session.header.parentSession
  if (parentId === undefined || String(parentId) !== String(descriptor.runId)) {
    throw new Error(`expert descriptor parent does not match TeamRun "${descriptor.runId}"`)
  }
  const parent = ctx.sessions.get(SessionId(descriptor.runId))
  if (parent === undefined) throw new Error(`expert descriptor Lead Session "${descriptor.runId}" is unavailable`)
  const binding = findExpertBinding(descriptor.runId, parent.events, descriptor.attemptId)
  if (binding === undefined || !sameExpertDescriptor(binding, descriptor)) {
    throw new Error(`expert descriptor attempt "${descriptor.attemptId}" does not match its Lead binding`)
  }
  if (session.events.slice(session.header.seedLength ?? 0).some(candidate => candidate.type === event.type)) {
    throw new Error(`expert child "${session.id}" already has a descriptor`)
  }
}

/** Validate ownership and P1/parent relations before an expert event enters a Session log. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    try {
      if (event.type === 'collaboration/expert/binding') validateBinding(session, event)
      if (event.type === 'collaboration/expert/descriptor') validateChild(ctx, session, event)
    } catch (error: unknown) {
      fail(`expert runtime candidate ${event.seq} is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the expert-runtime invariant companion.
 * @param ctx - Cordis context with Session and invariant registries.
 * @returns disposer registration promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
