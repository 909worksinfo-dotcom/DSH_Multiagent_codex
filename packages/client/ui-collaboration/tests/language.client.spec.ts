import { describe, expect, it } from 'vitest'
import { collaborationCopy, detectCollaborationLanguage, matchesCollaborationLanguage } from '../src/client/language.ts'

describe('collaboration language', () => {
  it('detects Chinese and English task instructions and selects matching UI copy', () => {
    expect(detectCollaborationLanguage('请评审这个产品发布方案')).toBe('zh')
    expect(detectCollaborationLanguage('Review this product launch plan and identify risks.')).toBe('en')
    expect(collaborationCopy('en', 'agent.work')).toBe('Final work')
    expect(collaborationCopy('zh', 'agent.history.compact', { count: 3 })).toBe('已隐藏 3 条重复内容或执行过程。')
    expect(matchesCollaborationLanguage('最终结论', 'zh')).toBe(true)
    expect(matchesCollaborationLanguage('Final answer', 'zh')).toBe(false)
  })
})
