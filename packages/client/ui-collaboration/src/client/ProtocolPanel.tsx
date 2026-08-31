import { collaborationCopy as copy } from './language.ts'
import { collaborationRunParticipantName } from './presentation.ts'
import type {
  CollaborationChallengeThread, CollaborationLanguage, CollaborationProtocolMember,
  CollaborationRunSnapshot,
} from './types.ts'
import css from './ProtocolPanel.module.css'

type BudgetTone = 'normal' | 'warning' | 'exhausted' | 'violation'

function budgetTone(member: CollaborationProtocolMember, maximum: number): BudgetTone {
  if (maximum < 0 || member.usedMessages < 0 || member.remainingMessages < 0
    || member.usedMessages > maximum || member.usedMessages + member.remainingMessages !== maximum) return 'violation'
  if (member.remainingMessages === 0) return 'exhausted'
  if (maximum > 0 && member.remainingMessages / maximum <= 0.2) return 'warning'
  return 'normal'
}

function Capability({ enabled, label, language }: { enabled: boolean; label: string; language: CollaborationLanguage }) {
  return (
    <span className={css.capability} data-enabled={enabled ? 'true' : 'false'} aria-label={copy(language, enabled ? 'protocol.permission.allowed' : 'protocol.permission.denied', { capability: label })}>
      <span aria-hidden="true">{enabled ? '✓' : '×'}</span>{label}
    </span>
  )
}

function MemberCard({ member, maximum, run, language }: {
  member: CollaborationProtocolMember
  maximum: number
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
}) {
  const tone = budgetTone(member, maximum)
  const usedRatio = maximum <= 0 ? (member.usedMessages > 0 ? 100 : 0) : Math.min(100, Math.max(0, member.usedMessages / maximum * 100))
  const displayName = collaborationRunParticipantName(run, member.name, 'expert', language)
  return (
    <article className={css.memberCard} data-budget-state={tone}>
      <header>
        <strong title={displayName}>{displayName}</strong>
        <span aria-live="polite">{copy(language, `protocol.budget.${tone}`)}</span>
      </header>
      <div className={css.identity}>
        <code title={member.memberId ?? member.slotId}>{member.slotId}</code>
        <span>{copy(language, `protocol.member.phase.${member.phase ?? 'unassigned'}`)}</span>
      </div>
      <div className={css.budgetLine}>
        <span>{copy(language, 'protocol.messages.used')}</span>
        <strong>{member.usedMessages} / {maximum}</strong>
      </div>
      <div className={css.meter} role="meter" aria-label={copy(language, 'protocol.messages.usedBy', { name: displayName })} aria-valuemin={0} aria-valuemax={Math.max(0, maximum)} aria-valuenow={Math.min(Math.max(0, maximum), Math.max(0, member.usedMessages))}>
        <span style={{ width: `${usedRatio}%` }} />
      </div>
      <small>{copy(language, 'protocol.messages.remaining', { count: member.remainingMessages })}</small>
      {tone === 'violation' ? <p className={css.violation} role="alert">{copy(language, 'protocol.violation.member')}</p> : null}
      <div className={css.capabilities} aria-label={copy(language, 'protocol.capabilities')}>
        <Capability enabled={member.permissions.challenge} label={copy(language, 'protocol.capability.challenge')} language={language} />
        <Capability enabled={member.permissions.review} label={copy(language, 'protocol.capability.review')} language={language} />
        <Capability enabled={member.permissions.requestHelp} label={copy(language, 'protocol.capability.requestHelp')} language={language} />
      </div>
      <dl className={css.targets}>
        <dt>{copy(language, 'protocol.allowedTargets')}</dt>
        <dd>{member.allowedTargets.length === 0
          ? <span>{copy(language, 'protocol.allowedTargets.empty')}</span>
          : member.allowedTargets.map((target, index) => {
            const role = /^(?:lead|lead agent)$/iu.test(target) ? 'lead' : 'expert'
            const targetName = collaborationRunParticipantName(run, target, role, language)
            return <span key={`${index}-${target}`} title={targetName}>{targetName}</span>
          })}</dd>
      </dl>
    </article>
  )
}

