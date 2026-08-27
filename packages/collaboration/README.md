# collaboration/ — stable multi-agent collaboration domain

English | [中文](README.zh.md)

Durable TeamRun state, immutable expert capability binding, and model-facing collaboration commands. The Lead Session log is the collaboration authority; consumers depend on stable domain and runtime adapters instead of experimental packages or the concrete agent loop.

| Package | Role | ctx key |
|---|---|---|
| [`agent-team/`](agent-team/README.md) | TeamRun lifecycle, expert-attempt roster, tasks, public messages, and strict replay | `ctx.teamRuns` |
| [`tool-agent-team/`](tool-agent-team/README.md) | Scoped model-facing commands over the TeamRun service | — |
| [`expert-catalog/`](expert-catalog/README.md) | Immutable ExpertBlueprint revisions and exact preset, skill, and plugin resolution | `ctx.expertCatalog` |
| [`expert-runtime/`](expert-runtime/README.md) | Bound continuable-child provisioning, recovery, drift checks, and execution budgets | `ctx.expertRuntime` |

The [stable collaboration domain decision](../../.agents/notes/implemented/architecture/2026-08-26-stable-collaboration-domain.md) owns persistence, capacity, formation, and migration isolation. The [ExpertBlueprint runtime decision](../../.agents/notes/implemented/architecture/2026-08-26-expert-blueprint-runtime-binding.md) owns exact capability composition and child recovery.
