import type { ISessions, PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CollaborationApprovalOutcome, CollaborationExpertApproval,
} from './contract.ts'

type SessionsApprovalPort = Pick<ISessions, 'binding'>

/** Read the first answerable approval blocking one expert session. */
export function readExpertApproval(
  sessions: SessionsApprovalPort,
  sessionId: string,
): CollaborationExpertApproval | null {
  const pending = sessions.binding(sessionId as SessionId)?.session.getSnapshot().pending
    .find((wait): wait is PendingWait<'approval'> => wait.kind === 'approval')
  if (pending === undefined) return null
  return {
    key: pending.key,
    sessionId: String(pending.sessionId),
    toolName: pending.payload.toolName,
    ...pending.payload.reason === undefined ? {} : { reason: pending.payload.reason },
    ...pending.payload.callId === undefined ? {} : { callId: String(pending.payload.callId) },
    ...pending.payload.collaborationRunId === undefined
      ? {}
      : { collaborationRunId: pending.payload.collaborationRunId },
  }
}

/** Resolve one exact pending approval without falling through to another wait. */
export async function answerExpertApproval(
  sessions: SessionsApprovalPort,
  sessionId: string,
  approvalKey: string,
  outcome: CollaborationApprovalOutcome,
): Promise<void> {
  const pending = sessions.binding(sessionId as SessionId)?.session.getSnapshot().pending
    .find((wait): wait is PendingWait<'approval'> => wait.kind === 'approval' && wait.key === approvalKey)
  if (pending === undefined) {
    throw new Error(`collaboration expert approval "${approvalKey}" is no longer pending`)
  }
  const receipt = await pending.respond({
    ok: true,
    value: {
      sessionId: pending.sessionId,
      approvalId: pending.payload.approvalId,
      outcome,
    },
  })
  if (!receipt.accepted) throw new Error(`collaboration expert approval response was rejected: ${receipt.reason}`)
}
