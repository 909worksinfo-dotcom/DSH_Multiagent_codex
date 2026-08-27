import type {
  CollaborationArtifact, CollaborationCatalogSnapshot, CollaborationController,
  CollaborationDecision, CollaborationExpertMember, CollaborationLanguage,
  CollaborationPort, CollaborationProtocol, CollaborationQualityGate, CollaborationRunSnapshot,
  CollaborationTask, CollaborationTimelineEvent,
  CreateCollaborationRunRequest,
} from './types.ts'

const now = Date.now()

function binding(index: number) {
  return {
    blueprint: { id: `expert.blueprint.${index}`, revision: 1 },
    preset: { id: `expert-preset-${index}`, label: index % 2 === 0 ? '审核模式' : '专业分析' },
    skills: [
      { id: `evidence-${index}`, label: index % 2 === 0 ? '证据审查' : '结构化研究' },
    ],
    marketplaceProviders: [
      { source: 'smithery', state: index === 1 ? 'authorization_required' : 'unavailable' },
      { source: 'composio', state: 'unavailable' },
      { source: 'skills_sh', state: index === 1 ? 'ready' : 'unavailable' },
    ] as const,
    marketplaceSkills: index === 1 ? ([
      { id: 'skills.sh:trusted/research', label: '深度调研方法', source: 'skills_sh', kind: 'method_skill', status: 'loaded' },
      { id: 'smithery:consensus', label: 'Consensus', source: 'smithery', kind: 'remote_tool', status: 'authorization_required' },
    ] as const) : [],
    plugins: [
      { id: `workspace-${index}`, label: index % 2 === 0 ? '代码检索' : '网络检索' },
    ],
  } as const
}

function expert(index: number, phase: CollaborationExpertMember['phase'] = 'active'): CollaborationExpertMember {
  return {
    id: `expert-attempt-${index}`,
    sessionId: phase === 'failed' ? null : `expert-session-${index}`,
    name: ['用户研究专家', '数据分析专家', '系统架构专家', '产品策略专家', '安全评审专家', '工程效率专家', '质量验收专家', '反方评审专家'][index - 1] ?? `专家 ${index}`,
    role: ['用户需求与使用情境', '数据、指标与证据', '边界、依赖与架构', '方案与取舍', '安全、权限与风险', '交付路径与效率', '测试、验收与回归', '对抗式质疑与盲点'][index - 1] ?? '专业分析',
    phase,
    binding: binding(index),
    ...(phase === 'failed' ? {
      failure: { code: 'EXPERT_PROVISION_FAILED', message: '专家会话未能通过安全预检', retryable: true },
    } : {}),
  }
}

function charter(maxExperts: number, topology: 'centralized' | 'grouped') {
  return {
    objective: '给出可验证、可执行且经过反方评审的统一交付',
    successCriteria: ['所有专家范围不重叠', '关键判断都有证据或明确假设', '由 Lead 验收并汇总'],
    topology,
    communicationRules: ['先独立产出观点，再公开质疑', '质疑必须指向具体观点', '分歧由 Lead 记录裁决或保留少数意见'],
    qualityChecks: ['目标覆盖', '证据质量', '逻辑一致性', '风险与可执行性'],
    budget: { maxExperts, maxDiscussionRounds: topology === 'grouped' ? 4 : 2, maxTokens: topology === 'grouped' ? 120_000 : 40_000 },
    terminationPolicy: '达成成功标准后由 Lead 验收；不达标进入返工或终止',
  } as const
}

function profile(complexity: 'simple' | 'medium' | 'complex') {
  return {
    complexity,
    decomposability: complexity === 'simple' ? 'low' : 'high',
    toolDensity: complexity === 'complex' ? 'high' : 'medium',
    risk: complexity === 'complex' ? 'high' : 'medium',
    sequentialDependencies: complexity !== 'simple',
    rationale: complexity === 'simple'
      ? '任务边界清晰，由 Lead 和 3 名专家形成交叉校验'
      : '任务包含多个专业边界，需要并行分析与显式质疑',
  } as const
}

