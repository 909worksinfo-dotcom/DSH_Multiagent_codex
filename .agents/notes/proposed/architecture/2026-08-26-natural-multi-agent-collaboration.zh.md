# Agent Note: 天然多智能体协作产品运行时

Status: proposed

[English](2026-08-26-natural-multi-agent-collaboration.md) | 中文

## Problem

现有 Agent Teams 能力是在 continuable child 之上的可选实验性协调层，它提供持久名册、peer mailbox 和共享任务 DAG，但每个 teammate 都继承 Lead 的组合，团队组建由提示词驱动，任务和消息缺少产品协作语义，失败的创建还会永久占用配置的成员上限

协作 Playground 围绕普通协调者 Session 创建浏览器本地任务卡，它从现有 Session 和 subagent 记录派生工作及参与者视图，但没有权威 TeamRun、结构化讨论、决策、产物、质量或最终交付记录，协调者 Session 由标题前缀识别，因此重命名可以在运行时状态未变时移除协作展示

产品要求每个任务都创建由 Lead 负责的专家团队，用户必须看到公开任务、提案、质疑、回应、评审、决策、产物和交付，但不能接收模型私有推理，简单顺序工作仍然需要团队，较大且可分解的工作可以使用最多八名专家，但不能允许无边界的 peer mesh

## Proposal

协作产品 profile 在任务执行开始前，为每个被接纳的用户任务创建一个 TeamRun，发起 Session 是 Lead，简单任务使用一名专家，中等任务使用两至四名专家，复杂任务使用五至八名专家，无法创建最低专家数量的运行进入明确的组队失败，绝不继续静默执行 Lead-only 运行

Task Profiler 推导复杂度、可分解性、顺序依赖、工具密度和风险，Team Planner 从 Capability Catalog 选择经过校验的 ExpertBlueprint revision，并提交包含目标、成功标准、名册、任务 DAG、协作拓扑、通信限制、质量检查、预算和终止策略的 Team Charter，模型规划提出这些值，运行时校验和配置上限负责强制执行

每个 ExpertBlueprint 把角色和目标绑定到一个 agent preset、一组 skill（技能）和插件、工具策略、模型和上下文策略、协作权限、输入输出字段、验收标准、轮次和 Token 预算、超时以及不可变 revision，Capability Catalog 只接纳本地配置的定义，Lead 在组队期间不能安装未知 skill 或插件

协作协议为任务、提案、求助、质疑、回应、评审、决策、移交、阻塞、完成申请、产物、状态和最终交付记录类型化公开事件，私有推理和 chain-of-thought 块绝不进入公开协作投影，中等和复杂工作支持有边界的质疑与回应轮次，复杂团队默认使用 Lead 定向或分组通信，而不是全员互通

Lead 拥有 Task Ledger 和 Progress Ledger，负责检测停滞与重复、重新分配或替换专家、修订计划、执行完成检查，并且只在所需产物、依赖、评审和验收标准通过后创建 FinalDelivery，Team Blackboard 在同一个持久 Team 权威中保存版本化产物元数据和决策记录

Team task 保留 compare-and-set revision 和完整依赖 DAG，同时以通用建议性 `resourceScopes` 替换代码专用 `writeScopes`，资源作用域报告所有权冲突，但不声称提供文件系统锁、权限授予或合并保证

## Runtime ownership

