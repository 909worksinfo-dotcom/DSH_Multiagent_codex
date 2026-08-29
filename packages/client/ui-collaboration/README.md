# @deepseek-ai/dsh-client-ui-collaboration

English | [中文](README.zh.md)

TeamRun console for multi-agent collaboration by design. Every task starts with a lead agent and three to eight experts. The console shows task launch, formation stages, the Task Profile, Team Charter, collaboration topology, roster, allowlisted capability metadata, the authoritative task ledger, Lead controller, Team Blackboard, runtime collaboration protocol, and public collaboration timeline

The root component consumes an injected `useCollaboration` selector Hook plus `createRun`, `retryFormation`, and `terminate` commands. The source is authoritative outside the UI package. The collaboration store persists only navigation, filters, selected ids, and task-composer drafts; it never persists TeamRuns, profiles, charters, expert bindings, tasks, artifacts, decisions, quality gates, controller state, failures, or results

`team_formation_failed` is rendered as an explicit terminal where execution never started. The console does not present lead-only execution as a successful team. Retrying creates and selects a new TeamRun while the original failed run remains available as an immutable audit record

The existing session-level agent overlay remains available for legacy collaboration sessions. It can show a bounded child-session work summary and key dialogue without exposing reasoning blocks or execution chatter

The main conversation task list groups the authoritative DAG by dependency depth, labels each group as a serial or parallel stage, and labels every task itself as serial or parallel with its assigned expert name. Each compact row keeps the task status on the title line, limits the description to one display line, and keeps task mode plus owner on one metadata line where width permits. Display descriptions are normalized and capped at 60 Unicode characters without changing the authoritative task data. Completed steps remain struck through and visually muted. The task board renders dependency readiness, ownership, progress, resource scopes, and conflicts from the runtime projection. The public timeline renders the typed collaboration vocabulary, including viewpoints, challenges, responses, reviews, decisions, artifacts, and the lead agent's final delivery. Each participant keeps one deterministic identity color across message kinds, while message kinds remain textual badges. Avatars, message surfaces, and message-kind badges use borderless color fills, and message rows use spacing instead of separator lines. Routed content is projected into labeled context, next-step, recipient-selection, and message sections. The projection removes legacy sequential-handoff presentation markers and suppresses impossible author-equal-target labels from immutable historical receipts without rewriting those events. It excludes private model reasoning and highlights final delivery only when an authoritative `final_delivery` event exists

The Lead controller separates automatically detected health from actions already recorded by Lead. It shows health, last progress, stalled tasks, duplicate work, quality failures, recommended recovery actions, completed interventions, and a Task / Progress Ledger aggregated from authoritative task, artifact, decision, and quality-gate counts

The Team Blackboard renders the authoritative `artifacts`, `decisions`, and `qualityGates` ledgers. Artifact rows show versioned metadata only, including category, review state, actor, task associations, media type, and update time; they neither embed bodies nor pretend that a body-reading capability exists. Decision and quality rows retain their versions, actor identities, associations, summaries, and outcomes. The UI never infers any of these business records from timeline prose

Completed TeamRuns show delivery provenance derived from completed tasks, accepted artifact versions, quality-gate reviewers, passed gates, and accepted Lead decisions. Failed gates and rework states remain visually explicit instead of being collapsed into generic execution activity

The P6 Collaboration Protocol view reads only the authoritative `run.protocol` projection. Enforced runs show topology-derived runtime rules, challenge-round and per-expert message limits, aggregate usage, each roster slot's challenge, review, and help-request permissions, allowed targets, remaining budget, and challenge-thread state with message trace ids. Near-limit, exhausted, capped, and inconsistent counters remain explicit while explanatory UI labels are visually separated from runtime-enforced policy

Legacy or pre-P6 snapshots receive a controlled empty state. The UI never reconstructs protocol policy from timeline prose or the Team Charter

## Model Experience

### Collaboration console

#### What the model sees

Nothing from this UI package. It adds no coordinator prompt, system-prompt section, tool schema, or hidden model instruction. Team planning and orchestration belong to the collaboration runtime behind the injected `CollaborationPort`

#### Token effect

None from the UI console. Tokens are consumed only by the authoritative collaboration runtime and its sessions

#### KV Cache effect

None from the UI console

## Known Limitations and Deferred Work

- The deterministic fixture covers forming with one expert, running with eight experts, enforced and legacy protocols, normal, near-limit, and exhausted expert budgets, open and responded challenge threads, stalled and reworking control states, task dependencies, authoritative artifact and decision ledgers, failed and passed quality gates, completed delivery provenance, typed public discussion, formation failure, retry into a new TeamRun, cancellation, and refresh recovery presentation
- The P5 and P6 views are read-only projections. Protocol admission, task mutation, collaboration messaging, controller intervention, decision admission, artifact-body reads, quality-gate execution, and final-delivery admission remain owned by the authoritative collaboration runtime
- The legacy right panel still identifies older coordinator sessions by their collaboration title prefix
