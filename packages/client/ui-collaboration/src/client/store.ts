import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

interface AgentPanelState {
  width: number
}

type AgentPanelActions = {
  setWidth: (draft: AgentPanelState, width: number) => void
}

/**
 * Create the persistent legacy agent-panel viewing store.
 * @returns Store handle scoped to presentation width only.
 */
export function createAgentPanelStore(): EngineStoreHandle<AgentPanelState, AgentPanelActions> {
  return defineStore({
    init: (): AgentPanelState => ({ width: 360 }),
    persist: 'dsh.collaboration.agentPanel',
    actions: {
      setWidth: (draft, width) => { draft.width = width },
    },
  })
}

/** The three intentionally retained collaboration views. */
export type CollaborationViewTab = 'timeline' | 'roster' | 'protocol'

/** Browser-only viewing state. Task creation belongs to the main conversation. */
interface CollaborationState {
  selectedMemberId: string | null
  tab: CollaborationViewTab
}

type CollaborationActions = {
  selectMember: (draft: CollaborationState, id: string | null) => void
  setTab: (draft: CollaborationState, tab: CollaborationViewTab) => void
}

/**
 * Create the persistent root-scoped collaboration viewing store.
 * @returns Store handle containing only navigation state for the latest run.
 */
export function createCollaborationStore(): EngineStoreHandle<CollaborationState, CollaborationActions> {
  return defineStore({
    init: (): CollaborationState => ({
      selectedMemberId: null,
      tab: 'timeline',
    }),
    // V4 drops the removed task-board tab so a persisted V3 selection cannot
    // restore into an empty panel.
    persist: 'dsh.collaboration.console.v4',
    actions: {
      selectMember: (draft, id) => { draft.selectedMemberId = id },
      setTab: (draft, tab) => { draft.tab = tab },
    },
  })
}
