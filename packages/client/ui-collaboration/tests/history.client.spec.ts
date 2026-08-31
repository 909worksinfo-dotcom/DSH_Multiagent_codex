import { describe, expect, it } from 'vitest'
import type { HistoryEntry, MessageId, SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import { conciseAgentHistory } from '../src/client/history.ts'

const messageId = (id: string): MessageId => id as MessageId

function event(
  value: SessionEvent<'user/message'> | SessionEvent<'assistant/message'>,
): HistoryEntry {
  return { event: value }
}

describe('conciseAgentHistory', () => {
  it('keeps latest final work and bounded key dialogue while hiding reasoning and other-language prose', () => {
    const entries: HistoryEntry[] = [
      event({
        type: 'user/message', seq: 1, time: 1,
        data: {
          id: messageId('user-1'), role: 'user',
          content: [{ type: 'text', text: '请评估目标市场。' }], source: { kind: 'user' },
        },
      }),
      event({
        type: 'assistant/message', seq: 2, time: 2,
        data: {
          turn: 1, step: 1,
          message: {
            id: messageId('assistant-2'), role: 'assistant',
            content: [{ type: 'reasoning', text: '内部推理过程' }, { type: 'text', text: '第一版建议。' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      }),
      event({
        type: 'assistant/message', seq: 3, time: 3,
        data: {
          turn: 1, step: 2,
          message: {
            id: messageId('assistant-3'), role: 'assistant',
            content: [{ type: 'text', text: 'Final answer in English.' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      }),
      event({
        type: 'assistant/message', seq: 4, time: 4,
        data: {
          turn: 1, step: 3,
          message: {
            id: messageId('assistant-4'), role: 'assistant',
            content: [{ type: 'text', text: '最终建议：优先进入东南亚市场。' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      }),
    ]

    const result = conciseAgentHistory(entries, '市场智能体', 'zh')
    expect(result.work).toBe('最终建议：优先进入东南亚市场。')
    expect(result.dialogue.map(item => item.content)).toEqual(['请评估目标市场。', '第一版建议。', '最终建议：优先进入东南亚市场。'])
    expect(result.dialogue.some(item => item.content.includes('内部推理'))).toBe(false)
    expect(result.languageMismatch).toBe(true)
    expect(result.omittedCount).toBe(1)
  })
})
