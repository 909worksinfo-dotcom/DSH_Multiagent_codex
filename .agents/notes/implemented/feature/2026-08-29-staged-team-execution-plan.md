# Agent Note: Staged team execution plan

Status: implemented

English | [中文](2026-08-29-staged-team-execution-plan.zh.md)

## Problem

An automatically formed team previously committed a roster and a task DAG, but the inferred task list could remain too coarse, the plan did not retain one executor per step, and the main collaboration workspace rendered a flat list. That made it difficult to verify whether execution followed a complete plan

## Decision

An inferred research, product-solution, or software-development request now expands into a bounded domain-specific execution DAG. Explicit caller workstreams remain unchanged. The planner groups dependency layers into immutable serial or parallel stages and assigns every workstream to one roster slot

Formation provisions the complete roster, then uses the Lead-only `assign` transition to bind each pending task to its planned active expert without starting blocked work. A routed `task` message must reference a ready task and target that exact owner. Serial stages retain the single-message collaboration baton, while an explicitly parallel stage now admits its distinct ready task owners concurrently and joins them before downstream work starts

The main collaboration conversation derives stages from the authoritative runtime DAG, shows the serial or parallel label on both stages and individual tasks, and displays the localized assigned expert name for each step. Task-list descriptions are whitespace-normalized and capped at 60 Unicode characters while the authoritative description remains unchanged. Completed steps remain struck through and muted

## Verification

The contract is covered at profiler/planner, durable fold, task-board, orchestration, model-router, Host composition, and client rendering boundaries. Historical orchestration payloads without the new optional persisted planning fields remain parseable and immutable

## Alternatives considered

**Keep a flat task list and infer stages only in the UI.** This would not give the runtime an immutable execution order or a reliable owner mapping, so displayed parallelism could diverge from actual orchestration

**Let the Lead create tasks while executing.** This would allow task duplication and plan drift, and would prevent formation from validating that every planned expert has bounded work before execution starts

## Consequences

The task list now gives users a concise stage, mode, owner, and completion projection while the durable Charter remains authoritative. Inferred plans carry more structure and formation performs assignment work before activation, but explicit caller-authored workstreams and historical payloads retain their previous meaning
