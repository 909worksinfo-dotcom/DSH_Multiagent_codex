# Agent Note: 有界团队协作协议

Status: implemented

[English](2026-08-26-bounded-team-collaboration-protocol.md) | 中文

## 问题

P3 Team Charter 记录 topology 与 communication limit，精确 ExpertBlueprint revision 记录协作权限，但 P5 公开消息准入并未强制它们。专家可以向任何 active 参与方发布消息，challenge 关系只是可选引用，而不是有序协议，浏览器则必须自行推断某个 target 或下一 round 是否合法

产品还存在日志中没有 protocol 的持久 P3-P5 TeamRun。P6 强制边界必须经受 JSON 回放与冷 Host recovery，且不得重新解释这些旧 run；每次拒绝都必须保持 message、cursor、ledger、revision 与 provider 状态不变

## 决定

[`@deepseek-ai/dsh-agent-team`](../../../../packages/collaboration/agent-team/README.md) 在 Lead Session 日志中持有一份不可变协作协议。新的读取时必需事件 `collaboration/protocol` 保存 topology、最大 challenge round、每个专家的最大公开消息数，以及每个计划 slot 的一条精确规则。每条规则保存 slot identity、初始 member identity、公开名称、从已提交 blueprint revision 复制的 `challenge`/`review`/`requestHelp` 权限，以及可用 peer slot identity

[`@deepseek-ai/dsh-team-orchestrator`](../../../../packages/collaboration/team-orchestrator/README.md) 会在 profile、plan 与 charter 提交后、专家可进入 active 前物化该记录。该操作按 compare-and-set 串行，并对相同记录保持幂等。recovery 会根据已提交 plan、charter 和精确 catalog revision 重新派生该记录；topology、limit、权限、slot identity 或 route 不同时会以 `TEAM_PROTOCOL_REQUIRED` 关闭式失败

初始与 replacement provisioning attempt 会携带 `protocolSlotId`。failed attempt 保留该 slot 供审计，后续不可变 replacement 可重用该 slot，同时获取新的 member、Session 与 attempt identity。member 不能冒领另一 slot，enforced run 也不能激活未绑定专家

## 准入与路由

专家撰写的每条 `collaboration/message` 都会消耗对应 slot 的公开消息预算，包括专家 artifact 写入生成的公开 receipt。准入会在任何追加或 ledger 变更前检查预算、blueprint 对 `challenge`、`review` 或 `request_help` 的权限和已解析 target。稳定拒绝使用 `TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED`、`TEAM_PROTOCOL_PERMISSION_DENIED` 和 `TEAM_PROTOCOL_TARGET_DENIED`

Topology route 具有确定性。`centralized` 与 `parallel` 只允许 Lead，`producer_reviewer` 允许所有其他专家，`hybrid` 允许相邻计划 slot，`grouped` 允许每个两 slot 分组中的另一个成员。Lead 始终是可用协调 target，且不计入专家预算。Lead 可以跨 roster 协调，但原始 `decision`、`artifact` 与 `final_delivery` 消息不能绕过权威 ledger 或 completion 操作

专家 artifact 写入会在 artifact batch 前预检其生成的公开 receipt。receipt 显式以 Lead 为 target，因此 centralized 与 parallel 团队可以贡献 artifact。被拒绝的写入既不追加 artifact 也不追加 message，且不推进 version、revision 或 cursor

## Challenge 协议

`challenge` 与对应 `response` 使用一个显式 dispute thread、一个 challenge id 和一个显式 target。challenge 不得把 author 作为 target，也不得重用 id。在先前 round 得到回应前，同一 thread 不得再打开一个 challenge，且 round 数不得超过持久 Charter limit。response 必须使用同一 thread 与 id，由原 target 撰写，并以原 challenger 为 target。孤立、并行、重复、参与方错误和超过 round 的记录会在追加前以 `TEAM_CHALLENGE_INVALID` 或 `TEAM_CHALLENGE_ROUND_LIMIT` 失败

replay fold 会重建每个已关联 round、challenger、target、challenge message、response message、sequence number 和确定性 `open` 或 `responded` 状态。存在任何 open challenge 的 enforced run 都不能完成；`completeRun()` 会在三事件 completion batch 之前返回 `DELIVERY_FAILED`

