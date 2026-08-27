/** Strict decoding for persisted expert binding and child descriptor events. */
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from './types.ts';
/**
 * Decode one Lead-side binding from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version binding.
 */
export declare function parseExpertBinding(value: unknown): ExpertBindingEventData;
/**
 * Decode one child-side descriptor from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version descriptor.
 */
export declare function parseExpertChildDescriptor(value: unknown): ExpertChildDescriptorEventData;
//# sourceMappingURL=schema.d.ts.map