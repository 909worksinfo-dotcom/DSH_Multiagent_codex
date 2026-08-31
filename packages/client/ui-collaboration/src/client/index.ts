/** Registers the collaboration trigger and its non-overlay root dock. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { CollaborationRoot, CollaborationTrigger } from './CollaborationRoot.tsx'
import { CollaborationWorkspace } from './CollaborationWorkspace.tsx'
import type {
  CollaborationInjected, CollaborationWorkspaceInjected,
} from './contract.ts'
import { answerExpertApproval, readExpertApproval } from './expert-approval.ts'
import { createCollaborationStore } from './store.ts'
import { en, NS, zh, type CollaborationKey } from './locales.ts'

export { createCollaborationStore } from './store.ts'
export type {
  CollaborationArtifact, CollaborationArtifactKind, CollaborationArtifactStatus,
  CollaborationCatalogSnapshot, CollaborationComplexity, CollaborationExpertCounts,
  CollaborationController, CollaborationControllerHealth, CollaborationControllerRecommendedAction,
  CollaborationDecision,
  CollaborationDecisionOutcome,
  CollaborationExternalCredential, CollaborationExternalCredentialRef,
  CollaborationExpertMember, CollaborationExpertModelSelection, CollaborationFailure, CollaborationLanguage, CollaborationLeadMember,
  CollaborationLevel, CollaborationMemberPhase, CollaborationPort, CollaborationRunId,
  CollaborationQualityGate, CollaborationQualityGateStatus,
  CollaborationChallengeStatus, CollaborationChallengeThread,
  CollaborationProtocol, CollaborationProtocolPermissions, CollaborationProtocolMember,
  CollaborationRunPhase, CollaborationRunSnapshot, CollaborationRunStatus,
  CollaborationSafeCapabilityMetadata, CollaborationSafeExpertBindingMetadata,
  CollaborationModelCatalog, CollaborationSkillOption,
  CollaborationTaskProfile, CollaborationTeamCharter, CollaborationTopology,
  CollaborationPlannedTask,
  CreateCollaborationRunRequest,
} from './types.ts'
export type { CollaborationApprovalOutcome, CollaborationExpertApproval } from './contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    collaboration: CollaborationKey
  }
}

/** Collaboration runtime, layout orchestration, slots, and locale composition. */
export const inject = ['collaboration', 'layout', 'slots', 'locale', 'sessions']

/** Collaboration client configuration. */
export type Config = Record<string, never>

/** Register the P5 TeamRun console and the existing session agent overlay. */
export function apply(ctx: ClientContext, _config: Config = {}): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-collaboration: dictionaries')

  const collaborationInjected = (): CollaborationInjected => ({
    hooks: { collaboration: ctx.collaboration.source },
    readExpertApproval: sessionId => readExpertApproval(ctx.sessions, sessionId),
    answerExpertApproval: (sessionId, approvalKey, outcome) =>
      answerExpertApproval(ctx.sessions, sessionId, approvalKey, outcome),
    refreshCollaboration: runId => runId === undefined
      ? ctx.collaboration.refresh()
      : ctx.collaboration.refreshRun(runId),
    openCollaboration: () => { ctx.layout.openCollaboration() },
    closeCollaboration: () => { ctx.layout.closeCollaboration() },
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'collaboration-playground',
    order: -10,
    locale: NS,
    inject: () => ({
      enterCollaboration: () => {
        ctx.layout.closeCollaboration()
        ctx.layout.enterCollaboration()
      },
    }),
  }, CollaborationTrigger))

  const workspaceInjected = (): CollaborationWorkspaceInjected => ({
    hooks: { collaboration: ctx.collaboration.source },
    listCollaborationSkills: runId => ctx.collaboration.listSkills(runId),
    listCollaborationModels: runId => ctx.collaboration.listModels(runId),
    describeCollaborationCredentials: () => ctx.collaboration.describeExternalCredentials(),
    setCollaborationCredential: (ref, value) => ctx.collaboration.setExternalCredential(ref, value),
    startCollaboration: async (request) => {
      return ctx.collaboration.createRun(request)
    },
    confirmCollaboration: async (runId) => {
      await ctx.collaboration.confirmRun(runId)
      ctx.layout.openCollaboration()
    },
    cancelCollaboration: runId => ctx.collaboration.terminate(runId),
    refreshCollaboration: runId => runId === undefined
      ? ctx.collaboration.refresh()
      : ctx.collaboration.refreshRun(runId),
    openCollaboration: () => { ctx.layout.openCollaboration() },
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
