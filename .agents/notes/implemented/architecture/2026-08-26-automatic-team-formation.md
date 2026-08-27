# Agent Note: Automatic fail-closed team formation

Status: implemented

English | [中文](2026-08-26-automatic-team-formation.zh.md)

## Problem

Stable TeamRun state and immutable expert provisioning provide the P1 and P2 enforcement primitives, but neither turns a user objective into a complete team. A product caller still needs one authority for profiling the task, selecting an exact roster, committing collaboration rules, provisioning every member, exposing the result to the browser, and representing failure without a Lead-only fallback.

The Demo product also needs formation to survive refresh and restart without moving authority into browser storage or exposing preset sources, skill paths, prompt bodies, composition digests, or private model reasoning.

## Decision

[`@deepseek-ai/dsh-team-orchestrator`](../../../../packages/collaboration/team-orchestrator/README.md) owns automatic Task Profiler, Team Planner, Team Charter, and exact-strength formation. It commits required-on-read `collaboration/orchestration/profile`, `collaboration/orchestration/plan`, and `collaboration/orchestration/charter` events to the Lead Session before provisioning experts through the P2 runtime.

The deterministic Demo profiler normalizes the objective, success criteria, workstreams, dependencies, capability signals, tool density, and risk. It assigns exactly one expert to a simple task, two through four to a medium task, and five through eight to a complex task. The planner selects exact immutable blueprint revisions from one configured domain pool and selects only a topology legal for that complexity. The charter freezes the objective, success criteria, task DAG, topology, communication limits, quality checks, per-expert budgets, and fail-closed termination rule.

Formation reaches `active` only after every planned slot has an accepted P2 expert binding and child Session. Unavailable capabilities, exhausted capacity, failed provisioning, cancellation, or invalid persisted state cannot produce a smaller successful team. Request, plan, charter, binding, and descriptor validation make replay idempotent and reject composition drift.

## Product composition

The web bundle mounts stable TeamRun, Expert Catalog, Expert Runtime, Team Orchestrator, model-facing team tools, twenty-four exact blueprints, and the three first-wave professional skill definitions. Each research-analysis, product-solution, and software-development pool contains eight distinct configured revisions, so the planner can form the maximum complex roster without inventing a capability.

[`packages/host/apiproxy`](../../../../packages/host/apiproxy/README.md) exposes create, list, get, interrupted-formation retry, and cancel operations over the real orchestration service. Cold listing resumes a Lead Session whose durable log contains an orchestration profile. Browser values are strict allowlist projections: capability ids and labels cross the boundary, while source paths, prompt text, persona, raw configuration, digests, causes, and private reasoning do not.

[`packages/client/runtime`](../../../../packages/client/runtime/README.md) owns reconnect-safe collaboration snapshots and product commands. Creation allocates a fresh Lead Session before calling Host formation. A user retry of terminal `team_formation_failed` creates a fresh Lead and TeamRun carrying `retryOf`; the failed run remains immutable and visible for audit. The collaboration UI stores only navigation and draft state and renders the authoritative runtime profile, charter, roster, capability labels, status, and explicit failure.

## Scope boundary

This decision implements the automatic-formation slice of the broader [natural multi-agent collaboration proposal](../../proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md). Typed expert discussion, challenge and response rounds, mutable task-ledger coordination, artifacts, decisions, Lead completion checks, and FinalDelivery remain later stages. The current profiler is a deterministic multilingual Demo classifier, not an LLM semantic planner.

## Verification

Package tests cover classification bands, legal topology selection, exact roster planning, charter construction, idempotent replay, cancellation, capability and provisioning failure, fail-closed terminal state, cold recovery, browser-safe wire schemas, fresh-run retry, runtime refresh, and UI formation and failure flows. Repository type, lint, build, package-invariant, skill-metadata, document, GUI, web snapshot, and local browser checks exercise the composed product.

## Alternatives considered

**Let the Lead prompt create experts directly.** Rejected because prompt behavior cannot enforce exact roster bands, immutable capability binding, idempotent replay, or terminal formation failure across every caller.

**Keep the team plan in browser state.** Rejected because refresh, reconnect, cancellation, and cross-client reads require a durable Host authority, and browser persistence cannot validate capability composition.

**Retry a terminal failure in place.** Rejected because terminal TeamRun state is immutable audit evidence. A fresh Lead and `retryOf` link preserve both the failed attempt and the user's new attempt.

**Return internal binding records to the UI.** Rejected because the roster needs capability identity, not local paths, prompts, digests, or private execution configuration.

## Consequences

Every admitted product task has a Lead plus at least one capability-bound expert before execution can begin, and complex tasks can form eight-expert teams through the same path. Users can inspect the automatic profile, charter, complete roster, and explicit formation failure from the collaboration page.

The deterministic profiler favors reproducibility and local validation over semantic flexibility. The configured pools and their exact blueprint revisions are deployment policy and must be expanded deliberately when new domains or capability combinations are introduced.
