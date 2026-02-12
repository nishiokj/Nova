import type { ArchitectureAlertRecord } from 'agent-memory/db/repositories/architecture.js'
import { architectureAlertKey, evaluateArchitecturePolicy } from 'agent-memory/architecture/policy.js'

function makeAlert(overrides: Partial<ArchitectureAlertRecord> = {}): ArchitectureAlertRecord {
  return {
    id: overrides.id ?? 'alert-1',
    runId: overrides.runId ?? 'run-1',
    alertType: overrides.alertType ?? 'leaky_boundary',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'open',
    concernId: overrides.concernId ?? null,
    leftConcernId: overrides.leftConcernId ?? 'concern.a',
    rightConcernId: overrides.rightConcernId ?? 'concern.b',
    filePath: overrides.filePath ?? null,
    score: overrides.score ?? 0.9,
    threshold: overrides.threshold ?? 0.65,
    title: overrides.title ?? 'Leaky boundary',
    description: overrides.description ?? 'Boundary pressure persisted',
    evidence: overrides.evidence ?? {},
    note: overrides.note ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    resolvedAt: overrides.resolvedAt ?? null,
  }
}

describe('architecture policy', () => {
  it('builds deterministic alert keys', () => {
    const key = architectureAlertKey(makeAlert({
      alertType: 'architectural_cycle',
      concernId: 'concern.api',
      leftConcernId: 'concern.api',
      rightConcernId: 'concern.db',
      filePath: 'src/api/router.ts',
    }))

    expect(key).toBe('architectural_cycle|concern.api|concern.api|concern.db|src/api/router.ts')
  })

  it('returns allow when critical alerts are not repeated', () => {
    const result = evaluateArchitecturePolicy([
      {
        runId: 'run-3',
        alerts: [makeAlert({ id: 'a3', runId: 'run-3', leftConcernId: 'concern.x', rightConcernId: 'concern.y' })],
      },
      {
        runId: 'run-2',
        alerts: [makeAlert({ id: 'a2', runId: 'run-2', leftConcernId: 'concern.m', rightConcernId: 'concern.n' })],
      },
      {
        runId: 'run-1',
        alerts: [],
      },
    ], {
      warnAfter: 2,
      blockAfter: 3,
    })

    expect(result.decision).toBe('allow')
    expect(result.maxObservedStreak).toBe(1)
  })

  it('returns warn when alert repeats at warn threshold', () => {
    const repeated = [
      makeAlert({ id: 'a3', runId: 'run-3' }),
      makeAlert({ id: 'a2', runId: 'run-2' }),
    ]

    const result = evaluateArchitecturePolicy([
      { runId: 'run-3', alerts: [repeated[0]] },
      { runId: 'run-2', alerts: [repeated[1]] },
      { runId: 'run-1', alerts: [] },
    ], {
      warnAfter: 2,
      blockAfter: 4,
    })

    expect(result.decision).toBe('warn')
    expect(result.maxObservedStreak).toBe(2)
    expect(result.repeatedCritical).toHaveLength(1)
  })

  it('returns block when alert repeats at block threshold', () => {
    const result = evaluateArchitecturePolicy([
      { runId: 'run-3', alerts: [makeAlert({ id: 'a3', runId: 'run-3' })] },
      { runId: 'run-2', alerts: [makeAlert({ id: 'a2', runId: 'run-2' })] },
      { runId: 'run-1', alerts: [makeAlert({ id: 'a1', runId: 'run-1' })] },
      { runId: 'run-0', alerts: [] },
    ], {
      warnAfter: 2,
      blockAfter: 3,
    })

    expect(result.decision).toBe('block')
    expect(result.maxObservedStreak).toBe(3)
    expect(result.summary).toContain('Blocking')
  })

  it('normalizes invalid config values to defaults', () => {
    const result = evaluateArchitecturePolicy([
      { runId: 'run-1', alerts: [] },
    ], {
      warnAfter: 0,
      blockAfter: -4,
      runWindow: Number.NaN,
      maxExamples: 0,
    })

    expect(result.warnAfter).toBe(2)
    expect(result.blockAfter).toBe(3)
    expect(result.runIdsEvaluated).toEqual(['run-1'])
  })
})
