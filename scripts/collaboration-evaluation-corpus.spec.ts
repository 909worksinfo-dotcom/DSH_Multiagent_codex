import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Complexity = 'simple' | 'medium' | 'complex'
type Domain = 'research_analysis' | 'product_solution' | 'software_development'

interface EvaluationCase {
  readonly id: string
  readonly domain: Domain
  readonly complexity: Complexity
  readonly title: string
  readonly objective: string
  readonly requiredCapabilities: string[]
  readonly allowedTopologies: string[]
  readonly requiredPublicEvents: string[]
  readonly requiredArtifacts: string[]
  readonly failureInjections: string[]
  readonly rubric: string[]
}

interface EvaluationCorpus {
  readonly version: number
  readonly teamPolicy: {
    readonly alwaysCreateTeam: boolean
    readonly leadCount: number
    readonly expertBands: Record<Complexity, [number, number]>
    readonly maxActiveExperts: number
    readonly maxProvisionAttempts: number
    readonly silentSoloFallback: boolean
  }
  readonly runtimeContract: {
    readonly authority: string
    readonly internalLifecycle: string[]
    readonly terminalStates: string[]
    readonly publicSnapshotStatuses: string[]
    readonly hostOperations: string[]
    readonly errorCodes: string[]
  }
  readonly visibilityPolicy: {
    readonly publicEventTypes: string[]
    readonly forbiddenPublicContent: string[]
  }
  readonly cases: EvaluationCase[]
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/collaboration-evaluation-corpus.json', import.meta.url), 'utf8'),
) as EvaluationCorpus

const complexities: readonly Complexity[] = ['simple', 'medium', 'complex']
const domains: readonly Domain[] = ['research_analysis', 'product_solution', 'software_development']

describe('collaboration evaluation corpus', () => {
  it('pins the mandatory team size and visibility policies', () => {
    expect(corpus.version).toBe(1)
    expect(corpus.teamPolicy).toEqual({
      alwaysCreateTeam: true,
      leadCount: 1,
      expertBands: {
        simple: [1, 1],
        medium: [2, 4],
        complex: [5, 8],
      },
      maxActiveExperts: 8,
      maxProvisionAttempts: 12,
      silentSoloFallback: false,
    })
    expect(corpus.visibilityPolicy.forbiddenPublicContent).toEqual([
      'private_reasoning',
      'chain_of_thought',
    ])
  })

  it('pins the durable authority, lifecycle, host operations, and initial failures', () => {
    expect(corpus.runtimeContract).toEqual({
      authority: 'lead_session_event_log',
      internalLifecycle: [
        'profiling',
        'planning',
        'provisioning',
        'active',
        'completing',
        'completed',
      ],
      terminalStates: ['formation_failed', 'failed', 'cancelled'],
      publicSnapshotStatuses: [
        'forming',
        'running',
        'blocked',
        'reviewing',
        'reworking',
        'completed',
        'team_formation_failed',
        'failed',
        'cancelled',
      ],
      hostOperations: [
        'collaboration.create',
        'collaboration.list',
        'collaboration.get',
        'collaboration.events',
        'collaboration.send',
        'collaboration.retryFormation',
        'collaboration.terminate',
        'collaboration.readArtifact',
      ],
      errorCodes: [
        'TEAM_MEMBER_LIMIT',
        'FORMATION_FAILED',
        'CAPABILITY_UNAVAILABLE',
        'BLUEPRINT_REVISION_MISMATCH',
        'RESOURCE_CONFLICT',
        'STALE_REVISION',
        'DELIVERY_FAILED',
      ],
    })
  })

  it('contains ten cases per domain with a three-four-three complexity distribution', () => {
    expect(corpus.cases).toHaveLength(30)
    for (const domain of domains) {
      const domainCases = corpus.cases.filter(item => item.domain === domain)
      expect(domainCases, domain).toHaveLength(10)
      expect(domainCases.filter(item => item.complexity === 'simple'), domain).toHaveLength(3)
      expect(domainCases.filter(item => item.complexity === 'medium'), domain).toHaveLength(4)
      expect(domainCases.filter(item => item.complexity === 'complex'), domain).toHaveLength(3)
    }
  })

  it('gives every case a unique executable acceptance definition', () => {
    expect(new Set(corpus.cases.map(item => item.id)).size).toBe(corpus.cases.length)
    for (const item of corpus.cases) {
      expect(item.id).toMatch(/^(research|product|software)-(simple|medium|complex)-\d{2}$/u)
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.objective.trim().length).toBeGreaterThan(0)
      expect(item.requiredCapabilities.length).toBeGreaterThanOrEqual(2)
      expect(item.requiredArtifacts.length).toBeGreaterThan(0)
      expect(item.rubric).toHaveLength(4)
      expect(item.requiredPublicEvents).toContain('task')
      expect(item.requiredPublicEvents).toContain('decision')
      expect(item.requiredPublicEvents).toContain('artifact')
      expect(item.requiredPublicEvents).toContain('final_delivery')
      for (const event of item.requiredPublicEvents) {
        expect(corpus.visibilityPolicy.publicEventTypes, `${item.id}:${event}`).toContain(event)
      }
    }
  })

  it('binds each complexity to its intended collaboration topology and expert band', () => {
    const topologyByComplexity: Record<Complexity, readonly string[]> = {
      simple: ['producer_reviewer'],
      medium: ['centralized', 'parallel'],
      complex: ['hybrid', 'grouped'],
    }
    for (const complexity of complexities) {
      const [minimum, maximum] = corpus.teamPolicy.expertBands[complexity]
      expect(minimum).toBeGreaterThanOrEqual(1)
      expect(maximum).toBeLessThanOrEqual(corpus.teamPolicy.maxActiveExperts)
      for (const item of corpus.cases.filter(entry => entry.complexity === complexity)) {
        expect(item.allowedTopologies.length).toBeGreaterThan(0)
        for (const topology of item.allowedTopologies) {
          expect(topologyByComplexity[complexity], `${item.id}:${topology}`).toContain(topology)
        }
        if (complexity !== 'simple') {
          expect(item.requiredPublicEvents).toContain('challenge')
          expect(item.requiredPublicEvents).toContain('response')
        }
      }
    }
  })

  it('covers the required local failure rehearsals', () => {
    const covered = new Set(corpus.cases.flatMap(item => item.failureInjections))
    const requiredFailures = [
      'expert_provision_failure',
      'missing_capability',
      'tool_timeout',
      'malformed_structured_output',
      'duplicate_event',
      'cas_conflict',
      'discussion_limit',
      'missing_required_artifact',
      'process_restart',
      'client_reconnect',
      'user_cancel',
      'expert_stall',
    ]
    expect([...covered].sort()).toEqual(requiredFailures.sort())
  })
})
