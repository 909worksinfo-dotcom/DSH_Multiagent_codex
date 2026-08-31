import { useState } from 'react'
import { collaborationCopy as copy } from './language.ts'
import type {
  CollaborationArtifact, CollaborationControllerRecommendedAction,
  CollaborationDecision, CollaborationLanguage,
  CollaborationQualityGate, CollaborationRunSnapshot,
} from './types.ts'
import css from './P5Panels.module.css'

type BlackboardView = 'artifacts' | 'decisions' | 'quality'

function displayTime(timestamp: number, language: CollaborationLanguage): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function LedgerMetric({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'error' | 'success' | undefined }) {
  return <div className={css.ledgerMetric} data-tone={tone}><dt>{label}</dt><dd>{value}</dd></div>
}

function recommendedActionLabel(
  action: CollaborationControllerRecommendedAction,
  language: CollaborationLanguage,
): string {
  return copy(language, `controller.recommendation.${action}`)
}

/** Render authoritative health signals separately from recorded Lead interventions. */
export function ControllerPanel({ run }: { run: CollaborationRunSnapshot }) {
  const { controller, language, progress } = run
  return (
    <section className={css.controller} aria-labelledby="lead-controller-title">
      <header className={css.heading}>
        <div><span className={css.eyebrow}>{copy(language, 'controller.eyebrow')}</span><h3 id="lead-controller-title">{copy(language, 'controller.title')}</h3></div>
        <div className={css.health} data-health={controller.health} aria-live="polite">
          <small>{copy(language, 'controller.health')}</small>
          <strong>{copy(language, `controller.health.${controller.health}`)}</strong>
        </div>
      </header>

      <div className={css.controllerGrid}>
        <section className={css.signalPanel} aria-labelledby="automatic-detection-title">
          <div className={css.panelTitle}>
            <div><h4 id="automatic-detection-title">{copy(language, 'controller.detected')}</h4><p>{copy(language, 'controller.detected.hint')}</p></div>
            <time dateTime={controller.lastProgressAt <= 0 ? undefined : new Date(controller.lastProgressAt).toISOString()}>
              {copy(language, 'controller.lastProgress')}: {controller.lastProgressAt <= 0 ? copy(language, 'controller.noProgress') : displayTime(controller.lastProgressAt, language)}
            </time>
          </div>
          <dl className={css.signalGrid}>
            <LedgerMetric label={copy(language, 'controller.stalledTasks')} value={controller.stalledTaskIds.length} tone={controller.stalledTaskIds.length > 0 ? 'warning' : undefined} />
            <LedgerMetric label={copy(language, 'controller.duplicateWork')} value={controller.duplicateWorkCount} tone={controller.duplicateWorkCount > 0 ? 'warning' : undefined} />
            <LedgerMetric label={copy(language, 'controller.qualityFailures')} value={controller.qualityFailureCount} tone={controller.qualityFailureCount > 0 ? 'error' : undefined} />
          </dl>
          {controller.stalledTaskIds.length > 0 ? (
            <div className={css.idList}>{controller.stalledTaskIds.map(id => <code key={id}>{id}</code>)}</div>
          ) : null}
          <div className={css.actionBlock}>
            <h5>{copy(language, 'controller.recommendations')}</h5>
            {controller.recommendedActions.length === 0
              ? <p className={css.emptyLine}>{copy(language, 'controller.recommendations.empty')}</p>
              : <ol>{controller.recommendedActions.map((action, index) => (
                <li key={`${index}-${action}`}>{recommendedActionLabel(action, language)}</li>
              ))}</ol>}
          </div>
        </section>

        <section className={css.actionPanel} aria-labelledby="lead-actions-title">
          <div className={css.panelTitle}><div><h4 id="lead-actions-title">{copy(language, 'controller.actions')}</h4><p>{copy(language, 'controller.actions.hint')}</p></div><span aria-hidden="true">L</span></div>
          {controller.actionsTaken.length === 0
            ? <p className={css.emptyLine}>{copy(language, 'controller.actions.empty')}</p>
            : <ol className={css.actionsTaken}>{controller.actionsTaken.map((action, index) => {
              const decision = run.decisions.find(value => value.id === action)
              return <li key={`${index}-${action}`}><span>{index + 1}</span><p>{decision?.summary ?? action}</p></li>
            })}</ol>}
        </section>
      </div>

      <section className={css.taskLedger} aria-labelledby="task-progress-ledger-title">
        <div className={css.panelTitle}><div><h4 id="task-progress-ledger-title">{copy(language, 'controller.taskLedger')}</h4><p>{copy(language, 'progress.summary', { completed: progress.completed, total: progress.total })}</p></div></div>
        <dl className={css.ledgerGrid}>
          <LedgerMetric label={copy(language, 'progress.inProgress')} value={progress.inProgress} />
          <LedgerMetric label={copy(language, 'progress.blocked')} value={progress.blocked} tone={progress.blocked > 0 ? 'warning' : undefined} />
          <LedgerMetric label={copy(language, 'progress.artifacts')} value={progress.artifactCount} />
          <LedgerMetric label={copy(language, 'progress.decisions')} value={progress.decisionCount} />
          <LedgerMetric label={copy(language, 'quality.status.passed')} value={progress.qualityGatePassed} tone="success" />
          <LedgerMetric label={copy(language, 'quality.status.failed')} value={progress.qualityGateFailed} tone={progress.qualityGateFailed > 0 ? 'error' : undefined} />
        </dl>
      </section>
    </section>
  )
}

