/** Package-owned invariant companion for the remote marketplace provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-marketplace'

/** Cordis companion plugin name. */
export const name = 'skill-marketplace-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Remote observations are immutable values and own no independent runtime relationship. */
const install: InvariantInstaller = () => {}

/** @param ctx - Cordis context carrying invariant registration. @returns exact disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
