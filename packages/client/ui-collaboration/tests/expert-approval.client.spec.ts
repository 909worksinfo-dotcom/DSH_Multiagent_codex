import { describe, expect, it, vi } from 'vitest'
import { PendingWait, type ConversationSnapshot, type ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { answerExpertApproval, readExpertApproval } from '../src/client/expert-approval.ts'

const SESSION_ID = 'expert-session-1' as SessionId

function sessionsWith(wait: PendingWait<'approval'> | undefined): Pick<ISessions, 'binding'> {
  const snapshot = { pending: wait === undefined ? [] : [wait] } as unknown as ConversationSnapshot
  return {
    binding: vi.fn(() => ({
      sessionId: SESSION_ID,
      session: { getSnapshot: () => snapshot },
      ctx: {},
    } as never)),
  }
}

describe('collaboration expert approvals', () => {
  it('projects and answers the exact expert approval wait', async () => {
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const wait = new PendingWait(
      'approval',
      'approval-rpc-1' as RpcId,
      SESSION_ID,
      {
        approvalId: 'approval-1' as never,
        toolName: 'bash',
        callId: 'call-1' as never,
        reason: '需要读取飞书认证状态',
      },
      respond,
    )
    const sessions = sessionsWith(wait)

    expect(readExpertApproval(sessions, SESSION_ID)).toEqual({
      key: 'a:approval-rpc-1',
      sessionId: SESSION_ID,
      toolName: 'bash',
      callId: 'call-1',
      reason: '需要读取飞书认证状态',
    })
    await answerExpertApproval(sessions, SESSION_ID, wait.key, 'allowed-for-turn')

    expect(respond).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith({
      type: 'client-response',
      rpcId: 'approval-rpc-1',
      result: {
        ok: true,
        value: {
          sessionId: SESSION_ID,
          approvalId: 'approval-1',
          outcome: 'allowed-for-turn',
        },
      },
    })
  })

  it('preserves the TeamRun scope and submits the collaboration-wide grant', async () => {
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const wait = new PendingWait(
      'approval',
      'approval-rpc-task' as RpcId,
      SESSION_ID,
      {
        approvalId: 'approval-task' as never,
        toolName: 'web_search',
        collaborationRunId: 'collaboration-run-1' as SessionId,
      },
      respond,
    )
    const sessions = sessionsWith(wait)

    expect(readExpertApproval(sessions, SESSION_ID)).toMatchObject({
      key: 'a:approval-rpc-task',
      collaborationRunId: 'collaboration-run-1',
    })
    await answerExpertApproval(sessions, SESSION_ID, wait.key, 'allowed-for-task')

    expect(respond).toHaveBeenCalledWith({
      type: 'client-response',
      rpcId: 'approval-rpc-task',
      result: {
        ok: true,
        value: {
          sessionId: SESSION_ID,
          approvalId: 'approval-task',
          outcome: 'allowed-for-task',
        },
      },
    })
  })

  it('rejects a stale approval key instead of answering another request', async () => {
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const wait = new PendingWait(
      'approval',
      'approval-rpc-2' as RpcId,
      SESSION_ID,
      { approvalId: 'approval-2' as never, toolName: 'bash' },
      respond,
    )

    await expect(answerExpertApproval(
      sessionsWith(wait),
      SESSION_ID,
      'a:stale-approval',
      'allowed-once',
    )).rejects.toThrow('is no longer pending')
    expect(respond).not.toHaveBeenCalled()
  })

  it('surfaces a rejected response receipt instead of pretending the wait was resolved', async () => {
    const respond = vi.fn(async () => ({
      accepted: false as const,
      reason: 'not-pending' as const,
    }))
    const wait = new PendingWait(
      'approval',
      'approval-rpc-3' as RpcId,
      SESSION_ID,
      { approvalId: 'approval-3' as never, toolName: 'bash' },
      respond,
    )

    await expect(answerExpertApproval(
      sessionsWith(wait),
      SESSION_ID,
      wait.key,
      'rejected',
    )).rejects.toThrow('not-pending')
    expect(respond).toHaveBeenCalledOnce()
  })
})
