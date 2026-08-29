# Agent Note: Collaboration identity colors and structured routes

Status: implemented

English | [中文](2026-08-28-collaboration-identity-colors-and-structured-routes.zh.md)

## Problem

The public collaboration timeline mixed author identity with message category: one Agent could change color between task, artifact, review, and handoff records, while a heavy left border competed with the content. Routed messages were stored as flat prose with a presentation-only sequential-handoff prefix, so readers had to parse context, next action, recipient choice, and the actual message from one visually uniform block. Removing the prefix only in new messages would also leave immutable historical events inconsistent in the UI and fragile during recovery

## Decision

The collaboration UI derives one deterministic tone from participant identity. Lead has a stable neutral tone, rostered experts use their stable roster position, and unknown participants use a deterministic hash fallback. Avatar, author accent, and message surface share that tone across every message kind. Message kind remains a textual badge. Avatars, message surfaces, and message-kind badges have no borders or outline shadows, and adjacent message rows use spacing rather than separator lines

The public-content projector sanitizes both Chinese and English legacy sequential-handoff markers and parses routed prose into semantic body, context-summary, next-step, recipient-selection, and message sections. Each section has its own label and typographic treatment, while ordinary non-routed messages remain a single body section. Sanitization affects presentation only and does not mutate durable history

New sequential routes contain the structured public fields without a presentation-only prefix. The router advances after the current sender is idle, rereads authoritative context, plans one next action, and selects exactly one eligible recipient. Recovery detects the structured field prefix and still recognizes the older stored form, so a UI wording decision is no longer the primary recovery key

## Verification

Presentation tests pin marker removal and section extraction for legacy and current content. Component tests pin stable participant tones across message kinds, distinct tones between participants, structured section rendering, and the absence of the legacy marker. Tool adapter tests pin marker-free persisted and follow-up route content. Type checking, focused linting, the production build, and the full GUI suite cover package integration. A browser audit of a persisted collaboration confirms zero visible legacy markers, zero borders on avatars, message surfaces, and message-kind badges, structured routed messages, and stable distinct tones for Lead and three experts

## Alternatives considered

**Color messages by event kind.** Rejected because the same Agent changes color across task, artifact, challenge, and review events, which weakens rapid author recognition and makes color carry two meanings

**Change only CSS.** Rejected because typography cannot reliably distinguish fields that remain one undifferentiated prose node, and newly generated content would continue to expose the presentation marker

**Rewrite historical events.** Rejected because TeamRun events are immutable audit records. Projection-time compatibility removes obsolete presentation text without changing persisted evidence

**Use the marker as the recovery discriminator.** Rejected because presentation wording is not a durable protocol contract. Structured field recognition preserves current recovery while the legacy recognizer keeps older runs resumable

## Consequences

Readers can track one Agent by color and scan routed content by meaning without confusing author identity with message type. The borderless treatment reduces visual noise and relies on color fill, typography, and spacing for hierarchy. New records no longer expose an implementation-oriented handoff label, and old records render consistently without migration. The UI and router retain a small compatibility parser for legacy content, and roster order remains part of the deterministic expert-color assignment
