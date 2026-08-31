# Agent Note: Charge expert timeout only while the child is executing

Status: implemented

English | [中文](2026-08-28-serial-expert-active-execution-timeout.zh.md)

## Problem

The expert runtime treated the absolute deadline created during provisioning as the lifetime of the roster member. In serialized collaboration, an expert can wait idle while the Lead and other experts hold the baton, then receive a later review or completion request. That normal wait consumed the whole timeout, so a contributor with an accepted artifact could be marked failed as soon as the next message woke it, reducing the active roster below the required team size

## Decision

The durable `deadlineAt` continues to bound initial prompt admission. Later work uses the exact `timeoutMs` re-resolved from the immutable blueprint and charges it to each whole-agent `running` interval. The `agent/status` transition to `running` opens one timer, the transition to `idle` clears it, and disposal or failed membership forgets the timer and cached budget. The pre-step check re-resolves the binding, restores a missing timer after runtime reload, and rejects an already expired active interval before model entry

A durable `approval/asked` event pauses the current active timer and retains its exact remaining duration. The matching final `approval/decided` event resumes that remainder after the last outstanding approval resolves. Human response latency therefore does not consume model execution time, while an expert that remains active after approval still receives only its original remaining budget

An expiry cancels and fails the child only when the child is still `running`. A timer callback that races an idle or terminal transition clears itself without changing TeamRun membership

## Alternatives considered

**Increase every blueprint timeout.** Rejected because serialized idle time remains coupled to execution time and sufficiently long tasks reproduce the failure at a larger threshold

**Ignore a failed expert after it has an accepted artifact.** Rejected because it hides a runtime failure and cannot safely authorize a later review turn. Accepted evidence and current execution availability remain separate facts

**Track one cumulative active-time ledger across all intervals.** Rejected for this demo because the product contract assigns one bounded message at a time and requires a fresh plan before the next activation. A durable aggregate token and time ledger remains a separate budget capability

## Consequences

Experts may remain idle or wait for a user approval for the full duration of a serialized task without losing membership, while a genuinely stuck active execution still fails closed at the configured timeout. Existing immutable task history is not rewritten. After a runtime reload, an already-running child receives its replacement timer at the next pre-step rather than reconstructing elapsed process-local time
