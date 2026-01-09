import type { GraphStore } from '../packages/graphd/src/index.js';
import type {
  Checkpoint,
  CheckpointDecision,
  CheckpointPatch,
  CheckpointV1,
  DecisionEmbedding,
  SIASState,
} from './types.js';

export const CHECKPOINT_VERSION = 1;

export function migrateCheckpoint(checkpoint: Checkpoint): Checkpoint {
  if (checkpoint.version === 1) {
    return checkpoint;
  }
  return checkpoint;
}

export async function restoreCheckpoint(
  store: GraphStore,
  sessionId: string,
  fallbackVersion: string
): Promise<SIASState> {
  const latest = store.getLatestSiasCheckpoint(sessionId);
  if (latest?.payload) {
    const checkpoint = migrateCheckpoint(latest.payload as CheckpointV1);
    return buildStateFromCheckpoint(checkpoint, fallbackVersion);
  }

  const created = store.createSiasSession(sessionId);
  if (!created) {
    store.updateSiasSession(sessionId, { status: 'running' });
  }

  return {
    sessionId,
    iteration: 0,
    version: fallbackVersion,
    currentFocus: 'Initialize kernel objectives',
    patchSummary: 'No patches applied yet.',
    learnedConstraints: [],
    horizonObjectives: [
      'Initialize kernel objectives',
      'Establish health metrics, anomaly detection, and recovery',
      'Define benchmark tiers and isolated runner',
      'Wire agent specifications and structured outputs',
      'Implement worktree lifecycle and upgrade flow',
      'Enable flip-flop detection and decision embeddings',
    ],
    lastUpgradeIteration: 0,
  };
}

export async function persistCheckpoint(store: GraphStore, state: SIASState): Promise<void> {
  const patches = store.listSiasPatches(state.sessionId);
  const decisions = store.listSiasDecisions(state.sessionId);
  const decisionEmbeddings: DecisionEmbedding[] = decisions
    .map((decision) => {
      const embeddingRecord = store.getSiasDecisionEmbedding(decision.decisionId);
      if (!embeddingRecord?.embedding) return null;
      return { decisionId: decision.decisionId, embedding: embeddingRecord.embedding };
    })
    .filter(Boolean) as DecisionEmbedding[];

  const checkpoint: CheckpointV1 = {
    version: CHECKPOINT_VERSION,
    session_id: state.sessionId,
    iteration: state.iteration,
    timestamp: Date.now(),
    principal_understanding: {
      objectives: state.horizonObjectives,
      learnedConstraints: state.learnedConstraints,
      currentFocus: state.currentFocus,
      patchSummary: state.patchSummary,
    },
    patches: patches.map((patch) => mapPatch(patch.patchId, patch.objective ?? '', patch.reasoning ?? '', patch.status, patch.filesChanged ?? [])),
    decisions: decisions.map((decision) => mapDecision(decision.iteration, decision.agent, decision.decisionType, decision.reasoning ?? '')),
    decision_embeddings: decisionEmbeddings,
    last_upgrade_iteration: state.lastUpgradeIteration,
    last_iteration_result: state.lastIterationResult,
  };

  store.withTransaction(() => {
    store.insertSiasCheckpoint(state.sessionId, checkpoint.version, state.iteration, checkpoint);
    store.upsertSiasPrincipalContext({
      sessionId: state.sessionId,
      patchSummary: state.patchSummary,
      currentFocus: state.currentFocus,
      learnedConstraints: state.learnedConstraints,
      horizonObjectives: state.horizonObjectives,
      lastUpdated: Date.now() / 1000,
      learnedConstraintsJson: null,
      horizonObjectivesJson: null,
    });
  });
}

function buildStateFromCheckpoint(checkpoint: Checkpoint, fallbackVersion: string): SIASState {
  return {
    sessionId: checkpoint.session_id,
    iteration: checkpoint.iteration,
    version: fallbackVersion,
    currentFocus: checkpoint.principal_understanding.currentFocus,
    patchSummary: checkpoint.principal_understanding.patchSummary,
    learnedConstraints: checkpoint.principal_understanding.learnedConstraints,
    horizonObjectives: checkpoint.principal_understanding.objectives,
    lastIterationResult: checkpoint.last_iteration_result ?? undefined,
    lastUpgradeIteration: checkpoint.last_upgrade_iteration ?? 0,
  };
}

function mapPatch(
  id: string,
  objective: string,
  reasoning: string,
  status: 'applied' | 'rolled_back' | string,
  files: string[]
): CheckpointPatch {
  return {
    id,
    objective,
    reasoning,
    status: status === 'rolled_back' ? 'rolled_back' : 'applied',
    files,
  };
}

function mapDecision(
  iteration: number,
  agent: string,
  decision: string,
  reasoning: string
): CheckpointDecision {
  return {
    iteration,
    agent,
    decision,
    reasoning,
  };
}
