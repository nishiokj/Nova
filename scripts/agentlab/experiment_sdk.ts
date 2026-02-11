#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface VariantPlanEntry {
  variant_id: string;
  bindings: Record<string, JsonValue>;
}

export interface TaskRecord {
  task_id: string;
  input: Record<string, JsonValue>;
}

export interface WriteResult {
  experimentPath: string;
  tasksPath: string;
}

type ExperimentObject = {
  version: '0.3';
  experiment: {
    id: string;
    name: string;
    description: string;
    workload_type: 'agent_harness' | 'trainer';
    owner: string;
    tags: string[];
  };
  dataset: {
    suite_id: string;
    provider: 'local_jsonl';
    path: string;
    schema_version: 'task_jsonl_v1';
    split_id: string;
    limit: number;
  };
  design: {
    sanitization_profile: string;
    comparison: 'paired';
    replications: number;
    random_seed: number;
    shuffle_tasks: boolean;
    max_concurrency: number;
  };
  analysis_plan: {
    primary_metrics: string[];
    secondary_metrics: string[];
    missingness: {
      policy: 'paired_drop' | 'paired_impute' | 'treat_as_failure';
      record_reasons: boolean;
    };
    tests: {
      success: { method: 'paired_bootstrap'; ci: number; resamples: number };
      latency_ms: { method: 'paired_bootstrap'; ci: number; resamples: number };
    };
    multiple_comparisons: { method: 'none' | 'holm' | 'bh' };
    reporting: {
      effect_sizes: Array<'risk_diff' | 'median_diff'>;
      show_task_level_table: boolean;
    };
  };
  baseline: {
    variant_id: string;
    bindings: Record<string, JsonValue>;
  };
  variant_plan: VariantPlanEntry[];
  runtime: {
    harness: {
      mode: 'cli';
      command: string[];
      integration_level: 'cli_basic' | 'cli_events' | 'otel' | 'sdk_control' | 'sdk_full';
      input_path: string;
      output_path: string;
      control_plane: { mode: 'file'; path: string };
      events?: { mode: 'jsonl'; path: string; schema_version: 'hook_events_v1' };
    };
    sandbox: {
      mode: 'container' | 'local';
      engine?: 'docker';
      image?: string;
      root_read_only?: boolean;
      run_as_user?: string;
      hardening?: { no_new_privileges: boolean; drop_all_caps: boolean };
      resources?: { cpu_count: number; memory_mb: number };
    };
    network: {
      mode: 'none' | 'full' | 'allowlist_enforced';
      allowed_hosts: string[];
    };
  };
  validity: {
    fail_on_state_leak: boolean;
    fail_on_profile_invariant_violation: boolean;
  };
};

export class ExperimentBuilder {
  private readonly repoRoot: string;
  private experiment: ExperimentObject;
  private tasks: TaskRecord[] = [];

  private constructor(repoRoot: string, experiment: ExperimentObject) {
    this.repoRoot = repoRoot;
    this.experiment = experiment;
  }

