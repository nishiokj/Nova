import os from 'os';
import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type {
  AgentType,
  Anomaly,
  AnomalyThresholds,
  AnomalyType,
  HealthMetrics,
  RecoveryAction,
  RecoveryPlan,
} from './types.js';

export class HealthCollector {
  private metrics: HealthMetrics;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleAt = Date.now();
  private restartCount = 0;
  private lastRestartReason?: string;
  private graphdLatencyMs = 0;

  constructor(private readonly logger: Logger, sessionVersion = 'v000') {
    this.metrics = {
      process: {
        pid: process.pid,
        uptime_ms: 0,
        memory_rss_bytes: 0,
        memory_heap_used_bytes: 0,
        cpu_percent: 0,
        restart_count: 0,
        last_restart_reason: undefined,
      },
      iteration: {
        current: 0,
        total_completed: 0,
        avg_duration_ms: 0,
        last_duration_ms: 0,
        consecutive_failures: 0,
        consecutive_no_progress: 0,
      },
      agents: {
        principal: this.createAgentMetrics(),
        oncall: this.createAgentMetrics(),
        testing: this.createAgentMetrics(),
        coding: this.createAgentMetrics(),
        research: this.createAgentMetrics(),
      },
      benchmark: {
        last_run_at: 0,
        last_score: 0,
        baseline_score: 0,
        improvement_percent: 0,
        regression_count: 0,
        tests_passing: 0,
        tests_failing: 0,
      },
      worktree: {
        current_version: sessionVersion,
        wip_version: '',
        total_versions: 0,
        rollback_count: 0,
        disk_usage_bytes: 0,
      },
      persistence: {
        last_checkpoint_at: 0,
        checkpoint_count: 0,
        patch_count: 0,
        decision_count: 0,
        graphd_latency_ms: 0,
        graphd_available: true,
      },
      logging: {
        file_path: null,
        file_size_bytes: 0,
      },
    };
  }

  private createAgentMetrics() {
    return {
      invocations: 0,
      failures: 0,
      avg_tokens_in: 0,
      avg_tokens_out: 0,
      avg_tool_calls: 0,
      context_compactions: 0,
      last_error: undefined as string | undefined,
    };
  }

  recordAgentInvocation(
    agent: AgentType,
    result: {
      success: boolean;
      tokens_in: number;
      tokens_out: number;
      tool_calls: number;
      error?: string;
    }
  ): void {
    const metrics = this.metrics.agents[agent];
    metrics.invocations += 1;
    if (!result.success) {
      metrics.failures += 1;
    }
    metrics.avg_tokens_in = this.rollingAvg(metrics.avg_tokens_in, result.tokens_in, metrics.invocations);
    metrics.avg_tokens_out = this.rollingAvg(metrics.avg_tokens_out, result.tokens_out, metrics.invocations);
    metrics.avg_tool_calls = this.rollingAvg(metrics.avg_tool_calls, result.tool_calls, metrics.invocations);
    if (result.error) {
      metrics.last_error = result.error;
    }
  }

  recordContextCompaction(agent: AgentType): void {
    this.metrics.agents[agent].context_compactions += 1;
  }

  recordIteration(durationMs: number, success: boolean, progressMade: boolean): void {
    this.metrics.iteration.current += 1;
    this.metrics.iteration.total_completed += 1;
    this.metrics.iteration.last_duration_ms = durationMs;
    this.metrics.iteration.avg_duration_ms = this.rollingAvg(
      this.metrics.iteration.avg_duration_ms,
      durationMs,
      this.metrics.iteration.total_completed
    );

    if (!success) {
      this.metrics.iteration.consecutive_failures += 1;
    } else {
      this.metrics.iteration.consecutive_failures = 0;
    }

    if (!progressMade) {
      this.metrics.iteration.consecutive_no_progress += 1;
    } else {
      this.metrics.iteration.consecutive_no_progress = 0;
    }
  }

  recordBenchmark(score: number, baseline: number, passed: number, failed: number): void {
    this.metrics.benchmark.last_run_at = Date.now();
    this.metrics.benchmark.last_score = score;
    this.metrics.benchmark.baseline_score = baseline;
    this.metrics.benchmark.improvement_percent = baseline > 0 ? (score - baseline) / baseline : 0;
    this.metrics.benchmark.tests_passing = passed;
    this.metrics.benchmark.tests_failing = failed;
  }

