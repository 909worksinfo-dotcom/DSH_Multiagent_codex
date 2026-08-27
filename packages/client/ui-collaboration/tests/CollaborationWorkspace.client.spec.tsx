// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CollaborationWorkspace } from '../src/client/CollaborationWorkspace.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { en, zh } from '../src/client/locales.ts'
import type { CollaborationCatalogSnapshot, CollaborationPort, CollaborationRunId } from '../src/client/types.ts'
import type {} from '../src/client/index.ts'

function makeProps(options: {
  readonly port?: CollaborationPort
  readonly dictionary?: typeof zh | typeof en
  readonly start?: (request: Parameters<CollaborationPort['createRun']>[0]) => Promise<CollaborationRunId>
} = {}) {
  const port = options.port ?? createCollaborationDemoPort([])
  const dictionary = options.dictionary ?? zh
  const t: TranslateNS<'collaboration'> = key => dictionary[key as keyof typeof zh]
  const startCollaboration = vi.fn(options.start ?? (async request => port.createRun(request)))
  return {
    port,
    startCollaboration,
    props: {
      useSessions: vi.fn(),
      useWorkspaces: vi.fn(),
      useCollaboration: <S,>(select: (state: CollaborationCatalogSnapshot) => S): S => useSyncExternalStore(
        listener => port.source.subscribe(listener),
        () => select(port.source.getSnapshot()),
      ),
      startCollaboration,
      refreshCollaboration: vi.fn(async () => undefined),
      prepareNewCollaboration: vi.fn(),
      leaveCollaboration: vi.fn(),
      t,
    },
  }
}

afterEach(() => { cleanup() })

describe('CollaborationWorkspace', () => {
  it('starts a TeamRun in the Chinese system language and shows a user-to-Lead conversation', async () => {
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
    expect(await screen.findByText(zh['workspace.active.title'])).toBeTruthy()
    expect(document.querySelector('[data-collaboration-center-author="user"]')?.textContent).toContain('评审这个 Demo')
    expect(document.querySelector('[data-collaboration-center-author="lead"]')?.textContent).toContain(zh['workspace.plan.title'])
    expect(screen.queryByRole('heading', { name: zh['workspace.title'] })).toBeNull()
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
    fireEvent.change(screen.getByLabelText(en['workspace.objective']), { target: { value: completed.objective } })
    fireEvent.click(screen.getByRole('button', { name: en['workspace.start'] }))

    expect(await screen.findByText(zh['workspace.active.title'])).toBeTruthy()
    expect(screen.queryByText(en['workspace.active.title'])).toBeNull()
  })

  it('shows the task ledger and Lead updates only, with completed tasks struck through', async () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!
    const port = createCollaborationDemoPort([completed])
    const value = makeProps({ port, start: async () => completed.id })
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: completed.objective } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))

    await screen.findByText(zh['workspace.delivery.title'])
    expect(document.querySelectorAll('[data-collaboration-center-task]')).toHaveLength(4)
    expect(document.querySelectorAll('[data-collaboration-center-task] del')).toHaveLength(4)
    expect(document.querySelectorAll('[data-center-lead-event]')).toHaveLength(2)
    expect(screen.getByText('裁决采用统一指标，并保留反方意见作为验收资产')).toBeTruthy()
    expect(screen.queryByText('建议首批聚焦调研分析、产品方案与软件开发三个通用领域')).toBeNull()
  })

  it('returns to a clean launcher without mixing into daily chat', async () => {
    const value = makeProps()
    render(<CollaborationWorkspace {...value.props} />)
    fireEvent.change(screen.getByLabelText(zh['workspace.objective']), { target: { value: '分析用户需求' } })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.start'] }))
    await screen.findByText(zh['workspace.active.title'])

    fireEvent.click(screen.getByRole('button', { name: zh['workspace.new'] }))
    expect(value.props.prepareNewCollaboration).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: zh['workspace.title'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.daily'] }))
    expect(value.props.leaveCollaboration).toHaveBeenCalledOnce()
  })
})
