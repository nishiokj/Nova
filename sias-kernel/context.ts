import { ContextWindow } from '../packages/agent-core/src/types/context.js';
import type { AgentType } from './types.js';

export interface ContextPolicy {
  tokenThreshold: number;
  thresholdPercent: number;
  minIterationsBetween: number;
  preserve: {
    protectedSections: string[];
    recentMessages: number;
  };
  summarization: {
    maxSummaryChars: number;
  };
}

export interface ContextPolicies {
  principal: ContextPolicy;
  oncall: ContextPolicy;
  testing: ContextPolicy;
  coding: ContextPolicy;
}

const DEFAULT_POLICIES: ContextPolicies = {
  principal: {
    tokenThreshold: 150000,
    thresholdPercent: 0.85,
    minIterationsBetween: 3,
    preserve: {
      protectedSections: [
        'session_objectives',
        'learned_constraints',
        'decision_history',
        'anti_flip_flop_state',
      ],
      recentMessages: 10,
    },
    summarization: {
      maxSummaryChars: 4000,
    },
  },
  oncall: {
    tokenThreshold: 100000,
    thresholdPercent: 0.9,
    minIterationsBetween: 1,
    preserve: {
      protectedSections: ['current_investigation', 'hypothesis_history'],
      recentMessages: 5,
    },
    summarization: {
      maxSummaryChars: 2000,
    },
  },
  testing: {
    tokenThreshold: 50000,
    thresholdPercent: 0.9,
    minIterationsBetween: 1,
    preserve: {
      protectedSections: ['benchmark_baseline'],
      recentMessages: 3,
    },
    summarization: {
      maxSummaryChars: 1000,
    },
  },
  coding: {
    tokenThreshold: 120000,
    thresholdPercent: 0.9,
    minIterationsBetween: 0,
    preserve: {
      protectedSections: ['objective', 'constraints'],
      recentMessages: 5,
    },
    summarization: {
      maxSummaryChars: 2000,
    },
  },
};

export class ContextManager {
  private contexts = new Map<AgentType, ContextWindow>();
  private lastCompactionIteration = new Map<AgentType, number>();
  private compactionCounts = new Map<AgentType, number>();
  private policies: ContextPolicies;
  private maxTokens: number;
  private sessionId: string;

  constructor(sessionId: string, maxTokens = 200000, policies: ContextPolicies = DEFAULT_POLICIES) {
    this.sessionId = sessionId;
    this.maxTokens = maxTokens;
    this.policies = policies;
  }

  getContext(agent: AgentType): ContextWindow {
    const existing = this.contexts.get(agent);
    if (existing) return existing;
    const context = new ContextWindow(`${this.sessionId}:${agent}`, this.maxTokens);
    this.contexts.set(agent, context);
    return context;
  }

  recordCompaction(agent: AgentType): void {
    const count = this.compactionCounts.get(agent) ?? 0;
    this.compactionCounts.set(agent, count + 1);
  }

  getCompactionCount(agent: AgentType): number {
    return this.compactionCounts.get(agent) ?? 0;
  }

  maybeCompact(agent: AgentType, iteration: number): boolean {
    const context = this.getContext(agent);
    const policy = this.policies[agent as keyof ContextPolicies];
    const lastCompaction = this.lastCompactionIteration.get(agent) ?? -Infinity;
    if (iteration - lastCompaction < policy.minIterationsBetween) {
      return false;
    }

    if (
      context.metrics.contextTokens < policy.tokenThreshold &&
      context.metrics.percentageUsed < policy.thresholdPercent
    ) {
      return false;
    }

    const items = context.items.filter((item) => item.type === 'message');
    const recentMessages = items.slice(-policy.preserve.recentMessages);
    const summaryText = this.buildSummary(items.slice(0, -policy.preserve.recentMessages), policy);

    const newContext = new ContextWindow(`${this.sessionId}:${agent}`, this.maxTokens);
    if (summaryText) {
      newContext.addMessage('system', summaryText);
    }
    for (const item of recentMessages) {
      if (item.type === 'message') {
        newContext.addMessage(item.role, item.content);
      }
    }

    this.contexts.set(agent, newContext);
    this.lastCompactionIteration.set(agent, iteration);
    this.recordCompaction(agent);
    return true;
  }

  private buildSummary(items: Array<{ role: string; content: string | unknown }>, policy: ContextPolicy): string {
    if (items.length === 0) return '';
    const rawText = items
      .map((item) => {
        const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
        return `[${item.role}] ${content}`;
      })
      .join('\n');

    const trimmed = rawText.slice(-policy.summarization.maxSummaryChars);
    return `Context summary (preserved sections: ${policy.preserve.protectedSections.join(', ')}):\n${trimmed}`;
  }
}