function RelationList({ label, values }: { label: string; values: readonly string[] }) {
  if (values.length === 0) return null
  return <div className={css.relation}><dt>{label}</dt><dd>{values.map(value => <code key={value}>{value}</code>)}</dd></div>
}

function ArtifactCard({ artifact, language }: { artifact: CollaborationArtifact; language: CollaborationLanguage }) {
  return (
    <article className={css.artifactCard} data-artifact-version={`${artifact.id}@${artifact.version}`}>
      <header>
        <div><span className={css.kind}>{copy(language, `artifact.kind.${artifact.kind}`)}</span><strong>{copy(language, 'artifact.version', { version: artifact.version })}</strong></div>
        <span className={css.state} data-state={artifact.status}>{copy(language, `artifact.status.${artifact.status}`)}</span>
      </header>
      <h4>{artifact.title}</h4>
      <dl className={css.metadata}>
        <div><dt>{copy(language, 'artifact.author')}</dt><dd>{artifact.author.name}</dd></div>
        <div><dt>{copy(language, 'artifact.mediaType')}</dt><dd><code>{artifact.mediaType}</code></dd></div>
        <div><dt>{copy(language, 'artifact.updated')}</dt><dd><time dateTime={new Date(artifact.updatedAt).toISOString()}>{displayTime(artifact.updatedAt, language)}</time></dd></div>
        <RelationList label={copy(language, 'artifact.tasks')} values={artifact.taskIds} />
      </dl>
    </article>
  )
}

function DecisionCard({ decision, language }: { decision: CollaborationDecision; language: CollaborationLanguage }) {
  return (
    <article className={css.decisionCard} data-decision-version={`${decision.id}@${decision.version}`}>
      <header><span className={css.state} data-state={decision.outcome}>{copy(language, `decision.outcome.${decision.outcome}`)}</span><small>{copy(language, 'decision.version', { version: decision.version })}</small></header>
      <h4>{decision.subject}</h4>
      <div className={css.decisionText}><strong>{copy(language, 'decision.summary')}</strong><p>{decision.summary}</p></div>
      <div className={css.decisionText}><strong>{copy(language, 'decision.rationale')}</strong><p>{decision.rationale}</p></div>
      <dl className={css.metadata}>
        <div><dt>{copy(language, 'decision.lead')}</dt><dd>{decision.lead.name}</dd></div>
        <div><dt>{copy(language, 'artifact.updated')}</dt><dd><time dateTime={new Date(decision.createdAt).toISOString()}>{displayTime(decision.createdAt, language)}</time></dd></div>
        <RelationList label={copy(language, 'artifact.tasks')} values={decision.taskIds} />
        <RelationList label={copy(language, 'decision.artifacts')} values={decision.artifactIds} />
      </dl>
    </article>
  )
}

function QualityCard({ gate, language }: { gate: CollaborationQualityGate; language: CollaborationLanguage }) {
  return (
    <article className={css.qualityCard} data-quality-status={gate.status}>
      <header><span className={css.state} data-state={gate.status}>{copy(language, `quality.status.${gate.status}`)}</span><small>{copy(language, 'quality.version', { version: gate.version })}</small></header>
      <h4>{gate.name}</h4>
      <p>{gate.summary}</p>
      <dl className={css.metadata}>
        <div><dt>{copy(language, 'quality.reviewer')}</dt><dd>{gate.reviewer?.name ?? copy(language, 'quality.unassigned')}</dd></div>
        <div><dt>{copy(language, 'artifact.updated')}</dt><dd><time dateTime={new Date(gate.updatedAt).toISOString()}>{displayTime(gate.updatedAt, language)}</time></dd></div>
        {gate.taskId === undefined ? null : <RelationList label={copy(language, 'quality.task')} values={[gate.taskId]} />}
        {gate.artifactId === undefined ? null : <RelationList label={copy(language, 'quality.artifact')} values={[gate.artifactId]} />}
      </dl>
    </article>
  )
}

