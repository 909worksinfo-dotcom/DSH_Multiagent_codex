/** Registers the collaboration trigger and its non-overlay root dock. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { CollaborationRoot, CollaborationTrigger } from './CollaborationRoot.tsx'
import { CollaborationWorkspace } from './CollaborationWorkspace.tsx'
import type { CollaborationInjected, CollaborationWorkspaceInjected } from './contract.ts'
import { createCollaborationStore } from './store.ts'
import { en, NS, zh, type CollaborationKey } from './locales.ts'

export { createCollaborationStore } from './store.ts'
export type {
  CollaborationArtifact, CollaborationArtifactKind, CollaborationArtifactStatus,
  CollaborationCatalogSnapshot, CollaborationComplexity, CollaborationExpertCounts,
  CollaborationController, CollaborationControllerHealth, CollaborationControllerRecommendedAction,
  CollaborationDecision,
  CollaborationDecisionOutcome,
  CollaborationExpertMember, CollaborationFailure, CollaborationLanguage, CollaborationLeadMember,
  CollaborationLevel, CollaborationMemberPhase, CollaborationPort, CollaborationRunId,
  CollaborationQualityGate, CollaborationQualityGateStatus,
  CollaborationChallengeStatus, CollaborationChallengeThread,
  CollaborationProtocol, CollaborationProtocolPermissions, CollaborationProtocolMember,
  CollaborationRunPhase, CollaborationRunSnapshot, CollaborationRunStatus,
  CollaborationSafeCapabilityMetadata, CollaborationSafeExpertBindingMetadata,
  CollaborationTaskProfile, CollaborationTeamCharter, CollaborationTopology,
  CreateCollaborationRunRequest,
} from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    collaboration: CollaborationKey
  }
}

/** Collaboration runtime, layout orchestration, slots, and locale composition. */
export const inject = ['collaboration', 'layout', 'slots', 'locale']

/** Collaboration client configuration. */
export type Config = Record<string, never>

/** Register the P5 TeamRun console and the existing session agent overlay. */
export function apply(ctx: ClientContext, _config: Config = {}): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-collaboration: dictionaries')

  const collaborationInjected = (): CollaborationInjected => ({
    hooks: { collaboration: ctx.collaboration.source },
    refreshCollaboration: runId => runId === undefined
      ? ctx.collaboration.refresh()
      : ctx.collaboration.refreshRun(runId),
    closeCollaboration: () => { ctx.layout.closeCollaboration() },
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'collaboration-playground',
    order: -10,
    locale: NS,
    inject: () => ({ enterCollaboration: () => { ctx.layout.enterCollaboration() } }),
  }, CollaborationTrigger))

  const workspaceInjected = (): CollaborationWorkspaceInjected => ({
    hooks: { collaboration: ctx.collaboration.source },
    startCollaboration: async (request) => {
      const runId = await ctx.collaboration.createRun(request)
      ctx.layout.openCollaboration()
      return runId
    },
    refreshCollaboration: runId => runId === undefined
      ? ctx.collaboration.refresh()
      : ctx.collaboration.refreshRun(runId),
    prepareNewCollaboration: () => { ctx.layout.closeCollaboration() },
    leaveCollaboration: () => { ctx.layout.enterConversation() },
  })
  ctx.slots.inject('collaboration.workspace', () => ctx.slots.register({
    name: 'collaboration.workspace',
    locale: NS,
    inject: workspaceInjected,
  }, CollaborationWorkspace))

  ctx.slots.inject('collaboration.dock', () => ctx.slots.register({
    name: 'collaboration.dock',
    store: createCollaborationStore,
    locale: NS,
    inject: collaborationInjected,
  }, CollaborationRoot))
}
