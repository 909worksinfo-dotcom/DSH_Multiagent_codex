# Agent Note: Evidence-backed task completion

Status: implemented

English | [中文](2026-08-29-evidence-backed-task-completion.zh.md)

## Problem

The task ledger drives both the center checklist and the collaboration panel. An enforced task could reach `completed` as soon as its expert owner wrote a review-state artifact, before that artifact was routed to Lead or accepted. The two interfaces therefore presented completion while specialist execution or Lead review was still in progress, and downstream tasks could become ready against unverified work

Persisted runs are immutable audit records. Some historical runs contain that premature task status, so correcting only the command path would still expose a false completion when those records are viewed

## Decision

An enforced task has one evidence-backed commit point. Its owner must be an active expert, the owner must publicly route an artifact with the exact task and artifact references to Lead, Lead must accept that owner-authored artifact, and Lead must perform the task `complete` transition. An expert completion attempt, a missing route, a mismatched artifact, or a review-state artifact fails without changing the task revision

Lead and expert prompts preserve the same ordering. Experts submit evidence and return control without completing the task. Lead reads and accepts the exact evidence before confirming task completion, then proceeds to quality gates, decisions, and final delivery

The client derives a presentation-safe status for immutable historical runs. A raw enforced `completed` task is displayed as completed only when its accepted owner artifact and exact public route to Lead are both present; otherwise both checklists display it as in progress and their progress counters use that corrected projection. Legacy protocol runs retain their existing task-transition semantics

## Verification

Domain tests cover expert refusal, Lead refusal before evidence, refusal after an unrouted artifact, refusal after a routed but unaccepted artifact, and successful Lead completion after acceptance. Adapter and prompt tests lock the execution order, while client runtime tests cover both a malformed historical completion and a valid routed-and-accepted completion. Broader collaboration suites, type checking, the web build, and local browser verification cover the affected execution and presentation paths

## Alternatives considered

**Trust the model prompt without a domain invariant.** Rejected because a delayed or mistaken tool call can still persist a false completion and unblock dependent work

**Treat a review-state artifact as completion.** Rejected because review is explicitly unresolved and does not prove that Lead received or accepted the work

**Repair only the two interfaces.** Rejected because the ledger would remain semantically wrong and dependent tasks would still start from an unverified blocker

**Rewrite historical TeamRun events.** Rejected because the Session journal is an immutable audit source. Projection compatibility prevents overclaiming without changing durable evidence

## Consequences

Both checklists use `completed` as a verified state instead of an optimistic progress signal. Dependent tasks remain blocked until Lead accepts the exact expert evidence and commits completion. Historical malformed records remain replayable but are presented conservatively, and legacy unprotocolled runs keep their prior behavior
