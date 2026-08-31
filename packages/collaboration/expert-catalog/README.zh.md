# @deepseek-ai/dsh-expert-catalog

[English](README.md) | 中文

面向天然多智能体协作的不可变本地 `ExpertBlueprint` revision 与精确能力解析包。`ctx.expertCatalog` 在加载时校验每个 blueprint，解析其 Agent preset、模型可调用 skill 和静态启用的 plugin，再返回 SHA-256 绑定 digest；任何 blueprint、preset 或 skill 内容变化都会改变该 digest。[P0 架构契约](../../../.agents/notes/proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md)负责产品边界

## 配置

```yaml
- id: expert-catalog
  name: '@deepseek-ai/dsh-expert-catalog'
  config:
    blueprints:
      - ref: { id: research-analyst, revision: 1 }
        role: Research analyst
        objective: Find and synthesize verifiable evidence
        preset: research
        skills: [literature-search]
        plugins: ['@plugins/research']
        tools: { allow: [web_search] }
        model: { provider: deepseek, model: deepseek-chat, maxTokens: 4096 }
        persona: Work as an evidence-first analyst
        inputs:
          - { name: question, description: Question to investigate, required: true }
        outputs:
          - { name: findings, description: Sourced findings, required: true }
        acceptanceCriteria: [Every material claim has a source]
        collaboration: { challenge: true, review: true, requestHelp: true }
        budget: { maxTurns: 8, maxTokens: 16000, timeoutMs: 120000 }
```

每个 `id@revision` 在单个进程中不可变且唯一。文本会被规范化并限制长度，命名字段和能力列表必须唯一，tool allow 与 deny 行不得重叠，执行限制必须是安全正整数。服务会深度冻结内部配置，并只返回分离副本

## 精确能力解析

`resolve()` 会读取确切 preset 源文件并拒绝 broken preset，同时要求每个声明的 plugin 都处于静态启用状态。动态或 disabled plugin 不能满足 blueprint。每个 skill 都在所选 preset scope 内解析且必须能由模型调用；缺失能力会返回 `CAPABILITY_UNAVAILABLE`，不会生成能力缩水的专家

结果包含完整 blueprint 及其 digest、preset id 与源文件 digest、胜出的 skill provider／source／path 与内容 digest、必需 plugin 行，以及覆盖完整记录的 binding digest。P2 会将该记录同时持久化到 Lead 和 child Session 日志，并在冷恢复或模型进入前重新解析

独立 `./invariant` 配套模块会在读取时必需的 profile 中保留本包。本地 catalog 经过构造器校验后没有可变注册或事件关系

## 模型体验

### Blueprint 解析

#### 模型看到的内容

`ctx.expertCatalog.resolve()` 不会直接增加 prompt 或 history 内容。P2 expert runtime 会把选定 blueprint 字段渲染成 child 的初始 user-role assignment，skill 正文仍通过普通 skill 机制提供，不会复制到绑定记录

#### Token 影响

catalog 查询不直接增加模型 token。runtime 渲染的 assignment 会随声明的 input、output、acceptance criteria、collaboration instruction 和 skill name 增长

#### KV Cache 影响

解析发生在推理之外，不会使既有请求前缀失效。每个专家 Agent 都维护自己的模型历史和 cache 生命周期

## 已知限制与暂缓工作

- **仅限本地不可变配置** — 没有远端 catalog、在线 blueprint 变更或分布式 revision registry
- **没有 P3 planner** — Task Profiler、Team Planner、Team Charter、复杂度选择和拓扑选择仍由后续独立消费方负责
- **仅证明静态 plugin** — 动态 `disabled` 表达式无法纳入不可变绑定，因此会关闭式失败
- **不注入 skill 正文** — binding 记录 skill 身份和内容 digest，完整 instruction 仍由普通 skill tool 加载
- **预算声明不是总量记账** — P2 强制 turn、wall-clock deadline 和每次请求的有效 `maxTokens`，aggregate token ledger 仍属暂缓工作
