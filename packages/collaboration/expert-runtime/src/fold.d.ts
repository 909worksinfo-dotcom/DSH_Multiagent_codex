/** Strict folds for immutable Lead bindings and child descriptors. */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from './types.ts';
type ProvisionAttemptIdType = ExpertBindingEventData['attemptId'];
type TeamRunIdType = ExpertBindingEventData['runId'];
/**
 * Whether two records carry the same immutable identity and capability digest.
 * @param left - first Lead binding or child descriptor.
 * @param right - second Lead binding or child descriptor.
 * @returns whether every durable identity and descriptor field is equal.
 */
export declare function sameExpertDescriptor(left: ExpertBindingEventData | ExpertChildDescriptorEventData, right: ExpertBindingEventData | ExpertChildDescriptorEventData): boolean;
/**
 * Fold every exact TeamRun binding while rejecting identity reuse.
 * @param runId - owning TeamRun.
 * @param events - Lead Session events.
 * @returns immutable bindings in append order.
 */
export declare function foldExpertBindings(runId: TeamRunIdType, events: readonly SessionEvent[]): ExpertBindingEventData[];
/**
 * Resolve one exact Lead binding.
 * @param runId - owning TeamRun.
 * @param events - Lead Session events.
 * @param attemptId - immutable attempt selector.
 * @returns the exact binding, or undefined.
 */
export declare function findExpertBinding(runId: TeamRunIdType, events: readonly SessionEvent[], attemptId: ProvisionAttemptIdType): ExpertBindingEventData | undefined;
/**
 * Fold one child Session's own immutable expert descriptor.
 * @param session - child Session or inspection result carrying seed length.
 * @returns the own descriptor, or undefined for a non-expert child.
 */
export declare function foldExpertChildDescriptor(session: Pick<Session, 'events' | 'header'>): ExpertChildDescriptorEventData | undefined;
/**
 * Count expert turns owned by this child after its descriptor, excluding inherited fork turns.
 * @param session - child Session carrying the durable seed boundary.
 * @returns number of own admitted turn-start records after the expert descriptor.
 */
export declare function countExpertTurns(session: Pick<Session, 'events' | 'header'>): number;
/**
 * Whether the retained initial expert prompt already entered this child's durable own log.
 * @param session - child Session or inspection result carrying the seed boundary.
 * @param prompt - exact retained initial prompt.
 * @returns whether one own user message contains exactly that prompt.
 */
export declare function hasExpertInitialPrompt(session: Pick<Session, 'events' | 'header'>, prompt: string): boolean;
export {};
//# sourceMappingURL=fold.d.ts.map