## 投影与兼容性

TeamRun 暴露一个权威可辨识 protocol 投影。`enforced` 模式包含 topology、正数 limit、一至八条 member row 和 challenge row。每条 member row 携带当前已绑定 member、phase、权限、可用公开名称、已用消息和剩余消息。[`packages/host/apiproxy`](../../../../packages/host/apiproxy/README.md) 映射同一白名单 shape，并拒绝 legacy 模式携带 limit 或 enforced 模式不携带 member 等不可能混合状态

不含 `collaboration/protocol` 的日志会投影为精确 `legacy` 模式，topology 与 limit 为 null，member 与 challenge 为空。其 P3-P5 公开发送与 completion 行为在冷恢复后保持不变。P6 不会静默追加 protocol、根据当前配置推断 protocol，也不会原地迁移历史审计

[`@deepseek-ai/dsh-tool-agent-team`](../../../../packages/collaboration/tool-agent-team/README.md) 会向 Lead 与专家返回该投影，并要求它们遵守用量与 route。通用 send tool 排除属于 ledger 的 decision、artifact 和 final-delivery kind。challenge 与 response 调用必须携带显式 dispute thread、一个 target 和 challenge id；只有普通消息可默认使用 `main`

## Wakeup 边界

P6 不会在公开消息后自动调用 Agent 或 subagent wakeup。可用 continuation 调用没有持久 route receipt、因果 delivery identity、compare-and-set ownership，也没有与已提交消息关联的 replay-safe 幂等性。在追加后调用会产生无法重建的副作用，在追加前调用则可能为永未提交的消息唤醒参与方

因此，已交付边界会持久准入并暴露权威可用 route，但不会隐式递归。后续 delivery worker 只能在拥有独立持久 outbox、delivery attempt identity、有界重试策略、取消行为和 replay 投影后添加 wakeup

## 验证

TDD 覆盖从缺少 protocol 操作的探针开始，随后验证精确物化、幂等 retry、protocol 漂移、topology 与权限拒绝、专家预算耗尽、centralized artifact 路由、ledger kind 绕过拒绝、有序 challenge 与 response round、open-challenge completion 拒绝、JSON replay、legacy 冷恢复、严格 Host schema 状态、模型 tool 输出，以及根据不同 blueprint 权限派生的复杂八专家 grouped route

每个拒绝测试都会比较调用前后的完整 TeamRun 快照与物理 Session event 数。artifact 预算覆盖还会比较 artifact version 与 ledger 内容。包类型检查、lint、collaboration 测试、Host 测试、export JSDoc、persistence catalog 生成和双语文档门禁会覆盖组合边界

## 考虑过的备选方案

**只把协作规则保留在 prompt 中。**已拒绝，因为 prompt 无法向所有调用方与 replay 路径强制预算、target、参与方、ledger ownership 或 completion 不变式

**让浏览器推断 route 与 challenge 状态。**已拒绝，因为根据 UI roster 顺序派生授权会创建第二个陈旧策略引擎，并可能在 replacement 或 reconnect 后发生分歧

**在追加后自动唤醒可用 target。**已暂缓，因为当前副作用没有持久 outbox 或 replay-safe delivery identity。best-effort 调用会使事件日志无法继续描述实际执行内容

**使用当前 Charter 或 catalog 值改造旧 run。**已拒绝，因为历史日志可能早于这些精确输入，静默改变其准入行为会破坏冷恢复与审计含义

**把 Lead 计入专家消息预算。**已拒绝，因为该预算用于约束 per-expert 贡献，Lead 则持有协调、裁决与 delivery。Lead 仍然受 run-wide 公开消息 limit 与权威 ledger 命令约束

## 后果

新团队现在拥有可强制且可检查的规则，不再只有建议性 topology。专家只能在持久能力、route 与预算内发起 challenge、review、request help、共享 artifact 和回应 dispute，Lead 则保留有界协调能力，且不能绕过 ledger ownership

一个 run 内的 protocol 不可变，route 具有确定性而不是自适应，强制机制依托现有 per-Lead Session journal queue 保持单进程。旧 run 仍可见，但不获得 P6 强制。在持久 delivery 机制接管该副作用前，自动 peer wakeup 会继续明确缺席
