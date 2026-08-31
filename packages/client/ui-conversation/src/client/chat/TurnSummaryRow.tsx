import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './TurnSummaryRow.module.css'

/**
 * Compact turn-summary row: shows the tool calls made in a completed turn
 * as a single muted line, e.g. "Read × 3  Edit × 2  Bash × 1".
 */
export function TurnSummaryRow({ node, t }: ChatNodeViewProps<'turn-summary'>) {
  const { data } = node
  if (data.calls.length === 0) return null
  return (
    <div className={css.row}>
      <span className={css.label}>{t('turnSummary.label')}</span>
      {data.calls.map(entry => (
        <span key={entry.name} className={css.chip}>
          {entry.label}
          {entry.count > 1 && <span className={css.count}> × {entry.count}</span>}
        </span>
      ))}
    </div>
  )
}
