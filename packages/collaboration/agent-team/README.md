# @deepseek-ai/dsh-agent-team

English | [中文](README.zh.md)

Stable TeamRun domain for natural multi-agent collaboration. `ctx.teamRuns` owns one explicit Lead-run lifecycle, an auditable expert-formation roster, a compare-and-set task DAG, and typed public collaboration records in the Lead Session log. The [P0 architecture contract](../../../.agents/notes/proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md) owns the product boundaries. The experimental `ctx.agentTeams` service is an independent legacy subsystem; the two services do not share state or silently interoperate.

## Config

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-agent-team'
  config:
    maxActiveExperts: 8
    maxProvisionAttempts: 12
    maxTasks: 256
    maxPublicMessages: 4096
    maxPublicMessageBytes: 65536
    maxArtifacts: 512
    maxArtifactBodyBytes: 1048576
    taskStallCursorThreshold: 20
```

`maxActiveExperts` is from one through eight and excludes the Lead. Every other limit must be a positive integer. The complete policy is copied into the creation event, so replay keeps the limits that governed the run even if a later deployment changes its defaults.

The service requires Agent and Session services. A persistence-enabled Session profile makes the TeamRun journal durable; the package itself does not create a second database or cache.

## TeamRun lifecycle and formation

Every run is created explicitly by one live Lead with an objective, complexity, and exact planned expert count. The legal bands are `simple = 1`, `medium = 2..4`, and `complex = 5..8`. The Lead is represented separately and never occupies an expert slot. `active + provisioning` cannot exceed the planned count or `maxActiveExperts`, and available slots equal `planned - active - provisioning`.

Formation is a three-command boundary for the P2 provider layer: `beginExpertProvision()` reserves immutable member, Session, attempt, name, and role identities; `succeedExpertProvision()` records child publication before its initial prompt is admitted; and `failExpertProvision()` retains a structured failed audit row while releasing its concurrency slot. If prompt admission fails after the success commit, the same failure command compensates that active row while the run is still provisioning. Failed identities and names remain consumed, attempt numbers continue monotonically, and the default thirteenth attempt is rejected. The separate P2 runtime creates child Agents and binds their exact capabilities; this domain remains the lifecycle authority.

A runtime expert may also transition from active to failed while the run remains in `active`. Its membership and scoped authority are revoked immediately, the public status becomes `blocked`, and the released slot can provision one new immutable replacement attempt. The status returns to `running` only after the exact planned active count is restored. New or successful roster formation is rejected after the Lead enters `completing`, but a late runtime failure is still recorded so the run cannot deliver with a stale active member and must transition to `failed`.

A run reaches `active` only when exactly its planned experts are active and no attempt is provisioning. The same condition is rechecked before completing. Failure before a valid team forms is the explicit `formation_failed` phase; execution failure and cancellation use `failed` and `cancelled`. Terminal phases are irreversible, and a Lead-only run cannot become active or completed.

## Durable event journal and replay

Nine required-on-read Session event families hold the complete domain truth:

- `collaboration/run/created` snapshots identity, objective, plan, Lead, and policy
- `collaboration/run/phase` advances lifecycle or records a structured terminal failure
- `collaboration/member` stores a complete immutable-identity expert-attempt row
- `collaboration/protocol` stores the immutable topology, limits, exact expert rules, and allowed slot routes
- `collaboration/task` stores a complete task revision
- `collaboration/message` stores one typed, public-only collaboration record
- `collaboration/artifact` stores one complete CAS artifact version, including its restricted body
- `collaboration/decision` stores one independent Lead arbitration row
- `collaboration/quality-gate` stores one materialized gate or formal result

The strict fold validates current-version payloads, run ownership, contiguous semantic revisions, lifecycle transitions, formation capacity, task DAG invariants, and message references. An ordinary Session fork filters inherited TeamRun events owned by another Lead. Replaying an identical `eventId` is semantically idempotent while the physical Session cursor still advances; reusing the id with different content is corruption and fails closed. The journal serializes writes per Lead and compare-and-set rejects stale concurrent commands.

The separate `./invariant` companion replays each candidate collaboration event against the committed Session prefix before publication. A profile that can read these events must mount the package because these facts are required for reconstruction rather than ignorable telemetry.

## Shared task DAG

Tasks are complete versioned snapshots. Every mutation carries `expectedRevision`; stale writers receive `STALE_REVISION`. Dependencies must reference current non-deleted tasks, contain no duplicate or self edge, and keep the complete graph acyclic. A pending task is ready only when every blocker is completed, and completion rechecks that condition. In an enforced run, an expert-owned task stays in progress until the owner routes an artifact linked to the exact task back to the Lead, the Lead accepts that artifact, and the Lead confirms the `complete` transition. Expert-side completion and review-only artifacts fail closed. Legacy runs retain their previous task transition behavior. Deleted tasks remain replay tombstones but disappear from `listTasks()` and release task capacity.

The Lead and active experts may create and read tasks. Lead-only `assign` binds one pending task to an active expert without starting it, including when dependencies are still blocked. Claim, release, edit, completion, reopen, reassign, and deletion retain domain-level owner and Lead authority. `resourceScopes` are normalized generic prefixes used to report overlap between in-progress work. They are coordination hints, not filesystem locks, plugin permissions, or authorization.

## Enforced collaboration protocol

New orchestrated runs materialize one immutable protocol before any expert becomes active. It copies the Team Charter topology and communication limits plus each exact ExpertBlueprint's `challenge`, `review`, and `requestHelp` permissions into the Lead Session log. Every expert attempt binds to one durable protocol slot, including a replacement attempt after a failed member. A retry with the same protocol is idempotent; a different protocol or active-run drift fails closed with `TEAM_PROTOCOL_REQUIRED`

Every expert-authored public record consumes that slot's message budget. `centralized` and `parallel` route experts only to Lead, `producer_reviewer` routes every peer, `hybrid` routes adjacent slots, and `grouped` routes paired slots; Lead remains an allowed coordination target in every topology. Permission, target, and exhausted-budget refusals use stable `TEAM_PROTOCOL_PERMISSION_DENIED`, `TEAM_PROTOCOL_TARGET_DENIED`, and `TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED` codes and append no event. Lead can coordinate across the roster but cannot forge raw decision, artifact, or final-delivery receipts outside their authoritative ledger operations

A challenge and response share one explicit dispute thread, one challenge id, and one exact counterparty. One thread admits only one open round, a response must reverse the original participants, and the Charter round limit is enforced before append. Open challenges block `completeRun()` with `DELIVERY_FAILED`. The authoritative protocol projection exposes topology, limits, per-member permissions, allowed targets, usage, remaining budget, and linked challenge round state to Host and tools

Runs whose logs predate `collaboration/protocol` project exact `legacy` mode and retain their previous P3-P5 message behavior for cold recovery and audit. They are never silently upgraded or reinterpreted as enforced runs

## Public collaboration records

Messages have one of fourteen persisted public kinds, including proposal, challenge, response, review, decision, handoff, completion request, and final delivery. The type system has no private-reasoning category. Runtime validation enforces public visibility, current actors and targets, current task references, lifecycle admission, byte and count limits, protocol admission, and authoritative ledger ownership. A challenge id is legal only on a linked challenge or response; decision, artifact, and final-delivery records are emitted only by their owning operations

Artifact, decision, and quality records are first-class durable ledgers. Compact TeamRun projections contain artifact metadata but never bodies; `readArtifact()` is the membership-authorized body read. Artifact and quality writes enforce count, UTF-8 byte, lifecycle, reference, authority, and CAS rules before atomically appending their ledger fact and public evidence. An expert-authored artifact receipt targets Lead, a Lead update of an expert-authored artifact targets that artifact author, and a Lead-owned artifact receipt has no conversational target. Every newly generated ledger message rejects an author-equal-target relation before append. The Lead Controller derives health, explicitly related task activity, duplicate work, quality failures, missing active experts, recommendations, and prior control actions only from persisted cursors, event times, and the snapshotted policy. Its reassign, rework, and replan operations atomically append the task revision, Lead decision, and public record, while `replace_expert` directs the runtime controller to the orchestrator-owned provider replacement path.

An active run projects `blocked` when the team is understaffed, a task is stalled, or a quality gate is failed; it projects `reworking` after the latest Lead control action reopens work and `reviewing` when every completion gate is ready. Related progress or corrected quality evidence deterministically restores `running` when no stronger state remains.

`completeRun()` validates and commits completion as one ordered batch. It requires non-empty completed tasks, at least one accepted artifact per task, both completion-request and review messages, at least one materialized quality gate with every gate passed, and an accepted Lead decision that links each task to one of its accepted artifacts before it appends `completing`, the Lead's `final_delivery`, and `completed`. Admission failures append nothing and preserve every run, task, artifact, decision, gate, revision, and cursor value.

The records are an ordered public audit stream, not a peer-delivery transport. The stable [`@deepseek-ai/dsh-tool-agent-team`](../tool-agent-team/README.md) package is the model-facing adapter, and the Host API exposes compact task progress plus cursor-paged public events.

## Model Experience

### Public collaboration records

#### What the model sees

TeamRun lifecycle, roster, task, and `collaboration/*` events are log-only and do not directly enter model history. A model sees selected current projections only when a scoped adapter returns them.

#### Token effect

The domain adds no direct prompt or history tokens. Tool schemas, policy, and compact results are owned by the stable tool adapter.

#### KV Cache effect

Domain events do not directly invalidate a model prefix. Adapter results append after the reusable request prefix when the model calls a collaboration tool.

## Known Limitations and Deferred Work

- **P2 is a separate adapter** — this package never creates a child Agent or attaches skills and plugins by itself; mount `@deepseek-ai/dsh-expert-catalog` and `@deepseek-ai/dsh-expert-runtime` with it for exact expert binding
- **No peer delivery transport** — public records are durable audit facts, not automatic Agent inbox messages or wakeups
- **No uncontrolled background timer** — controller health changes only when another durable event advances the cursor; deployments that need wall-clock-only alerts must schedule an explicit logged observation
- **One process authority** — the per-Lead queue and Session journal do not provide a distributed transaction across harness processes
