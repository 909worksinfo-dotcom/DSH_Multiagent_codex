import { Context } from '@deepseek-ai/cordis'
import type { CollaborationPublicEventView, CollaborationRunView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import { CollaborationRuntime } from '../src/client/collaboration/service.ts'
import type { ISessions } from '../src/client/contract/sessions.ts'
import { err, FakeApiClient, ok } from './fake-api.client.ts'

function wireRun(
  id: SessionId,
  requestId: string,
  overrides: Partial<CollaborationRunView> = {},
): CollaborationRunView {
  return {
    id,
    requestId,
    title: '验证协作组队',
    objective: '分析需求并完成开发和测试',
    language: 'zh',
    createdAt: 1_000,
    cursor: 0,
    status: 'running',
    phase: 'active',
    profile: {
      domain: 'software_development',
      objective: '分析需求并完成开发和测试',
      successCriteria: ['通过验收'],
      workstreams: [{
        id: 'analysis', subject: '分析', description: '分析需求', blockedBy: [],
        requiredCapabilities: ['analysis'], resourceScopes: [],
      }, {
        id: 'implementation', subject: '开发', description: '完成开发', blockedBy: ['analysis'],
        requiredCapabilities: ['implementation'], resourceScopes: ['src/'],
      }],
      riskSignals: [],
      complexity: 'medium',
      plannedExperts: 2,
      metrics: {
        workstreamCount: 2, dependencyCount: 1, independentWorkstreams: 1,
        longestDependencyPath: 2, capabilityCount: 2, riskSignalCount: 0,
        decomposable: true, toolDensity: 'low', risk: 'low',
      },
    },
    charter: {
      objective: '分析需求并完成开发和测试',
      successCriteria: ['通过验收'],
      topology: 'centralized',
      taskDag: [{
        id: 'analysis', subject: '分析', description: '分析需求', blockedBy: [],
        requiredCapabilities: ['analysis'], resourceScopes: [],
      }],
      communication: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 },
      qualityChecks: ['通过验收'],
      budgets: [
        { slotId: 'slot-1', maxTurns: 8, maxTokens: 4_096, timeoutMs: 60_000 },
        { slotId: 'slot-2', maxTurns: 8, maxTokens: 4_096, timeoutMs: 60_000 },
      ],
      termination: { success: 'all_tasks_completed_and_reviewed', formationFailure: 'fail_closed' },
    },
    lead: { sessionId: id, name: 'lead', role: 'Lead Agent' },
    experts: [{
      id: 'member-1', sessionId: 'expert-1' as SessionId, name: 'expert-1', role: 'Implementation Engineer', phase: 'active',
      binding: {
        blueprint: { id: 'software-implementation', revision: 1 },
        preset: { id: 'standard', label: 'standard' },
        skills: [{ id: 'collaboration-software-development', label: 'collaboration-software-development' }],
        marketplaceProviders: [
          { source: 'smithery', state: 'authorization_required' },
          { source: 'composio', state: 'authorization_required' },
          { source: 'skills_sh', state: 'ready' },
        ],
        marketplaceSkills: [{
          id: 'skills.sh:anthropics/skills/frontend-design', label: 'frontend-design',
          source: 'skills_sh', kind: 'method_skill', status: 'loaded',
        }],
        plugins: [{ id: '@deepseek-ai/dsh-tool-fs', label: '@deepseek-ai/dsh-tool-fs' }],
      },
    }],
    tasks: [{
      id: 'task-1', revision: 1, subject: '分析', description: '分析需求', status: 'in_progress',
      owner: { role: 'expert', memberId: 'member-1', sessionId: 'expert-1' as SessionId, name: 'expert-1' },
      blockedBy: [], resourceScopes: [], ready: true, resourceConflicts: [],
    }, {
      id: 'task-2', revision: 1, subject: '开发', description: '完成开发', status: 'pending',
      owner: null, blockedBy: ['task-1'], resourceScopes: ['src/'], ready: false, resourceConflicts: [],
    }],
    artifacts: [{
      id: 'artifact-1',
      version: 2,
      kind: 'product_spec',
      title: '验收规格',
      status: 'review',
      author: { role: 'expert', memberId: 'member-1', sessionId: 'expert-1' as SessionId, name: 'expert-1' },
      taskIds: ['task-1'],
      mediaType: 'text/markdown',
      updatedAt: 1_010,
    }],
    decisions: [{
      id: 'decision-1',
      version: 1,
      subject: '采纳规格',
      outcome: 'accepted',
      summary: '进入交付',
      rationale: '证据已完整',
      taskIds: ['task-1'],
      artifactIds: ['artifact-1'],
      lead: { role: 'lead', sessionId: id, name: 'lead' },
      createdAt: 1_011,
    }],
    qualityGates: [{
      id: 'quality-1',
      version: 2,
      name: '通过验收',
      status: 'passed',
      reviewer: { role: 'lead', sessionId: id, name: 'lead' },
      taskId: 'task-1',
      artifactId: 'artifact-1',
      summary: '验收通过',
      updatedAt: 1_012,
    }],
    controller: {
      health: 'attention',
      lastProgressAt: 1_012,
      stalledTaskIds: ['task-2'],
      duplicateWorkCount: 0,
      qualityFailureCount: 0,
      recommendedActions: ['reassign'],
      actionsTaken: [],
    },
    protocol: {
      mode: 'enforced',
      topology: 'centralized',
      limits: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 },
      members: [{
        slotId: 'slot-1',
        memberId: 'member-1',
        name: 'expert-1',
        phase: 'active',
        permissions: { challenge: true, review: true, requestHelp: true },
        allowedTargets: ['lead'],
        usedMessages: 3,
        remainingMessages: 5,
      }],
      challenges: [{
        challengeId: 'challenge-1',
        threadId: 'challenge-thread-1',
        round: 1,
        challenger: 'member-1',
        target: 'lead',
        status: 'responded',
        challengeMessageId: 'message-challenge-1',
        responseMessageId: 'message-response-1',
      }],
    },
    progress: {
      total: 2,
      ready: 0,
      inProgress: 1,
      completed: 0,
      blocked: 1,
      messageCount: 0,
      artifactCount: 1,
      decisionCount: 1,
      qualityGatePending: 0,
      qualityGatePassed: 1,
      qualityGateFailed: 0,
    },
    expertCounts: { planned: 2, provisioning: 0, active: 1, failed: 0, attempts: 1, availableSlots: 7 },
    ...overrides,
  }
}

