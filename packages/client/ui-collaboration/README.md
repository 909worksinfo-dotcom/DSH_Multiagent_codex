# @deepseek-ai/dsh-client-ui-collaboration

English | [中文](README.zh.md)

TeamRun console for multi-agent collaboration by design. Every task starts with a lead agent and three to eight experts. The console shows task launch, formation stages, the Task Profile, Team Charter, collaboration topology, roster, allowlisted capability metadata, the authoritative task ledger, Lead controller, Team Blackboard, runtime collaboration protocol, and public collaboration timeline

The root component consumes an injected `useCollaboration` selector Hook plus `createRun`, `confirmRun`, `retryFormation`, and `terminate` commands. `createRun` commits a reviewable planning snapshot without provisioning an expert or starting the Lead. The independent Chinese launcher then shows the exact Charter task DAG, serial and parallel stages, planned assignees, expert descriptions, presets, mounted skills, and plugins. Users may confirm the exact plan, return to the objective, submit cumulative free-form changes, or edit each expert's local skills through GUI controls. The skill editor lists only model-invocable entries from the current Lead preset, supports name and description search, disables removal at the effective per-expert minimum, and blocks confirmation while changes remain unapplied. Applying a GUI edit creates and validates a replacement immutable plan before cancelling the previous draft, so a failed skill resolution leaves the reviewed plan intact. Explicit per-expert skill floors, named-expert local-skill replacement/addition/removal, and stage serial/parallel requirements become verified planning constraints. Named skill changes accept the visible local skill ids and the built-in Chinese or English aliases, resolve every changed skill against the selected preset before the plan is published, and become the exact immutable runtime binding after confirmation. Unknown experts, unavailable skills, and unsatisfied constraints fail before a reviewable plan is published. Only `confirmRun` provisions the reviewed roster, materializes its task ledger, and starts the Lead through the existing execution protocol

The Lead coordinator and every expert card render independent Provider-grouped model selectors plus the selected model's adapter-owned reasoning efforts from the everyday-session catalog. Unapplied changes block confirmation; applying them creates a replacement plan carrying the exact Lead route and every expert slot selection, and the plan returned by the Host is the display authority

When a live expert tool call needs approval, the collaboration panel keeps the existing reject, one-shot, and current-Agent choices and adds **Allow this collaboration task** only when the Host binds the request to the displayed TeamRun. The task-wide action authorizes already-waiting and future tool approvals for every active member of that one run; it never appears for an unscoped everyday-session request. A pending expert approval opens a collapsed collaboration column so the answerable card cannot remain mounted outside the visible frame; an active run without a pending approval does not open the column

The source is authoritative outside the UI package. The collaboration store persists only navigation, filters, selected ids, and task-composer drafts; it never persists TeamRuns, profiles, charters, expert bindings, tasks, artifacts, decisions, quality gates, controller state, failures, or results

`team_formation_failed` is rendered as an explicit terminal where execution never started. The console does not present lead-only execution as a successful team. Retrying creates and selects a new TeamRun while the original failed run remains available as an immutable audit record

The existing session-level agent overlay remains available for legacy collaboration sessions. It can show a bounded child-session work summary and key dialogue without exposing reasoning blocks or execution chatter

The main conversation task list groups the authoritative DAG by dependency depth, labels each group as a serial or parallel stage, and labels every task itself as serial or parallel with its assigned expert name. Each compact row keeps the task status on the title line, renders the complete whitespace-normalized description without ellipsis, and keeps task mode plus owner on one metadata line where width permits. Completed steps remain struck through and visually muted. The task board renders dependency readiness, ownership, progress, resource scopes, and conflicts from the runtime projection. The public timeline renders the typed collaboration vocabulary, including viewpoints, challenges, responses, reviews, decisions, artifacts, and the lead agent's final delivery. Each participant keeps one deterministic identity color across message kinds, while message kinds remain textual badges. Avatars, message surfaces, and message-kind badges use borderless color fills, and message rows use spacing instead of separator lines. Routed content is projected into labeled context, next-step, recipient-selection, and message sections. The projection removes legacy sequential-handoff presentation markers and suppresses impossible author-equal-target labels from immutable historical receipts without rewriting those events. It excludes private model reasoning and highlights final delivery only when an authoritative `final_delivery` event exists

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

- The deterministic fixture covers forming with the three-expert minimum, running with eight experts, enforced and legacy protocols, normal, near-limit, and exhausted expert budgets, open and responded challenge threads, stalled and reworking control states, task dependencies, authoritative artifact and decision ledgers, failed and passed quality gates, completed delivery provenance, typed public discussion, formation failure, retry into a new TeamRun, cancellation, and refresh recovery presentation
- The P5 and P6 views are read-only projections. Protocol admission, task mutation, collaboration messaging, controller intervention, decision admission, artifact-body reads, quality-gate execution, and final-delivery admission remain owned by the authoritative collaboration runtime
- The legacy right panel still identifies older coordinator sessions by their collaboration title prefix