function executionTasks(completed = false): readonly CollaborationTask[] {
  const tasks: readonly CollaborationTask[] = [
    {
      id: 'task-1', revision: 2, subject: '收敛产品边界', description: '确认首批验证用户、核心任务和非目标',
      status: 'completed', owner: { sessionId: 'expert-session-4', memberId: 'expert-attempt-4', name: '产品策略专家', role: 'expert' },
      blockedBy: [], resourceScopes: ['prd'], ready: true, resourceConflicts: [],
    },
    {
      id: 'task-2', revision: 2, subject: '验证系统架构', description: '检查任务 DAG、事件流和失败恢复边界',
      status: 'completed', owner: { sessionId: 'expert-session-3', memberId: 'expert-attempt-3', name: '系统架构专家', role: 'expert' },
      blockedBy: [], resourceScopes: ['architecture'], ready: true, resourceConflicts: [],
    },
    {
      id: 'task-3', revision: completed ? 4 : 3, subject: '执行质量验收', description: '覆盖正常、边界、失败与重连场景',
      status: completed ? 'completed' : 'in_progress', owner: { sessionId: 'expert-session-7', memberId: 'expert-attempt-7', name: '质量验收专家', role: 'expert' },
      blockedBy: [], resourceScopes: ['test-results'], ready: true, resourceConflicts: [],
    },
    {
      id: 'task-4', revision: completed ? 3 : 1, subject: '反方评审与交付', description: '质疑关键假设并由 Lead 汇总最终交付',
      status: completed ? 'completed' : 'pending', owner: { sessionId: 'expert-session-8', memberId: 'expert-attempt-8', name: '反方评审专家', role: 'expert' },
      blockedBy: completed ? [] : ['task-3'], resourceScopes: ['final-delivery'], ready: completed, resourceConflicts: [],
    },
  ]
  return tasks
}

function executionTimeline(runId: string, includeDelivery = false): readonly CollaborationTimelineEvent[] {
  const lead = { sessionId: runId, name: 'Lead Agent', role: 'lead' as const }
  const product = { sessionId: 'expert-session-4', memberId: 'expert-attempt-4', name: '产品策略专家', role: 'expert' as const }
  const architect = { sessionId: 'expert-session-3', memberId: 'expert-attempt-3', name: '系统架构专家', role: 'expert' as const }
  const reviewer = { sessionId: 'expert-session-8', memberId: 'expert-attempt-8', name: '反方评审专家', role: 'expert' as const }
  const quality = { sessionId: 'expert-session-7', memberId: 'expert-attempt-7', name: '质量验收专家', role: 'expert' as const }
  const messages: CollaborationTimelineEvent[] = [
    { id: 'message-1', eventId: 'event-1', cursor: 1, threadId: 'thread-main', kind: 'task', author: lead, targets: [product, architect], references: { taskId: 'task-1' }, content: '请先独立收敛产品边界与系统约束，再在公开线程合并分歧', createdAt: now - 150_000, visibility: 'public' },
    { id: 'message-2', eventId: 'event-2', cursor: 2, threadId: 'thread-main', kind: 'proposal', author: product, targets: [lead], references: { taskId: 'task-1' }, content: '建议首批聚焦调研分析、产品方案与软件开发三个通用领域', createdAt: now - 140_000, visibility: 'public' },
    { id: 'message-3', eventId: 'event-3', cursor: 3, threadId: 'thread-main', kind: 'challenge', author: reviewer, targets: [product], references: { taskId: 'task-1', challengeId: 'challenge-1' }, content: '三个领域是否足以证明机制通用，需要明确一致的成功指标', createdAt: now - 130_000, visibility: 'public' },
    { id: 'message-4', eventId: 'event-4', cursor: 4, threadId: 'thread-main', kind: 'response', author: product, targets: [reviewer], references: { taskId: 'task-1', challengeId: 'challenge-1' }, content: '统一以任务完成率、有效质疑率、Lead 返工次数和最终验收通过率衡量', createdAt: now - 120_000, visibility: 'public' },
    { id: 'message-5', eventId: 'event-5', cursor: 5, threadId: 'thread-main', kind: 'review', author: quality, targets: [lead, architect], references: { taskId: 'task-3' }, content: '任务依赖、8 专家窄屏、失败终态与冷启动恢复均已纳入验收', createdAt: now - 110_000, visibility: 'public' },
    { id: 'message-6', eventId: 'event-6', cursor: 6, threadId: 'thread-main', kind: 'decision', author: lead, targets: [product, architect, reviewer, quality], references: { decisionId: 'decision-1' }, content: '裁决采用统一指标，并保留反方意见作为验收资产', createdAt: now - 100_000, visibility: 'public' },
    { id: 'message-7', eventId: 'event-7', cursor: 7, threadId: 'thread-main', kind: 'artifact', author: architect, targets: [lead], references: { taskId: 'task-2', artifactId: 'artifact-architecture' }, content: '已提交任务 DAG、公开事件流与恢复边界说明', createdAt: now - 90_000, visibility: 'public' },
  ]
  if (includeDelivery) messages.push({ id: 'message-8', eventId: 'event-8', cursor: 8, threadId: 'thread-main', kind: 'final_delivery', author: lead, targets: [], references: { decisionId: 'decision-1', artifactId: 'artifact-final' }, content: '团队已完成产品边界、架构、质量与反方评审。建议进入小批量验证，并按统一指标记录三个领域的真实表现', createdAt: now - 60_000, visibility: 'public' })
  return messages
}

