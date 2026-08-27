# @deepseek-ai/dsh-expert-runtime

[English](README.md) | 中文

在稳定 TeamRun 迁移上按 ExpertBlueprint 绑定 continuable child Agent 的 provisioning 包。`ctx.expertRuntime` 会解析确切 catalog revision、预留 P1 roster attempt、持久化匹配的 Lead 与 child 能力 descriptor、通过 continuable subagent provider 创建真实 child、在初始 prompt 准入前激活 P1，并补偿每条失败路径，绝不回退成单 Agent

## 配置

```yaml
- id: expert-runtime
  name: '@deepseek-ai/dsh-expert-runtime'
  config:
    subagentProvider: spawn
    maxInitialPromptBytes: 65536
```

所选 provider 必须实现 continuable creation。`maxInitialPromptBytes` 会限制 fresh provisioning 与 recovery 的完整 UTF-8 prompt。服务需要 Agent、Session、Session persistence、TeamRun、ExpertCatalog 和 subagent 服务

## Provisioning 事务

`provision()` 会先解析请求的不可变 blueprint 并校验 assignment，再消耗 attempt。它会计算包括 Lead route 继承在内的有效 provider、model 与 output-token ceiling，并把 runtime 派生 composition 与 catalog digest 一起计算 hash。顺序为 P1 `beginExpertProvision()`、追加并 flush Lead binding、使用精确 preset／persona／tool policy 创建并发布 child、在未发布 setup 期间追加 child descriptor、P1 `succeedExpertProvision()`，最后准入首条 prompt

任何 provider、setup、activation hook 或 prompt admission 失败都会先 drain child，再把不可变 P1 attempt 改为 `failed`。P1 CAS settlement 会跨无关 TeamRun 并发写入重试。能力缺失、descriptor drift、turn 耗尽和 deadline 到期都会保留结构化公开失败，绝不会静默缩减团队能力

集成测试还会挂载真实 Loader、Agent preset roster、ExpertCatalog、TeamRun、JSONL persistence、SubagentRuntime、`spawn` in-process provider 与 AgentLoop，验证真实 child 只携带 blueprint 选中的 preset tool 进入模型，再从 persistence 重新读取两种 P2 descriptor 与回答

## 恢复与漂移校验

Lead 与 child 日志会保存完整 catalog descriptor、有效模型 route、runtime composition digest、execution budget 和确切 attempt 身份。独立 subagent v3 descriptor 也必须匹配 provider、label、model route、`maxTokens`、preset、persona 和 tool filter。冷恢复与每次模型 step 前都会重新解析当前 catalog、preset、plugin 和 skill 内容

恢复会区分三种状态。没有 child 的 provisioning attempt 会重建 child 并只准入一次保留 prompt。存在 persisted descriptor 但没有匹配初始 `user/message` 时，会冷恢复并只准入一次该保留 prompt。live child 或已经记录确切 prompt 的 persisted child 只会在必要时激活，不会重放工作。active P1 行缺失 child 会关闭式失败

冷 activation 使用彼此独立的引用计数 authorization token。通用 `ctx.subagents.followup()` 无法绕过本校验路径冷恢复专家。只有 TeamRun 处于 `active` 时才接受公开 expert followup；completing 和 terminal run 会拒绝新增专家工作

## 执行预算

blueprint 的有效 `maxTokens` 会传入 continuable creation，并由 subagent v3 descriptor 保留供冷恢复使用。`maxTurns` 只统计 expert descriptor 之后属于当前 child 的 `turn/start` event，因此继承的 fork turn 不消耗预算。持久化绝对 deadline 会在 fresh creation、cold publication 和 plugin reload 时安装 timer，pre-step hook 也会在模型进入前立即复查

## 读取时必需的不变式

独立 `./invariant` 配套模块会在发布前，对照已提交 P1 roster 行校验每个候选 Lead binding，并对照确切 live parent binding 校验每个 child descriptor。能够读取这些 event 的 profile 必须同时挂载 TeamRun 与 expert-runtime companion

## 模型体验

### 初始专家 assignment

#### 模型看到的内容

child 会收到一条 user-role prompt，其中包含公开 name 与 role、responsibility、assignment objective 与命名 input、required output、acceptance criteria、collaboration permission、已挂载 skill name，以及要求公开 conclusion、evidence、uncertainty、challenge 和 handoff 且不暴露 private reasoning 的说明。动态用户输入会在严格 field 与 byte 校验后原样加入，`collaboration/expert/binding` 与 `collaboration/expert/descriptor` 则只存在于日志

#### Token 影响

初始 assignment 的 token 消耗与 blueprint 和 task 文本长度成正比。后续 followup 会追加普通 user-role content。skill 正文不会复制进该 prompt，lifecycle descriptor 只存在于日志

#### KV Cache 影响

每个 expert 都是独立 Agent，拥有独立请求前缀和 KV Cache 生命周期。冷恢复会在追加新工作前恢复相同 preset、model route、persona、tool 和 token ceiling，不会共享 Lead 的 KV Cache

## 已知限制与暂缓工作

- **没有 P3 自动组队设计** — 调用方仍需选择 blueprint revision 与确切 expert 身份，profiler、planner、charter 和 topology selection 属于后续阶段
- **每次请求的 token ceiling** — 每次模型请求都会强制 `maxTokens`，但 aggregate task-token accounting 尚未成为持久 ledger
- **单进程事务 owner** — P1 CAS 重试和 child lifecycle coordination 不会跨多个 harness 进程形成分布式事务
- **没有自动公开 peer transport** — TeamRun 记录公开 collaboration fact，更高阶段决定这些 fact 何时唤醒或通知另一名 expert
- **没有静默回退** — provider、preset、skill、plugin、child 或匹配 revision 缺失都会形成可见 failure，并要求 retry 或 replacement
