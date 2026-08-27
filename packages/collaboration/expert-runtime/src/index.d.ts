/** ExpertBlueprint-bound continuable child provisioning over stable TeamRun transitions. */
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { type SubagentFollowupOptions } from '@deepseek-ai/dsh-subagent';
import type { Config, ExpertBindingEventData, ExpertProvisionAttemptId, ProvisionedExpert, ProvisionExpertRequest, RecoveredExpert } from './types.ts';
export type * from './types.ts';
export { ExpertRuntimeEventId } from './ids.ts';
export { countExpertTurns, findExpertBinding, foldExpertBindings, foldExpertChildDescriptor, hasExpertInitialPrompt, sameExpertDescriptor, } from './fold.ts';
export { parseExpertBinding, parseExpertChildDescriptor } from './schema.ts';
export { renderExpertInitialPrompt } from './prompt.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        expertRuntime: ExpertRuntime;
    }
}
/** Expert child provisioning, recovery, drift enforcement, and execution-budget owner. */
export declare class ExpertRuntime extends Service {
    readonly config: Config;
    static inject: string[];
    /** Loader validation for provider selection and complete-prompt bounds. */
    static Config: schema<Config>;
    private readonly locks;
    private readonly pending;
    private readonly authorizations;
    private readonly deadlines;
    /**
     * @param ctx - Cordis context carrying TeamRun, catalog, Session, Agent, persistence, and subagent services.
     * @param config - exact provider and initial-prompt byte limit.
     */
    constructor(ctx: Context, config: Config);
    /**
     * Resolve, reserve, durably bind, create, and activate one real expert child.
     * P1 success commits after child publication and before the initial prompt enters its inbox.
     * @param lead - exact live TeamRun Lead.
     * @param request - identities, blueprint revision, assignment, CAS revision, and cancellation.
     * @returns active P1 member, immutable binding, and accepted initial message id.
     */
    provision(lead: Agent, request: ProvisionExpertRequest): Promise<ProvisionedExpert>;
    /**
     * Recover one P1 provisioning attempt without replaying a prompt already accepted by a persisted child.
     * @param lead - exact live TeamRun Lead.
     * @param attemptId - existing immutable provisioning attempt.
     * @param signal - caller cancellation through inspection or missing-child creation.
     * @returns active P1 member plus whether a missing child had to start.
     */
    recoverProvisioning(lead: Agent, attemptId: ExpertProvisionAttemptId, signal: AbortSignal): Promise<RecoveredExpert>;
    /**
     * Deliver a later expert message after validating current catalog content and the durable parent/child descriptor pair.
     * @param lead - exact live TeamRun Lead.
     * @param childId - exact expert child Session.
     * @param content - user-role content to enqueue.
     * @param options - durable attribution and pre-acceptance cancellation.
     * @returns accepted inbox message id.
     */
    followup(lead: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
    /**
     * List immutable bindings owned by one live Lead.
     * @param lead - exact live TeamRun Lead.
     * @returns detached records in append order.
     */
    listBindings(lead: Agent): ExpertBindingEventData[];
    /** Prepare one binding descriptor and execution budget. */
    private bindingDescriptor;
    /** Resolve exact child Agent options, including the enforced effective token ceiling. */
    private agentOptions;
    /** Ensure the selected provider can establish continuable children before consuming an attempt. */
    private assertProvider;
    /** Enforce the complete rendered prompt bound at the point its bytes are known. */
    private assertPromptBytes;
    /** Append and flush the immutable Lead binding before any child work starts. */
    private appendBinding;
    /** Start one child and commit P1 activation immediately before initial prompt admission. */
    private startBoundChild;
    /** Cold-resume one persisted child and deliver a retained prompt under an exact one-call authorization. */
    private followupBoundChild;
    /** Add one independent activation token without allowing competing descriptors. */
    private authorize;
    /** Release only the caller's authorization token, preserving concurrent cold activations. */
    private releaseAuthorization;
    /** Append or verify the child-side descriptor inside the unpublished setup window. */
    private setupChild;
    /** Match the independent subagent v3 route/composition snapshot to the P2 Lead binding. */
    private assertSubagentComposition;
    /** Compare one child against its exact live parent and Lead binding. */
    private assertParentBinding;
    /** Re-resolve catalog, preset, and skill content and compare the complete immutable binding. */
    private assertResolvedBinding;
    /** Validate a live expert at the final pre-model extension point. */
    private assertCurrentBinding;
    /** Commit P1 success with the latest revision after locating the exact provisioning row. */
    private activateAttempt;
    /** Locate one exact member and require one of the allowed phases. */
    private member;
    /** Resolve one exact immutable Lead binding. */
    private requireBinding;
    /** Inspect a live or persisted child, returning undefined only when no durable identity exists. */
    private inspectChild;
    /** Inspect one required child. */
    private requireInspectedChild;
    /** Roll back a failed provider/admission path to a P1 failed attempt after reaching child quiescence. */
    private compensateFailure;
    /** Retry P1 failure settlement across unrelated concurrent TeamRun revisions. */
    private settleFailure;
    /** Mark an active child failed when activation validation or budgets reject its next model step. */
    private failFromChild;
    /** Install the persisted absolute deadline for one published expert Activation. */
    private installDeadline;
    /** Clear one child deadline timer. */
    private clearDeadline;
    /** Whether the exact live parent TeamRun has reached an irreversible terminal phase. */
    private parentRunIsTerminal;
}
export default ExpertRuntime;
//# sourceMappingURL=index.d.ts.map