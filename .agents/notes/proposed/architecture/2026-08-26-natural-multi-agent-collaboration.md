# Agent Note: Natural multi-agent collaboration product runtime

Status: proposed

English | [中文](2026-08-26-natural-multi-agent-collaboration.zh.md)

## Problem

The existing Agent Teams capability is an opt-in experimental coordination layer over continuable children. It provides a durable roster, peer mailbox, and shared task DAG, but every teammate inherits the Lead's composition, team formation is prompt-directed, tasks and messages lack product collaboration semantics, and failed provisioning permanently consumes the configured member limit.

The collaboration playground creates browser-local task cards around an ordinary coordinator Session. It derives work and participant views from existing Session and subagent records, but it has no authoritative TeamRun, structured discussion, decision, artifact, quality, or final-delivery records. A title prefix identifies coordinator Sessions, so renaming one can remove the collaboration presentation without changing runtime state.

The product requires every task to create a Lead-led expert team. Users must see public tasks, proposals, challenges, responses, reviews, decisions, artifacts, and delivery without receiving private model reasoning. Simple sequential work still needs a team, while larger decomposable work can use up to eight experts without permitting an unbounded peer mesh.

## Proposal

The collaboration product profile creates one TeamRun for every admitted user task before task execution begins. The initiating Session is the Lead, simple tasks use one expert, medium tasks use two through four experts, and complex tasks use five through eight experts. A run that cannot provision its minimum expert count reaches an explicit formation failure and never continues as a silent Lead-only run.

Task Profiler derives complexity, decomposability, sequential dependencies, tool density, and risk. Team Planner selects validated ExpertBlueprint revisions from Capability Catalog and commits a Team Charter containing the objective, success criteria, roster, task DAG, collaboration topology, communication limits, quality checks, budgets, and termination policy. Model planning proposes these values, while runtime validation and configured bounds enforce them.

Each ExpertBlueprint binds a role and objective to one agent preset, a set of skills and plugins, a tool policy, a model and context policy, collaboration permissions, input and output fields, acceptance criteria, turn and token budgets, timeout, and immutable revision. Capability Catalog admits only locally configured definitions; the Lead cannot install an unknown skill or plugin during formation.

The collaboration protocol records typed public events for tasks, proposals, help requests, challenges, responses, reviews, decisions, handoffs, blockers, completion requests, artifacts, status, and final delivery. Private reasoning and chain-of-thought blocks never enter the public collaboration projection. Medium and complex work supports bounded challenge and response rounds; complex teams use Lead-directed or grouped communication instead of an all-to-all default.

The Lead owns Task Ledger and Progress Ledger, detects stalls and repetition, reallocates or replaces experts, revises the plan, applies completion checks, and creates FinalDelivery only after required artifacts, dependencies, reviews, and acceptance criteria pass. Team Blackboard stores versioned artifact metadata and decision records in the same durable Team authority.

Team tasks retain compare-and-set revisions and a complete dependency DAG while replacing code-specific `writeScopes` with generic advisory `resourceScopes`. A resource scope reports conflicting ownership but does not claim a filesystem lock, permission grant, or merge guarantee.

## Runtime ownership

| Owner | Responsibility |
|---|---|
| Stable `agent-team` collaboration package | TeamRun identity, roster, mailbox, task state, durable event replay, lifecycle, and configured limits promoted from the experimental Team service |
| Stable `tool-agent-team` collaboration package | Model-facing Team communication and task tools with structured results and scoped authority |
| Stable `expert-catalog` collaboration package | ExpertBlueprint registration, capability resolution, revision lookup, and configuration validation |
| Stable `team-orchestrator` collaboration package | Task Profiler, Team Planner, Team Charter, topology rules, collaboration protocol, Lead ledgers, Team Blackboard, completion checks, and FinalDelivery |
| `packages/host/apiproxy` | Host queries, controls, event cursors, and transport schemas over collaboration services |
| `packages/client/runtime` | JSON-compatible collaboration projections and reconnect-safe client state |
| `packages/client/ui-collaboration` | Task launch, team formation, public timeline, task graph, decisions, artifacts, budgets, failures, and final delivery presentation |
| `packages/bundle/web-app` | Product composition that mounts collaboration owners in dependency order |

No collaboration package imports or modifies `agent-loop`. Durable model-visible inputs use Session events, live interception uses Agent or capability events, and per-expert behavior uses the existing preset, skill, plugin, tool, and subagent extension points.

## Host and browser contract

Cross-process records use branded TeamRun, member, task, thread, challenge, decision, artifact, and event ids. `TeamRunSnapshot` carries one of `forming`, `running`, `blocked`, `reviewing`, `reworking`, `completed`, `team_formation_failed`, `failed`, or `cancelled`, and it reports the authoritative Lead and expert count instead of asking the browser to infer either value.