function wireEvent(cursor: number, kind: CollaborationPublicEventView['kind'], content: string): CollaborationPublicEventView {
  return {
    id: `message-${String(cursor)}`,
    eventId: `event-${String(cursor)}`,
    cursor,
    threadId: 'main',
    kind,
    author: { role: 'lead', sessionId: 'lead-recovered' as SessionId, name: 'lead' },
    targets: [],
    references: kind === 'decision' ? { taskId: 'task-1', decisionId: 'decision-1' } : { taskId: 'task-1' },
    content,
    createdAt: 1_000 + cursor,
    visibility: 'public',
  }
}

function harness(): {
  ctx: Context
  api: FakeApiClient
  sessions: ISessions
  runtime: CollaborationRuntime
  create: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  const api = new FakeApiClient()
  const create = vi.fn(async (options?: { sessionId?: SessionId }) => {
    if (options?.sessionId === undefined) throw new Error('collaboration Lead must be preallocated')
    return options.sessionId
  })
  const prompt = vi.fn(async (): Promise<
    | { readonly ok: true; readonly value: { readonly accepted: true } }
    | { readonly ok: false; readonly error: { readonly code: 'internal'; readonly message: string; readonly details: Record<string, never> } }
  > => ({ ok: true, value: { accepted: true } }))
  const sessions = {
    create,
    binding: (id: SessionId) => ({ session: { sessionId: id, prompt } }),
  } as unknown as ISessions
  const runtime = new CollaborationRuntime(ctx, api, sessions)
  return { ctx, api, sessions, runtime, create, prompt }
}

