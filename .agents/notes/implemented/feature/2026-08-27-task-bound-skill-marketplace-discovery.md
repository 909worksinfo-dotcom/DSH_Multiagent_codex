# Agent Note: Task-bound skill marketplace discovery

Status: implemented

English | [中文](2026-08-27-task-bound-skill-marketplace-discovery.zh.md)

## Problem

Automatic team formation selects exact local ExpertBlueprint revisions, but a task may benefit from specialized methods or connected applications that are not part of every static blueprint. Treating a market search as an ambient permission would make accepted teams non-reproducible, expose untrusted instructions, and imply remote execution before a user has authorized it

## Decision

[`@deepseek-ai/dsh-skill-marketplace`](../../../../packages/skill/skill-marketplace/README.md) owns bounded discovery across Smithery, Composio, and skills.sh. Each provider runs independently with its own timeout and returns an explicit ready, authorization-required, or unavailable observation. Smithery accepts only verified, deployed, active remote servers; skills.sh accepts only exact deployment-configured repository sources; Composio requires a deployment API key and still reports end-user application authorization as pending

TeamOrchestrator builds a deterministic provider query from each selected blueprint's role, capability terms, and bounded ASCII task entity terms. It does not forward the complete multilingual user prompt because provider relevance degrades sharply for long mixed-language queries. When at least one verified candidate directly matches a recognizable task entity, selection drops candidates that match only generic role terms before ranking by readiness and popularity. It then removes duplicate names, prepares only the bounded selected mounts, and persists the resulting immutable capability snapshot. Retries and replacement therefore reuse the accepted names, readiness, connection ID, and allowlisted tool names rather than querying a changed marketplace

SkillMarketplace prepares a Smithery mount only when TeamOrchestrator has selected it for one expert. Public servers become connected only after the configured platform connection is ready and MCP `tools/list` returns at least one tool. `execute()` accepts only a tool name retained in that immutable connection snapshot. Composio deployment credentials enable discovery but never imply end-user application authorization, so those candidates remain user-authorization-required

ExpertRuntime copies the selected capabilities into the Lead binding and child descriptor. It registers persisted `loaded` method skills and deterministic wrappers for persisted `connected` remote tools in that exact child scope. Wrappers forward the child execution cancellation signal through SkillMarketplace and reject every tool name outside the persisted allowlist. It fails closed if a required registry or runtime is missing

The Host projection exposes only provider scan state plus capability identity, display name, source, kind, readiness, and public/platform/user access class. It deliberately omits connection IDs, tool names, provider errors, and credentials. The collaboration panel distinguishes public ready capabilities, missing platform credentials, and end-user authorization without exposing private model reasoning

## Trust and failure boundaries

Market outages do not invalidate a team whose required local blueprint capabilities remain available. Provider failure produces an explicit unavailable observation and an empty contribution from that provider. Required blueprint skills and plugins keep their existing fail-closed behavior

skills.sh discovery requires both an exact trusted source and meaningful overlap between the returned skill name and the bounded query. It creates a deployment-authored bounded method card and does not fetch or execute repository files. Smithery and Composio results do not register tools while authorization is pending. Provider credentials remain runtime configuration and never enter persisted task events or browser projections. Discovery performs no filesystem writes and grants no user credentials

## Verification

Provider tests pin verified, trusted-source, and name-relevance filtering, public Smithery preparation, MCP tool allowlisting and invocation, missing Composio authorization, and partial outage behavior. Orchestrator tests pin multilingual query compaction, task-entity preference, preparation after bounded selection, plan persistence, and exact provisioning inputs. ExpertRuntime tests prove child-scope method and remote-tool registration. Host compatibility tests cover legacy plans without discovery rows. Client-runtime and collaboration UI tests pin safe transport and localized access presentation. A live provider smoke test additionally proved Hugging Face Smithery discovery, four-tool connection, and `hub_repo_search` execution while Composio remained authorization-required

## Alternatives considered

**Install every search result locally.** Rejected because marketplace popularity is not a trust decision and third-party repositories may contain executable hooks or conflicting instructions

**Expose pending remote results as executable tools.** Rejected because discovery cannot prove end-user OAuth, credential scope, MCP session ownership, or revocation behavior

**Query marketplaces again during every expert activation.** Rejected because retries could receive a different capability set from the accepted plan and cold recovery would become dependent on current network state

**Fail team formation when one marketplace is unavailable.** Rejected because these candidates augment exact local blueprint capabilities; one external catalog outage must not silently remove required local capabilities or prevent otherwise valid staffing

## Consequences

Experts visibly receive bounded task-relevant skill names, and loaded methods are reproducible across retry and recovery without installing third-party repositories. The plan and runtime binding become larger, and automatic planning adds bounded network latency

Public Smithery capabilities now provide task-bound invocation without broadening child permissions. Composio and account-bearing Smithery servers still need a later user-authorization connector with credential references, revocation, and audit before they can reach `connected`
