import { describe, expect, it } from 'vitest'
import {
  collaborationDisplayText, collaborationEventContent, collaborationParticipantName,
  collaborationRunEventContent,
} from '../src/client/presentation.ts'
import type { CollaborationRunSnapshot, CollaborationTimelineEvent } from '../src/client/types.ts'

function event(kind: CollaborationTimelineEvent['kind'], content: string): CollaborationTimelineEvent {
  return {
    id: 'message-1', eventId: 'event-1', cursor: 1, threadId: 'main', kind,
    author: { role: 'lead', sessionId: 'lead', name: 'lead' }, targets: [], references: {},
    content, createdAt: 1, visibility: 'public',
  }
}

describe('collaboration presentation language', () => {
  it('localizes deterministic runtime receipts and built-in metadata in Chinese', () => {
    expect(collaborationEventContent(
      event('artifact', 'Artifact "方案" is review at version 1.'),
      'zh',
    )).toBe('资产“方案”已更新为评审中，当前为版本 1')
    expect(collaborationEventContent(
      event('review', 'Quality gate "Every proposal maps to a user problem" passed: 覆盖完整'),
      'zh',
    )).toBe('质量门禁“每项方案均对应具体用户问题”已通过：覆盖完整')
    expect(collaborationDisplayText('Product Strategist', 'zh')).toBe('产品策略专家')
    expect(collaborationDisplayText('collaboration-research-analysis', 'zh')).toBe('深度研究与证据分析')
    expect(collaborationDisplayText('collaboration-peer-review', 'zh')).toBe('协作质疑与同行评审')
    expect(collaborationParticipantName('lead', 'lead', 'zh')).toBe('主协调智能体')
    expect(collaborationParticipantName('expert-3', 'expert', 'zh', 'Market Analyst')).toBe('市场分析专家')
    expect(collaborationParticipantName('expert-3', 'expert', 'zh')).toBe('协作专家')
  })

  it('does not rewrite agent-authored prose or English-system metadata', () => {
    expect(collaborationEventContent(event('proposal', 'Artifact "quoted by an agent"'), 'zh'))
      .toBe('Artifact "quoted by an agent"')
    expect(collaborationDisplayText('Product Strategist', 'en')).toBe('Product Strategist')
    expect(collaborationDisplayText('collaboration-research-analysis', 'en')).toBe('Deep research and evidence analysis')
    expect(collaborationDisplayText('collaboration-peer-review', 'en')).toBe('Collaborative challenge and peer review')
    expect(collaborationParticipantName('expert-3', 'expert', 'en', 'Market Analyst')).toBe('Market Analyst')
  })

  it('projects leaked stable participant identifiers as assigned names', () => {
    const run = {
      language: 'zh',
      lead: { name: 'lead' },
      experts: [{ name: 'expert-1', role: 'Market Analyst' }],
    } as unknown as CollaborationRunSnapshot
    const leaked = {
      ...event('challenge', 'expert-1 请 lead 复核专家1的估值假设'),
      author: { role: 'expert', memberId: 'member-1', sessionId: 'session-1', name: 'expert-1' },
    } as CollaborationTimelineEvent

    expect(collaborationRunEventContent(leaked, run)).toBe('市场分析专家 请 主协调智能体 复核市场分析专家的估值假设')
  })
})
