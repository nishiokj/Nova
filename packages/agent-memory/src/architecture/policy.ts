import type { ArchitectureAlertRecord } from '../db/repositories/architecture.js'

export interface ArchitecturePolicyConfig {
  warnAfter: number
  blockAfter: number
  runWindow: number
  maxExamples: number
}

export const DEFAULT_ARCHITECTURE_POLICY_CONFIG: ArchitecturePolicyConfig = {
  warnAfter: 2,
  blockAfter: 3,
  runWindow: 6,
  maxExamples: 12,
}

export interface ArchitecturePolicyRunSnapshot {
  runId: string
  alerts: ArchitectureAlertRecord[]
}

export interface ArchitecturePolicyStreak {
  key: string
  streak: number
  latestAlert: Pick<ArchitectureAlertRecord,
    'id' | 'alertType' | 'title' | 'severity' | 'concernId' | 'leftConcernId' | 'rightConcernId' | 'filePath' | 'score' | 'threshold'>
}

export interface ArchitecturePolicyResult {
  decision: 'allow' | 'warn' | 'block'
  latestRunId: string | null
  runIdsEvaluated: string[]
  warnAfter: number
  blockAfter: number
  latestCriticalCount: number
  maxObservedStreak: number
  repeatedCritical: ArchitecturePolicyStreak[]
  summary: string
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

export function architectureAlertKey(
  alert: Pick<ArchitectureAlertRecord, 'alertType' | 'concernId' | 'leftConcernId' | 'rightConcernId' | 'filePath'>
): string {
  return [
    alert.alertType,
    alert.concernId ?? '',
    alert.leftConcernId ?? '',
    alert.rightConcernId ?? '',
    alert.filePath ?? '',
  ].join('|')
}

export function evaluateArchitecturePolicy(
  runs: ArchitecturePolicyRunSnapshot[],
  config: Partial<ArchitecturePolicyConfig> = {}
): ArchitecturePolicyResult {
  const warnAfter = clampPositiveInt(config.warnAfter ?? DEFAULT_ARCHITECTURE_POLICY_CONFIG.warnAfter, DEFAULT_ARCHITECTURE_POLICY_CONFIG.warnAfter)
  const blockAfter = Math.max(warnAfter, clampPositiveInt(config.blockAfter ?? DEFAULT_ARCHITECTURE_POLICY_CONFIG.blockAfter, DEFAULT_ARCHITECTURE_POLICY_CONFIG.blockAfter))
  const runWindow = clampPositiveInt(config.runWindow ?? DEFAULT_ARCHITECTURE_POLICY_CONFIG.runWindow, DEFAULT_ARCHITECTURE_POLICY_CONFIG.runWindow)
  const maxExamples = clampPositiveInt(config.maxExamples ?? DEFAULT_ARCHITECTURE_POLICY_CONFIG.maxExamples, DEFAULT_ARCHITECTURE_POLICY_CONFIG.maxExamples)

  const considered = runs.slice(0, runWindow)
  const latest = considered[0]
  if (!latest) {
    return {
      decision: 'allow',
      latestRunId: null,
      runIdsEvaluated: [],
      warnAfter,
      blockAfter,
      latestCriticalCount: 0,
      maxObservedStreak: 0,
      repeatedCritical: [],
      summary: 'No successful architecture runs available',
    }
  }

  const keySetsByRun: Array<{ runId: string; keys: Set<string>; byKey: Map<string, ArchitectureAlertRecord> }> = considered.map((entry) => {
    const keys = new Set<string>()
    const byKey = new Map<string, ArchitectureAlertRecord>()
    for (const alert of entry.alerts) {
      const key = architectureAlertKey(alert)
      keys.add(key)
      if (!byKey.has(key)) {
        byKey.set(key, alert)
      }
    }
    return {
      runId: entry.runId,
      keys,
      byKey,
    }
  })

  const latestSet = keySetsByRun[0]
  const streaks: ArchitecturePolicyStreak[] = []

  for (const key of latestSet.keys) {
    let streak = 0
    for (const run of keySetsByRun) {
      if (!run.keys.has(key)) break
      streak += 1
    }

    const latestAlert = latestSet.byKey.get(key)
    if (!latestAlert) continue
    streaks.push({
      key,
      streak,
      latestAlert: {
        id: latestAlert.id,
        alertType: latestAlert.alertType,
        title: latestAlert.title,
        severity: latestAlert.severity,
        concernId: latestAlert.concernId,
        leftConcernId: latestAlert.leftConcernId,
        rightConcernId: latestAlert.rightConcernId,
        filePath: latestAlert.filePath,
        score: latestAlert.score,
        threshold: latestAlert.threshold,
      },
    })
  }

  streaks.sort((a, b) => {
    if (b.streak !== a.streak) return b.streak - a.streak
    if (b.latestAlert.score !== a.latestAlert.score) return b.latestAlert.score - a.latestAlert.score
    return a.key.localeCompare(b.key)
  })

  const maxObservedStreak = streaks.length > 0 ? streaks[0].streak : 0
  const repeatedCritical = streaks.filter((item) => item.streak >= warnAfter).slice(0, maxExamples)

  let decision: ArchitecturePolicyResult['decision'] = 'allow'
  if (streaks.some((item) => item.streak >= blockAfter)) {
    decision = 'block'
  } else if (streaks.some((item) => item.streak >= warnAfter)) {
    decision = 'warn'
  }

  const summary = decision === 'block'
    ? `Blocking due to repeated critical architecture alerts (streak >= ${blockAfter})`
    : decision === 'warn'
      ? `Warning: repeated critical architecture alerts detected (streak >= ${warnAfter})`
      : 'No repeated critical architecture alerts beyond policy thresholds'

  return {
    decision,
    latestRunId: latest.runId,
    runIdsEvaluated: considered.map((entry) => entry.runId),
    warnAfter,
    blockAfter,
    latestCriticalCount: latest.alerts.length,
    maxObservedStreak,
    repeatedCritical,
    summary,
  }
}
