# Agent Note: Explicit parallel stage runtime

Status: implemented

English | [中文](2026-08-29-explicit-parallel-stage-runtime.zh.md)

## Problem

The Team Charter already labeled dependency layers as serial or parallel, but the runtime always passed one execution baton to one expert. The UI could therefore show a parallel stage while model turns still ran serially

## Decision

Serial stages preserve the existing one-message handoff and idle-before-delivery behavior. Only a committed Charter stage with mode `parallel` can use the new Lead-only `collaboration_parallel_followup` tool, and a single serial route is rejected while that stage has at least two ready tasks

The Lead atomically publishes one task message per distinct preassigned expert. The runtime starts every expert inbox concurrently, grants execution permits only to successful admissions, and blocks the Lead and nonparticipants until all admitted experts return the exact dispatched task. The last return closes one barrier and wakes the Lead once with all returned public summaries plus any initial admission failures

The public batch uses one stable parallel thread. Live router recovery reconstructs unfinished participants and completed returns from durable messages without modifying historical events

An admitted participant that later becomes a durable failed member is resolved as a failed batch result instead of retaining the barrier forever. The non-model runtime controller attempts one idempotent replacement in the same planned protocol slot before the join wakes the Lead. The Lead receives every successful return plus the failed-task evidence, then explicitly reassigns unfinished work to the active replacement rather than reporting the stage complete

## Verification

Tests prove true concurrent admission before either inbox settles, one final Lead wake-up, explicit serial-stage rejection, prevention of accidental one-at-a-time dispatch in a ready parallel stage, partial admission failure handling, admitted-participant failure release with runtime replacement, atomic public batch rollback, and unchanged serial routing behavior

## Alternatives considered

**Keep the parallel label as dependency metadata only.** This preserves the old router but gives users a parallel promise that the runtime does not execute

**Call the serial follow-up tool repeatedly.** The first call concludes the Lead turn and transfers the only baton, so later calls cannot start concurrently and there is no deterministic join barrier

**Run every ready task concurrently.** Readiness alone does not authorize parallel execution. A committed serial stage can encode ordering or review intent that must retain the existing one-recipient path

## Consequences

Explicit parallel stages now reduce wall-clock execution time when multiple assigned experts are ready, while serial stages and one-task remainders preserve the existing path. The adapter adds one schema, one durable batch thread, and a process-local barrier reconstructed from public messages. The Lead must handle reported inbox-admission failures before the remaining task can complete
