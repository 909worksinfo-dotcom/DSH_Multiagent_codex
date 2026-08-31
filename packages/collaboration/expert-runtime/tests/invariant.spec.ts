import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CollaborationEventId,
  ProvisionAttemptId,
  TeamMemberId,
  TeamRunId,
} from '@deepseek-ai/dsh-agent-team'
import { ExpertBindingDigest, ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as ExpertRuntimeInvariant from '../src/invariant.ts'
import { ExpertRuntimeEventId } from '../src/ids.ts'
import type { ExpertBindingEventData, ExpertChildDescriptorEventData } from '../src/types.ts'

const digest = 'b'.repeat(64)

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(ExpertRuntimeInvariant)
  const lead = ctx.sessions.create(SessionId(`lead-${crypto.randomUUID()}`))
  const runId = TeamRunId(lead.id)
  const memberId = TeamMemberId('member-researcher')
  const sessionId = SessionId('child-researcher')
  const attemptId = ProvisionAttemptId('attempt-researcher')
  lead.append('collaboration/run/created', {
    version: 1,
    runId,
    eventId: CollaborationEventId('team-event-created'),
    revision: 1,
    leadId: lead.id,
    objective: 'Research the requested market',
    complexity: 'simple',
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
  })
  lead.append('collaboration/run/phase', {
    version: 1,
    runId,
    eventId: CollaborationEventId('team-event-planning'),
    revision: 2,
    phase: 'planning',
  })
  lead.append('collaboration/run/phase', {
    version: 1,
    runId,
    eventId: CollaborationEventId('team-event-provisioning'),
    revision: 3,
    phase: 'provisioning',
  })
  lead.append('collaboration/member', {
    version: 1,
    runId,
    eventId: CollaborationEventId('team-event-member'),
    revision: 4,
    member: {
      id: memberId,
      sessionId,
      name: 'researcher',
      role: 'Research analyst',
      attemptId,
      attemptNumber: 1,
      phase: 'provisioning',
    },
  })
  const binding: ExpertBindingEventData = {
    version: 1,
    eventId: ExpertRuntimeEventId('expert-event-binding'),
    runId,
    memberId,
    sessionId,
    attemptId,
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
      model: { maxTokens: 2_048 },
      compositionDigest: digest,
      execution: { maxTurns: 3, maxTokens: 2_048, deadlineAt: Date.now() + 60_000 },
    },
    initialPrompt: 'Investigate the market',
    agentOptions: { maxTokens: 2_048 },
    toolFilter: { allow: ['web_search'] },
  }
  return { ctx, lead, binding }
}

describe('expert runtime stream invariant', () => {
  it('accepts a binding and exact child descriptor with complete P1/parent relations', async () => {
    const { ctx, lead, binding } = await setup()
    expect(() => lead.append('collaboration/expert/binding', binding)).not.toThrow()
    const child = ctx.sessions.create(binding.sessionId, { meta: { parentSession: lead.id, seedLength: 0, origin: 'subagent' } })
    const descriptor: ExpertChildDescriptorEventData = {
      version: 1,
      eventId: ExpertRuntimeEventId('expert-event-child'),
      runId: binding.runId,
      memberId: binding.memberId,
      sessionId: binding.sessionId,
      attemptId: binding.attemptId,
      descriptor: binding.descriptor,
    }
    expect(() => child.append('collaboration/expert/descriptor', descriptor)).not.toThrow()
  })

  it('rejects a Lead binding whose public identity differs from its P1 roster row', async () => {
    const { lead, binding } = await setup()
    expect(() => lead.append('collaboration/expert/binding', { ...binding, role: 'Different role' }))
      .toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-expert-runtime',
      }))
    expect(lead.events.some(event => event.type === 'collaboration/expert/binding')).toBe(false)
  })

  it('rejects child content that keeps the old digest but changes one mounted plugin', async () => {
    const { ctx, lead, binding } = await setup()
    lead.append('collaboration/expert/binding', binding)
    const child = ctx.sessions.create(binding.sessionId, { meta: { parentSession: lead.id, seedLength: 0, origin: 'subagent' } })
    expect(() => child.append('collaboration/expert/descriptor', {
      version: 1,
      eventId: ExpertRuntimeEventId('expert-event-tampered'),
      runId: binding.runId,
      memberId: binding.memberId,
      sessionId: binding.sessionId,
      attemptId: binding.attemptId,
      descriptor: { ...binding.descriptor, plugins: ['@plugins/tampered'] },
    })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-expert-runtime',
    }))
    expect(child.events).toEqual([])
  })
})