| Owner | Responsibility |
|---|---|
| 稳定的 `agent-team` collaboration 包 | 从实验性 Team 服务晋升而来的 TeamRun 身份、名册、mailbox、任务状态、持久事件重放、生命周期和配置上限 |
| 稳定的 `tool-agent-team` collaboration 包 | 提供结构化结果和作用域权限的模型可见 Team 通信及任务工具 |
| 稳定的 `expert-catalog` collaboration 包 | ExpertBlueprint 注册、能力解析、revision 查询和配置校验 |
| 稳定的 `team-orchestrator` collaboration 包 | Task Profiler、Team Planner、Team Charter、拓扑规则、协作协议、Lead ledgers、Team Blackboard、完成检查和 FinalDelivery |
| `packages/host/apiproxy` | 面向协作服务的 Host 查询、控制、事件游标和传输 Schema |
| `packages/client/runtime` | JSON 兼容的协作投影和可安全重连的 Client 状态 |
| `packages/client/ui-collaboration` | 任务发起、团队组建、公开时间线、任务图、决策、产物、预算、失败和最终交付展示 |
| `packages/bundle/web-app` | 按依赖顺序挂载协作 owner 的产品组合 |

任何协作包都不导入或修改 `agent-loop`，持久且模型可见的输入使用 Session 事件，实时拦截使用 Agent 或能力事件，每个专家的行为使用现有 preset、skill、插件、工具和 subagent 扩展点

## Host and browser contract

跨进程记录使用带品牌的 TeamRun、member、task、thread、challenge、decision、artifact 和 event id，`TeamRunSnapshot` 携带 `forming`、`running`、`blocked`、`reviewing`、`reworking`、`completed`、`team_formation_failed`、`failed` 或 `cancelled` 之一，并报告权威 Lead 和专家数量，而不是让浏览器推断这些值

Host 操作为 `collaboration.create`、`collaboration.list`、`collaboration.get`、`collaboration.events`、`collaboration.send`、`collaboration.complete`、`collaboration.retryFormation`、`collaboration.terminate` 和 `collaboration.readArtifact`，创建操作原子地建立 TeamRun 及其 Lead，事件读取使用单调游标和幂等事件 id，重连先恢复权威 snapshot，再从其游标后继续，失败返回 code、message、retryability 和结构化 details

`PublicCollaborationMessage` 携带事件序号、TeamRun、thread、author、targets、可选 task、challenge、decision 和 artifact 引用、content、创建时间以及字面 public visibility，Host 在提交公开记录前决定可见性，浏览器不把 reasoning-block 过滤或文本启发式作为隐私边界

Client runtime 拥有 `TeamRunManager`、`TeamRun`、`TeamRunSnapshot` 和 `CollaborationCatalogSnapshot`，UI store 只保留打开状态、选中的 run 和 member、tab、filters、panel width 和 draft 等查看状态，members、messages、tasks、charter、artifacts、decisions、failures 和 final delivery 仍然是通过 renderer-bound hooks 获取的运行时投影

## 已实现的 P4 执行切片

P4 会在激活前把每个已提交 Charter task DAG 物化到稳定 TeamRun 任务板，依赖优先遍历可以接受任意输入顺序的合法 DAG，并确定性固定生成的 task id，恢复只接受完全一致且未被修改的物化前缀，额外、重排、编辑、已分配 owner 或其他发生偏离的任务都会 fail closed，而不会把 Charter 绑定到无关的可变任务

紧凑 Host run 投影现在携带 Session cursor、全部当前未删除任务，以及 total、ready、in-progress、completed、blocked 和公开消息数量，完整讨论仍位于该快照之外，`collaboration.events` 只分页读取排他 cursor 之后的类型化公开消息，limit 范围是一到 100，`collaboration.send` 通过完全相同的 live Lead 发布，且不存在 private-reasoning 输入字段

完成收口是一个经过完整校验的 TeamRun 批次，领域层要求非空任务板全部 completed、任务 artifact 已 accepted、同时存在公开 completion request 与 review、至少有一个 passed quality gate，并且每个任务都有一条 Lead acceptance 关联到该任务的 accepted artifact，才会依次追加 `completing`、Lead 的 `final_delivery` 和 `completed`，Host `collaboration.complete` 与仅限 Lead 的 `collaboration_complete` 共用该操作，因此准入失败会保持 active run 不变

## 已实现的 P5 控制与账本切片

