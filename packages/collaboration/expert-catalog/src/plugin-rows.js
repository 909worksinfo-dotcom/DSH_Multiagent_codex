/** Preset plugin-row extraction used by capability admission. */
import yaml from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
/** Merge duplicate row observations, preferring an enabled occurrence. */
function mergeState(current, next) {
    if (current === 'enabled' || next === 'enabled')
        return 'enabled';
    if (current === 'dynamic' || next === 'dynamic')
        return 'dynamic';
    return 'disabled';
}
/** Classify one row under its containing group's state. */
function rowState(value, parent) {
    if (parent !== 'enabled')
        return parent;
    if (value === true)
        return 'disabled';
    if (value === undefined || value === false)
        return 'enabled';
    return 'dynamic';
}
/** Recursively collect declared plugin modules from Loader rows. */
function visitRows(value, parent, found) {
    if (!Array.isArray(value))
        throw new Error('preset composition must be a top-level list of plugin rows');
    for (const candidate of value) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            throw new Error('preset composition contains a non-object plugin row');
        }
        const row = candidate;
        if (typeof row.name !== 'string' || row.name.length === 0)
            throw new Error('preset composition contains a plugin row without a name');
        const state = rowState(row.disabled, parent);
        if (row.group === true) {
            visitRows(row.config, state, found);
            continue;
        }
        found.set(row.name, mergeState(found.get(row.name), state));
    }
}
/**
 * Parse plugin module states from one preset composition.
 * @param content - exact agent.cordis.yml source.
 * @returns module name to statically provable activation state.
 */
export function presetPluginStates(content) {
    const parsed = yaml.load(content, { schema: entryListSchema });
    const found = new Map();
    visitRows(parsed, 'enabled', found);
    return found;
}
//# sourceMappingURL=plugin-rows.js.map