function FinalProvenance({ run }: { run: CollaborationRunSnapshot }) {
  if (run.status !== 'completed') return null
  const acceptedArtifacts = run.artifacts.filter(artifact => artifact.status === 'accepted')
  const passedGates = run.qualityGates.filter(gate => gate.status === 'passed')
  const acceptedDecisions = run.decisions.filter(decision => decision.outcome === 'accepted')
  const reviewers = new Set(passedGates.flatMap(gate => gate.reviewer === undefined ? [] : [gate.reviewer.sessionId]))
  return (
    <section className={css.provenance} aria-labelledby="delivery-provenance-title" data-delivery-provenance="true">
      <div><span className={css.eyebrow}>{copy(run.language, 'provenance.eyebrow')}</span><h4 id="delivery-provenance-title">{copy(run.language, 'provenance.title')}</h4></div>
      <dl>
        <LedgerMetric label={copy(run.language, 'provenance.tasks')} value={run.tasks.filter(task => task.status === 'completed').length} tone="success" />
        <LedgerMetric label={copy(run.language, 'provenance.artifacts')} value={acceptedArtifacts.length} tone="success" />
        <LedgerMetric label={copy(run.language, 'provenance.reviews')} value={reviewers.size} tone="success" />
        <LedgerMetric label={copy(run.language, 'provenance.gates')} value={passedGates.length} tone="success" />
        <LedgerMetric label={copy(run.language, 'provenance.decisions')} value={acceptedDecisions.length} tone="success" />
      </dl>
    </section>
  )
}

/** Render the authoritative Team Blackboard without deriving records from timeline prose. */
export function BlackboardPanel({ run }: { run: CollaborationRunSnapshot }) {
  const [view, setView] = useState<BlackboardView>('artifacts')
  const language = run.language
  const artifacts = [...run.artifacts].sort((left, right) => right.updatedAt - left.updatedAt || right.version - left.version)
  const decisions = [...run.decisions].sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)
  const gates = [...run.qualityGates].sort((left, right) => right.updatedAt - left.updatedAt || right.version - left.version)
  return (
    <section className={css.blackboard} aria-labelledby="team-blackboard-title">
      <header className={css.heading}>
        <div><span className={css.eyebrow}>{copy(language, 'blackboard.eyebrow')}</span><h3 id="team-blackboard-title">{copy(language, 'blackboard.title')}</h3></div>
        <div className={css.blackboardCounts}>
          <span>{run.artifacts.length}</span><span>{run.decisions.length}</span><span>{run.qualityGates.length}</span>
        </div>
      </header>
      <p className={css.authorityNotice}><span aria-hidden="true">◎</span>{copy(language, 'blackboard.authoritative')}</p>
      <FinalProvenance run={run} />
      <div className={css.blackboardNav} role="group" aria-label={copy(language, 'blackboard.views')}>
        {(['artifacts', 'decisions', 'quality'] as const).map(value => (
          <button type="button" key={value} aria-pressed={view === value} onClick={() => { setView(value) }}>
            {copy(language, `blackboard.${value}`)}
          </button>
        ))}
      </div>
      {view === 'artifacts' ? <p className={css.metadataNotice}>{copy(language, 'blackboard.metadataOnly')}</p> : null}
      <div className={css.records} data-blackboard-view={view}>
        {view === 'artifacts' && artifacts.length === 0 ? <p className={css.empty}>{copy(language, 'blackboard.empty.artifacts')}</p> : null}
        {view === 'artifacts' ? artifacts.map(artifact => <ArtifactCard key={`${artifact.id}@${artifact.version}`} artifact={artifact} language={language} />) : null}
        {view === 'decisions' && decisions.length === 0 ? <p className={css.empty}>{copy(language, 'blackboard.empty.decisions')}</p> : null}
        {view === 'decisions' ? decisions.map(decision => <DecisionCard key={`${decision.id}@${decision.version}`} decision={decision} language={language} />) : null}
        {view === 'quality' && gates.length === 0 ? <p className={css.empty}>{copy(language, 'blackboard.empty.quality')}</p> : null}
        {view === 'quality' ? gates.map(gate => <QualityCard key={`${gate.id}@${gate.version}`} gate={gate} language={language} />) : null}
      </div>
    </section>
  )
}
