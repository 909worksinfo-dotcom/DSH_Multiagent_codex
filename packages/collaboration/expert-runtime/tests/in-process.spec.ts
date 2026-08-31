import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import TeamRunService, {
  ProvisionAttemptId,
  TeamMemberId,
} from '@deepseek-ai/dsh-agent-team'
import ExpertCatalog, { ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ExpertRuntime from '../src/index.ts'
import ApprovalService, { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const contexts: Context[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('ExpertRuntime with the real in-process continuation stack', () => {
  it('mounts the exact expert preset and executes the accepted prompt on a real child Agent', { timeout: 20_000 }, async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await mountAgentLoopTestDependencies(ctx)
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-expert-runtime-'))
    temporaryRoots.push(persistenceRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    await ctx.plugin(ApprovalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentPresets, {
      default: 'research',
      roots: [{ path: join(FIXTURES, 'presets'), trust: 'system' }],
      includeUserRoot: false,
    })
    await ctx.plugin(TeamRunService)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(ExpertCatalog, {
      blueprints: [{
        ref: { id: ExpertBlueprintId('researcher'), revision: 1 },
        role: 'Research analyst',
        objective: 'Produce one concise, verifiable finding',
        preset: 'research',
        skills: [],
        plugins: ['../../plugins/expert-tool.js'],
        tools: { deny: [] },
        model: { provider: 'mock', model: 'mock', maxTokens: 512 },
        persona: 'Use the mounted research capability and report only public conclusions',
        inputs: [{ name: 'question', description: 'Question to investigate', required: true }],
        outputs: [{ name: 'finding', description: 'Verified finding', required: true }],
        acceptanceCriteria: ['Return one direct finding'],
        collaboration: { challenge: true, review: true, requestHelp: true },
        budget: { maxTurns: 1, maxTokens: 256, timeoutMs: 30_000 },
      }],
    })
    await ctx.plugin(ExpertRuntime, { subagentProvider: 'spawn', maxInitialPromptBytes: 64_000 })

    const adapter = new MockAdapter([textResponse('verified expert result')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const lead = ctx.agentLoop.create(SessionId('p2-real-lead'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/pre-step', async ({ agent }, next) => agent === lead
      ? { kind: 'reject' as const }
      : next())

    let run = await ctx.teamRuns.createRun(lead, {
      objective: 'Verify the real P2 child pipeline',
      complexity: 'simple',
      plannedExperts: 1,
    })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'planning' })
    run = await ctx.teamRuns.changePhase(lead, { expectedRevision: run.revision, phase: 'provisioning' })
    const provisioned = await ctx.expertRuntime.provision(lead, {
      expectedRevision: run.revision,
      memberId: TeamMemberId('p2-real-member'),
      sessionId: SessionId('p2-real-child'),
      attemptId: ProvisionAttemptId('p2-real-attempt'),
      name: 'researcher-one',
      blueprint: { id: ExpertBlueprintId('researcher'), revision: 1 },
      assignment: {
        objective: 'Answer the supplied question',
        inputs: { question: 'Did the real expert child run?' },
      },
      signal: new AbortController().signal,
    })

    expect(provisioned.member.phase).toBe('active')
    expect(provisioned.binding.descriptor.preset.id).toBe('research')
    expect(provisioned.binding.agentOptions.maxTokens).toBe(256)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) }, { timeout: 10_000 })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['expert_only'])
    expect(adapter.requests[0]?.system).toContain('section for expert_only')

    await vi.waitFor(() => { expect(ctx.agents.get(provisioned.member.sessionId)).toBeUndefined() }, { timeout: 10_000 })
    const child = await ctx.sessionPersistence.load(provisioned.member.sessionId)
    expect(child.meta.agentPreset).toBe('research')
    expect(effectiveApprovalPolicy(child.events)).toBe('ask')
    expect(child.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(child.events.some(event => event.type === 'collaboration/expert/descriptor')).toBe(true)
    expect(child.events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'verified expert result'))).toBe(true)
  })
})
