/** Strict replay of P3 orchestration events from one Lead Session. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamRunSnapshot } from '@deepseek-ai/dsh-agent-team'
import { digestJson } from './digest.ts'
import { applyStageRequirements, applyTaskRequirements, executionStages, executionTaskDag } from './plan.ts'
import {
  parseTeamCharterEvent,
  parseTeamPlanEvent,
  parseTeamProfileEvent,
} from './schema.ts'
import type {
  TeamCharterEventData,
  TeamPlanEventData,
  TeamProfileEventData,
  TeamTopology,
} from './types.ts'

/** Mutable strict replay state retained only during folding. */
export interface TeamOrchestrationFoldState {
  readonly runId: TeamRunSnapshot['id']
  profile?: TeamProfileEventData
  plan?: TeamPlanEventData
  charter?: TeamCharterEventData
  createdAt?: number
}

/**
 * Create replay state for one owning TeamRun.
 * @param runId - owning TeamRun.
 * @returns empty replay state.
 */
export function emptyTeamOrchestrationFoldState(runId: TeamRunSnapshot['id']): TeamOrchestrationFoldState {
  return { runId }
}

/**
 * Test whether a Session event belongs to P3 orchestration replay.
 * @param event - candidate Session event.
 * @returns whether P3 owns the event.
 */
export function isTeamOrchestrationEvent(event: SessionEvent): boolean {
  return event.type === 'collaboration/orchestration/profile'
    || event.type === 'collaboration/orchestration/plan'
    || event.type === 'collaboration/orchestration/charter'
}

function assertCommon(
  state: TeamOrchestrationFoldState,
  value: TeamProfileEventData | TeamPlanEventData | TeamCharterEventData,
): void {
  if (value.runId !== state.runId) throw new Error(`orchestration event belongs to "${value.runId}" instead of "${state.runId}"`)
  if (state.profile !== undefined
    && (value.requestId !== state.profile.requestId || value.requestDigest !== state.profile.requestDigest)) {
    throw new Error('orchestration request identity or digest changed within one TeamRun')
  }
}

function legalTopology(complexity: 'simple' | 'medium' | 'complex', topology: TeamTopology): boolean {
  return complexity === 'simple'
    ? topology === 'producer_reviewer'
    : complexity === 'medium'
      ? topology === 'centralized' || topology === 'parallel'
      : topology === 'hybrid' || topology === 'grouped'
}

/**
 * Apply one owned event with ordering, digest, count, and topology validation.
 * @param state - mutable candidate replay state.
 * @param event - persisted or not-yet-appended Session event.
 */
export function applyTeamOrchestrationEvent(state: TeamOrchestrationFoldState, event: SessionEvent): void {
  if (event.type === 'collaboration/orchestration/profile') {
    const value = parseTeamProfileEvent(event.data)
    assertCommon(state, value)
    if (state.profile !== undefined) throw new Error('TeamRun already has a task profile')
    if (value.requestDigest !== digestJson({
      requestId: value.requestId,
      retryOf: value.retryOf ?? null,
      profile: value.profile,
    })) throw new Error('task profile request digest does not match its complete value')
    state.profile = value
    state.createdAt = event.time
    return
  }
  if (event.type === 'collaboration/orchestration/plan') {
    const value = parseTeamPlanEvent(event.data)
    assertCommon(state, value)
    const profile = state.profile
    if (profile === undefined || state.plan !== undefined) throw new Error('team plan must follow exactly one task profile')
    if (value.planDigest !== digestJson(value.plan)) throw new Error('team plan digest does not match its complete value')
    if (value.plan.roster.length !== profile.profile.plannedExperts) throw new Error('team plan roster does not match the profiled expert target')
    if (!legalTopology(profile.profile.complexity, value.plan.topology)) throw new Error('team plan topology is illegal for the profiled complexity')
    const currentPlan = profile.profile.workstreamSource !== undefined
    const plannedWorkstreams = value.plan.taskDag.map(({ assigneeSlotId: _assigneeSlotId, ...task }) => task)
    if (digestJson(plannedWorkstreams) !== digestJson(currentPlan
      ? applyStageRequirements(applyTaskRequirements(executionTaskDag(profile.profile), profile.profile), profile.profile)
      : profile.profile.workstreams)
      || (currentPlan && digestJson(value.plan.stages) !== digestJson(executionStages(value.plan.taskDag)))
      || (currentPlan && value.plan.taskDag.some(task => task.assigneeSlotId === undefined
        || !value.plan.roster.some(expert => expert.slotId === task.assigneeSlotId)))
      || value.plan.roster.some(item => item.assignment.objective !== profile.profile.objective)) {
      throw new Error('team plan task DAG or assignments do not match the task profile')
    }
    if (new Set(value.plan.roster.map(item => String(item.slotId))).size !== value.plan.roster.length
      || new Set(value.plan.roster.map(item => `${item.blueprint.id}@${String(item.blueprint.revision)}`)).size !== value.plan.roster.length) {
      throw new Error('team plan roster slots and blueprint revisions must be unique')
    }
    state.plan = value
    return
  }
  if (event.type === 'collaboration/orchestration/charter') {
    const value = parseTeamCharterEvent(event.data)
    assertCommon(state, value)
    const profile = state.profile
    const plan = state.plan
    if (profile === undefined || plan === undefined || state.charter !== undefined) {
      throw new Error('team charter must follow exactly one task profile and plan')
    }
    if (value.planDigest !== plan.planDigest) throw new Error('team charter references a different plan digest')
    if (value.charterDigest !== digestJson(value.charter)) throw new Error('team charter digest does not match its complete value')
    const expectedQualityChecks = [...new Set([
      ...profile.profile.successCriteria,
      ...plan.plan.roster.flatMap(expert => expert.acceptanceCriteria),
    ])]
    if (value.charter.objective !== profile.profile.objective
      || digestJson(value.charter.successCriteria) !== digestJson(profile.profile.successCriteria)
      || value.charter.topology !== plan.plan.topology
      || digestJson(value.charter.taskDag) !== digestJson(plan.plan.taskDag)
      || digestJson(value.charter.stages ?? null) !== digestJson(plan.plan.stages ?? null)
      || digestJson(value.charter.roster) !== digestJson(plan.plan.roster.map(
        ({ slotId, name, role, blueprint }) => ({ slotId, name, role, blueprint }),
      ))
      || digestJson(value.charter.qualityChecks) !== digestJson(expectedQualityChecks)
      || digestJson(value.charter.budgets) !== digestJson(plan.plan.roster.map(
        expert => ({ slotId: expert.slotId, execution: expert.budget }),
      ))) {
      throw new Error('team charter does not match its profile and exact plan')
    }
    state.charter = value
  }
}

/**
 * Reconstruct P3 state from one Lead Session event stream.
 * @param runId - exact TeamRun owner.
 * @param events - complete Lead Session events.
 * @returns strict replay state, including allowed formation intermediates.
 */
export function foldTeamOrchestration(runId: TeamRunSnapshot['id'], events: readonly SessionEvent[]): TeamOrchestrationFoldState {
  const state = emptyTeamOrchestrationFoldState(runId)
  for (const event of events) if (isTeamOrchestrationEvent(event)) applyTeamOrchestrationEvent(state, event)
  return state
}
