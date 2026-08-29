/** Compare-and-set task commands over the TeamRun journal. */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sameActor, resolveActorByName } from './authority.ts'
import { reviewableOwnerArtifact } from './completion-evidence.ts'
import { TeamRunError } from './error.ts'
import { projectTeamTask } from './fold.ts'
import type { TeamRunFoldState } from './fold.ts'
import { CollaborationEventId, TeamTaskId } from './ids.ts'
import type { TeamRunJournal } from './journal.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import type {
  CreateTeamTaskRequest,
  TeamActorRef,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { requiredText, resourceScope } from './validation.ts'

const GRAPH_CODES: Record<TeamTaskGraphViolation, 'TEAM_TASK_NOT_FOUND' | 'TEAM_INVALID_ARGUMENT' | 'TEAM_TASK_DEPENDENCY_CYCLE'> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Owns TeamRun task limits, authorization, transitions, CAS, and DAG checks. */
export class TeamRunTaskBoard {
  /** @param journal - authoritative Lead-log transaction owner. */
  constructor(private readonly journal: TeamRunJournal) {}

  /**
   * Create one unowned pending task.
   * @param lead - exact live TeamRun Lead.
   * @param request - task text, blockers, and advisory resource scopes.
   * @returns committed revision-one task view.
   */
  async create(lead: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return this.journal.transact(lead.id, async () => {
      const state = this.journal.state(lead)
      const created = state.created
      if (created === undefined) throw new TeamRunError(`TeamRun "${state.id}" not found`, 'TEAM_NOT_FOUND')
      this.assertTaskPhase(state)
      const currentTasks = [...state.tasks.values()].filter(task => task.status !== 'deleted').length
      if (currentTasks >= created.policy.maxTasks) {
        throw new TeamRunError(`TeamRun task limit ${created.policy.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.has(id)) throw new TeamRunError('TeamRun task id space exhausted', 'TEAM_TASK_LIMIT')
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        status: 'pending',
        blockedBy: this.dependencies(request.blockedBy ?? [], state),
        resourceScopes: this.resourceScopes(request.resourceScopes ?? []),
      }
      this.assertGraph(state, task)
      await this.journal.appendAndFlush(lead, 'collaboration/task', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        task,
      })
      const committed = this.journal.state(lead)
      const committedTask = committed.tasks.get(id)
      if (committedTask === undefined) throw new Error(`committed team task "${id}" is missing from replay`)
      return projectTeamTask(committed, committedTask)
    })
  }

  /**
   * Return one current task, including a deleted tombstone.
   * @param state - current authoritative replay state.
   * @param id - task identity.
   * @returns detached current task view.
   */
  get(state: TeamRunFoldState, id: import('./types.ts').TeamTaskId): TeamTaskView {
    const task = state.tasks.get(id)
    if (task === undefined) throw new TeamRunError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return projectTeamTask(state, task)
  }

  /**
   * List current non-deleted tasks in creation order.
   * @param state - current authoritative replay state.
   * @returns detached current task views.
   */
  list(state: TeamRunFoldState): TeamTaskView[] {
    return [...state.tasks.values()]
      .filter(task => task.status !== 'deleted')
      .map(task => projectTeamTask(state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param lead - exact live TeamRun Lead.
   * @param actor - current Lead or active expert authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns committed next task revision.
   */
  async update(lead: Agent, actor: TeamActorRef, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return this.journal.transact(lead.id, async () => {
      const state = this.journal.state(lead)
      const task = this.planUpdate(state, actor, request)
      await this.journal.appendAndFlush(lead, 'collaboration/task', {
        version: 1,
        runId: state.id,
        eventId: CollaborationEventId(`collaboration-event-${randomUUID()}`),
        revision: state.revision + 1,
        task,
      })
      return this.get(this.journal.state(lead), task.id)
    })
  }

  /**
   * Validate and prepare one task CAS mutation without writing it.
   * @param state - authoritative state inside the owning journal transaction.
   * @param actor - current Lead or active expert.
   * @param request - requested compare-and-set mutation.
   * @returns complete next task value for an atomic multi-ledger batch.
   */
  planUpdate(state: TeamRunFoldState, actor: TeamActorRef, request: UpdateTeamTaskRequest): TeamTaskSnapshot {
    this.assertTaskPhase(state)
    const current = state.tasks.get(request.taskId)
    if (current === undefined) {
      throw new TeamRunError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
    }
    if (current.revision !== request.expectedRevision) {
      throw new TeamRunError(
        `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
        'STALE_REVISION',
        { retryable: true, details: { taskId: current.id, expected: request.expectedRevision, actual: current.revision } },
      )
    }
    if (current.status === 'deleted') {
      throw new TeamRunError(`team task "${current.id}" is deleted`, 'TEAM_TASK_INVALID_TRANSITION')
    }
    const leadAuthority = actor.role === 'lead'
    const ownerAuthority = current.owner !== undefined && sameActor(current.owner, actor)
    const requireOwner = (): void => {
      if (!leadAuthority && !ownerAuthority) {
        throw new TeamRunError('task mutation requires its owner or TeamRun Lead', 'TEAM_TASK_UNAUTHORIZED')
      }
    }

    let next: TeamTaskSnapshot
    switch (request.action) {
      case 'assign':
        if (!leadAuthority) throw new TeamRunError('only the TeamRun Lead can assign tasks', 'TEAM_LEAD_REQUIRED')
        if (current.status !== 'pending' || current.owner !== undefined) {
          throw new TeamRunError(
            'only an unowned pending task can receive its planned assignment',
            'TEAM_TASK_INVALID_TRANSITION',
          )
        }
        if (request.owner === undefined || request.owner.trim().length === 0) {
          throw new TeamRunError('assign requires one active expert owner', 'TEAM_INVALID_ARGUMENT')
        }
        const plannedOwner = resolveActorByName(state, request.owner)
        if (plannedOwner.role !== 'expert') {
          throw new TeamRunError('planned task assignment requires an active expert', 'TEAM_TASK_UNAUTHORIZED')
        }
        next = { ...current, owner: plannedOwner }
        break
      case 'claim':
        if (current.owner !== undefined && !sameActor(current.owner, actor)) {
          throw new TeamRunError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_UNAUTHORIZED')
        }
        if (current.status !== 'pending' || !this.ready(state, current)) {
          throw new TeamRunError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
        }
        next = { ...current, status: 'in_progress', owner: actor }
        break
      case 'release':
        requireOwner()
        if (current.status !== 'in_progress') {
          throw new TeamRunError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
        }
        next = this.withoutOwner({ ...current, status: 'pending' })
        break
      case 'edit':
        requireOwner()
        next = this.edit(current, request)
        break
      case 'set_dependencies':
        requireOwner()
        if (request.blockedBy === undefined) {
          throw new TeamRunError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
        }
        next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
        break
      case 'complete':
        requireOwner()
        if (current.status !== 'in_progress') {
          throw new TeamRunError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
        }
        if (!this.ready(state, current)) {
          throw new TeamRunError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
        }
        if (state.protocol !== undefined && current.owner?.role !== 'expert') {
          throw new TeamRunError(
            `enforced team task "${current.id}" requires an expert owner before completion`,
            'TEAM_TASK_INVALID_TRANSITION',
          )
        }
        if (state.protocol !== undefined && reviewableOwnerArtifact(state, current) === undefined) {
          throw new TeamRunError(
            `team task "${current.id}" requires a reviewable artifact authored by its owner before completion`,
            'TEAM_TASK_INVALID_TRANSITION',
          )
        }
        next = { ...current, status: 'completed' }
        break
      case 'reopen':
        requireOwner()
        if (current.status !== 'completed') {
          throw new TeamRunError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
        }
        next = this.withoutOwner({ ...current, status: 'pending' })
        break
      case 'reassign': {
        if (!leadAuthority) throw new TeamRunError('only the TeamRun Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
        if (current.status !== 'pending' && current.status !== 'in_progress') {
          throw new TeamRunError(
            'only a pending or in-progress task can be reassigned',
            'TEAM_TASK_INVALID_TRANSITION',
          )
        }
        if (request.owner === undefined || request.owner.trim().length === 0) {
          next = this.withoutOwner({ ...current, status: 'pending' })
        } else {
          if (!this.ready(state, current)) {
            throw new TeamRunError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          }
          next = { ...current, status: 'in_progress', owner: resolveActorByName(state, request.owner) }
        }
        break
      }
      case 'delete': {
        requireOwner()
        const dependent = [...state.tasks.values()].find(task =>
          task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
        if (dependent !== undefined) {
          throw new TeamRunError(
            `team task "${current.id}" still blocks "${dependent.id}"`,
            'TEAM_TASK_HAS_DEPENDENTS',
          )
        }
        next = { ...current, status: 'deleted' }
        break
      }
    }

    const task: TeamTaskSnapshot = { ...next, revision: current.revision + 1 }
    this.assertGraph(state, task)
    return task
  }

  /** Normalize and de-duplicate dependency ids against current tasks. */
  private dependencies(
    values: readonly import('./types.ts').TeamTaskId[],
    state: TeamRunFoldState,
    self?: import('./types.ts').TeamTaskId,
  ): import('./types.ts').TeamTaskId[] {
    const seen = new Set<import('./types.ts').TeamTaskId>()
    const result: import('./types.ts').TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamRunError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamRunError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.get(id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamRunError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Reject task mutations outside planning, formation, execution, or completion review. */
  private assertTaskPhase(state: TeamRunFoldState): void {
    if (state.phase === 'planning' || state.phase === 'provisioning'
      || state.phase === 'active' || state.phase === 'completing') return
    throw new TeamRunError(`tasks cannot change while TeamRun is ${String(state.phase)}`, 'TEAM_INVALID_TRANSITION')
  }

  /** Normalize and de-duplicate generic resource scopes. */
  private resourceScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(resourceScope))]
  }

  /** Apply normalized optional edit fields while retaining the complete task value. */
  private edit(current: TeamTaskSnapshot, request: UpdateTeamTaskRequest): TeamTaskSnapshot {
    const changes = [request.subject, request.description, request.resourceScopes]
    if (changes.every(value => value === undefined)) {
      throw new TeamRunError('task edit requires subject, description, or resource_scopes', 'TEAM_INVALID_ARGUMENT')
    }
    const subject = request.subject === undefined
      ? current.subject
      : requiredText(request.subject, 'subject', 200)
    const description = request.description === undefined
      ? current.description
      : requiredText(request.description, 'description', 16_384)
    const resourceScopes = request.resourceScopes === undefined
      ? current.resourceScopes
      : this.resourceScopes(request.resourceScopes)
    return { ...current, subject, description, resourceScopes }
  }

  /** Map shared graph validation onto stable command errors. */
  private assertGraph(state: TeamRunFoldState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamRunError(error.message, GRAPH_CODES[error.violation], { cause: error })
    }
  }

  /** Whether every current blocker completed. */
  private ready(state: TeamRunFoldState, task: TeamTaskSnapshot): boolean {
    return task.blockedBy.every(id => state.tasks.get(id)?.status === 'completed')
  }

  /** Remove an optional owner under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { owner: _owner, ...without } = task
    return without
  }
}
