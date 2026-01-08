import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { AnomalyThresholds, UpgradePolicy } from './types.js';

export interface AgentModelConfig {
  provider: 'openai' | 'anthropic' | 'unknown';
  model: string;
  maxTokens: number;
  temperature: number;
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'xhigh'};
  apiKey?: string;
}

export interface KernelConfig {
  graphdDbPath: string;
  worktreeBaseDir: string;
  upgradeSignalFile: string;
  checkpointEveryIterations: number;
  log: {
    backend: 'console' | 'file';
    format: 'pretty' | 'json';
    level: 'debug' | 'info' | 'warn' | 'error';
    path?: string;
  };
  orchestrator: {
    maxIterations: number;
    maxToolCalls: number;
    maxDurationMs: number;
  };
  health: {
    thresholds: AnomalyThresholds;
    samplingIntervalMs: number;
  };
  upgradePolicy: UpgradePolicy;
  agents: {
    principal: AgentModelConfig;
    oncall: AgentModelConfig;
    testing: AgentModelConfig;
    coding: AgentModelConfig;
  };
}

interface PartialKernelConfig {
  graphdDbPath?: string;
  worktreeBaseDir?: string;
  upgradeSignalFile?: string;
  checkpointEveryIterations?: number;
  log?: Partial<KernelConfig['log']>;
  orchestrator?: Partial<KernelConfig['orchestrator']>;
  health?: { thresholds?: Partial<AnomalyThresholds>; samplingIntervalMs?: number };
  upgradePolicy?: Partial<UpgradePolicy>;
  agents?: Partial<Record<keyof KernelConfig['agents'], Partial<AgentModelConfig>>>;
}

const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  memory_heap_max_bytes: 2 * 1024 * 1024 * 1024,
  cpu_percent_max: 90,
  iteration_max_duration_ms: 30 * 60 * 1000,
  max_consecutive_failures: 3,
  max_consecutive_no_progress: 5,
  agent_failure_rate_max: 0.3,
  agent_tokens_max: 100000,
  max_regression_percent: 0.1,
  max_consecutive_regressions: 2,
  graphd_latency_max_ms: 5000,
  checkpoint_staleness_max_ms: 10 * 60 * 1000,
};

const DEFAULT_UPGRADE_POLICY: UpgradePolicy = {
  benchmark_improvement_threshold: 0.05,
  max_iterations_before_checkpoint: 10,
  require_all_tests_pass: true,
  max_allowed_regression: 0.02,
  min_iterations_between_upgrades: 3,
};

const DEFAULT_CONFIG: KernelConfig = {
  graphdDbPath: '.graphd/graphd.db',
  worktreeBaseDir: 'worktrees',
  upgradeSignalFile: '/tmp/sias-upgrade-signal',
  checkpointEveryIterations: 5,
  log: {
    backend: 'console',
    format: 'pretty',
    level: 'info',
  },
  orchestrator: {
    maxIterations: 10,
    maxToolCalls: 150,
    maxDurationMs: 120000,
  },
  health: {
    thresholds: DEFAULT_THRESHOLDS,
    samplingIntervalMs: 5000,
  },
  upgradePolicy: DEFAULT_UPGRADE_POLICY,
  agents: {
    principal: {
      provider: 'openai',
      model: 'gpt-5.2',
      maxTokens: 128000,
      temperature: 0.4,
    },
    oncall: {
      provider: 'openai',
      model: 'gpt-5.2',
      maxTokens: 128000,
      temperature: 0.4,
    },
    testing: {
      provider: 'openai',
      model: 'gpt-5-mini',
      maxTokens: 100000,
      temperature: 0.2,
    },
    coding: {
      provider: 'openai',
      model: 'gpt-5.1-codex',
      maxTokens: 12800,
      temperature: 0.6,
      reasoning: { effort: 'xhigh' },
    },
  },
};

function resolveApiKey(provider: AgentModelConfig['provider']): string | undefined {
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY;
  }
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY;
  }
  return undefined;
}

function loadConfigFile(configPath?: string): PartialKernelConfig | null {
  const candidates = [
    configPath,
    process.env.SIAS_CONFIG_PATH,
    'config/sias_kernel.json',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!existsSync(resolved)) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolved, 'utf-8')) as PartialKernelConfig;
      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

export function loadKernelConfig(configPath?: string): KernelConfig {
  const fileConfig = loadConfigFile(configPath) ?? {};

  const merged: KernelConfig = {
    ...DEFAULT_CONFIG,
    graphdDbPath:
      process.env.SIAS_GRAPHD_DB_PATH ||
      process.env.GRAPHD_DB_PATH ||
      fileConfig.graphdDbPath ||
      DEFAULT_CONFIG.graphdDbPath,
    worktreeBaseDir:
      process.env.SIAS_WORKTREE_BASE_DIR ||
      fileConfig.worktreeBaseDir ||
      DEFAULT_CONFIG.worktreeBaseDir,
    upgradeSignalFile:
      process.env.SIAS_UPGRADE_SIGNAL_FILE ||
      fileConfig.upgradeSignalFile ||
      DEFAULT_CONFIG.upgradeSignalFile,
    checkpointEveryIterations:
      fileConfig.checkpointEveryIterations ??
      DEFAULT_CONFIG.checkpointEveryIterations,
    log: {
      ...DEFAULT_CONFIG.log,
      ...fileConfig.log,
    },
    orchestrator: {
      ...DEFAULT_CONFIG.orchestrator,
      ...fileConfig.orchestrator,
    },
    health: {
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        ...(fileConfig.health?.thresholds ?? {}),
      },
      samplingIntervalMs:
        fileConfig.health?.samplingIntervalMs ??
        DEFAULT_CONFIG.health.samplingIntervalMs,
    },
    upgradePolicy: {
      ...DEFAULT_UPGRADE_POLICY,
      ...(fileConfig.upgradePolicy ?? {}),
    },
    agents: { ...DEFAULT_CONFIG.agents },
  };

  const agentOverrides = fileConfig.agents ?? {};
  for (const agentType of Object.keys(merged.agents) as Array<keyof KernelConfig['agents']>) {
    merged.agents[agentType] = {
      ...merged.agents[agentType],
      ...(agentOverrides[agentType] ?? {}),
    };
    merged.agents[agentType].apiKey =
      merged.agents[agentType].apiKey ?? resolveApiKey(merged.agents[agentType].provider);
  }

  return merged;
}
