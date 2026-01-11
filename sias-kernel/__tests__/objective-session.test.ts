import { describe, test, expect } from 'bun:test';
import { restoreCheckpoint, persistCheckpoint } from './sias-kernel/checkpoint.js';
import type { SIASState } from './sias-kernel/types.js';
import { persistSessionObjectiveMetadata, ensureInitializationDecision } from './sias-kernel/session.js';

function createMockGraphStore() {
  const sessions = new Map<string, any>();
  const checkpoints = new Map<string, any[]>();
  const decisions = new Map<string, any[]>();
  const patches = new Map<string, any[]>();
  const decisionEmbeddings = new Map<string, any>();
  const principalContexts = new Map<string, any>();

  return {
    // Session methods
    getSiasSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    createSiasSession: (sessionId: string) => {
      if (sessions.has(sessionId)) return false;
      sessions.set(sessionId, { sessionId, status: 'created', metadata: {} });
      return true;
    },
    updateSiasSession: (sessionId: string, update: any) => {
      const session = sessions.get(sessionId) ?? { sessionId };
      sessions.set(sessionId, { ...session, ...update });
    },

    // Checkpoints
    getLatestSiasCheckpoint: (sessionId: string) => {
      const list = checkpoints.get(sessionId) ?? [];
      return list[list.length - 1] ?? null;
    },
    insertSiasCheckpoint: (sessionId: string, version: number, iteration: number, payload: any) => {
      const list = checkpoints.get(sessionId) ?? [];
      list.push({ sessionId, version, iteration, payload });
      checkpoints.set(sessionId, list);
    },
    listSiasCheckpoints: (sessionId: string) => checkpoints.get(sessionId) ?? [],

    // Decisions
    upsertSiasDecision: (decision: any) => {
      const list = decisions.get(decision.sessionId) ?? [];
      list.push(decision);
      decisions.set(decision.sessionId, list);
    },
    listSiasDecisions: (sessionId: string) => decisions.get(sessionId) ?? [],
    getSiasDecisionEmbedding: (decisionId: string) => decisionEmbeddings.get(decisionId) ?? null,
    upsertSiasDecisionEmbedding: (decisionId: string, embedding: number[]) => {
      decisionEmbeddings.set(decisionId, { decisionId, embedding });
    },

    // Patches (minimal for checkpoint persistence)
    listSiasPatches: (sessionId: string) => patches.get(sessionId) ?? [],
    upsertSiasPatch: (patch: any) => {
      const list = patches.get(patch.sessionId) ?? [];
      list.push(patch);
      patches.set(patch.sessionId, list);
    },

    upsertSiasPrincipalContext: (context: any) => {
      principalContexts.set(context.sessionId, context);
    },
    withTransaction: (fn: () => void) => fn(),
  } as any;
}

describe('Objective/session persistence', () => {
  test('save and restore objective state with decision log initialization', async () => {
    const store = createMockGraphStore();
    const sessionId = 'sess-objective';

    const state: SIASState = {
      sessionId,
      iteration: 0,
      version: 'v000',
      currentFocus: 'Initialize kernel objectives',
      patchSummary: 'boot',
      learnedConstraints: [],
      horizonObjectives: ['Initialize kernel objectives'],
      lastUpgradeIteration: 0,
    };

    // restore should create session and default state
    const restored = await restoreCheckpoint(store, sessionId, 'v000');
    expect(restored.currentFocus).toBe('Initialize kernel objectives');

    // ensure decision and session metadata are persisted
    ensureInitializationDecision(store, restored);
    persistSessionObjectiveMetadata(store, sessionId, restored);

    const initialDecisions = store.listSiasDecisions(sessionId);
    expect(initialDecisions).toHaveLength(1);
    expect(initialDecisions[0].decisionType).toBe('initialize_objectives');

    // mutate state and persist
    const updatedState: SIASState = {
      ...state,
      iteration: 3,
      currentFocus: 'Define benchmark tiers',
      learnedConstraints: ['Prefer smoke tier first'],
      horizonObjectives: ['Initialize kernel objectives', 'Define benchmark tiers'],
      patchSummary: 'updated',
    };

    await persistCheckpoint(store, updatedState);
    persistSessionObjectiveMetadata(store, sessionId, updatedState);

    // restore should round-trip updated objective state
    const roundTripped = await restoreCheckpoint(store, sessionId, 'v000');
    expect(roundTripped.currentFocus).toBe('Define benchmark tiers');
    expect(roundTripped.horizonObjectives).toContain('Define benchmark tiers');
    expect(roundTripped.learnedConstraints).toContain('Prefer smoke tier first');
    expect(roundTripped.patchSummary).toBe('updated');

    // decisions log should still include initialization entry
    const decisions = store.listSiasDecisions(sessionId);
    expect(decisions[0].decisionType).toBe('initialize_objectives');
  });
});
