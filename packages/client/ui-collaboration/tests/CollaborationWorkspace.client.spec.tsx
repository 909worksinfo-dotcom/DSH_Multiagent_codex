// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CollaborationWorkspace } from '../src/client/CollaborationWorkspace.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { en, zh } from '../src/client/locales.ts'
import type {
  CollaborationCatalogSnapshot, CollaborationExternalCredential, CollaborationExternalCredentialRef,
  CollaborationModelCatalog, CollaborationPort, CollaborationRunId,
} from '../src/client/types.ts'
import type {} from '../src/client/index.ts'

function makeProps(options: {
  readonly port?: CollaborationPort
  readonly dictionary?: typeof zh | typeof en
  readonly start?: (request: Parameters<CollaborationPort['createRun']>[0]) => Promise<CollaborationRunId>
  readonly confirm?: (runId: CollaborationRunId) => Promise<void>
  readonly listSkills?: () => Promise<readonly { readonly id: string; readonly label: string; readonly description: string }[]>
  readonly listModels?: () => Promise<CollaborationModelCatalog>
  readonly credentials?: readonly CollaborationExternalCredential[]
} = {}) {
  const port = options.port ?? createCollaborationDemoPort([])
  const dictionary = options.dictionary ?? zh
  const t: TranslateNS<'collaboration'> = key => dictionary[key as keyof typeof zh]
  const startCollaboration = vi.fn(options.start ?? (async request => port.createRun(request)))
  const confirmCollaboration = vi.fn(options.confirm ?? (async runId => port.confirmRun(runId)))
  const cancelCollaboration = vi.fn(async (runId: CollaborationRunId) => port.terminate(runId))
  const listCollaborationSkills = vi.fn(options.listSkills ?? (async () => [
    { id: 'collaboration-research-analysis', label: 'collaboration-research-analysis', description: '研究事实与证据' },
    { id: 'collaboration-peer-review', label: 'collaboration-peer-review', description: '质疑结论并交叉评审' },
    { id: 'collaboration-product-solution', label: 'collaboration-product-solution', description: '形成产品解决方案' },
    { id: 'collaboration-software-development', label: 'collaboration-software-development', description: '实现并验证软件方案' },
  ]))
  const listCollaborationModels = vi.fn(options.listModels ?? (async () => ({
    current: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' },
    groups: [
      {
        id: 'deepseek-official', name: 'DeepSeek', models: [{
          id: 'deepseek-chat', name: 'DeepSeek Chat',
          reasoning: { defaultEffort: 'medium', efforts: [{ id: 'medium', name: '中' }, { id: 'high', name: '高' }] },
        }],
      },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    ],
    failures: [],
  })))
  let credentials = options.credentials ?? [
    { ref: 'SMITHERY_API_KEY', configured: false, writable: true },
    { ref: 'COMPOSIO_API_KEY', configured: false, writable: true },
  ] satisfies readonly CollaborationExternalCredential[]
  const describeCollaborationCredentials = vi.fn(async () => credentials)
  const setCollaborationCredential = vi.fn(async (ref: CollaborationExternalCredentialRef, _value: string) => {
    credentials = credentials.map(value => value.ref === ref
      ? { ...value, configured: true, source: 'test' }
      : value)
  })
  return {
    port,
    startCollaboration,
    confirmCollaboration,
    cancelCollaboration,
    listCollaborationSkills,
    listCollaborationModels,
    describeCollaborationCredentials,
    setCollaborationCredential,
    props: {
      useSessions: vi.fn(),
      useWorkspaces: vi.fn(),
      useCollaboration: <S,>(select: (state: CollaborationCatalogSnapshot) => S): S => useSyncExternalStore(
        listener => port.source.subscribe(listener),
        () => select(port.source.getSnapshot()),
      ),
      startCollaboration,
      listCollaborationSkills,
      listCollaborationModels,
      describeCollaborationCredentials,
      setCollaborationCredential,
      confirmCollaboration,
      cancelCollaboration,
      refreshCollaboration: vi.fn(async () => undefined),
      openCollaboration: vi.fn(),
      prepareNewCollaboration: vi.fn(),
      leaveCollaboration: vi.fn(),
      t,
    },
  }
}

afterEach(() => { cleanup() })

