import { describe, expect, it } from 'vitest'
import {
  ProvisionAttemptId,
  TeamMemberId,
  TeamRunId,
} from '@deepseek-ai/dsh-agent-team'
import { ExpertBindingDigest, ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  countExpertTurns,
  hasExpertInitialPrompt,
  sameExpertDescriptor,
} from '../src/fold.ts'
import { ExpertRuntimeEventId } from '../src/ids.ts'
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from '../src/types.ts'

const digest = 'a'.repeat(64)

function binding(): ExpertBindingEventData {
  return {
    version: 1,
    eventId: ExpertRuntimeEventId('event-one'),
    runId: TeamRunId('lead-one'),
    memberId: TeamMemberId('member-one'),
    sessionId: SessionId('child-one'),
    attemptId: ProvisionAttemptId('attempt-one'),
    name: 'researcher',
    role: 'Research analyst',
    subagentProvider: 'in-process',
    descriptor: {
      blueprint: { id: ExpertBlueprintId('researcher'), revision: 1 },
      blueprintDigest: digest,
      preset: { id: 'research', contentDigest: digest },
      skills: [{ name: 'search', provider: 'filesystem', source: 'bundled', contentDigest: digest }],
      plugins: ['@plugins/research'],
      digest: ExpertBindingDigest(digest),
      model: { maxTokens: 1_024 },
      compositionDigest: digest,
      execution: { maxTurns: 2, maxTokens: 1_024, deadlineAt: 10_000 },
    },
    initialPrompt: 'Investigate the evidence',
    agentOptions: { maxTokens: 1_024 },
    toolFilter: { allow: ['web_search'] },
  }
}

function event(type: SessionEvent['type'], data: unknown, seq: number): SessionEvent {
  return { type, data, seq } as SessionEvent
}

describe('expert runtime folds', () => {
  it('compares the complete descriptor instead of trusting two equal top-level digests', () => {
    const left = binding()
    const right: ExpertChildDescriptorEventData = {
      version: 1,
      eventId: ExpertRuntimeEventId('event-two'),
      runId: left.runId,
      memberId: left.memberId,
      sessionId: left.sessionId,
      attemptId: left.attemptId,
      descriptor: structuredClone(left.descriptor),
    }
    expect(sameExpertDescriptor(left, right)).toBe(true)
    const drifted = {
      ...right,
      descriptor: { ...right.descriptor, plugins: ['@plugins/different'] },
    }
    expect(sameExpertDescriptor(left, drifted)).toBe(false)
  })

  it('counts only own turns after the descriptor and detects the exact retained initial prompt', () => {
    const value = binding()
    const childDescriptor: ExpertChildDescriptorEventData = {
      version: 1,
      eventId: ExpertRuntimeEventId('event-child'),
      runId: value.runId,
      memberId: value.memberId,
      sessionId: value.sessionId,
      attemptId: value.attemptId,
      descriptor: value.descriptor,
    }
    const events = [
      event('turn/start', { turn: 8 }, 0),
      event('collaboration/expert/descriptor', childDescriptor, 1),
      event('turn/start', { turn: 9 }, 2),
      event('user/message', {
        id: 'message-one',
        role: 'user',
        content: [{ type: 'text', text: value.initialPrompt }],
        source: { kind: 'user' },
      }, 3),
      event('turn/start', { turn: 10 }, 4),
    ]
    const session = {
      header: { seedLength: 1 },
      events,
    }
    expect(countExpertTurns(session as never)).toBe(2)
    expect(hasExpertInitialPrompt(session as never, value.initialPrompt)).toBe(true)
    expect(hasExpertInitialPrompt(session as never, 'different prompt')).toBe(false)
  })
})
