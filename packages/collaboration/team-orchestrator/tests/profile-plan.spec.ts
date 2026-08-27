import { describe, expect, it } from 'vitest'
import { ExpertBlueprintId, type ExpertBlueprint } from '@deepseek-ai/dsh-expert-catalog'
import { planTeam } from '../src/plan.ts'
import { profileTask } from '../src/profile.ts'
import type { Config } from '../src/types.ts'

function config(): Config {
  const refs = Array.from({ length: 8 }, (_, index) => ({
    id: ExpertBlueprintId(`expert-${String(index + 1)}`),
    revision: 1,
  }))
  return {
    pools: [
      { domain: 'research_analysis', blueprints: refs },
      { domain: 'product_solution', blueprints: refs },
      { domain: 'software_development', blueprints: refs },
    ],
    maxTextBytes: 16_384,
    maxWorkstreams: 16,
    maxListItems: 32,
    maxContextEntries: 32,
    maxEventBytes: 1_000_000,
    maxMarketplaceSkillsPerExpert: 3,
    communication: {
      simple: { maxChallengeRounds: 1, maxMessagesPerExpert: 4 },
      medium: { maxChallengeRounds: 2, maxMessagesPerExpert: 8 },
      complex: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
    },
  }
}

function blueprint(index: number): ExpertBlueprint {
  return {
    ref: { id: ExpertBlueprintId(`expert-${String(index)}`), revision: 1 },
    role: index === 1 ? 'Evidence research specialist' : `Expert role ${String(index)}`,
    objective: 'Deliver assigned work',
    preset: 'standard',
    skills: index === 1 ? ['research'] : ['general'],
    plugins: ['@plugins/demo'],
    tools: {},
    model: {},
    inputs: [{ name: 'question', description: 'Task question', required: true }],
    outputs: [{ name: 'result', description: 'Task result', required: true }],
    acceptanceCriteria: ['Output satisfies the assignment'],
    collaboration: { challenge: true, review: true, requestHelp: true },
    budget: { maxTurns: 2, maxTokens: 1_024, timeoutMs: 60_000 },
  }
}

