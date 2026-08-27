# Agent Note：自动且失败关闭的团队组建

Status: implemented

[English](2026-08-26-automatic-team-formation.md) | 中文

## Problem

稳定 TeamRun 状态和不可变专家创建提供了 P1 与 P2 的强制原语，但它们都不会把用户目标变成完整团队，产品调用方仍需要一个权威机制完成任务画像、精确名册选择、协作规则提交、全部成员创建、浏览器展示，以及不降级为 Lead-only 的失败表达

Demo 产品还需要让组队在刷新和重启后可恢复，同时不能把权威状态放进浏览器存储，也不能暴露 preset source、skill path、prompt body、composition digest 或模型私有思考

## Decision

[`@deepseek-ai/dsh-team-orchestrator`](../../../../packages/collaboration/team-orchestrator/README.md)拥有自动 Task Profiler、Team Planner、Team Charter 和精确人数组队，它在通过 P2 runtime 创建专家之前，先把 required-on-read 的 `collaboration/orchestration/profile`、`collaboration/orchestration/plan` 和 `collaboration/orchestration/charter` 事件提交到 Lead Session

确定性的 Demo profiler 会归一化目标、成功标准、workstream、依赖、能力信号、工具密度和风险，它为简单任务分配恰好一名专家，为中等任务分配二至四名专家，为复杂任务分配五至八名专家，planner 从一个已配置领域池选择精确不可变 blueprint revision，并只选择该复杂度允许的 topology，charter 冻结目标、成功标准、任务 DAG、topology、通信限制、质量检查、逐专家预算和 fail-closed 终止规则

只有每个计划 slot 都获得已接纳的 P2 专家 binding 和 child Session，组队才会进入 `active`，能力不可用、容量耗尽、创建失败、取消或持久状态无效都不能产生缩水的成功团队，请求、plan、charter、binding 和 descriptor 校验使 replay 保持幂等并拒绝 composition drift

## Product composition

Web bundle 挂载稳定 TeamRun、Expert Catalog、Expert Runtime、Team Orchestrator、模型可调用的团队工具、二十四个精确 blueprint 和三个首批专业 skill 定义，调研分析、产品方案和软件开发三个池各包含八个不同的已配置 revision，因此 planner 无需虚构能力即可组成最大复杂团队

[`packages/host/apiproxy`](../../../../packages/host/apiproxy/README.md)基于真实 orchestration service 暴露 create、list、get、中断组队重试和 cancel 操作，cold listing 会恢复持久日志中包含 orchestration profile 的 Lead Session，浏览器值使用严格 allowlist projection，只允许 capability id 与 label 通过边界，不允许 source path、prompt text、persona、原始 config、digest、cause 和私有思考通过

[`packages/client/runtime`](../../../../packages/client/runtime/README.md)拥有可安全重连的协作 snapshot 和产品命令，创建流程在调用 Host 组队前分配新的 Lead Session，用户重试终态 `team_formation_failed` 时会创建带有 `retryOf` 的全新 Lead 与 TeamRun，失败运行保持不可变并继续展示以便审计，协作 UI 只保存导航和草稿状态，并展示权威 runtime profile、charter、roster、能力标签、状态和显式失败

## Scope boundary

本决策实现更广泛的[天然多智能体协作提案](../../proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md)中的自动组队部分，类型化专家讨论、质疑与回应轮次、可变 task ledger 协调、artifact、decision、Lead 完成检查和 FinalDelivery 仍属于后续阶段，当前 profiler 是确定性的多语言 Demo 分类器，不是 LLM 语义 planner

## Verification

包测试覆盖复杂度分档、合法 topology 选择、精确 roster planning、charter 构建、幂等 replay、取消、能力与创建失败、fail-closed 终态、cold recovery、浏览器安全 wire schema、全新运行重试、runtime refresh，以及 UI 组队与失败流程，仓库 type、lint、build、package invariant、skill metadata、document、GUI、web snapshot 和本地浏览器检查覆盖组合后的产品

## Alternatives considered

**让 Lead prompt 直接创建专家**：否决，因为 prompt 行为无法在所有调用方上强制精确人数区间、不可变能力绑定、幂等 replay 或终态组队失败

**把团队计划保存在浏览器状态**：否决，因为刷新、重连、取消和跨客户端读取需要持久 Host authority，浏览器持久化也无法校验 capability composition

**原地重试终态失败**：否决，因为终态 TeamRun 是不可变审计证据，新 Lead 和 `retryOf` 链接可以同时保留失败尝试与用户的新尝试

**向 UI 返回内部 binding record**：否决，因为 roster 需要的是能力身份，而不是本地 path、prompt、digest 或私有执行 config

## Consequences

每个被接纳的产品任务在执行开始前都会拥有 Lead 和至少一名完成能力绑定的专家，复杂任务可通过同一路径组成八专家团队，用户可以在协作页面检查自动 profile、charter、完整 roster 和显式组队失败

确定性 profiler 选择可复现性和本地验证，因此牺牲了一部分语义灵活度，已配置 pool 及其精确 blueprint revision 属于部署策略，增加新领域或能力组合时必须显式扩充
