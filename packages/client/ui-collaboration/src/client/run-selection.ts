import type { CollaborationRunSnapshot } from './types.ts'

const WORKSPACE_RECOVERABLE_STATUSES = new Set([
  'forming', 'running', 'blocked', 'reviewing', 'reworking',
])

/** Select the newest durable task that still has a meaningful workspace to recover. */
export function preferredCollaborationRun(
  runs: readonly CollaborationRunSnapshot[],
): CollaborationRunSnapshot | undefined {
  return runs
    .filter(run => run.status !== 'cancelled')
    .reduce<CollaborationRunSnapshot | undefined>((newest, run) => (
      newest === undefined || run.createdAt > newest.createdAt ? run : newest
    ), undefined)
}

/** Select the newest non-terminal task that should reclaim the center workspace after reload. */
export function preferredActiveCollaborationRun(
  runs: readonly CollaborationRunSnapshot[],
): CollaborationRunSnapshot | undefined {
  return runs
    .filter(run => WORKSPACE_RECOVERABLE_STATUSES.has(run.status))
    .reduce<CollaborationRunSnapshot | undefined>((newest, run) => (
      newest === undefined || run.createdAt > newest.createdAt ? run : newest
    ), undefined)
}
