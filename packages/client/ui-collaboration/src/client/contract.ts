import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createAgentPanelStore, createCollaborationStore } from './store.ts'
import type {
  CollaborationAgentDetail, CollaborationCatalogSnapshot, CollaborationLanguage,
  CollaborationRunId, CreateCollaborationRunRequest,
} from './types.ts'

/** Registration-side collaboration business face supplied by client runtime. */
export interface CollaborationInjected {
  readonly hooks: {
    readonly collaboration: HostObservable<CollaborationCatalogSnapshot>
  }
  refreshCollaboration(runId?: CollaborationRunId): Promise<void>
  closeCollaboration(): void
}

/** Sidebar action that opens the root-scoped collaboration dock. */
export interface CollaborationTriggerInjected {
  readonly enterCollaboration: () => void
}

/** Operations supplied to the dedicated collaboration task workspace. */
export interface CollaborationWorkspaceInjected {
  readonly hooks: {
    readonly collaboration: HostObservable<CollaborationCatalogSnapshot>
  }
  startCollaboration(request: CreateCollaborationRunRequest): Promise<CollaborationRunId>
  refreshCollaboration(runId?: CollaborationRunId): Promise<void>
  prepareNewCollaboration(): void
  leaveCollaboration(): void
}

/** Operations supplied to the legacy collaboration overlay entry. */
export interface AgentPanelInjected {
  loadAgentDetail: (
    parentSessionId: string,
    childSessionId: string,
    language: CollaborationLanguage,
    signal: AbortSignal,
  ) => Promise<CollaborationAgentDetail>
  readSessionLanguage: (sessionId: string) => CollaborationLanguage
  refreshAgents: (sessionId: string, open: boolean) => void
}

/** Fully injected props for the legacy per-session agent overlay. */
export type AgentPanelProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createAgentPanelStore>>
  & AgentPanelInjected
  & PropsLocale<'collaboration'>

/** Fully injected props for the authoritative collaboration console. */
export type CollaborationRootProps =
  & PropsRuntime<'collaboration.dock'>
  & PropsStore<ReturnType<typeof createCollaborationStore>>
  & InjectFace<CollaborationInjected>
  & PropsLocale<'collaboration'>

/** Fully injected props for the independent multi-agent task workspace. */
export type CollaborationWorkspaceProps =
  & PropsRuntime<'collaboration.workspace'>
  & InjectFace<CollaborationWorkspaceInjected>
  & PropsLocale<'collaboration'>

/** Fully injected sidebar trigger props. */
export type CollaborationTriggerProps =
  & PropsRuntime<'sidebar.footer.action'>
  & CollaborationTriggerInjected
  & PropsLocale<'collaboration'>
