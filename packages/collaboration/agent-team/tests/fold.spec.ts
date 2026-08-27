import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import {
  CollaborationEventId,
  CollaborationMessageId,
  ProvisionAttemptId,
  TeamArtifactId,
  TeamDecisionId,
  TeamMemberId,
  TeamQualityGateId,
  TeamRunId,
  TeamTaskId,
  TeamThreadId,
  emptyTeamRunFoldState,
  foldTeamRun,
  snapshotTeamRun,
} from '../src/index.ts'
import type {
  TeamMemberSnapshot,
  TeamRunCreatedEventData,
  TeamRunPhaseEventData,
} from '../src/index.ts'

const ROOT = SessionId('fold-root')
const RUN = TeamRunId(ROOT)

function event<T extends SessionEventType>(type: T, data: SessionEventMap[T], seq: number): SessionEvent<T> {
  return { type, data, seq, time: 1_000 + seq } as SessionEvent<T>
}

function created(overrides: Partial<TeamRunCreatedEventData> = {}): TeamRunCreatedEventData {
  return {
    version: 1,
    runId: RUN,
    eventId: CollaborationEventId('event-created'),
    revision: 1,
    leadId: ROOT,
    objective: 'Deliver the task',
    complexity: 'simple',
    plannedExperts: 1,
    policy: {
      maxActiveExperts: 8,
      maxProvisionAttempts: 12,
      maxTasks: 16,
      maxPublicMessages: 16,
      maxPublicMessageBytes: 1_024,
      maxArtifacts: 16,
      maxArtifactBodyBytes: 4_096,
      taskStallCursorThreshold: 10,
    },
    ...overrides,
  }
}

function phase(revision: number, next: TeamRunPhaseEventData['phase']): TeamRunPhaseEventData {
  return {
    version: 1,
    runId: RUN,
    eventId: CollaborationEventId(`event-phase-${revision}`),
    revision,
    phase: next,
  }
}

it('replays a pre-P5 creation policy with frozen ledger/controller limits', () => {
  const value = created()
  const legacyCreated = {
    ...value,
    policy: {
      maxActiveExperts: value.policy.maxActiveExperts,
      maxProvisionAttempts: value.policy.maxProvisionAttempts,
      maxTasks: value.policy.maxTasks,
      maxPublicMessages: value.policy.maxPublicMessages,
      maxPublicMessageBytes: value.policy.maxPublicMessageBytes,
    },
  } as unknown as TeamRunCreatedEventData
  const snapshot = snapshotTeamRun(foldTeamRun(RUN, [event('collaboration/run/created', legacyCreated, 0)]))

  expect(snapshot.policy).toMatchObject({
    maxArtifacts: 512,
    maxArtifactBodyBytes: 1_048_576,
    taskStallCursorThreshold: 20,
  })
})

function member(memberPhase: TeamMemberSnapshot['phase']): TeamMemberSnapshot {
  return {
    id: TeamMemberId('member-one'),
    sessionId: SessionId('expert-one'),
    name: 'expert-one',
    role: 'Research expert',
    attemptId: ProvisionAttemptId('attempt-one'),
    attemptNumber: 1,
    phase: memberPhase,
  }
}

function activePrefix(): SessionEvent[] {
  return [
    event('collaboration/run/created', created(), 0),
    event('collaboration/run/phase', phase(2, 'planning'), 1),
    event('collaboration/run/phase', phase(3, 'provisioning'), 2),
    event('collaboration/member', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-member-start'),
      revision: 4,
      member: member('provisioning'),
    }, 3),
    event('collaboration/member', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-member-active'),
      revision: 5,
      member: member('active'),
    }, 4),
    event('collaboration/run/phase', phase(6, 'active'), 5),
  ]
}

