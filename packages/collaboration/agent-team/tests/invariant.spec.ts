import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as TeamRunInvariant from '../src/invariant.ts'
import { CollaborationEventId, TeamRunId } from '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TeamRunInvariant)
  return ctx
}

function created(sessionId: SessionId) {
  return {
    version: 1 as const,
    runId: TeamRunId(sessionId),
    eventId: CollaborationEventId(`event-${sessionId}`),
    revision: 1 as const,
    leadId: sessionId,
    objective: 'Invariant test task',
    complexity: 'simple' as const,
    plannedExperts: 1,
    policy: {
      maxActiveExperts: 8,
      maxProvisionAttempts: 12,
      maxTasks: 16,
      maxPublicMessages: 16,
      maxPublicMessageBytes: 1_024,
      maxArtifacts: 16,
      maxArtifactBodyBytes: 4_096,
      taskStallCursorThreshold: 10,
    },
  }
}

describe('TeamRun stream invariant', () => {
  it('accepts a valid creation and rejects an invalid complexity plan before publication', async () => {
    const ctx = await setup()
    const valid = ctx.sessions.create(SessionId('valid-team-run'))
    expect(() => {
      valid.append('collaboration/run/created', created(valid.id))
    }).not.toThrow()

    const invalid = ctx.sessions.create(SessionId('invalid-team-run'))
    expect(() => {
      invalid.append('collaboration/run/created', {
        ...created(invalid.id),
        plannedExperts: 2,
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-agent-team',
    }))
    expect(invalid.events).toEqual([])
  })

  it('rejects a newly appended event owned by another Lead Session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('owner-team-run'))
    expect(() => {
      session.append('collaboration/run/created', {
        ...created(session.id),
        runId: TeamRunId('different-run'),
        leadId: SessionId('different-run'),
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-agent-team',
    }))
    expect(session.events).toEqual([])
  })
})
