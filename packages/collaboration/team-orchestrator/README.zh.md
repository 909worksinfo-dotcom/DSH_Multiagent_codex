# @deepseek-ai/dsh-team-orchestrator

[English](README.md) | 中文

基于稳定 TeamRun 与 ExpertRuntime 服务的自动 Task Profiler、Team Planner、Team Charter 和关闭式组队包。每个已准入任务都会创建一个由 Lead 拥有的 TeamRun、选择确切不可变 ExpertBlueprint revision，并且只有在计划 roster 全员就绪后才能进入 `active`

## 配置

```yaml
- id: team-orchestrator
  name: '@deepseek-ai/dsh-team-orchestrator'
  config:
    maxTextBytes: 16384
    maxWorkstreams: 16
    maxListItems: 32
    maxContextEntries: 32
    maxEventBytes: 1048576
    communication:
      simple: { maxChallengeRounds: 1, maxMessagesPerExpert: 4 }
      medium: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 }
      complex: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 }
    pools:
      - domain: research_analysis
        blueprints: [{ id: research-analyst, revision: 1 }]
      - domain: product_solution
        blueprints: [{ id: product-strategist, revision: 1 }]
      - domain: software_development
        blueprints: [{ id: software-engineer, revision: 1 }]
```

配置必须为三个首批领域各提供一个有序 pool。每个领域的 pool 至少需要八个不同的确切 revision，才能覆盖该领域的所有 complex 任务。文本、列表、workstream、context 和完整 event 的限制会在持久化日志之前拒绝过大的保留输入

## 分析与规划

`create()` 会保留原始 objective，在没有 hint 时推断 domain，把显式 workstream 标准化，或根据多语言分隔符与任务动作信号生成有界 workstream，再计算依赖深度、能力密度、可拆解性和风险指标。确定性专家区间为 `simple = 1`、`medium = 2..4`、`complex = 5..8`。可选 `productTitle` context 会参与推断，但不会改写展示用 objective

planner 会按稳定能力相关性和配置顺序排列确切 revision。simple 任务使用 `producer_reviewer`，medium 任务使用 `centralized` 或 `parallel`，complex 任务使用 `hybrid` 或 `grouped`。容量不足或 revision 不可用会把 P1 run 终止为 `formation_failed`，绝不会只保留 Lead 继续执行

charter 会在 provisioning 开始前提交 objective、success criteria、确切 roster、task DAG、topology、communication limit、quality check、每位专家的 execution budget 和关闭式 termination rule。orchestrator 随后会根据该精确 charter 与已提交 catalog revision 物化一份不可变 TeamRun protocol：每个 slot 在专家 provisioning 可成功前都会获得对应 blueprint 权限与确定性 topology route

## 服务操作

- `create(lead, request)` 创建或幂等恢复 profile、plan 和 charter
- `form(lead, command, signal)` 会物化或校验 Charter task DAG 与质量门，通过 `ctx.expertRuntime` provision 或恢复每位计划专家，并且只在精确满编时激活
- `orchestrate(lead, request, signal)` 是一键执行 `create` 加 `form` 的入口
- `retry(lead, command, signal)` 幂等恢复尚未终态的 provisioning run，不重放已经接受的 child 工作
- `replaceExpert(lead, request, signal)` 会把一个 active 运行中的 failed member 幂等绑定回持久 roster slot，通过 ExpertRuntime provision 下一次不可变 attempt，并把失败 attempt 保留为审计行
- `cancel(lead, request)` 记录终态取消，同时保留当前审计
- `get(lead)` 与 `list()` 投影当前 live Lead 的持久状态；如果失败发生在提交之前，`plan` 和 `charter` 会缺失

P1 终态不可变。对终态 `formation_failed` 或 `cancelled` run 重试会返回其稳定错误；用户要求重新尝试时，产品会创建新的 Lead 和 TeamRun，并用 `retryOf` 关联旧请求

## 持久化与恢复

Lead Session 会存储读取时必需的 `collaboration/orchestration/profile`、`collaboration/orchestration/plan` 和 `collaboration/orchestration/charter` event。request、plan 和 charter digest 会拒绝不匹配的重试与被篡改的持久值。独立 `./invariant` companion 会在发布前，对照所属 P1 TeamRun 和当前 event prefix 校验每个候选 event

组队身份由已提交 request digest 与 roster slot 派生。专家激活前，稳定的依赖优先遍历会把 Charter DAG 物化为 P1 task，即使依赖项出现在输入后方也一样，同时 Charter quality check 会变成精确的有序 gate 前缀。同一次遍历会幂等物化精确 protocol；recovery 会根据持久 plan、charter 与 catalog 比较 topology、limit、权限和 route，并在漂移时关闭式失败。retry 只接受完全一致且未被修改的前缀，只创建缺失行，同时恢复已有 P2 attempt，通过 ExpertRuntime 校验不可变能力 binding，并绝不重复 provision 已接受的 slot。active replacement identity 还包含单调派生的 slot generation，因此重复同一替换命令会恢复或返回相同 attempt，替换后来再次失败的 replacement 则必须寻址该 failed member。发生偏离的 task、quality-gate 或 protocol 状态会 fail closed，冷恢复后也不例外。初始 provider failure 由 P2 补偿，随后 P3 明确提交 `formation_failed`；replacement provider failure 会让 active run 保持 blocked 并保留失败审计，绝不会伪报恢复；取消会提交 `cancelled`

## 模型体验

### 团队设计记录

#### 模型看到的内容

本包不会注入 prompt，也不会暴露私有思考过程。它的 `collaboration/orchestration/*` record 会保留公开任务结构，并把每个计划 assignment 交给 ExpertRuntime；后者记录的初始专家 prompt 负责模型可见的 role、input、output、acceptance 与 collaboration instruction

#### Token 影响

profile、plan 和 charter event 只存在于日志，本身不会增加模型 token。计划 assignment 文本会通过 ExpertRuntime 进入每个 child 的初始 prompt

#### KV Cache 影响

orchestrator 不会在 Agent 之间共享 cache。每个已 provision 专家仍是独立 continuable child，其 preset、model route 与 KV Cache 生命周期由 ExpertRuntime 强制执行

## 已知限制与暂缓工作

- **确定性 Demo profiler** — domain 与 complexity 推断使用有界多语言文本和任务信号，而不是 LLM 语义分类器；评测 fixture 仍可显式提供 domain 与 workstream
- **配置候选 pool** — planner 只会选择部署配置已准入的确切 revision，不会发现或生成 ExpertBlueprint
- **精确前缀 task 恢复** — orchestration 只负责初始 Charter 物化，后续 task owner、edit、claim 和 completion 仍由 P1 collaboration command 负责，激活前的任何偏离都会被拒绝，不会合并
- **live-host 列表** — `list()` 只投影当前已注册 Lead Agent，基于 persistence 的跨进程历史查询属于 Host query 层
- **单进程命令串行化** — 每个 Lead 的 orchestration command 与 P1 CAS retry 不会跨多个 harness 进程形成分布式事务