function emptyProgress() {
  return {
    total: 0, ready: 0, inProgress: 0, completed: 0, blocked: 0, messageCount: 0,
    artifactCount: 0, decisionCount: 0,
    qualityGatePending: 0, qualityGatePassed: 0, qualityGateFailed: 0,
  }
}

function emptyController(health: CollaborationController['health'] = 'attention'): CollaborationController {
  return {
    health, lastProgressAt: 0, stalledTaskIds: [], duplicateWorkCount: 0,
    qualityFailureCount: 0, recommendedActions: [], actionsTaken: [],
  }
}

function executionArtifacts(completed = false): readonly CollaborationArtifact[] {
  const artifacts: readonly CollaborationArtifact[] = [
    {
      id: 'artifact-product-spec', version: 2, kind: 'product_spec', title: '首批验证产品规格与成功指标',
      status: completed ? 'accepted' : 'review', author: { role: 'expert', memberId: 'expert-attempt-4', sessionId: 'expert-session-4', name: '产品策略专家' }, taskIds: ['task-1'],
      mediaType: 'text/markdown', updatedAt: now - 86_000,
    },
    {
      id: 'artifact-architecture', version: 3, kind: 'design', title: '任务 DAG、公开事件流与恢复设计',
      status: completed ? 'accepted' : 'review', author: { role: 'expert', memberId: 'expert-attempt-3', sessionId: 'expert-session-3', name: '系统架构专家' }, taskIds: ['task-2'],
      mediaType: 'application/vnd.dsh.architecture+json', updatedAt: now - 80_000,
    },
    {
      id: 'artifact-test-report', version: completed ? 4 : 3, kind: 'test_report', title: '正常、边界、异常与冷恢复验收报告',
      status: completed ? 'accepted' : 'draft', author: { role: 'expert', memberId: 'expert-attempt-7', sessionId: 'expert-session-7', name: '质量验收专家' }, taskIds: ['task-3'],
      mediaType: 'text/markdown', updatedAt: now - 70_000,
    },
  ]
  return completed ? [...artifacts, {
    id: 'artifact-final', version: 1, kind: 'final_delivery', title: '多智能体协作产品统一交付',
    status: 'accepted', author: { role: 'lead', sessionId: 'team-run-completed-8', name: 'Lead Agent' }, taskIds: ['task-1', 'task-2', 'task-3', 'task-4'],
    mediaType: 'text/markdown', updatedAt: now - 55_000,
  }] : artifacts
}

