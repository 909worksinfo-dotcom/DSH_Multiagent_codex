import { describe, expect, it } from 'vitest'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'

describe('P5 collaboration preview fixture', () => {
  it('covers one-expert formation and an eight-expert running team', () => {
    const runs = createDemoRuns()
    const forming = runs.find(run => run.status === 'forming')
    const running = runs.find(run => run.status === 'running')

    expect(forming?.expertCounts).toMatchObject({ planned: 3, provisioning: 3, active: 0 })
    expect(forming?.experts).toHaveLength(3)
    expect(running?.expertCounts).toMatchObject({ planned: 8, active: 8 })
    expect(running?.experts).toHaveLength(8)
    expect(running?.controller).toMatchObject({ health: 'stalled', stalledTaskIds: ['task-3'] })
    expect(running?.artifacts).toHaveLength(3)
    expect(running?.qualityGates.map(gate => gate.status)).toContain('failed')
  })

  it('keeps completed provenance ledgers authoritative and versioned', () => {
    const completed = createDemoRuns().find(run => run.status === 'completed')!

    expect(completed.controller.health).toBe('ready')
    expect(completed.artifacts.every(artifact => artifact.version >= 1 && artifact.status === 'accepted')).toBe(true)
    expect(completed.qualityGates.every(gate => gate.status === 'passed')).toBe(true)
    expect(completed.progress).toMatchObject({ artifactCount: 4, decisionCount: 1, qualityGatePassed: 3 })
  })

  it('retries formation by creating a new TeamRun without mutating the failed audit terminal', async () => {
    const port = createCollaborationDemoPort()
    const before = port.source.getSnapshot()
    const failed = before.runs.find(run => run.status === 'team_formation_failed')
    expect(failed).toBeDefined()

    const newId = await port.retryFormation(failed!.id)
    const after = port.source.getSnapshot()
    expect(after.runs).toHaveLength(before.runs.length + 1)
    expect(after.runs.find(run => run.id === failed!.id)).toBe(failed)
    expect(after.runs.find(run => run.id === failed!.id)?.status).toBe('team_formation_failed')
    expect(after.runs.find(run => run.id === newId)).toMatchObject({ status: 'forming', phase: 'provisioning' })
  })
})
