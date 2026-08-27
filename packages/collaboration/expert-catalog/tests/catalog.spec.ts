import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import ExpertCatalog, { ExpertBlueprintId, type Config, type ExpertBlueprint } from '../src/index.ts'

const composition = `
- name: '@plugins/research'
- name: '@plugins/reviewer'
`

function blueprint(overrides: Partial<ExpertBlueprint> = {}): ExpertBlueprint {
  return {
    ref: { id: ExpertBlueprintId('research-analyst'), revision: 1 },
    role: 'Research analyst',
    objective: 'Find and synthesize verifiable evidence',
    preset: 'research',
    skills: ['literature-search'],
    plugins: ['@plugins/research'],
    tools: { allow: ['web_search'] },
    model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4_096 },
    persona: 'Work as an evidence-first research analyst',
    inputs: [{ name: 'question', description: 'Question to investigate', required: true }],
    outputs: [{ name: 'findings', description: 'Sourced findings', required: true }],
    acceptanceCriteria: ['Every material claim has a source'],
    collaboration: { challenge: true, review: true, requestHelp: true },
    budget: { maxTurns: 8, maxTokens: 16_000, timeoutMs: 120_000 },
    ...overrides,
  }
}

function skill(content = 'Search sources and retain precise citations'): SkillDefinition {
  return {
    name: 'literature-search',
    description: 'Find authoritative sources',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: '/skills/literature-search' },
    content,
    path: '/skills/literature-search/SKILL.md',
  }
}

async function setup(config: Config, options: {
  readonly source?: string
  readonly definition?: SkillDefinition | undefined
} = {}): Promise<{ ctx: Context; catalog: ExpertCatalog; getSkill: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  const source = options.source ?? composition
  const scope = { agentPreset: 'research' }
  ctx.provide('agentPresets', {
    resolve: vi.fn(async (id: string) => ({ id, trust: 'system', path: `/presets/${id}/agent.cordis.yml` })),
    read: vi.fn(async () => source),
    standingKeyFor: vi.fn(async () => scope),
  } as never)
  const getSkill = vi.fn(async () => options.definition === undefined && 'definition' in options
    ? undefined
    : options.definition ?? skill())
  ctx.provide('skills', { get: getSkill } as never)
  await ctx.plugin(ExpertCatalog, config)
  return { ctx, catalog: ctx.expertCatalog, getSkill }
}

describe('ExpertCatalog', () => {
  it('stores exact immutable revisions and returns detached values', async () => {
    const first = blueprint()
    const second = blueprint({ ref: { id: ExpertBlueprintId('research-analyst'), revision: 2 } })
    const { catalog } = await setup({ blueprints: [first, second] })

    expect(catalog.list()).toEqual([first.ref, second.ref])
    const detached = catalog.get(first.ref) as { role: string }
    detached.role = 'mutated outside the catalog'
    expect(catalog.get(first.ref).role).toBe('Research analyst')
  })

  it('fails load for malformed or duplicate immutable revisions', async () => {
    await expect(setup({ blueprints: [blueprint({ tools: {} })] })).rejects.toMatchObject({
      code: 'TEAM_INVALID_CONFIG',
    })
    await expect(setup({ blueprints: [blueprint(), blueprint()] })).rejects.toMatchObject({
      code: 'TEAM_INVALID_CONFIG',
    })
  })

  it('resolves exact preset, enabled plugins, and model-invocable skills into a stable digest', async () => {
    const configured = blueprint()
    const { catalog, getSkill } = await setup({ blueprints: [configured] })
    const first = await catalog.resolve(configured.ref, { cwd: '/workspace' })
    const second = await catalog.resolve(configured.ref, { cwd: '/workspace' })

    expect(first).toEqual(second)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.preset.id).toBe('research')
    expect(first.preset.contentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.skills).toEqual([expect.objectContaining({
      name: 'literature-search', provider: 'filesystem', source: 'bundled',
    })])
    expect(getSkill).toHaveBeenCalledWith('literature-search', expect.objectContaining({
      cwd: '/workspace', scope: { agentPreset: 'research' },
    }))
  })

  it('changes the binding digest when preset or skill content changes', async () => {
    const configured = blueprint()
    const left = await setup({ blueprints: [configured] })
    const right = await setup(
      { blueprints: [configured] },
      { source: `${composition}- name: '@plugins/extra'\n`, definition: skill('Changed instructions') },
    )
    expect((await left.catalog.resolve(configured.ref)).digest)
      .not.toBe((await right.catalog.resolve(configured.ref)).digest)
  })

  it.each([
    {
      label: 'missing plugin',
      configured: blueprint({ plugins: ['@plugins/missing'] }),
      options: {},
      message: 'enabled plugin "@plugins/missing" is unavailable',
    },
    {
      label: 'dynamically enabled plugin',
      configured: blueprint({ plugins: ['@plugins/research'] }),
      options: { source: '- name: \'@plugins/research\'\n  disabled: !!js \'() => false\'\n' },
      message: 'dynamic enablement',
    },
    {
      label: 'missing skill',
      configured: blueprint(),
      options: { definition: undefined },
      message: 'model-invocable skill "literature-search" is unavailable',
    },
    {
      label: 'non-model skill',
      configured: blueprint(),
      options: { definition: { ...skill(), invocation: { modelInvocable: false, userInvocable: true } } },
      message: 'model-invocable skill "literature-search" is unavailable',
    },
  ])('rejects a $label instead of weakening the binding', async ({ configured, options, message }) => {
    const { catalog } = await setup({ blueprints: [configured] }, options)
    let error: unknown
    try {
      await catalog.resolve(configured.ref)
    } catch (cause: unknown) {
      error = cause
    }
    expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
  })

  it('removes the service when its owning plugin is disposed', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {} as never)
    ctx.provide('skills', {} as never)
    const fiber = ctx.plugin(ExpertCatalog, { blueprints: [] })
    await fiber
    expect(ctx.get('expertCatalog')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('expertCatalog')).toBeUndefined()
  })
})
