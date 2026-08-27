/** Zero-cost constructors for TeamOrchestrator branded identities. */

import type {
  TeamOrchestrationEventId as EventId,
  TeamOrchestrationRequestId as RequestId,
  TeamPlanSlotId as SlotId,
} from './types.ts'

/**
 * Brand a validated orchestration request identity.
 * @param value - validated raw request identity.
 * @returns branded request identity.
 */
export const TeamOrchestrationRequestId = (value: string): RequestId => value as RequestId

/**
 * Brand a validated orchestration event identity.
 * @param value - validated raw event identity.
 * @returns branded event identity.
 */
export const TeamOrchestrationEventId = (value: string): EventId => value as EventId

/**
 * Brand a validated planned-roster slot identity.
 * @param value - validated raw planned-slot identity.
 * @returns branded slot identity.
 */
export const TeamPlanSlotId = (value: string): SlotId => value as SlotId
