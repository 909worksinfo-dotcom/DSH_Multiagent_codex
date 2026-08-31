import { describe, expect, it } from 'vitest'
import { createCollaborationStore } from '../src/client/store.ts'

describe('collaboration view store', () => {
  it('persists only expert and three-view navigation state for the latest run', () => {
    const store = createCollaborationStore().create('spec')
    store.actions.setTab('protocol')
    store.actions.selectMember('expert-1')

    expect(store.getSnapshot()).toEqual({
      selectedMemberId: 'expert-1',
      tab: 'protocol',
    })
    expect(store.getSnapshot()).not.toHaveProperty('creating')
    expect(store.getSnapshot()).not.toHaveProperty('draftTitle')
    expect(store.getSnapshot()).not.toHaveProperty('draftObjective')
    expect(store.getSnapshot()).not.toHaveProperty('filter')
  })
})
