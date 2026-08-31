# Agent Note: Recover vacant expert slots across live and cold collaboration runs

Status: implemented

English | [中文](2026-08-30-cold-team-integrity-recovery.zh.md)

## Problem

An active TeamRun could retain fewer active experts than its committed roster after one expert failed during a serial handoff or while waiting for approval. Parallel-batch recovery could release its own barrier, but a serial owner failure retained the baton and cold restoration could announce the Lead before expert child Agents were live. The UI then reported an incomplete team, and the recovery callback could either never run or throw while reading a not-yet-restored participant

## Decision

The collaboration router now starts one bounded same-slot replacement from durable TeamRun membership before rebuilding serial or parallel route state. This operation is keyed by run and protocol slot, so repeated events cannot create duplicate replacement attempts. The failed audit row remains immutable, unfinished tasks remain unfinished, and a successful replacement adds a new active attempt in the same protocol slot

If the failed expert owned the serial baton, the router returns that baton to the Lead. After replacement settles, the Lead receives an explicit instruction to refresh the run and reassign every unfinished task that still names the failed member. Parallel batches retain their existing joined-result notification and do not receive a duplicate recovery wake-up

Cold startup now retries reconciliation after every Agent arrival because durable TeamRun membership can become readable after the first `agent/created` callback. Missing child Agents defer route reconstruction instead of terminating the web process. Team-level slot recovery does not depend on route reconstruction and can therefore restore the committed active roster first

## Alternatives considered

**Hide the integrity warning when one expert failed.** Rejected because the team would still be incomplete and unfinished work could be misreported as successful

**Rewrite the failed member back to active.** Rejected because it destroys failure evidence and makes timeout and provider incidents unauditable

**Retry replacement without a slot key on every event.** Rejected because repeated Session events and cold-start callbacks could create unbounded duplicate experts

## Consequences

Active teams restore vacant committed slots across serial, parallel, live, and cold-start paths without erasing the original failure. The Lead must still reassign unfinished task ownership before execution continues. If replacement itself fails, the run remains visibly incomplete and cannot pass the multi-agent completion gate
