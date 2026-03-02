/**
 * Control-plane state contracts used by decisions and patches.
 */

export interface WorkItemSpec {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: {
    maxToolCalls?: number;
    maxLlmCalls?: number;
    maxDurationMs?: number;
  };
  semantic?: unknown;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AuditLogEntry {
  timestamp: number;
  source: string;
  event: string;
  details: Record<string, unknown>;
}