  recordWorktree(currentVersion: string, wipVersion: string, totalVersions: number, rollbackCount: number): void {
    this.metrics.worktree.current_version = currentVersion;
    this.metrics.worktree.wip_version = wipVersion;
    this.metrics.worktree.total_versions = totalVersions;
    this.metrics.worktree.rollback_count = rollbackCount;
  }

  recordCheckpoint(timestamp: number, checkpointCount: number, patchCount: number, decisionCount: number): void {
    this.metrics.persistence.last_checkpoint_at = timestamp;
    this.metrics.persistence.checkpoint_count = checkpointCount;
    this.metrics.persistence.patch_count = patchCount;
    this.metrics.persistence.decision_count = decisionCount;
  }

  recordGraphdLatency(latencyMs: number, available = true): void {
    this.graphdLatencyMs = latencyMs;
    this.metrics.persistence.graphd_latency_ms = latencyMs;
    this.metrics.persistence.graphd_available = available;
  }

  recordLogFile(filePath: string | null, sizeBytes: number): void {
    this.metrics.logging.file_path = filePath;
    this.metrics.logging.file_size_bytes = sizeBytes;
  }

  incrementRestart(reason?: string): void {
    this.restartCount += 1;
    this.lastRestartReason = reason;
  }

  async collectSnapshot(): Promise<HealthMetrics> {
    this.metrics.process = await this.collectProcessMetrics();
    this.logger.debug('[health] Snapshot collected', {
      iteration: this.metrics.iteration.current,
      memory_heap_used_bytes: this.metrics.process.memory_heap_used_bytes,
    });
    return { ...this.metrics };
  }

  private async collectProcessMetrics(): Promise<HealthMetrics['process']> {
    const usage = process.memoryUsage();
    return {
      pid: process.pid,
      uptime_ms: process.uptime() * 1000,
      memory_rss_bytes: usage.rss,
      memory_heap_used_bytes: usage.heapUsed,
      cpu_percent: await this.getCpuPercent(),
      restart_count: this.restartCount,
      last_restart_reason: this.lastRestartReason,
    };
  }

  private async getCpuPercent(): Promise<number> {
    const now = Date.now();
    const elapsedMs = now - this.lastCpuSampleAt;
    const usage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAt = now;

    const totalUsageMs = (usage.user + usage.system) / 1000;
    if (elapsedMs === 0) return 0;
    const cores = Math.max(1, os.cpus().length);
    return Math.min(100, (totalUsageMs / (elapsedMs * cores)) * 100);
  }

  private rollingAvg(current: number, next: number, count: number): number {
    if (count <= 1) return next;
    return current + (next - current) / count;
  }
}

export function detectAnomalies(metrics: HealthMetrics, thresholds: AnomalyThresholds): Anomaly[] {
  const anomalies: Anomaly[] = [];

  if (metrics.process.memory_heap_used_bytes > thresholds.memory_heap_max_bytes) {
    anomalies.push({
      type: 'memory_pressure',
      severity:
        metrics.process.memory_heap_used_bytes > thresholds.memory_heap_max_bytes * 1.2
          ? 'critical'
          : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.process.memory_heap_used_bytes,
      threshold_value: thresholds.memory_heap_max_bytes,
      context: {},
    });
  }

  if (metrics.iteration.consecutive_no_progress >= thresholds.max_consecutive_no_progress) {
    anomalies.push({
      type: 'stalled_no_progress',
      severity: 'critical',
      detected_at: Date.now(),
      metric_value: metrics.iteration.consecutive_no_progress,
      threshold_value: thresholds.max_consecutive_no_progress,
      context: { last_iteration: metrics.iteration.current },
    });
  }

  if (metrics.process.cpu_percent > thresholds.cpu_percent_max) {
    anomalies.push({
      type: 'cpu_pressure',
      severity: metrics.process.cpu_percent > 95 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.process.cpu_percent,
      threshold_value: thresholds.cpu_percent_max,
      context: {},
    });
  }

  if (metrics.iteration.consecutive_failures >= thresholds.max_consecutive_failures) {
    anomalies.push({
      type: 'consecutive_failures',
      severity: metrics.iteration.consecutive_failures >= 5 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.iteration.consecutive_failures,
      threshold_value: thresholds.max_consecutive_failures,
      context: {},
    });
  }

  if (!metrics.persistence.graphd_available) {
    anomalies.push({
      type: 'graphd_unavailable',
      severity: 'critical',
      detected_at: Date.now(),
      metric_value: 0,
      threshold_value: 1,
      context: {},
    });
  }

  const checkpointAge = Date.now() - metrics.persistence.last_checkpoint_at;
  if (metrics.persistence.last_checkpoint_at > 0 && checkpointAge > thresholds.checkpoint_staleness_max_ms) {
    anomalies.push({
      type: 'checkpoint_stale',
      severity: checkpointAge > thresholds.checkpoint_staleness_max_ms * 2 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: checkpointAge,
      threshold_value: thresholds.checkpoint_staleness_max_ms,
      context: {},
    });
  }

  const logSize = metrics.logging?.file_size_bytes ?? 0;
  const logPath = metrics.logging?.file_path ?? null;

  if (logSize > thresholds.log_file_max_bytes) {
    anomalies.push({
      type: 'log_file_overflow',
      severity: logSize > thresholds.log_file_max_bytes * 1.5 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: logSize,
      threshold_value: thresholds.log_file_max_bytes,
      context: { file_path: logPath },
    });
  }

  return anomalies;
}