function executionDecisions(completed = false): readonly CollaborationDecision[] {
  return [{
    id: 'decision-1', version: completed ? 2 : 1, subject: '首批验证领域与统一成功指标',
    outcome: completed ? 'accepted' : 'revise',
    summary: completed ? '采用三个通用领域和同一组协作质量指标' : '补充三个领域共用的量化指标后再验收',
    rationale: '统一口径可以隔离领域差异，验证协作机制是否通用',
    taskIds: ['task-1', 'task-4'], artifactIds: ['artifact-product-spec'], lead: { role: 'lead', sessionId: completed ? 'team-run-completed-8' : 'team-run-running-8', name: 'Lead Agent' },
    createdAt: now - 78_000,
  }]
}

function executionQualityGates(completed = false): readonly CollaborationQualityGate[] {
  return [
    {
      id: 'gate-boundary', version: 2, name: '产品边界覆盖', status: 'passed', reviewer: { role: 'expert', memberId: 'expert-attempt-8', sessionId: 'expert-session-8', name: '反方评审专家' },
      taskId: 'task-1', artifactId: 'artifact-product-spec', summary: '目标用户、核心任务与非目标均可验收', updatedAt: now - 68_000,
    },
    {
      id: 'gate-recovery', version: completed ? 4 : 3, name: '异常与冷恢复验证', status: completed ? 'passed' : 'failed',
      reviewer: { role: 'expert', memberId: 'expert-attempt-7', sessionId: 'expert-session-7', name: '质量验收专家' }, taskId: 'task-3', artifactId: 'artifact-test-report',
      summary: completed ? '异常、重连和冷启动场景全部通过' : '冷启动后仍缺少一次版本一致性复验', updatedAt: now - 62_000,
    },
    {
      id: 'gate-final-review', version: 1, name: '最终反方评审', status: completed ? 'passed' : 'pending',
      reviewer: { role: 'expert', memberId: 'expert-attempt-8', sessionId: 'expert-session-8', name: '反方评审专家' }, taskId: 'task-4',
      summary: completed ? '关键假设已有证据或保留意见' : '等待返工报告通过后开始', updatedAt: now - 58_000,
      ...(completed ? { artifactId: 'artifact-final' } : {}),
    },
  ]
}

function executionController(completed = false): CollaborationController {
  return completed ? {
    health: 'ready', lastProgressAt: now - 55_000, stalledTaskIds: [], duplicateWorkCount: 1,
    qualityFailureCount: 1, recommendedActions: [],
    actionsTaken: ['decision-1'],
  } : {
    health: 'stalled', lastProgressAt: now - 92_000, stalledTaskIds: ['task-3'], duplicateWorkCount: 1,
    qualityFailureCount: 1,
    recommendedActions: ['reassign', 'replan', 'rework', 'resolve_quality_failure', 'replace_expert'],
    actionsTaken: ['decision-1'],
  }
}

function legacyProtocol(): CollaborationProtocol {
  return { mode: 'legacy', topology: null, limits: null, members: [], challenges: [] }
}

function executionProtocol(completed = false): CollaborationProtocol {
  const names = ['用户研究专家', '数据分析专家', '系统架构专家', '产品策略专家', '安全评审专家', '工程效率专家', '质量验收专家', '反方评审专家']
  const used = completed ? [6, 8, 5, 10, 10, 8, 12, 12] : [4, 7, 2, 9, 10, 11, 12, 3]
  return {
    mode: 'enforced',
    topology: 'grouped',
    limits: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
    members: names.map((name, index) => {
      const usedMessages = used[index] ?? 0
      return {
        slotId: `slot-${index + 1}`,
        memberId: `expert-attempt-${index + 1}`,
        name,
        phase: 'active',
        permissions: {
          challenge: index === 3 || index === 6 || index === 7,
          review: index === 2 || index === 4 || index === 6 || index === 7,
          requestHelp: index < 7,
        },
        allowedTargets: index < 4 ? names.slice(0, 4).filter(value => value !== name) : names.slice(4).filter(value => value !== name),
        usedMessages,
        remainingMessages: 12 - usedMessages,
      }
    }),
    challenges: [
      {
        challengeId: 'challenge-product-metrics', threadId: 'thread-product', round: 2,
        challenger: '反方评审专家', target: '产品策略专家', status: 'responded',
        challengeMessageId: 'message-3', responseMessageId: 'message-4',
      },
      {
        challengeId: 'challenge-recovery-proof', threadId: 'thread-quality', round: completed ? 3 : 1,
        challenger: '质量验收专家', target: '系统架构专家', status: completed ? 'responded' : 'open',
        challengeMessageId: 'message-quality-challenge', responseMessageId: completed ? 'message-quality-response' : null,
      },
    ],
  }
}

