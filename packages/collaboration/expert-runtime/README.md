# @deepseek-ai/dsh-expert-runtime

English | [中文](README.zh.md)

ExpertBlueprint-bound continuable child Agent provisioning over stable TeamRun transitions. `ctx.expertRuntime` resolves an exact catalog revision, reserves a P1 roster attempt, persists matching Lead and child capability descriptors, creates the real child through a continuable subagent provider, activates P1 before initial prompt admission, and compensates every failed path without falling back to a single Agent.

## Config

```yaml
- id: expert-runtime
  name: '@deepseek-ai/dsh-expert-runtime'
  config:
    subagentProvider: spawn
    maxInitialPromptBytes: 65536
```

The selected provider must implement continuable creation. `maxInitialPromptBytes` bounds the complete UTF-8 prompt on fresh provisioning and recovery. The service requires Agent, Session, Session persistence, TeamRun, ExpertCatalog, and subagent services.

## Provisioning transaction

`provision()` resolves the requested immutable blueprint and validates its assignment before consuming an attempt. It computes the effective provider, model, and output-token ceiling, including Lead route inheritance, and hashes runtime-derived composition with the catalog digest. The sequence is P1 `beginExpertProvision()`, append and flush the Lead binding, create and publish the child with the exact preset/persona/tool policy, append the child descriptor during unpublished setup, P1 `succeedExpertProvision()`, then admit the first prompt.

Any provider, setup, activation-hook, or prompt-admission failure drains the child first and changes the immutable P1 attempt to `failed`. P1 compare-and-set settlement retries across unrelated concurrent TeamRun writes. Missing capability, descriptor drift, turn exhaustion, and deadline expiry remain structured public failures; they never silently weaken the team.

The integration suite also mounts the real Loader, Agent preset roster, ExpertCatalog, TeamRun, JSONL persistence, SubagentRuntime, `spawn` in-process provider, and AgentLoop. It verifies that the real child reaches the model with only its blueprint-selected preset tool, then reloads both P2 descriptors and the answer from persistence.

## Recovery and drift checks

Lead and child logs carry the complete catalog descriptor, effective model route, runtime composition digest, execution budget, and exact attempt identities. The independent subagent v3 descriptor must also match provider, label, model route, `maxTokens`, preset, persona, and tool filter. Current catalog, preset, plugin, and skill content is re-resolved before cold recovery and every model step.

Recovery distinguishes three states. A provisioning attempt with no child recreates it and admits the retained prompt once. A persisted descriptor without the matching initial `user/message` cold-resumes and admits that retained prompt once. A live child or persisted child that already logged the exact prompt is activated if necessary without replaying work. An active P1 row with no child fails closed.

Cold activation uses independent reference-counted authorization tokens. Generic `ctx.subagents.followup()` cannot cold-resume an expert outside this validation path. Public expert followup is accepted only while the TeamRun is `active`; completing and terminal runs reject new expert work.

## Execution budgets

The blueprint's effective `maxTokens` is passed into continuable creation and retained by the subagent v3 descriptor for cold resume. `maxTurns` counts only this child's own `turn/start` events after its expert descriptor, so inherited fork turns do not consume the budget. The absolute persisted deadline installs a timer on fresh creation, cold publication, and plugin reload; the pre-step hook also rechecks it immediately before model entry.

## Required-on-read invariant

The separate `./invariant` companion validates every candidate Lead binding against its already-committed P1 roster row and validates every child descriptor against the exact live parent binding before publication. Profiles that can read these events must mount both the TeamRun and expert-runtime companions.

## Model Experience

### Initial expert assignment

#### What the model sees

The child receives one user-role prompt containing its public name and role, responsibility, assignment objective and named inputs, required outputs, acceptance criteria, collaboration permissions, mounted skill names, and instructions to expose conclusions, evidence, uncertainty, challenges, and handoffs without exposing private reasoning. Dynamic user input is included verbatim after strict field and byte validation, while `collaboration/expert/binding` and `collaboration/expert/descriptor` remain log-only.

#### Token effect

The initial assignment consumes tokens proportional to blueprint and task text. Later followups append ordinary user-role content. Skill bodies are not copied into this prompt, and lifecycle descriptors remain log-only.

#### KV Cache effect

Each expert is a separate Agent with an independent request prefix and KV Cache lifecycle. A cold resume restores the same preset, model route, persona, tools, and token ceiling before appending new work; it does not share the Lead's KV Cache.

## Known Limitations and Deferred Work

- **No P3 automatic team design** — callers still choose blueprint revisions and exact expert identities; profiler, planner, charter, and topology selection are later phases
- **Per-request token ceiling** — `maxTokens` is enforced on every model request, but aggregate task-token accounting is not yet a durable ledger
- **Single-process transaction owner** — P1 CAS retries and child lifecycle coordination do not form a distributed transaction across harness processes
- **No automatic public peer transport** — TeamRun records public collaboration facts; higher phases decide when those facts should wake or message another expert
- **No silent fallback** — a missing provider, preset, skill, plugin, child, or matching revision is a visible failure and requires retry or replacement
