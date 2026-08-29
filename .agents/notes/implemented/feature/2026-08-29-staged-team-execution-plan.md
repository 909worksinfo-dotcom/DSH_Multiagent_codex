# Agent Note: Staged team execution plan

Status: implemented

English | [中文](2026-08-29-staged-team-execution-plan.zh.md)

## Context

An automatically formed team previously committed a roster and a task DAG, but the inferred task list could remain too coarse, the plan did not retain one executor per step, and the main collaboration workspace rendered a flat list. That made it difficult to verify whether execution followed a complete plan

## Decision

An inferred research, product-solution, or software-development request now expands into a bounded domain-specific execution DAG. Explicit caller workstreams remain unchanged. The planner groups dependency layers into immutable serial or parallel stages and assigns every workstream to one roster slot

Formation provisions the complete roster, then uses the Lead-only `assign` transition to bind each pending task to its planned active expert without starting blocked work. A routed `task` message must reference a ready task and target that exact owner. The existing single-message collaboration baton remains unchanged, so a parallel stage means dependency-independent work rather than simultaneous model turns

The main collaboration conversation derives stages from the authoritative runtime DAG, shows the serial or parallel label on both stages and individual tasks, and displays the localized assigned expert name for each step. Task-list descriptions are whitespace-normalized and capped at 60 Unicode characters while the authoritative description remains unchanged. Completed steps remain struck through and muted

## Verification boundary

The contract is covered at profiler/planner, durable fold, task-board, orchestration, model-router, Host composition, and client rendering boundaries. Historical orchestration payloads without the new optional persisted planning fields remain parseable and immutable