const RECOVERY_MATRIX: Record<AnomalyType, (anomaly: Anomaly) => RecoveryAction[]> = {
  memory_pressure: (a) =>
    a.severity === 'critical'
      ? [{ type: 'gc_force' }, { type: 'checkpoint_now' }, { type: 'restart_soft' }]
      : [{ type: 'gc_force' }],
  cpu_pressure: (a) => (a.severity === 'critical' ? [{ type: 'pause_iteration_loop' }] : []),
  iteration_timeout: () => [{ type: 'checkpoint_now' }, { type: 'escalate_to_oncall' }],
  consecutive_failures: (a) => [
    { type: 'escalate_to_oncall' },
    a.metric_value >= 5 ? { type: 'rollback_version' } : { type: 'checkpoint_now' },
  ],
  stalled_no_progress: () => [{ type: 'escalate_to_oncall' }, { type: 'checkpoint_now' }],
  agent_failure_rate: (a) => [
    { type: 'compact_agent_context', agent: a.context.agent as AgentType },
    { type: 'escalate_to_oncall' },
  ],
  agent_context_explosion: (a) => [{ type: 'compact_agent_context', agent: a.context.agent as AgentType }],
  benchmark_regression: (a) => (a.severity === 'critical' ? [{ type: 'rollback_version' }] : [{ type: 'escalate_to_oncall' }]),
  graphd_latency: () => [{ type: 'checkpoint_now' }],
  graphd_unavailable: () => [{ type: 'pause_iteration_loop' }],
  checkpoint_stale: () => [{ type: 'checkpoint_now' }],
  log_file_overflow: () => [{ type: 'rotate_logs' }],
};

export function buildRecoveryPlan(anomalies: Anomaly[]): RecoveryPlan {
  const actions: RecoveryAction[] = [];
  for (const anomaly of anomalies) {
    actions.push(...RECOVERY_MATRIX[anomaly.type](anomaly));
  }

  const reasoning = anomalies.map((a) => `${a.type}:${a.severity}`).join(', ');
  return { anomalies, actions, reasoning };
}

export interface RecoveryHandlers {
  compactAgentContext: (agent: AgentType) => Promise<void>;
  checkpointNow: () => Promise<void>;
  restartSoft: () => Promise<void>;
  rollbackVersion: () => Promise<void>;
  pauseIterationLoop: () => Promise<void>;
  escalateToOnCall: () => Promise<void>;
  haltFatal: () => Promise<void>;
  rotateLogs: () => Promise<void>;
}

export async function executeRecovery(
  plan: RecoveryPlan,
  handlers: RecoveryHandlers,
  logger: Logger
): Promise<void> {
  logger.info('[health] Executing recovery plan', { reasoning: plan.reasoning });

  for (const action of plan.actions) {
    switch (action.type) {
      case 'gc_force':
        if (global.gc) {
          global.gc();
        } else {
          logger.warn('[health] GC unavailable; run with --expose-gc');
        }
        break;
      case 'compact_agent_context':
        await handlers.compactAgentContext(action.agent);
        break;
      case 'checkpoint_now':
        await handlers.checkpointNow();
        break;
      case 'restart_soft':
        await handlers.restartSoft();
        break;
      case 'rollback_version':
        await handlers.rollbackVersion();
        break;
      case 'pause_iteration_loop':
        await handlers.pauseIterationLoop();
        break;
      case 'escalate_to_oncall':
        await handlers.escalateToOnCall();
        break;
      case 'halt_fatal':
        await handlers.haltFatal();
        break;
      case 'restart_hard_same_version':
        await handlers.restartSoft();
        break;
      case 'rotate_logs':
        await handlers.rotateLogs();
        break;
    }
  }
}