describe('CollaborationRuntime', () => {
  it('recovers the authoritative catalog and projects only UI business fields', async () => {
    const { api, runtime } = harness()
    const run = wireRun('lead-recovered' as SessionId, 'request-recovered')
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [run] }))

    await runtime.refresh()

    const snapshot = runtime.source.getSnapshot()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.runs[0]).toMatchObject({
      id: 'lead-recovered',
      profile: { complexity: 'medium', sequentialDependencies: true },
      charter: { topology: 'centralized', budget: { maxExperts: 2, maxTokens: 8_192 } },
      tasks: [
        { id: 'task-1', status: 'in_progress', owner: { role: 'expert', name: 'expert-1' } },
        { id: 'task-2', status: 'pending', ready: false },
      ],
      artifacts: [{ id: 'artifact-1', version: 2, author: { role: 'expert', name: 'expert-1' } }],
      decisions: [{ id: 'decision-1', outcome: 'accepted', lead: { role: 'lead', name: 'lead' } }],
      qualityGates: [{ id: 'quality-1', status: 'passed', reviewer: { role: 'lead', name: 'lead' } }],
      controller: { health: 'attention', stalledTaskIds: ['task-2'], recommendedActions: ['reassign'] },
      protocol: {
        mode: 'enforced',
        topology: 'centralized',
        limits: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 },
        members: [{ name: 'expert-1', usedMessages: 3, remainingMessages: 5, allowedTargets: ['lead'] }],
        challenges: [{ challengeId: 'challenge-1', status: 'responded', round: 1 }],
      },
      progress: { total: 2, inProgress: 1, blocked: 1, messageCount: 0 },
      timeline: [],
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/digest|persona|path/i)
  })

  it('preserves an explicit legacy protocol without inferring policy from the charter', async () => {
    const { api, runtime } = harness()
    const run = wireRun('lead-legacy' as SessionId, 'request-legacy', {
      protocol: { mode: 'legacy', topology: null, limits: null, members: [], challenges: [] },
    })
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [run] }))

    await runtime.refresh()

    expect(runtime.source.getSnapshot().runs[0]?.protocol).toEqual({
      mode: 'legacy', topology: null, limits: null, members: [], challenges: [],
    })
    expect(run.charter?.topology).toBe('centralized')
  })

  it('hydrates every exclusive-cursor public page and advances across non-message run events', async () => {
    const { api, runtime } = harness()
    const run = wireRun('lead-recovered' as SessionId, 'request-recovered', {
      cursor: 9,
      progress: {
        total: 2,
        ready: 0,
        inProgress: 1,
        completed: 0,
        blocked: 1,
        messageCount: 2,
        artifactCount: 1,
        decisionCount: 1,
        qualityGatePending: 0,
        qualityGatePassed: 1,
        qualityGateFailed: 0,
      },
    })
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [run] }))
    api.onCollaborationEvents = (payload) => {
      if ((payload.afterCursor ?? -1) < 2) {
        return Promise.resolve(ok({
          events: [wireEvent(2, 'proposal', '公开方案')],
          hasMore: true,
          nextCursor: 2,
        }))
      }
      return Promise.resolve(ok({
        events: [wireEvent(7, 'decision', 'Lead 公开裁决')],
        hasMore: false,
        nextCursor: 9,
      }))
    }

    await runtime.refresh()

    expect(api.callsOf('collaboration.events')).toEqual([
      { runId: 'lead-recovered', afterCursor: -1, limit: 100 },
      { runId: 'lead-recovered', afterCursor: 2, limit: 100 },
    ])
    expect(runtime.source.getSnapshot().runs[0]?.timeline).toEqual([
      expect.objectContaining({ cursor: 2, kind: 'proposal', content: '公开方案' }),
      expect.objectContaining({ cursor: 7, kind: 'decision', references: { taskId: 'task-1', decisionId: 'decision-1' } }),
    ])
  })

  it('keeps the last authoritative catalog visible when a background refresh is invalid', async () => {
    const { api, runtime } = harness()
    const retained = wireRun('lead-retained' as SessionId, 'request-retained')
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [retained] }))
    await runtime.refresh()

    const advanced = wireRun('lead-retained' as SessionId, 'request-retained', { cursor: 2 })
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [advanced] }))
    api.onCollaborationEvents = () => Promise.resolve(ok({ events: [], hasMore: true, nextCursor: 0 }))

    const retainedSnapshot = runtime.source.getSnapshot()
    await runtime.refresh()

    expect(runtime.source.getSnapshot()).toBe(retainedSnapshot)
    expect(runtime.source.getSnapshot()).toMatchObject({ state: 'ready', runs: [{ id: 'lead-retained', cursor: 0 }] })
  })

  it('does not notify observers when a polling result is unchanged', async () => {
    const { api, runtime } = harness()
    const run = wireRun('lead-stable' as SessionId, 'request-stable')
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [run] }))
    await runtime.refresh()
    const retainedSnapshot = runtime.source.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = runtime.source.subscribe(listener)

    await runtime.refresh()

    expect(runtime.source.getSnapshot()).toBe(retainedSnapshot)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('creates a fresh Lead before calling automatic formation', async () => {
    const { api, runtime, create, prompt } = harness()
    api.onCollaborationCreate = payload => Promise.resolve(ok(wireRun(payload.leadSessionId, payload.requestId)))

    const id = await runtime.createRun({
      title: '验证协作组队', objective: '分析需求并完成开发和测试', language: 'zh',
    })

    expect(create).toHaveBeenCalledWith({ sessionId: id })
    const promptCall = prompt.mock.calls[0] as unknown as [readonly { readonly type: string; readonly text: string }[], string]
    expect(promptCall[1]).toBe('queue')
    expect(promptCall[0][0]?.type).toBe('text')
    const leadPrompt = promptCall[0][0]?.text ?? ''
    expect(leadPrompt).toMatch(/用户任务：\n分析需求并完成开发和测试[\s\S]+collaboration_complete/u)
    expect(leadPrompt).toContain('主协调智能体不自行使用 Bash、联网搜索、技能加载或其他日常会话工具')
    expect(leadPrompt).toContain('称每位专家为任务章程中的完整角色名')
    expect(leadPrompt).toContain('不得使用 expert-N 或“专家N”')
    expect(leadPrompt).toContain('不要重复创建 Team Charter 中已有的任务')
    expect(leadPrompt).toContain('所有公开任务名、观点、质疑、回应、评审、资产、裁决和最终交付都使用简体中文')
    expect(api.calls.map(call => call.method)).toEqual([
      'session.rename',
      'collaboration.create',
      'collaboration.events',
    ])
    expect(runtime.source.getSnapshot().runs[0]).toMatchObject({ id, status: 'running' })
    expect(runtime.source.getSnapshot().runs[0]?.experts[0]?.binding).toMatchObject({
      marketplaceProviders: expect.arrayContaining([{ source: 'smithery', state: 'authorization_required' }]),
      marketplaceSkills: [{ label: 'frontend-design', source: 'skills_sh', status: 'loaded' }],
    })
  })

  it('keeps the local pre-commit placeholder protocol absent instead of labelling it legacy', async () => {
    const { api, runtime } = harness()
    let release = (): void => { throw new Error('collaboration create was not started') }
    api.onCollaborationCreate = payload => new Promise((resolve) => {
      release = () => { resolve(ok(wireRun(payload.leadSessionId, payload.requestId))) }
    })

    const creating = runtime.createRun({
      title: '验证协议占位', objective: '等待 Host 物化权威协作协议', language: 'zh',
    })
    await vi.waitFor(() => {
      expect(runtime.source.getSnapshot().runs[0]).toMatchObject({ status: 'forming' })
    })
    expect(runtime.source.getSnapshot().runs[0]).not.toHaveProperty('protocol')

    release()
    await creating
    expect(runtime.source.getSnapshot().runs[0]?.protocol?.mode).toBe('enforced')
  })

  it.each([
    ['title', { title: '界'.repeat(5_462), objective: '分析需求' }],
    ['objective', { title: '验证协作组队', objective: '界'.repeat(5_462) }],
  ] as const)('rejects an oversized %s before allocating a Lead session', async (_field, request) => {
    const { runtime, create, api } = harness()

    await expect(runtime.createRun({ ...request, language: 'zh' })).rejects.toThrow(/16,384 UTF-8 bytes/)

    expect(create).not.toHaveBeenCalled()
    expect(api.calls).toEqual([])
    expect(runtime.source.getSnapshot().runs).toEqual([])
  })

  it.each([
    ['title', { title: 'a'.repeat(16_384), objective: 'analyze the request' }],
    ['objective', { title: 'validate collaboration', objective: 'a'.repeat(16_384) }],
  ] as const)('accepts a %s at the exact UTF-8 byte limit', async (_field, request) => {
    const { runtime, api, create } = harness()
    api.onCollaborationCreate = payload => Promise.resolve(ok(wireRun(payload.leadSessionId, payload.requestId)))

    await expect(runtime.createRun({ ...request, language: 'en' })).resolves.toMatch(/^collaboration-lead-/u)

    expect(create).toHaveBeenCalledOnce()
    expect(api.calls.map(call => call.method)).toEqual([
      'session.rename', 'collaboration.create', 'collaboration.events',
    ])
  })

  it('archives a blank Lead and stops when its display rename is rejected', async () => {
    const { api, runtime } = harness()
    api.onRename = () => Promise.resolve(err({
      code: 'internal', message: 'session title service is unavailable', details: {},
    }))

    await expect(runtime.createRun({
      title: '验证协作组队', objective: '分析需求', language: 'zh',
    })).rejects.toBeInstanceOf(Error)

    expect(api.calls.map(call => call.method)).toEqual([
      'session.rename',
      'workspace.archiveSession',
    ])
    expect(runtime.source.getSnapshot().runs).toEqual([])
  })

  it('archives an uncommitted Lead when the Host rejects creation', async () => {
    const { api, runtime } = harness()
    api.onCollaborationCreate = () => Promise.resolve(err({
      code: 'collaboration-error',
      message: 'objective must be non-blank and at most 16384 UTF-8 bytes',
      details: { collaborationCode: 'TEAM_INVALID_ARGUMENT', retryable: false },
    }))

    await expect(runtime.createRun({
      title: '验证协作组队', objective: '分析需求', language: 'zh',
    })).rejects.toBeInstanceOf(Error)

    expect(api.calls.map(call => call.method)).toEqual([
      'session.rename',
      'collaboration.create',
      'workspace.archiveSession',
    ])
    expect(runtime.source.getSnapshot()).toMatchObject({
      state: 'error',
      runs: [],
      error: { code: 'collaboration-error', retryable: false },
    })
  })

  it('removes the provisional run when creation loses its transport', async () => {
    const { api, runtime } = harness()
    const failure = new Error('connection reset during collaboration.create')
    api.onCollaborationCreate = () => Promise.reject(failure)

    await expect(runtime.createRun({
      title: '验证协作组队', objective: '分析需求', language: 'zh',
    })).rejects.toBe(failure)

    expect(api.calls.map(call => call.method)).toEqual([
      'session.rename',
      'collaboration.create',
    ])
    expect(runtime.source.getSnapshot()).toMatchObject({
      state: 'error',
      runs: [],
      error: { code: 'transport-error', retryable: true },
    })
  })

  it('retains the committed TeamRun when the Lead prompt is rejected', async () => {
    const { api, runtime, prompt } = harness()
    api.onCollaborationCreate = payload => Promise.resolve(ok(wireRun(payload.leadSessionId, payload.requestId, {
      objective: '必须启动 Lead 执行',
    })))
    prompt.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'Lead prompt admission is unavailable', details: {} },
    })

    await expect(runtime.createRun({
      title: '验证协作启动', objective: '必须启动 Lead 执行', language: 'zh',
    })).rejects.toBeInstanceOf(Error)

    expect(api.callsOf('workspace.archiveSession')).toEqual([])
    expect(runtime.source.getSnapshot()).toMatchObject({
      state: 'ready',
      runs: [{ status: 'running', objective: '必须启动 Lead 执行' }],
    })
  })

  it('retries a failed formation as a new immutable TeamRun and can cancel the replacement', async () => {
    const { api, runtime } = harness()
    const failed = wireRun('lead-failed' as SessionId, 'request-failed', {
      status: 'team_formation_failed',
      phase: 'formation_failed',
      experts: [],
      expertCounts: { planned: 2, provisioning: 0, active: 0, failed: 1, attempts: 1, availableSlots: 8 },
      failure: { code: 'FORMATION_FAILED', message: 'The expert team could not be formed at full strength.', retryable: false, details: {} },
    })
    api.onCollaborationList = () => Promise.resolve(ok({ runs: [failed] }))
    await runtime.refresh()
    let retryPayload: Parameters<typeof api.onCollaborationCreate>[0] | undefined
    api.onCollaborationCreate = (payload) => {
      retryPayload = payload
      return Promise.resolve(ok(wireRun(payload.leadSessionId, payload.requestId, {
        ...(payload.retryOf === undefined ? {} : { retryOf: payload.retryOf }),
      })))
    }
    api.onCollaborationCancel = payload => Promise.resolve(ok(wireRun(
      payload.runId,
      payload.requestId,
      { status: 'cancelled', phase: 'cancelled' },
    )))

    const replacementId = await runtime.retryFormation(failed.id)
    expect(replacementId).not.toBe(failed.id)
    expect(retryPayload?.retryOf).toBe('request-failed')
    expect(runtime.source.getSnapshot().runs.map(run => run.id)).toContain(failed.id)

    await runtime.terminate(replacementId)
    expect(runtime.source.getSnapshot().runs.find(run => run.id === replacementId)?.status).toBe('cancelled')
  })
})
