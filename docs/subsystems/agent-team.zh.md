# TeamRun 协作

[English](agent-team.md) | 中文

稳定 TeamRun 领域把 Lead Session log 作为组队、专家尝试审计行、任务与公开协作的唯一权威，[稳定协作决策](../../.agents/notes/implemented/architecture/2026-08-26-stable-collaboration-domain.md)负责这些契约，本页记录 [`packages/collaboration/agent-team/src/types.ts`](../../packages/collaboration/agent-team/src/types.ts)中的字面持久形式

## TeamRun 与组队

`TeamRunId` 是具有独立[品牌](core.md#branded-ids)的 Lead `SessionId`，Lead 是隐式成员且永不消耗专家容量，简单、中等和复杂运行分别要求一名、两至四名和五至八名专家，每次专家尝试会在 P2 启动 child 前保留不可变的 member、Session、名称与 attempt 身份，失败尝试继用于审计但释放 active 槽。当 child 已发布但首 prompt 准入失败时，P2 可在运行仍处于 provisioning 时补偿 active 行；active 专家在执行中失败时同样撤销成员权限，运行投影为 `blocked`，直到使用新身份的替补恢复精确计划人数

```ts type-equiv
/** Complete immutable-identity expert row retained for audit after failure. */
interface TeamMemberSnapshot {
  /** Stable roster identity. */
  readonly id: TeamMemberId
  /** Stable child Session identity reserved before provider work begins. */
  readonly sessionId: SessionId
  /** Stable model-facing expert name. */
  readonly name: string
  /** User-safe expert responsibility. */
  readonly role: string
  /** Planned protocol slot retained across replacement attempts. */
  readonly protocolSlotId?: TeamProtocolSlotId
  /** Immutable provisioning attempt identity. */
  readonly attemptId: ProvisionAttemptId
  /** Contiguous one-based attempt number. */
  readonly attemptNumber: number
  /** Current attempt lifecycle. */
  readonly phase: TeamMemberPhase
  /** Required failure for a failed attempt. */
  readonly failure?: TeamFailure
}
```

精确内部生命周期为 `profiling`、`planning`、`provisioning`、`active`、`completing` 和 `completed`，另有显式终态 `formation_failed`、`failed` 与 `cancelled`，只有精确计划专家数全部 active 且没有 attempt 仍在 provisioning 时，运行才能进入 `active`，运行保持 active 时仅在低于该精确人数后才允许替补尝试，进入 `completing` 后不再允许新增或成功组队，但 active 专家仍可结算为 failed，从而阻断精确团队完成并要求 Lead 将运行终止为 failed

```ts type-equiv
/** Authoritative TeamRun projection reconstructed from the Lead Session log. */
interface TeamRunSnapshot {
  /** Explicit run identity. */
  readonly id: TeamRunId
  /** Monotonic semantic revision, excluding idempotent duplicate events. */
  readonly revision: number
  /** Session-log cursor of the last applicable physical event. */
  readonly cursor: number
  /** Authoritative Lead, which never appears in {@link members}. */
  readonly lead: Extract<TeamActorRef, { readonly role: 'lead' }>
  /** User task objective. */
  readonly objective: string
  /** Complexity that fixes the legal expert target band. */
  readonly complexity: TeamRunComplexity
  /** Exact number of active experts required before execution. */
  readonly plannedExperts: number
  /** Limits fixed when the run was created. */
  readonly policy: TeamRunPolicySnapshot
  /** Exact durable lifecycle. */
  readonly phase: TeamRunPhase
  /** Host-facing lifecycle projection. */
  readonly status: TeamRunPublicStatus
  /** Immutable expert attempts in provisioning order. */
  readonly members: readonly TeamMemberSnapshot[]
  /** Current non-deleted tasks in creation order. */
  readonly tasks: readonly TeamTaskView[]
  /** Complete retained public collaboration timeline. */
  readonly messages: readonly PublicCollaborationMessage[]
  /** Authoritative protocol limits, routes, usage, and challenge state. */
  readonly protocol: TeamProtocolSnapshot
  /** Artifact metadata only; bodies require the restricted read operation. */
  readonly artifacts: readonly TeamArtifactSnapshot[]
  /** Independent Lead decision ledger. */
  readonly decisions: readonly TeamDecisionRecord[]
  /** Independent materialized quality-gate ledger. */
  readonly qualityGates: readonly TeamQualityGateRecord[]
  /** Deterministic Lead Controller health and recommendations. */
  readonly controller: TeamControllerSnapshot
  /** Expert-only capacity and audit counts. */
  readonly expertCounts: TeamExpertCounts
  /** Terminal failure or cancellation, when present. */
  readonly failure?: TeamFailure
}
```

## 强制协议

新的 orchestrated run 会在专家激活前追加 `collaboration/protocol`。该记录固定 topology、challenge 与公开消息 limit、精确 blueprint 权限和可用 peer slot。每个初始或 replacement attempt 都绑定一个 slot。fold 会根据 protocol 与公开消息流派生 per-member 用量、剩余预算、当前可用名称和已关联 challenge round，因此 Host 与客户端无需推断第二份授权模型

专家消息必须在追加前满足对应 slot 的预算、kind 权限和 topology route。challenge 使用一个显式 thread、id 与 target，在同一 thread 中按顺序进行，并要求原 target 回应原 challenger。open challenge 会阻断 final delivery。没有 protocol 的日志保留精确 `legacy` 投影与 P6 前的准入行为

## 公开协作

领域只接受封闭的公开 intent 词表，并存储字面 `public` visibility，不存在 private-reasoning 或 chain-of-thought 消息类型，author 和 target 会按照 Lead 或 active 专家 roster 校验，引用不能指向缺失或已删除任务

```ts type-equiv
/** Complete user-visible collaboration message derived from one durable event. */
interface PublicCollaborationMessage {
  /** Stable public message identity. */
  readonly id: CollaborationMessageId
  /** Idempotent durable event identity. */
  readonly eventId: CollaborationEventId
  /** Session-log sequence used as the reconnect cursor. */
  readonly sequence: number
  /** Owning TeamRun. */
  readonly runId: TeamRunId
  /** Public discussion thread. */
  readonly threadId: TeamThreadId
  /** Message category. */
  readonly kind: PublicCollaborationMessageKind
  /** Author validated against the current roster. */
  readonly author: TeamActorRef
  /** Explicit public recipients; an empty list addresses the whole team. */
  readonly targets: readonly TeamActorRef[]
  /** Optional typed relations to collaboration records. */
  readonly references: PublicCollaborationReferences
  /** User-safe public content; private reasoning has no representation in this type. */
  readonly content: string
  /** Unix epoch milliseconds from the durable event envelope. */
  readonly createdAt: number
  /** Visibility fixed before persistence. */
  readonly visibility: 'public'
}
```

## 共享任务 DAG

每条 task event 都存储完整快照，`revision` 是 compare-and-set 值，每次变更递增 1，`blockedBy` edge 必须指向未删除任务并维持无环图，通用 `resourceScopes` 是规范化的建议性 ownership 前缀，而不是锁或权限授予

```ts type-equiv
/** Complete task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  /** Team-local task identity. */
  readonly id: TeamTaskId
  /** One-based compare-and-set revision. */
  readonly revision: number
  /** Concise user-safe task title. */
  readonly subject: string
  /** Complete task objective and acceptance information. */
  readonly description: string
  /** Current task lifecycle. */
  readonly status: TeamTaskStatus
  /** Current owner, absent while unclaimed. */
  readonly owner?: TeamActorRef
  /** Tasks that must complete before this task becomes ready. */
  readonly blockedBy: readonly TeamTaskId[]
  /** Generic advisory resource ownership prefixes. */
  readonly resourceScopes: readonly string[]
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone，view 会添加 readiness 和当前 resource-scope 重叠诊断，但不会改变持久快照

## 回放

`foldTeamRun()` 严格解码 `collaboration/*` 记录、校验连续 semantic revision 与幂等 event 身份，并按 `TeamRunId` 选取记录，从其他 Lead 继承的 event 保留原 Lead id，绝不会进入新运行状态，Session event 的 `seq` 与 `time` 继续作为物理顺序和时间权威，[包 README](../../packages/collaboration/agent-team/README.md)负责命令、authorization、恢复与策略限制

## 迁移隔离

历史实验性 Agent Teams 服务在 `ctx.agentTeams` 上继续服务其显式示例，其提示词选择 child、peer delivery mailbox、代码专用 `writeScopes` 与 `team/*` 记录属于迁移证据，而不是稳定 TeamRun 状态，两种服务绝不读取对方日志或共享 Context key

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, scheduling mode, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined
```

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts:56`](../../packages/experimental/agent-team/src/index.ts)

<a id="ctxexpertcatalog--expertcatalog"></a>

### `ctx.expertCatalog` — `ExpertCatalog`

Locally configured immutable ExpertBlueprint catalog.

```ts cordis-catalog
/**
 * List configured immutable revisions in deployment order.
 * @returns detached blueprint references.
 */
list(): ExpertBlueprintRef[]

/**
 * Read one exact configured revision without resolving external capabilities.
 * @param ref - exact immutable selector.
 * @returns a detached blueprint.
 * @throws `CAPABILITY_UNAVAILABLE` when the revision is not configured.
 */
get(ref: ExpertBlueprintRef): ExpertBlueprint

/**
 * Resolve one revision to the exact mountable preset, enabled plugin rows, and winning skill definitions.
 * @param ref - exact immutable selector.
 * @param options - cwd-sensitive lookup and caller cancellation.
 * @returns detached binding with a digest covering every resolved capability.
 * @throws `CAPABILITY_UNAVAILABLE` instead of omitting any missing or indeterminate capability.
 */
async resolve(ref: ExpertBlueprintRef, options: ResolveExpertBindingOptions = {}): Promise<ResolvedExpertBinding>
```

Source: [`packages/collaboration/expert-catalog/src/index.ts:52`](../../packages/collaboration/expert-catalog/src/index.ts)

<a id="ctxexpertruntime--expertruntime"></a>

### `ctx.expertRuntime` — `ExpertRuntime`

Expert child provisioning, recovery, drift enforcement, and execution-budget owner.

```ts cordis-catalog
/**
 * Resolve, reserve, durably bind, create, and activate one real expert child.
 * P1 success commits after child publication and before the initial prompt enters its inbox.
 * @param lead - exact live TeamRun Lead.
 * @param request - identities, blueprint revision, assignment, CAS revision, and cancellation.
 * @returns active P1 member, immutable binding, and accepted initial message id.
 */
provision(lead: Agent, request: ProvisionExpertRequest): Promise<ProvisionedExpert>

/**
 * Recover one P1 provisioning attempt without replaying a prompt already accepted by a persisted child.
 * @param lead - exact live TeamRun Lead.
 * @param attemptId - existing immutable provisioning attempt.
 * @param signal - caller cancellation through inspection or missing-child creation.
 * @returns active P1 member plus whether a missing child had to start.
 */
recoverProvisioning( lead: Agent, attemptId: ExpertProvisionAttemptId, signal: AbortSignal, ): Promise<RecoveredExpert>

/**
 * Deliver a later expert message after validating current catalog content and the durable parent/child descriptor pair.
 * @param lead - exact live TeamRun Lead.
 * @param childId - exact expert child Session.
 * @param content - user-role content to enqueue.
 * @param options - durable attribution and pre-acceptance cancellation.
 * @returns accepted inbox message id.
 */
async followup( lead: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions, ): Promise<MessageId>

/**
 * List immutable bindings owned by one live Lead.
 * @param lead - exact live TeamRun Lead.
 * @returns detached records in append order.
 */
listBindings(lead: Agent): ExpertBindingEventData[]
```

Types: [Agent](core.md) · [ContentBlock](llm-streaming.md) · [MessageId](llm-streaming.md) · [SessionId](core.md) · [SubagentFollowupOptions](subagent.md)

Source: [`packages/collaboration/expert-runtime/src/index.ts:136`](../../packages/collaboration/expert-runtime/src/index.ts)

<a id="ctxteamorchestrator--teamorchestrator"></a>

### `ctx.teamOrchestrator` — `TeamOrchestrator`

P3 owner for one TeamRun's automatic team formation records.

```ts cordis-catalog
/**
 * Create or resume the unique profile, plan, and charter for one live Lead.
 * @param lead - exact live top-level Agent whose Session owns the TeamRun.
 * @param request - idempotency id, task text, optional domain/decomposition hints, and assignment context.
 * @returns planning snapshot with an exact immutable roster and charter.
 */
create(lead: Agent, request: CreateTeamOrchestrationRequest): Promise<TeamOrchestrationSnapshot>

/**
 * Provision or recover every exact planned slot and activate only at full strength.
 * @param lead - exact live Lead.
 * @param command - matching durable request id.
 * @param signal - cancellation through catalog resolution and initial prompt admission.
 * @returns active, exactly staffed TeamRun snapshot.
 */
form(lead: Agent, command: TeamOrchestrationCommand, signal: AbortSignal): Promise<TeamOrchestrationSnapshot>

/**
 * Create, plan, charter, and fully form one team through the product one-click path.
 * @param lead - exact live Lead.
 * @param request - automatic orchestration request.
 * @param signal - formation cancellation.
 * @returns active, exactly staffed team.
 */
async orchestrate( lead: Agent, request: CreateTeamOrchestrationRequest, signal: AbortSignal, ): Promise<TeamOrchestrationSnapshot>

/**
 * Idempotently continue a non-terminal provisioning run after a local interruption.
 * @param lead - exact live Lead.
 * @param command - matching durable request id.
 * @param signal - recovery cancellation.
 * @returns active snapshot, or the same active snapshot on repeat.
 */
retry(lead: Agent, command: TeamOrchestrationCommand, signal: AbortSignal): Promise<TeamOrchestrationSnapshot>

/**
 * Idempotently replace one failed active-run expert from its durable planned slot.
 * @param lead - exact live TeamRun Lead.
 * @param request - matching request and failed immutable member identity.
 * @param signal - provider cancellation propagated through recovery and provisioning.
 * @returns active orchestration with the replacement settled successfully.
 */
replaceExpert( lead: Agent, request: ReplaceTeamExpertRequest, signal: AbortSignal, ): Promise<TeamOrchestrationSnapshot>

/**
 * Cancel a non-terminal orchestration and preserve its current durable audit.
 * @param lead - exact live Lead.
 * @param request - matching request id and user-safe reason.
 * @returns cancelled snapshot.
 */
cancel(lead: Agent, request: CancelTeamOrchestrationRequest): Promise<TeamOrchestrationSnapshot>

/**
 * Read one live Lead's P3 projection, including a partial plan after explicit formation failure.
 * @param lead - exact live Lead.
 * @returns detached orchestration and authoritative P1 snapshot.
 */
get(lead: Agent): TeamOrchestrationSnapshot

/**
 * List P3 projections for current live top-level Leads in Agent registration order.
 * @returns detached snapshots; unrelated Agents and pre-profile crash gaps are absent.
 */
list(): TeamOrchestrationSnapshot[]
```

Types: [Agent](core.md)

Source: [`packages/collaboration/team-orchestrator/src/index.ts:129`](../../packages/collaboration/team-orchestrator/src/index.ts)

<a id="ctxteamruns--teamrunservice"></a>

### `ctx.teamRuns` — `TeamRunService`

Stable TeamRun service; `ctx.teamRuns` is independent from experimental `ctx.agentTeams`.

```ts cordis-catalog
/**
 * Atomically establish one explicit TeamRun before expert work begins.
 * @param lead - exact live initiating Agent, retained as the implicit Lead outside expert capacity.
 * @param request - objective, complexity, and exact planned expert target.
 * @returns authoritative profiling snapshot at revision one.
 */
async createRun(lead: Agent, request: CreateTeamRunRequest): Promise<TeamRunSnapshot>

/**
 * Resolve one exact live Agent's TeamRun role.
 * @param agent - exact live Lead or active expert.
 * @returns current run and actor authority.
 */
membership(agent: Agent): TeamMembership

/**
 * Resolve membership without throwing for scoped installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns membership, or undefined for an unrostered, inactive, stale, or malformed Agent.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Read the authoritative run visible to one exact live member.
 * @param caller - exact live Lead or active expert.
 * @returns detached current TeamRun snapshot.
 */
getRun(caller: Agent): TeamRunSnapshot

/**
 * Advance profiling, planning, formation, execution, or completion with run-level CAS.
 * @param caller - exact live Lead.
 * @param request - expected revision and next non-failure phase.
 * @returns committed TeamRun snapshot.
 */
async changePhase(caller: Agent, request: ChangeTeamRunPhaseRequest): Promise<TeamRunSnapshot>

/**
 * Idempotently commit the exact Team Charter collaboration protocol before activation.
 * @param caller - exact live TeamRun Lead.
 * @param request - run CAS plus topology, limits, immutable slots, permissions, and routes.
 * @returns authoritative snapshot containing the enforced protocol projection.
 */
async materializeProtocol(caller: Agent, request: MaterializeTeamProtocolRequest): Promise<TeamRunSnapshot>

/**
 * Reserve one immutable expert attempt before P2 starts provider work, during formation or active replacement.
 * @param caller - exact live Lead.
 * @param request - run CAS, reserved ids, name, and role.
 * @returns committed provisioning attempt.
 */
async beginExpertProvision( caller: Agent, request: BeginExpertProvisionRequest, ): Promise<TeamMemberSnapshot>

/**
 * Record one expert as active after P2 reports provider success.
 * @param caller - exact live Lead.
 * @param request - run CAS and immutable attempt identity.
 * @returns committed active expert row.
 */
async succeedExpertProvision( caller: Agent, request: SucceedExpertProvisionRequest, ): Promise<TeamMemberSnapshot>

/**
 * Mark a provisioning attempt or active runtime expert failed while retaining audit and releasing capacity.
 * @param caller - exact live Lead.
 * @param request - run CAS, immutable attempt identity, and structured failure.
 * @returns committed failed expert row.
 */
async failExpertProvision( caller: Agent, request: FailExpertProvisionRequest, ): Promise<TeamMemberSnapshot>

/**
 * Commit an explicit formation failure, execution failure, or cancellation.
 * @param caller - exact live Lead.
 * @param request - run CAS, exact terminal phase, and structured cause.
 * @returns committed terminal TeamRun snapshot.
 */
async terminateRun(caller: Agent, request: TerminateTeamRunRequest): Promise<TeamRunSnapshot>

/**
 * Create one TeamRun task through the single Lead-log authority.
 * @param caller - exact live Lead or active expert.
 * @param request - task text, blockers, and generic resource scopes.
 * @returns committed revision-one task.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Read one current task, including a deleted tombstone.
 * @param caller - exact live Lead or active expert.
 * @param taskId - Team-local task identity.
 * @returns detached task view.
 */
getTask(caller: Agent, taskId: import('./types.ts').TeamTaskId): TeamTaskView

/**
 * List current non-deleted TeamRun tasks.
 * @param caller - exact live Lead or active expert.
 * @returns detached task views in creation order.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized TeamRun task mutation.
 * @param caller - exact live Lead or active expert.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Publish one public-only structured collaboration message.
 * @param caller - exact live Lead or active expert author.
 * @param request - kind, thread, targets, references, and user-safe content.
 * @returns committed public message with event cursor and creation time.
 */
async publishMessage( caller: Agent, request: PublishCollaborationMessageRequest, ): Promise<PublicCollaborationMessage>

/**
 * Write one complete artifact version and a body-free public receipt atomically.
 * @param caller - exact live Lead or active expert author.
 * @param request - artifact CAS, metadata, task relations, status, and bounded body.
 * @returns complete artifact to the authorized caller.
 */
async writeArtifact(caller: Agent, request: WriteTeamArtifactRequest): Promise<TeamArtifactRecord>

/**
 * Read one complete artifact through current TeamRun membership authority.
 * @param caller - exact live Lead or active expert.
 * @param artifactId - artifact identity.
 * @returns complete current artifact including its body.
 */
readArtifact(caller: Agent, artifactId: import('./types.ts').TeamArtifactId): TeamArtifactRecord

/**
 * Write one Lead arbitration row and its public decision record atomically.
 * @param caller - exact live Lead.
 * @param request - decision CAS, outcome, safe rationale, and ledger relations.
 * @returns committed decision.
 */
async writeDecision(caller: Agent, request: WriteTeamDecisionRequest): Promise<TeamDecisionRecord>

/**
 * Materialize one pending quality gate before activation.
 * @param caller - exact live Lead.
 * @param request - immutable gate name.
 * @returns committed pending gate.
 */
async createQualityGate(caller: Agent, request: CreateTeamQualityGateRequest): Promise<TeamQualityGateRecord>

/**
 * Commit one formal quality result and its public review atomically.
 * @param caller - exact live Lead reviewer.
 * @param request - gate CAS, result, safe summary, and optional relations.
 * @returns committed quality gate.
 */
async updateQualityGate(caller: Agent, request: UpdateTeamQualityGateRequest): Promise<TeamQualityGateRecord>

/**
 * Apply one Lead-only task correction with decision and public evidence in one batch.
 * @param caller - exact live Lead Controller authority.
 * @param request - run/task CAS, correction, and safe rationale.
 * @returns committed run snapshot.
 */
async control(caller: Agent, request: TeamControlRequest): Promise<TeamRunSnapshot>

/**
 * Atomically close one fully completed and publicly reviewed run with a Lead delivery.
 * @param caller - exact live TeamRun Lead.
 * @param request - public thread, optional typed references, and final user delivery.
 * @returns committed completed snapshot containing the final delivery.
 */
async completeRun(caller: Agent, request: CompleteTeamRunRequest): Promise<TeamRunSnapshot>
```

Types: [Agent](core.md)

Source: [`packages/collaboration/agent-team/src/index.ts:115`](../../packages/collaboration/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
