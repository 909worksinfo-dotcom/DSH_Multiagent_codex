# Agent Note: Collaboration expert daily infrastructure

Status: implemented

English | [中文](2026-08-30-collaboration-expert-daily-infrastructure.zh.md)

## Problem

Collaboration experts were real continuable Agent sessions, but their role blueprints narrowed the standard preset to small tool allowlists, generic delegation fixed approval to `never`, and provisioning copied the Lead's creation-time model route instead of its current user selection. A roster could therefore claim that an expert was mounted while the expert lacked the daily Agent infrastructure available in an ordinary session

## Decision

Every shipped collaboration blueprint uses the `standard` preset with an empty deny list. The role, persona, skills, assignment, collaboration protocol, task budget, and quality gates still specialize behavior, but they no longer remove standard daily tools from the expert scope

Provisioning reads the Lead's live model-selection reference before resolving blueprint overrides. The immutable expert binding records the effective provider, model, optional reasoning effort, token ceiling, complete-or-restricted tool state, sandbox mode, and approval policy. Fresh and resumed expert scopes install the same model-selection owner used by the ordinary session model API, so later model inspection or selection mutates the actual request route instead of a display-only copy

Expert setup appends exact delegated sandbox and approval overrides before publication. An expert therefore follows the Lead's effective permission state at formation, and approval-requiring expert tools use the existing host approval flow. Generic non-collaboration subagents retain their existing fail-closed `never` default

The plan review and expert roster project only safe foundation metadata. They show model inheritance or the selected route, full or restricted tools, and the permission policy without exposing secrets, filesystem paths, prompts, persona text, or binding digests

Bindings created before this feature remain immutable. Their absent foundation field is accepted and shown as legacy data rather than being retroactively upgraded or misrepresented

## Verification

Runtime tests prove live Lead model inheritance, exact child model-selection installation, effective `ask` approval after generic delegation setup, full shipped blueprint tool access, cold safe projection, client deep cloning, model API adoption, and both plan-review and roster presentation

The collaboration, subagent, approval, host, runtime, and UI regression suites preserve expert recovery, role rules, marketplace mounts, task execution, and existing daily sessions

## Alternatives considered

**Keep role-specific tool allowlists.** This gives reviewers a smaller catalog, but it contradicts the requirement that every expert own the same daily infrastructure and makes future standard tools silently unavailable until every blueprint is updated

**Copy the Lead model only once into child options.** This preserves creation behavior, but it misses the model currently selected in the UI and leaves the expert disconnected from the ordinary session model API

**Change the default policy for every subagent to `ask`.** This broadens behavior outside collaboration and weakens the existing fail-closed generic delegation contract. The permission upgrade is therefore limited to immutable ExpertRuntime bindings

**Rewrite legacy bindings on read.** This would make old tasks look upgraded without proving how they actually ran and would violate immutable task snapshots

## Consequences

Collaboration experts now run on the same standard tool, model-selection, sandbox, and approval substrate as daily Agents while retaining task-specific roles and bounded collaboration rules. The binding schema and safe browser contract gain one optional foundation record, setup performs one additional scoped model installation, and shipped experts can see tools they are expected to use only when their assignment requires them