function challengeViolates(thread: CollaborationChallengeThread, maximum: number): boolean {
  return thread.round < 0 || thread.round > maximum
}

function ChallengeCard({ thread, maximum, run, language }: {
  thread: CollaborationChallengeThread
  maximum: number
  run: CollaborationRunSnapshot
  language: CollaborationLanguage
}) {
  const violation = challengeViolates(thread, maximum)
  const capped = maximum >= 0 && thread.round >= maximum
  return (
    <article className={css.challengeCard} data-challenge-status={thread.status} data-challenge-capped={capped ? 'true' : undefined} data-protocol-violation={violation ? 'true' : undefined}>
      <header>
        <code title={thread.challengeId}>{thread.challengeId}</code>
        <span data-status={thread.status}>{copy(language, `protocol.challenge.status.${thread.status}`)}</span>
      </header>
      <div className={css.route}>
        <strong title={collaborationRunParticipantName(run, thread.challenger, /^(?:lead|lead agent)$/iu.test(thread.challenger) ? 'lead' : 'expert', language)}>{collaborationRunParticipantName(run, thread.challenger, /^(?:lead|lead agent)$/iu.test(thread.challenger) ? 'lead' : 'expert', language)}</strong>
        <span aria-hidden="true">→</span>
        <strong title={collaborationRunParticipantName(run, thread.target, /^(?:lead|lead agent)$/iu.test(thread.target) ? 'lead' : 'expert', language)}>{collaborationRunParticipantName(run, thread.target, /^(?:lead|lead agent)$/iu.test(thread.target) ? 'lead' : 'expert', language)}</strong>
      </div>
      <div className={css.rounds}>
        <span>{copy(language, 'protocol.challenge.rounds')}</span>
        <strong>{thread.round} / {maximum}</strong>
      </div>
      <div className={css.challengeTrace} aria-label={copy(language, 'protocol.challenge.trace')}>
        <code title={thread.threadId}>{thread.threadId}</code>
        <code title={thread.challengeMessageId}>{thread.challengeMessageId}</code>
        {thread.responseMessageId === null ? null : <code title={thread.responseMessageId}>{thread.responseMessageId}</code>}
      </div>
      {capped && !violation ? <p className={css.capNotice}>{copy(language, 'protocol.challenge.capped')}</p> : null}
      {violation ? <p className={css.violation} role="alert">{copy(language, 'protocol.violation.challenge')}</p> : null}
    </article>
  )
}

