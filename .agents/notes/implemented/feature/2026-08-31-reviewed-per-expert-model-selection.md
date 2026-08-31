# Agent Note: Reviewed per-agent model selection

Status: implemented

English | [中文](2026-08-31-reviewed-per-expert-model-selection.zh.md)

## Problem

The Lead used its session default while every collaboration expert inherited the Lead route or a blueprint route. The planning UI could display expert routes but could not let a user assign different daily-session Providers and models to the Lead and each expert, and a display-only client preference would not have survived replacement drafts, cold replay, or the first child turn

## Decision

The collaboration review page loads `session.models` for its retained Lead, so Provider groups, model labels, descriptions, and reasoning-effort values come from the same Host catalog used by everyday chat. The Lead and each expert own independent selectors, and confirmation remains disabled while model changes are unapplied

Applying model changes creates a replacement immutable collaboration draft before cancelling the previous draft. The create request carries one Lead route and exact `slot-N` expert selections, while skill edits and free-form plan revisions carry forward routes already retained by the current plan

The Host resolves every submitted Provider, model, and optional reasoning effort through `ctx.llm.resolveCallConfig` before orchestration. The durable Task Profile retains the canonical Lead route, the Team Plan retains canonical per-slot expert routes, and the safe planning projection displays those retained values without exposing credentials or adapter configuration. Confirmation reinstalls the reviewed Lead route before formation, including after cold recovery

ExpertRuntime gives a reviewed selection precedence over blueprint and Lead routes. The exact selection is hashed into the immutable binding foundation, installed in the child scope before initial prompt admission, and reused during recovery and replacement, while the blueprint execution budget continues to own the Token ceiling

Plans and bindings created before this feature remain readable because the new selection fields are optional. Their previous inheritance behavior is unchanged

## Verification

Planner tests cover Lead and per-slot persistence plus invalid out-of-range slots. Runtime tests prove that a reviewed expert route overrides both blueprint and Lead settings from the first child turn. Host carrier tests cover both structured wire fields, client runtime tests cover reuse of the daily model directory and request forwarding, and GUI tests cover independent Lead and expert selection, unapplied-change blocking, and replacement-plan submission

Strict TypeScript project builds and focused collaboration tests cover schema replay, runtime binding, Host transport, client orchestration, and the React planning surface

## Alternatives considered

**Switch child sessions after formation.** This can update a later turn but allows the first expert prompt to run on the wrong route and leaves the reviewed plan unable to prove intended execution

**Store model choices only in React state.** This is simple visually but loses selections on refresh, replacement drafts, recovery, and retries, making the UI claim a configuration the runtime never committed

**Encode model choices in free-form adjustment text.** This reuses the existing revision box but makes Provider and model identifiers dependent on natural-language parsing and cannot share the exact daily-session validation contract

**Copy the Lead selection to every expert.** This preserves existing behavior but cannot satisfy independent model assignment and unnecessarily couples specialist cost and capability choices

## Consequences

Users can now choose a different Provider, model, and supported reasoning effort for the Lead and every planned expert before execution. The collaboration create wire contract and durable profile schema gain a Lead selection, while the durable plan schema, client runtime port, and expert provision request retain exact expert selections. Existing permissions, tools, skills, task execution, and legacy replay behavior stay unchanged
