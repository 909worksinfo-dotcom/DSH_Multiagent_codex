/** Strict decoding for persisted expert binding and child descriptor events. */
import { z } from 'zod';
import { ProvisionAttemptId, TeamMemberId, TeamRunId, } from '@deepseek-ai/dsh-agent-team';
import { ExpertBindingDigest, ExpertBlueprintId } from '@deepseek-ai/dsh-expert-catalog';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ExpertRuntimeEventId } from "./ids.js";
const nonEmpty = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({
    id: nonEmpty.transform(ExpertBlueprintId),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const skill = z.object({
    name: nonEmpty,
    provider: nonEmpty,
    source: nonEmpty,
    contentDigest: digest,
    path: nonEmpty.optional(),
}).strict();
const agentOptions = z.object({
    provider: nonEmpty.optional(),
    model: nonEmpty.optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const descriptor = z.object({
    blueprint: ref,
    blueprintDigest: digest,
    preset: z.object({ id: nonEmpty, contentDigest: digest }).strict(),
    skills: z.array(skill),
    plugins: z.array(nonEmpty),
    digest: digest.transform(ExpertBindingDigest),
    model: agentOptions,
    compositionDigest: digest,
    execution: z.object({
        maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
}).strict();
const toolFilter = z.object({
    allow: z.array(nonEmpty).optional(),
    deny: z.array(nonEmpty).optional(),
}).strict();
const common = {
    version: z.literal(1),
    eventId: nonEmpty.transform(ExpertRuntimeEventId),
    runId: nonEmpty.transform(TeamRunId),
    memberId: nonEmpty.transform(TeamMemberId),
    sessionId: nonEmpty.transform(SessionId),
    attemptId: nonEmpty.transform(ProvisionAttemptId),
    descriptor,
};
const binding = z.object({
    ...common,
    name: nonEmpty,
    role: nonEmpty,
    subagentProvider: nonEmpty,
    initialPrompt: nonEmpty,
    agentOptions,
    persona: nonEmpty.optional(),
    toolFilter,
}).strict();
const child = z.object(common).strict();
/**
 * Decode one Lead-side binding from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version binding.
 */
export function parseExpertBinding(value) {
    try {
        return binding.parse(value);
    }
    catch (cause) {
        throw new Error('persisted expert binding payload is invalid', { cause });
    }
}
/**
 * Decode one child-side descriptor from the durable log.
 * @param value - persisted event payload.
 * @returns detached current-version descriptor.
 */
export function parseExpertChildDescriptor(value) {
    try {
        return child.parse(value);
    }
    catch (cause) {
        throw new Error('persisted expert child descriptor payload is invalid', { cause });
    }
}
//# sourceMappingURL=schema.js.map