/** Authoritative client collaboration catalog and mutation runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  CollaborationActorView,
  CollaborationFailureView,
  CollaborationPublicEventView,
  CollaborationRunView,
  RpcError,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '../contract/sessions.ts'
import { createSnapshotStore, type SnapshotStore } from '../contract/store.ts'
import {
  collaborationLeadSessionId,
  type CollaborationCatalogSnapshot,
  type CollaborationFailure,
  type CollaborationLevel,
  type CollaborationPublicActor,
  type CollaborationPublicMessage,
  type CollaborationRunId,
  type CollaborationRunSnapshot,
  type CreateCollaborationRunRequest,
  type ICollaboration,
} from '../contract/collaboration.ts'

const MAX_COLLABORATION_TEXT_BYTES = 16_384

function boundedCreateRequest(request: CreateCollaborationRunRequest): CreateCollaborationRunRequest {
  const title = request.title.trim()
  const objective = request.objective.trim()
  for (const [label, value] of [['title', title], ['objective', objective]] as const) {
    if (value === '' || new TextEncoder().encode(value).byteLength > MAX_COLLABORATION_TEXT_BYTES) {
      throw new RangeError(`${label} must be non-blank and at most 16,384 UTF-8 bytes`)
    }
  }
  return { title, objective, language: request.language }
}

/** Build the Lead's explicit collaboration contract instead of treating it as an everyday chat prompt. */
function leadExecutionPrompt(request: CreateCollaborationRunRequest): string {
  if (request.language === 'zh') {
    return `你是本次多智能体协作任务的 Lead，只负责组织、质疑、裁决、验收和最终汇总

用户任务：
${request.objective}

必须遵守以下执行协议：
1. 所有公开任务名、观点、质疑、回应、评审、资产、裁决和最终交付都使用简体中文
2. 公开文本中称自己为“主协调智能体”，称每位专家为任务章程中的完整角色名（例如“市场分析专家”），不得使用 expert-N 或“专家N”；工具参数仍使用内部标识。除用户原文中的专有名词和必要缩写外，避免使用英文角色名与界面术语
3. 先调用 collaboration_get 和 collaboration_task_list 读取 Team Charter 已创建的完整任务、依赖关系、预分配负责人和质量门；把相同依赖层视为一个阶段，同阶段多个无互相依赖的任务是并行阶段，单个任务是串行阶段
4. 不要重复创建或擅自改写 Team Charter 中已有的任务。每次只从 ready=true 的任务里选择下一步，使用 collaboration_followup 并携带 task_id 发送给该任务预分配的 owner；专家领取并完成当前任务后才能推进其下游任务。并行阶段表示依赖上可并行，但仍按当前单消息接力协议逐个发起
5. 主协调智能体不自行使用 Bash、联网搜索、技能加载或其他日常会话工具执行专家工作，只使用 collaboration_* 工具协调；必要的调研和工具执行交给已挂载技能与插件的专家
6. 每位专家都必须亲自创建覆盖其任务的资产，并把该资产连同任务引用回交主协调智能体；只有聊天、口头结论或其他专家代写的资产都不算完成
7. 主协调智能体必须逐项阅读并接收专家本人资产，随后才能宣告整体完成、记录“已接受”裁决或通过关联质量门；不得把“评审中”资产描述为已接收产出或整体完成
8. 最终交付前，向恰好一名专家发送完成申请，引用该专家已经接收的 task_id 与 artifact_id，并等待同一专家使用完全相同的 task_id 与 artifact_id 返回后续评审
9. 仅当所有活跃专家都有本人已接收且已回交的资产、全部任务与质量门完成、完成申请获得匹配评审后，才调用 collaboration_complete；在该调用成功前不得直接结束任务

现在开始执行，不要只复述计划`
  }
  return `You are the Lead for this multi-agent collaboration. You coordinate, challenge, arbitrate, review, and synthesize; experts execute the specialist work.

User task:
${request.objective}

Mandatory execution protocol:
1. Use English for every public task, contribution, challenge, response, review, artifact, decision, and final delivery.
2. In public text, refer to every expert by the full assigned role name from the Team Charter; never expose expert-N identifiers. Internal tool arguments still use stable identifiers.
3. Call collaboration_get and collaboration_task_list first to read every Charter task, dependency, preassigned owner, and quality gate. Treat one dependency layer as a stage: multiple mutually independent tasks form a parallel stage and one task forms a serial stage.
4. Never duplicate or silently rewrite Charter tasks. Select the next step only from tasks with ready=true, then use collaboration_followup with its task_id and its preassigned owner. The expert must claim and finish that task before any downstream task can start. A parallel stage is dependency-parallel but is still dispatched one task at a time under the existing single-message baton.
5. Do not use Bash, web search, skill loading, or everyday-chat tools for expert work. Coordinate only through collaboration_* tools and delegate specialist execution to experts with mounted skills and plugins.
6. Every expert must author an artifact covering their assigned task and route that exact task/artifact evidence back to the Lead. A chat message, verbal conclusion, or artifact authored by another expert is not completion.
7. The Lead must read and accept each owner-authored artifact before declaring the overall collaboration complete, recording an accepted decision, or passing a linked quality gate. Never describe a review-state artifact as an accepted output or an overall completion.
8. Before final delivery, send a completion request to exactly one expert referencing that expert's already-accepted task_id and artifact_id, then wait for the same expert's later review using the exact same task_id and artifact_id.
9. Call collaboration_complete only after every active expert has an accepted routed artifact, every task and quality gate is complete, and the completion request has its matching review. Do not end the task before that call succeeds.

Start executing now; do not merely restate the plan.`
}

