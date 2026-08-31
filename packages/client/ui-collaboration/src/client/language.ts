import { en, zh } from './locales.ts'
import type { CollaborationLanguage } from './types.ts'

const CJK = /[\u3400-\u9fff]/gu
const LATIN_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

/**
 * Read collaboration copy in the task instruction language.
 *
 * @param language - Language selected for the current collaboration task.
 * @param key - Locale dictionary key to resolve.
 * @param params - Optional named interpolation values.
 * @returns Localized collaboration copy with interpolation applied.
 */
export function collaborationCopy(
  language: CollaborationLanguage,
  key: keyof typeof zh,
  params?: Record<string, unknown>,
): string {
  let value = (language === 'zh' ? zh : en)[key]
  if (params === undefined) return value
  for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

/**
 * Detect the dominant instruction language used by one task or message.
 *
 * @param text - Task or message text to classify.
 * @returns The supported language that dominates the supplied text.
 */
export function detectCollaborationLanguage(text: string): CollaborationLanguage {
  const cjkCount = text.match(CJK)?.length ?? 0
  const latinWords = text.match(LATIN_WORD)?.length ?? 0
  return cjkCount > 0 && cjkCount >= latinWords ? 'zh' : 'en'
}

/**
 * Test whether displayable prose uses the task's dominant language.
 *
 * @param text - Public prose to validate.
 * @param language - Language required by the collaboration task.
 * @returns Whether empty or displayable prose matches the required language.
 */
export function matchesCollaborationLanguage(text: string, language: CollaborationLanguage): boolean {
  if (text.trim() === '') return true
  return detectCollaborationLanguage(text) === language
}