  static forRex(repoRoot: string): ExperimentBuilder {
    const base: ExperimentObject = {
      version: '0.3',
      experiment: {
        id: 'exp_rex_sdk_local',
        name: 'Rex SDK Experiment',
        description: 'Generated from scripts/agentlab/experiment_sdk.ts',
        workload_type: 'agent_harness',
        owner: 'you',
        tags: ['sdk', 'rex'],
      },
      dataset: {
        suite_id: 'local_suite',
        provider: 'local_jsonl',
        path: 'tasks.jsonl',
        schema_version: 'task_jsonl_v1',
        split_id: 'dev',
        limit: 50,
      },
      design: {
        sanitization_profile: 'hermetic_functional_v2',
        comparison: 'paired',
        replications: 3,
        random_seed: 1337,
        shuffle_tasks: true,
        max_concurrency: 1,
      },
      analysis_plan: {
        primary_metrics: ['success'],
        secondary_metrics: ['latency_ms'],
        missingness: {
          policy: 'paired_drop',
          record_reasons: true,
        },
        tests: {
          success: { method: 'paired_bootstrap', ci: 0.95, resamples: 1000 },
          latency_ms: { method: 'paired_bootstrap', ci: 0.95, resamples: 1000 },
        },
        multiple_comparisons: { method: 'none' },
        reporting: {
          effect_sizes: ['risk_diff', 'median_diff'],
          show_task_level_table: true,
        },
      },
      baseline: {
        variant_id: 'base',
        bindings: {},
      },
      variant_plan: [],
      runtime: {
        harness: {
          mode: 'cli',
          command: ['bun', './scripts/agentlab/run_cli.ts'],
          integration_level: 'cli_events',
          input_path: '/out/trial_input.json',
          output_path: '/out/trial_output.json',
          control_plane: { mode: 'file', path: '/state/lab_control.json' },
          events: {
            mode: 'jsonl',
            path: '/out/harness_events.jsonl',
            schema_version: 'hook_events_v1',
          },
        },
        sandbox: {
          mode: 'container',
          engine: 'docker',
          image: 'oven/bun:1',
          root_read_only: true,
          run_as_user: '1000:1000',
          hardening: { no_new_privileges: true, drop_all_caps: true },
          resources: { cpu_count: 2, memory_mb: 2048 },
        },
        network: {
          mode: 'none',
          allowed_hosts: [],
        },
      },
      validity: {
        fail_on_state_leak: true,
        fail_on_profile_invariant_violation: true,
      },
    };
    return new ExperimentBuilder(repoRoot, base);
  }

  setId(id: string): this {
    this.experiment.experiment.id = id;
    return this;
  }

  setName(name: string): this {
    this.experiment.experiment.name = name;
    return this;
  }

  setDescription(description: string): this {
    this.experiment.experiment.description = description;
    return this;
  }

  setReplications(replications: number): this {
    this.experiment.design.replications = replications;
    return this;
  }

  setDatasetPath(datasetPath: string, limit: number): this {
    this.experiment.dataset.path = datasetPath;
    this.experiment.dataset.limit = limit;
    return this;
  }

  setHarnessCommand(command: string[]): this {
    this.experiment.runtime.harness.command = [...command];
    return this;
  }

  setBaseline(variantId: string, bindings: Record<string, JsonValue>): this {
    this.experiment.baseline = {
      variant_id: variantId,
      bindings,
    };
    return this;
  }

  addVariant(variantId: string, bindings: Record<string, JsonValue>): this {
    this.experiment.variant_plan.push({
      variant_id: variantId,
      bindings,
    });
    return this;
  }

  addTask(taskId: string, input: Record<string, JsonValue>): this {
    this.tasks.push({ task_id: taskId, input });
    return this;
  }

  toObject(): ExperimentObject {
    return JSON.parse(JSON.stringify(this.experiment)) as ExperimentObject;
  }

  write(labDir: string = '.lab'): WriteResult {
    if (this.tasks.length === 0) {
      throw new Error('At least one task is required. Call addTask() before write().');
    }

    const outDir = resolve(this.repoRoot, labDir);
    mkdirSync(outDir, { recursive: true });
    const experimentPath = resolve(outDir, 'experiment.yaml');
    const tasksPath = resolve(outDir, 'tasks.jsonl');

    const experimentDoc = this.toObject();
    experimentDoc.dataset.path = 'tasks.jsonl';

    // JSON is valid YAML, so this remains compatible with YAML loaders.
    writeFileSync(experimentPath, JSON.stringify(experimentDoc, null, 2) + '\n', 'utf-8');
    const tasksJsonl = this.tasks.map((t) => JSON.stringify(t)).join('\n') + '\n';
    writeFileSync(tasksPath, tasksJsonl, 'utf-8');

    return { experimentPath, tasksPath };
  }
}
