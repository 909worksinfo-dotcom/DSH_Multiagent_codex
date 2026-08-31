import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns, computeFrameColumns,
  COLLABORATION_CENTER_MIN, COLLABORATION_DEFAULT, COLLABORATION_MAX, COLLABORATION_MIN,
  DETAILS_DEFAULT, DETAILS_MIN, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250; details concedes to 1250-280-640 = 330.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 330 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210 → details 0; sidebar untouched: center = 1210-280 = 930.
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 930, details: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640: sidebar keeps 280, center takes 420 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), open(DETAILS_DEFAULT))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches step 3's auto-close with the compact rail sidebar.
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0 })
  })
})

describe('computeFrameColumns', () => {
  it('allows the collaboration dock to expand to twice its default width', () => {
    expect(COLLABORATION_MAX).toBe(COLLABORATION_DEFAULT * 2)
    const viewport = SIDEBAR_DEFAULT + COLLABORATION_CENTER_MIN + COLLABORATION_MAX
    expect(computeFrameColumns(viewport, SIDEBAR_DEFAULT, 0, 99_999)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: COLLABORATION_CENTER_MIN,
      details: 0,
      collaboration: COLLABORATION_MAX,
    })
  })

  it('keeps the collaboration dock beside the conversation instead of overlaying it', () => {
    expect(computeFrameColumns(1440, SIDEBAR_DEFAULT, DETAILS_DEFAULT, COLLABORATION_DEFAULT)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 1440 - SIDEBAR_DEFAULT - COLLABORATION_DEFAULT,
      details: 0,
      collaboration: COLLABORATION_DEFAULT,
    })
  })

  it('shrinks the dock before compromising the conversation floor', () => {
    const viewport = SIDEBAR_DEFAULT + COLLABORATION_CENTER_MIN + COLLABORATION_DEFAULT - 40
    expect(computeFrameColumns(viewport, SIDEBAR_DEFAULT, 0, COLLABORATION_DEFAULT)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: COLLABORATION_CENTER_MIN,
      details: 0,
      collaboration: COLLABORATION_DEFAULT - 40,
    })
  })

  it('supports the compact 639px frame with both conversation and dock visible', () => {
    expect(computeFrameColumns(639, 0, 0, COLLABORATION_DEFAULT)).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: COLLABORATION_CENTER_MIN,
      details: 0,
      collaboration: 639 - SIDEBAR_COLLAPSED - COLLABORATION_CENTER_MIN,
    })
  })

  it('derives the dock closed when even its minimum cannot fit', () => {
    const viewport = SIDEBAR_COLLAPSED + COLLABORATION_CENTER_MIN + COLLABORATION_MIN - 1
    expect(computeFrameColumns(viewport, 0, 0, COLLABORATION_DEFAULT)).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: viewport - SIDEBAR_COLLAPSED,
      details: 0,
      collaboration: 0,
    })
  })
})
