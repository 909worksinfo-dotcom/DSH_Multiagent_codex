# @deepseek-ai/dsh-team-orchestrator

English | [中文](README.zh.md)

Automatic Task Profiler, Team Planner, Team Charter, and fail-closed formation over stable TeamRun and ExpertRuntime services. Every admitted task creates one Lead-owned TeamRun, selects exact immutable ExpertBlueprint revisions, and reaches `active` only with its complete planned roster.

## Config

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

Configuration requires exactly one ordered pool for each first-wave domain. A pool needs at least eight distinct exact revisions to staff every complex task in that domain. Text, list, workstream, context, and complete-event bounds reject oversized retained input before it reaches the durable log.

## Profiling and planning

`create()` preserves the original objective, infers a domain when no hint is supplied, normalizes explicit workstreams or derives bounded workstreams from multilingual separators and task-action signals, then computes dependency depth, capability density, decomposition, and risk metrics. Every task starts with at least three experts; simple tasks use exactly three, medium tasks use three or four, and complex tasks use five to eight. An optional `productTitle` context value participates in inference without changing the displayed objective.

The planner ranks the configured exact revisions by stable capability relevance and configuration order. An inferred objective becomes a domain-specific execution DAG, while caller-authored workstreams remain unchanged. The planner groups dependency layers into explicit serial or parallel stages and assigns every step to one immutable roster slot. Simple tasks use `producer_reviewer`; medium tasks use `centralized` or `parallel`; complex tasks use `hybrid` or `grouped`. Missing capacity or an unavailable revision terminates the P1 run as `formation_failed`; it never continues with only the Lead.

The charter commits the objective, success criteria, exact roster, assigned task DAG, execution stages, topology, communication limits, quality checks, per-expert execution budgets, and fail-closed termination rule before provisioning starts. The orchestrator then materializes one immutable TeamRun protocol from that exact charter and the committed catalog revisions: each slot receives its blueprint permissions and deterministic topology routes before expert provisioning can succeed

## Service operations

- `create(lead, request)` creates or idempotently resumes the profile, plan, and charter
- `form(lead, command, signal)` materializes or verifies the Charter task DAG and quality gates, provisions or recovers every planned expert through `ctx.expertRuntime`, preassigns every task without starting blocked work, and activates only at exact strength
- `orchestrate(lead, request, signal)` is the one-click `create` plus `form` path
- `retry(lead, command, signal)` idempotently resumes a non-terminal provisioning run without replaying accepted child work
- `replaceExpert(lead, request, signal)` idempotently binds one failed active member back to its durable roster slot, provisions the next immutable attempt through ExpertRuntime, and preserves failed attempts as audit rows
- `cancel(lead, request)` records terminal cancellation while retaining the current audit
- `get(lead)` and `list()` project durable state for current live Leads; `plan` and `charter` are absent after a failure before those commit points

P1 terminal states are immutable. Retrying a terminal `formation_failed` or `cancelled` run returns its stable error; the product creates a new Lead and TeamRun with `retryOf` when the user requests a fresh attempt.

## Durability and recovery

The Lead Session stores required-on-read `collaboration/orchestration/profile`, `collaboration/orchestration/plan`, and `collaboration/orchestration/charter` events. Request, plan, and charter digests reject mismatched retries and tampered persisted values. The separate `./invariant` companion validates each candidate against the owning P1 TeamRun and its event prefix before publication.

Formation identities derive from the committed request digest and roster slot. Before expert activation, a stable dependency-first walk materializes the Charter DAG as P1 tasks even when dependencies appear later in the input, and the Charter quality checks become an exact ordered gate prefix. The same pass idempotently materializes the exact protocol; recovery compares topology, limits, permissions, and routes with the durable plan, charter, and catalog, then fails closed on drift. A retry accepts exact untouched prefixes, creates only missing rows, recovers an existing P2 attempt, validates its immutable capability binding through ExpertRuntime, and never provisions a duplicate accepted slot. Active replacement identities additionally include a monotonically derived slot generation, so repeating one replacement command recovers or returns the same attempt while replacing a subsequently failed replacement requires addressing that failed member. Divergent task, quality-gate, or protocol state fails closed, including after cold recovery. Initial provider failure is compensated by P2, then P3 commits explicit `formation_failed`; replacement provider failure leaves the active run blocked with its failed audit instead of reporting false recovery; cancellation commits `cancelled`

## Model Experience

### Team design records

#### What the model sees

This package does not inject a prompt or expose private reasoning. Its `collaboration/orchestration/*` records preserve public task structure and pass each planned assignment to ExpertRuntime, whose logged initial expert prompt owns model-visible role, input, output, acceptance, and collaboration instructions.

#### Token effect

Profile, plan, and charter events are log-only and add no model tokens by themselves. Planned assignment text contributes to each child initial prompt through ExpertRuntime.

#### KV Cache effect

The orchestrator does not share caches between Agents. Every provisioned expert remains an independent continuable child with the preset, model route, and KV Cache lifecycle enforced by ExpertRuntime.

## Known Limitations and Deferred Work

- **Deterministic Demo profiler** — domain and complexity inference use bounded multilingual text and task signals rather than an LLM semantic classifier; explicit domain and workstreams remain available for evaluation fixtures
- **Configured candidate pools** — the planner selects only exact revisions admitted by deployment configuration; it does not discover or generate ExpertBlueprints
- **Exact-prefix task recovery** — orchestration owns initial Charter materialization only; later task ownership, edits, claims, and completion remain P1 collaboration commands, and any pre-activation drift is rejected rather than merged
- **Live-host listing** — `list()` projects currently registered Lead Agents; persistence-backed cross-process history belongs to the Host query layer
- **Single-process command serialization** — per-Lead orchestration commands and P1 CAS retries do not form a distributed transaction across harness processes
