import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallCount, TurnSummaryChatData } from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'
import { isSummarizedToolActivity } from './tool-activity.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Compact tool-call summary for one completed turn. */
    'turn-summary': TurnSummaryChatData
  }
}

interface TurnSummaryState {
  readonly turn: number
  readonly counts: ReadonlyMap<string, number>
  readonly endSeq?: number
}

/** Stable tool names grouped under concise user-facing labels. */
const LABEL_OF: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  skill: 'Skill',
  web_search: 'Search',
  web_fetch: 'Fetch',
  grep: 'Search',
  glob: 'Find',
  create_goal: 'Goal',
  task: 'Task',
  subagent: 'Subagent',
  ask_user_question: 'Question',
}

function sortedCounts(counts: ReadonlyMap<string, number>): readonly ToolCallCount[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, label: LABEL_OF[name] ?? name, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function summaryAnchor(context: ConversationNodeContext<TurnSummaryState>, endSeq: number): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return endSeq - 0.1
  const closing = location.turn.data.get('turn-tail')?.closing
  return closing === null || closing === undefined
    ? endSeq - 0.1
    : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.turnSummary
}

/** Aggregate routine file and search calls into one row after the turn closes. */
export const turnSummaryDefinition: ConversationNodeDefinition<TurnSummaryState> = {
  kind: 'turn-summary',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'turn/end') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-summary start requires turn/start')
    return { turn: match.event.data.turn, counts: new Map() }
  },
  update: (context, match) => {
    if (match.event.type === 'turn/end') return { ...context.state, endSeq: match.event.seq }
    if (match.event.type !== 'tool/call' || !isSummarizedToolActivity(match.event.data.name)) return context.state
    const counts = new Map(context.state.counts)
    counts.set(match.event.data.name, (counts.get(match.event.data.name) ?? 0) + 1)
    return { ...context.state, counts }
  },
  publication: match => match.event.type === 'turn/end' ? 'immediate' : 'none',
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || state.endSeq === undefined) return null
    const calls = sortedCounts(state.counts)
    if (calls.length === 0) return null
    return chatNode(
      context,
      'turn-summary',
      summaryAnchor(context, state.endSeq),
      { turn: state.turn, calls },
      { flow: 'activity' },
    )
  },
}

/**
 * Register the completed-turn tool summary.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnSummaryConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(turnSummaryDefinition)
}
