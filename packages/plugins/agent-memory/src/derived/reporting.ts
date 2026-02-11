/**
 * Derived Run Reporting + Sanity Policy
 *
 * Provides a shared report structure for derived task runs and a policy evaluator.
 */

export type DerivedRunStatus = 'ok' | 'skipped' | 'failed'

export interface DerivedRunSample {
  label?: string
  value: unknown
}

export interface DerivedRunReport {
  status: DerivedRunStatus
  inputCount?: number
  outputCount?: number
  outputUnusableCount?: number
  modelVersion?: string
  skipReason?: string
  errorCode?: string
  errorMsg?: string
  samples: DerivedRunSample[]
}

export interface DerivedRunReporter {
  setInputCount: (count: number) => void
  setOutputCount: (count: number) => void
  setOutputUnusableCount: (count: number) => void
  setModelVersion: (version: string) => void
  addSample: (sample: DerivedRunSample) => void
  markSkipped: (reason: string) => void
  markFailed: (code: string, message: string) => void
  snapshot: () => DerivedRunReport
}

export function createDerivedRunReporter(): DerivedRunReporter {
  const report: DerivedRunReport = {
    status: 'ok',
    samples: [],
  }

  return {
    setInputCount(count) {
      report.inputCount = count
    },
    setOutputCount(count) {
      report.outputCount = count
    },
    setOutputUnusableCount(count) {
      report.outputUnusableCount = count
    },
    setModelVersion(version) {
      report.modelVersion = version
    },
    addSample(sample) {
      if (report.samples.length >= 5) return
      report.samples.push(sample)
    },
    markSkipped(reason) {
      report.status = 'skipped'
      report.skipReason = reason
    },
    markFailed(code, message) {
      report.status = 'failed'
      report.errorCode = code
      report.errorMsg = message
    },
    snapshot() {
      return { ...report, samples: [...report.samples] }
    },
  }
}

export interface DerivedSanityPolicy {
  min_input_count?: number
  min_output_count?: number
  max_output_unusable_rate?: number
  require_model_version?: boolean
  forbid_statuses?: DerivedRunStatus[]
}

export function evaluateSanityPolicy(
  policy: DerivedSanityPolicy | null | undefined,
  report: DerivedRunReport | null | undefined
): { ok: boolean; errorCode?: string; errorMsg?: string } {
  if (!policy) return { ok: true }
  if (!report) {
    return {
      ok: false,
      errorCode: 'policy_violation',
      errorMsg: 'Missing run report for sanity policy evaluation',
    }
  }

  const forbidden = policy.forbid_statuses ?? []
  if (forbidden.includes(report.status)) {
    return {
      ok: false,
      errorCode: 'policy_violation',
      errorMsg: `Run status '${report.status}' is forbidden by policy`,
    }
  }

  if (policy.require_model_version && !report.modelVersion) {
    return {
      ok: false,
      errorCode: 'policy_violation',
      errorMsg: 'Model version required by policy but missing from report',
    }
  }

  if (policy.min_input_count !== undefined) {
    const input = report.inputCount ?? 0
    if (input < policy.min_input_count) {
      return {
        ok: false,
        errorCode: 'policy_violation',
        errorMsg: `Input count ${input} below minimum ${policy.min_input_count}`,
      }
    }
  }

  if (policy.min_output_count !== undefined) {
    const output = report.outputCount ?? 0
    if (output < policy.min_output_count) {
      return {
        ok: false,
        errorCode: 'policy_violation',
        errorMsg: `Output count ${output} below minimum ${policy.min_output_count}`,
      }
    }
  }

  if (policy.max_output_unusable_rate !== undefined) {
    const output = report.outputCount ?? 0
    const unusable = report.outputUnusableCount ?? 0
    const rate = output > 0 ? unusable / output : 1
    if (rate > policy.max_output_unusable_rate) {
      return {
        ok: false,
        errorCode: 'policy_violation',
        errorMsg: `Unusable rate ${rate.toFixed(2)} exceeds max ${policy.max_output_unusable_rate}`,
      }
    }
  }

  return { ok: true }
}