The Host operations are `collaboration.create`, `collaboration.list`, `collaboration.get`, `collaboration.events`, `collaboration.send`, `collaboration.complete`, `collaboration.retryFormation`, `collaboration.terminate`, and `collaboration.readArtifact`. Creation atomically establishes TeamRun and its Lead. Event reads use a monotonic cursor and idempotent event ids; reconnect first restores an authoritative snapshot and then continues after its cursor. Failures return a code, message, retryability, and structured details.

`PublicCollaborationMessage` carries event sequence, TeamRun, thread, author, targets, optional task, challenge, decision, and artifact references, content, creation time, and literal public visibility. The Host decides visibility before committing the public record; the browser does not use reasoning-block filters or text heuristics as a privacy boundary.

Client runtime owns `TeamRunManager`, `TeamRun`, `TeamRunSnapshot`, and `CollaborationCatalogSnapshot`. The UI store retains only viewing state such as open state, selected run and member, tab, filters, panel width, and draft. Members, messages, tasks, charter, artifacts, decisions, failures, and final delivery remain runtime projections reached through renderer-bound hooks.

## Implemented P4 execution slice

P4 materializes every committed Charter task DAG into the stable TeamRun task board before activation. A dependency-first walk accepts a legal DAG in any input order and fixes generated task ids deterministically. Recovery accepts only an exact, untouched materialization prefix; an extra, reordered, edited, owned, or otherwise divergent task fails closed instead of binding the Charter to unrelated mutable work.

The compact Host run projection now carries the Session cursor, all current non-deleted tasks, and total, ready, in-progress, completed, blocked, and public-message counts. Full discussion remains outside that snapshot. `collaboration.events` pages only typed public messages after an exclusive cursor with a limit from one through 100, while `collaboration.send` publishes through the exact live Lead and has no private-reasoning input field.

Completion is one validated TeamRun batch. The domain requires a non-empty completed task board, accepted task artifacts, both a public completion request and review, at least one passed quality gate, and per-task Lead acceptance linked to an accepted task artifact before it appends `completing`, the Lead's `final_delivery`, and `completed`. Host `collaboration.complete` and Lead-only `collaboration_complete` use this operation, so an admission failure leaves the active run unchanged.

## Implemented P5 control and ledger slice

P5 adds three required-on-read event families for complete versioned artifacts, independent Lead decisions, and materialized quality gates. Compact run projections expose artifact metadata but never the body; only membership-authorized `readArtifact()` and Host `collaboration.readArtifact` return it. Artifact count and UTF-8 body limits are snapshotted with each run, and validation failure appends neither metadata nor public evidence.

Every formal artifact, decision, or quality result is committed with a corresponding typed public record in one prevalidated Session batch. Decision arbitration and quality settlement require the Lead. The deterministic Lead Controller derives health, cursor-based stalls, duplicate task subjects, quality failures, missing active experts, recommendations, and recorded actions from the durable fold without an uncontrolled timer. Only explicitly typed task relations from task, message, artifact, decision, or quality-gate events refresh task activity. Lead-only reassign, rework, and replan operations atomically commit the task revision, decision, and public evidence. Missing active experts produce `replace_expert`; TeamOrchestrator resolves the failed member to its durable planned slot and idempotently runs the next immutable attempt through ExpertRuntime, preserving provider failures instead of claiming recovery.

The active public status follows the same controller evidence: understaffing, a stalled task, or a failed quality gate is `blocked`; the latest rework action is `reworking`; a complete delivery gate is `reviewing`; otherwise the active run is `running`. This keeps UI status and controller health from presenting contradictory states.

The Charter quality checks materialize as an exact ordered gate prefix before activation, and active cold recovery rejects drift. Completion requires non-empty completed tasks, an accepted artifact for each task, both completion-request and review records, at least one materialized quality gate with every gate passed, and accepted Lead decisions that cover every task through one of its accepted artifacts. Only then can the existing `completing` → `final_delivery` → `completed` batch commit. Missing or unrelated evidence preserves the complete aggregate unchanged.

This slice does not implement automatic expert wakeups, wall-clock-only monitoring, or distributed multi-process transactions. Stalls update when durable activity advances the run cursor.

## Capacity and recovery

`maxActiveExperts` limits the sum of active and provisioning experts and excludes the Lead. It defaults to eight for this product profile. Failed members retain immutable names and attempt ids for audit but release the active slot. `maxProvisionAttempts` separately limits all provisioning attempts and defaults to twelve, so a valid replacement can fill the planned team without permitting infinite retries.

The internal lifecycle is `profiling`, `planning`, `provisioning`, `active`, `completing`, and `completed`, with `formation_failed`, `failed`, and `cancelled` terminal failures. The browser may fold the first three states into `forming`, but the durable events retain the exact state and failure cause.

