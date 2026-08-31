# Agent Note: Recover live collaboration runs without false dependency stalls

Status: implemented

English | [中文](2026-08-30-collaboration-run-recovery-and-stall-readiness.zh.md)

## Problem

The controller counted every old pending task as stalled, including tasks whose declared blockers had not completed. A valid later stage could therefore change the whole run to blocked while an earlier parallel stage was still executing

After a reload, the center collaboration workspace recovered only an unconfirmed planning draft, while the dock blindly selected the first catalog row. A live run could disappear from the center and a newer cancelled draft could occupy the dock, leaving the user with an apparently empty collaboration panel

Catalog boot hydrated every historical timeline as one all-or-nothing batch. With 85 persisted runs this created a request burst that disconnected the browser transport before the current run became visible. The dock also used the sessions service for approval projections without declaring that dependency, so a cold boot repeatedly threw during render

After a Host restart, a durable parallel return could outlive its process-local expert Agent. Router recovery treated the missing Agent as an invalid team member and rejected every subsequent Lead collaboration tool. An unfinished expert from the same batch could also remain recorded as active without a live turn to finish it

## Decision

Stall detection now considers only in-progress tasks and pending tasks whose declared blockers have completed. Dependency-blocked tasks remain pending without degrading controller health

The client now selects the newest non-terminal collaboration run by creation time when recovering the center workspace. The dock selects the newest non-cancelled run by the same ordering and both surfaces share a deterministic selection policy

Recovering a live run opens the dock once. The active workspace also exposes an explicit panel-open action so a user can restore the dock after manually collapsing it

The browser requests a newest-first recovery window of 20 TeamRuns. Cold discovery reads lightweight persistence headers in creation order and stops after that bounded window instead of replaying every stored session. Catalog refresh then hydrates timelines only for the newest visible run and newest active run, bounding boot fan-out to at most two histories. Once a run is selected, dock polling addresses that exact run instead of repeatedly rescanning the catalog. The runtime retains the last good projection when a relevant timeline is temporarily unavailable. The UI plugin now explicitly declares its sessions dependency, while approval lookup remains isolated per expert as a final containment boundary

Parallel router recovery now trusts a durable expert return without requiring that expert to remain live in memory. It preserves genuinely running participants, reconstructs the original private execution permit for each missing or idle unfinished participant from the durable launch message and task, and redispatches only those unfinished tasks once before joining the batch

## Alternatives considered

**Increase the stall threshold.** Rejected because it would delay the same false positive instead of respecting task readiness

**Persist the selected run only in component state.** Rejected because component state is lost on reload and cannot reconcile cancelled replacement drafts

**Keep reopening the dock on every catalog update.** Rejected because it would override an intentional user collapse and reintroduce visible panel instability

## Consequences

Parallel work can continue without later dependency stages falsely blocking the run. Reloading the application restores the latest live task and its panel, while completed historical runs remain available to the dock without unexpectedly replacing the new-task launcher in the center

Historical growth no longer makes recovery scan and hydrate every prior task. The current UI retains the newest 20 recoverable runs, while the durable store and unbounded Host API default remain intact. A missing or temporarily unavailable approval projection no longer crashes the dock

A process restart no longer turns a valid parallel return into a missing-member protocol failure. Completed contributions are not repeated, unfinished cold participants regain their exact assigned work, and the Lead resumes only after the recovered batch reaches a real join
