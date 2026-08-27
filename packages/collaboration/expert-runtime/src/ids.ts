/** Constructor for durable expert-runtime event identity. */

import type { ExpertRuntimeEventId as Id } from './types.ts'

/**
 * Brand a validated event id.
 * @param value - raw identity.
 * @returns the same value branded as an expert-runtime event id.
 */
export const ExpertRuntimeEventId = (value: string): Id => value as Id
