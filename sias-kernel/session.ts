import type { Session } from '../packages/agent-core/src/types/session.js';
import type { GraphStore } from '../packages/graphd/src/index.js';
import type { SIASState } from './types.js';

export interface SessionObjectiveMetadata {
  currentObjective: string;
  horizonObjectives: string[];
  learnedConstraints: string[];
  patchSummary: string;
  iteration: number;
}

function mergeMetadata(existing: Record<string, unknown> | undefined, next: SessionObjectiveMetadata): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    currentObjective: next.currentObjective,
    horizonObjectives: next.horizonObjectives,
    learnedConstraints: next.learnedConstraints,
    patchSummary: next.patchSummary,
    iteration: next.iteration,
  };
}

export function persistSessionObjectiveMetadata(store: GraphStore, sessionId: string, state: SIASState): void {
  const existing = store.getSiasSession(sessionId)?.metadata as Record<string, unknown> | undefined;
  const merged = mergeMetadata(existing, {
    currentObjective: state.currentFocus,
    horizonObjectives: state.horizonObjectives,
    learnedConstraints: state.learnedConstraints,
    patchSummary: state.patchSummary,
    iteration: state.iteration,
  });

  store.updateSiasSession(sessionId, { metadata: merged as Session['metadata'] });
}

export function ensureInitializationDecision(store: GraphStore, state: SIASState): string {
  const existing = store.listSiasDecisions(state.sessionId);
  if (existing.length > 0) return existing[0].decisionId;

  const decisionId = `decision-${state.sessionId}-0`;
  store.upsertSiasDecision({
    decisionId,
    sessionId: state.sessionId,
    iteration: 0,
    agent: 'principal',
    decisionType: 'initialize_objectives',
    reasoning: `Initialized objectives: ${state.currentFocus}`,
    outcome: 'initialize_objectives',
    relatedDecisionsJson: null,
    createdAt: Date.now() / 1000,
  });
  return decisionId;
}
