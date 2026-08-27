# Agent Note: Coordinator-led collaboration playground

Status: implemented

English | [中文](2026-08-17-collaboration-playground.zh.md)

## Problem

Harness exposes subagent and workflow orchestration inside a normal conversation, but a user who starts a collaborative task has no task-oriented surface that explains the team, separates discussion from deliverables, or keeps a direct path to the authoritative coordinator transcript. Adding a second orchestration runtime for the page would duplicate agent lifecycle, session durability, cancellation, and tool authority.

## Decision

`@deepseek-ai/dsh-client-ui-collaboration` contributes a root-scoped sidebar action, a dedicated modal, and a `shell.overlay` entry through the existing slot system. Its persisted browser store owns task cards and viewing state. Creating a task records the title, objective, and a coordinator kickoff message; starting real collaboration creates a normal Harness session, renames it, and sends one coordinator prompt requiring the assembled subagent or workflow capabilities to create task-specific agents. The coordinator derives the team size, names, expertise, responsibilities, and prompts from the task instead of applying a fixed role roster. Every agent first contributes independently, then receives the other positions and participates in at least two rounds of direct cross-agent responses. The coordinator manages information delivery, participation, and scope but does not preempt the debate; it performs acceptance only after the team finishes and returns deficient work for another discussion round.

The session log remains authoritative for model work. The task card stores only the session id and polls the existing client session snapshot. The coordinator's final assistant output uses two explicit headings, `## 任务结果` and `## 汇总报告`; the page derives its result and report tabs from those sections and offers a direct transition to the coordinator conversation.

The root overlay recognizes the active coordinator from its collaboration title prefix and opens that session's subagent catalog while mounted. It renders the durable child roster as a right-side avatar strip. The panel's left-edge drag handle changes a root-store width value persisted for later visits. Selecting an avatar reads every page of that child's `subagents.history` using the catalog entry's parent, child, and mode address. The projection excludes reasoning blocks, duplicate messages, execution chatter, and prose that conflicts with the task language; it keeps the latest assistant text as final work and at most eight deduplicated key exchanges. Selection changes and unmounts cancel obsolete reads; the transcript wait is bounded by `historyTimeoutMs`. Ordinary sessions render no collaboration overlay.

Task creation detects the dominant language of the title and objective. The modal, kickoff message, coordinator session title, coordinator prompt, every child prompt, cross-agent discussion, and final headings use that language. Legacy task cards derive the language from their saved task text, and existing sessions derive it from their first user message. Mismatched legacy child prose and labels are hidden or localized rather than mixed into the panel.

The browser store is intentionally not a second session log. Its kickoff messages orient the user before model work begins and are labelled as role activity, while real tool calls, child output, failures, and final prose stay in normal transcripts.

## Alternatives considered

**Build a new host collaboration service and durable event family.** Rejected because the current product need does not introduce a new execution semantic. Sessions, subagents, workflows, and coordinator output already own execution and durability; another service would duplicate lifecycle control and persistence.

**Render only a shortcut that injects a prompt into the current chat.** Rejected because it does not provide the requested task list, group-discussion orientation, or separate result and report views.

**Copy every child transcript into the browser task store.** Rejected because it creates a second, lossy authority and cannot preserve tool calls, cancellation, reconnect, or replay semantics. The right panel reads each selected child directly from durable history without activating that child.

## Consequences

The feature reuses the complete agent runtime and requires no wire or session-format change. Task cards survive browser reloads and remain lightweight, but clearing browser storage removes those cards without deleting their Harness sessions. The right panel is backed by durable child catalogs and histories, so it also works for existing collaboration sessions that retain a recognized collaboration title prefix. Removing that prefix hides the panel.
