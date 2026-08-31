/**
 * approvals domain contract. The approval requested frame is a
 * server-request (stable rpcId); the answer is a client-response echoing that rpcId (not a
 * unary method, not in RpcMethodMap, mints no new id), carried on POST /api/respond with an
 * RpcReceipt carrier receipt as the HTTP response body; the final outcome arrives in the resolved frame.
 */

import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Approval answer payload (the result.value slot of a client-response). The
 * task-wide value is a Web collaboration extension: the gateway converts it
 * into one-shot core grants for every pending/future member request in the
 * same live TeamRun. `cancelled` and `unavailable` remain host-only outcomes.
 * approvalId is the core audit correlation; wire correlation is governed by
 * the echoed rpcId.
 */
export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  outcome: 'allowed-once' | 'allowed-for-turn' | 'allowed-for-task' | 'rejected'
}
