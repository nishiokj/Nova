# Experiments Library Design

## Philosophy

**Adapter pattern + explicit surfacing**: The library doesn't assume any specific agent architecture. Users implement interfaces to expose what's testable. If you want to test a deep primitive, first surface it in your config.

This is more honest than trying to magically inject variables into arbitrary implementations.

---

## Core Interfaces

### 1. ExperimentableRunner

The main interface users implement to make their agent system testable.

```typescript
interface ExperimentableRunner<TConfig, TResult> {
  /** Schema describing configurable variables */
  readonly configSchema: ConfigSchema<TConfig>;

  /** Apply config overlay for a trial */
  configure(overlay: Partial<TConfig>): void;

  /** Run a single trial with the current config */
  run(input: TrialInput): Promise<TResult>;

  /** Reset state between trials (optional) */
  reset?(): Promise<void>;
}

interface ConfigSchema<T> {
  /** Variable paths that can be manipulated */
  variables: VariableDefinition[];

  /** Default config values */
  defaults: T;

  /** Validate a config overlay */
  validate(overlay: Partial<T>): ValidationResult;
}

interface VariableDefinition {
  path: string;           // e.g., "orchestrator.compactTriggerPercent"
  type: 'number' | 'string' | 'boolean' | 'enum';
  description: string;
  range?: { min?: number; max?: number };
  options?: string[];     // For enum type
}
```

### 2. Snapshotable (Optional)

For session forking / context experiments.

```typescript
interface Snapshotable<TSnapshot> {
  /** Serialize current state */
  snapshot(): TSnapshot;

  /** Restore from snapshot */
  restore(snapshot: TSnapshot): void;
}
```

### 3. MetricsProvider

Standardizes what metrics the library can analyze.

```typescript
interface MetricsProvider {
  getMetrics(): TrialMetrics;
}

interface TrialMetrics {
  success: boolean;
  durationMs: number;
  // User extends with their specific metrics
  [key: string]: unknown;
}
```

---

## Package Structure

```
packages/experiments/
  src/
    # Core
    index.ts                    # Public exports
    interfaces.ts               # ExperimentableRunner, Snapshotable, etc.
    experiment.ts               # Experiment definition
    trial.ts                    # Trial execution wrapper
    variable.ts                 # Variable definition helpers
    result.ts                   # Result types

    # Runners
    runners/
      experiment-runner.ts      # Orchestrates trials across conditions
      parallel-runner.ts        # Concurrent trial execution
      worktree-runner.ts        # Code-level experiments via git worktrees

    # Analysis
    analysis/
      statistics.ts             # t-tests, effect sizes, confidence intervals
      aggregator.ts             # Aggregate N trials into condition results
      reporter.ts               # Markdown/JSON report generation

    # Utilities
    utils/
      worktree-manager.ts       # Git worktree lifecycle
      snapshot-store.ts         # Store/retrieve snapshots for reproducibility
      seed-manager.ts           # Deterministic randomness

    # Adapters (reference implementations)
    adapters/
      rex-harness-adapter.ts    # Adapter for your Harness/Orchestrator/Agent
```

---

## User's Responsibility

To make a component testable, the user must:

1. **Implement `ExperimentableRunner`** for their agent system
2. **Surface deep primitives in config** - If you want to test compaction threshold, add it to your agent's config interface
3. **Implement `Snapshotable`** if they want session forking experiments
4. **Define their config schema** with variable paths the library can manipulate

---

## Rex-Specific Adapter

For your architecture, we'll provide a reference adapter:

