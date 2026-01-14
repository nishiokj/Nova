/**
 * Watcher Skill - Meta-agent for monitoring and intervening in agent execution.
 *
 * Minimal implementation:
 * - Prompt in SKILL.md
 * - Structured output schema
 * - GlobalState snapshot helper
 */

import type { ContextWindowSnapshot, ArtifactItem, StructuredOutputSchema } from 'types';

// ============================================
// TYPES
// ============================================

/**
 * Watcher decision output.
 */
export interface WatcherDecision {
  action: 'none' | 'compact' | 'enqueue_subagent' | 'snapshot';
  reason: string;
  subagentConfig?: {
    agent: string;
    goal: string;
    objective: string;
  };
}

/**
 * Uncertainty reduction tracking (0-100 scale per category).
 */
export interface UncertaintyReduction {
  structural: number;
  relational: number;
  behavioral: number;
  contractual: number;
}

/**
 * GlobalState snapshot for watcher input.
 */
export interface GlobalState {
  contextUtilization: number;
  totalArtifacts: number;
  totalToolCalls: number;
  totalLlmCalls: number;
  totalTokens: number;
  filesModified: string[];
  filesRead: string[];
  uncertaintyReduction: UncertaintyReduction;
}

// ============================================
// SCHEMA
// ============================================

/**
 * Structured output schema for watcher decisions.
 */
export const WATCHER_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: 'watcher_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['none', 'compact', 'enqueue_subagent', 'snapshot'],
        description: 'The intervention action to take',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation for this decision',
      },
      subagentConfig: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent type to dispatch' },
          goal: { type: 'string', description: 'High-level goal' },
          objective: { type: 'string', description: 'Specific objective' },
        },
        required: ['agent', 'goal', 'objective'],
        additionalProperties: false,
      },
    },
    required: ['action', 'reason'],
    additionalProperties: false,
  },
};

// ============================================
// HELPERS
// ============================================

/**
 * Calculate uncertainty reduction from artifacts.
 */
function calculateUncertaintyReduction(artifacts: ArtifactItem[]): UncertaintyReduction {
  const counts = { structural: 0, relational: 0, behavioral: 0, contractual: 0 };

  for (const artifact of artifacts) {
    if (artifact.reduces && artifact.reduces in counts) {
      counts[artifact.reduces as keyof typeof counts]++;
    }
  }

  const total = artifacts.length || 1;
  return {
    structural: Math.min(100, (counts.structural / total) * 100),
    relational: Math.min(100, (counts.relational / total) * 100),
    behavioral: Math.min(100, (counts.behavioral / total) * 100),
    contractual: Math.min(100, (counts.contractual / total) * 100),
  };
}

/**
 * Create a GlobalState snapshot from context.
 */
export function createGlobalState(
  snapshot: ContextWindowSnapshot,
  metrics: { toolCalls: number; llmCalls: number },
  filesModified: string[] = []
): GlobalState {
  const artifacts = snapshot.items.filter(
    (item): item is ArtifactItem => item.type === 'artifact'
  );

  return {
    contextUtilization: snapshot.metrics.percentageUsed,
    totalArtifacts: artifacts.length,
    totalToolCalls: metrics.toolCalls,
    totalLlmCalls: metrics.llmCalls,
    totalTokens: snapshot.metrics.inputTokens + snapshot.metrics.outputTokens,
    filesModified,
    filesRead: snapshot.readFiles,
    uncertaintyReduction: calculateUncertaintyReduction(artifacts),
  };
}

/**
 * Format GlobalState as a string for the watcher's objective.
 */
export function formatGlobalStateObjective(state: GlobalState): string {
  return `Evaluate the following execution state and decide if intervention is needed.

## Current State

- **Context utilization**: ${(state.contextUtilization * 100).toFixed(1)}%
- **Artifacts discovered**: ${state.totalArtifacts}
- **Tool calls**: ${state.totalToolCalls}
- **LLM calls**: ${state.totalLlmCalls}
- **Total tokens**: ${state.totalTokens}
- **Files modified**: ${state.filesModified.length > 0 ? state.filesModified.join(', ') : 'none'}
- **Files read**: ${state.filesRead.length}

## Uncertainty Reduction

- Structural: ${state.uncertaintyReduction.structural.toFixed(0)}%
- Relational: ${state.uncertaintyReduction.relational.toFixed(0)}%
- Behavioral: ${state.uncertaintyReduction.behavioral.toFixed(0)}%
- Contractual: ${state.uncertaintyReduction.contractual.toFixed(0)}%

Based on this state, decide: compact, enqueue_subagent, snapshot, or none.`;
}

// ============================================
// WATCHER AGENT CONFIG
// ============================================

/**
 * Watcher agent configuration.
 * No tools - uses structured output for decisions.
 */
export const WATCHER_AGENT_CONFIG = {
  type: 'watcher',
  systemPrompt: `You are a meta-agent observing the execution state of another agent. Your job is to decide if intervention is needed.

## Decision Criteria

### Compact (action: 'compact')
- Context utilization > 75%
- Many file contents could be deduplicated

### Enqueue Subagent (action: 'enqueue_subagent')
- Primary agent is stuck or looping
- A specific subtask would benefit from focused exploration

### Snapshot (action: 'snapshot')
- Significant milestone reached
- About to attempt risky operation

### None (action: 'none')
- Execution is progressing normally
- No clear benefit to intervention

## Principles
1. Minimal intervention - Only act when there's clear benefit
2. Preserve momentum - Don't interrupt productive work
3. Trust the primary - You're a safety net, not a micromanager`,
  tools: [], // No tools - structured output only
  budget: {
    maxIterations: 1, // Single decision
    maxToolCalls: 0,
    maxDurationMs: 10_000,
  },
  outputSchema: WATCHER_OUTPUT_SCHEMA,
};

// ============================================
// THRESHOLDS
// ============================================

/**
 * Default thresholds for triggering watcher evaluation.
 */
export const WATCHER_THRESHOLDS = {
  /** Context usage percentage that triggers watcher */
  contextUsagePercent: 0.6,
  /** Minimum iterations between watcher runs */
  minIterationGap: 5,
  /** Artifact count that triggers watcher */
  artifactThreshold: 15,
};