describe('TeamRun strict replay', () => {
  it('treats an identical event id as idempotent while advancing the physical cursor', () => {
    const creation = created()
    const state = foldTeamRun(RUN, [
      event('collaboration/run/created', creation, 0),
      event('collaboration/run/created', creation, 1),
    ])
    expect(state.revision).toBe(1)
    expect(state.cursor).toBe(1)
    expect(state.eventSignatures.size).toBe(1)

    expect(() => foldTeamRun(RUN, [
      event('collaboration/run/created', creation, 0),
      event('collaboration/run/created', { ...creation, objective: 'Different payload' }, 1),
    ])).toThrow(/event id .* was reused/)
  })

  it('rejects unsupported own versions and ignores unsupported inherited run records', () => {
    const own = event('collaboration/run/created', { ...created(), version: 2 as 1 }, 0)
    expect(() => foldTeamRun(RUN, [own])).toThrow(/unsupported TeamRun event version 2/)

    const inherited = event('collaboration/run/created', {
      ...created(),
      version: 99 as 1,
      runId: TeamRunId('ancestor'),
      leadId: SessionId('ancestor'),
    }, 0)
    const state = foldTeamRun(RUN, [inherited])
    expect(state.created).toBeUndefined()
    expect(state.cursor).toBe(-1)
  })

  it('filters a valid current-version inherited TeamRun from an ordinary fork', () => {
    const state = foldTeamRun(RUN, [event('collaboration/run/created', {
      ...created(),
      runId: TeamRunId('ancestor'),
      leadId: SessionId('ancestor'),
    }, 0)])
    expect(state).toMatchObject({ revision: 0, cursor: -1 })
    expect(state.created).toBeUndefined()
  })

  it('rejects malformed persisted objective, task text, public content, and task references', () => {
    expect(() => foldTeamRun(RUN, [event('collaboration/run/created', {
      ...created(), objective: '   ',
    }, 0)])).toThrow(/objective must be non-empty/)

    const taskEvent = event('collaboration/task', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-task'),
      revision: 7,
      task: {
        id: TeamTaskId('task-1'),
        revision: 1,
        subject: ' padded ',
        description: 'Task description',
        status: 'pending',
        blockedBy: [],
        resourceScopes: [],
      },
    }, 6)
    expect(() => foldTeamRun(RUN, [...activePrefix(), taskEvent])).toThrow(/text is not normalized/)

    const missingReference = event('collaboration/message', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-message'),
      revision: 7,
      message: {
        id: CollaborationMessageId('message-one'),
        threadId: TeamThreadId('main'),
        kind: 'review',
        author: { role: 'lead', sessionId: ROOT, name: 'lead' },
        targets: [],
        references: { taskId: TeamTaskId('missing') },
        content: 'Public review',
        visibility: 'public',
      },
    }, 6)
    expect(() => foldTeamRun(RUN, [...activePrefix(), missingReference]))
      .toThrow(/references missing or deleted task/)

    const whitespaceMessage = {
      ...missingReference,
      data: {
        ...missingReference.data,
        message: { ...missingReference.data.message, references: {}, content: '   ' },
      },
    }
    expect(() => foldTeamRun(RUN, [...activePrefix(), whitespaceMessage]))
      .toThrow(/public message content must be non-empty/)
  })

  it('has no persisted private-reasoning category and rejects a forged one', () => {
    const forged = {
      ...event('collaboration/message', {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-private'),
        revision: 7,
        message: {
          id: CollaborationMessageId('message-private'),
          threadId: TeamThreadId('main'),
          kind: 'inform',
          author: { role: 'lead', sessionId: ROOT, name: 'lead' },
          targets: [],
          references: {},
          content: 'Safe public statement',
          visibility: 'public',
        },
      }, 6),
      data: {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-private'),
        revision: 7,
        message: {
          id: CollaborationMessageId('message-private'),
          threadId: TeamThreadId('main'),
          kind: 'private_reasoning',
          author: { role: 'lead', sessionId: ROOT, name: 'lead' },
          targets: [],
          references: {},
          content: 'must not persist',
          visibility: 'public',
        },
      },
    } as unknown as SessionEvent
    expect(() => foldTeamRun(RUN, [...activePrefix(), forged]))
      .toThrow(/persisted TeamRun collaboration\/message payload is invalid/)
  })

  it('rejects the Lead as a provisioned expert and terminal state mutation', () => {
    const leadMember = event('collaboration/member', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-lead-member'),
      revision: 4,
      member: { ...member('provisioning'), sessionId: ROOT },
    }, 3)
    expect(() => foldTeamRun(RUN, [
      event('collaboration/run/created', created(), 0),
      event('collaboration/run/phase', phase(2, 'planning'), 1),
      event('collaboration/run/phase', phase(3, 'provisioning'), 2),
      leadMember,
    ])).toThrow(/Lead cannot occupy an expert slot/)

    const terminal = event('collaboration/run/phase', {
      ...phase(2, 'cancelled'),
      failure: { code: 'TEAM_CANCELLED', message: 'cancelled', retryable: false, details: {} },
    }, 1)
    expect(() => foldTeamRun(RUN, [
      event('collaboration/run/created', created(), 0),
      terminal,
      event('collaboration/run/phase', phase(3, 'planning'), 2),
    ])).toThrow(/cannot transition from cancelled/)
  })

  it('starts with a truly empty fold before creation', () => {
    expect(emptyTeamRunFoldState(RUN)).toMatchObject({ id: RUN, revision: 0, cursor: -1 })
  })

  it('cold-replays independent P5 ledgers while keeping artifact bodies out of the run projection', () => {
    const taskId = TeamTaskId('task-1')
    const artifactId = TeamArtifactId('artifact-one')
    const decisionId = TeamDecisionId('decision-one')
    const gateId = TeamQualityGateId('quality-gate-1')
    const prefix = activePrefix().slice(0, -1)
    prefix.push(event('collaboration/quality-gate', {
      version: 1,
      runId: RUN,
      eventId: CollaborationEventId('event-gate-pending'),
      revision: 6,
      gate: { id: gateId, version: 1, name: 'Evidence quality', status: 'pending', summary: '' },
    }, 5))
    prefix.push(event('collaboration/run/phase', phase(7, 'active'), 6))
    const records = [
      ...prefix,
      event('collaboration/task', {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-task-p5'),
        revision: 8,
        task: {
          id: taskId,
          revision: 1,
          subject: 'Evidence task',
          description: 'Produce evidence',
          status: 'completed',
          owner: { role: 'lead', sessionId: ROOT, name: 'lead' },
          blockedBy: [],
          resourceScopes: [],
        },
      }, 7),
      event('collaboration/artifact', {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-artifact-p5'),
        revision: 9,
        artifact: {
          id: artifactId,
          version: 1,
          kind: 'evidence',
          title: 'Evidence body',
          status: 'accepted',
          author: { role: 'lead', sessionId: ROOT, name: 'lead' },
          taskIds: [taskId],
          mediaType: 'text/markdown',
          body: 'restricted body',
        },
      }, 8),
      event('collaboration/quality-gate', {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-gate-passed'),
        revision: 10,
        gate: {
          id: gateId,
          version: 2,
          name: 'Evidence quality',
          status: 'passed',
          reviewer: { role: 'lead', sessionId: ROOT, name: 'lead' },
          taskId,
          artifactId,
          summary: 'Passed',
        },
      }, 9),
      event('collaboration/decision', {
        version: 1,
        runId: RUN,
        eventId: CollaborationEventId('event-decision-p5'),
        revision: 11,
        decision: {
          id: decisionId,
          version: 1,
          subject: 'Accept evidence',
          outcome: 'accepted',
          summary: 'Evidence is accepted',
          rationale: 'The quality gate passed',
          taskIds: [taskId],
          artifactIds: [artifactId],
          lead: { role: 'lead', sessionId: ROOT, name: 'lead' },
        },
      }, 10),
    ]
    const persisted = JSON.parse(JSON.stringify(records)) as SessionEvent[]
    const state = foldTeamRun(RUN, persisted)
    expect(state.artifacts.get(artifactId)?.body).toBe('restricted body')
    const snapshot = snapshotTeamRun(state)
    expect(snapshot.artifacts).toEqual([expect.objectContaining({ id: artifactId, version: 1, status: 'accepted' })])
    expect(snapshot.artifacts[0]).not.toHaveProperty('body')
    expect(snapshot.qualityGates).toEqual([expect.objectContaining({ id: gateId, status: 'passed' })])
    expect(snapshot.decisions).toEqual([expect.objectContaining({ id: decisionId, outcome: 'accepted' })])
    expect(snapshot.controller.health).toBe('healthy')
  })
})
