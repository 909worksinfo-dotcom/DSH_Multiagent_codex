/** Package-owned relational checks for durable P3 orchestration records. */

import type { Context } from '@deepseek-ai/cordis'
import { foldTeamRun, TeamRunId } from '@deepseek-ai/dsh-agent-team'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyTeamOrchestrationEvent,
  foldTeamOrchestration,
  isTeamOrchestrationEvent,
} from './fold.ts'
import { parseTeamProfileEvent } from './schema.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-team-orchestrator'

/** Cordis companion plugin name. */
export const name = 'team-orchestrator-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

function validateCandidate(session: Session, event: SessionEvent): void {
  if (!isTeamOrchestrationEvent(event)) return
  const runId = TeamRunId(session.id)
  const run = foldTeamRun(runId, session.events)
  if (run.created === undefined || run.phase === undefined) throw new Error('orchestration event requires an existing P1 TeamRun')
  if (event.type === 'collaboration/orchestration/profile') {
    const profile = parseTeamProfileEvent(event.data)
    if (run.phase !== 'profiling'
      || profile.runId !== runId
      || profile.profile.objective !== run.created.objective
      || profile.profile.complexity !== run.created.complexity
      || profile.profile.plannedExperts !== run.created.plannedExperts) {
      throw new Error('task profile does not match its owning P1 TeamRun')
    }
  } else if (run.phase !== 'planning') {
    throw new Error(`team plan and charter can commit only during planning, not ${run.phase}`)
  }
  const state = foldTeamOrchestration(runId, session.events)
  applyTeamOrchestrationEvent(state, event)
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    try {
      validateCandidate(session, event)
    } catch (error: unknown) {
      fail(`team orchestrator candidate ${event.seq} is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the TeamOrchestrator invariant companion.
 * @param ctx - Cordis context with Session and invariant registries.
 * @returns disposer registration promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
