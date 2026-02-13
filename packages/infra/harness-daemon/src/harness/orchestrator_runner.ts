import type { AgentHooks, AgentRegistry, EventEmitCallback, ModelSelection } from 'agent';
import type { ContextWindow } from 'context';
import type { LLMAdapter } from 'llm';
import {
  Orchestrator,
  type OrchestratorConfig,
  type OrchestratorLogger,
  type OrchestratorResult,
  type OrchestratorRuntime,
} from 'orchestrator';
import type { ToolRegistry } from 'tools';

export interface OrchestratorRunParams {
  config: Partial<OrchestratorConfig>;
  toolRegistry: ToolRegistry;
  llm: LLMAdapter;
  emit: EventEmitCallback;
  requestId: string;
  logger?: OrchestratorLogger;
  agentRegistry?: AgentRegistry;
  hooks?: AgentHooks;
  getModelSelection?: (agentType: string) => ModelSelection | null;
  context: ContextWindow;
  goal: string;
  agentType: string;
  cwd: string;
  runtime?: OrchestratorRuntime;
}

export interface OrchestratorRunner {
  execute(params: OrchestratorRunParams): Promise<OrchestratorResult>;
}

export class DefaultOrchestratorRunner implements OrchestratorRunner {
  async execute(params: OrchestratorRunParams): Promise<OrchestratorResult> {
    const orchestrator = new Orchestrator(
      params.config,
      params.toolRegistry,
      params.llm,
      params.emit,
      params.requestId,
      params.logger,
      params.agentRegistry,
      params.hooks,
      params.getModelSelection
    );

    return orchestrator.execute(
      params.context,
      params.goal,
      params.agentType,
      params.cwd,
      params.runtime
    );
  }
}
