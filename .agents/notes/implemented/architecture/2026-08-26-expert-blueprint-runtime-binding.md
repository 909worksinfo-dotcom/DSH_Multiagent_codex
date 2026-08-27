# Agent Note: Immutable ExpertBlueprint runtime binding

Status: implemented

English | [中文](2026-08-26-expert-blueprint-runtime-binding.zh.md)

## Problem

The stable TeamRun domain can reserve and settle expert roster attempts, but P1 deliberately does not decide which preset, skills, plugins, tools, model route, persona, or execution limits one expert receives. A roster row alone therefore cannot prove that an active member is a real child with the required capabilities.

Continuable children historically inherit the Lead composition. That behavior is useful for general delegation, but it cannot reproduce an expert-specific composition after a process restart. Resolving only a mutable blueprint name at activation time would also let preset or skill changes silently alter a previously accepted team.

## Decision

[`@deepseek-ai/dsh-expert-catalog`](../../../../packages/collaboration/expert-catalog/README.md) owns locally configured immutable `ExpertBlueprint` revisions. A revision declares role, objective, preset, skills, plugin rows, tool policy, model policy, optional persona, structured inputs and outputs, acceptance criteria, collaboration permissions, and execution budgets.

Catalog resolution requires the exact preset source, statically enabled required plugin rows, and model-invocable winning skill definitions in the preset's standing scope. It records SHA-256 digests for the blueprint, preset source, and each resolved skill, then derives one canonical binding digest over the complete resolved capability set. A missing revision, broken preset, dynamic or disabled required plugin row, missing skill, or unreadable capability fails with `CAPABILITY_UNAVAILABLE`; no required capability is omitted as a fallback.

[`@deepseek-ai/dsh-expert-runtime`](../../../../packages/collaboration/expert-runtime/README.md) is the adapter between that catalog, the stable TeamRun transitions, and continuable subagents. Provisioning resolves capabilities and provider availability before consuming an attempt, then reserves the P1 roster row, flushes an immutable Lead-side binding, creates the exact child Session, writes its matching child descriptor, mounts the selected preset and restrictions, publishes the child, commits P1 activation, and only then admits the initial expert prompt.

If any step after reservation fails, the runtime drains the child to quiescence and records the attempt as failed. This compensation also applies after the child is published but before the first prompt is admitted. New formation remains closed during `completing`, while a late active-expert failure is still durable so exact-team completion is rejected and the Lead must terminate the run as failed.

## Durable composition and recovery

The Lead Session owns `collaboration/expert/binding`; the child owns `collaboration/expert/descriptor`. Both records carry the exact TeamRun, member, Session and attempt identities plus the complete immutable capability descriptor. The descriptor includes the absolute deadline and effective turn and output-token limits.

The continuable subagent descriptor is version 3 and durably retains explicit agent preset, resolved provider, model, maximum output tokens, persona, and tool restrictions. Fresh creation and cold resume therefore use the same composition instead of inheriting whatever the Lead or catalog currently exposes.

Every fresh activation, recovery, cold follow-up, and pre-model step validates the parent binding, child descriptor, current catalog resolution, and complete derived composition. A missing descriptor, identity mismatch, changed capability, or binding drift fails closed with `BLUEPRINT_REVISION_MISMATCH`. Recovery reuses a live child without replay, resumes a persisted child with its retained prompt only when that prompt was never accepted, and refuses an active roster row whose child identity has disappeared.

## Budget enforcement

The blueprint turn limit counts only the child Session's own turns after its descriptor, excluding inherited history. The effective model output ceiling is the lower of the model policy and blueprint token budget and is retained in the continuable descriptor. An absolute persisted deadline installs a cancellation timer on fresh and already-live expert Agents. Budget or drift rejection records the active expert failure before another model step can start.

## Scope boundary

P2 provides exact-revision expert provisioning and recovery primitives. The [automatic team formation decision](2026-08-26-automatic-team-formation.md) composes them with Task Profiler, Team Planner, Team Charter, Host transport, and the authoritative browser projection. Bounded discussion orchestration and Lead completion policy remain later stages. P2 does not modify the replaceable agent loop.

## Verification

Package tests cover immutable catalog snapshots, strict blueprint validation, preset and plugin resolution, skill digests, unavailable and dynamic capabilities, deterministic prompt rendering, binding and descriptor folds, fresh provisioning order, rollback, cold recovery without duplicate work, capability drift, tampered records, concurrent revision retries, follow-up authorization, and turn, token, and deadline budgets. A real-provider integration test composes Loader, Agent presets, ExpertCatalog, TeamRun, JSONL persistence, SubagentRuntime, the `spawn` in-process provider, and AgentLoop, then reloads the accepted child result and both descriptors from persistence. Repository type, lint, package-invariant, generated-document, translation, build, and local browser regression gates include the new stable packages.

## Alternatives considered

**Let every expert inherit the Lead preset.** Rejected because distinct professional capabilities are a product requirement and inherited composition cannot prove or reproduce an expert-specific binding.

**Persist only an ExpertBlueprint id.** Rejected because the same id could resolve to changed preset, plugin, or skill contents after restart. Exact revision plus content digests makes drift observable.

**Create the child before writing TeamRun state.** Rejected because a child could execute without an auditable roster attempt or durable parent binding. The ordered transaction makes every published child traceable to P1 authority.

**Silently remove unavailable capabilities.** Rejected because a nominal expert without its required skill or plugin violates the planned team and makes successful formation misleading.

**Add expert branches to `agent-loop`.** Rejected because preset mounting, scoped tools, continuable children, Session events, and pre-step interception already provide the required extension points with a smaller regression surface.

## Consequences

P2 turns a P1 roster attempt into a reproducible expert runtime with fail-closed recovery and observable capability identity. Later planning can select exact catalog revisions without owning child mechanics or persistence.

Every expert activation now pays capability-resolution and digest-validation cost, and a local capability edit intentionally blocks an old binding instead of silently resuming. Operators must add a new blueprint revision when changing an accepted expert composition.
