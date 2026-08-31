import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ActivityFlow.module.css'

const FOLLOW_THRESHOLD = 2

/** Bounded transcript region for contiguous low-priority process rows. */
export function ActivityFlow({ children, count, t }: {
  children: ReactNode
  count: number
  t: ChatViewSlotProps['t']
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followsEndRef = useRef(true)

  const followEnd = (): void => {
    const viewport = viewportRef.current
    if (viewport !== null && followsEndRef.current) viewport.scrollTop = viewport.scrollHeight
  }

  useLayoutEffect(() => {
    followEnd()
  }, [count])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (content === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(followEnd)
    observer.observe(content)
    return () => { observer.disconnect() }
  }, [])

  return (
    <div
      ref={viewportRef}
      className={css.viewport}
      data-chat-activity-flow=""
      data-chat-activity-count={count}
      role="region"
      aria-label={t('activity.label')}
      tabIndex={0}
      onScroll={(event) => {
        const viewport = event.currentTarget
        followsEndRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_THRESHOLD
      }}
    >
      <div ref={contentRef} className={css.content}>{children}</div>
    </div>
  )
}
