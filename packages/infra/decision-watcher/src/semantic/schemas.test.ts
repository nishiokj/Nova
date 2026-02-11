import { describe, expect, it } from 'bun:test';
import {
  ChangeEntrySchema,
  ComponentStatusSchema,
  GapEntrySchema,
  TradeoffAnalysisSchema,
  SemanticFileStateSchema,
  isFailedSemantic,
  isInitialSemantic,
  isValidSemantic,
  type FailedSemanticFile,
  type InitialSemanticFile,
  type ValidSemanticFile,
} from './schemas.js';

const validComponentStatus = {
  component: 'schemas.test.ts',
  status: 'partial',
  location: 'packages/infra/decision-watcher/src/semantic/schemas.test.ts:1',
};

const validChangeEntry = {
  file: 'packages/infra/decision-watcher/src/semantic/schemas.test.ts',
  summary: 'Added schema validation tests',
  rationale: 'Ensure discriminated union coverage',
};

const validGapEntry = {
  required: 'Comprehensive schema tests',
  current: 'Added initial test cases',
  blocker: 'None',
};

const validTradeoffAnalysis = {
  title: 'Test framework choice',
  options: [
    { id: 'A', description: 'Use bun:test' },
    { id: 'B', description: 'Use vitest' },
  ],
  considerations: ['Consistency with package test runner', 'Speed'],
  relevantPreferences: ['testing.framework'],
  precedent: 'Other decision-watcher tests use bun:test',
  assessment: 'Prefer bun:test for consistency',
};

const validSemanticFile: ValidSemanticFile = {
  _state: 'valid',
  meta: {
    workId: 'work-123',
    created: '2026-02-03T00:00:00.000Z',
    lastAudit: '2026-02-03T00:01:00.000Z',
    auditSequence: 2,
    logPosition: 10,
    totalEvents: 12,
  },
  stateAndProgress: {
    objective: 'Create schema validation tests',
    currentState: [validComponentStatus],
    changesMade: [validChangeEntry],
    gapAnalysis: [validGapEntry],
    reasoningTrace: ['1. Read schemas', '2. Add tests'],
    blockers: [],
  },
  decisionContext: {
    pendingQuestions: ['Do we need extra edge cases?'],
    tradeoffs: [validTradeoffAnalysis],
  },
  crossReferences: {
    sessionSalience: 'workitems/semantic',
    preferences: ['testing.framework'],
    siblingWorkItems: ['work-456'],
    decisions: ['decision-123'],
  },
};

const failedSemanticFile: FailedSemanticFile = {
  _state: 'failed',
  meta: {
    workId: 'work-123',
    auditSequence: 3,
    timestamp: '2026-02-03T00:02:00.000Z',
  },
  error: 'Schema validation failed',
  previousValidVersion: 2,
};

const initialSemanticFile: InitialSemanticFile = {
  _state: 'initial',
  meta: {
    workId: 'work-123',
    created: '2026-02-03T00:00:00.000Z',
    objective: 'Create schema validation tests',
  },
};

// ============================================
// COMPONENT SCHEMA TESTS
// ============================================

describe('ComponentStatusSchema', () => {
  it('accepts a valid component status', () => {
    const result = ComponentStatusSchema.safeParse(validComponentStatus);
    expect(result.success).toBe(true);
  });

  it('rejects invalid status enum', () => {
    const result = ComponentStatusSchema.safeParse({
      ...validComponentStatus,
      status: 'done',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing component field', () => {
    const { component, ...rest } = validComponentStatus;
    const result = ComponentStatusSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('ChangeEntrySchema', () => {
  it('accepts a valid change entry', () => {
    const result = ChangeEntrySchema.safeParse(validChangeEntry);
    expect(result.success).toBe(true);
  });

  it('rejects missing rationale', () => {
    const { rationale, ...rest } = validChangeEntry;
    const result = ChangeEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('GapEntrySchema', () => {
  it('accepts a valid gap entry', () => {
    const result = GapEntrySchema.safeParse(validGapEntry);
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { required, ...rest } = validGapEntry;
    const result = GapEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('TradeoffAnalysisSchema', () => {
  it('accepts a valid tradeoff analysis', () => {
    const result = TradeoffAnalysisSchema.safeParse(validTradeoffAnalysis);
    expect(result.success).toBe(true);
  });

  it('rejects analyses with fewer than two options', () => {
    const result = TradeoffAnalysisSchema.safeParse({
      ...validTradeoffAnalysis,
      options: [{ id: 'A', description: 'Only option' }],
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// DISCRIMINATED UNION TESTS
// ============================================

describe('SemanticFileStateSchema', () => {
  it('accepts valid semantic file state', () => {
    const result = SemanticFileStateSchema.safeParse(validSemanticFile);
    expect(result.success).toBe(true);
  });

  it('accepts failed semantic file state', () => {
    const result = SemanticFileStateSchema.safeParse(failedSemanticFile);
    expect(result.success).toBe(true);
  });

  it('accepts initial semantic file state', () => {
    const result = SemanticFileStateSchema.safeParse(initialSemanticFile);
    expect(result.success).toBe(true);
  });

  it('rejects unknown _state discriminator', () => {
    const result = SemanticFileStateSchema.safeParse({
      ...validSemanticFile,
      _state: 'pending',
    });
    expect(result.success).toBe(false);
  });

  it('rejects valid state missing required section', () => {
    const { decisionContext, ...rest } = validSemanticFile;
    const result = SemanticFileStateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ============================================
// TYPE GUARD TESTS
// ============================================

describe('semantic state type guards', () => {
  it('identifies valid semantic state', () => {
    const state = validSemanticFile;
    expect(isValidSemantic(state)).toBe(true);
    expect(isFailedSemantic(state)).toBe(false);
    expect(isInitialSemantic(state)).toBe(false);
  });

  it('identifies failed semantic state', () => {
    const state = failedSemanticFile;
    expect(isFailedSemantic(state)).toBe(true);
    expect(isValidSemantic(state)).toBe(false);
    expect(isInitialSemantic(state)).toBe(false);
  });

  it('identifies initial semantic state', () => {
    const state = initialSemanticFile;
    expect(isInitialSemantic(state)).toBe(true);
    expect(isValidSemantic(state)).toBe(false);
    expect(isFailedSemantic(state)).toBe(false);
  });
});
