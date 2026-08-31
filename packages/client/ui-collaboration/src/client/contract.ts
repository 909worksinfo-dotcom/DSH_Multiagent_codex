import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createAgentPanelStore, createCollaborationStore } from './store.ts'
import type {
  CollaborationAgentDetail, CollaborationCatalogSnapshot, CollaborationLanguage,
  CollaborationExternalCredential, CollaborationExternalCredentialRef,
  CollaborationModelCatalog, CollaborationRunId, CollaborationSkillOption, CreateCollaborationRunRequest,
} from './types.ts'

/** Registration-side collaboration business face supplied by client runtime. */
export interface CollaborationInjected {
  readonly hooks: {
    readonly collaboration: HostObservable<CollaborationCatalogSnapshot>
  }
  readExpertApproval(sessionId: string): CollaborationExpertApproval | null
  answerExpertApproval(
    sessionId: string,
    approvalKey: string,
    outcome: CollaborationApprovalOutcome,
  ): Promise<void>
  refreshCollaboration(runId?: CollaborationRunId): Promise<void>
  /** Reveal the native collaboration column when an expert needs approval. */
  openCollaboration(): void
  closeCollaboration(): void
}

/** User-answerable approval currently blocking one collaboration expert. */
export interface CollaborationExpertApproval {
  readonly key: string
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string
  readonly callId?: string
  /** Exact TeamRun eligible for the collaboration-only all-agent grant. */
  readonly collaborationRunId?: CollaborationRunId
}

/** Outcomes exposed by the collaboration approval surface. */
export type CollaborationApprovalOutcome =
  | 'allowed-once'
  | 'allowed-for-turn'
  | 'allowed-for-task'
  | 'rejected'

/** Sidebar action that opens the root-scoped collaboration dock. */
export interface CollaborationTriggerInjected {
  readonly enterCollaboration: () => void
}

/** Operations supplied to the dedicated collaboration task workspace. */
export interface CollaborationWorkspaceInjected {
  readonly hooks: {
    readonly collaboration: HostObservable<CollaborationCatalogSnapshot>
  }
  listCollaborationSkills(runId: CollaborationRunId): Promise<readonly CollaborationSkillOption[]>
  listCollaborationModels(runId: CollaborationRunId): Promise<CollaborationModelCatalog>
  describeCollaborationCredentials(): Promise<readonly CollaborationExternalCredential[]>
  setCollaborationCredential(ref: CollaborationExternalCredentialRef, value: string): Promise<void>
  startCollaboration(request: CreateCollaborationRunRequest): Promise<CollaborationRunId>
  confirmCollaboration(runId: CollaborationRunId): Promise<void>
  cancelCollaboration(runId: CollaborationRunId): Promise<void>
  refreshCollaboration(runId?: CollaborationRunId): Promise<void>
  openCollaboration(): void
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