/** Product error carrying the stable Host RPC refusal. */
export class CollaborationClientError extends Error {
  override readonly name = 'CollaborationClientError'

  /** @param rpcError - collaboration business or transport refusal. */
  constructor(readonly rpcError: RpcError) {
    super(`collaboration request failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

function failureView(value: CollaborationFailureView): CollaborationFailure {
  const details = Object.entries(value.details).map(([key, detail]) => `${key}: ${String(detail)}`).join(', ')
  return {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    ...details === '' ? {} : { details },
  }
}

function rpcFailure(value: RpcError): CollaborationFailure {
  return { code: value.code, message: value.message, retryable: false }
}

function decomposability(value: CollaborationRunView['profile']['metrics']): CollaborationLevel {
  if (value.workstreamCount >= 5 || value.independentWorkstreams >= 4) return 'high'
  return value.decomposable ? 'medium' : 'low'
}

function profileRationale(value: CollaborationRunView): string {
  const metrics = value.profile.metrics
  return value.language === 'zh'
    ? `识别到 ${String(metrics.workstreamCount)} 个工作流、${String(metrics.capabilityCount)} 类专业能力和 ${String(metrics.riskSignalCount)} 个风险信号`
    : `Detected ${String(metrics.workstreamCount)} workstreams, ${String(metrics.capabilityCount)} capability groups, and ${String(metrics.riskSignalCount)} risk signals`
}

function actorView(value: CollaborationActorView): CollaborationPublicActor {
  return {
    role: value.role,
    ...value.role === 'expert' ? { memberId: value.memberId } : {},
    sessionId: value.sessionId,
    name: value.name,
  }
}

function eventView(value: CollaborationPublicEventView): CollaborationPublicMessage {
  return {
    id: value.id,
    eventId: value.eventId,
    cursor: value.cursor,
    threadId: value.threadId,
    kind: value.kind,
    author: actorView(value.author),
    targets: value.targets.map(actorView),
    references: { ...value.references },
    content: value.content,
    createdAt: value.createdAt,
    visibility: value.visibility,
  }
}

function runView(
  value: CollaborationRunView,
  timeline: readonly CollaborationPublicMessage[] = [],
): CollaborationRunSnapshot {
  const charter = value.charter === null
    ? null
    : {
      objective: value.charter.objective,
      successCriteria: [...value.charter.successCriteria],
      topology: value.charter.topology,
      communicationRules: value.language === 'zh'
        ? [
          `每个争议最多 ${String(value.charter.communication.maxChallengeRounds)} 轮质疑与回应`,
          `每位专家最多发布 ${String(value.charter.communication.maxMessagesPerExpert)} 条公开消息`,
          'Lead 负责冲突裁决、进度兜底和最终汇总',
        ]
        : [
          `At most ${String(value.charter.communication.maxChallengeRounds)} challenge-response rounds per dispute`,
          `At most ${String(value.charter.communication.maxMessagesPerExpert)} public messages per expert`,
          'Lead owns conflict resolution, recovery, and final synthesis',
        ],
      qualityChecks: [...value.charter.qualityChecks],
      budget: {
        maxExperts: value.profile.plannedExperts,
        maxDiscussionRounds: value.charter.communication.maxChallengeRounds,
        maxTokens: value.charter.budgets.reduce((sum, budget) => sum + budget.maxTokens, 0),
      },
      terminationPolicy: value.language === 'zh'
        ? '全部任务完成并通过复核后交付；组队失败时显式终止，不降级为单 Agent'
        : 'Deliver only after all tasks are completed and reviewed; formation fails closed without single-agent fallback',
    }
  return {
    id: value.id,
    title: value.title,
    objective: value.objective,
    language: value.language,
    status: value.status,
    phase: value.phase,
    createdAt: value.createdAt,
    cursor: value.cursor,
    profile: {
      complexity: value.profile.complexity,
      decomposability: decomposability(value.profile.metrics),
      toolDensity: value.profile.metrics.toolDensity,
      risk: value.profile.metrics.risk,
      sequentialDependencies: value.profile.metrics.dependencyCount > 0,
      rationale: profileRationale(value),
    },
    charter,
    lead: { ...value.lead },
    experts: value.experts.map(expert => ({
      id: expert.id,
      sessionId: expert.sessionId,
      name: expert.name,
      role: expert.role,
      phase: expert.phase,
      binding: {
        blueprint: { ...expert.binding.blueprint },
        preset: { ...expert.binding.preset },
        skills: expert.binding.skills.map(skill => ({ ...skill })),
        ...expert.binding.marketplaceProviders === undefined
          ? {}
          : { marketplaceProviders: expert.binding.marketplaceProviders.map(provider => ({ ...provider })) },
        marketplaceSkills: expert.binding.marketplaceSkills.map(skill => ({ ...skill })),
        plugins: expert.binding.plugins.map(plugin => ({ ...plugin })),
      },
      ...expert.failure === undefined ? {} : { failure: failureView(expert.failure) },
    })),
    tasks: value.tasks.map(task => ({
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      owner: task.owner === null ? null : actorView(task.owner),
      blockedBy: [...task.blockedBy],
      resourceScopes: [...task.resourceScopes],
      ready: task.ready,
      resourceConflicts: [...task.resourceConflicts],
    })),
    artifacts: value.artifacts.map(artifact => ({
      id: artifact.id,
      version: artifact.version,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      author: actorView(artifact.author),
      taskIds: [...artifact.taskIds],
      mediaType: artifact.mediaType,
      updatedAt: artifact.updatedAt,
    })),
    decisions: value.decisions.map(decision => ({
      id: decision.id,
      version: decision.version,
      subject: decision.subject,
      outcome: decision.outcome,
      summary: decision.summary,
      rationale: decision.rationale,
      taskIds: [...decision.taskIds],
      artifactIds: [...decision.artifactIds],
      lead: actorView(decision.lead),
      createdAt: decision.createdAt,
    })),
    qualityGates: value.qualityGates.map(gate => ({
      id: gate.id,
      version: gate.version,
      name: gate.name,
      status: gate.status,
      ...gate.reviewer === undefined ? {} : { reviewer: actorView(gate.reviewer) },
      ...gate.taskId === undefined ? {} : { taskId: gate.taskId },
      ...gate.artifactId === undefined ? {} : { artifactId: gate.artifactId },
      summary: gate.summary,
      updatedAt: gate.updatedAt,
    })),
    controller: {
      health: value.controller.health,
      lastProgressAt: value.controller.lastProgressAt,
      stalledTaskIds: [...value.controller.stalledTaskIds],
      duplicateWorkCount: value.controller.duplicateWorkCount,
      qualityFailureCount: value.controller.qualityFailureCount,
      recommendedActions: [...value.controller.recommendedActions],
      actionsTaken: [...value.controller.actionsTaken],
    },
    protocol: {
      mode: value.protocol.mode,
      topology: value.protocol.topology,
      limits: value.protocol.limits === null ? null : { ...value.protocol.limits },
      members: value.protocol.members.map(member => ({
        slotId: member.slotId,
        memberId: member.memberId,
        name: member.name,
        phase: member.phase,
        permissions: { ...member.permissions },
        allowedTargets: [...member.allowedTargets],
        usedMessages: member.usedMessages,
        remainingMessages: member.remainingMessages,
      })),
      challenges: value.protocol.challenges.map(challenge => ({ ...challenge })),
    },
    timeline: timeline.map(message => ({
      ...message,
      author: { ...message.author },
      targets: message.targets.map(target => ({ ...target })),
      references: { ...message.references },
    })),
    progress: { ...value.progress },
    expertCounts: {
      planned: value.expertCounts.planned,
      provisioning: value.expertCounts.provisioning,
      active: value.expertCounts.active,
      failed: value.expertCounts.failed,
      attempts: value.expertCounts.attempts,
    },
    ...value.failure === undefined ? {} : { failure: failureView(value.failure) },
  }
}

function provisionalRun(id: SessionId, request: CreateCollaborationRunRequest): CollaborationRunSnapshot {
  const createdAt = Date.now()
  return {
    id,
    title: request.title,
    objective: request.objective,
    language: request.language,
    status: 'forming',
    phase: 'profiling',
    createdAt,
    cursor: 0,
    profile: null,
    charter: null,
    lead: { sessionId: id, name: 'lead', role: 'Lead Agent' },
    experts: [],
    tasks: [],
    timeline: [],
    artifacts: [],
    decisions: [],
    qualityGates: [],
    controller: {
      health: 'healthy',
      lastProgressAt: createdAt,
      stalledTaskIds: [],
      duplicateWorkCount: 0,
      qualityFailureCount: 0,
      recommendedActions: [],
      actionsTaken: [],
    },
    progress: {
      total: 0,
      ready: 0,
      inProgress: 0,
      completed: 0,
      blocked: 0,
      messageCount: 0,
      artifactCount: 0,
      decisionCount: 0,
      qualityGatePending: 0,
      qualityGatePassed: 0,
      qualityGateFailed: 0,
    },
    expertCounts: { planned: 3, provisioning: 0, active: 0, failed: 0, attempts: 0 },
  }
}

/** Avoid publishing a new observer snapshot when a polling result is identical. */
function sameRuns(
  left: readonly CollaborationRunSnapshot[],
  right: readonly CollaborationRunSnapshot[],
): boolean {
  if (left.length !== right.length) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Runtime-owned collaboration catalog; UI stores contain viewing state only. */
export class CollaborationRuntime implements ICollaboration {
  readonly source: SnapshotStore<CollaborationCatalogSnapshot>
  private readonly requestIds = new Map<CollaborationRunId, string>()
  private readonly timelines = new Map<CollaborationRunId, {
    readonly cursor: number
    readonly events: readonly CollaborationPublicMessage[]
  }>()
  private refreshGeneration = 0

  /**
   * @param ctx - browser root context receiving the outward service.
   * @param api - typed Host transport.
   * @param sessions - top-level Lead session owner.
   */
  constructor(
    ctx: Context,
    private readonly api: IApiClient,
    private readonly sessions: ISessions,
  ) {
    this.source = createSnapshotStore<CollaborationCatalogSnapshot>({ state: 'loading', runs: [] })
    ctx.reflect.provide('collaboration', this, undefined)
    ctx.on('connection/reset', () => { void this.refresh() })
  }

  /** Reconcile the complete recoverable TeamRun catalog after boot or reconnect. */
  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    const current = this.source.getSnapshot()
    const retained = current.runs
    // Preserve a settled panel while a background discovery pull is running.
    // Initial boot still exposes the explicit recovery state.
    if (current.state === 'loading') this.source.set({ state: 'loading', runs: retained })
    try {
      const response = await this.api.collaboration.list({})
      if (generation !== this.refreshGeneration) return
      if (!response.result.ok) {
        if (current.state !== 'ready') {
          this.source.set({ state: 'error', runs: retained, error: rpcFailure(response.result.error) })
        }
        return
      }
      const runs = await Promise.all(response.result.value.runs.map(async value =>
        runView(value, await this.eventsFor(value))))
      if (generation !== this.refreshGeneration) return
      this.requestIds.clear()
      for (const value of response.result.value.runs) this.requestIds.set(value.id, value.requestId)
      if (current.state !== 'ready' || !sameRuns(retained, runs)) {
        this.source.set({ state: 'ready', runs })
      }
    } catch (error: unknown) {
      if (generation !== this.refreshGeneration) return
      if (current.state !== 'ready') {
        this.source.set({
          state: 'error',
          runs: retained,
          error: { code: 'transport-error', message: error instanceof Error ? error.message : String(error), retryable: true },
        })
      }
    }
  }

  /** Refresh one known run without scanning the complete persisted catalog. */
  refreshRun(runId: CollaborationRunId): Promise<void> {
    return this.refreshOne(runId as SessionId)
  }

  /** Create a fresh Lead and run the complete automatic formation transaction. */
  createRun(request: CreateCollaborationRunRequest): Promise<CollaborationRunId> {
    return this.createFreshRun(request)
  }

  /** Create a new Lead for a failed run while retaining the old terminal record. */
  async retryFormation(runId: CollaborationRunId): Promise<CollaborationRunId> {
    const previous = this.source.getSnapshot().runs.find(run => run.id === runId)
    if (previous === undefined) throw new Error(`collaboration retry references unknown run "${runId}"`)
    if (previous.status !== 'team_formation_failed' && previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new Error(`collaboration run "${runId}" is not a terminal formation failure`)
    }
    const retryOf = this.requestIds.get(runId)
    if (retryOf === undefined) throw new Error(`collaboration run "${runId}" has no retained request identity`)
    return this.createFreshRun({
      title: previous.title,
      objective: previous.objective,
      language: previous.language,
    }, retryOf)
  }

  /** Cancel one non-terminal run while preserving its durable audit. */
  async terminate(runId: CollaborationRunId): Promise<void> {
    const requestId = this.requestIds.get(runId)
    if (requestId === undefined) throw new Error(`collaboration terminate references unknown run "${runId}"`)
    const response = await this.api.collaboration.cancel({
      runId: runId as SessionId,
      requestId,
      reason: 'Cancelled by the user',
    })
    if (!response.result.ok) throw new CollaborationClientError(response.result.error)
    this.accept(response.result.value)
    await this.hydrateAndAccept(response.result.value).catch(() => undefined)
  }

  private async createFreshRun(request: CreateCollaborationRunRequest, retryOf?: string): Promise<CollaborationRunId> {
    const boundedRequest = boundedCreateRequest(request)
    const leadSessionId = collaborationLeadSessionId()
    const requestId = `collaboration-request-${crypto.randomUUID()}`
    await this.sessions.create({ sessionId: leadSessionId })
    let renamed
    try {
      renamed = await this.api.sessions.rename({
        sessionId: leadSessionId,
        title: boundedRequest.language === 'zh'
          ? `协作 · ${boundedRequest.title}`
          : `Collaboration · ${boundedRequest.title}`,
      })
    } catch (error: unknown) {
      await this.archiveUncommittedLead(leadSessionId)
      throw error
    }
    if (!renamed.result.ok) {
      await this.archiveUncommittedLead(leadSessionId)
      throw new CollaborationClientError(renamed.result.error)
    }
    this.requestIds.set(leadSessionId, requestId)
    this.replaceRun(provisionalRun(leadSessionId, boundedRequest))
    let polling = false
    const timer = setInterval(() => {
      if (polling) return
      polling = true
      void this.refreshOne(leadSessionId).finally(() => { polling = false })
    }, 250)
    let committed = false
    try {
      const response = await this.api.collaboration.create({
        leadSessionId,
        requestId,
        ...retryOf === undefined ? {} : { retryOf },
        title: boundedRequest.title,
        objective: boundedRequest.objective,
        language: boundedRequest.language,
      })
      if (!response.result.ok) {
        await this.archiveUncommittedLead(leadSessionId)
        this.removeRun(leadSessionId)
        const failure = rpcFailure(response.result.error)
        this.source.set({ state: 'error', runs: this.source.getSnapshot().runs, error: failure })
        throw new CollaborationClientError(response.result.error)
      }
      committed = true
      this.accept(response.result.value)
      await this.hydrateAndAccept(response.result.value).catch(() => undefined)
      const lead = this.sessions.binding(leadSessionId)?.session
      if (lead === undefined) {
        throw new Error(`collaboration Lead session "${leadSessionId}" is unavailable after formation`)
      }
      const started = await lead.prompt([{ type: 'text', text: leadExecutionPrompt(boundedRequest) }], 'queue')
      if (!started.ok) throw new CollaborationClientError(started.error)
      return response.result.value.id
    } catch (error: unknown) {
      if (!committed && !(error instanceof CollaborationClientError)) {
        this.removeRun(leadSessionId)
        this.source.set({
          state: 'error',
          runs: this.source.getSnapshot().runs,
          error: {
            code: 'transport-error',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        })
      }
      throw error
    } finally {
      clearInterval(timer)
    }
  }

  private async archiveUncommittedLead(sessionId: SessionId): Promise<void> {
    try {
      await this.api.workspace.archiveSession({ sessionId })
    } catch {
      // Cleanup is best-effort and must never replace the actionable creation error.
    }
  }

  private async refreshOne(runId: SessionId): Promise<void> {
    try {
      const response = await this.api.collaboration.get({ runId })
      if (response.result.ok) await this.hydrateAndAccept(response.result.value)
    } catch {
      // The create transaction may not have committed its profile yet; the next poll or final response owns it.
    }
  }

  private accept(value: CollaborationRunView): void {
    this.requestIds.set(value.id, value.requestId)
    this.replaceRun(runView(value, this.timelines.get(value.id)?.events ?? []))
  }

  /** Fetch every strictly cursor-ordered public page required by one compact snapshot. */
  private async eventsFor(value: CollaborationRunView): Promise<readonly CollaborationPublicMessage[]> {
    const retained = this.timelines.get(value.id)
    let cursor = retained !== undefined && retained.cursor <= value.cursor ? retained.cursor : -1
    const byEventId = new Map(
      (retained !== undefined && retained.cursor <= value.cursor ? retained.events : [])
        .map(event => [event.eventId, event] as const),
    )
    while (cursor < value.cursor) {
      const response = await this.api.collaboration.events({
        runId: value.id,
        afterCursor: cursor,
        limit: 100,
      })
      if (!response.result.ok) throw new CollaborationClientError(response.result.error)
      const page = response.result.value
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor || page.nextCursor > value.cursor) {
        throw new Error(`collaboration events cursor did not advance within run "${value.id}"`)
      }
      let priorEventCursor = cursor
      for (const event of page.events) {
        if (event.cursor <= priorEventCursor || event.cursor > page.nextCursor) {
          throw new Error(`collaboration events are not strictly cursor ordered for run "${value.id}"`)
        }
        priorEventCursor = event.cursor
        byEventId.set(event.eventId, eventView(event))
      }
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    if (cursor !== value.cursor) {
      throw new Error(`collaboration events stopped at cursor ${String(cursor)} before run cursor ${String(value.cursor)}`)
    }
    const events = [...byEventId.values()].sort((left, right) => left.cursor - right.cursor)
    this.timelines.set(value.id, { cursor, events })
    return events
  }

  /** Publish one compact snapshot only after its public timeline reaches the same cursor. */
  private async hydrateAndAccept(value: CollaborationRunView): Promise<void> {
    const timeline = await this.eventsFor(value)
    this.requestIds.set(value.id, value.requestId)
    this.replaceRun(runView(value, timeline))
  }

  private replaceRun(value: CollaborationRunSnapshot): void {
    const current = this.source.getSnapshot().runs
    const runs = [value, ...current.filter(run => run.id !== value.id)]
      .sort((left, right) => right.createdAt - left.createdAt)
    this.source.set({ state: 'ready', runs })
  }

  private removeRun(runId: CollaborationRunId): void {
    const runs = this.source.getSnapshot().runs.filter(run => run.id !== runId)
    this.requestIds.delete(runId)
    this.timelines.delete(runId)
    this.source.set({ state: 'ready', runs })
  }
}