P5 新增三类读取时必需的事件，分别保存完整版本化 artifact、独立 Lead decision 和已物化 quality gate。紧凑 run 投影会暴露 artifact 元数据但永不包含正文，只有经过 membership 授权的 `readArtifact()` 与 Host `collaboration.readArtifact` 会返回正文。Artifact 数量和 UTF-8 正文限制会随运行创建一起快照保存，校验失败既不追加元数据，也不追加公开证据

每次正式 artifact、decision 或 quality result 写入都会在一个预校验 Session 批次中同时提交对应的类型化公开记录。Decision 裁决和 quality 结算要求 Lead 权限。确定性 Lead Controller 只根据持久 fold 派生健康度、基于 cursor 的停滞、重复 task subject、质量失败、active 专家缺员、建议动作和已记录动作，不使用不受控 timer。只有 task、message、artifact、decision 或 quality-gate event 中显式类型化的任务关联才会刷新任务活跃度。仅限 Lead 的 reassign、rework 和 replan 会原子提交 task revision、decision 与公开证据。active 专家缺员会产生 `replace_expert`，TeamOrchestrator 会把 failed member 解析回持久 planned slot，并通过 ExpertRuntime 幂等运行下一次不可变 attempt，provider failure 会被保留而不会伪报恢复

active public status 使用相同的 controller 证据，团队缺员、task 停滞或 quality gate failed 会得到 `blocked`，最新 rework 动作为 `reworking`，完整交付门禁就绪为 `reviewing`，其余 active run 为 `running`，从而避免 UI status 与 controller health 展示互相矛盾的状态

Charter quality check 会在激活前物化为精确有序 gate 前缀，active 冷恢复会拒绝偏离。完成收口要求非空任务全部 completed、每个任务有 accepted artifact、同时存在 completion-request 和 review、至少物化一个 quality gate 且全部 passed，并且 accepted Lead decision 通过每个任务的 accepted artifact 覆盖所有任务，之后现有 `completing` → `final_delivery` → `completed` 批次才能提交，缺少证据或只有无关证据都会保持完整聚合不变

该切片不实现自动专家唤醒、仅基于墙钟的监控或多进程分布式事务，停滞状态会在持久活动推进 run cursor 时更新

## Capacity and recovery

`maxActiveExperts` 限制 active 和 provisioning 专家的总和且不包含 Lead，本产品 profile 默认值为八，failed member 保留不可变名称和 attempt id 以供审计，但释放 active 槽，`maxProvisionAttempts` 独立限制全部创建尝试且默认值为十二，因此有效替代者可以填充计划团队，又不会允许无限重试

内部生命周期为 `profiling`、`planning`、`provisioning`、`active`、`completing` 和 `completed`，并以 `formation_failed`、`failed` 和 `cancelled` 作为失败终态，浏览器可以把前三种状态折叠为 `forming`，但持久事件保留确切状态和失败原因

Team 在启动每个 child 前保存 `ExpertBlueprintRef { id, revision }`、preset revision 或 content digest 以及解析后的 binding digest，continuable subagent descriptor 保留重现该组合所需的恢复输入，Team binding 与 child descriptor digest 不一致时以 `BLUEPRINT_REVISION_MISMATCH` 失败，而不是使用当前 catalog 内容恢复

初始错误集合包含 `TEAM_MEMBER_LIMIT`、`FORMATION_FAILED`、`CAPABILITY_UNAVAILABLE`、`BLUEPRINT_REVISION_MISMATCH`、`RESOURCE_CONFLICT`、`STALE_REVISION` 和 `DELIVERY_FAILED`，Session Projection 只保留紧凑团队阶段、名册、计数和摘要，完整讨论与产物记录继续使用分页且由事件支持的读取，使 Session tail 不会复制整个团队历史

Demo 执行环境保持单进程和共享 checkout，软件开发领域默认分配一名活跃写入者，并让其他专家担任评审者或测试者，不相交的资源作用域可以允许并行写入者，但建议性所有权不声称提供文件系统锁或合并隔离

