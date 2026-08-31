/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), and center absorbs any remaining
 * deficit as the last resort. Inputs are the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

/** Resolved four-column frame widths, including the collaboration dock. */
export interface FrameColumns extends Columns { collaboration: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

/** Collaboration dock drag clamp floor. */
export const COLLABORATION_MIN = 320
/** Collaboration dock drag clamp ceiling. */
export const COLLABORATION_MAX = 880
/** Collaboration dock width before any user drag. */
export const COLLABORATION_DEFAULT = 440
/**
 * Conversation floor while the collaboration dock is visible. The dock is
 * deliberately allowed beside a compact conversation on narrow desktop
 * windows; unlike an overlay, both surfaces remain visible and operable.
 */
export const COLLABORATION_CENTER_MIN = 240

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1 }

  // Step 3: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}

/**
 * Resolve the shell's mutually exclusive right-side columns. Collaboration
 * owns the right edge when requested; otherwise the existing details solver
 * remains byte-for-byte authoritative. A narrow viewport first shrinks the
 * dock, then derives it closed without rewriting the stored preference.
 */
export function computeFrameColumns(
  viewport: number,
  sidebar: number,
  details: number,
  collaboration: number,
): FrameColumns {
  if (collaboration === 0) return { ...computeColumns(viewport, sidebar, details), collaboration: 0 }

  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const c0 = clampWidth(collaboration, COLLABORATION_MIN, COLLABORATION_MAX)
  if (s + c0 + COLLABORATION_CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - c0, details: 0, collaboration: c0 }
  }

  const c1 = Math.max(COLLABORATION_MIN, viewport - s - COLLABORATION_CENTER_MIN)
  if (s + c1 + COLLABORATION_CENTER_MIN <= viewport) {
    return { sidebar: s, center: COLLABORATION_CENTER_MIN, details: 0, collaboration: c1 }
  }

  return { sidebar: s, center: Math.max(0, viewport - s), details: 0, collaboration: 0 }
}
