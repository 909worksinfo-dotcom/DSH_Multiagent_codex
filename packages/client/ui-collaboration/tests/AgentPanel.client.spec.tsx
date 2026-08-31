// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentPanelProps } from '../src/client/contract.ts'
import { AgentPanel } from '../src/client/AgentPanel.tsx'
import { createAgentPanelStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

function props(language: 'zh' | 'en' = 'zh'): AgentPanelProps {
  const parent = 'parent' as SessionId
  const child = 'child' as SessionId
  const sessions: SessionListState = {
    ids: [parent, child],
    current: parent,
    phase: 'ready',
    byId: {
      [parent]: {
        id: parent,
        displayTitle: language === 'zh' ? '协作：出海策略' : 'Collaboration: launch strategy',
        running: false,
        blank: false,
        updatedAt: 1,
      },
      [child]: {
        id: child,
        displayTitle: language === 'zh' ? '市场进入智能体' : 'Market entry agent',
        running: false,
        blank: false,
        updatedAt: 1,
      },
    },
    subagentsByParent: {
      [parent]: {
        state: 'ready', error: null, parentAvailable: true,
        entries: [{
          kind: 'child',
          id: child,
          mode: 'one-shot',
          label: language === 'zh' ? '市场进入智能体' : 'Market entry agent',
          activity: 'inactive',
          hasChildren: false,
        }],
      },
    },
    jobsBySession: {},
    currentAddress: undefined,
  }
  const store = createAgentPanelStore().create(`panel-${language}`)
  const useSessions: AgentPanelProps['useSessions'] = select => select(sessions)
  const dictionary = language === 'zh' ? zh : en
  const t: TranslateNS<'collaboration'> = key => key in dictionary
    ? dictionary[key as keyof typeof dictionary]
    : key
  return {
    useSessions,
    useWorkspaces: vi.fn() as AgentPanelProps['useWorkspaces'],
    useStore: <S,>(select: (state: ReturnType<typeof store.getSnapshot>) => S) => select(store.getSnapshot()),
    actions: store.actions,
    refreshAgents: vi.fn(),
    readSessionLanguage: vi.fn().mockReturnValue(language),
    loadAgentDetail: vi.fn().mockResolvedValue({
      work: language === 'zh' ? '完成目标市场排序与进入路径建议。' : 'Completed market prioritization and entry recommendations.',
      dialogue: [{ id: 'm1', speaker: language === 'zh' ? '市场进入智能体' : 'Market entry agent', content: language === 'zh' ? '建议优先进入东南亚市场。' : 'Prioritize Southeast Asia.', time: 1 }],
      omittedCount: 12,
      languageMismatch: false,
    }),
    t,
  }
}

describe('AgentPanel', () => {
  it('shows concise agent work and key dialogue in Chinese', async () => {
    const value = props()
    render(<AgentPanel {...value} />)

    expect(screen.getByRole('separator', { name: zh['agents.resize'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '市场进入智能体' }))

    await waitFor(() => { expect(screen.getByText('完成目标市场排序与进入路径建议。')).toBeTruthy() })
    expect(screen.getByText('已隐藏 12 条重复内容或执行过程。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['agent.dialogue'] }))
    expect(screen.getByText('建议优先进入东南亚市场。')).toBeTruthy()
  })

  it('uses English UI for an English collaboration session', () => {
    render(<AgentPanel {...props('en')} />)
    expect(screen.getByRole('complementary', { name: en['agents.panel'] })).toBeTruthy()
    expect(screen.getByText(en['agents.title'])).toBeTruthy()
    expect(screen.getByRole('separator', { name: en['agents.resize'] })).toBeTruthy()
  })
})
