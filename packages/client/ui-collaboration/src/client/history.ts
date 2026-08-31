import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import { matchesCollaborationLanguage } from './language.ts'
import type { CollaborationAgentDetail, CollaborationAgentDialogue, CollaborationLanguage } from './types.ts'

const MAX_WORK_CHARS = 8_000
const MAX_DIALOGUE_ITEMS = 8
const MAX_DIALOGUE_CHARS = 1_200

function blocksText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n').trim()
}

function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`
}

function duplicateKey(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().slice(0, 500)
}

/**
 * Project raw child history into final work and a small set of key exchanges.
 *
 * @param entries - Durable child-session events in ascending sequence order.
 * @param name - Display name used for assistant-authored dialogue.
 * @param language - Task language accepted by the public projection.
 * @returns Bounded public work and dialogue without reasoning blocks.
 */
export function conciseAgentHistory(
  entries: readonly HistoryEntry[],
  name: string,
  language: CollaborationLanguage,
): CollaborationAgentDetail {
  const messages: CollaborationAgentDialogue[] = []
  let omittedCount = 0
  let languageMismatch = false
  let work = ''
  const seen = new Set<string>()

  for (const entry of entries) {
    const event = entry.event
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const content = event.type === 'user/message'
      ? blocksText(event.data.content)
      : blocksText(event.data.message.content)
    if (content === '') { omittedCount++; continue }
    if (!matchesCollaborationLanguage(content, language)) { omittedCount++; languageMismatch = true; continue }
    const key = duplicateKey(content)
    if (seen.has(key)) { omittedCount++; continue }
    seen.add(key)
    if (event.type === 'assistant/message') work = clipped(content, MAX_WORK_CHARS)
    messages.push({
      id: `${event.type === 'user/message' ? 'user' : 'assistant'}-${event.seq}`,
      speaker: event.type === 'user/message' ? (language === 'zh' ? '协调消息' : 'Coordinator') : name,
      content: clipped(content, MAX_DIALOGUE_CHARS),
      time: event.time,
    })
  }

  if (messages.length > MAX_DIALOGUE_ITEMS) omittedCount += messages.length - MAX_DIALOGUE_ITEMS
  return {
    work,
    dialogue: messages.slice(-MAX_DIALOGUE_ITEMS),
    omittedCount,
    languageMismatch,
  }
}
