# Agent Note: Collaboration task-wide approval

Status: implemented

English | [中文](2026-08-31-collaboration-task-wide-approval.zh.md)

## Problem

The everyday approval service already supports `allowed-for-turn`, but that grant is intentionally local to one Agent turn and matches one tool name plus a consumer-supplied task key. A multi-agent TeamRun can have several expert sessions, different tools, parallel pending questions, and later turns, so presenting the existing result as whole-task authorization would leave the team blocked and overstate its permission scope

## Decision

The core `ApprovalOutcome` remains unchanged. The Web answer contract gains a collaboration-only `allowed-for-task` value, and `approval/requested` gains an optional `collaborationRunId` that the Host emits only after confirming current active TeamRun membership and a non-terminal execution status

The ApiProxy owns one process-local grant set keyed by the exact TeamRun id. When a scoped pending question receives `allowed-for-task`, the Host revalidates that request's membership, records the grant, and resolves every already-pending question for that run as `allowed-once`. A request dispatched after the grant also resolves as `allowed-once` before an answerable frame is published. The ApprovalService therefore still writes one complete `approval/asked` and `approval/decided` pair for every operation

The collaboration panel shows the new action only when the pending request's `collaborationRunId` equals the displayed run. The prior `allowed-for-turn` action remains available as the narrower current-Agent choice. A pending expert approval asks the layout owner to reveal a collapsed collaboration column, while a run without a pending approval leaves the user's panel state untouched. Everyday conversation UI and unscoped approval requests keep their previous behavior

The grant is deliberately memory-only. Restarting the Host asks again, terminal or stale members cannot establish a grant, and a mismatched or forged task-wide answer fails closed

## Verification

The Host tracer test creates two parallel expert approvals in one run, answers only one with the task-wide choice, proves both pending requests settle, proves a later request from a different expert and tool creates no new question, and proves an unrelated session still prompts and can be rejected

Client tests prove the TeamRun scope survives the mux projection, the exact task-wide answer reaches `/api/respond`, the button appears for the current run, and the button stays absent when the Host did not supply a collaboration scope. They also prove a pending expert approval reveals a collapsed column and that an active run without pending approval does not. Schema tests cover the new optional frame field and client-answerable value

## Alternatives considered

**Reuse `allowed-for-turn` unchanged.** This would authorize only matching operations in one Agent turn and cannot cover parallel or future experts

**Add `allowed-for-task` to core `ApprovalOutcome`.** This would force every approval consumer to understand TeamRun ownership even though only the Web collaboration gateway has that context

**Persist the grant in the TeamRun log.** This would survive restart but create a durable high-privilege permission and revocation contract that the Demo does not require. Process-local scope is safer and matches the existing temporary-approval posture

## Consequences

One explicit user action can unblock all current and future approvals in one running multi-agent task while preserving per-operation audit events. Daily conversation semantics, core tool consumers, session policy, model selection, sandbox mode, and historical TeamRun replay stay unchanged
