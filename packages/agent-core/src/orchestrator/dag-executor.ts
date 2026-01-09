/**
 * DAG Executor - Standalone module for executing RuntimeScript WorkItem DAGs
 *
 * Extracted from orchestrator for separation of concerns.
 * Not used by main orchestrator loop - available for future parallel execution needs.
 */

import type { ContextWindow } from '../types/context.js';
import { Agent } from '../agent/agent.js';
import type { AgentResult } from '../agent/types.js';
import { DEFAULT_WORK_BOUNDS, type WorkItem } from '../wizard/work-item.js';
import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentRegistry } from '../agent/agent-registry.js';
import type { EventEmitCallback } from '../agent/types.js';

// --- Types ---

/**
 * Declarative execution script - DAG of WorkItems.
 */
export interface RuntimeScript {
  goal: string;
  workItems: WorkItem[];
  createdAt: number;
}

/**
 * Raw output format from RuntimeScriptAgent.
 */
export interface RuntimeScriptOutput {
  goal: string;
  workItems: Array<{
    id: string;
    objective: string;
    delta: string;
    agent: string;
    dependencies: string[];
    toolHint?: string;
    targetPaths?: string[];
    params?: Record<string, unknown>;
  }>;
}

/**
 * DAG executor configuration.
 */
export interface DAGExecutorConfig {
  maxParallelAgents: number;
  maxRetriesPerWorkItem: number;
  maxIterations: number;
}

/**
 * Result from DAG execution.
 */
export interface DAGResult {
  success: boolean;
  error?: string;
  completedWorkItems: string[];
  failedWorkItems: string[];
  metrics: {
    totalLlmCalls: number;
    totalToolCalls: number;
    durationMs: number;
  };
}

type WorkItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

interface WorkItemState {
  workItem: WorkItem;
  status: WorkItemStatus;
  attemptCount: number;
  result?: AgentResult;
  error?: string;
}

// --- Parser ---

/**
 * Parse RuntimeScriptAgent output into RuntimeScript.
 */
export function parseRuntimeScript(output: RuntimeScriptOutput): RuntimeScript {
  const workItems: WorkItem[] = output.workItems.map((item) => ({
    workId: item.id,
    goal: output.goal,
    objective: item.objective,
    delta: item.delta,
    agent: item.agent,
    dependencies: Object.freeze(item.dependencies),
    targetPaths: Object.freeze(item.targetPaths ?? []),
    toolHint: item.toolHint,
    params: item.params,
    bounds: DEFAULT_WORK_BOUNDS,
    successCriteria: {
      description: `Complete: ${item.objective}`,
      requiredOutputs: [],
      postconditions: [],
      verificationHints: [],
    },
    preconditionsMet: Object.freeze([]),
  }));

  return {
    goal: output.goal,
    workItems,
    createdAt: Date.now(),
  };
}

// --- Executor ---

/**
 * DAG Executor - executes WorkItem DAGs in parallel.
 * Standalone module not used by main orchestrator loop.
 */
export class DAGExecutor {
  private config: DAGExecutorConfig;
  private states: Map<string, WorkItemState> = new Map();

  constructor(
    config: Partial<DAGExecutorConfig>,
    private toolRegistry: ToolRegistry,
    private llm: LLMAdapter,
    private emit: EventEmitCallback,
    private agentRegistry?: AgentRegistry
  ) {
    this.config = {
      maxParallelAgents: config.maxParallelAgents ?? 3,
      maxRetriesPerWorkItem: config.maxRetriesPerWorkItem ?? 3,
      maxIterations: config.maxIterations ?? 100,
    };
  }

  async execute(script: RuntimeScript, context: ContextWindow): Promise<DAGResult> {
    const startTime = Date.now();
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Initialize state
    this.states.clear();
    for (const workItem of script.workItems) {
      this.states.set(workItem.workId, {
        workItem,
        status: 'pending',
        attemptCount: 0,
      });
    }

    const inFlight = new Map<string, Promise<{ workId: string; result: AgentResult }>>();
    let iteration = 0;

    while (!this.isAllDone() || inFlight.size > 0) {
      iteration++;
      if (iteration > this.config.maxIterations) break;

      // Dispatch ready WorkItems
      const ready = this.getReady();
      for (const state of ready) {
        if (inFlight.size >= this.config.maxParallelAgents) break;

        const { workItem } = state;
        state.status = 'in_progress';
        state.attemptCount++;

        const promise = this.dispatchWorkItem(workItem, context).then((result) => ({
          workId: workItem.workId,
          result,
        }));
        inFlight.set(workItem.workId, promise);
      }

      if (inFlight.size === 0) {
        if (!this.isAllDone()) break; // Deadlock
        continue;
      }

      // Wait for first completion
      const completed = await Promise.race(inFlight.values());
      inFlight.delete(completed.workId);

      const state = this.states.get(completed.workId)!;
      const { result } = completed;

      totalLlmCalls += result.metrics.llmCallsMade;
      totalToolCalls += result.metrics.toolCallsMade;

      if (result.success) {
        state.status = 'completed';
        state.result = result;
      } else {
        if (state.attemptCount < this.config.maxRetriesPerWorkItem) {
          state.status = 'pending'; // Retry
        } else {
          state.status = 'failed';
          state.error = result.error;
          state.result = result;
        }
      }
    }

    const completedItems = [...this.states.values()]
      .filter((s) => s.status === 'completed')
      .map((s) => s.workItem.workId);
    const failedItems = [...this.states.values()]
      .filter((s) => s.status === 'failed')
      .map((s) => s.workItem.workId);

    return {
      success: failedItems.length === 0 && completedItems.length > 0,
      completedWorkItems: completedItems,
      failedWorkItems: failedItems,
      metrics: {
        totalLlmCalls,
        totalToolCalls,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async dispatchWorkItem(workItem: WorkItem, context: ContextWindow): Promise<AgentResult> {
    const runtime = this.agentRegistry?.getRuntimeConfig(workItem.agent);
    if (!runtime) {
      return {
        success: false,
        response: '',
        error: `Unknown agent type: ${workItem.agent}`,
        metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
        filesRead: [],
        invalidatedPaths: [],
        toolErrors: [],
        terminationReason: 'exception',
        needsUserInput: false,
        isRefusal: false,
      };
    }

    const agent = new Agent(
      runtime.config,
      this.llm,
      this.toolRegistry,
      this.emit,
      workItem.workId,
      this.agentRegistry,
      runtime.llm
    );

    // Override work item bounds with agent's configured budget
    const workItemWithBudget: WorkItem = {
      ...workItem,
      bounds: {
        maxToolCalls: runtime.config.budget.maxToolCalls,
        maxDurationMs: runtime.config.budget.maxDurationMs,
        maxLlmCalls: runtime.config.budget.maxIterations,
      },
    };

    return agent.run({ context, workItem: workItemWithBudget });
  }

  private getReady(): WorkItemState[] {
    return [...this.states.values()].filter((state) => {
      if (state.status !== 'pending') return false;
      return state.workItem.dependencies.every((depId) => {
        const dep = this.states.get(depId);
        return dep && dep.status === 'completed';
      });
    });
  }

  private isAllDone(): boolean {
    return [...this.states.values()].every((s) => s.status === 'completed' || s.status === 'failed');
  }
}
