# Agent Note：不可变 ExpertBlueprint 运行时绑定

Status: implemented

[English](2026-08-26-expert-blueprint-runtime-binding.md) | 中文

## Problem

稳定 TeamRun 领域可以预留和结算专家 roster attempt，但 P1 有意不决定每名专家使用哪个 preset、skill、plugin、tool、模型路由、persona 或执行限制，因此仅有 roster row 不能证明 active 成员是具备必需能力的真实 child

continuable child 历史上继承 Lead composition，这对通用委派有价值，但进程重启后无法复现专家专属 composition，如果激活时只解析可变的 blueprint 名称，preset 或 skill 变化还会静默改变已经接受的团队

## Decision

[`@deepseek-ai/dsh-expert-catalog`](../../../../packages/collaboration/expert-catalog/README.md)拥有本地配置的不可变 `ExpertBlueprint` revision，revision 声明角色、目标、preset、skills、plugin rows、tool policy、model policy、可选 persona、结构化输入输出、验收标准、协作权限与执行预算

Catalog resolution 要求精确 preset source、静态启用的必需 plugin rows，以及 preset standing scope 中模型可调用的 winning skill definitions，它记录 blueprint、preset source 和每个 resolved skill 的 SHA-256 digest，再基于完整 resolved capability set 派生一个 canonical binding digest，缺少 revision、preset 损坏、必需 plugin row 动态或关闭、skill 缺失或能力不可读都会以 `CAPABILITY_UNAVAILABLE` 失败，不会通过省略必需能力进行降级

[`@deepseek-ai/dsh-expert-runtime`](../../../../packages/collaboration/expert-runtime/README.md)是 Catalog、稳定 TeamRun transition 与 continuable subagent 之间的适配器，provisioning 在消耗 attempt 之前解析能力与 provider 可用性，随后预留 P1 roster row、flush 不可变 Lead-side binding、创建精确 child Session、写入匹配的 child descriptor、挂载选定 preset 与限制、发布 child、提交 P1 activation，最后才准入首条专家 prompt

reservation 之后任一步骤失败时，runtime 会把 child drain 到 quiescence 并把 attempt 记录为 failed，这个补偿也覆盖 child 已发布但首条 prompt 尚未准入的窗口，`completing` 期间仍禁止新增组队，但迟到的 active expert failure 会持久记录，从而拒绝精确团队完成并要求 Lead 将运行终止为 failed

## Durable composition and recovery

Lead Session 拥有 `collaboration/expert/binding`，child 拥有 `collaboration/expert/descriptor`，两种记录都携带精确 TeamRun、member、Session 与 attempt 身份，以及完整不可变 capability descriptor，descriptor 还包含绝对 deadline 和有效 turn 与 output-token 限制

continuable subagent descriptor 升级到 version 3，并持久保留显式 agent preset、resolved provider、model、最大输出 token、persona 和 tool restrictions，因此 fresh creation 与 cold resume 使用同一 composition，而不是继承 Lead 或 Catalog 当前暴露的内容

每次 fresh activation、recovery、cold follow-up 与 pre-model step 都会校验 parent binding、child descriptor、当前 Catalog resolution 和完整派生 composition，descriptor 缺失、身份不匹配、能力变化或 binding 漂移都会以 `BLUEPRINT_REVISION_MISMATCH` fail closed，恢复会复用 live child 且不重放，只在持久 child 从未接受保留 prompt 时才 cold resume 并补发该 prompt，同时拒绝 child 身份已经消失的 active roster row

## Budget enforcement

blueprint turn limit 只统计 child Session 在 descriptor 之后的自身 turn，不包含继承历史，有效模型输出上限取 model policy 与 blueprint token budget 中的较小值并保留在 continuable descriptor 中，持久绝对 deadline 会为 fresh 和已经 live 的 expert Agent 安装取消 timer，budget 或 drift 拒绝会在下一次 model step 开始前记录 active expert failure

## Scope boundary

P2 提供精确 revision 的专家创建与恢复原语，[自动组队决策](2026-08-26-automatic-team-formation.md)将它们与 Task Profiler、Team Planner、Team Charter、Host transport 和权威浏览器投影组合，有边界讨论编排与 Lead 完成策略仍属于后续阶段，P2 不修改可替换 agent loop

## Verification

包测试覆盖不可变 Catalog snapshot、严格 blueprint validation、preset 与 plugin resolution、skill digest、能力缺失与动态能力、确定性 prompt rendering、binding 与 descriptor folds、fresh provisioning order、rollback、cold recovery 不重复执行、capability drift、篡改记录、并发 revision retry、follow-up authorization 以及 turn、token 与 deadline budget，真实 provider 集成测试会组合 Loader、Agent presets、ExpertCatalog、TeamRun、JSONL persistence、SubagentRuntime、`spawn` in-process provider 与 AgentLoop，再从 persistence 重新读取已接受的 child result 与两种 descriptor，仓库 type、lint、package invariant、generated document、translation、build 和本地 browser regression 门禁包含新增稳定包

## Alternatives considered

**让每名专家继承 Lead preset**：否决，因为不同专业能力是产品需求，继承 composition 无法证明或复现专家专属 binding

**只持久化 ExpertBlueprint id**：否决，因为重启后同一 id 可能解析为变化后的 preset、plugin 或 skill 内容，精确 revision 与 content digest 可以让漂移可观察

**先创建 child 再写 TeamRun state**：否决，因为 child 可能在没有可审计 roster attempt 或持久 parent binding 的情况下执行，有序 transaction 使每个 published child 都能追溯到 P1 authority

**静默移除不可用能力**：否决，因为缺少必需 skill 或 plugin 的名义专家违反计划团队，也会让成功组队产生误导

**在 `agent-loop` 增加专家分支**：否决，因为 preset mounting、scoped tools、continuable children、Session events 和 pre-step interception 已经提供所需 extension points，并具有更小的 regression surface

## Consequences

P2 把 P1 roster attempt 转变为可复现 expert runtime，并提供 fail-closed recovery 与可观察 capability identity，后续 planning 可以选择精确 Catalog revision，而不拥有 child mechanics 或 persistence

每次 expert activation 现在都会承担 capability resolution 与 digest validation 成本，本地 capability 编辑会有意阻止旧 binding，而不是静默恢复，operator 修改已经接受的专家 composition 时必须新增 blueprint revision
