import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CollaborationEventId,
  TeamRunId,
} from '@deepseek-ai/dsh-agent-team'
import { ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { digestJson } from '../src/digest.ts'
import { foldTeamOrchestration } from '../src/fold.ts'
import * as TeamOrchestratorInvariant from '../src/invariant.ts'
import {
  TeamOrchestrationEventId,
  TeamOrchestrationRequestId,
  TeamPlanSlotId,
} from '../src/ids.ts'
import type { TaskProfile, TeamPlan, TeamProfileEventData } from '../src/types.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }
})

function profile(): TaskProfile {
  return {
    domain: 'research_analysis',
    objective: 'Summarize the evidence',
    successCriteria: ['Return a reviewed summary'],
    workstreams: [{
      id: 'primary-delivery',
      subject: 'Deliver the task',
      description: 'Summarize the evidence',
      blockedBy: [],
      requiredCapabilities: [],
      resourceScopes: [],
    }],
    riskSignals: [],
    context: {},
    complexity: 'simple',
    plannedExperts: 1,
    metrics: {
      workstreamCount: 1,
      dependencyCount: 0,
      independentWorkstreams: 1,
      longestDependencyPath: 1,
      capabilityCount: 0,
      riskSignalCount: 0,
      decomposable: false,
      toolDensity: 'low',
      risk: 'low',
    },
  }
}

function profileData(runId: ReturnType<typeof TeamRunId>): TeamProfileEventData {
  const value = profile()
  const requestId = TeamOrchestrationRequestId('request-one')
  return {
    version: 1,
    eventId: TeamOrchestrationEventId('profile-event'),
    runId,
    requestId,
    requestDigest: digestJson({ requestId, retryOf: null, profile: value }),
    revision: 1,
    profile: value,
  }
}

describe('TeamOrchestrator replay and invariant companion', () => {
  it('rejects a plan whose retained complete value does not match its digest', () => {
    const runId = TeamRunId('lead-fold')
    const first = {
      type: 'collaboration/orchestration/profile',
      data: profileData(runId),
      seq: 0,
      time: 123,
    } as SessionEvent
    const plan: TeamPlan = {
      topology: 'producer_reviewer',
      roster: [{
        slotId: TeamPlanSlotId('slot-1'),
        name: 'expert-1',
        role: 'Research expert',
        blueprint: { id: ExpertBlueprintId('researcher'), revision: 1 },
        assignment: { objective: 'Summarize the evidence', inputs: { question: 'Summarize the evidence' } },
        acceptanceCriteria: ['Return a reviewed summary'],
        budget: { maxTurns: 2, maxTokens: 1_024, timeoutMs: 60_000 },
      }],
      taskDag: profile().workstreams.map(task => ({ ...task, assigneeSlotId: TeamPlanSlotId('slot-1') })),
      stages: [{ id: 'stage-1', order: 1, mode: 'serial', workstreamIds: ['primary-delivery'] }],
    }
    const valid = {
      type: 'collaboration/orchestration/plan',
      data: {
        version: 1,
        eventId: TeamOrchestrationEventId('plan-event'),
        runId,
        requestId: TeamOrchestrationRequestId('request-one'),
        requestDigest: profileData(runId).requestDigest,
        revision: 2,
        planDigest: digestJson(plan),
        plan,
      },
      seq: 1,
      time: 124,
    } as SessionEvent
    expect(foldTeamOrchestration(runId, [first, valid])).toMatchObject({ createdAt: 123 })
    const tampered = { ...valid, data: { ...valid.data, planDigest: 'b'.repeat(64) } } as SessionEvent
    expect(() => foldTeamOrchestration(runId, [first, tampered])).toThrow('plan digest')
  })

  it('rejects a profile that does not match its existing P1 TeamRun', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(TeamOrchestratorInvariant)
    const lead = ctx.sessions.create(SessionId('lead-invariant'))
    const runId = TeamRunId(lead.id)
    lead.append('collaboration/run/created', {
      version: 1,
      runId,
      eventId: CollaborationEventId('p1-created'),
      revision: 1,
      leadId: lead.id,
      objective: 'Different objective',
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
    expect(() => lead.append('collaboration/orchestration/profile', profileData(runId)))
      .toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-team-orchestrator',
      }))
    expect(lead.events.some(event => event.type === 'collaboration/orchestration/profile')).toBe(false)
  })
})