## Evaluation baseline

机器校验的[协作评估语料](../../../../scripts/fixtures/collaboration-evaluation-corpus.json)包含十个调研分析、十个产品方案和十个软件开发任务，每个领域包含三个简单、四个中等和三个复杂案例，语料还固定了可见性策略，以及创建、能力解析、工具、结构化输出、重放、并发、讨论上限、产物、重启、重连、取消和停滞故障预演

## Relationship to current decisions

现有多智能体运行时和浏览器决策提供实现证据，而不是本产品提案的约束，现有约定与当前产品需求及验收语料冲突时，实现通过所属扩展点原子地替换该约定

[持久 Agent Teams 决策](../../implemented/feature/2026-08-05-agent-teams.md)在晋升替换这些约定前，继续负责已经交付的实验性名册、mailbox、任务和共享 checkout 行为，[实验性包决策](../../implemented/architecture/2026-08-18-experimental-agent-teams-packages.md)在稳定 collaboration group 落地前，继续把当前包排除在发布之外，[协作 Playground 决策](../../implemented/feature/2026-08-17-collaboration-playground.md)在 Host-backed 协作投影替换其浏览器本地任务权威和标题前缀识别前，继续负责现有浏览器功能

## Alternatives considered

**保持 Agent Teams 可选**：否决，因为产品要求把团队定义为每个任务的执行单元，自适应规模和拓扑控制开销，但不允许 Lead-only 成功路径

**只通过协调者提示词表达组队和协作**：否决，因为提示词无法跨替代调用方强制容量、能力准入、权限、事件可见性、终止、完成检查或恢复不变式

**允许每位专家无边界地与其他全部专家通信**：否决，因为通信量按平方增长，并且可能在执行开始前耗尽任务预算，拓扑限制候选者和轮次，同时保留相关 peer 之间的直接质疑

**保持浏览器任务卡为产品权威**：否决，因为浏览器存储无法负责生命周期、持久性、重放、取消或跨 Client 恢复，浏览器只拥有查看状态，并从 Host 投影派生产品状态

**围绕团队重写 agent loop**：否决，因为现有 Session、Agent、preset、工具、skill、subagent 和事件扩展点已经拥有所需行为，修改循环会扩大回归面，并把一种产品组合耦合到可替换 driver

## Acceptance criteria

- 每个被接纳的产品任务在任务执行前创建一个包含一名 Lead 和至少一名专家的 TeamRun
- 简单、中等和复杂任务分别强制一名、两至四名和五至八名专家的区间
- 组队失败可以在创建预算内重试，但不能以少于计划最低值的团队静默继续
- 每位专家使用经过校验且不可变的 ExpertBlueprint revision，并以同一组合恢复
- 协作规则、权限、轮次上限、预算和完成检查由运行时操作强制执行
- 公开投影包含完整类型化协作记录，并排除私有推理和 chain-of-thought 内容
- Lead 恢复通过持久记录重建名册、任务、公开消息、ledgers、产物、决策和终态交付
- 三十个案例的本地语料在 Host 和浏览器产品组合上通过硬功能检查

## Risks

每个任务至少消耗两个模型上下文，因此简单任务的时延和 Token 使用会增加，产品必须展示预算并保留单专家路径，而不是隐藏这项成本

即使工作可分解，八名专家也可能使 mailbox、UI 和 Lead 上下文过载，候选过滤、分组拓扑、轮次上限、事件投影限制和分阶段激活需要在 Demo release candidate 前获得压力覆盖

晋升实验性包会原子地改变路径、npm 名称、配置项、生成目录和快照，预发布仓库允许这项改变，但部分晋升会违反实验性依赖隔离

当前 worktree 包含相互重叠且尚未提交的协作和 conversation UI 工作，实现阶段必须保留其基线，在每个阶段开始前分配文件 owner，并避免把无关修改混入协作改造
