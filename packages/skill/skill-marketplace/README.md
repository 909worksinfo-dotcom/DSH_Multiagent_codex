# @deepseek-ai/dsh-skill-marketplace

English | [中文](README.zh.md)

Bounded remote discovery for the first Demo marketplaces: Smithery, Composio, and skills.sh

The service searches all providers independently, filters Smithery to verified deployed remote servers, filters skills.sh to deployment-owned trusted repositories, and reports authorization or outage states without turning an unavailable market into a failed TeamRun. Composio results remain authorization-required until an end user connects the corresponding application

Market results are planning inputs, not ambient permissions. TeamOrchestrator prepares only the capabilities selected for one task and persists their safe execution metadata. ExpertRuntime mounts loaded methods and connected remote tools only inside the assigned child scope

## Config

```yaml
- id: skill-marketplace
  name: '@deepseek-ai/dsh-skill-marketplace'
  config:
    timeoutMs: 7000
    maxResultsPerProvider: 4
    smitheryEndpoint: https://registry.smithery.ai/
    smitheryApiKey: !!js process.env.SMITHERY_API_KEY
    smitheryConnectEndpoint: https://api.smithery.ai/
    smitheryNamespace: deployment-namespace
    skillsShEndpoint: https://skills.sh/
    composioEndpoint: https://backend.composio.dev/api/v3/
    composioApiKey: !!js process.env.COMPOSIO_API_KEY
    trustedSkillsShSources:
      - anthropics/skills
      - vercel-labs/agent-skills
```

`timeoutMs` applies independently to every provider and `maxResultsPerProvider` bounds each response before team-level ranking. `trustedSkillsShSources` is an exact repository allowlist. Provider credentials remain deployment secrets and are sent only to their configured provider endpoints; task events retain connection IDs and tool names but never credentials

## Discovery semantics

`search()` runs all three providers concurrently and returns one state per provider. TeamOrchestrator sends a bounded ASCII query made from the expert role, capability terms, and task entity terms instead of forwarding a long multilingual prompt. When any verified candidate matches a recognizable task entity, team-level selection keeps entity matches and discards candidates that overlap only with generic role terms. After ranking, `prepare()` runs only for the selected mounts. Public Smithery servers become `connected` only after deterministic Connect provisioning and a successful MCP `tools/list`; servers requiring account input remain authorization-required. Composio application tools remain user-authorization-required. skills.sh entries must pass both the trusted-repository allowlist and a skill-name relevance check before becoming `loaded` method-skill cards containing bounded deployment-owned guidance, not downloaded repository contents

Provider HTTP, parsing, timeout, and trust failures are isolated as `unavailable`. A blank query is a caller error. Results are detached values; discovery does not register global tools, change filesystem state, or grant credentials

## Model Experience

### Task-bound method discovery

#### What the model sees

The expert's initial assignment lists selected loaded method-skill names and discovered remote capability names with their readiness states. ExpertRuntime registers persisted `loaded` methods and one deterministic child-scoped tool per allowlisted remote tool. Every call returns through `SkillMarketplace.execute()` with the child execution signal. Pending remote tools never become executable model tools

#### Token effect

Selected names add a small bounded section to the initial assignment. Method guidance consumes prompt tokens only when the expert loads that skill through the existing skill capability

#### KV Cache effect

Each expert receives its own selected catalog entries. Different selections produce different child request prefixes and therefore do not share an identical KV Cache prefix

## Known Limitations and Deferred Work

- **Smithery public execution only** — selected public Smithery servers support task-bound MCP execution; servers requiring account authorization stay pending
- **Composio execution deferred** — discovery uses the deployment API key, but account tools stay pending until a task-scoped end-user authorization and execution connector exists
- **Method cards, not repository installation** — skills.sh results contribute a safe method summary; the service does not download or execute third-party repository code
- **Static trust policy** — trusted skills.sh repositories are deployment configuration rather than a user-managed approval screen
