# @deepseek-ai/dsh-tool-agent-team

English | [中文](README.zh.md)

Scoped model-facing adapter for the stable [`ctx.teamRuns`](../agent-team/README.md) domain. It installs one public collaboration policy and fifteen bounded tools only in a live Lead or active expert scope. It never owns formation, provisioning, lifecycle, task, ledger, or message state, so the domain service remains the single source of truth

## Config

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
  config: {}
```

The adapter has no deployment tunables. Team size, attempt, task, and public-message limits belong to the stable domain configuration and are snapshotted into each TeamRun.

## Scoped installation and authority

The plugin reconciles current Agents at startup and after Agent or TeamRun events. A Lead receives tools after explicit run creation. A child receives them only when its direct parent is the Lead and its reserved Session identity belongs to an active expert row. Failed, unrostered, disposed, and stale Agent instances do not retain the registrations.

Every command passes the exact calling Agent to `ctx.teamRuns`; descriptions and prompt policy are not the authority boundary. Plugin HMR removes all scoped policy and tool registrations, then a replacement generation can reinstall them for current members without mutating TeamRun state.

The stable tool names are deliberately distinct from the experimental Agent Teams controls, so both packages can be loaded without global-name collision:

- `collaboration_get` returns lifecycle, exact plan, expert-attempt audit rows, capacity, and structured failure
- `collaboration_send` commits one typed public record and returns a compact receipt without echoing caller-owned content
- `collaboration_followup` advances one serial turn to exactly one best-suited recipient after the sender becomes idle
- `collaboration_parallel_followup` atomically dispatches at least two ready tasks from one explicitly parallel Charter stage, starts their expert inboxes concurrently, and joins once
- `collaboration_complete` lets only the Lead atomically publish final delivery after every P5 ledger and public evidence requirement passes
- `collaboration_artifact_write` and `collaboration_artifact_read` write bounded CAS versions and explicitly read one restricted body
- `collaboration_decision_write` lets only the Lead commit arbitration with public evidence
- `collaboration_quality_update` lets only the Lead settle one materialized quality gate
- `collaboration_controller_get` reads deterministic health and recommendations
- `collaboration_control` lets only the Lead atomically reassign, rework, or replan one task
- `collaboration_task_create` creates one pending task with blockers and generic advisory resource scopes
- `collaboration_task_list` returns at most 100 tasks, with cursor pagination and a default limit of 50
- `collaboration_task_get` returns one complete latest task view
- `collaboration_task_update` performs one compare-and-set task action

The adapter intentionally exposes no model tool for TeamRun creation, complexity choice, expert provisioning, or provider settlement. Those operations belong to the runtime controller and P2/P3 packages.

## Public collaboration policy

The policy tells every member to read authoritative protocol state before acting on stale information, obey remaining message budget and allowed targets, use task revisions for compare-and-set updates, treat `resource_scopes` as advisory labels, and publish concise user-safe facts. All persisted message kinds are public by construction, while `collaboration_send` excludes authoritative decision, artifact, and final-delivery receipts that belong to their ledger commands. `private_reasoning` and chain-of-thought have no schema path

`collaboration_send` accepts typed references only where the domain relation is legal. A challenge and response require the same explicit non-default dispute `thread_id`, one explicit target, and the same `challenge_id`; an ordinary message may default to `main`. Its result retains stable message, event, run, thread, cursor, author, target, reference, time, kind, and visibility fields, but omits the content the caller just supplied. This bounds duplicate model context even when the domain permits a large public record

Serial stages advance only after the current sender becomes idle. The router rereads the authoritative run, summarizes relevant context, plans one next action, selects exactly one eligible recipient, and emits public content as structured context-summary, next-step, recipient-selection, and message fields. A `task` route must reference a ready Charter task and target its preassigned active expert, so downstream stages cannot start before their blockers complete

Only a Charter stage whose committed mode is `parallel` can use `collaboration_parallel_followup`. The Lead submits at least two distinct ready task-owner pairs in one atomic public batch. Inbox admission runs concurrently with `Promise.allSettled`; only admitted experts receive execution permits, each must return the exact task to the Lead, and the Lead remains blocked until one barrier join reports all successful returns and any initial delivery failures. A serial route is rejected while two or more tasks remain ready in that explicit parallel stage. The shared thread and public routes let live recovery reconstruct an unfinished batch without changing immutable historical messages

The structured fields support recovery and readable projection without a presentation-only handoff prefix. Recovery recognizes the current structured fields and the older stored form, so immutable historical runs remain resumable while newly generated messages contain no legacy marker

`collaboration_task_list` validates a non-negative safe-integer cursor and a limit from one through 100 before slicing the authoritative creation-order list. Invalid bounds return the stable `TEAM_INVALID_ARGUMENT` code. Other command validation and authorization errors preserve the domain's stable taxonomy.

## Model Experience

### TeamRun policy and tools

#### What the model sees

One fixed policy section plus a short per-member TeamRun role, public name, and run id line. The fifteen collaboration schemas, including `collaboration_get`, appear only in current member scopes. The run value includes the authoritative protocol topology, limits, member permissions, allowed targets, usage, remaining budget, and challenge rounds. Tool calls return compact canonical JSON; the send receipt and run projection do not repeat artifact bodies

#### Token effect

The fixed policy and fifteen schemas add a bounded cost to every TeamRun member request. Read and mutation calls append compact run, task, ledger, controller, page, or message-receipt JSON after invocation. Large public content and artifact bodies are absent unless the model explicitly invokes the corresponding restricted read

#### KV Cache effect

The fixed policy and schemas remain prefix-stable while the plugin generation is unchanged. The identity line differs per Agent. Tool results append after the reusable prefix, and formation changes can add or remove the scoped adapter for an expert.

## Known Limitations and Deferred Work

- **No formation tools** — P2 owns real child-Agent creation, provider settlement, skill mounting, and plugin binding
- **No autonomous planner** — P3 owns Task Profiler, Team Planner, complexity selection, and Team Charter generation
- **Prompt policy is not confinement** — it guides public collaboration but cannot prevent other tools or external processes from exposing private data
