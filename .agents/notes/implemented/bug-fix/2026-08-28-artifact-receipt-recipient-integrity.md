# Agent Note: Artifact receipt recipient integrity

Status: implemented

English | [中文](2026-08-28-artifact-receipt-recipient-integrity.zh.md)

## Problem

Artifact writes append a compact public receipt beside the durable artifact version. The receipt target was always Lead, which was correct when an expert submitted work but produced a Lead-to-Lead public record when Lead accepted or revised that artifact. Ordinary collaboration messages and sequential routes already rejected self-targeting, but generated ledger receipts used a separate admission path. The group-chat projection faithfully rendered the invalid durable target, including for immutable historical runs

## Decision

Artifact receipt targets now follow the operation's counterparty. An expert write targets Lead. A Lead update of an expert-authored artifact targets the immutable artifact author. A Lead write of a Lead-owned artifact has no conversational target. Artifact ownership remains unchanged across versions, and the receipt author remains the exact caller that performed the update

The shared ledger-message builder rejects any generated target whose stable actor identity equals the author before an event is appended. This extends the self-target invariant beyond model-authored messages and serial routes to authoritative artifact, decision, review, and controller receipts that use the builder

The collaboration UI filters author-equal-target labels at projection time. This compatibility rule does not rewrite durable history, so older runs remain replayable and auditable while no longer presenting an impossible self-conversation

## Verification

The domain regression test exercises one state trajectory: expert submission targets Lead, Lead acceptance preserves the expert artifact author and targets that expert, and a new Lead-owned artifact has no target. It also asserts that no resulting public message targets its author. The component regression test renders a legacy self-targeted artifact receipt and proves that its localized receipt remains visible while the recipient label is absent. The affected domain, adapter, and collaboration UI suites cover adjacent permissions, protocol budgets, immutable receipt content, and public projection

## Alternatives considered

**Hide every artifact receipt target only in the UI.** Rejected because new durable events would remain semantically invalid and other consumers would still observe Lead-to-Lead relations

**Give every Lead artifact update no target.** Rejected because acceptance of expert work has a real counterparty and the expert should remain visible as the recipient of that public acknowledgement

**Rewrite old TeamRun events.** Rejected because the event journal is an immutable audit source. Projection compatibility fixes presentation without changing historical evidence

**Apply the ordinary message validator to ledger receipts.** Rejected because that validator intentionally denies authoritative artifact, decision, and final-delivery kinds outside their ledger operations. A focused identity invariant in the ledger builder preserves ownership boundaries

## Consequences

New artifact receipts have coherent directionality, generated ledger records cannot introduce a self-recipient, and historical invalid labels disappear from the group chat without migration. Consumers that inspect raw historical events can still observe the prior malformed target because durable audit records remain unchanged
