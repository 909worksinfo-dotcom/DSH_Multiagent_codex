/** Serialized TeamRun transactions over the exact live Lead Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { applyTeamRunEvent, foldTeamRun } from './fold.ts'
import type { TeamRunFoldState } from './fold.ts'
import { TeamRunId } from './ids.ts'
import type { TeamRunEventType } from './schema.ts'

type AppendTeamRunEvent = <T extends TeamRunEventType>(type: T, data: SessionEventMap[T]) => SessionEvent<T>
type TeamRunEventInput = {
  [T in TeamRunEventType]: { readonly type: T; readonly data: SessionEventMap[T] }
}[TeamRunEventType]

/** Owns per-Lead command order and the append-then-flush commit point. */
export class TeamRunJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /** @param ctx - service context with Session durability. */
  constructor(private readonly ctx: Context) {}

  /**
   * Fold authoritative TeamRun state from one exact live Lead.
   * @param lead - exact live Lead whose Session owns the log.
   * @returns current strict replay state.
   */
  state(lead: Agent): TeamRunFoldState {
    return foldTeamRun(TeamRunId(lead.id), lead.session.events)
  }

  /**
   * Serialize one Lead's complete read-check-append command.
   * @param leadId - Lead Session identity selecting the command queue.
   * @param operation - complete asynchronous command.
   * @returns the operation result.
   */
  async transact<T>(leadId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(leadId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(leadId, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(leadId) === tail) this.tails.delete(leadId)
    }
  }

  /**
   * Append and durably flush one log-only TeamRun event.
   * @param lead - exact live Lead owning the event.
   * @param type - stable collaboration event key.
   * @param data - payload correlated with `type`.
   * @returns the committed event including sequence and time.
   */
  async appendAndFlush<T extends TeamRunEventType>(
    lead: Agent,
    type: T,
    data: SessionEventMap[T],
  ): Promise<SessionEvent<T>> {
    const candidate = {
      type,
      data,
      seq: lead.session.events.length,
      time: Date.now(),
    } as SessionEvent<T>
    applyTeamRunEvent(this.state(lead), candidate)
    const append = lead.session.append.bind(lead.session) as unknown as AppendTeamRunEvent
    const event = append(type, data)
    await this.ctx.sessions.flush(lead.session)
    return event
  }

  /**
   * Validate a complete multi-event transition before appending any row, then flush it as
   * one Session write-behind batch. This is reserved for state machines whose public commit
   * requires every adjacent event, such as completing, final delivery, and completed.
   * @param lead - exact live Lead owning the event batch.
   * @param inputs - correlated TeamRun events in semantic revision order.
   * @returns committed events in input order.
   */
  async appendBatchAndFlush(lead: Agent, inputs: readonly TeamRunEventInput[]): Promise<SessionEvent[]> {
    const staged = this.state(lead)
    const startedAt = Date.now()
    for (const [index, input] of inputs.entries()) {
      applyTeamRunEvent(staged, {
        type: input.type,
        data: input.data,
        seq: lead.session.events.length + index,
        time: startedAt + index,
      } as SessionEvent)
    }
    const append = lead.session.append.bind(lead.session) as unknown as (
      type: TeamRunEventType,
      data: SessionEventMap[TeamRunEventType],
    ) => SessionEvent
    const events = inputs.map(input => append(input.type, input.data))
    await this.ctx.sessions.flush(lead.session)
    return events
  }
}
