/**
 * Orchestrator - Dispatches agents and owns execution state.
 *
 * Replaces the Wizard class with a cleaner execution model:
 * 1. ExplorerAgent gathers system context
 * 2. RuntimeScriptAgent generates WorkItem DAG
 * 3. Orchestrator executes DAG, dispatching agents in parallel
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextWindow } from '../types/context.js';
import type { EventEmitCallback, AgentResult, AgentConfig } from '../agent/types.js';
import { Agent } from '../agent/agent.js';
import type { AgentRegistry } from '../agent/agent-registry.js';
import type { LLMRequestConfig } from '../llm/index.js';
import { createWorkItem, type WorkItem } from '../wizard/work-item.js';
import { WorkLedger } from '../wizard/work-ledger.js';
import { KnowledgeStore } from '../wizard/knowledge.js';
import {
  WorkItemStateManager,
  type WorkItemState,
} from './workitem-state.js';
import {
  parseRuntimeScript,
  type RuntimeScript,
  type SystemContext,
  type RuntimeScriptOutput,
} from './runtime-script.js';
import { createEvent } from '../types/events.js';
import { coerceStructuredOutput } from '../shared/structured_output.js';

/**
 * Orchestrator configuration.
 */
export interface OrchestratorConfig {
  /** Maximum iterations in execution loop */
  maxIterations: number;
  /** Maximum parallel agents */
  maxParallelAgents: number;
  /** Maximum retries per WorkItem */
  maxRetriesPerWorkItem: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxParallelAgents: 3,
  maxRetriesPerWorkItem: 3,
};

/**
 * Result from Orchestrator.execute().
 */
export interface OrchestratorResult {
  success: boolean;
  response: string;
  error?: string;
  metrics: OrchestratorMetrics;
  paused: boolean;
  userPrompt?: AgentResult['userPrompt'];
}

/**
 * Orchestrator metrics.
 */
export interface OrchestratorMetrics {
  totalIterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
  workItemsCompleted: number;
  workItemsFailed: number;
  workItemsSkipped: number;
}

/**
 * Tier classification.
 */
export type Tier = 'simple' | 'standard' | 'complex';

/**
 * Logger protocol.
 */