```typescript
// packages/experiments/src/adapters/rex-harness-adapter.ts

import { AgentHarness, type FullHarnessConfig } from 'harness-daemon';
import type { ExperimentableRunner, ConfigSchema, Snapshotable } from '../interfaces.js';

export class RexHarnessAdapter implements
  ExperimentableRunner<RexExperimentConfig, RexTrialResult>,
  Snapshotable<ContextWindowSnapshot>
{
  private harness: AgentHarness;
  private config: RexExperimentConfig;

  readonly configSchema: ConfigSchema<RexExperimentConfig> = {
    variables: [
      // Only variables that ARE surfaced in your config
      { path: 'orchestrator.maxIterations', type: 'number', description: 'Max loop iterations' },
      { path: 'orchestrator.maxToolCalls', type: 'number', description: 'Max total tool calls' },
      { path: 'orchestrator.compactTriggerPercent', type: 'number', description: 'Compaction trigger threshold', range: { min: 0, max: 1 } },
      { path: 'agents.standard.llm.temperature', type: 'number', description: 'LLM temperature', range: { min: 0, max: 2 } },
      { path: 'agents.standard.budget.maxIterations', type: 'number', description: 'Agent max iterations' },
      // Add more as you surface them
    ],
    defaults: loadDefaultConfig(),
    validate: (overlay) => validateOverlay(overlay),
  };

  configure(overlay: Partial<RexExperimentConfig>): void {
    this.config = deepMerge(this.configSchema.defaults, overlay);
    this.harness = new AgentHarness(buildFullConfig(this.config));
  }

  async run(input: TrialInput): Promise<RexTrialResult> {
    await this.harness.start();
    const handle = this.harness.run({
      inputText: input.prompt,
      sessionKey: input.sessionKey,
      workingDir: input.workingDir,
    });
    const result = await handle.result;
    await this.harness.shutdown();
    return extractMetrics(result);
  }

  snapshot(): ContextWindowSnapshot {
    return this.harness.getSessionContext().serialize();
  }

  restore(snapshot: ContextWindowSnapshot): void {
    this.harness.restoreContext(snapshot);
  }
}
```

---

## What Needs Surfacing in Rex

To test the primitives you mentioned, these need to move from hardcoded to config:

| Primitive | Current Location | Action |
|-----------|------------------|--------|
| Compaction threshold | `orchestrator.ts:75` | Already in `OrchestratorConfig` |
| Compaction max files | `orchestrator.ts:77` | Already in `OrchestratorConfig` |
| Compaction truncate | `orchestrator.ts:78` | Already in `OrchestratorConfig` |
| Harness compaction params | `harness.ts:1504-1508` | **Surface to config** |
| System prompts | `prompts.ts` constants | **Add `systemPromptOverride` to agent config** |
| Agent temperature | Agent config | Already there |
| Context max tokens | `context` config | Already there |

**Required refactors in Rex codebase:**
1. `harness.ts`: Extract `{ deduplicateByPath, maxFileContentCount, truncateOutputsTo }` to `this.config.compaction`
2. `agent.ts`: Check for `config.systemPromptOverride` before using `prompts.ts` constant
3. `config.ts`: Add schemas for new fields

---

## Experiment Definition

```typescript
interface ExperimentConfig {
  id: string;
  name: string;
  hypothesis: string;

  /** Variables to manipulate */
  independentVariables: Variable[];

  /** Metrics to measure */
  dependentVariables: DependentVariable[];

  /** Number of trials per condition */
  trialsPerCondition: number;

  /** For snapshot-based experiments */
  baseSnapshot?: unknown;

  /** Random seed for reproducibility */
  seed?: number;
}

interface Variable {
  name: string;
  path: string;  // Must match a path in runner's configSchema.variables
  values: unknown[];
}

interface DependentVariable {
  name: string;
  path: string;  // Path in TrialResult to extract
  aggregation: 'mean' | 'median' | 'min' | 'max' | 'count';
  higherIsBetter?: boolean;
}
```

---

## Usage Example

```typescript
import { Experiment, ExperimentRunner } from '@rex/experiments';
import { RexHarnessAdapter } from '@rex/experiments/adapters';

// 1. Create adapter for your agent system
const adapter = new RexHarnessAdapter();

// 2. Define experiment (only uses variables the adapter exposes)
const experiment = new Experiment({
  id: 'compaction-threshold-v1',
  name: 'Impact of Compaction Threshold on Long-Context Tasks',
  hypothesis: 'Lower thresholds preserve more context, improving success on complex tasks',

  independentVariables: [
    {
      name: 'compactTrigger',
      path: 'orchestrator.compactTriggerPercent',
      values: [0.5, 0.7, 0.9],
    },
  ],

  dependentVariables: [
    { name: 'successRate', path: 'success', aggregation: 'mean', higherIsBetter: true },
    { name: 'duration', path: 'durationMs', aggregation: 'mean', higherIsBetter: false },
    { name: 'toolCalls', path: 'metrics.toolCalls', aggregation: 'mean' },
  ],

  trialsPerCondition: 30,
  seed: 42,
});

// 3. Run experiment
const runner = new ExperimentRunner(experiment, adapter, {
  input: { prompt: 'Refactor the authentication module to use JWT' },
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

const result = await runner.run();

// 4. Analyze
console.log(generateReport(result, 'markdown'));
```

