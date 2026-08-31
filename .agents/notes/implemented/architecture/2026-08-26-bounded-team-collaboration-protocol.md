# Agent Note: Bounded team collaboration protocol

Status: implemented

English | [中文](2026-08-26-bounded-team-collaboration-protocol.zh.md)

## Problem

The P3 Team Charter records topology and communication limits, and exact ExpertBlueprint revisions record collaboration permissions, but P5 public-message admission did not enforce them. Experts could publish to any active participant, challenge relations were optional references rather than an ordered protocol, and a browser had to infer whether a target or another round was legal

The product also has persisted P3-P5 TeamRuns whose logs contain no protocol. A P6 enforcement boundary must survive JSON replay and cold Host recovery without reinterpreting those older runs, and every refusal must leave message, cursor, ledger, revision, and provider state unchanged

## Decision

[`@deepseek-ai/dsh-agent-team`](../../../../packages/collaboration/agent-team/README.md) owns one immutable collaboration protocol in the Lead Session log. A new required-on-read `collaboration/protocol` event stores topology, maximum challenge rounds, maximum public messages per expert, and one exact rule per planned slot. Each rule stores the slot identity, initial member identity, public name, `challenge`/`review`/`requestHelp` permissions copied from the committed blueprint revision, and allowed peer slot identities

[`@deepseek-ai/dsh-team-orchestrator`](../../../../packages/collaboration/team-orchestrator/README.md) materializes this record after profile, plan, and charter commit and before an expert can become active. The operation is compare-and-set serialized and idempotent for the same record. Recovery derives it again from the committed plan, charter, and exact catalog revisions; different topology, limits, permissions, slot identities, or routes fail closed with `TEAM_PROTOCOL_REQUIRED`

Initial and replacement provisioning attempts carry a `protocolSlotId`. A failed attempt retains that slot for audit, and a later immutable replacement may reuse the slot while receiving a new member, Session, and attempt identity. A member cannot claim another slot, and an enforced run cannot activate an unbound expert

## Admission and routing

Every expert-authored `collaboration/message`, including the public receipt produced by an expert artifact write, consumes the slot's public-message budget. Admission checks the budget, blueprint permission for `challenge`, `review`, or `request_help`, and resolved targets before any append or ledger mutation. Stable refusals use `TEAM_EXPERT_MESSAGE_BUDGET_EXHAUSTED`, `TEAM_PROTOCOL_PERMISSION_DENIED`, and `TEAM_PROTOCOL_TARGET_DENIED`

Topology routes are deterministic. `centralized` and `parallel` allow only Lead, `producer_reviewer` allows every other expert, `hybrid` allows adjacent planned slots, and `grouped` allows the other member of each two-slot group. Lead is always an allowed coordination target and is not charged against an expert budget. Lead can coordinate across the roster, but raw `decision`, `artifact`, and `final_delivery` messages cannot bypass their authoritative ledger or completion operations

An expert artifact write preflights its generated public receipt before the artifact batch. The receipt explicitly targets Lead, so centralized and parallel teams can contribute artifacts. A rejected write appends neither artifact nor message and advances no version, revision, or cursor

## Challenge protocol

A `challenge` and its `response` use one explicit dispute thread, one challenge id, and one explicit target. A challenge cannot target its author or reuse an id. The same thread cannot open another challenge until its prior round is answered, and its round count cannot exceed the persisted Charter limit. A response must use the same thread and id, be authored by the original target, and target the original challenger. Orphan, parallel, duplicate, wrong-party, and excess-round records fail before append with `TEAM_CHALLENGE_INVALID` or `TEAM_CHALLENGE_ROUND_LIMIT`

The replay fold reconstructs each linked round, challenger, target, challenge message, response message, sequence number, and deterministic `open` or `responded` status. An enforced run with any open challenge cannot complete; `completeRun()` returns `DELIVERY_FAILED` before its three-event completion batch

## Projection and compatibility

TeamRun exposes an authoritative discriminated protocol projection. `enforced` mode contains topology, positive limits, one through eight member rows, and challenge rows. Each member row carries the current bound member, phase, permissions, allowed public names, used messages, and remaining messages. [`packages/host/apiproxy`](../../../../packages/host/apiproxy/README.md) maps the same allowlisted shape and rejects impossible mixed states such as legacy mode with limits or enforced mode without members

A log without `collaboration/protocol` projects exact `legacy` mode with null topology and limits plus empty members and challenges. Its P3-P5 public sending and completion behavior remains unchanged after cold recovery. P6 does not silently append a protocol, infer one from current configuration, or migrate the historical audit in place

[`@deepseek-ai/dsh-tool-agent-team`](../../../../packages/collaboration/tool-agent-team/README.md) returns the projection to Lead and experts and instructs them to obey usage and routes. The general send tool excludes ledger-owned decision, artifact, and final-delivery kinds. Challenge and response calls require an explicit dispute thread, one target, and a challenge id; only ordinary messages may default to `main`

## Wakeup boundary

P6 does not automatically call an Agent or subagent wakeup after a public message. The available continuation call has no durable route receipt, causal delivery identity, compare-and-set ownership, or replay-safe idempotency link to the committed message. Calling it after append would create a non-reconstructible side effect, while calling it before append could wake a participant for a message that never committed

The shipped boundary therefore persists admission and exposes authoritative allowed routes without implicit recursion. A later delivery worker may add wakeup only with its own durable outbox, delivery attempt identity, bounded retry policy, cancellation behavior, and replay projection

## Verification

TDD coverage starts from a missing protocol-operation probe, then exercises exact materialization, idempotent retry, protocol drift, topology and permission refusal, expert budget exhaustion, centralized artifact routing, ledger-kind bypass refusal, ordered challenge and response rounds, open-challenge completion refusal, JSON replay, legacy cold recovery, strict Host schema states, model-tool output, and complex eight-expert grouped routes derived from distinct blueprint permissions

Every refusal test compares the complete TeamRun snapshot and physical Session event count before and after the call. Artifact-budget coverage also compares artifact version and ledger contents. Package type checks, lint, collaboration tests, Host tests, export JSDoc, persistence catalog generation, and bilingual documentation gates cover the composed boundary

## Alternatives considered

**Keep collaboration rules in the prompt only.** Rejected because a prompt cannot enforce budget, target, participant, ledger ownership, or completion invariants for every caller and replay path

**Let the browser infer routes and challenge state.** Rejected because authorization derived from UI roster order would create a second, stale policy engine and could disagree after replacement or reconnect

**Automatically wake the allowed target after append.** Deferred because the current side effect has no durable outbox or replay-safe delivery identity. A best-effort call would make the event log cease to describe what actually executed

**Retrofit old runs with current Charter or catalog values.** Rejected because historical logs may predate those exact inputs, and silently changing their admission behavior would break cold recovery and audit meaning

**Charge Lead against the expert message budget.** Rejected because the budget bounds per-expert contribution, while Lead owns coordination, arbitration, and delivery. Lead remains constrained by the run-wide public-message limit and authoritative ledger commands

## Consequences

New teams now have enforceable, inspectable rules rather than advisory topology. Experts can challenge, review, request help, share artifacts, and answer disputes only within their persisted capability, route, and budget, while Lead retains bounded coordination and cannot bypass ledger ownership

The protocol is immutable for one run, routing is deterministic rather than adaptive, and enforcement is single-process around the existing per-Lead Session journal queue. Older runs remain visible but do not gain P6 enforcement. Automatic peer wakeup remains deliberately absent until a durable delivery mechanism owns that side effect
