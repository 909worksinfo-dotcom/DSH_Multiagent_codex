# @deepseek-ai/dsh-expert-catalog

English | [中文](README.zh.md)

Immutable local `ExpertBlueprint` revisions and exact capability resolution for natural multi-agent collaboration. `ctx.expertCatalog` validates every blueprint at load, resolves its Agent preset, model-invocable skills, and statically enabled plugins, then returns a SHA-256 binding digest that changes with any blueprint, preset, or skill content. The [P0 architecture contract](../../../.agents/notes/proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md) owns the product boundaries.

## Config

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

Each `id@revision` is immutable and unique within one process. Text is normalized and bounded, named fields and capability lists are unique, tool allow and deny rows cannot overlap, and execution limits are positive safe integers. The service deep-freezes its internal configuration and returns detached values.

## Exact capability resolution

`resolve()` reads the exact preset source, rejects broken presets, and requires every declared plugin to be statically enabled. A dynamic or disabled plugin does not satisfy the blueprint. Every skill resolves inside the selected preset scope and must be model-invocable; missing capabilities return `CAPABILITY_UNAVAILABLE` instead of producing a weaker expert.

The result includes the complete blueprint, its digest, preset id and source digest, winning skill provider/source/path and content digest, required plugin rows, and one binding digest over the complete record. P2 persists that record in both Lead and child Session logs and re-resolves it before cold recovery or model entry.

The separate `./invariant` companion reserves the package in required-on-read profiles. The catalog itself has no mutable registration or event relation after constructor validation.

## Model Experience

### Blueprint resolution

#### What the model sees

`ctx.expertCatalog.resolve()` does not directly add prompt or history content. The P2 expert runtime renders selected blueprint fields into the child's initial user-role assignment, while skill bodies remain available through the normal skill mechanism rather than being copied into the binding record.

#### Token effect

Catalog lookup adds no direct model tokens. The runtime-rendered assignment grows with declared inputs, outputs, acceptance criteria, collaboration instructions, and skill names.

#### KV Cache effect

Resolution is outside inference and does not invalidate an existing request prefix. Each expert Agent maintains its own model history and cache lifecycle.

## Known Limitations and Deferred Work

- **Local immutable configuration only** — there is no remote catalog, live blueprint mutation, or distributed revision registry
- **No P3 planner** — Task Profiler, Team Planner, Team Charter, complexity selection, and topology selection remain separate later-phase consumers
- **Static plugin proof only** — dynamic `disabled` expressions fail closed because their activation cannot be included in an immutable binding
- **No skill body injection** — the binding records skill identity and content digest, while the normal skill tool owns loading the full instructions
- **Budget declaration is not aggregate accounting** — P2 enforces turns, wall-clock deadline, and an effective per-request `maxTokens`; aggregate token-ledger enforcement remains deferred
