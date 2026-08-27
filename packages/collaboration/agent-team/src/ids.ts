/** Zero-cost constructors for TeamRun branded identities. */

import type {
  CollaborationEventId as CollaborationEventIdType,
  CollaborationMessageId as CollaborationMessageIdType,
  ProvisionAttemptId as ProvisionAttemptIdType,
  TeamArtifactId as TeamArtifactIdType,
  TeamChallengeId as TeamChallengeIdType,
  TeamDecisionId as TeamDecisionIdType,
  TeamMemberId as TeamMemberIdType,
  TeamQualityGateId as TeamQualityGateIdType,
  TeamProtocolSlotId as TeamProtocolSlotIdType,
  TeamRunId as TeamRunIdType,
  TeamTaskId as TeamTaskIdType,
  TeamThreadId as TeamThreadIdType,
} from './types.ts'

/**
 * Brand one raw identity as a TeamRun id.
 * @param value - raw identity.
 * @returns the same string branded as a TeamRun id.
 */
export const TeamRunId = (value: string): TeamRunIdType => value as TeamRunIdType
/**
 * Brand one raw identity as a member id.
 * @param value - raw identity.
 * @returns the same string branded as a member id.
 */
export const TeamMemberId = (value: string): TeamMemberIdType => value as TeamMemberIdType
/**
 * Brand one raw identity as a provisioning-attempt id.
 * @param value - raw identity.
 * @returns the same string branded as an attempt id.
 */
export const ProvisionAttemptId = (value: string): ProvisionAttemptIdType => value as ProvisionAttemptIdType
/**
 * Brand one raw identity as a TeamRun task id.
 * @param value - raw identity.
 * @returns the same string branded as a task id.
 */
export const TeamTaskId = (value: string): TeamTaskIdType => value as TeamTaskIdType
/**
 * Brand one raw identity as a public thread id.
 * @param value - raw identity.
 * @returns the same string branded as a thread id.
 */
export const TeamThreadId = (value: string): TeamThreadIdType => value as TeamThreadIdType
/**
 * Brand one raw identity as a public message id.
 * @param value - raw identity.
 * @returns the same string branded as a message id.
 */
export const CollaborationMessageId = (value: string): CollaborationMessageIdType => value as CollaborationMessageIdType
/**
 * Brand one raw identity as a collaboration event id.
 * @param value - raw identity.
 * @returns the same string branded as an event id.
 */
export const CollaborationEventId = (value: string): CollaborationEventIdType => value as CollaborationEventIdType
/**
 * Brand one raw identity as a challenge id.
 * @param value - raw identity.
 * @returns the same string branded as a challenge id.
 */
export const TeamChallengeId = (value: string): TeamChallengeIdType => value as TeamChallengeIdType
/**
 * Brand one raw identity as a decision id.
 * @param value - raw identity.
 * @returns the same string branded as a decision id.
 */
export const TeamDecisionId = (value: string): TeamDecisionIdType => value as TeamDecisionIdType
/**
 * Brand one raw identity as an artifact id.
 * @param value - raw identity.
 * @returns the same string branded as an artifact id.
 */
export const TeamArtifactId = (value: string): TeamArtifactIdType => value as TeamArtifactIdType
/**
 * Brand one raw identity as a materialized quality-gate id.
 * @param value - raw identity.
 * @returns the same string branded as a quality-gate id.
 */
export const TeamQualityGateId = (value: string): TeamQualityGateIdType => value as TeamQualityGateIdType
/**
 * Brand one raw identity as a planned protocol slot id.
 * @param value - raw identity.
 * @returns the same string branded as a protocol slot id.
 */
export const TeamProtocolSlotId = (value: string): TeamProtocolSlotIdType => value as TeamProtocolSlotIdType

/** Default whole-team public discussion thread. */
export const MAIN_TEAM_THREAD_ID = TeamThreadId('main')
