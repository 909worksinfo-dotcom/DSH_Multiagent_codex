# Agent Note: Reviewed collaboration plan confirmation

Status: implemented

English | [中文](2026-08-29-reviewed-collaboration-plan-confirmation.zh.md)

## Problem

The independent multi-agent entry previously treated task submission as authorization to profile, plan, provision the expert team, and start the Lead in one transaction. Users could not inspect the task DAG, assigned agents, or mounted capabilities before model work began, and any requested plan change arrived too late to prevent the original team from executing

## Decision

The product creation boundary is now split into two durable commands. `collaboration.create` allocates the Lead-owned TeamRun and commits its Task Profile, exact roster plan, Team Charter, task DAG, planned assignee slots, and task-selected capability bindings, but leaves the run in `planning` with no expert member, materialized task, or Lead prompt. `collaboration.confirm` accepts the matching request identity, provisions that exact roster, materializes and assigns the Charter tasks and quality gates, activates the run, and then admits the existing Lead execution prompt

The independent entry and plan-review surface always use Chinese product copy. The review presents the complete objective, dependency-derived serial and parallel stages, every task's planned expert name, and every planned expert's responsibility, preset, mounted skills, and plugins. A user can confirm the exact plan, return to edit the objective, enter free-form changes, or edit each expert's local skills with GUI controls. The editor queries the current Lead Session's model-invocable skill catalog, supports local search, prevents removal below the effective expert-skill floor, and blocks confirmation until a changed selection has been applied. Applying skill edits creates a replacement immutable planning record with exact per-expert skill replacements, validates every selected skill through the existing planner and preset resolution, then cancels the previous draft. If replacement creation or validation fails, the current reviewed draft remains available

The right collaboration dock opens only after confirmation. Existing execution routing, parallel-stage admission, completion evidence, public discussion, model providers, approval policy, and execution-message folding remain unchanged

Catalog recovery discovers live Leads from their durable profile marker before strict per-run replay. A historical run that cannot satisfy the current replay contract is omitted only when at least one healthy run remains visible; an all-incompatible catalog still returns an explicit failure instead of pretending that no collaboration history exists

## Verification

UI component tests prove that planning renders three or more experts and their assigned tasks before confirmation, that no active conversation appears early, that confirmation starts the existing Lead view, that English system locale does not leak into the entry, and that free-form revision replaces the draft without confirming it. They also remove one mounted skill, search and add an available replacement, prevent confirmation while the GUI selection is dirty, and assert the exact per-expert replacement requirement submitted for a new reviewed plan

Runtime and carrier tests cover the new typed confirmation RPC, no Lead prompt during `createRun`, model-invocable filtering for review-time skill lookup, exact Charter assignee projection, active formation and prompt admission during `confirmRun`, retained active state when prompt admission must be retried, and healthy catalog visibility beside an incompatible historical run. A real TeamOrchestrator composition test proves that `create` leaves members and task storage empty, reviewed skill replacements resolve before publication, and `form` provisions and materializes the exact reviewed plan

## Alternatives considered

**Render a temporary plan generated only in the browser.** Rejected because it could diverge from the roster, task DAG, and capability bindings that the Host later executes

**Provision experts before review but delay only the Lead prompt.** Rejected because expert sessions and provider-side effects would already exist before the user approved the team configuration

**Mutate the existing plan in place after each change request.** Rejected because this would weaken the immutable audit and make retries ambiguous

**Display a browser-only editable skill list and pass it directly to confirmation.** Rejected because the visible list could diverge from the durable Host plan and would bypass preset-specific skill resolution

## Consequences

Starting a collaboration now requires an explicit confirmation step and one additional typed RPC. Planning drafts remain durable and recoverable, cancelled revisions remain auditable, and no expert or model execution begins before approval. GUI skill edits add one read-only skill-catalog request and one replacement planning transaction, but the exact reviewed binding remains the single source used for provisioning and recovery. The UI gains a larger but bounded confirmation surface while active TeamRun behavior remains compatible with existing collaboration execution
