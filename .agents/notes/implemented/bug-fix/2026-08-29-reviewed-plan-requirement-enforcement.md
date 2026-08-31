# Agent Note: Reviewed plan requirement enforcement

Status: implemented

English | [中文](2026-08-29-reviewed-plan-requirement-enforcement.zh.md)

## Problem

The collaboration review screen accepted free-form changes by appending them to the task objective and generating another deterministic plan. Explicit structural requests such as “mount three skills for every expert” and “make the two tasks in stage 1 serial” therefore appeared in the text but did not constrain skill binding or task dependencies. Repeated revisions also nested multiple adjustment headings and leaked those headings into task descriptions

This was a false-confirmation risk because the user could approve a durable charter whose visible team and stages contradicted the requested revision

## Decision

Reviewed objectives now retain one cumulative adjustment block. The profiler canonicalizes legacy repeated headings, separates the original task from their cumulative requirements, and parses enforceable skill-floor and stage-mode requirements into the durable Task Profile

A serial-stage requirement is materialized as real task dependencies before assignment, so preview grouping, durable event replay, and runtime readiness use the same canonical DAG. An exact stage-and-task requirement is bound to the referenced one-based task before stage mutations, appended to that task's visible description, and converted into capability and resource signals when it requests a known deliverable such as a Feishu document. A stage/task mismatch fails planning instead of modifying a different step

A per-expert skill floor counts only immutable local skills and task-bound marketplace capabilities whose state is `loaded` or `connected`. Planning fails closed before publishing a reviewable plan when any expert misses the requested floor; authorization-required candidates never count as mounted

The shipped expert blueprints expose three executable local skills from the existing standard preset. No skill implementation or plugin content is changed

## Verification

Regression tests prove that the original broken objective produces a four-stage serial DAG, excludes adjustment prose from task descriptions, applies “stage 3 task 04 must deliver a Feishu document” only to the exact final task, rejects inconsistent stage/task references, survives durable event replay, and refuses to persist a plan when only two executable skills are available. A UI regression test applies two consecutive revisions and proves that one cumulative adjustment heading remains

The affected collaboration suites, Host and Client type checks, targeted static checks, the complete web build, and a local browser run validate the production composition and the reviewed-plan-to-confirmation boundary

## Alternatives considered

**Continue relying on keyword relevance.** Rejected because relevance can reorder experts but cannot prove a requested skill count or execution mode

**Display the revision as advisory text.** Rejected because the confirmation screen represents a committed execution contract

**Count authorization-required marketplace candidates.** Rejected because those capabilities cannot execute before authorization and would make the mounted-skill label false

**Rewrite the existing planning event.** Rejected because persisted review drafts are immutable audit records. Regeneration creates a new corrected plan and retains the cancelled draft

## Consequences

Supported structural revisions are now observable execution constraints instead of prompt decoration. Preview stages, runtime task readiness, and expert skill counts agree before the confirmation button can start execution. An unavailable capability produces an explicit planning failure instead of an apparently successful but non-compliant plan