/** Render the authoritative P6 runtime protocol without reconstructing policy from timeline messages. */
export function ProtocolPanel({ run, language = run.language }: {
  run: CollaborationRunSnapshot
  language?: CollaborationLanguage
}) {
  const { protocol } = run
  if (protocol === undefined || protocol.mode === 'legacy') {
    return (
      <section className={css.protocol} aria-labelledby="collaboration-protocol-title">
        <div className={css.heading}><div><span>{copy(language, 'protocol.eyebrow')}</span><h3 id="collaboration-protocol-title">{copy(language, 'protocol.title')}</h3></div></div>
        <div className={css.empty} role="status"><strong>{copy(language, protocol?.mode === 'legacy' ? 'protocol.legacy.title' : 'protocol.empty.title')}</strong><p>{copy(language, protocol?.mode === 'legacy' ? 'protocol.legacy.body' : 'protocol.empty.body')}</p></div>
      </section>
    )
  }

  const limits = protocol.limits
  const totalExpertMessages = protocol.members.reduce((sum, member) => sum + member.usedMessages, 0)
  const totalCapacity = limits === null ? 0 : limits.maxMessagesPerExpert * protocol.members.length
  const invalidShape = protocol.topology === null || limits === null
  const totalViolation = invalidShape || totalExpertMessages < 0 || limits.maxMessagesPerExpert < 0
    || limits.maxChallengeRounds < 0 || totalExpertMessages > totalCapacity
  return (
    <section className={css.protocol} aria-labelledby="collaboration-protocol-title">
      <header className={css.heading}>
        <div><span>{copy(language, 'protocol.eyebrow')}</span><h3 id="collaboration-protocol-title">{copy(language, 'protocol.title')}</h3></div>
        <span className={css.topology} data-protocol-topology>{protocol.topology === null ? copy(language, 'protocol.unavailable') : copy(language, `topology.${protocol.topology}`)}</span>
      </header>
      <p className={css.authority}>{copy(language, 'protocol.authoritative')}</p>

      <div className={css.summaryGrid} data-protocol-summary>
        <section className={css.rulePanel} aria-labelledby="protocol-runtime-rules">
          <div className={css.panelHeading}><div><span className={css.enforcedMark}>{copy(language, 'protocol.enforced')}</span><h4 id="protocol-runtime-rules">{copy(language, 'protocol.rules')}</h4></div></div>
          {protocol.topology === null || limits === null
            ? <p className={css.muted}>{copy(language, 'protocol.rules.unavailable')}</p>
            : <ol>
              <li data-protocol-rule><span>1</span><p>{copy(language, `protocol.topologyRule.${protocol.topology}`)}</p></li>
              <li data-protocol-rule><span>2</span><p>{copy(language, 'protocol.limitRule.challenge', { count: limits.maxChallengeRounds })}</p></li>
              <li data-protocol-rule><span>3</span><p>{copy(language, 'protocol.limitRule.messages', { count: limits.maxMessagesPerExpert })}</p></li>
            </ol>}
        </section>
        <section className={css.budgetPanel} aria-labelledby="protocol-budget-title" data-protocol-budget>
          <div className={css.panelHeading}><div><span>{copy(language, 'protocol.liveUsage')}</span><h4 id="protocol-budget-title">{copy(language, 'protocol.budget.title')}</h4></div></div>
          <dl>
            <div><dt>{copy(language, 'protocol.maxRounds')}</dt><dd>{limits?.maxChallengeRounds ?? '-'}</dd></div>
            <div><dt>{copy(language, 'protocol.maxMessages')}</dt><dd>{limits?.maxMessagesPerExpert ?? '-'}</dd></div>
            <div><dt>{copy(language, 'protocol.totalMessages')}</dt><dd>{totalExpertMessages} / {limits === null ? '-' : totalCapacity}</dd></div>
          </dl>
          {totalViolation ? <p className={css.violation} role="alert">{copy(language, 'protocol.violation.total')}</p> : null}
        </section>
      </div>

      <p className={css.explainer}><span>{copy(language, 'protocol.explanatory')}</span>{copy(language, 'protocol.explanatory.body')}</p>

      <section className={css.section} aria-labelledby="protocol-members-title" data-protocol-members>
        <div className={css.sectionHeading}><div><span>{copy(language, 'protocol.members.eyebrow')}</span><h4 id="protocol-members-title">{copy(language, 'protocol.members.title')}</h4></div><strong>{protocol.members.length}</strong></div>
        {protocol.members.length === 0
          ? <p className={css.sectionEmpty}>{copy(language, 'protocol.members.empty')}</p>
          : limits === null ? <p className={css.sectionEmpty}>{copy(language, 'protocol.rules.unavailable')}</p> : <div className={css.memberGrid}>{protocol.members.map(member => <MemberCard key={member.slotId} member={member} maximum={limits.maxMessagesPerExpert} run={run} language={language} />)}</div>}
      </section>

      <section className={css.section} aria-labelledby="protocol-challenges-title" data-protocol-challenges>
        <div className={css.sectionHeading}><div><span>{copy(language, 'protocol.challenges.eyebrow')}</span><h4 id="protocol-challenges-title">{copy(language, 'protocol.challenges.title')}</h4></div><strong>{protocol.challenges.length}</strong></div>
        {protocol.challenges.length === 0
          ? <p className={css.sectionEmpty}>{copy(language, 'protocol.challenges.empty')}</p>
          : limits === null ? <p className={css.sectionEmpty}>{copy(language, 'protocol.rules.unavailable')}</p> : <div className={css.challengeGrid}>{protocol.challenges.map(thread => <ChallengeCard key={thread.challengeId} thread={thread} maximum={limits.maxChallengeRounds} run={run} language={language} />)}</div>}
      </section>
    </section>
  )
}
