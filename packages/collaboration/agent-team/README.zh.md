# @deepseek-ai/dsh-agent-team

[English](README.md) | 中文

面向天然多智能体协作的稳定 TeamRun 领域包。`ctx.teamRuns` 在 Lead Session 日志中维护一条显式 Lead 运行生命周期、可审计专家组队 roster、基于 CAS 的任务 DAG 和类型化公开协作记录。[P0 架构契约](../../../.agents/notes/proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md)负责产品边界。实验性 `ctx.agentTeams` 是独立的旧子系统，两个服务不共享状态，也不会静默互操作

## 配置

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-agent-team'
  config:
    maxActiveExperts: 8
    maxProvisionAttempts: 12
    maxTasks: 256
    maxPublicMessages: 4096
    maxPublicMessageBytes: 65536
    maxArtifacts: 512
    maxArtifactBodyBytes: 1048576
    taskStallCursorThreshold: 20
```

`maxActiveExperts` 的取值为一到八，且不计 Lead。其他限制都必须是正整数。完整策略会复制到创建事件中，因此即使后续部署修改默认值，回放仍然使用该运行创建时的限制

该服务需要 Agent 和 Session 服务。启用 Session 持久化的 profile 会让 TeamRun journal 持久保存，本包不会创建第二个数据库或缓存

## TeamRun 生命周期与组队

每个运行由一个 live Lead 显式创建，并指定目标、复杂度和确切的计划专家数。合法区间为 `simple = 1`、`medium = 2..4` 和 `complex = 5..8`。Lead 单独表示，永远不占专家槽位。`active + provisioning` 不得超过计划数或 `maxActiveExperts`，可用槽位等于 `planned - active - provisioning`

组队为 P2 provider 层提供三命令边界：`beginExpertProvision()` 预留不可变的 member、Session、attempt、name 和 role 身份，`succeedExpertProvision()` 在初始 prompt 准入前记录 child 发布，`failExpertProvision()` 保留结构化的失败审计行并释放并发槽位。如果首 prompt 在 success commit 后准入失败，同一失败命令会在 run 仍处于 provisioning 时补偿该 active 行。失败身份和名称仍被占用，attempt 序号单调增长，默认第十三次尝试会被拒绝。独立的 P2 runtime 创建 child Agent 并绑定精确能力，本领域仍是生命周期权威

runtime 专家也可以在运行保持 `active` 时从 active 转为 failed。其 membership 和 scoped 权限会立即撤销，公开 status 转为 `blocked`，释放的槽位可以 provision 一个新的不可变 replacement attempt。只有精确计划的 active 数量恢复后，status 才回到 `running`。Lead 进入 `completing` 后会拒绝新增或成功组队，但仍记录迟到的 runtime failure，避免运行带着过期 active 成员交付，并强制后续转为 `failed`

只有当 active 专家数严格等于计划数且没有 provisioning attempt 时，运行才能进入 `active`。完成前会重新检查同一条件。有效团队形成前失败会进入显式 `formation_failed` phase，执行失败和取消分别使用 `failed` 和 `cancelled`。终态不可逆，仅有 Lead 的运行不能进入 active 或 completed

## 持久事件 journal 与回放

九类读取时必需的 Session event 组成完整领域真相：

- `collaboration/run/created` 快照保存身份、目标、计划、Lead 和策略
- `collaboration/run/phase` 推进生命周期或记录结构化终态失败
- `collaboration/member` 保存完整的不可变身份专家 attempt 行
- `collaboration/protocol` 保存不可变 topology、limit、精确专家规则和可用 slot route
- `collaboration/task` 保存完整任务 revision
- `collaboration/message` 保存一条类型化且仅公开的协作记录
- `collaboration/artifact` 保存一个完整的 CAS artifact 版本及其受限正文
- `collaboration/decision` 保存一条独立的 Lead 裁决账本记录
- `collaboration/quality-gate` 保存一个已物化质量门或正式结果

严格 fold 会校验当前版本 payload、运行归属、连续语义 revision、生命周期迁移、组队容量、任务 DAG 不变式和消息引用。普通 Session fork 会过滤属于其他 Lead 的继承 TeamRun 事件。重放相同 `eventId` 和内容在语义上幂等，但物理 Session cursor 仍会前进；使用同一 id 承载不同内容属于损坏，会关闭式失败。journal 按 Lead 串行写入，CAS 会拒绝并发的陈旧命令

独立的 `./invariant` 配套模块会在发布前，将每个候选 collaboration event 对照已提交的 Session 前缀回放。能够读取这些事件的 profile 必须挂载本包，因为这些事实是重建所必需的内容，而不是可忽略 telemetry

## 共享任务 DAG

任务是完整的版本化快照。每次变更都携带 `expectedRevision`，陈旧写入方会收到 `STALE_REVISION`。依赖必须引用当前未删除任务，不得包含重复边或自边，并保持完整图无环。只有所有 blocker 都已 completed，pending 任务才 ready，完成操作会再次检查该条件。在 enforced run 中，专家负责的任务必须保持 in_progress，直到负责人把精确关联该任务的资产回交 Lead、Lead 接收该资产并由 Lead 确认 `complete` 迁移；专家自行完成或只有 review 状态资产都会关闭式失败。legacy run 保留原任务迁移行为。已删除任务作为回放 tombstone 保留，但不会出现在 `listTasks()` 中，也不再占用任务容量

Lead 和 active 专家可以创建和读取任务。仅 Lead 可调用的 `assign` 会把 pending 任务绑定给一名 active 专家但不启动任务，即使其依赖仍处于阻塞状态也可以提前分配。claim、release、edit、completion、reopen、reassign 和 deletion 都保留领域层 owner 与 Lead 权限校验。`resourceScopes` 是经规范化的通用前缀，用于报告进行中工作的重叠。它们是协作提示，不是文件系统锁、plugin 权限或授权

## 强制协作协议

新的 orchestrated run 会在任何专家进入 active 前物化一份不可变协议。它会把 Team Charter 的 topology 与 communication limit，以及每个精确 ExpertBlueprint 的 `challenge`、`review` 与 `requestHelp` 权限复制到 Lead Session 日志。每个专家 attempt 都绑定一个持久 protocol slot，failed member 之后的 replacement attempt 也不例外。使用同一协议重试保持幂等，协议不同或 active run 发生漂移时会以 `TEAM_PROTOCOL_REQUIRED` 关闭式失败

专家撰写的每条公开记录都会消耗对应 slot 的消息预算。`centralized` 与 `parallel` 只允许专家向 Lead 路由，`producer_reviewer` 允许向所有 peer 路由，`hybrid` 允许向相邻 slot 路由，`grouped` 允许向配对 slot 路由；Lead 在每种 topology 中都是可用协调目标。权限、目标与预算耗尽拒绝分别使用稳定错误码 `TEAM_PROTOCOL_PERMISSION_DENIED`、`TEAM_PROTOCOL_TARGET_DENIED` 与 `TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED`，且不追加 event。Lead 可跨 roster 协调，但不能绕过权威账本操作伪造原始 decision、artifact 或 final-delivery receipt

challenge 与 response 必须共享一个显式 dispute thread、一个 challenge id 和一个精确对方。同一 thread 一次只允许一个 open round，response 必须反向对应原始参与方，并在追加前强制 Charter round limit。open challenge 会以 `DELIVERY_FAILED` 阻断 `completeRun()`。权威 protocol 投影会向 Host 与 tool 暴露 topology、limit、per-member 权限、可用目标、已用与剩余预算、以及已关联 challenge round 状态

日志早于 `collaboration/protocol` 的 run 会投影为精确 `legacy` 模式，并在冷恢复与审计时保留原 P3-P5 消息行为。它们不会被静默升级，也不会被重新解释为 enforced run

## 公开协作记录

消息有十四种持久公开 kind，包括 proposal、challenge、response、review、decision、handoff、completion request 和 final delivery。类型系统中没有 private-reasoning 类别。运行时校验会强制公开 visibility、当前 actor 和 target、当前任务引用、生命周期准入、字节和数量限制、protocol 准入和权威账本所有权。challenge id 只能出现在已关联的 challenge 或 response 上；decision、artifact 与 final-delivery 记录只能由各自所属操作生成

Artifact、decision 和 quality 都是一等持久账本。紧凑 TeamRun 投影只携带 artifact 元数据而不含正文，`readArtifact()` 是经过 membership 授权的正文读取入口。Artifact 和 quality 写入会在原子追加账本事实与公开证据前校验数量、UTF-8 字节、生命周期、引用、权限和 CAS。专家撰写的 artifact receipt 以 Lead 为接收者，Lead 更新专家撰写的 artifact 时以原 artifact 作者为接收者，Lead 自有 artifact 的 receipt 不设置会话接收者。每条新生成的账本消息都会在追加前拒绝作者与接收者相同的关系。Lead Controller 只根据持久 cursor、event time 和运行创建时快照策略派生健康度、显式关联的任务活跃度、重复工作、质量失败、active 专家缺员、建议动作和已执行控制动作。reassign、rework 与 replan 会原子追加 task revision、Lead decision 和公开记录，`replace_expert` 则把 runtime controller 引导到 orchestrator 拥有的 provider 替换路径

active run 在团队缺员、task 停滞或 quality gate failed 时投影为 `blocked`，最新 Lead 控制动作重新打开工作后投影为 `reworking`，全部完成门禁就绪后投影为 `reviewing`，相关进展或修正后的质量证据会在不存在更强状态时确定性恢复 `running`

`completeRun()` 会把完成收口校验并提交为一个有序批次。它要求非空任务全部 completed、每个任务至少关联一个 accepted artifact、同时存在 completion-request 和 review、至少物化一个质量门且全部 passed，并且每个任务都有一条 accepted Lead decision 关联到该任务的 accepted artifact，才会追加 `completing`、Lead 的 `final_delivery` 和 `completed`。准入失败不会追加任何内容，并保持 run、task、artifact、decision、gate、revision 与 cursor 全部不变

这些记录是有序的公开审计流，不是 peer 投递传输。稳定 [`@deepseek-ai/dsh-tool-agent-team`](../tool-agent-team/README.md) 包负责面向模型的适配，Host API 会暴露紧凑 task progress 和按 cursor 分页的公开事件

## 模型体验

### 公开协作记录

#### 模型看到的内容

TeamRun 生命周期、roster、task 和 `collaboration/*` event 只存在于日志，不会直接进入模型历史。只有 scoped 适配器返回所选当前投影时，模型才能看到它们

#### Token 影响

领域包不直接增加 prompt 或 history token。工具 schema、策略和紧凑结果由稳定工具适配器负责

#### KV Cache 影响

领域事件不会直接使模型前缀失效。模型调用协作工具时，适配器结果会追加在可复用请求前缀之后

## 已知限制与暂缓工作

- **P2 是独立适配器** — 本包自身永不创建 child Agent 或挂载 skill 与 plugin，需同时挂载 `@deepseek-ai/dsh-expert-catalog` 和 `@deepseek-ai/dsh-expert-runtime` 以获得精确专家绑定
- **没有 peer 投递传输** — 公开记录是持久审计事实，不是自动 Agent inbox 消息或唤醒
- **没有不受控后台 timer** — 只有其他持久事件推进 cursor 时，controller 健康度才会变化；需要纯墙钟告警的部署必须安排显式且落账的观察动作
- **单进程权限** — 按 Lead 串行的 queue 和 Session journal 不会在多个 harness 进程之间提供分布式事务