/**
 * Build the complete isolated UI fixture catalog.
 * @returns Deterministic forming, active, completed, and failed snapshots for isolated UI tests.
 */
export function createDemoRuns(): readonly CollaborationRunSnapshot[] {
  const runningExperts = Array.from({ length: 8 }, (_, index) => expert(index + 1))
  const failedExperts = [expert(1, 'failed'), expert(2, 'failed')]
  const runningTasks = executionTasks()
  const runningTimeline = executionTimeline('team-run-running-8')
  const completedTasks = executionTasks(true)
  const completedTimeline = executionTimeline('team-run-completed-8', true)
  return [
    {
      id: 'team-run-forming-1',
      title: '评审一页产品方案',
      objective: '识别最大的产品风险并给出修订建议',
      language: 'zh', status: 'forming', phase: 'provisioning', createdAt: now - 60_000, cursor: 3,
      profile: profile('simple'), charter: charter(3, 'centralized'),
      lead: { sessionId: 'team-run-forming-1', name: 'Lead Agent', role: '任务协调、裁决与最终验收' },
      experts: [expert(1, 'provisioning'), expert(2, 'provisioning'), expert(3, 'provisioning')],
      expertCounts: { planned: 3, provisioning: 3, active: 0, failed: 0, attempts: 3 },
      tasks: [], timeline: [], artifacts: [], decisions: [], qualityGates: [],
      controller: emptyController(), progress: emptyProgress(), protocol: legacyProtocol(),
    },
    {
      id: 'team-run-running-8',
      title: '规划多智能体协作产品',
      objective: '完成产品、架构、安全、测试与交付的联合方案',
      language: 'zh', status: 'running', phase: 'active', createdAt: now - 180_000, cursor: 21,
      profile: profile('complex'), charter: charter(8, 'grouped'),
      lead: { sessionId: 'team-run-running-8', name: 'Lead Agent', role: '任务协调、分歧裁决与最终验收' },
      experts: runningExperts,
      expertCounts: { planned: 8, provisioning: 0, active: 8, failed: 0, attempts: 8 },
      tasks: runningTasks,
      timeline: runningTimeline,
      artifacts: executionArtifacts(), decisions: executionDecisions(), qualityGates: executionQualityGates(),
      controller: executionController(),
      protocol: executionProtocol(),
      progress: {
        total: 4, ready: 0, inProgress: 1, completed: 2, blocked: 1, messageCount: runningTimeline.length,
        artifactCount: 3, decisionCount: 1, qualityGatePending: 1, qualityGatePassed: 1, qualityGateFailed: 1,
      },
    },
    {
      id: 'team-run-completed-8',
      title: '验收多智能体协作产品',
      objective: '完成产品、架构、安全、测试与反方评审的统一交付',
      language: 'zh', status: 'completed', phase: 'completed', createdAt: now - 240_000, cursor: 26,
      profile: profile('complex'), charter: charter(8, 'grouped'),
      lead: { sessionId: 'team-run-completed-8', name: 'Lead Agent', role: '任务协调、分歧裁决与最终验收' },
      experts: runningExperts,
      expertCounts: { planned: 8, provisioning: 0, active: 8, failed: 0, attempts: 8 },
      tasks: completedTasks,
      timeline: completedTimeline,
      artifacts: executionArtifacts(true), decisions: executionDecisions(true), qualityGates: executionQualityGates(true),
      controller: executionController(true),
      protocol: executionProtocol(true),
      progress: {
        total: 4, ready: 0, inProgress: 0, completed: 4, blocked: 0, messageCount: completedTimeline.length,
        artifactCount: 4, decisionCount: 1, qualityGatePending: 0, qualityGatePassed: 3, qualityGateFailed: 0,
      },
    },
    {
      id: 'team-run-failed-2',
      title: '验证供应商技术方案',
      objective: '交叉审查架构与安全风险',
      language: 'zh', status: 'team_formation_failed', phase: 'formation_failed', createdAt: now - 300_000, cursor: 6,
      profile: profile('medium'), charter: charter(3, 'centralized'),
      lead: { sessionId: 'team-run-failed-2', name: 'Lead Agent', role: '任务协调与组队' },
      experts: failedExperts,
      expertCounts: { planned: 3, provisioning: 0, active: 0, failed: 2, attempts: 2 },
      tasks: [], timeline: [], artifacts: [], decisions: [], qualityGates: [],
      controller: emptyController('attention'), progress: emptyProgress(), protocol: legacyProtocol(),
      failure: { code: 'TEAM_FORMATION_FAILED', message: '2 名专家均未完成安全预检', retryable: true, details: '任务未进入执行阶段' },
    },
  ]
}

