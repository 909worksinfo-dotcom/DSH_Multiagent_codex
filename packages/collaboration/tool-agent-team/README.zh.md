# @deepseek-ai/dsh-tool-agent-team

[English](README.md) | 中文

稳定 [`ctx.teamRuns`](../agent-team/README.md) 领域的 scoped 模型适配器。它只在 live Lead 或 active 专家 scope 中安装一份公开协作策略和十三个有界工具。它永远不拥有 formation、provisioning、lifecycle、task、ledger 或 message 状态，因此领域服务仍是唯一真相源

## 配置

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
  config: {}
```

适配器没有部署调节项。团队规模、attempt、task 和公开消息限制属于稳定领域配置，并会快照保存到每个 TeamRun

## Scoped 安装与权限

插件会在启动时以及 Agent 或 TeamRun 事件发生后对当前 Agent 进行对账。Lead 在显式创建运行后获得工具。只有 child 的直接 parent 是 Lead，且预留 Session 身份属于 active 专家行时，child 才能获得工具。failed、unrostered、disposed 和 stale Agent 实例不会保留这些注册

每个命令都会把完全相同的调用 Agent 传给 `ctx.teamRuns`，描述和 prompt 策略不是权限边界。插件 HMR 会移除所有 scoped 策略和工具注册，替换 generation 可为当前成员重新安装，而不修改 TeamRun 状态

稳定工具名特意与实验性 Agent Teams control 区分，因此两个包可以同时加载，不会发生全局名称冲突：

- `collaboration_get` 返回生命周期、精确计划、专家 attempt 审计行、容量和结构化失败
- `collaboration_send` 提交一条类型化公开记录，并返回不重复 caller 自有内容的紧凑 receipt
- `collaboration_complete` 仅允许 Lead 在全部 P5 账本与公开证据要求通过后原子发布 final delivery
- `collaboration_artifact_write` 和 `collaboration_artifact_read` 写入有界 CAS 版本并显式读取一份受限正文
- `collaboration_decision_write` 仅允许 Lead 提交带公开证据的裁决
- `collaboration_quality_update` 仅允许 Lead 结算一个已物化质量门
- `collaboration_controller_get` 读取确定性健康状态与建议
- `collaboration_control` 仅允许 Lead 原子 reassign、rework 或 replan 一个任务
- `collaboration_task_create` 创建一个带 blocker 和通用建议性 resource scope 的 pending 任务
- `collaboration_task_list` 最多返回 100 个任务，使用 cursor 分页，默认 limit 为 50
- `collaboration_task_get` 返回一个完整的最新任务 view
- `collaboration_task_update` 执行一个 CAS 任务操作

适配器刻意不向模型提供 TeamRun 创建、复杂度选择、专家 provisioning 或 provider settlement 工具。这些操作属于 runtime controller 以及 P2/P3 包

## 公开协作策略

策略要求每个成员在基于陈旧信息行动前读取权威 protocol 状态，遵守剩余消息预算与可用目标，在 CAS 更新中使用任务 revision，把 `resource_scopes` 视为建议性标签，并发布简洁、用户安全的事实。所有持久消息 kind 在结构上都是公开的，但 `collaboration_send` 排除属于权威账本命令的 decision、artifact 与 final-delivery receipt。`private_reasoning` 和 chain-of-thought 没有 schema 路径

`collaboration_send` 只在领域关系合法时接受类型化引用。challenge 与 response 必须使用同一显式非默认 dispute `thread_id`、一个显式 target 和同一 `challenge_id`；普通消息可以默认使用 `main`。其结果保留稳定 message、event、run、thread、cursor、author、target、reference、time、kind 和 visibility 字段，但会省略 caller 刚提供的 content。即使领域允许较大的公开记录，也能限制重复模型上下文

串行路由器只在当前发送者进入空闲状态后推进。它会重新读取权威 run、总结相关上下文、规划一个下一步动作、选择唯一一名符合条件的接收者，并将公开内容生成为上下文摘要、下一步、接收者选择和消息四类结构化字段。`task` 路由必须引用一个已就绪的 Charter 任务，并以其预分配的 active 专家为接收者，因此下游阶段无法在 blocker 完成前启动。这些字段无需依赖展示性移交前缀即可支持恢复和清晰投影。恢复逻辑同时识别当前结构化字段与旧存储格式，因此不可变历史任务仍可继续执行，新生成消息不会包含旧标记

`collaboration_task_list` 会在切分权威创建顺序列表前，校验非负安全整数 cursor 和一到 100 的 limit。非法边界返回稳定 `TEAM_INVALID_ARGUMENT` code。其他命令校验和授权错误保留领域层的稳定分类

## 模型体验

### TeamRun 策略与工具

#### 模型看到的内容

一段固定策略，加一行简短的当前成员 TeamRun role、公开名称和 run id。包括 `collaboration_get` 在内的十三个 collaboration schema 只出现在当前成员 scope 中。run value 包含权威 protocol topology、limit、member 权限、可用目标、已用与剩余预算和 challenge round。工具调用返回紧凑 canonical JSON，send receipt 和 run 投影不会重复 artifact 正文

#### Token 影响

固定策略和十三个 schema 会为每次 TeamRun 成员请求增加有界成本。read 和 mutation 调用会在调用后追加紧凑的 run、task、ledger、controller、page 或 message-receipt JSON。较大的公开 content 和 artifact 正文不会出现，除非模型显式调用对应的受限读取

#### KV Cache 影响

插件 generation 不变时，固定策略和 schema 保持前缀稳定。身份行在每个 Agent 之间不同。工具结果追加在可复用前缀之后，组队变更可能为专家添加或移除 scoped 适配器

## 已知限制与暂缓工作

- **没有 formation 工具** — P2 负责真实 child Agent 创建、provider settlement、skill 挂载和 plugin 绑定
- **没有自动 planner** — P3 负责 Task Profiler、Team Planner、复杂度选择和 Team Charter 生成
- **Prompt 策略不是 confinement** — 它引导公开协作，但无法阻止其他工具或外部进程暴露私密数据
