/** Cold collaboration discovery across fresh Host contexts and durable event-catalog refusals. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import {
  ProvisionAttemptId,
  TeamMemberId,
  TeamQualityGateId,
  TeamRunId,
  type TeamRunSnapshot,
} from '@deepseek-ai/dsh-agent-team'
import {
  ExpertBlueprintId,
  type ExpertBlueprint,
} from '@deepseek-ai/dsh-expert-catalog'
import SessionStore, {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistenceRevision,
  type PersistenceBackend,
} from '@deepseek-ai/dsh-session-persistence'
import {
  TeamOrchestrationEventId,
  TeamOrchestrationRequestId,
  TeamPlanSlotId,
  type TaskProfile,
  type TeamCharter,
  type TeamOrchestrationSnapshot,
  type TeamPlan,
  type TeamWorkstream,
} from '@deepseek-ai/dsh-team-orchestrator'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'

const contexts = new Set<Context>()
let nextRpc = 0

afterEach(async () => {
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }
})

function request<P>(payload: P): RpcRequest<P> {
  nextRpc += 1
  return { rpcId: RpcId(`collaboration-cold-${String(nextRpc)}`), payload }
}

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1_000, cwd: '/project' }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function jsonlMemoryBackend(): PersistenceBackend<never> {
  let storedMeta: string | undefined
  const storedEventLines: string[] = []
  let storedRevision: SessionPersistenceRevision | undefined
  let revision = 0
  const nextRevision = (): SessionPersistenceRevision => {
    revision += 1
    return SessionPersistenceRevision(`collaboration-cold:${String(revision)}`)
  }
  return {
    name: 'collaboration-cold-jsonl-memory',
    loadStored: (id) => {
      if (storedMeta === undefined || storedRevision === undefined) return Promise.resolve(undefined)
      const meta = parseJson(storedMeta) as SessionHeader
      if (meta.id !== id) return Promise.resolve(undefined)
      return Promise.resolve({
        meta,
        events: storedEventLines.map(line => parseJson(line) as SessionEvent),
        revision: storedRevision,
      })
    },
    readStoredRevision: (id) => {
      if (storedMeta === undefined) return Promise.resolve(undefined)
      return Promise.resolve((parseJson(storedMeta) as SessionHeader).id === id ? storedRevision : undefined)
    },
    appendBatch: (meta, events) => {
      storedMeta = JSON.stringify(meta)
      storedEventLines.push(...events.map(event => JSON.stringify(event)))
      storedRevision = nextRevision()
      return Promise.resolve()
    },
    commitRepair: () => Promise.resolve(),
    list: () => Promise.resolve(storedMeta === undefined ? [] : [parseJson(storedMeta) as SessionHeader]),
  }
}

function collaborationFixture(id: SessionId): {
  readonly blueprint: ExpertBlueprint
  readonly events: SessionEvent[]
  readonly snapshot: TeamOrchestrationSnapshot
} {
  const runId = TeamRunId(id)
  const requestId = TeamOrchestrationRequestId('restart-request')
  const slotId = TeamPlanSlotId('researcher-slot')
  const blueprint: ExpertBlueprint = {
    ref: { id: ExpertBlueprintId('researcher'), revision: 1 },
    role: 'Research expert',
    objective: 'Summarize the evidence',
    preset: 'standard',
    skills: ['research-analysis'],
    plugins: ['local-search'],
    tools: {},
    model: {},
    inputs: [],
    outputs: [],
    acceptanceCriteria: ['Return a reviewable summary'],
    collaboration: { challenge: true, review: true, requestHelp: true },
    budget: { maxTurns: 2, maxTokens: 1_024, timeoutMs: 60_000 },
  }
  const workstream: TeamWorkstream = {
    id: 'summary',
    subject: 'Summary',
    description: 'Summarize the evidence',
    blockedBy: [],
    requiredCapabilities: ['research'],
    resourceScopes: [],
  }
  const profile: TaskProfile = {
    domain: 'research_analysis',
    objective: 'Summarize the evidence',
    successCriteria: ['Return a reviewable summary'],
    workstreams: [workstream],
    riskSignals: [],
    context: { productTitle: 'Restart-safe research', productLanguage: 'en' },
    complexity: 'simple',
    plannedExperts: 1,
    metrics: {
      workstreamCount: 1,
      dependencyCount: 0,
      independentWorkstreams: 1,
      longestDependencyPath: 1,
      capabilityCount: 1,
      riskSignalCount: 0,
      decomposable: false,
      toolDensity: 'low',
      risk: 'low',
    },
  }
  const plan: TeamPlan = {
    topology: 'producer_reviewer',
    roster: [{
      slotId,
      name: 'researcher-1',
      role: blueprint.role,
      blueprint: blueprint.ref,
      assignment: { objective: profile.objective, inputs: {} },
      acceptanceCriteria: [...blueprint.acceptanceCriteria],
      budget: blueprint.budget,
    }],
    taskDag: [workstream],
  }
  const charter: TeamCharter = {
    objective: profile.objective,
    successCriteria: [...profile.successCriteria],
    topology: plan.topology,
    roster: plan.roster.map(value => ({
      slotId: value.slotId,
      name: value.name,
      role: value.role,
      blueprint: value.blueprint,
    })),
    taskDag: [...plan.taskDag],
    communication: { maxChallengeRounds: 1, maxMessagesPerExpert: 4 },
    qualityChecks: ['Lead reviews the expert result'],
    budgets: [{ slotId, execution: blueprint.budget }],
    termination: {
      success: 'all_tasks_completed_and_reviewed',
      formationFailure: 'fail_closed',
    },
  }
  const run: TeamRunSnapshot = {
    id: runId,
    revision: 5,
    cursor: 2,
    lead: { role: 'lead', sessionId: id, name: 'lead' },
    objective: profile.objective,
    complexity: 'simple',
    plannedExperts: 1,
    policy: {
      maxActiveExperts: 8,
      maxProvisionAttempts: 16,
      maxTasks: 64,
      maxPublicMessages: 1_000,
      maxPublicMessageBytes: 16_384,
      maxArtifacts: 16,
      maxArtifactBodyBytes: 65_536,
      taskStallCursorThreshold: 10,
    },
    phase: 'active',
    status: 'running',
    members: [{
      id: TeamMemberId('researcher-member'),
      sessionId: SessionId('researcher-child'),
      name: 'researcher-1',
      role: blueprint.role,
      attemptId: ProvisionAttemptId('researcher-attempt'),
      attemptNumber: 1,
      phase: 'active',
    }],
    tasks: [],
    messages: [],
    protocol: { mode: 'legacy', topology: null, limits: null, members: [], challenges: [] },
    artifacts: [],
    decisions: [],
    qualityGates: [{
      id: TeamQualityGateId('quality-gate-1'),
      version: 1,
      name: 'Lead reviews the expert result',
      status: 'pending',
      summary: '',
      updatedAt: 1_025,
    }],
    controller: {
      health: 'healthy',
      lastProgressAt: 1_025,
      stalledTaskIds: [],
      duplicateWorkCount: 0,
      qualityFailureCount: 0,
      recommendedActions: [],
      actionsTaken: [],
    },
    expertCounts: {
      planned: 1,
      provisioning: 0,
      active: 1,
      failed: 0,
      attempts: 1,
      availableSlots: 7,
    },
  }
  const snapshot: TeamOrchestrationSnapshot = {
    requestId,
    createdAt: 1_010,
    run,
    profile,
    plan,
    charter,
  }
  const events = [
    {
      type: 'collaboration/orchestration/profile',
      seq: 0,
      time: 1_010,
      data: {
        version: 1,
        eventId: TeamOrchestrationEventId('profile-event'),
        runId,
        requestId,
        requestDigest: 'request-digest',
        revision: 1,
        profile,
      },
    },
    {
      type: 'collaboration/orchestration/plan',
      seq: 1,
      time: 1_020,
      data: {
        version: 1,
        eventId: TeamOrchestrationEventId('plan-event'),
        runId,
        requestId,
        requestDigest: 'request-digest',
        revision: 2,
        planDigest: 'plan-digest',
        plan,
      },
    },
    {
      type: 'collaboration/orchestration/charter',
      seq: 2,
      time: 1_030,
      data: {
        version: 1,
        eventId: TeamOrchestrationEventId('charter-event'),
        runId,
        requestId,
        requestDigest: 'request-digest',
        revision: 3,
        planDigest: 'plan-digest',
        charterDigest: 'charter-digest',
        charter,
      },
    },
  ] satisfies SessionEvent[]
  return { blueprint, events, snapshot }
}

describe('collaboration cold restart', () => {
  it('discovers a JSONL-serialized TeamRun from a fresh Context without dropping collaboration events', async () => {
    const backend = jsonlMemoryBackend()
    const id = SessionId('collaboration-restart')
    const fixture = collaborationFixture(id)

    const first = new Context()
    contexts.add(first)
    await first.plugin(SessionStore)
    const writer = new PersistenceCoordinator(first, backend)
    await writer.create(header(id))
    await writer.append(id, fixture.events)
    await first.fiber.dispose()
    contexts.delete(first)

    const restarted = new Context()
    contexts.add(restarted)
    await restarted.plugin(SessionStore)
    await restarted.plugin(AgentRegistry)
    await restarted.plugin(UserQuestionService)
    const reader = new PersistenceCoordinator(restarted, backend)
    restarted.provide('sessionPersistence', {
      list: (signal?: AbortSignal) => backend.list(signal),
      inspect: (sessionId: SessionId, signal?: AbortSignal) => reader.inspect(sessionId, signal),
      readFrom: (sessionId: SessionId, fromSeq: number, signal?: AbortSignal) => reader.readFrom(sessionId, fromSeq, signal),
      locate: () => undefined,
    } as never)
    restarted.provide('teamOrchestrator', {
      list: () => [],
      get: () => fixture.snapshot,
    } as never)
    restarted.provide('expertCatalog', {
      get: () => fixture.blueprint,
    } as never)

    const inspected = await reader.inspect(id)
    const resumedSession = {
      id,
      header: inspected.meta,
      events: [...inspected.events],
    } as unknown as Session
    const resumedAgent = {
      id,
      session: resumedSession,
      status: 'idle',
      ctx: restarted,
    } as Agent
    const resume = vi.spyOn(restarted.agents, 'resume').mockImplementation(() => {
      // Real AgentRegistry.resume publishes the resumed Agent before resolving. Preserve that
      // contract so a following collaboration RPC reuses the same live Lead.
      restarted.agents.register(resumedAgent)
      return Promise.resolve({
        agent: resumedAgent,
        dispose: () => Promise.resolve(),
      })
    })
    const api = createApiProxy(restarted, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/project',
    })

    const response = await api.collaboration.list(request({}))

    expect(response.result).toMatchObject({
      ok: true,
      value: {
        runs: [{
          id,
          title: 'Restart-safe research',
          phase: 'active',
          cursor: 2,
          expertCounts: { planned: 1, active: 1 },
          tasks: [],
          artifacts: [],
          decisions: [],
          qualityGates: [{ id: 'quality-gate-1', status: 'pending' }],
          controller: { health: 'healthy', stalledTaskIds: [] },
          protocol: { mode: 'legacy', topology: null, limits: null, members: [], challenges: [] },
          progress: {
            total: 0, ready: 0, inProgress: 0, completed: 0, blocked: 0, messageCount: 0,
            artifactCount: 0, decisionCount: 0, qualityGatePending: 1, qualityGatePassed: 0, qualityGateFailed: 0,
          },
        }],
      },
    })
    const events = await api.collaboration.events(request({ runId: id, afterCursor: 2, limit: 1 }))
    expect(events.result).toEqual({
      ok: true,
      value: { events: [], hasMore: false, nextCursor: 2 },
    })
    expect(inspected.events.map(event => event.type)).toEqual([
      'collaboration/orchestration/profile',
      'collaboration/orchestration/plan',
      'collaboration/orchestration/charter',
    ])
    expect(resume).toHaveBeenCalledOnce()
  })

  it('surfaces an incompatible collaboration log instead of returning an empty list', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const id = SessionId('collaboration-incompatible')
    const meta = header(id)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.reject(new SessionFormatUnsupportedError('unsupported TeamRun log')),
      locate: () => undefined,
    } as never)
    ctx.provide('teamOrchestrator', { list: () => [] } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/project',
    })

    const response = await api.collaboration.list(request({}))

    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'The collaboration service encountered an internal error.',
        details: {},
      },
    })
  })
})
