/** Complete DAG validation for current non-deleted TeamRun tasks. */

import type { TeamTaskId, TeamTaskSnapshot } from './types.ts'

/** Invalid relation categories mapped onto stable domain failures by commands. */
export type TeamTaskGraphViolation = 'missing' | 'duplicate' | 'cycle'

/** Package-private dependency failure retaining its stable relation category. */
export class TeamTaskGraphError extends Error {
  /** Stable category used by command-layer error mapping. */
  readonly violation: TeamTaskGraphViolation

  /**
   * @param violation - stable relation category.
   * @param message - concrete invalid dependency relation.
   */
  constructor(violation: TeamTaskGraphViolation, message: string) {
    super(message)
    this.name = 'TeamTaskGraphError'
    this.violation = violation
  }
}

/**
 * Validate the complete task graph after replacing one candidate snapshot.
 * @param current - latest task snapshots before the candidate.
 * @param candidate - new or next-revision task snapshot.
 * @throws {TeamTaskGraphError} when a live dependency is absent, duplicated, self-referential, or cyclic.
 */
export function assertTaskGraphCandidate(
  current: ReadonlyMap<TeamTaskId, TeamTaskSnapshot>,
  candidate: TeamTaskSnapshot,
): void {
  const next = new Map(current)
  next.set(candidate.id, candidate)
  const live = new Map([...next].filter(([, task]) => task.status !== 'deleted'))
  const remainingBlockers = new Map<TeamTaskId, number>()
  const dependents = new Map<TeamTaskId, TeamTaskId[]>()

  for (const [id, task] of live) {
    const uniqueBlockers = new Set(task.blockedBy)
    if (uniqueBlockers.size !== task.blockedBy.length) {
      throw new TeamTaskGraphError('duplicate', `team task "${id}" repeats a blocker`)
    }
    if (uniqueBlockers.has(id)) {
      throw new TeamTaskGraphError('cycle', `team task "${id}" cannot block itself`)
    }
    for (const blockerId of uniqueBlockers) {
      if (!live.has(blockerId)) {
        throw new TeamTaskGraphError('missing', `blocker task "${blockerId}" for "${id}" is missing or deleted`)
      }
      const consumers = dependents.get(blockerId) ?? []
      consumers.push(id)
      dependents.set(blockerId, consumers)
    }
    remainingBlockers.set(id, uniqueBlockers.size)
  }

  const ready = [...remainingBlockers].filter(([, count]) => count === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const resolved = ready.pop()
    if (resolved === undefined) break
    visited += 1
    for (const dependentId of dependents.get(resolved) ?? []) {
      const count = (remainingBlockers.get(dependentId) ?? 0) - 1
      remainingBlockers.set(dependentId, count)
      if (count === 0) ready.push(dependentId)
    }
  }
  if (visited !== live.size) {
    const cycleMember = [...remainingBlockers].find(([, count]) => count > 0)?.[0]
    throw new TeamTaskGraphError('cycle', `task dependency cycle includes "${String(cycleMember)}"`)
  }
}
