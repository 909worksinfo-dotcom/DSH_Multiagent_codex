# Agent Note: Collaboration panel reading hierarchy

Status: implemented

English | [中文](2026-08-29-collaboration-panel-reading-hierarchy.zh.md)

## Problem

The collaboration workspace shortened authoritative task descriptions to sixty characters and applied a single-line CSS ellipsis, so acceptance criteria could disappear from the main task ledger. The right dock repeated the raw task prompt above its tabs, while the protocol view used repeated topology labels, nested borders, and cramped fixed grids that obscured the runtime policy

## Decision

The main task ledger now normalizes whitespace without changing or truncating task descriptions and allows those descriptions to wrap naturally. The right dock keeps the product title and live status in its persistent header but does not render the run title or objective again

The protocol view preserves the authoritative runtime projection and all existing states while presenting it in three reading layers: enforced rules and live limits, member permissions and message budgets, then challenge routes. The layout uses the existing design tokens, one brand accent, responsive auto-fit grids, semantic warning and error colors, and fewer nested borders

## Alternatives considered

**Keep the sixty-character summary and expose the full value on hover.** Rejected because touch and keyboard users could still miss execution requirements and the task ledger must remain directly auditable

**Replace the protocol projection with a simplified static explanation.** Rejected because runtime limits, permissions, and violations are operational state rather than decorative help content

## Consequences

Long task details take additional vertical space but remain complete and auditable. Removing the repeated prompt gives the group chat more usable space without changing task selection or execution. Protocol behavior and data contracts remain unchanged; component tests cover the complete description, prompt-free dock, unique topology label, and the new semantic protocol groups
