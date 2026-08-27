import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillMarketplace, { type Config } from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }
})

function config(overrides: Partial<Config> = {}): Config {
  return {
    timeoutMs: 2_000,
    maxResultsPerProvider: 2,
    smitheryEndpoint: 'https://smithery.example/',
    skillsShEndpoint: 'https://skills.example/',
    composioEndpoint: 'https://composio.example/',
    trustedSkillsShSources: ['trusted/skills'],
    ...overrides,
  }
}

async function service(options: Partial<Config> = {}): Promise<SkillMarketplace> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SkillMarketplace, config(options))
  return ctx.skillMarketplace
}

describe('SkillMarketplace', () => {
  it('keeps only verified remote Smithery entries and trusted skills.sh methods', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://smithery.example/servers')) {
        return Response.json({ servers: [
          { qualifiedName: 'trusted-search', displayName: 'Trusted Search', description: 'Search evidence', verified: true, remote: true, isDeployed: true, inactive: false, useCount: 9 },
          { qualifiedName: 'unverified', displayName: 'Unverified', description: 'Ignore', verified: false, remote: true, isDeployed: true, inactive: false, useCount: 99 },
        ] })
      }
      if (url.startsWith('https://skills.example/api/search')) {
        return Response.json({ skills: [
          { id: 'trusted/skills/research', skillId: 'research', name: 'research', source: 'trusted/skills', installs: 100 },
          { id: 'unknown/skills/research', skillId: 'research', name: 'research', source: 'unknown/skills', installs: 1_000 },
        ] })
      }
      throw new Error(`unexpected URL ${url}`)
    })
    const marketplace = await service()

    const result = await marketplace.search('evidence research')

    expect(result.providers).toEqual([
      {
        source: 'smithery',
        state: 'authorization_required',
        capabilities: [{
          id: 'smithery:trusted-search',
          name: 'Trusted Search',
          description: 'Search evidence',
          source: 'smithery',
          kind: 'remote_tool',
          access: 'platform',
          status: 'authorization_required',
          verified: true,
          popularity: 9,
        }],
      },
      {
        source: 'composio',
        state: 'authorization_required',
        capabilities: [],
        message: 'Composio API key is not configured',
      },
      {
        source: 'skills_sh',
        state: 'ready',
        capabilities: [expect.objectContaining({
          id: 'skills.sh:trusted/skills/research',
          name: 'research',
          source: 'skills_sh',
          kind: 'method_skill',
          status: 'loaded',
          skillName: 'market-trusted-skills-research',
          verified: true,
          popularity: 100,
        })],
      },
    ])
  })

  it('reports one provider outage without discarding independent results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://smithery.example/')) throw new Error('smithery offline')
      if (url.startsWith('https://skills.example/')) return Response.json({ skills: [] })
      throw new Error(`unexpected URL ${url}`)
    })
    const marketplace = await service()

    const result = await marketplace.search('product strategy')

    expect(result.providers.map(value => [value.source, value.state])).toEqual([
      ['smithery', 'unavailable'],
      ['composio', 'authorization_required'],
      ['skills_sh', 'unavailable'],
    ])
    expect(result.providers[0]?.message).toBe('smithery offline')
  })

  it('rejects trusted but query-irrelevant skills.sh results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://smithery.example/')) return Response.json({ servers: [] })
      if (url.startsWith('https://skills.example/')) {
        return Response.json({ skills: [
          { id: 'vendor/skills/nv-reason-cxr', skillId: 'nv-reason-cxr', name: 'nv-reason-cxr', source: 'vendor/skills', installs: 2_000 },
          { id: 'vendor/skills/huggingface-papers', skillId: 'huggingface-papers', name: 'huggingface-papers', source: 'vendor/skills', installs: 1_000 },
        ] })
      }
      throw new Error(`unexpected URL ${url}`)
    })
    const marketplace = await service({ trustedSkillsShSources: ['vendor/skills'] })

    const result = await marketplace.search('Technical Analyst Hugging Face research')

    expect(result.providers.find(value => value.source === 'skills_sh')?.capabilities.map(value => value.name)).toEqual([
      'huggingface-papers',
    ])
  })

  it('prepares a public Smithery connection before exposing an executable capability', async () => {
    const trace: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://smithery.example/servers?')) {
        return Response.json({ servers: [{
          qualifiedName: 'huggingface', displayName: 'Hugging Face', description: 'Search models and datasets',
          verified: true, remote: true, isDeployed: true, inactive: false, useCount: 99,
        }] })
      }
      if (url === 'https://smithery.example/servers/huggingface') {
        trace.push('details')
        return Response.json({
          qualifiedName: 'huggingface', displayName: 'Hugging Face', description: 'Search models and datasets',
          remote: true, deploymentUrl: 'https://huggingface.example/mcp',
          connections: [{ type: 'http', deploymentUrl: 'https://huggingface.example/mcp', configSchema: {} }],
        })
      }
      if (url === 'https://connect.example/connect/dsh-demo/huggingface' && init?.method === 'PUT') {
        trace.push('connect')
        return Response.json({ connectionId: 'huggingface', status: { state: 'connected' } })
      }
      if (url === 'https://connect.example/connect/dsh-demo/huggingface/mcp' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string; params?: { name?: string } }
        trace.push(body.method)
        if (body.method === 'tools/list') {
          return Response.json({ result: { tools: [{ name: 'hub_repo_search' }, { name: 'hub_repo_details' }] } })
        }
        return Response.json({ result: { content: [{ type: 'text', text: `called:${String(body.params?.name)}` }] } })
      }
      if (url.startsWith('https://skills.example/')) return Response.json({ skills: [] })
      throw new Error(`unexpected URL ${url}`)
    })
    const marketplace = await service({
      smitheryApiKey: 'smithery-secret',
      smitheryConnectEndpoint: 'https://connect.example/',
      smitheryNamespace: 'dsh-demo',
    } as Partial<Config>)
    const found = await marketplace.search('Hugging Face research')
    const candidate = found.providers[0]!.capabilities[0]!

    const prepared = await marketplace.prepare(candidate, new AbortController().signal)

    expect(prepared).toMatchObject({
      id: 'smithery:huggingface',
      access: 'public',
      status: 'connected',
      connection: {
        connectionId: 'huggingface',
        toolNames: ['hub_repo_search', 'hub_repo_details'],
      },
    })
    expect(trace).toEqual(['details', 'connect', 'tools/list'])

    await expect(marketplace.execute(prepared, {
      tool: 'hub_repo_search', arguments: { query: 'agents' },
    }, new AbortController().signal)).resolves.toEqual({
      content: [{ type: 'text', text: 'called:hub_repo_search' }],
    })
    await expect(marketplace.execute(prepared, {
      tool: 'not_advertised', arguments: {},
    }, new AbortController().signal)).rejects.toThrow('not available')
    expect(trace).toEqual(['details', 'connect', 'tools/list', 'tools/call'])
  })
})
