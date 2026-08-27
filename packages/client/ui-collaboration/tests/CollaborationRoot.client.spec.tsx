// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CollaborationRoot } from '../src/client/CollaborationRoot.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { createCollaborationStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { CollaborationCatalogSnapshot, CollaborationPort } from '../src/client/types.ts'
import type {} from '../src/client/index.ts'

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
      useSessions: vi.fn(),
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
      closeCollaboration: vi.fn(),
      t,
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('CollaborationRoot', () => {
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
    expect(screen.getByText('结构化研究')).toBeTruthy()
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
    expect(view.container.textContent).not.toContain('private chain of thought')
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
      createRun: vi.fn(), retryFormation: vi.fn(), terminate: vi.fn(),
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
    const view = render(<CollaborationRoot {...value} />)
    expect(value.refreshCollaboration).toHaveBeenCalledOnce()

    const replacement = vi.fn(async () => undefined)
    view.rerender(<CollaborationRoot {...value} refreshCollaboration={replacement} />)
    expect(replacement).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('automatically follows a newer run created through the independent workspace', async () => {
    const previous = createDemoRuns().find(run => run.status === 'completed')!
    const port = createCollaborationDemoPort([previous])
    const value = makeProps('latest-run', port).props
    render(<CollaborationRoot {...value} />)
    expect(screen.getByRole('heading', { name: previous.title })).toBeTruthy()

    await act(async () => {
      await port.createRun({
        title: '独立协作新任务',
        objective: '验证面板自动同步最新任务',
        language: 'zh',
      })
    })

    expect(screen.getByRole('heading', { name: '独立协作新任务' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: previous.title })).toBeNull()
  })

  it('shows recovery and collapses on Escape', () => {
    const loading: CollaborationCatalogSnapshot = { state: 'loading', runs: [] }
    const loadingPort: CollaborationPort = {
      source: { getSnapshot: () => loading, subscribe: () => () => {} },
      createRun: vi.fn(), retryFormation: vi.fn(), terminate: vi.fn(),
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