describe('automatic task profiler and team planner', () => {
  it('derives simple, medium, and complex bands from plain Chinese and English UI text', () => {
    const simple = profileTask({
      requestId: 'simple-request' as never,
      objective: 'Summarize this paragraph clearly',
    }, config())
    expect(simple).toMatchObject({ complexity: 'simple', plannedExperts: 3, domain: 'research_analysis' })

    const medium = profileTask({
      requestId: 'medium-request' as never,
      objective: '调研竞品并输出产品方案',
    }, config())
    expect(medium).toMatchObject({ complexity: 'medium', plannedExperts: 3, domain: 'product_solution' })

    const complex = profileTask({
      requestId: 'complex-request' as never,
      objective: 'Research competitors; analyze evidence; design PRD; implement frontend and backend; test security; review and deploy production release',
    }, config())
    expect(complex).toMatchObject({ complexity: 'complex', plannedExperts: 8, domain: 'software_development' })
  })

  it('uses productTitle as an inference signal without changing the displayed objective', () => {
    const profile = profileTask({
      requestId: 'title-request' as never,
      objective: '输出第一版结果',
      context: { productTitle: '前后端开发与测试', productLanguage: 'zh-CN' },
    }, config())
    expect(profile.domain).toBe('software_development')
    expect(profile.complexity).toBe('medium')
    expect(profile.objective).toBe('输出第一版结果')
    expect(profile.successCriteria).toEqual(['完成并评审用户提出的任务目标'])
    expect(profile.workstreams.every(value => !/[A-Za-z]/u.test(value.subject))).toBe(true)
  })

  it('treats strategic acquisition analysis as research even when the subject mentions developers', () => {
    const profile = profileTask({
      requestId: 'nvidia-hugging-face' as never,
      objective: '请分析英伟达以超 130 亿美元收购 Hugging Face 的战略利弊。利端：整合开源模型生态、强化 AI 开发者粘性、完善硬件与平台闭环。弊端：估值过高、监管反垄断审查、人才与文化整合风险。请分点论述并给出综合判断。',
      context: { productLanguage: 'zh' },
    }, config())

    expect(profile.domain).toBe('research_analysis')
    expect(profile.workstreams.some(value => value.requiredCapabilities.includes('analysis'))).toBe(true)

    const specialistBlueprints = [
      ['Evidence Researcher', 'source_retrieval literature_research with primary evidence'],
      ['Market Analyst', 'market_research commercial_analysis valuation and market sizing'],
      ['Competitive Intelligence Analyst', 'competitive_research product_analysis positioning'],
      ['Policy and Regulatory Analyst', 'policy_research regulatory_research antitrust compliance'],
      ['Data Analyst', 'data_analysis quantitative validation and metrics'],
      ['Technical Analyst', 'technical_analysis engineering_analysis architecture and model ecosystems'],
      ['Research Risk Reviewer', 'risk_review adversarial evidence review'],
      ['Synthesis Reviewer', 'synthesis evidence_review and cross-source consistency'],
    ] as const
    const plan = planTeam({
      get: (ref) => {
        const index = Number(String(ref.id).split('-')[1])
        const [role, objective] = specialistBlueprints[index - 1]!
        return { ...blueprint(index), role, objective }
      },
    }, config(), profile)

    expect(plan.roster.map(expert => expert.role)).toEqual([
      '市场分析专家',
      '政策与监管专家',
      '技术分析专家',
    ])
  })

  it('selects three and eight distinct immutable revisions and legal topologies', () => {
    const catalog = { get: (ref: { id: unknown }) => blueprint(Number(String(ref.id).split('-')[1])) }
    const simple = profileTask({ requestId: 'one' as never, objective: 'Summarize the evidence' }, config())
    const simplePlan = planTeam(catalog, config(), simple)
    expect(simplePlan.topology).toBe('producer_reviewer')
    expect(simplePlan.roster).toHaveLength(3)
    expect(simplePlan.roster[0]?.assignment.language).toBe('en')

    const chinese = profileTask({
      requestId: 'chinese' as never,
      objective: '调研竞品并总结关键风险',
      context: { productLanguage: 'zh' },
    }, config())
    const chinesePlan = planTeam({
      get: ref => ({
        ...blueprint(Number(String(ref.id).split('-')[1])),
        role: 'Product Strategist',
        acceptanceCriteria: ['Every proposal maps to a user problem'],
      }),
    }, config(), chinese)
    expect(chinesePlan.roster[0]).toMatchObject({
      role: '产品策略专家',
      assignment: { language: 'zh' },
      acceptanceCriteria: ['每项方案均对应具体用户问题'],
    })
    expect(chinese.successCriteria).toEqual(['完成并评审用户提出的任务目标'])
    expect(chinese.workstreams.every(value => !/[A-Za-z]/u.test(value.subject))).toBe(true)

    const complex = profileTask({
      requestId: 'eight' as never,
      objective: 'Research; analyze; design; plan; implement; test; review; deploy',
      domain: 'software_development',
    }, config())
    const complexPlan = planTeam(catalog, config(), complex)
    expect(['hybrid', 'grouped']).toContain(complexPlan.topology)
    expect(complexPlan.roster).toHaveLength(8)
    expect(new Set(complexPlan.roster.map(item => `${item.blueprint.id}@${String(item.blueprint.revision)}`)).size).toBe(8)
  })

  it('rejects cyclic explicit work and insufficient exact blueprint revisions', () => {
    expect(() => profileTask({
      requestId: 'cycle' as never,
      objective: 'Analyze two dependent tasks',
      workstreams: [
        { id: 'one', subject: 'One', description: 'One', blockedBy: ['two'] },
        { id: 'two', subject: 'Two', description: 'Two', blockedBy: ['one'] },
      ],
    }, config())).toThrow(expect.objectContaining({ code: 'TEAM_INVALID_ARGUMENT' }))

    const profile = profileTask({
      requestId: 'short-pool' as never,
      objective: 'Research; analyze; design; plan; implement; test; review; deploy',
      domain: 'software_development',
    }, config())
    const short = config()
    const pools = short.pools.map(pool => pool.domain === 'software_development'
      ? { ...pool, blueprints: pool.blueprints.slice(0, 7) }
      : pool)
    expect(() => planTeam({ get: ref => blueprint(Number(String(ref.id).split('-')[1])) }, { ...short, pools }, profile))
      .toThrow(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }))
  })
})
