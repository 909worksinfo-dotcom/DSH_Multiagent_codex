/** Package-owned relational checks for required-on-read TeamRun events. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTeamRunEvent, foldTeamRun, isTeamRunEvent } from './fold.ts'
import { TeamRunId } from './ids.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-team'

/** Cordis companion plugin name. */
export const name = 'team-run-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Validate one stable candidate against its exact owning Session prefix. */
function validateCandidate(session: Session, event: SessionEvent): void {
  if (!isTeamRunEvent(event)) return
  const owner = TeamRunId(session.id)
  if (event.data.runId !== owner) {
    throw new Error(`new TeamRun event belongs to "${event.data.runId}" instead of Session "${session.id}"`)
  }
  const state = foldTeamRun(owner, session.events)
  applyTeamRunEvent(state, event)
}

/** Validate ownership and replay relations before a collaboration event enters the Session log. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    try {
      validateCandidate(session, event)
    } catch (error: unknown) {
      fail(`TeamRun candidate ${event.seq} is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the stable TeamRun invariant companion.
 * @param ctx - Cordis context with the invariant registry.
 * @returns disposer registration promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