/**
 * Create an isolated deterministic preview port for tests and standalone stories.
 * @param seed - Initial authoritative snapshots owned by the preview fixture.
 * @returns In-memory collaboration port with fresh-run retry semantics.
 */
export function createCollaborationDemoPort(seed = createDemoRuns()): CollaborationPort {
  let snapshot: CollaborationCatalogSnapshot = { state: 'ready', runs: seed }
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = (runs: readonly CollaborationRunSnapshot[]): void => {
    snapshot = { state: 'ready', runs }
    for (const listener of listeners) listener()
  }
  const source = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const create = (request: CreateCollaborationRunRequest, prior?: CollaborationRunSnapshot): CollaborationRunSnapshot => {
    sequence += 1
    const id = `team-run-preview-${sequence}`
    const language: CollaborationLanguage = request.language
    const planned = prior?.expertCounts.planned ?? 3
    const experts = Array.from({ length: planned }, (_, index) => ({
      ...expert(index + 1, 'provisioning'),
      id: `${id}-attempt-${index + 1}`,
      sessionId: `${id}-expert-${index + 1}`,
    }))
    return {
      id, title: request.title, objective: request.objective, language,
      status: 'forming', phase: 'provisioning', createdAt: Date.now(), cursor: 0,
      profile: prior?.profile ?? profile('simple'), charter: prior?.charter ?? charter(3, 'centralized'),
      lead: { sessionId: id, name: 'Lead Agent', role: language === 'zh' ? '任务协调、裁决与最终验收' : 'Coordination, arbitration, and final acceptance' },
      experts,
      expertCounts: { planned, provisioning: planned, active: 0, failed: 0, attempts: planned },
      tasks: [], timeline: [], artifacts: [], decisions: [], qualityGates: [],
      controller: emptyController(), progress: emptyProgress(), protocol: legacyProtocol(),
    }
  }
  return {
    source,
    createRun: (request) => {
      const run = create(request)
      publish([run, ...snapshot.runs])
      return Promise.resolve(run.id)
    },
    retryFormation: runId => Promise.resolve().then(() => {
      const failed = snapshot.runs.find(run => run.id === runId)
      if (failed === undefined || failed.status !== 'team_formation_failed' || failed.failure?.retryable !== true) {
        throw new Error('Run is not retryable')
      }
      const run = create({ title: failed.title, objective: failed.objective, language: failed.language }, failed)
      publish([run, ...snapshot.runs])
      return run.id
    }),
    terminate: (runId) => {
      publish(snapshot.runs.map(run => run.id === runId
        ? { ...run, status: 'cancelled', phase: 'cancelled' }
        : run))
      return Promise.resolve()
    },
  }
}
