// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { CollaborationRoot } from '../src/client/CollaborationRoot.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { createCollaborationStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { CollaborationCatalogSnapshot, CollaborationPort } from '../src/client/types.ts'
import type { CollaborationExpertApproval } from '../src/client/contract.ts'
import type {} from '../src/client/index.ts'

const emptySessions: SessionListState = {
  ids: [],
  byId: {},
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

function makeProps(
  scope = 'component',
  port: CollaborationPort = createCollaborationDemoPort(),
  dictionary: typeof zh | typeof en = zh,
) {
  const instance = createCollaborationStore().create(scope)
  const t: TranslateNS<'collaboration'> = key => key in dictionary ? dictionary[key as keyof typeof zh] : key
  return {
    port,
    store: instance,
    props: {
      open: true,
      width: 440,
      useSessions: <S,>(select: (state: SessionListState) => S): S => select(emptySessions),
      useWorkspaces: vi.fn(),
      useStore: <S,>(select: (state: ReturnType<typeof instance.getSnapshot>) => S): S => useSyncExternalStore(
        listener => instance.subscribe(listener),
        () => select(instance.getSnapshot()),
      ),
      actions: instance.actions,
      useCollaboration: <S,>(select: (state: CollaborationCatalogSnapshot) => S): S => useSyncExternalStore(
        listener => port.source.subscribe(listener),
        () => select(port.source.getSnapshot()),
      ),
      refreshCollaboration: vi.fn(async () => undefined),
      openCollaboration: vi.fn(),
      closeCollaboration: vi.fn(),
      readExpertApproval: vi.fn<(sessionId: string) => CollaborationExpertApproval | null>(() => null),
      answerExpertApproval: vi.fn(async () => undefined),
      t,
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('CollaborationRoot', () => {
  it('skips a newer cancelled draft and renders the newest recoverable task', () => {
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
    const value = makeProps('recover-live-run', createCollaborationDemoPort([cancelled, running])).props

    render(<CollaborationRoot {...value} />)
    fireEvent.click(screen.getByRole('tab', { name: zh['tabs.roster'] }))

    expect(screen.getAllByText('8 / 8 名专家已就位').length).toBeGreaterThan(0)
  })

  it('keeps exactly three keyboard-operable collaboration views without a task-board page', () => {
    const forming = createDemoRuns().find(run => run.status === 'forming')!
    const value = makeProps('forming', createCollaborationDemoPort([forming])).props
    render(<CollaborationRoot {...value} />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['群聊', '专家团队', '协作协议'])
    expect(screen.queryByRole('tab', { name: zh['tabs.tasks'] })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh['tabs.overview'] })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh['tabs.controller'] })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh['tabs.blackboard'] })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh['tabs.charter'] })).toBeNull()

    const rosterTab = screen.getByRole('tab', { name: zh['tabs.roster'] })
    fireEvent.click(rosterTab)
    fireEvent.keyDown(rosterTab, { key: 'ArrowLeft' })
    const timelineTab = screen.getByRole('tab', { name: zh['tabs.timeline'] })
    expect(timelineTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(timelineTab)
  })

  it('renders panel chrome in the prompt language instead of the system language', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const value = makeProps('english-system', createCollaborationDemoPort([completed]), en).props
    render(<CollaborationRoot {...value} />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      zh['tabs.timeline'], zh['tabs.roster'], zh['tabs.protocol'],
    ])
    expect(screen.queryByRole('tab', { name: en['tabs.timeline'] })).toBeNull()
  })

  it('does not repeat the task prompt in the collaboration panel', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const prompt = '请分析英伟达以超 130 亿美元收购 Hugging Face 的战略利弊'
    const run = { ...running, title: prompt, objective: prompt }
    const value = makeProps('prompt-free-panel', createCollaborationDemoPort([run])).props
    const view = render(<CollaborationRoot {...value} />)

    expect(view.container.textContent).not.toContain(prompt)
    expect(screen.getByRole('tablist', { name: zh['tabs.label'] })).toBeTruthy()
  })

  it('surfaces an expert tool approval in the collaboration panel and resumes through the original wait', async () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const expert = running.experts.find(value => value.sessionId !== null)!
    const value = makeProps('expert-approval', createCollaborationDemoPort([running])).props
    const approval: CollaborationExpertApproval = {
      key: 'a:approval-rpc-1',
      sessionId: expert.sessionId!,
      toolName: 'bash',
      reason: '需要读取飞书登录状态以创建最终交付文档',
    }
    value.readExpertApproval.mockReturnValue(approval)
    const view = render(<CollaborationRoot {...value} />)

    const banner = view.container.querySelector('[data-collaboration-expert-approval]')
    expect(banner?.textContent).toContain('等待你的授权')
    expect(banner?.textContent).toContain(expert.name)
    expect(banner?.textContent).toContain('需要读取飞书登录状态以创建最终交付文档')

    fireEvent.click(screen.getByRole('button', { name: '仅本次允许' }))
    await act(async () => undefined)
    expect(value.answerExpertApproval).toHaveBeenCalledOnce()
    expect(value.answerExpertApproval).toHaveBeenCalledWith(
      expert.sessionId,
      approval.key,
      'allowed-once',
    )
  })

  it('offers an exact task-wide approval only for the current TeamRun', async () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const expert = running.experts.find(value => value.sessionId !== null)!
    const value = makeProps('task-wide-expert-approval', createCollaborationDemoPort([running])).props
    value.readExpertApproval.mockReturnValue({
      key: 'a:approval-rpc-task',
      sessionId: expert.sessionId!,
      toolName: 'bash',
      collaborationRunId: running.id,
    })
    render(<CollaborationRoot {...value} />)

    expect(screen.getByRole('button', { name: '当前 Agent 允许' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '本次任务允许' }))
    await act(async () => undefined)
    expect(value.answerExpertApproval).toHaveBeenCalledWith(
      expert.sessionId,
      'a:approval-rpc-task',
      'allowed-for-task',
    )
  })

  it('opens a collapsed collaboration dock when an expert approval needs the user', async () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const expert = running.experts.find(value => value.sessionId !== null)!
    const value = makeProps('approval-opens-collapsed-dock', createCollaborationDemoPort([running])).props
    value.open = false
    value.readExpertApproval.mockReturnValue({
      key: 'a:approval-rpc-visible',
      sessionId: expert.sessionId!,
      toolName: 'bash',
      collaborationRunId: running.id,
    })

    render(<CollaborationRoot {...value} />)
    await act(async () => undefined)

    expect(value.openCollaboration).toHaveBeenCalledOnce()
  })

  it('keeps a collapsed collaboration dock closed when no expert is waiting for approval', async () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const value = makeProps('no-approval-keeps-dock-collapsed', createCollaborationDemoPort([running])).props
    value.open = false

    render(<CollaborationRoot {...value} />)
    await act(async () => undefined)

    expect(value.openCollaboration).not.toHaveBeenCalled()
  })

  it('does not offer a task-wide grant when the host did not bind the approval to this TeamRun', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const expert = running.experts.find(value => value.sessionId !== null)!
    const value = makeProps('unscoped-expert-approval', createCollaborationDemoPort([running])).props
    value.readExpertApproval.mockReturnValue({
      key: 'a:approval-rpc-unscoped',
      sessionId: expert.sessionId!,
      toolName: 'bash',
    })
    render(<CollaborationRoot {...value} />)

    expect(screen.queryByRole('button', { name: '本次任务允许' })).toBeNull()
    expect(screen.getByRole('button', { name: '当前 Agent 允许' })).toBeTruthy()
  })

  it('keeps the collaboration panel visible when one cold expert approval projection cannot be read', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const value = makeProps('cold-expert-approval', createCollaborationDemoPort([running])).props
    value.readExpertApproval.mockImplementation(() => { throw new Error('cold expert projection unavailable') })

    const view = render(<CollaborationRoot {...value} />)

    expect(view.container.querySelector('[data-collaboration-dock="true"]')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: zh['tabs.label'] })).toBeTruthy()
  })

  it('renders all eight experts and only safe binding metadata', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const value = makeProps('running', createCollaborationDemoPort([running])).props
    const view = render(<CollaborationRoot {...value} />)
    fireEvent.click(screen.getByRole('tab', { name: zh['tabs.roster'] }))

    expect(view.container.querySelectorAll('[data-expert-attempt]')).toHaveLength(8)
    expect(screen.getAllByText('8 / 8 名专家已就位').length).toBeGreaterThan(0)
    fireEvent.click(view.container.querySelector('[data-expert-attempt="expert-attempt-1"]')!)
    expect(screen.getByText('expert.blueprint.1')).toBeTruthy()
    expect(screen.getByText('专业分析')).toBeTruthy()
    expect(screen.getByText('完整日常工具集')).toBeTruthy()
    expect(screen.getByText('跟随主协调智能体 · 按需审批')).toBeTruthy()
    expect(screen.getByText('深度研究与证据分析')).toBeTruthy()
    expect(screen.getByText('协作质疑与同行评审')).toBeTruthy()
    expect(screen.getByText('产品方案设计')).toBeTruthy()
    expect(screen.getByText('网络检索')).toBeTruthy()
    expect(screen.getByText('深度调研方法')).toBeTruthy()
    expect(screen.getByText('Consensus')).toBeTruthy()
    expect(screen.getByText('Smithery · 已选能力尚未接通')).toBeTruthy()
    expect(screen.getByText('Composio · 当前任务未选用')).toBeTruthy()
    expect(screen.getByText('skills.sh · 任务内可用')).toBeTruthy()
    expect(screen.getByText('skills.sh · 公开能力 · 已加载')).toBeTruthy()
    expect(screen.getByText('未接通候选能力')).toBeTruthy()
    expect(screen.getByText('Smithery · 尚未接通，当前任务不执行')).toBeTruthy()
    expect(view.container.textContent).not.toContain('digest')
    expect(view.container.textContent).not.toContain('/Users/')
  })

  it('does not imply that authorization is possible when a provider supplied no selected capability', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const value = makeProps('provider-readiness', createCollaborationDemoPort([running])).props
    const view = render(<CollaborationRoot {...value} />)
    fireEvent.click(screen.getByRole('tab', { name: zh['tabs.roster'] }))
    fireEvent.click(view.container.querySelector('[data-expert-attempt="expert-attempt-2"]')!)

    expect(screen.getByText('Smithery · 当前任务未选用')).toBeTruthy()
    expect(screen.getByText('Composio · 当前任务未选用')).toBeTruthy()
    expect(screen.getByText('skills.sh · 当前任务未选用')).toBeTruthy()
    expect(view.container.textContent).not.toContain('按任务授权后可用')
  })

  it('shows public agent group chat without a task-board page or private reasoning', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const value = makeProps('completed', createCollaborationDemoPort([completed])).props
    const view = render(<CollaborationRoot {...value} />)

    fireEvent.click(screen.getByRole('tab', { name: zh['tabs.timeline'] }))
    expect(screen.getByText(zh['timeline.public'])).toBeTruthy()
    expect(view.container.querySelectorAll('[data-collaboration-event]')).toHaveLength(8)
    expect(screen.getByText('最终交付')).toBeTruthy()
    expect(view.container.querySelector('[data-final-delivery="true"]')?.textContent).toContain('建议进入小批量验证')
    expect(view.container.querySelector('[data-collaboration-discussion-stage="task-4"] [data-final-delivery="true"]')).toBeTruthy()
    expect(view.container.textContent).not.toContain('private chain of thought')
  })

  it('assigns one stable, distinct identity tone to each visible agent', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const value = makeProps('participant-tones', createCollaborationDemoPort([completed])).props
    const view = render(<CollaborationRoot {...value} />)
    const tonesByAuthor = new Map<string, string>()

    for (const event of completed.timeline) {
      const article = view.container.querySelector<HTMLElement>(`[data-collaboration-event="${event.id}"]`)
      const tone = article?.dataset.participantTone
      expect(tone).toBeTruthy()
      const previous = tonesByAuthor.get(event.author.sessionId)
      if (previous === undefined) tonesByAuthor.set(event.author.sessionId, tone!)
      else expect(tone).toBe(previous)
    }
    expect(new Set(tonesByAuthor.values()).size).toBe(tonesByAuthor.size)
  })

  it('renders routed messages with semantic hierarchy and hides legacy handoff wording', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const routed = {
      ...completed,
      tasks: [],
      timeline: [{
        ...completed.timeline[0]!,
        kind: 'handoff' as const,
        content: [
          '【串行协作交接】',
          '上下文摘要：已完成市场证据核验',
          '下一步：完成技术交叉评审',
          '选择专家1：该专家负责技术边界',
          '消息：请形成可审计评审资产',
        ].join('\n'),
      }],
    }
    const value = makeProps('message-hierarchy', createCollaborationDemoPort([routed])).props
    const view = render(<CollaborationRoot {...value} />)

    expect(view.container.textContent).not.toContain('串行协作交接')
    expect(view.container.querySelector('[data-message-section="context"]')?.textContent).toContain('上下文摘要')
    expect(view.container.querySelector('[data-message-section="next"]')?.textContent).toContain('下一步')
    expect(view.container.querySelector('[data-message-section="selection"]')?.textContent).toContain('选择')
    expect(view.container.querySelector('[data-message-section="message"]')?.textContent).toContain('消息')
  })

  it('hides impossible self-recipient labels from immutable legacy events', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const leadActor = { role: 'lead' as const, sessionId: completed.lead.sessionId, name: completed.lead.name }
    const legacySelfReceipt = {
      ...completed,
      tasks: [],
      timeline: [{
        ...completed.timeline[0]!,
        kind: 'artifact' as const,
        author: leadActor,
        targets: [leadActor],
        content: 'Artifact "Accepted synthesis" is accepted at version 2.',
      }],
    }
    const value = makeProps('legacy-self-recipient', createCollaborationDemoPort([legacySelfReceipt])).props
    const view = render(<CollaborationRoot {...value} />)

    expect(view.container.textContent).toContain('资产“Accepted synthesis”已更新为已采纳，当前为版本 2')
    expect(view.container.textContent).not.toContain('发送给 主协调智能体')
  })

  it('uses the authoritative main-task titles for every discussion stage', () => {
    const running = createDemoRuns().find(run => run.status === 'running')!
    const value = makeProps('task-aligned-stages', createCollaborationDemoPort([running])).props
    const view = render(<CollaborationRoot {...value} />)

    const stages = view.container.querySelectorAll<HTMLElement>('[data-collaboration-discussion-stage]')
    expect(stages).toHaveLength(running.tasks.length)
    for (const task of running.tasks) {
      const title = view.container.querySelector<HTMLElement>(`[data-collaboration-stage-title="${task.id}"]`)
      expect(title?.textContent).toBe(task.subject)
    }

    const activeStage = view.container.querySelector<HTMLElement>('[data-collaboration-discussion-stage="task-3"]')
    expect(activeStage?.dataset.current).toBe('true')
    expect(activeStage?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(activeStage?.textContent).toContain(`${zh['timeline.discussing']}执行质量验收`)

    const architectureStage = view.container.querySelector<HTMLElement>('[data-collaboration-discussion-stage="task-2"]')!
    expect(architectureStage.querySelector('[data-collaboration-event="message-7"]')).toBeTruthy()
    fireEvent.click(architectureStage.querySelector('button')!)
    expect(architectureStage.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(activeStage?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses assigned expert roles as names throughout the visible panel', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const value = makeProps('role-names', createCollaborationDemoPort([completed])).props
    const view = render(<CollaborationRoot {...value} />)

    fireEvent.click(screen.getByRole('tab', { name: zh['tabs.roster'] }))
    for (const expert of completed.experts) {
      expect(screen.getByText(expert.name)).toBeTruthy()
    }
    expect(view.container.textContent).not.toMatch(/专家\d+/u)
    expect(view.container.textContent).not.toMatch(/expert-\d+/iu)
  })

  it('fails closed without exposing a panel-owned retry or task creation path', () => {
    const failed = createDemoRuns().find(run => run.status === 'team_formation_failed')!
    const value = makeProps('failure', createCollaborationDemoPort([failed])).props
    render(<CollaborationRoot {...value} />)

    expect(screen.getByRole('alert').textContent).toContain(zh['formation.failed.title'])
    expect(screen.getByRole('alert').textContent).toContain(zh['formation.failed.mainEntry'])
    expect(screen.queryByRole('button', { name: zh.new })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['actions.retry'] })).toBeNull()
  })

  it('keeps Chinese formation failures free of raw English runtime messages', () => {
    const failed = createDemoRuns().find(run => run.status === 'team_formation_failed')!
    const run = { ...failed, failure: { ...failed.failure!, message: 'The expert team could not be formed at full strength.' } }
    const value = makeProps('localized-failure', createCollaborationDemoPort([run])).props
    render(<CollaborationRoot {...value} />)

    expect(screen.getByRole('alert').textContent).toContain(zh['formation.failed.body'])
    expect(screen.getByRole('alert').textContent).not.toContain('could not be formed')
  })

  it('directs an empty panel to the independent collaboration entry and starts background discovery', () => {
    const snapshot: CollaborationCatalogSnapshot = { state: 'ready', runs: [] }
    const port: CollaborationPort = {
      source: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      createRun: vi.fn(), confirmRun: vi.fn(), retryFormation: vi.fn(), terminate: vi.fn(),
    }
    const value = makeProps('empty', port).props
    render(<CollaborationRoot {...value} />)

    expect(screen.getByText(zh['empty.body'])).toBeTruthy()
    expect(screen.getByText(zh['empty.hint'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.new })).toBeNull()
    expect(value.refreshCollaboration).toHaveBeenCalledOnce()
  })

  it('does not restart polling when an injected refresh callback changes identity', async () => {
    vi.useFakeTimers()
    const value = makeProps('stable-polling').props
    const runId = [...createDemoRuns()].sort((left, right) => right.createdAt - left.createdAt)
      .find(run => run.status !== 'cancelled')!.id
    const view = render(<CollaborationRoot {...value} />)
    expect(value.refreshCollaboration).toHaveBeenCalledOnce()
    expect(value.refreshCollaboration).toHaveBeenLastCalledWith(runId)

    const replacement = vi.fn(async () => undefined)
    view.rerender(<CollaborationRoot {...value} refreshCollaboration={replacement} />)
    expect(replacement).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(replacement).toHaveBeenCalledOnce()
    expect(replacement).toHaveBeenLastCalledWith(runId)
  })

  it('automatically follows a newer run created through the independent workspace', async () => {
    const previous = createDemoRuns().find(run => run.status === 'completed')!
    const port = createCollaborationDemoPort([previous])
    const value = makeProps('latest-run', port).props
    const view = render(<CollaborationRoot {...value} />)
    expect(view.container.querySelector('[data-collaboration-dock] > header [aria-live="polite"]')?.textContent).toBe(zh['status.completed'])

    await act(async () => {
      await port.createRun({
        title: '独立协作新任务',
        objective: '验证面板自动同步最新任务',
        language: 'zh',
      })
    })

    const latest = port.source.getSnapshot().runs[0]!
    expect(view.container.querySelector('[data-collaboration-dock] > header [aria-live="polite"]')?.textContent).toBe(zh[`status.${latest.status}`])
    expect(screen.queryByText('独立协作新任务')).toBeNull()
  })

  it('shows recovery and collapses on Escape', () => {
    const loading: CollaborationCatalogSnapshot = { state: 'loading', runs: [] }
    const loadingPort: CollaborationPort = {
      source: { getSnapshot: () => loading, subscribe: () => () => {} },
      createRun: vi.fn(), confirmRun: vi.fn(), retryFormation: vi.fn(), terminate: vi.fn(),
    }
    const first = makeProps('loading', loadingPort)
    const view = render(<CollaborationRoot {...first.props} />)
    expect(screen.getByText(zh['restore.loading'])).toBeTruthy()
    view.unmount()

    const second = makeProps('stale-selection')
    render(<CollaborationRoot {...second.props} />)
    expect(screen.queryByText(zh['restore.loading'])).toBeNull()
    expect(screen.getByRole('tab', { name: zh['tabs.timeline'] }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(second.props.closeCollaboration).toHaveBeenCalledOnce()
  })
})
