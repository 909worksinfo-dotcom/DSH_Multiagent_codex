# Agent Note: Stable collaboration domain foundation

Status: implemented

English | [中文](2026-08-26-stable-collaboration-domain.zh.md)

## Problem

The experimental Agent Teams service combines continuable-child execution with an opt-in roster, mailbox, and task board under `ctx.agentTeams`. Its historical-member capacity rule, code-specific write scopes, prompt-selected formation, and `team/*` records cannot enforce the natural multi-agent product requirements without making stable callers depend on an experimental package.

The product needs a stable durable authority before expert composition, automatic planning, Host transport, or browser projections can depend on collaboration state. That authority must represent formation failure and recovery without pretending that P1 already provisions skill-bound expert runtimes.

## Decision

[`@deepseek-ai/dsh-agent-team`](../../../../packages/collaboration/agent-team/README.md) owns stable TeamRun state on `ctx.teamRuns`. [`@deepseek-ai/dsh-tool-agent-team`](../../../../packages/collaboration/tool-agent-team/README.md) is a model-facing command adapter over that service and never stores a second copy of TeamRun state. Both packages remain independent from `agent-loop`.

The stable domain uses `collaboration/*` Session events and does not read or write the experimental service's `team/*` records. Both implementations can exist in one build during migration, but they do not share state, Context keys, or implicit compatibility behavior.

## Durable authority

The Lead Session event log is the only TeamRun authority. The fold selects records by TeamRun id, validates current payload versions, rejects invalid transitions and non-contiguous task revisions, and ignores records inherited from another root TeamRun. TeamRun status, provisioning attempts, member audit rows, tasks, and public messages reconstruct from that log.

Collaboration records are required-on-read Session facts because dropping them would change formation, task, or public-history reconstruction. A reader that does not know the stable event types refuses the log instead of silently resuming incomplete state.

## Formation and capacity

Every TeamRun records a complexity and exact planned expert count. Simple plans require one expert, medium plans accept two through four, and complex plans accept five through eight. The Lead is implicit and excluded from expert capacity.

Provisioning records begin, success, and failure as separate durable transitions. Active plus provisioning experts cannot exceed eight. Failed attempts retain their identity and error for audit, release their active slot, and still count toward the twelve-attempt budget. Names and attempt ids are immutable and cannot be reused.

A TeamRun becomes active only after its exact planned expert count succeeds. Formation that cannot reach that count becomes `formation_failed`; no command can activate or complete a Lead-only run. P2 owns the adapter that binds these transitions to real ExpertBlueprint and subagent lifecycles.

If an active expert fails during execution, the same failed transition revokes that expert's membership and releases its slot without erasing tasks, messages, or audit identity. The active TeamRun projects `blocked` until the Lead provisions a new immutable replacement and the exact planned count is restored, then projects `running` again. New or successful formation is closed after the Lead enters `completing`, but a late active-expert failure still commits so exact-team completion is blocked and the Lead must terminate the run as failed.

## Tasks and public messages

Tasks retain compare-and-set revisions and an acyclic dependency graph. Generic advisory `resourceScopes` report conflicting active ownership without claiming a filesystem lock, permission grant, or merge guarantee.

Public collaboration messages use typed intent, author and target identities, optional task and relationship references, JSON-compatible content, literal public visibility, and idempotent event identity. The stable domain rejects private-reasoning and chain-of-thought message kinds rather than relying on a browser filter.

## Relationship to the product proposal

This decision implements the domain foundation of the broader [natural multi-agent collaboration proposal](../../proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md). The [expert runtime](2026-08-26-expert-blueprint-runtime-binding.md) and [automatic formation](2026-08-26-automatic-team-formation.md) decisions consume this domain for immutable capability binding, profiling, team planning, Host RPC, and the authoritative browser projection. Bounded discussion control and Lead quality gates remain later stages.

The experimental Agent Teams implementation remains available only to its existing explicit example while migration proceeds. New stable code depends on `@deepseek-ai/dsh-agent-team`, never on an experimental package.

## Verification

Package tests replay normal, boundary, invalid, and recovery sequences for complexity bands, slot release, active-expert replacement, authority revocation, attempt exhaustion, formation failure, task CAS and DAG rules, resource conflicts, message visibility, idempotency, and TeamRun isolation. Repository type, lint, package, generated-document, and translation checks include both stable packages.

## Alternatives considered

**Rename the experimental packages without changing their state model.** Rejected because failed records would still consume capacity, formation would remain prompt-directed, and stable package names would conceal incompatible product semantics.

**Reuse `ctx.agentTeams` and `team/*` records.** Rejected because both generations could not coexist safely during migration and old readers could misinterpret new lifecycle facts as the historical opt-in team model.

**Provision real expert runtimes in the domain package.** Rejected because ExpertBlueprint revision, preset digest, skill and plugin resolution, and subagent descriptor binding belong to P2. The domain records validated transitions while the adapter owns the external lifecycle.

**Store collaboration state in Host or browser projections.** Rejected because projections cannot own durable replay, compare-and-set revisions, formation recovery, or cross-caller consistency.

## Consequences

P1 establishes a stable, replayable foundation that later stages can consume without importing experimental code or modifying `agent-loop`. Capacity, formation failure, tasks, and public-message privacy become runtime invariants instead of prompt conventions.

The repository temporarily carries experimental and stable team implementations. Composition must choose the intended service explicitly, and no caller may treat their events or Context keys as interchangeable. P1 deliberately stops before executing ExpertBlueprint-bound children or exposing browser-visible collaboration state.
