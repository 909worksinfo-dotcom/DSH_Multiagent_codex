/** Package-owned invariant companion for the immutable ExpertBlueprint catalog. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-expert-catalog'

/** Cordis companion plugin name. */
export const name = 'expert-catalog-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** No runtime invariant: constructor validation freezes the complete catalog and it has no mutable registration or event relation. */
const install: InvariantInstaller = () => {}

/**
 * Register the ExpertBlueprint catalog invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns disposer registration promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