---

## Code-Level Experiments (Worktrees)

For testing actual code changes (different `prompts.ts`, different algorithms):

```typescript
import { WorktreeExperimentRunner } from '@rex/experiments/runners';

const runner = new WorktreeExperimentRunner({
  repoRoot: process.cwd(),
  experiment: {
    id: 'explorer-prompt-v1',
    name: 'Explorer Prompt Variants',
    independentVariables: [
      {
        name: 'codeVersion',
        path: 'worktree.ref',  // Special path for worktree experiments
        values: ['main', 'feature/structured-artifacts', 'experiment/minimal-prompt'],
      },
    ],
    trialsPerCondition: 20,
  },
  adapterFactory: (worktreePath) => {
    // Import and create adapter from worktree
    const { RexHarnessAdapter } = require(`${worktreePath}/packages/experiments`);
    return new RexHarnessAdapter({ configPath: `${worktreePath}/config/defaults.json` });
  },
});
```

---

## Analysis Output

```markdown
# Experiment: Impact of Compaction Threshold on Long-Context Tasks

**Hypothesis:** Lower thresholds preserve more context, improving success on complex tasks

## Results Summary

| Condition | Success Rate | Duration (ms) | Tool Calls |
|-----------|--------------|---------------|------------|
| threshold=0.5 | 0.87 ± 0.06 | 45,230 ± 8,400 | 42.3 ± 12.1 |
| threshold=0.7 | 0.73 ± 0.08 | 38,100 ± 7,200 | 35.8 ± 9.4 |
| threshold=0.9 | 0.60 ± 0.09 | 32,400 ± 6,100 | 28.2 ± 7.8 |

## Statistical Analysis

### Success Rate
- threshold=0.5 vs threshold=0.9: p=0.002, Cohen's d=1.24 (large effect) **
- threshold=0.5 vs threshold=0.7: p=0.048, Cohen's d=0.58 (medium effect) *
- threshold=0.7 vs threshold=0.9: p=0.087, Cohen's d=0.42 (small effect)

### Best Condition: threshold=0.5

## Reproducibility
- Seed: 42
- Git commit: abc123
- Config snapshot: [attached]
```

---

## Implementation Order

1. **Core interfaces** (`interfaces.ts`) - Define `ExperimentableRunner`, `Snapshotable`, `MetricsProvider`
2. **Variable & Experiment types** (`variable.ts`, `experiment.ts`)
3. **ExperimentRunner** - Core runner that calls adapter, manages conditions
4. **RexHarnessAdapter** - Reference implementation for your architecture
5. **Rex refactors** - Surface compaction params, add prompt override
6. **Statistics** - t-tests, aggregation, effect sizes
7. **Reporter** - Markdown output
8. **WorktreeRunner** - Code-level experiments

---

## Files to Create

| File | Purpose |
|------|---------|
| `packages/experiments/src/interfaces.ts` | Core interfaces |
| `packages/experiments/src/experiment.ts` | Experiment class |
| `packages/experiments/src/variable.ts` | Variable helpers |
| `packages/experiments/src/result.ts` | Result types |
| `packages/experiments/src/runners/experiment-runner.ts` | Main runner |
| `packages/experiments/src/analysis/statistics.ts` | Statistical analysis |
| `packages/experiments/src/analysis/reporter.ts` | Report generation |
| `packages/experiments/src/adapters/rex-harness-adapter.ts` | Rex adapter |

## Files to Modify (Rex Codebase)

| File | Change |
|------|--------|
| `packages/harness-daemon/src/harness/config.ts` | Add `compaction` schema |
| `packages/harness-daemon/src/harness/harness.ts` | Read compaction from config |
| `packages/agent/src/types.ts` | Add `systemPromptOverride` field |
| `packages/agent/src/agent.ts` | Check for prompt override |

---

## Verification

1. Unit tests for interfaces, experiment generation, statistics
2. Integration test: Run adapter with mock harness
3. End-to-end: Run 3-condition, 5-trial experiment on real task
4. Verify statistical output matches expected calculations
