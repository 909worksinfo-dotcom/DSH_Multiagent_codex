/** ExpertBlueprint-bound continuable child provisioning over stable TeamRun transitions. */
import { createHash, randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { TeamRunError, TeamRunId, } from '@deepseek-ai/dsh-agent-team';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { countExpertTurns, findExpertBinding, foldExpertBindings, foldExpertChildDescriptor, hasExpertInitialPrompt, sameExpertDescriptor, } from "./fold.js";
import { ExpertRuntimeEventId } from "./ids.js";
import { renderExpertInitialPrompt } from "./prompt.js";
export { ExpertRuntimeEventId } from "./ids.js";
export { countExpertTurns, findExpertBinding, foldExpertBindings, foldExpertChildDescriptor, hasExpertInitialPrompt, sameExpertDescriptor, } from "./fold.js";
export { parseExpertBinding, parseExpertChildDescriptor } from "./schema.js";
export { renderExpertInitialPrompt } from "./prompt.js";
/** Per-TeamRun operation serialization without retaining settled keys. */
class RunLock {
    tails = new Map();
    /**
     * Serialize one operation after earlier runtime operations for the same Lead.
     * @param leadId - TeamRun and Lead Session identity.
     * @param operation - critical section.
     * @returns the operation's exact settlement.
     */
    run(leadId, operation) {
        const previous = this.tails.get(leadId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(() => undefined, () => undefined);
        this.tails.set(leadId, tail);
        void tail.then(() => {
            if (this.tails.get(leadId) === tail)
                this.tails.delete(leadId);
        });
        return result;
    }
}
/** User-safe single-line failure message. */
function errorMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.replaceAll(/\s+/g, ' ').trim().slice(0, 2_000) || 'expert provisioning failed';
}
/** Build a failure suitable for the P1 public roster audit. */
function teamFailure(error, signal) {
    const cancelled = signal?.aborted === true;
    const code = cancelled
        ? 'TEAM_CANCELLED'
        : error instanceof TeamRunError ? error.code : 'CAPABILITY_UNAVAILABLE';
    return {
        code,
        message: cancelled ? 'expert provisioning was cancelled before initial prompt admission' : errorMessage(error),
        retryable: !cancelled && error instanceof TeamRunError ? error.retryable : false,
        details: {},
    };
}
/** Build the explicit immutable-revision refusal used on every activation path. */
function revisionMismatch(expected, actual, cause) {
    return new TeamRunError(`expert capability binding changed: expected ${expected}, resolved ${actual}`, 'BLUEPRINT_REVISION_MISMATCH', {
        retryable: false,
        details: { expectedDigest: expected, actualDigest: actual },
        ...cause === undefined ? {} : { cause },
    });
}
/** Hash catalog identity together with runtime-resolved composition that the catalog cannot know. */
function compositionDigest(resolved, model, subagentProvider) {
    return createHash('sha256').update(JSON.stringify({
        catalogDigest: resolved.digest,
        subagentProvider,
        model,
        role: resolved.blueprint.role,
        persona: resolved.blueprint.persona,
        toolFilter: resolved.blueprint.tools,
    })).digest('hex');
}
/** Expert child provisioning, recovery, drift enforcement, and execution-budget owner. */
export class ExpertRuntime extends Service {
    config;
    static inject = ['agents', 'sessions', 'sessionPersistence', 'teamRuns', 'expertCatalog', 'subagents'];
    /** Loader validation for provider selection and complete-prompt bounds. */
    static Config = schema.object({
        subagentProvider: schema.string().required(),
        maxInitialPromptBytes: schema.number().step(1).min(1).required(),
    });
    locks = new RunLock();
    pending = new Map();
    authorizations = new Map();
    deadlines = new Map();
    /**
     * @param ctx - Cordis context carrying TeamRun, catalog, Session, Agent, persistence, and subagent services.
     * @param config - exact provider and initial-prompt byte limit.
     */
    constructor(ctx, config) {
        super(ctx, 'expertRuntime');
        this.config = config;
        if (config.subagentProvider.trim() === '') {
            throw new TeamRunError('expert runtime subagentProvider must be non-blank', 'TEAM_INVALID_CONFIG');
        }
        if (!Number.isSafeInteger(config.maxInitialPromptBytes) || config.maxInitialPromptBytes < 1) {
            throw new TeamRunError('expert runtime maxInitialPromptBytes must be a positive safe integer', 'TEAM_INVALID_CONFIG');
        }
        ctx.subagents.registerContinuableSetup(childCtx => this.setupChild(childCtx.agent));
        ctx.on('agent/created', ({ agent }) => { this.installDeadline(agent); });
        ctx.on('agent/disposed', ({ agent }) => { this.clearDeadline(agent.id); });
        ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
            const descriptor = foldExpertChildDescriptor(agent.session);
            if (descriptor === undefined)
                return next();
            try {
                if (this.parentRunIsTerminal(agent)) {
                    throw new TeamRunError('expert cannot enter a model step after its TeamRun is terminal', 'TEAM_INVALID_TRANSITION');
                }
                await this.assertCurrentBinding(agent, descriptor, signal);
                if (countExpertTurns(agent.session) > descriptor.descriptor.execution.maxTurns) {
                    throw new TeamRunError(`expert turn budget ${String(descriptor.descriptor.execution.maxTurns)} exhausted`, 'TEAM_CANCELLED');
                }
                if (Date.now() >= descriptor.descriptor.execution.deadlineAt) {
                    throw new TeamRunError('expert execution deadline reached', 'TEAM_CANCELLED');
                }
            }
            catch (error) {
                if (!this.parentRunIsTerminal(agent)) {
                    try {
                        await this.failFromChild(agent, descriptor, error);
                    }
                    catch (failureError) {
                        this.ctx.logger.warn(`expert "${agent.id}" failure record was rejected: ${errorMessage(failureError)}`);
                    }
                }
                throw error;
            }
            return next();
        });
        ctx.effect(() => () => {
            for (const timer of this.deadlines.values())
                clearTimeout(timer);
            this.deadlines.clear();
            this.pending.clear();
            this.authorizations.clear();
        }, 'expertRuntime.lifecycle()');
        for (const agent of ctx.agents.list())
            this.installDeadline(agent);
    }
    /**
     * Resolve, reserve, durably bind, create, and activate one real expert child.
     * P1 success commits after child publication and before the initial prompt enters its inbox.
     * @param lead - exact live TeamRun Lead.
     * @param request - identities, blueprint revision, assignment, CAS revision, and cancellation.
     * @returns active P1 member, immutable binding, and accepted initial message id.
     */
    provision(lead, request) {
        return this.locks.run(lead.id, async () => {
            const resolved = await this.ctx.expertCatalog.resolve(request.blueprint, {
                ...lead.session.header.cwd === undefined ? {} : { cwd: lead.session.header.cwd },
                signal: request.signal,
            });
            this.assertProvider(this.config.subagentProvider);
            const initialPrompt = renderExpertInitialPrompt(request.name, resolved.blueprint, request.assignment);
            this.assertPromptBytes(initialPrompt);
            const agentOptions = this.agentOptions(resolved, lead.options);
            const descriptor = this.bindingDescriptor(resolved, agentOptions);
            let began = false;
            let binding;
            try {
                await this.ctx.teamRuns.beginExpertProvision(lead, {
                    expectedRevision: request.expectedRevision,
                    memberId: request.memberId,
                    sessionId: request.sessionId,
                    attemptId: request.attemptId,
                    name: request.name,
                    role: resolved.blueprint.role,
                    ...request.protocolSlotId === undefined ? {} : { protocolSlotId: request.protocolSlotId },
                });
                began = true;
                binding = {
                    version: 1,
                    eventId: ExpertRuntimeEventId(`expert-runtime-event-${randomUUID()}`),
                    runId: TeamRunId(lead.id),
                    memberId: request.memberId,
                    sessionId: request.sessionId,
                    attemptId: request.attemptId,
                    name: request.name,
                    role: resolved.blueprint.role,
                    subagentProvider: this.config.subagentProvider,
                    descriptor,
                    initialPrompt,
                    agentOptions,
                    ...resolved.blueprint.persona === undefined ? {} : { persona: resolved.blueprint.persona },
                    toolFilter: structuredClone(resolved.blueprint.tools),
                };
                await this.appendBinding(lead, binding);
                const started = await this.startBoundChild(lead, binding, request.signal);
                return {
                    member: this.member(lead, request.attemptId, 'active'),
                    binding: structuredClone(binding),
                    messageId: started,
                };
            }
            catch (error) {
                if (began)
                    await this.compensateFailure(lead, request.attemptId, request.sessionId, error, request.signal);
                throw error;
            }
        });
    }
    /**
     * Recover one P1 provisioning attempt without replaying a prompt already accepted by a persisted child.
     * @param lead - exact live TeamRun Lead.
     * @param attemptId - existing immutable provisioning attempt.
     * @param signal - caller cancellation through inspection or missing-child creation.
     * @returns active P1 member plus whether a missing child had to start.
     */
    recoverProvisioning(lead, attemptId, signal) {
        return this.locks.run(lead.id, async () => {
            const binding = this.requireBinding(lead, attemptId);
            const current = this.member(lead, attemptId, 'provisioning', 'active');
            try {
                this.assertPromptBytes(binding.initialPrompt);
                await this.assertResolvedBinding(binding, lead.session.header.cwd, signal);
                this.assertProvider(binding.subagentProvider);
                const live = this.ctx.sessions.get(binding.sessionId);
                const existing = await this.inspectChild(binding.sessionId, signal);
                if (existing !== undefined) {
                    const descriptor = foldExpertChildDescriptor(existing);
                    if (descriptor === undefined || !sameExpertDescriptor(binding, descriptor)) {
                        throw revisionMismatch(binding.descriptor.digest, descriptor?.descriptor.digest ?? 'missing');
                    }
                    this.assertSubagentComposition(existing, binding);
                    const member = current.phase === 'active' ? current : await this.activateAttempt(lead, attemptId);
                    if (live === undefined && !hasExpertInitialPrompt(existing, binding.initialPrompt)) {
                        const messageId = await this.followupBoundChild(lead, binding, signal);
                        return { member, binding, started: true, messageId };
                    }
                    return { member, binding, started: false };
                }
                if (current.phase === 'active') {
                    throw revisionMismatch(binding.descriptor.digest, 'active-child-missing');
                }
                const messageId = await this.startBoundChild(lead, binding, signal);
                return {
                    member: this.member(lead, attemptId, 'active'),
                    binding,
                    started: true,
                    messageId,
                };
            }
            catch (error) {
                await this.compensateFailure(lead, attemptId, binding.sessionId, error, signal);
                throw error;
            }
        });
    }
    /**
     * Deliver a later expert message after validating current catalog content and the durable parent/child descriptor pair.
     * @param lead - exact live TeamRun Lead.
     * @param childId - exact expert child Session.
     * @param content - user-role content to enqueue.
     * @param options - durable attribution and pre-acceptance cancellation.
     * @returns accepted inbox message id.
     */
    async followup(lead, childId, content, options) {
        const run = this.ctx.teamRuns.getRun(lead);
        if (run.phase !== 'active') {
            throw new TeamRunError(`expert followup requires an active TeamRun; current phase is ${run.phase}`, 'TEAM_INVALID_TRANSITION');
        }
        const inspected = await this.requireInspectedChild(childId, options.signal);
        const descriptor = foldExpertChildDescriptor(inspected);
        if (descriptor === undefined)
            throw new TeamRunError(`child "${childId}" is not an expert runtime child`, 'TEAM_MEMBER_NOT_FOUND');
        const binding = this.requireBinding(lead, descriptor.attemptId);
        try {
            if (!sameExpertDescriptor(binding, descriptor)) {
                throw revisionMismatch(binding.descriptor.digest, descriptor.descriptor.digest);
            }
            this.assertSubagentComposition(inspected, binding);
            await this.assertResolvedBinding(binding, lead.session.header.cwd, options.signal);
            const token = this.authorize(childId, binding);
            try {
                return await this.ctx.subagents.followup(lead, childId, content, options);
            }
            finally {
                this.releaseAuthorization(childId, token);
            }
        }
        catch (error) {
            if (error instanceof TeamRunError && error.code === 'BLUEPRINT_REVISION_MISMATCH') {
                await this.compensateFailure(lead, binding.attemptId, childId, error, options.signal);
            }
            throw error;
        }
    }
    /**
     * List immutable bindings owned by one live Lead.
     * @param lead - exact live TeamRun Lead.
     * @returns detached records in append order.
     */
    listBindings(lead) {
        this.ctx.teamRuns.getRun(lead);
        return structuredClone(foldExpertBindings(TeamRunId(lead.id), lead.session.events));
    }
    /** Prepare one binding descriptor and execution budget. */
    bindingDescriptor(resolved, model) {
        const budget = resolved.blueprint.budget;
        const maxTokens = Math.min(resolved.blueprint.model.maxTokens ?? budget.maxTokens, budget.maxTokens);
        const deadlineAt = Date.now() + budget.timeoutMs;
        if (!Number.isSafeInteger(deadlineAt)) {
            throw new TeamRunError('ExpertBlueprint timeout exceeds the supported absolute deadline range', 'TEAM_INVALID_CONFIG');
        }
        return {
            blueprint: structuredClone(resolved.blueprint.ref),
            blueprintDigest: resolved.blueprintDigest,
            preset: structuredClone(resolved.preset),
            skills: structuredClone(resolved.skills),
            plugins: structuredClone(resolved.plugins),
            digest: resolved.digest,
            model: structuredClone(model),
            compositionDigest: compositionDigest(resolved, model, this.config.subagentProvider),
            execution: {
                maxTurns: budget.maxTurns,
                maxTokens,
                deadlineAt,
            },
        };
    }
    /** Resolve exact child Agent options, including the enforced effective token ceiling. */
    agentOptions(resolved, inherited = {}) {
        const maxTokens = Math.min(resolved.blueprint.model.maxTokens ?? resolved.blueprint.budget.maxTokens, resolved.blueprint.budget.maxTokens);
        const provider = resolved.blueprint.model.provider ?? inherited.provider;
        const model = resolved.blueprint.model.model ?? inherited.model;
        return {
            ...provider === undefined ? {} : { provider },
            ...model === undefined ? {} : { model },
            maxTokens,
        };
    }
    /** Ensure the selected provider can establish continuable children before consuming an attempt. */
    assertProvider(name) {
        const provider = this.ctx.subagents.getProvider(name);
        if (provider?.prepareContinuable === undefined) {
            throw new TeamRunError(`continuable subagent provider "${name}" is unavailable`, 'CAPABILITY_UNAVAILABLE');
        }
    }
    /** Enforce the complete rendered prompt bound at the point its bytes are known. */
    assertPromptBytes(prompt) {
        const bytes = Buffer.byteLength(prompt, 'utf8');
        if (bytes > this.config.maxInitialPromptBytes) {
            throw new TeamRunError(`expert initial prompt uses ${String(bytes)} UTF-8 bytes; limit is ${String(this.config.maxInitialPromptBytes)}`, 'TEAM_INVALID_ARGUMENT');
        }
    }
    /** Append and flush the immutable Lead binding before any child work starts. */
    async appendBinding(lead, binding) {
        if (findExpertBinding(binding.runId, lead.session.events, binding.attemptId) !== undefined) {
            throw new TeamRunError(`expert attempt "${binding.attemptId}" already has a binding`, 'TEAM_ATTEMPT_ID_TAKEN');
        }
        lead.session.append('collaboration/expert/binding', binding);
        await this.ctx.sessions.flush(lead.session);
    }
    /** Start one child and commit P1 activation immediately before initial prompt admission. */
    async startBoundChild(lead, binding, signal) {
        if (this.pending.has(binding.sessionId)) {
            throw new TeamRunError(`expert child "${binding.sessionId}" is already provisioning`, 'TEAM_SESSION_ID_TAKEN');
        }
        this.pending.set(binding.sessionId, binding);
        try {
            const started = await this.ctx.subagents.startContinuable({
                provider: binding.subagentProvider,
                label: binding.name,
                childId: binding.sessionId,
                agentPreset: binding.descriptor.preset.id,
                request: {
                    parent: lead,
                    prompt: [{ type: 'text', text: binding.initialPrompt }],
                    agentOptions: binding.agentOptions,
                    ...binding.persona === undefined ? {} : { persona: binding.persona },
                    toolFilter: binding.toolFilter,
                },
                beforeInitialPrompt: async () => {
                    if (Date.now() >= binding.descriptor.execution.deadlineAt) {
                        throw new TeamRunError('expert execution deadline reached before initial prompt admission', 'TEAM_CANCELLED');
                    }
                    await this.activateAttempt(lead, binding.attemptId);
                },
                signal,
            });
            return started.messageId;
        }
        finally {
            this.pending.delete(binding.sessionId);
        }
    }
    /** Cold-resume one persisted child and deliver a retained prompt under an exact one-call authorization. */
    async followupBoundChild(lead, binding, signal) {
        const token = this.authorize(binding.sessionId, binding);
        try {
            return await this.ctx.subagents.followup(lead, binding.sessionId, [{ type: 'text', text: binding.initialPrompt }], { source: { kind: 'user' }, signal });
        }
        finally {
            this.releaseAuthorization(binding.sessionId, token);
        }
    }
    /** Add one independent activation token without allowing competing descriptors. */
    authorize(childId, binding) {
        const token = Symbol(childId);
        const current = this.authorizations.get(childId);
        if (current === undefined) {
            this.authorizations.set(childId, { binding, tokens: new Set([token]) });
            return token;
        }
        if (!sameExpertDescriptor(current.binding, binding)) {
            throw revisionMismatch(current.binding.descriptor.digest, binding.descriptor.digest);
        }
        current.tokens.add(token);
        return token;
    }
    /** Release only the caller's authorization token, preserving concurrent cold activations. */
    releaseAuthorization(childId, token) {
        const current = this.authorizations.get(childId);
        if (current === undefined)
            return;
        current.tokens.delete(token);
        if (current.tokens.size === 0)
            this.authorizations.delete(childId);
    }
    /** Append or verify the child-side descriptor inside the unpublished setup window. */
    setupChild(child) {
        const existing = foldExpertChildDescriptor(child.session);
        const pending = this.pending.get(child.id);
        const authorized = this.authorizations.get(child.id)?.binding;
        if (existing === undefined && pending === undefined)
            return () => undefined;
        const expected = pending ?? authorized;
        if (expected === undefined) {
            throw revisionMismatch(existing?.descriptor.digest ?? 'missing', 'activation-not-authorized');
        }
        this.assertParentBinding(child, expected);
        this.assertSubagentComposition(child.session, expected);
        if (existing !== undefined) {
            if (!sameExpertDescriptor(expected, existing)) {
                throw revisionMismatch(expected.descriptor.digest, existing.descriptor.digest);
            }
            return () => undefined;
        }
        const descriptor = {
            version: 1,
            eventId: ExpertRuntimeEventId(`expert-runtime-event-${randomUUID()}`),
            runId: expected.runId,
            memberId: expected.memberId,
            sessionId: expected.sessionId,
            attemptId: expected.attemptId,
            descriptor: structuredClone(expected.descriptor),
        };
        child.session.append('collaboration/expert/descriptor', descriptor);
        return () => undefined;
    }
    /** Match the independent subagent v3 route/composition snapshot to the P2 Lead binding. */
    assertSubagentComposition(session, expected) {
        const descriptor = foldSubagentDescriptor(session.events.slice(session.header.seedLength ?? 0));
        const options = expected.agentOptions;
        if (descriptor?.mode !== 'continuable'
            || descriptor.provider !== expected.subagentProvider
            || descriptor.label !== expected.name
            || descriptor.agentProvider !== options.provider
            || descriptor.agentModel !== options.model
            || descriptor.agentMaxTokens !== options.maxTokens
            || descriptor.agentPreset !== expected.descriptor.preset.id
            || descriptor.persona !== expected.persona
            || JSON.stringify(descriptor.toolFilter) !== JSON.stringify(expected.toolFilter)) {
            throw revisionMismatch(expected.descriptor.digest, 'subagent-composition-mismatch');
        }
    }
    /** Compare one child against its exact live parent and Lead binding. */
    assertParentBinding(child, expected) {
        if (child.id !== expected.sessionId || String(child.session.header.parentSession) !== String(expected.runId)) {
            throw revisionMismatch(expected.descriptor.digest, 'child-identity-mismatch');
        }
        const parent = this.ctx.sessions.get(expected.runId);
        if (parent === undefined)
            throw revisionMismatch(expected.descriptor.digest, 'lead-session-unavailable');
        const durable = findExpertBinding(expected.runId, parent.events, expected.attemptId);
        if (durable === undefined || !sameExpertDescriptor(durable, expected)) {
            throw revisionMismatch(expected.descriptor.digest, durable?.descriptor.digest ?? 'missing');
        }
    }
    /** Re-resolve catalog, preset, and skill content and compare the complete immutable binding. */
    async assertResolvedBinding(binding, cwd, signal) {
        signal?.throwIfAborted();
        let resolved;
        try {
            resolved = await this.ctx.expertCatalog.resolve(binding.descriptor.blueprint, {
                ...cwd === undefined ? {} : { cwd },
                ...signal === undefined ? {} : { signal },
            });
        }
        catch (cause) {
            signal?.throwIfAborted();
            throw revisionMismatch(binding.descriptor.digest, 'unavailable', cause);
        }
        signal?.throwIfAborted();
        const maxTokens = Math.min(resolved.blueprint.model.maxTokens ?? resolved.blueprint.budget.maxTokens, resolved.blueprint.budget.maxTokens);
        const expectedOptions = this.agentOptions(resolved, binding.descriptor.model);
        const expectedDescriptor = {
            blueprint: structuredClone(resolved.blueprint.ref),
            blueprintDigest: resolved.blueprintDigest,
            preset: structuredClone(resolved.preset),
            skills: structuredClone(resolved.skills),
            plugins: structuredClone(resolved.plugins),
            digest: resolved.digest,
            model: structuredClone(expectedOptions),
            compositionDigest: compositionDigest(resolved, expectedOptions, binding.subagentProvider),
            execution: {
                maxTurns: resolved.blueprint.budget.maxTurns,
                maxTokens,
                deadlineAt: binding.descriptor.execution.deadlineAt,
            },
        };
        const expectedPersona = resolved.blueprint.persona;
        if (JSON.stringify(binding.descriptor) !== JSON.stringify(expectedDescriptor)
            || binding.role !== resolved.blueprint.role
            || JSON.stringify(binding.agentOptions) !== JSON.stringify(expectedOptions)
            || binding.persona !== expectedPersona
            || JSON.stringify(binding.toolFilter) !== JSON.stringify(resolved.blueprint.tools)) {
            throw revisionMismatch(binding.descriptor.digest, `resolved-content:${resolved.digest}`);
        }
    }
    /** Validate a live expert at the final pre-model extension point. */
    async assertCurrentBinding(child, descriptor, signal) {
        const parentId = child.session.header.parentSession;
        const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
        if (lead === undefined)
            throw revisionMismatch(descriptor.descriptor.digest, 'lead-agent-unavailable');
        const binding = this.requireBinding(lead, descriptor.attemptId);
        if (!sameExpertDescriptor(binding, descriptor)) {
            throw revisionMismatch(binding.descriptor.digest, descriptor.descriptor.digest);
        }
        this.assertSubagentComposition(child.session, binding);
        await this.assertResolvedBinding(binding, child.session.header.cwd, signal);
    }
    /** Commit P1 success with the latest revision after locating the exact provisioning row. */
    async activateAttempt(lead, attemptId) {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const current = this.member(lead, attemptId, 'provisioning', 'active');
            if (current.phase === 'active')
                return current;
            const revision = this.ctx.teamRuns.getRun(lead).revision;
            try {
                return await this.ctx.teamRuns.succeedExpertProvision(lead, { expectedRevision: revision, attemptId });
            }
            catch (error) {
                if (!(error instanceof TeamRunError) || error.code !== 'STALE_REVISION')
                    throw error;
            }
        }
        throw new TeamRunError(`expert attempt "${attemptId}" could not settle after concurrent TeamRun writes`, 'RESOURCE_CONFLICT');
    }
    /** Locate one exact member and require one of the allowed phases. */
    member(lead, attemptId, ...phases) {
        const member = this.ctx.teamRuns.getRun(lead).members.find(value => value.attemptId === attemptId);
        if (member === undefined)
            throw new TeamRunError(`expert attempt "${attemptId}" not found`, 'TEAM_MEMBER_NOT_FOUND');
        if (!phases.includes(member.phase)) {
            throw new TeamRunError(`expert attempt "${attemptId}" is ${member.phase}`, 'TEAM_INVALID_TRANSITION');
        }
        return member;
    }
    /** Resolve one exact immutable Lead binding. */
    requireBinding(lead, attemptId) {
        const runId = TeamRunId(lead.id);
        const binding = findExpertBinding(runId, lead.session.events, attemptId);
        if (binding === undefined) {
            throw new TeamRunError(`expert attempt "${attemptId}" has no durable capability binding`, 'BLUEPRINT_REVISION_MISMATCH');
        }
        return structuredClone(binding);
    }
    /** Inspect a live or persisted child, returning undefined only when no durable identity exists. */
    async inspectChild(childId, signal) {
        const live = this.ctx.sessions.get(childId);
        if (live !== undefined)
            return live;
        const listed = await this.ctx.sessionPersistence.listSnapshots(signal);
        if (!listed.some(candidate => candidate.header.id === childId))
            return undefined;
        const inspected = await this.ctx.sessionPersistence.inspect(childId, signal);
        return { events: inspected.events, header: inspected.meta };
    }
    /** Inspect one required child. */
    async requireInspectedChild(childId, signal) {
        const child = await this.inspectChild(childId, signal);
        if (child === undefined)
            throw new TeamRunError(`expert child "${childId}" is unavailable`, 'TEAM_MEMBER_NOT_FOUND');
        return child;
    }
    /** Roll back a failed provider/admission path to a P1 failed attempt after reaching child quiescence. */
    async compensateFailure(lead, attemptId, childId, error, signal) {
        const failures = [];
        try {
            await this.ctx.subagents.drainContinuableChildren(lead, [childId]);
        }
        catch (cause) {
            failures.push(cause);
        }
        finally {
            this.clearDeadline(childId);
        }
        try {
            await this.settleFailure(lead, attemptId, error, signal);
        }
        catch (cause) {
            failures.push(cause);
        }
        if (failures.length > 0) {
            throw new AggregateError([error, ...failures], 'expert provisioning failed and compensation did not reach a clean failed state');
        }
    }
    /** Retry P1 failure settlement across unrelated concurrent TeamRun revisions. */
    async settleFailure(lead, attemptId, error, signal) {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const run = this.ctx.teamRuns.getRun(lead);
            const member = run.members.find(value => value.attemptId === attemptId);
            if (member === undefined || member.phase === 'failed')
                return;
            try {
                await this.ctx.teamRuns.failExpertProvision(lead, {
                    expectedRevision: run.revision,
                    attemptId,
                    failure: teamFailure(error, signal),
                });
                return;
            }
            catch (failure) {
                if (!(failure instanceof TeamRunError) || failure.code !== 'STALE_REVISION')
                    throw failure;
            }
        }
        throw new TeamRunError(`expert attempt "${attemptId}" failure could not settle after concurrent TeamRun writes`, 'RESOURCE_CONFLICT');
    }
    /** Mark an active child failed when activation validation or budgets reject its next model step. */
    async failFromChild(child, descriptor, error) {
        const parentId = child.session.header.parentSession;
        const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
        if (lead === undefined)
            return;
        if (this.parentRunIsTerminal(child)) {
            this.authorizations.delete(child.id);
            this.clearDeadline(child.id);
            return;
        }
        try {
            await this.settleFailure(lead, descriptor.attemptId, error);
        }
        finally {
            this.authorizations.delete(child.id);
            this.clearDeadline(child.id);
        }
    }
    /** Install the persisted absolute deadline for one published expert Activation. */
    installDeadline(agent) {
        const descriptor = foldExpertChildDescriptor(agent.session);
        if (descriptor === undefined)
            return;
        this.clearDeadline(agent.id);
        const delay = Math.max(0, descriptor.descriptor.execution.deadlineAt - Date.now());
        const timerDelay = Math.min(delay, 2_147_483_647);
        const timer = setTimeout(() => {
            this.deadlines.delete(agent.id);
            if (Date.now() < descriptor.descriptor.execution.deadlineAt) {
                this.installDeadline(agent);
                return;
            }
            if (this.parentRunIsTerminal(agent))
                return;
            agent.cancel({ kind: 'hook', reason: 'expert execution deadline reached' });
            void this.failFromChild(agent, descriptor, new TeamRunError('expert execution deadline reached', 'TEAM_CANCELLED')).catch((error) => {
                this.ctx.logger.warn(`expert "${agent.id}" deadline cleanup failed: ${errorMessage(error)}`);
            });
        }, timerDelay);
        this.deadlines.set(agent.id, timer);
    }
    /** Clear one child deadline timer. */
    clearDeadline(childId) {
        const timer = this.deadlines.get(childId);
        if (timer === undefined)
            return;
        clearTimeout(timer);
        this.deadlines.delete(childId);
    }
    /** Whether the exact live parent TeamRun has reached an irreversible terminal phase. */
    parentRunIsTerminal(child) {
        const parentId = child.session.header.parentSession;
        const lead = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
        if (lead === undefined)
            return false;
        const phase = this.ctx.teamRuns.getRun(lead).phase;
        return phase === 'completed'
            || phase === 'formation_failed'
            || phase === 'failed'
            || phase === 'cancelled';
    }
}
export default ExpertRuntime;
//# sourceMappingURL=index.js.map