# @deepseek-ai/dsh-skill-marketplace

[中文] | [English](README.md)

面向首个 Demo 的远程市场发现能力，支持 Smithery、Composio 和 skills.sh

服务会独立搜索每个来源，Smithery 只保留已验证且已部署的远程 Server，skills.sh 只保留部署白名单内的仓库，并显式返回授权或不可用状态，不会因单个市场故障让 TeamRun 组队失败。Composio 在终端用户完成应用授权前始终保持待授权状态

市场结果是规划输入，不是环境级权限。TeamOrchestrator 只准备当前任务选中的能力并持久化安全执行元数据，ExpertRuntime 只在被分配的子 Agent 作用域内挂载已加载方法和已连接远程工具

## 配置

```yaml
- id: skill-marketplace
  name: '@deepseek-ai/dsh-skill-marketplace'
  config:
    timeoutMs: 7000
    maxResultsPerProvider: 4
    smitheryEndpoint: https://registry.smithery.ai/
    smitheryApiKey: !!js process.env.SMITHERY_API_KEY
    smitheryConnectEndpoint: https://api.smithery.ai/
    smitheryNamespace: deployment-namespace
    skillsShEndpoint: https://skills.sh/
    composioEndpoint: https://backend.composio.dev/api/v3/
    composioApiKey: !!js process.env.COMPOSIO_API_KEY
    trustedSkillsShSources:
      - anthropics/skills
      - vercel-labs/agent-skills
```

`timeoutMs` 分别作用于每个 provider，`maxResultsPerProvider` 在团队级排序前限制每个响应的数量。`trustedSkillsShSources` 是精确仓库白名单。Provider credential 始终是部署秘密，只会发送到对应 provider endpoint；任务事件只保留 connection ID 和工具名称，不保存 credential

## 发现语义

`search()` 并发运行三个 provider，并为每个来源返回独立状态。TeamOrchestrator 会使用专家角色、能力词和任务实体词构造有界 ASCII 查询，不再把长篇多语言 prompt 原样发送给市场。如果已验证候选中存在与可识别任务实体直接匹配的结果，团队级选择只保留实体匹配项，丢弃仅命中通用角色词的候选。排序完成后只对当前任务选中的 mount 调用 `prepare()`。公开 Smithery server 只有在确定性创建 Connect connection 且 MCP `tools/list` 成功后才会成为 `connected`；需要账户输入的 server 保持待授权。Composio 应用工具保持需要用户授权。skills.sh 条目必须同时通过可信仓库白名单和技能名称相关性校验，之后才能成为 `loaded` 方法技能卡；方法卡只包含有界、由部署方控制的指导，不包含下载的仓库内容

Provider HTTP、解析、超时与信任校验失败会被隔离成 `unavailable`。空查询属于调用方错误。结果是分离的值；发现过程不会注册全局工具、修改文件系统或授予凭据

## 模型体验

### 任务级方法发现

#### 模型看到的内容

专家的初始 assignment 会列出已选中的方法技能名称，以及远程能力名称和就绪状态。ExpertRuntime 会注册持久化为 `loaded` 的方法技能，并为白名单内的每个远程工具创建确定性的 child scoped tool。每次调用都通过 `SkillMarketplace.execute()` 执行并继承 child execution signal；待授权远程工具不会变成模型可执行工具

#### Token 影响

选中的名称会给初始 assignment 增加一段有界的短文本。只有专家通过现有 skill capability 加载对应技能时，方法指导才会消耗 prompt token

#### KV Cache 影响

每名专家拥有各自选中的 catalog 条目。不同选择会形成不同的 child 请求前缀，因此不会共享完全相同的 KV Cache 前缀

## 已知限制与暂缓工作

- **只执行 Smithery 公开能力** — 当前任务选中的公开 Smithery server 支持任务级 MCP 执行，需要账户授权的 server 仍保持待授权
- **Composio 执行暂缓** — 部署 API key 只用于发现，账户工具要等任务级终端用户授权和执行 connector 完成后才能调用
- **方法卡而非仓库安装** — skills.sh 结果只贡献安全的方法摘要，服务不会下载或执行第三方仓库代码
- **静态信任策略** — 可信 skills.sh 仓库由部署配置控制，尚无面向用户的审批界面
