# Agent Note: 任务级技能市场发现

Status: implemented

[English](2026-08-27-task-bound-skill-marketplace-discovery.md) | 中文

## Problem

自动组队会选择精确的本地 ExpertBlueprint revision，但任务可能需要并非每个静态 blueprint 都携带的专业方法或已连接应用。如果把市场搜索当作环境级权限，已接受的团队将无法复现，还会引入不可信指令，并在用户授权前造成远程能力已经可执行的错觉

## Decision

[`@deepseek-ai/dsh-skill-marketplace`](../../../../packages/skill/skill-marketplace/README.md)负责 Smithery、Composio 与 skills.sh 的有界发现。每个 provider 都使用独立 timeout 运行，并显式返回 ready、authorization-required 或 unavailable 状态。Smithery 只接纳已验证、已部署且活跃的远程 server；skills.sh 只接纳部署配置中的精确仓库来源；Composio 需要部署级 API key，并继续把终端用户应用授权标为待完成

TeamOrchestrator 使用每个已选 blueprint 的 role、能力词和有界 ASCII 任务实体词构造确定性 provider 查询。它不会转发完整的多语言用户 prompt，因为长篇混合语言查询会显著降低 provider 的相关性。当至少一个已验证候选直接命中可识别任务实体时，系统会先丢弃仅命中通用角色词的候选，再按就绪程度和热度排序。之后去除重名结果，只准备有界且已选中的 mount，并持久化不可变能力快照。Retry 与 replacement 因此复用已接受的名称、就绪状态、connection ID 和工具白名单，不会重新查询已经变化的市场

SkillMarketplace 只会在 TeamOrchestrator 为某位专家选中 Smithery mount 后执行准备。公开 server 只有在平台 connection 就绪且 MCP `tools/list` 至少返回一个工具后才会进入 connected。`execute()` 只接受不可变 connection 快照内保留的工具名称。Composio 部署 credential 只允许发现，不代表终端用户已经授权应用，因此候选仍保持需要用户授权

ExpertRuntime 会把已选能力复制到 Lead binding 和 child descriptor。它只在指定 child 作用域注册持久化为 `loaded` 的方法技能和 `connected` 远程工具的确定性 wrapper。Wrapper 会把 child execution cancellation signal 传给 SkillMarketplace，并拒绝快照白名单之外的工具；所需 registry 或 runtime 缺失时关闭式失败

Host projection 只公开 provider 扫描状态，以及能力身份、显示名称、来源、类型、就绪状态和 public/platform/user access class。它不会下发 connection ID、工具名称、provider error 或 credential。协作 panel 会区分公开可用、缺少平台 credential 和需要终端用户授权三种情况，不会公开模型私有推理

## 信任与失败边界

只要要求的本地 blueprint 能力仍然可用，市场故障就不会使团队失效。Provider 失败会形成显式 unavailable 观察，并且该 provider 不贡献候选。Blueprint 必需的 skill 和 plugin 继续保持既有关闭式失败行为

skills.sh 发现要求返回技能同时通过精确可信来源和技能名称与有界查询的有效重合校验。它会生成由部署方编写的有界方法卡，不会获取或执行仓库文件。Smithery 与 Composio 结果在等待授权时不会注册成工具。Provider credential 始终属于 runtime config，不会进入任务事件或浏览器 projection。发现过程不写入文件系统，也不授予用户 credential

## Verification

Provider 测试固定已验证结果、可信来源和名称相关性过滤、公开 Smithery 准备、MCP 工具白名单与调用、Composio 缺少用户授权和局部故障。Orchestrator 测试固定多语言查询压缩、任务实体匹配、在有界选择后执行准备、计划持久化和精确 provisioning 输入。ExpertRuntime 测试证明 child 作用域方法技能与远程工具注册。Host 兼容性测试覆盖没有 discovery 行的旧计划。Client runtime 和协作 UI 测试固定安全传递和本地化 access 展示。真实 provider smoke test 还验证了 Hugging Face Smithery 发现、四个工具连接和 `hub_repo_search` 调用，同时 Composio 保持待授权

## Alternatives considered

**在本地安装每个搜索结果。** 未采用，因为市场热度不是信任决策，第三方仓库可能包含可执行 hook 或冲突指令

**把待授权远程结果公开为可执行工具。** 未采用，因为发现过程无法证明终端用户 OAuth、credential scope、MCP session owner 或撤销行为

**每次专家 activation 都重新查询市场。** 未采用，因为 retry 可能得到与已接受计划不同的能力集合，cold recovery 也会依赖当前网络状态

**任一市场不可用时让团队组建失败。** 未采用，因为这些候选只增强精确的本地 blueprint 能力；单个外部 catalog 故障不应静默移除必需本地能力，也不应阻止原本有效的组队

## Consequences

专家可以显式获得有界且与任务相关的技能名称，已加载方法能跨 retry 和 recovery 复现，而不需要安装第三方仓库。计划和 runtime binding 会变大，自动规划也会增加有界网络延迟

公开 Smithery 能力现在支持任务级调用，而且不会扩大 child 权限。Composio 和需要账户的 Smithery server 仍需后续用户授权 connector 负责 credential reference、revocation 和 audit，之后才能进入 `connected`
