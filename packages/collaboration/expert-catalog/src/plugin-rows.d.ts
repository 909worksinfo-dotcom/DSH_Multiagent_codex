/** Preset plugin-row extraction used by capability admission. */
type PluginState = 'enabled' | 'disabled' | 'dynamic';
/**
 * Parse plugin module states from one preset composition.
 * @param content - exact agent.cordis.yml source.
 * @returns module name to statically provable activation state.
 */
export declare function presetPluginStates(content: string): ReadonlyMap<string, PluginState>;
export {};
//# sourceMappingURL=plugin-rows.d.ts.map