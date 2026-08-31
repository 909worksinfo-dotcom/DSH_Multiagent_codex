# collaboration/：稳定多智能体协作领域

[English](README.md) | 中文

持久 TeamRun 状态、不可变专家能力绑定与模型可见协作命令，Lead Session log 是协作权威，消费方依赖稳定领域与运行时适配器，而不依赖实验性包或具体 agent loop

| 包 | 职责 | ctx key |
|---|---|---|
| [`agent-team/`](agent-team/README.md) | TeamRun 生命周期、专家尝试 roster、任务、公开消息与严格重放 | `ctx.teamRuns` |
| [`tool-agent-team/`](tool-agent-team/README.md) | TeamRun 服务之上的作用域化模型可见命令 | 无 |
| [`expert-catalog/`](expert-catalog/README.md) | 不可变 ExpertBlueprint revision 以及精确 preset、skill 与 plugin resolution | `ctx.expertCatalog` |
| [`expert-runtime/`](expert-runtime/README.md) | 已绑定 continuable child 创建、恢复、漂移检查与执行预算 | `ctx.expertRuntime` |

[稳定协作领域决策](../../.agents/notes/implemented/architecture/2026-08-26-stable-collaboration-domain.md)负责持久性、容量、组队与迁移隔离，[ExpertBlueprint 运行时决策](../../.agents/notes/implemented/architecture/2026-08-26-expert-blueprint-runtime-binding.md)负责精确能力 composition 与 child recovery