describe('CollaborationWorkspace', () => {
  it('recovers the newest non-cancelled task after reload and opens its collaboration panel', async () => {
    const runs = createDemoRuns()
    const running = runs.find(run => run.status === 'running')!
    const forming = runs.find(run => run.status === 'forming')!
    const cancelled = {
      ...forming,
      id: 'team-run-cancelled-newer',
      status: 'cancelled' as const,
      phase: 'cancelled' as const,
      createdAt: running.createdAt + 60_000,
    }
    const port = createCollaborationDemoPort([cancelled, running])
    const value = makeProps({ port })

    render(<CollaborationWorkspace {...value.props} />)

    expect(await screen.findByText(zh['workspace.active.title'])).toBeTruthy()
    expect(screen.getByRole('heading', { name: running.title })).toBeTruthy()
    await waitFor(() => { expect(value.props.openCollaboration).toHaveBeenCalledOnce() })
  })

  it('shows the durable task and expert plan before confirmation, then starts the Lead', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)

    expect(screen.getByRole('heading', { name: zh['workspace.title'] })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), {
      target: { value: '评审这个 Demo，由产品专家提案，技术专家质疑，Lead 裁决' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    await waitFor(() => {
      expect(value.startCollaboration).toHaveBeenCalledWith({
        title: '评审这个 Demo，由产品专家提案，技术专家质疑，Lead 裁决',
        objective: '评审这个 Demo，由产品专家提案，技术专家质疑，Lead 裁决',
        language: 'zh',
      })
    })
    expect(await screen.findByRole('heading', { name: zh['workspace.review.title'] })).toBeTruthy()
    expect(document.querySelectorAll('[data-review-task]')).toHaveLength(3)
    expect(document.querySelectorAll('[data-review-expert]')).toHaveLength(3)
    expect(document.querySelector('[data-review-task="scope"]')?.textContent).toContain('用户研究专家')
    expect(screen.getAllByRole('combobox', { name: /选择模型/u })).toHaveLength(4)
    expect(screen.getAllByText(zh['workspace.review.expert.tools.full'])).toHaveLength(3)
    expect(screen.getAllByText(zh['workspace.review.expert.permissions.inherit'])).toHaveLength(3)
    expect(document.querySelector('[data-collaboration-workspace="review"]')?.textContent).not.toMatch(/expert-\d+/iu)
    expect(value.confirmCollaboration).not.toHaveBeenCalled()
    expect(screen.queryByText(zh['workspace.active.title'])).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.confirm'] }))
    await waitFor(() => { expect(value.confirmCollaboration).toHaveBeenCalledOnce() })
    expect(await screen.findByText(zh['workspace.active.title'])).toBeTruthy()
    expect(document.querySelector('[data-collaboration-center-author="user"]')?.textContent).toContain('评审这个 Demo')
    expect(document.querySelector('[data-collaboration-center-author="lead"]')?.textContent).toContain(zh['workspace.plan.title'])
    expect(screen.queryByRole('heading', { name: zh['workspace.title'] })).toBeNull()
  })

  it('inherits everyday web search for research plans without showing or consulting external authorization', async () => {
    const seed = createCollaborationDemoPort([])
    const runId = await seed.createRun({
      title: '研究市场变化', objective: '研究市场变化并核验外部证据', language: 'zh',
    })
    const planned = seed.source.getSnapshot().runs.find(run => run.id === runId)
    if (planned?.profile === null || planned?.profile === undefined) throw new Error('planning fixture has no profile')
    const port = createCollaborationDemoPort([{
      ...planned,
      profile: { ...planned.profile, domain: 'research_analysis' },
      experts: planned.experts.map(expert => ({
        ...expert,
        binding: { ...expert.binding, marketplaceProviders: [], marketplaceSkills: [] },
      })),
    }])
    const value = makeProps({ port })
    render(<CollaborationWorkspace {...value.props} />)

    expect(await screen.findByRole('heading', { name: zh['workspace.review.title'] })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh['workspace.review.external'] })).toBeNull()
    const confirm = screen.getByRole('button', { name: zh['workspace.review.confirm'] })
    expect(confirm.getAttribute('disabled')).toBeNull()
    fireEvent.click(confirm)
    await waitFor(() => { expect(value.confirmCollaboration).toHaveBeenCalledOnce() })
  })

  it('shows authorization only for a third-party provider selected by the reviewed task', async () => {
    const seed = createCollaborationDemoPort([])
    const runId = await seed.createRun({
      title: '评估市场资料', objective: '评估市场资料并交付结论', language: 'zh',
    })
    const planned = seed.source.getSnapshot().runs.find(run => run.id === runId)
    if (planned === undefined) throw new Error('planning fixture is missing')
    const [first, ...rest] = planned.experts
    if (first === undefined) throw new Error('planning fixture has no experts')
    const port = createCollaborationDemoPort([{
      ...planned,
      experts: [{
        ...first,
        binding: {
          ...first.binding,
          marketplaceProviders: [{ source: 'smithery', state: 'authorization_required' }],
          marketplaceSkills: [],
        },
      }, ...rest.map(expert => ({
        ...expert,
        binding: { ...expert.binding, marketplaceProviders: [], marketplaceSkills: [] },
      }))],
    }])
    const value = makeProps({ port })
    render(<CollaborationWorkspace {...value.props} />)

    expect(await screen.findByRole('heading', { name: zh['workspace.review.external'] })).toBeTruthy()
    expect(screen.getByLabelText(`${zh['workspace.review.external.smithery']} ${zh['workspace.review.external.secret']}`)).toBeTruthy()
    expect(screen.queryByText(zh['workspace.review.external.composio'])).toBeNull()
    expect(screen.queryByText('联网搜索')).toBeNull()
    await waitFor(() => { expect(value.describeCollaborationCredentials).toHaveBeenCalledOnce() })
    const confirm = screen.getByRole('button', { name: zh['workspace.review.confirm'] })
    expect(confirm.getAttribute('disabled')).toBeNull()
  })

  it('lets the Lead and every expert select independent daily-session models before confirmation', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), {
      target: { value: '分析一个市场机会并交付有证据的综合判断' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))
    await screen.findByRole('heading', { name: zh['workspace.review.title'] })
    await waitFor(() => { expect(value.listCollaborationModels).toHaveBeenCalledOnce() })

    const modelSelectors = screen.getAllByRole('combobox', { name: /选择模型/u })
    fireEvent.change(modelSelectors[0]!, { target: { value: 'openai\u0000gpt-5' } })
    expect(screen.getByText(zh['workspace.review.models.changed'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['workspace.review.confirm'] }).getAttribute('disabled')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.models.apply'] }))
    await waitFor(() => { expect(value.startCollaboration).toHaveBeenCalledTimes(2) })
    expect(value.cancelCollaboration).toHaveBeenCalledOnce()
    expect(value.startCollaboration.mock.calls[1]?.[0].leadModel).toEqual({
      provider: 'openai', model: 'gpt-5',
    })
    expect(value.startCollaboration.mock.calls[1]?.[0].expertModels).toEqual([
      { slotId: 'slot-1', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' } },
      { slotId: 'slot-2', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' } },
      { slotId: 'slot-3', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' } },
    ])
    expect(value.confirmCollaboration).not.toHaveBeenCalled()
  })

  it('uses the prompt language instead of the system locale when starting a task', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), {
      target: { value: 'Review this product strategy and deliver a recommendation' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    await waitFor(() => {
      expect(value.startCollaboration).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }))
    })
  })

  it('lets users remove and search-add real skills before applying a new reviewed plan', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), {
      target: { value: '分析一个新市场机会并给出可验证结论' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))
    await screen.findByRole('heading', { name: zh['workspace.review.title'] })

    await waitFor(() => { expect(value.listCollaborationSkills).toHaveBeenCalledOnce() })
    const removeProduct = screen.getByRole('button', {
      name: /从用户研究专家删除技能“产品方案设计”/u,
    })
    fireEvent.click(removeProduct)
    expect(screen.getByRole('button', {
      name: zh['workspace.review.confirm'],
    }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByText(zh['workspace.review.skills.changed'])).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: zh['workspace.review.skills.add'] })[0]!)
    const search = await screen.findByRole('searchbox', { name: zh['workspace.review.skills.search'] })
    fireEvent.change(search, { target: { value: '软件' } })
    fireEvent.click(screen.getByRole('button', { name: /软件开发与验证.*实现并验证软件方案/u }))

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.skills.apply'] }))
    await waitFor(() => { expect(value.startCollaboration).toHaveBeenCalledTimes(2) })
    expect(value.cancelCollaboration).toHaveBeenCalledOnce()
    const objective = value.startCollaboration.mock.calls[1]?.[0].objective ?? ''
    expect(objective).toContain('将用户研究专家的技能修改为')
    expect(objective).toContain('`collaboration-research-analysis`')
    expect(objective).toContain('`collaboration-peer-review`')
    expect(objective).toContain('`collaboration-software-development`')
    expect(objective).not.toContain('`collaboration-product-solution`')
    expect(value.confirmCollaboration).not.toHaveBeenCalled()
  })

  it('shows launch failures in the prompt language instead of exposing runtime English', async () => {
    const value = makeProps({ start: async () => { throw new Error('provider request failed') } })
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: '分析这个中文任务' } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    expect((await screen.findByRole('alert')).textContent).toContain(zh['workspace.error'])
    expect(screen.getByRole('alert').textContent).not.toContain('provider request failed')
  })

  it('keeps an active task UI in its prompt language when the system locale differs', async () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const port = createCollaborationDemoPort([completed])
    const value = makeProps({ port, dictionary: en, start: async () => completed.id })
    render(<CollaborationWorkspace {...value.props} />)
    expect(screen.getByRole('heading', { name: zh['workspace.title'] })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en['workspace.title'] })).toBeNull()
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: completed.objective } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    expect(await screen.findByText(zh['workspace.active.title'])).toBeTruthy()
    expect(screen.queryByText(en['workspace.active.title'])).toBeNull()
  })

  it('shows the task ledger and Lead updates only, with completed tasks struck through', async () => {
    const base = createDemoRuns().find(run => run.status === 'completed')!
    const longDescription = '这是一段用于验证任务清单完整性的任务描述，需要展示全部执行细节，不允许用省略号截断关键的验收条件、证据要求与交付标准'
    const completed = {
      ...base,
      tasks: base.tasks.map((task, index) => index === 0 ? { ...task, description: longDescription } : task),
    }
    const port = createCollaborationDemoPort([completed])
    const value = makeProps({ port, start: async () => completed.id })
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: completed.objective } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    await screen.findByText(zh['workspace.delivery.title'])
    expect(document.querySelectorAll('[data-collaboration-center-task]')).toHaveLength(4)
    expect(document.querySelectorAll('[data-collaboration-center-task] del')).toHaveLength(4)
    expect(document.querySelectorAll('[data-execution-stage]')).toHaveLength(2)
    expect(document.querySelector('[data-execution-stage="1"]')?.getAttribute('data-mode')).toBe('parallel')
    expect(document.querySelector('[data-execution-stage="2"]')?.getAttribute('data-mode')).toBe('serial')
    const taskRows = [...document.querySelectorAll('[data-collaboration-center-task]')]
    expect(taskRows.map(row => row.getAttribute('data-task-mode'))).toEqual([
      'parallel', 'parallel', 'parallel', 'serial',
    ])
    const firstTask = document.querySelector('[data-collaboration-center-task="task-1"]')
    const finalTask = document.querySelector('[data-collaboration-center-task="task-4"]')
    expect(firstTask?.querySelector('[data-task-heading] [data-task-status]')?.textContent).toBe('已完成')
    expect(firstTask?.querySelector('[data-task-mode-label]')?.textContent).toBe('并行任务')
    expect(firstTask?.querySelector('[data-task-agent]')?.textContent).toBe('执行 Agent：产品策略专家')
    expect(finalTask?.querySelector('[data-task-mode-label]')?.textContent).toBe('串行任务')
    expect(finalTask?.querySelector('[data-task-agent]')?.textContent).toBe('执行 Agent：反方评审专家')
    const descriptions = [...document.querySelectorAll('[data-task-description]')].map(node => node.textContent ?? '')
    expect(descriptions).toHaveLength(4)
    expect(descriptions[0]).toBe(longDescription)
    expect(descriptions[0]).not.toContain('…')
    expect(base.tasks[0]?.description).not.toBe(longDescription)
    expect(document.querySelectorAll('[data-center-lead-event]')).toHaveLength(2)
    expect(screen.getByText('裁决采用统一指标，并保留反方意见作为验收资产')).toBeTruthy()
    expect(screen.queryByText('建议首批聚焦调研分析、产品方案与软件开发三个通用领域')).toBeNull()
  })

  it('returns to a clean launcher without mixing into daily chat', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: '分析用户需求' } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))
    await screen.findByRole('heading', { name: zh['workspace.review.title'] })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.confirm'] }))
    await screen.findByText(zh['workspace.active.title'])

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.panel.open'] }))
    expect(value.props.openCollaboration).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.new'] }))
    expect(value.props.prepareNewCollaboration).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: zh['workspace.title'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.daily'] }))
    expect(value.props.leaveCollaboration).toHaveBeenCalledOnce()
  })

  it('cancels the previous draft and regenerates a new durable plan from user changes', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: '分析一个新市场机会' } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))
    await screen.findByRole('heading', { name: zh['workspace.review.title'] })

    fireEvent.change(screen.getByLabelText(zh['workspace.review.revision']), { target: { value: '增加监管专家并补充风险验收' } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.regenerate'] }))

    await waitFor(() => { expect(value.startCollaboration).toHaveBeenCalledTimes(2) })
    expect(value.cancelCollaboration).toHaveBeenCalledOnce()
    expect(value.startCollaboration.mock.calls[1]?.[0].objective).toContain('协作方案调整要求')
    expect(value.startCollaboration.mock.calls[1]?.[0].objective).toContain('增加监管专家')
    expect(value.confirmCollaboration).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(zh['workspace.review.revision']), {
      target: { value: '阶段1两个任务变成串行任务' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.review.regenerate'] }))

    await waitFor(() => { expect(value.startCollaboration).toHaveBeenCalledTimes(3) })
    const twiceRevised = value.startCollaboration.mock.calls[2]?.[0].objective ?? ''
    expect(twiceRevised.match(/协作方案调整要求/gu)).toHaveLength(1)
    expect(twiceRevised).toContain('增加监管专家并补充风险验收')
    expect(twiceRevised).toContain('阶段1两个任务变成串行任务')
  })
})
