#!/usr/bin/env bun

import type { DerivedMetadataSchema, DerivedRunContext, DerivedRunResult } from '../src/derived/runner.js'
import { runArchitectureDerivation } from '../src/architecture/index.js'

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export const metadata: DerivedMetadataSchema = {
  fields: {
    lookbackDays: {
      type: 'number',
      default: 30,
      description: 'Lookback window in days for traces and runtime co-signals',
    },
    minEdgeWeight: {
      type: 'number',
      default: 0.12,
      description: 'Minimum weighted edge threshold for sparse graph retention',
    },
    strongEdgeWeight: {
      type: 'number',
      default: 0.20,
      description: 'Strong-edge threshold for initial concern components',
    },
    maxPairsPerFile: {
      type: 'number',
      default: 128,
      description: 'Maximum retained neighbor pairs per file for sparsification',
    },
    maxFiles: {
      type: 'number',
      default: 20000,
      description: 'Maximum number of files included in one architecture run',
    },
    emitAlerts: {
      type: 'boolean',
      default: false,
      description: 'Emit architecture alerts (disabled for Phase 1)',
    },
  },
}

export default async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const taskMetadata = (ctx.task.metadata ?? {}) as Record<string, unknown>
  const jobMetadata = (ctx.job.metadata ?? {}) as Record<string, unknown>

  const resolved = {
    lookbackDays: numberValue(jobMetadata.lookbackDays ?? taskMetadata.lookbackDays, 30),
    minEdgeWeight: numberValue(jobMetadata.minEdgeWeight ?? taskMetadata.minEdgeWeight, 0.12),
    strongEdgeWeight: numberValue(jobMetadata.strongEdgeWeight ?? taskMetadata.strongEdgeWeight, 0.20),
    maxPairsPerFile: numberValue(jobMetadata.maxPairsPerFile ?? taskMetadata.maxPairsPerFile, 128),
    maxFiles: numberValue(jobMetadata.maxFiles ?? taskMetadata.maxFiles, 20000),
    emitAlerts: booleanValue(jobMetadata.emitAlerts ?? taskMetadata.emitAlerts, false),
  }

  ctx.logger.info('derive-architecture-boundaries:start', resolved)
  const result = await runArchitectureDerivation(ctx.sql, resolved, ctx.logger)
  ctx.logger.info('derive-architecture-boundaries:done', {
    runId: result.runId,
    concerns: result.concernCount,
    boundaries: result.boundaryCount,
    alerts: result.alertCount,
  })

  return {
    metadata: {
      runId: result.runId,
      concernCount: result.concernCount,
      boundaryCount: result.boundaryCount,
      alertCount: result.alertCount,
      graphHash: result.graphHash,
      stats: result.stats,
      config: resolved,
    },
  }
}