The Team stores `ExpertBlueprintRef { id, revision }`, preset revision or content digest, and the resolved binding digest before starting each child. The continuable subagent descriptor retains the recovery inputs needed to reproduce that composition. A Team binding and child descriptor digest mismatch fails with `BLUEPRINT_REVISION_MISMATCH` instead of resuming with current catalog contents.

The initial error set includes `TEAM_MEMBER_LIMIT`, `FORMATION_FAILED`, `CAPABILITY_UNAVAILABLE`, `BLUEPRINT_REVISION_MISMATCH`, `RESOURCE_CONFLICT`, `STALE_REVISION`, and `DELIVERY_FAILED`. Session Projection retains compact team phase, roster, counts, and summaries; complete discussion and artifact records remain paged event-backed reads so Session tails do not duplicate the whole team history.

One process and one shared checkout remain the Demo execution environment. The software-development domain assigns one active writer by default and uses other experts as reviewers or testers. Disjoint resource scopes may permit parallel writers, but advisory ownership does not claim filesystem locking or merge isolation.

## Evaluation baseline

The machine-checked [collaboration evaluation corpus](../../../../scripts/fixtures/collaboration-evaluation-corpus.json) contains ten research-analysis, ten product-solution, and ten software-development tasks. Each domain has three simple, four medium, and three complex cases. The corpus also pins the visibility policy and failure rehearsals for provisioning, capability resolution, tools, structured output, replay, concurrency, discussion bounds, artifacts, restart, reconnect, cancellation, and stalls.

## Relationship to current decisions

Existing multi-agent runtime and browser decisions provide implementation evidence, not constraints on this product proposal. When an existing contract conflicts with the current product requirements and acceptance corpus, the implementation replaces that contract atomically through its owning extension point.

The [durable Agent Teams decision](../../implemented/feature/2026-08-05-agent-teams.md) remains the authority for the shipped experimental roster, mailbox, task, and shared-checkout behavior until promotion replaces those contracts. The [experimental package decision](../../implemented/architecture/2026-08-18-experimental-agent-teams-packages.md) continues to exclude the current packages from releases until the stable collaboration group lands. The [collaboration playground decision](../../implemented/feature/2026-08-17-collaboration-playground.md) remains the authority for the existing browser feature until the host-backed collaboration projection replaces its browser-local task authority and title-prefix identification.

## Alternatives considered

**Keep Agent Teams opt-in.** Rejected because the product requirement defines a team as the execution unit for every task. Adaptive size and topology control overhead without permitting a Lead-only success path.

**Express formation and collaboration only through coordinator prompts.** Rejected because prompts cannot enforce capacity, capability admission, permissions, event visibility, termination, completion checks, or recovery invariants across alternate callers.

**Allow every expert to communicate with every other expert without bounds.** Rejected because communication grows quadratically and can consume the task budget before execution. The topology limits candidates and rounds while preserving direct challenge between relevant peers.

**Keep browser task cards as the product authority.** Rejected because browser storage cannot own lifecycle, durability, replay, cancellation, or cross-client recovery. The browser owns viewing state and derives product state from host projections.

**Rewrite the agent loop around teams.** Rejected because the existing Session, Agent, preset, tool, skill, subagent, and event extension points already own the required behavior. A loop change would enlarge the regression surface and couple one product composition to the replaceable driver.

## Acceptance criteria

- Every admitted product task creates one TeamRun with one Lead and at least one expert before task execution
- Simple, medium, and complex tasks enforce expert bands of one, two through four, and five through eight
- Failed formation can retry within its provisioning budget but cannot silently continue with fewer than the planned minimum
- Every expert uses a validated immutable ExpertBlueprint revision and recovers with the same composition
- Collaboration rules, permissions, round limits, budgets, and completion checks are enforced by runtime operations
- Public projections include the complete typed collaboration record and exclude private reasoning and chain-of-thought content
- Lead recovery reconstructs roster, tasks, public messages, ledgers, artifacts, decisions, and terminal delivery from durable records
- The thirty-case local corpus passes its hard functional checks across the host and browser product composition

## Risks

Every task spends at least two model contexts, so simple-task latency and token use increase. The product must expose budgets and retain the one-expert path rather than hiding this cost.

Eight experts can overload the mailbox, UI, and Lead context even when work is decomposable. Candidate filtering, grouped topology, bounded rounds, event projection limits, and staged activation need stress coverage before the Demo release candidate.

Promoting the experimental packages changes paths, npm names, configuration rows, generated catalogs, and snapshots atomically. The pre-release repository permits this change, but partial promotion would violate experimental dependency isolation.

The current working tree contains overlapping uncommitted collaboration and conversation UI work. Implementation must preserve its baseline, assign file ownership before each phase, and avoid mixing unrelated changes into the collaboration stack.
