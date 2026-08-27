/** Immutable ExpertBlueprint registry with exact preset, skill, and plugin resolution. */
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import type { Config, ExpertBlueprint, ExpertBlueprintRef, ResolveExpertBindingOptions, ResolvedExpertBinding } from './types.ts';
export type * from './types.ts';
export { ExpertBindingDigest, ExpertBlueprintId } from './ids.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        expertCatalog: ExpertCatalog;
    }
}
/** Locally configured immutable ExpertBlueprint catalog. */
export declare class ExpertCatalog extends Service {
    static inject: string[];
    /** Loader schema; exact nested validation runs before the service publishes. */
    static Config: schema<Config>;
    private readonly revisions;
    /**
     * @param ctx - Cordis context carrying preset and skill registries.
     * @param config - complete local immutable blueprint revisions.
     */
    constructor(ctx: Context, config?: Config);
    /**
     * List configured immutable revisions in deployment order.
     * @returns detached blueprint references.
     */
    list(): ExpertBlueprintRef[];
    /**
     * Read one exact configured revision without resolving external capabilities.
     * @param ref - exact immutable selector.
     * @returns a detached blueprint.
     * @throws `CAPABILITY_UNAVAILABLE` when the revision is not configured.
     */
    get(ref: ExpertBlueprintRef): ExpertBlueprint;
    /**
     * Resolve one revision to the exact mountable preset, enabled plugin rows, and winning skill definitions.
     * @param ref - exact immutable selector.
     * @param options - cwd-sensitive lookup and caller cancellation.
     * @returns detached binding with a digest covering every resolved capability.
     * @throws `CAPABILITY_UNAVAILABLE` instead of omitting any missing or indeterminate capability.
     */
    resolve(ref: ExpertBlueprintRef, options?: ResolveExpertBindingOptions): Promise<ResolvedExpertBinding>;
}
export default ExpertCatalog;
//# sourceMappingURL=index.d.ts.map