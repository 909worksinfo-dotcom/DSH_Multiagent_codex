/** Package-owned invariant companion for the stateless TeamRun model adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-agent-team'

/** Cordis companion plugin name. */
export const name = 'tool-agent-team-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: `ctx.teamRuns` owns durable state, validation, and authorization. */
const install: InvariantInstaller = () => {}

/**
 * Register the model adapter's explicit invariant ownership.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns disposer registration promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
