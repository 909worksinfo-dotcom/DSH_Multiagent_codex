# Agent Note: Surface blocking expert approvals in collaboration runs

Status: implemented

English | [中文](2026-08-30-visible-collaboration-expert-approvals.zh.md)

## Problem

An expert child session could request tool approval while a collaboration task was running. The runtime correctly kept the task in progress and paused its execution timeout, but the collaboration panel did not expose approvals owned by expert sessions. The user therefore saw an apparently stalled run with no available action

## Decision

The collaboration client now reads pending approvals directly from every expert session in the active run and renders one blocking approval notice above the collaboration tabs. The notice identifies the expert, tool, and reason, and offers reject, allow once, or allow for the current task without changing the existing permission policy

Approval responses are bound to the exact pending wait key. A stale key or rejected runtime receipt is surfaced as an error instead of answering a different request or pretending that execution resumed

The scan uses the run roster as its source of expert sessions and treats session-list updates only as an invalidation signal. This keeps approvals visible even when the sidebar summary projection is delayed or omits a pending child wait

## Alternatives considered

**Approve expert tools automatically.** Rejected because it would bypass the user's configured permission boundary

**Copy approval state into the collaboration domain store.** Rejected because it would duplicate volatile runtime state and create stale approval records

**Inspect only sidebar session summaries.** Rejected because the observed failure already demonstrated that their pending projection can lag behind the authoritative child session

## Consequences

Collaboration tasks that require expert tool approval now visibly enter a waiting-for-approval state and can continue after the user decides. Existing task execution, timeout pausing, team routing, and completion gates remain unchanged
