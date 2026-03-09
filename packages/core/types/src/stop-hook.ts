import type { TerminationReason } from './termination.js';

export interface DeferredWorkItem {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  background: boolean;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
  semantic?: unknown;
}

export interface ExecutionSnapshot {
  toolHistory: {
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
    outputPreview?: string;
  }[];
  filesModified: string[];
  filesRead: string[];
  metrics: {
    llmCallsMade: number;
    toolCallsMade: number;
    toolCallsSucceeded: number;
    toolCallsFailed: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    contextPercentUsed: number;
  };
  artifacts?: { sourcePath: string; name: string; kind: string; insight?: string }[];
  fullResponse: string;
}

export type StopHookResult =
  | {
      decision: 'allow';
      systemMessage?: string;
      terminationReason?: TerminationReason;
      deferredWork?: DeferredWorkItem[];
    }
  | {
      decision: 'block';
      reason: string;
      systemMessage?: string;
      deferredWork?: DeferredWorkItem[];
    };

export interface StopHookUserPrompt {
  question: string;
  options?: (string | { label: string; description?: string })[];
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

export interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: TerminationReason;
  iteration: number;
  agentType: string;
  sessionKey: string;
  userPrompt?: StopHookUserPrompt;
  executionSnapshot?: ExecutionSnapshot;
}

export type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;
