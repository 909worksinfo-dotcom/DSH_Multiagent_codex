// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CollaborationRoot } from '../src/client/CollaborationRoot.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { createCollaborationStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import type { CollaborationRunSnapshot } from '../src/client/types.ts'
import type {} from '../src/client/index.ts'

function open(run: CollaborationRunSnapshot): HTMLElement {
  const port = createCollaborationDemoPort([run])
  const instance = createCollaborationStore().create(`p6-${run.id}`)
  const t: TranslateNS<'collaboration'> = key => key in zh ? zh[key as keyof typeof zh] : key
  const view = render(<CollaborationRoot
    open
    width={440}
    useSessions={vi.fn()}
    useWorkspaces={vi.fn()}
    useStore={select => useSyncExternalStore(
      listener => instance.subscribe(listener),
      () => select(instance.getSnapshot()),
    )}
    actions={instance.actions}
    useCollaboration={select => useSyncExternalStore(
      listener => port.source.subscribe(listener),
      () => select(port.source.getSnapshot()),
    )}
    refreshCollaboration={vi.fn(async () => undefined)}
    closeCollaboration={vi.fn()}
    t={t}
  />)
  return view.container
}

afterEach(cleanup)

describe('P6 authoritative collaboration protocol', () => {
  it('renders enforced topology, capability, budget, and challenge state from run.protocol only', () => {
    const base = createDemoRuns().find(run => run.status === 'running')!
    const run = {
      ...base,
      timeline: base.timeline.map(event => ({ ...event, content: 'TIMELINE-DECOY-PROTOCOL' })),
      protocol: {
        mode: 'enforced',
        topology: 'grouped',
        limits: { maxChallengeRounds: 3, maxMessagesPerExpert: 12 },
        members: [{
          slotId: 'slot-reviewer', memberId: 'expert-attempt-8', phase: 'active',
          name: '反方评审专家',
          permissions: { challenge: true, review: true, requestHelp: false },
          allowedTargets: ['产品策略专家'],
          usedMessages: 11,
          remainingMessages: 1,
        }],
        challenges: [{
          challengeId: 'challenge-authoritative', threadId: 'thread-authoritative', round: 3,
          challenger: '反方评审专家', target: '产品策略专家', status: 'responded',
          challengeMessageId: 'message-challenge', responseMessageId: 'message-response',
        }],
      },
    } as unknown as CollaborationRunSnapshot

    const container = open(run)
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))

    expect(screen.getAllByText('分组协作').length).toBeGreaterThan(0)
    expect(screen.getByText('专家按组协作，质疑、评审与求助只能发往协议允许的目标')).toBeTruthy()
    expect(screen.getAllByText('11 / 12').length).toBeGreaterThan(0)
    expect(screen.getByText('接近耗尽')).toBeTruthy()
    expect(screen.getByText('challenge-authoritative')).toBeTruthy()
    expect(screen.getByText('message-response')).toBeTruthy()
    expect(screen.getByText('已回应')).toBeTruthy()
    expect(screen.getByText('已达轮次上限，运行时将拒绝继续追问')).toBeTruthy()
    expect(container.textContent).not.toContain('TIMELINE-DECOY-PROTOCOL')
  })

  it('shows controlled legacy and missing states without borrowing charter rules', () => {
    const legacy = createDemoRuns().find(run => run.status === 'forming')!
    const container = open({
      ...legacy,
      charter: legacy.charter === null ? null : { ...legacy.charter, communicationRules: ['CHARTER-DECOY-RULE'] },
    })
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))
    expect(screen.getByText('历史任务未启用强制协议')).toBeTruthy()
    expect(container.textContent).not.toContain('CHARTER-DECOY-RULE')
  })

  it('does not fabricate a protocol for snapshots that omit it', () => {
    const base = createDemoRuns().find(run => run.status === 'forming')!
    const { protocol: _protocol, ...withoutProtocol } = base
    open(withoutProtocol)
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))
    expect(screen.getByText('尚无可用的协议投影')).toBeTruthy()
    expect(screen.getByText(/P6 协作协议/)).toBeTruthy()
  })

  it('renders eight expert slots with normal, near-limit, and exhausted budgets', () => {
    const run = createDemoRuns().find(candidate => candidate.status === 'running')!
    const container = open(run)
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))

    expect(container.querySelectorAll('[data-budget-state]')).toHaveLength(8)
    expect(container.querySelectorAll('[data-budget-state="normal"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-budget-state="warning"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-budget-state="exhausted"]')).toHaveLength(1)
    expect(screen.getByText('slot-8')).toBeTruthy()
    expect(screen.getAllByText('质疑').length).toBeGreaterThan(0)
    expect(screen.getAllByText('评审').length).toBeGreaterThan(0)
    expect(screen.getAllByText('求助').length).toBeGreaterThan(0)
    expect(screen.getByText('slot-8').closest('[data-budget-state]')?.textContent).toContain('安全评审专家')
    expect(container.querySelectorAll('[data-challenge-status="open"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-challenge-status="responded"]')).toHaveLength(1)
  })

  it('keeps one long expert identity readable and renders enforced empty collections honestly', () => {
    const base = createDemoRuns().find(candidate => candidate.status === 'running')!
    const protocol = base.protocol!
    const longName = '负责跨地域数据证据、反方评审与异常边界验证的超长名称专家'
    const run: CollaborationRunSnapshot = {
      ...base,
      protocol: {
        ...protocol,
        members: [{ ...protocol.members[0]!, name: longName, allowedTargets: [] }],
        challenges: [],
      },
    }
    const container = open(run)
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))

    expect(container.querySelectorAll('[data-budget-state]')).toHaveLength(1)
    expect(screen.getByText(longName).getAttribute('title')).toBe(longName)
    expect(screen.getByText('无允许目标')).toBeTruthy()
    expect(screen.getByText('尚无质疑线程')).toBeTruthy()
  })

  it('raises explicit warnings for inconsistent counters and over-limit challenge rounds', () => {
    const base = createDemoRuns().find(candidate => candidate.status === 'running')!
    const protocol = base.protocol!
    const run: CollaborationRunSnapshot = {
      ...base,
      protocol: {
        ...protocol,
        members: [{ ...protocol.members[0]!, usedMessages: 13, remainingMessages: -1 }],
        challenges: [{ ...protocol.challenges[0]!, round: 4 }],
      },
    }
    const container = open(run)
    fireEvent.click(screen.getByRole('tab', { name: '协作协议' }))

    expect(container.querySelector('[data-budget-state="violation"]')).toBeTruthy()
    expect(container.querySelector('[data-protocol-violation="true"]')).toBeTruthy()
    expect(screen.getByText('专家计数与运行时上限不一致')).toBeTruthy()
    expect(screen.getByText('质疑轮次超出运行时上限')).toBeTruthy()
    expect(screen.getByText('协议投影存在缺失或总量越界，请由主协调智能体处理')).toBeTruthy()
  })

  it('localizes English protocol copy and keeps the new tab keyboard-operable', () => {
    const base = createDemoRuns().find(candidate => candidate.status === 'running')!
    const protocol = base.protocol!
    const run: CollaborationRunSnapshot = {
      ...base,
      language: 'en',
      title: 'Long multi-agent protocol verification task name that remains readable',
      objective: 'Verify enforced routes, budgets, and challenge rounds',
      experts: base.experts.map((expert, index) => ({
        ...expert,
        name: `expert-${index + 1}`,
        role: `Research specialist ${index + 1}`,
      })),
      protocol: {
        ...protocol,
        members: protocol.members.map((member, index) => ({
          ...member,
          name: `expert-${index + 1}`,
          allowedTargets: member.allowedTargets.map((_target, targetIndex) => `Peer ${targetIndex + 1}`),
        })),
        challenges: protocol.challenges.map((challenge, index) => ({
          ...challenge, challenger: `Reviewer ${index + 1}`, target: `Producer ${index + 1}`,
        })),
      },
    }
    open(run)
    const roster = screen.getByRole('tab', { name: 'Expert team' })
    fireEvent.click(roster)
    roster.focus()
    fireEvent.keyDown(roster, { key: 'ArrowRight' })

    const protocolTab = screen.getByRole('tab', { name: 'Collaboration protocol' })
    expect(protocolTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(protocolTab)
    expect(screen.getByText('Runtime enforced')).toBeTruthy()
    expect(screen.getAllByText('Responded').length).toBeGreaterThan(0)
    expect(screen.getByText('Research specialist 8')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/expert-\d+/iu)
  })
})