export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Orchestrator class.
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private emit: EventEmitCallback;
  private requestId: string;
  private logger?: OrchestratorLogger;
  private agentRegistry?: AgentRegistry;

  // State (owned by Orchestrator)
  private workLedger!: WorkLedger;
  private knowledge!: KnowledgeStore;
  private stateManager!: WorkItemStateManager;

  // Metrics
  private totalLlmCalls = 0;
  private totalToolCalls = 0;

  constructor(
    config: Partial<OrchestratorConfig>,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    emit: EventEmitCallback,
    requestId: string,
    logger?: OrchestratorLogger,
    agentRegistry?: AgentRegistry
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.emit = emit;
    this.requestId = requestId;
    this.logger = logger;
    this.agentRegistry = agentRegistry;
  }

  private resolveAgentRuntimeConfig(agentType: string): { config: AgentConfig; llm: LLMRequestConfig } {
    if (!this.agentRegistry) {
      throw new Error('Agent registry is required to resolve agent configs');
    }
    return this.agentRegistry.getRuntimeConfig(agentType);
  }

  private getRuntimeScriptAllowedAgents(): string[] {
    if (!this.agentRegistry) {
      throw new Error('Agent registry is required to resolve runtime script tools');
    }
    const runtimeConfig = this.agentRegistry.getRuntimeConfig('runtime_script').config;
    const allowed = runtimeConfig.tools.filter((name) => this.agentRegistry?.has(name));
    if (allowed.length === 0) {
      throw new Error('runtime_script has no allowed agent tools configured');
    }
    return allowed;
  }

  /**
   * Execute a goal.
   */
  async execute(
    context: ContextWindow,
    goal: string,
    tier: 'standard' | 'complex'
  ): Promise<OrchestratorResult> {
    const startTime = Date.now();

    this.workLedger = new WorkLedger();
    this.knowledge = new KnowledgeStore();
    this.stateManager = new WorkItemStateManager();
    this.totalLlmCalls = 0;
    this.totalToolCalls = 0;

    try {
      const script = await this.generateRuntimeScript(context, goal, tier);

      this.stateManager.initFromScript(script.workItems);

      this.emit(createEvent('runtime_script_created', {
        goal: script.goal,
        workItemCount: script.workItems.length,
        workItems: script.workItems.map((w) => ({
          workId: w.workId,
          objective: w.objective,
          delta: w.delta,
          agent: w.agent,
          dependencies: [...w.dependencies],
        })),
        systemContext: {
          packageManagers: script.systemContext.packageManagers,
          frameworks: script.systemContext.frameworks,
          languages: script.systemContext.languages,
        },
      }));

      const result = await this.executeDAG(context, goal, script);

      const counts = this.stateManager.getCounts();
      if (result.success) {
        this.emit(createEvent('goal_achieved', {
          goal,
          completed: counts.completed,
          skipped: counts.skipped,
        }));
      } else if (!result.paused) {
        this.emit(createEvent('goal_not_achieved', {
          goal,
          reason: result.error ?? 'Unknown',
          completed: counts.completed,
          failed: counts.failed,
          skipped: counts.skipped,
        }));
      }

      return {
        ...result,
        metrics: {
          totalIterations: result.metrics.totalIterations,
          totalLlmCalls: this.totalLlmCalls,
          totalToolCalls: this.totalToolCalls,
          durationMs: Date.now() - startTime,
          workItemsCompleted: counts.completed,
          workItemsFailed: counts.failed,
          workItemsSkipped: counts.skipped,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `Orchestrator error: ${message}`);

      const counts = this.stateManager
        ? this.stateManager.getCounts()
        : { completed: 0, failed: 0, skipped: 0 };
      this.emit(createEvent('goal_not_achieved', {
        goal,
        reason: message,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        skipped: counts.skipped ?? 0,
      }));

      return {
        success: false,
        response: '',
        error: message,
        metrics: {
          totalIterations: 0,
          totalLlmCalls: this.totalLlmCalls,
          totalToolCalls: this.totalToolCalls,
          durationMs: Date.now() - startTime,
          workItemsCompleted: counts.completed ?? 0,
          workItemsFailed: counts.failed ?? 0,
          workItemsSkipped: counts.skipped ?? 0,
        },
        paused: false,
      };
    } finally {
      // No-op cleanup
    }
  }

  /**
   * Generate RuntimeScript via ExplorerAgent + RuntimeScriptAgent.
   */
  private async generateRuntimeScript(
    context: ContextWindow,
    goal: string,
    tier: 'standard' | 'complex'
  ): Promise<RuntimeScript> {
    const explorerRuntime = this.resolveAgentRuntimeConfig('explorer');
    const explorerAgent = new Agent(
      explorerRuntime.config,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId,
      this.agentRegistry,
      explorerRuntime.llm
    );

    const explorationWorkItem = createWorkItem({
      goal,
      objective: `Explore the codebase to understand:
1. What package managers are used?
2. What frameworks are in use?
3. What languages are present?
4. What files are relevant to: ${goal}
5. What patterns/conventions exist?`,
      agent: 'explorer',
    });

    this.emit(createEvent('workitem_started', {
      workId: explorationWorkItem.workId,
      objective: explorationWorkItem.objective,
      delta: explorationWorkItem.delta,
      agent: explorationWorkItem.agent,
      dependencies: [...explorationWorkItem.dependencies],
    }, explorationWorkItem.workId));

    const explorationResult = await explorerAgent.run({
      context,
      workItem: explorationWorkItem,
    });

    if (!explorationResult.success && !explorationResult.needsUserInput) {
      this.emit(createEvent('workitem_failed', {
        workId: explorationWorkItem.workId,
        objective: explorationWorkItem.objective,
        error: explorationResult.error ?? 'Explorer failed',
        toolErrors: explorationResult.toolErrors,
        terminationReason: explorationResult.terminationReason,
      }, explorationWorkItem.workId));
      throw new Error(explorationResult.error ?? 'Explorer failed');
    }

    this.emit(createEvent('workitem_completed', {
      workId: explorationWorkItem.workId,
      objective: explorationWorkItem.objective,
      response: explorationResult.response,
      metrics: {
        llmCallsMade: explorationResult.metrics.llmCallsMade,
        toolCallsMade: explorationResult.metrics.toolCallsMade,
        durationMs: explorationResult.metrics.durationMs,
      },
    }, explorationWorkItem.workId));

    this.totalLlmCalls += explorationResult.metrics.llmCallsMade;
    this.totalToolCalls += explorationResult.metrics.toolCallsMade;

    const systemContext = this.parseSystemContext(
      explorationResult.structuredOutput ?? explorationResult.response
    );

    const scriptRuntime = this.resolveAgentRuntimeConfig('runtime_script');
    const allowedAgents = this.getRuntimeScriptAllowedAgents();
    const allowedAgentsText = allowedAgents.join(', ');
    const scriptPrompt = `${scriptRuntime.config.systemPrompt}\n\nAllowed agent types for WorkItems: ${allowedAgentsText}\nUse only these values for "agent".`;
    const scriptAgent = new Agent(
      { ...scriptRuntime.config, systemPrompt: scriptPrompt },
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId,
      this.agentRegistry,
      scriptRuntime.llm
    );

    const scriptWorkItem = createWorkItem({
      goal,
      objective: `Create an executable WorkItem DAG for: ${goal}

System context:
${JSON.stringify(systemContext, null, 2)}`,
      agent: 'runtime_script',
    });

    this.emit(createEvent('workitem_started', {
      workId: scriptWorkItem.workId,
      objective: scriptWorkItem.objective,
      delta: scriptWorkItem.delta,
      agent: scriptWorkItem.agent,
      dependencies: [...scriptWorkItem.dependencies],
    }, scriptWorkItem.workId));

    const scriptResult = await scriptAgent.run({
      context,
      workItem: scriptWorkItem,
    });

    if (!scriptResult.success && !scriptResult.needsUserInput) {
      this.emit(createEvent('workitem_failed', {
        workId: scriptWorkItem.workId,
        objective: scriptWorkItem.objective,
        error: scriptResult.error ?? 'runtime_script failed',
        toolErrors: scriptResult.toolErrors,
        terminationReason: scriptResult.terminationReason,
      }, scriptWorkItem.workId));
      throw new Error(scriptResult.error ?? 'runtime_script failed');
    }

    this.emit(createEvent('workitem_completed', {
      workId: scriptWorkItem.workId,
      objective: scriptWorkItem.objective,
      response: scriptResult.response,
      metrics: {
        llmCallsMade: scriptResult.metrics.llmCallsMade,
        toolCallsMade: scriptResult.metrics.toolCallsMade,
        durationMs: scriptResult.metrics.durationMs,
      },
    }, scriptWorkItem.workId));

    this.totalLlmCalls += scriptResult.metrics.llmCallsMade;

    // DEBUG: Log runtime_script agent output
    this.log('info', 'runtime_script agent completed', {
      terminationReason: scriptResult.terminationReason,
      responseLength: scriptResult.response.length,
      responsePreview: scriptResult.response.slice(0, 500),
      success: scriptResult.success,
      error: scriptResult.error,
    });

    const scriptOutput = this.parseScriptOutput(
      scriptResult.structuredOutput ?? scriptResult.response,
      goal,
      allowedAgents,
      scriptRuntime.llm
    );
    return parseRuntimeScript(scriptOutput, systemContext);
  }

  /**
   * Execute the WorkItem DAG.
   */
  private async executeDAG(
    context: ContextWindow,
    goal: string,
    script: RuntimeScript
  ): Promise<OrchestratorResult> {
    let iteration = 0;
    let lastResponse = '';
    let paused = false;
    let userPrompt: AgentResult['userPrompt'] | undefined;

    type InFlightResult = {
      workId: string;
      entryId: string;
      result: AgentResult;
    };
    const inFlight = new Map<string, Promise<InFlightResult>>();

    while (!this.stateManager.isAllDone() || inFlight.size > 0) {
      iteration++;
      if (iteration > this.config.maxIterations) {
        this.log('warning', 'Max iterations reached');
        break;
      }

      const ready = this.stateManager.getReady();
      for (const state of ready) {
        if (inFlight.size >= this.config.maxParallelAgents) break;

        const agentId = uuidv4().slice(0, 8);
        this.stateManager.markInProgress(state.workItem.workId, agentId);

        const entryId = this.workLedger.recordDispatch(state.workItem, agentId);

        this.emit(createEvent('workitem_started', {
          workId: state.workItem.workId,
          objective: state.workItem.objective,
          delta: state.workItem.delta,
          agent: state.workItem.agent,
          dependencies: [...state.workItem.dependencies],
        }, state.workItem.workId));

        const promise = this.dispatchAgent(context, state.workItem, agentId)
          .then(({ workId, result }) => ({ workId, entryId, result }));
        inFlight.set(state.workItem.workId, promise);
      }

      if (inFlight.size === 0) {
        if (!this.stateManager.isAllDone()) {
          this.log('warning', 'Possible deadlock - no ready WorkItems');
          break;
        }
        continue;
      }

      const completed = await Promise.race(inFlight.values());
      inFlight.delete(completed.workId);

      const { workId, entryId, result } = completed;
      const state = this.stateManager.get(workId) as WorkItemState;

      this.totalLlmCalls += result.metrics.llmCallsMade;
      this.totalToolCalls += result.metrics.toolCallsMade;

      if (result.needsUserInput && result.userPrompt) {
        this.stateManager.markAwaitingUser(workId);
        this.workLedger.recordAwaitingUser(entryId, result.userPrompt as Record<string, unknown>);
        paused = true;
        userPrompt = result.userPrompt;
        break;
      }

      this.workLedger.recordCompletion(entryId, result);

      if (result.success) {
        this.stateManager.markCompleted(workId, result);
        lastResponse = result.response;
        this.emit(createEvent('workitem_completed', {
          workId,
          objective: state.workItem.objective,
          response: result.response,
          metrics: {
            llmCallsMade: result.metrics.llmCallsMade,
            toolCallsMade: result.metrics.toolCallsMade,
            durationMs: result.metrics.durationMs,
          },
        }, workId));
      } else {
        if (state.attemptCount < this.config.maxRetriesPerWorkItem) {
          this.stateManager.resetForRetry(workId);
          this.log('info', `Retrying WorkItem ${workId}`, { attempt: state.attemptCount + 1 });
        } else {
          this.stateManager.markFailed(workId, result.error ?? 'Unknown error', result);

          this.emit(createEvent('workitem_failed', {
            workId,
            objective: state.workItem.objective,
            error: result.error ?? 'Unknown error',
            toolErrors: result.toolErrors,
            terminationReason: result.terminationReason,
          }, workId));
        }
      }
    }

    const counts = this.stateManager.getCounts();
    const allDone = this.stateManager.isAllDone();
    const success = allDone && counts.failed === 0 && counts.completed > 0;

    let error: string | undefined;
    if (!success && !paused) {
      error = allDone ? 'Some WorkItems failed' : 'WorkItems incomplete';
    }

    return {
      success,
      response: lastResponse,
      error,
      paused,
      userPrompt,
      metrics: {
        totalIterations: iteration,
        totalLlmCalls: this.totalLlmCalls,
        totalToolCalls: this.totalToolCalls,
        durationMs: 0,
        workItemsCompleted: counts.completed,
        workItemsFailed: counts.failed,
        workItemsSkipped: counts.skipped,
      },
    };
  }

  /**
   * Dispatch an agent for a WorkItem.
   */
  private async dispatchAgent(
    context: ContextWindow,
    workItem: WorkItem,
    agentId: string
  ): Promise<{ workId: string; result: AgentResult }> {
    try {
      const runtimeConfig = this.resolveAgentRuntimeConfig(workItem.agent);
      const agent = new Agent(
        runtimeConfig.config,
        this.llm,
        this.toolRegistry,
        this.emit,
        this.requestId,
        this.agentRegistry,
        runtimeConfig.llm
      );

      const result = await agent.run({ context, workItem });
      return { workId: workItem.workId, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        workId: workItem.workId,
        result: {
          success: false,
          response: '',
          error: message,
          metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
          filesRead: [],
          invalidatedPaths: [],
          toolErrors: [message],
          terminationReason: `exception:${message}`,
          needsUserInput: false,
          isRefusal: false,
        },
      };
    }
  }

  /**
   * Parse system context from exploration result.
   */
  private parseSystemContext(output: unknown): SystemContext {
    const parsed = coerceStructuredOutput(output);
    if (parsed) {
      const asStringArray = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value.filter((item): item is string => typeof item === 'string');
      };

      const packageManagers = asStringArray(parsed.packageManagers);
      const frameworks = asStringArray(parsed.frameworks);
      const languages = asStringArray(parsed.languages);
      const patterns = asStringArray(parsed.patterns);
      const os = typeof parsed.os === 'string' ? parsed.os : process.platform;

      const allowedArtifactTypes = new Set([
        'config',
        'source',
        'test',
        'doc',
        'other',
      ]);
      const artifactsRaw = parsed.artifacts;
      const artifacts = Array.isArray(artifactsRaw)
        ? artifactsRaw
            .map((item) => {
              if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return null;
              }
              const obj = item as Record<string, unknown>;
              const path = typeof obj.path === 'string' ? obj.path : '';
              if (!path) return null;
              const typeRaw = typeof obj.type === 'string' ? obj.type : 'other';
              const type = allowedArtifactTypes.has(typeRaw) ? typeRaw : 'other';
              const description =
                typeof obj.description === 'string' ? obj.description : undefined;
              const relevance =
                typeof obj.relevance === 'number' ? obj.relevance : undefined;
              return { path, type, description, relevance };
            })
            .filter((item): item is SystemContext['artifacts'][number] => item !== null)
        : [];

      return {
        packageManagers,
        frameworks,
        languages,
        os,
        artifacts,
        patterns,
      };
    }

    this.log('warning', 'Failed to parse system context');
    return {
      packageManagers: [],
      frameworks: [],
      languages: [],
      os: process.platform,
      artifacts: [],
      patterns: [],
    };
  }

  /**
   * Parse script output from RuntimeScriptAgent.
   */
  private parseScriptOutput(
    output: unknown,
    goal: string,
    allowedAgents: string[],
    llmConfig: LLMRequestConfig
  ): RuntimeScriptOutput {
    const preview =
      typeof output === 'string'
        ? output
        : JSON.stringify(output ?? {});
    try {
      const parsed = coerceStructuredOutput(output);
      if (!parsed) {
        throw new Error('No structured output found in runtime_script response');
      }
      if (!Array.isArray(parsed.workItems)) {
        throw new Error('runtime_script workItems must be an array');
      }
      const workItems = parsed.workItems;
      if (workItems.length === 0) {
        throw new Error('runtime_script produced no workItems');
      }
      for (const [index, item] of workItems.entries()) {
        if (!item || typeof item !== 'object') {
          throw new Error(`runtime_script workItems[${index}] must be an object`);
        }
        const typedItem = item as Record<string, unknown>;
        if (typeof typedItem.id !== 'string' || typedItem.id.trim() === '') {
          throw new Error(`runtime_script workItems[${index}].id is required`);
        }
        if (typeof typedItem.objective !== 'string' || typedItem.objective.trim() === '') {
          throw new Error(`runtime_script workItems[${index}].objective is required`);
        }
        if (typeof typedItem.agent !== 'string' || typedItem.agent.trim() === '') {
          throw new Error(`runtime_script workItems[${index}].agent is required`);
        }
        if (!Array.isArray(typedItem.dependencies)) {
          throw new Error(`runtime_script workItems[${index}].dependencies must be an array`);
        }
        if (typedItem.dependencies.some((dep: unknown) => typeof dep !== 'string')) {
          throw new Error(`runtime_script workItems[${index}].dependencies must be strings`);
        }
        if (typedItem.targetPaths && !Array.isArray(typedItem.targetPaths)) {
          throw new Error(`runtime_script workItems[${index}].targetPaths must be an array`);
        }
      }
      const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
      const invalidAgents = workItems
        .map((item: { agent?: string }) => item.agent)
        .filter((agent: string | undefined) => !agent || !allowedSet.has(agent.toLowerCase()));
      if (invalidAgents.length > 0) {
        throw new Error(
          `runtime_script used disallowed agents: ${invalidAgents.join(', ')}`
        );
      }
      this.log('info', 'Parsed runtime script', {
        workItemCount: workItems.length,
        agents: workItems.map((w: { agent?: string }) => w.agent),
      });
      return {
        goal: typeof parsed.goal === 'string' ? parsed.goal : goal,
        workItems,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log('warning', 'Failed to parse script output', {
        error,
        responsePreview: preview.slice(0, 200),
      });
      this.emit(createEvent('llm_error', {
        agentType: 'runtime_script',
        provider: llmConfig.provider ?? 'unknown',
        model: llmConfig.model,
        error,
        errorType: 'validation',
        responseLength: preview.length,
      }));
    }
    throw new Error('runtime_script output could not be parsed');
  }

  /**
   * Resume after user input.
   */
  async resume(
    context: ContextWindow,
    userResponse: string
  ): Promise<OrchestratorResult> {
    context.addMessage('user', userResponse);

    const awaiting = this.stateManager.getAll().find((s) => s.status === 'awaiting_user');
    if (awaiting) {
      this.stateManager.resetForRetry(awaiting.workItem.workId);
    }

    throw new Error('Resume not yet implemented - script state not preserved');
  }

  private log(level: keyof OrchestratorLogger, msg: string, meta?: Record<string, unknown>): void {
    this.logger?.[level](msg, { component: 'orchestrator', requestId: this.requestId, ...meta });
  }
}
