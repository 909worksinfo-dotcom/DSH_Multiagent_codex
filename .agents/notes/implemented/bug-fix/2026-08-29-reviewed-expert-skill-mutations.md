# Agent Note: Reviewed expert skill mutations

Status: implemented

English | [中文](2026-08-29-reviewed-expert-skill-mutations.zh.md)

## Problem

Free-form collaboration revisions previously enforced only a numeric per-expert skill floor. Requests that named one expert and replaced, added, or removed concrete skills remained prompt text while the review projection and provisioned child continued using the immutable blueprint defaults

## Decision

The Task Profile now retains ordered named-expert local-skill mutations. Planning resolves each target against the exact selected roster, applies replacement, addition, or removal deterministically, and stores the resulting local skill set on that planned slot

Visible local skill ids and the built-in Chinese or English aliases are accepted. Every changed set is resolved through the selected preset before a reviewable plan is published. Unknown expert targets, unavailable skills, ambiguous targets, empty skill sets, and the product minimum skill-floor violation fail closed instead of producing an unchanged confirmation screen

ExpertCatalog accepts a call-scoped skill set without mutating the configured blueprint. ExpertRuntime binds that reviewed set, persists its content digests in the expert descriptor, includes it in the initial expert prompt, and re-resolves the same persisted names during recovery and drift validation

## Verification

Regression tests cover one named replacement, ordered add and remove mutations, natural-language aliases, an unavailable requested skill with no plan event, propagation into provisioning, call-scoped catalog resolution, and the runtime prompt and descriptor

The shipped Web composition test uses the production preset to replace the technical expert skill set with three available capabilities and verifies the exact durable plan before confirmation

## Alternatives considered

**Rewrite the deployment blueprint** Rejected because one task revision must not mutate later tasks or the deployment-owned catalog

**Display requested skills without binding them** Rejected because the confirmation screen is an execution contract

**Accept arbitrary names and defer failure until formation** Rejected because the user must see a valid executable team before confirmation

## Consequences

Review-time skill edits now change both the visible expert configuration and the actual child binding. Existing tasks and immutable historical plans remain unchanged, while newly regenerated plans carry their exact per-expert skill sets through confirmation, provisioning, recovery, and public projection
