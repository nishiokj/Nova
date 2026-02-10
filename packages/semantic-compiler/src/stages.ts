import fs from 'fs/promises';
import path from 'path';
import type {
  CompileFinding,
  CompilerQuestion,
  SemanticCompilerStage,
  SemanticCompilerState,
  StageSnapshot,
} from './types.js';

export const STAGE_ORDER: SemanticCompilerStage[] = [
  'stage0_parse',
  'stage1_compile_invariants',
  'stage2_user_review_gate',
  'stage3_generate_harness',
  'stage4_run_verification',
  'stage5_emit_verdict',
];

function snapshot(stage: SemanticCompilerStage): StageSnapshot {
  return {
    stage,
    status: 'pending',
  };
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function createInitialState(uowId: string, now: Date = new Date()): SemanticCompilerState {
  return {
    version: '0.1',
    uow_id: uowId,
    current_stage: 'stage0_parse',
    status: 'idle',
    updated_at: nowIso(now),
    stages: {
      stage0_parse: snapshot('stage0_parse'),
      stage1_compile_invariants: snapshot('stage1_compile_invariants'),
      stage2_user_review_gate: snapshot('stage2_user_review_gate'),
      stage3_generate_harness: snapshot('stage3_generate_harness'),
      stage4_run_verification: snapshot('stage4_run_verification'),
      stage5_emit_verdict: snapshot('stage5_emit_verdict'),
    },
    pending_questions: [],
    findings: [],
    artifacts: {},
  };
}

export function markStageRunning(
  state: SemanticCompilerState,
  stage: SemanticCompilerStage,
  now: Date = new Date()
): SemanticCompilerState {
  const next: SemanticCompilerState = {
    ...state,
    current_stage: stage,
    status: 'running',
    updated_at: nowIso(now),
    stages: {
      ...state.stages,
      [stage]: {
        ...state.stages[stage],
        status: 'running',
        started_at: state.stages[stage].started_at ?? nowIso(now),
        error: undefined,
      },
    },
  };
  return next;
}

export function markStageCompleted(
  state: SemanticCompilerState,
  stage: SemanticCompilerStage,
  now: Date = new Date()
): SemanticCompilerState {
  const next: SemanticCompilerState = {
    ...state,
    updated_at: nowIso(now),
    stages: {
      ...state.stages,
      [stage]: {
        ...state.stages[stage],
        status: 'completed',
        completed_at: nowIso(now),
      },
    },
  };

  const stageIdx = STAGE_ORDER.indexOf(stage);
  const isFinal = stageIdx === STAGE_ORDER.length - 1;
  if (isFinal) {
    next.status = 'completed';
    return next;
  }

  next.current_stage = STAGE_ORDER[stageIdx + 1];
  next.status = 'idle';
  return next;
}

export function markStageWaitingUser(
  state: SemanticCompilerState,
  stage: SemanticCompilerStage,
  questions: CompilerQuestion[],
  findings: CompileFinding[] = [],
  now: Date = new Date()
): SemanticCompilerState {
  return {
    ...state,
    current_stage: stage,
    status: 'waiting_user',
    updated_at: nowIso(now),
    pending_questions: questions,
    findings: findings.length > 0 ? findings : state.findings,
    stages: {
      ...state.stages,
      [stage]: {
        ...state.stages[stage],
        status: 'waiting_user',
        completed_at: undefined,
      },
    },
  };
}

export function markStageFailed(
  state: SemanticCompilerState,
  stage: SemanticCompilerStage,
  error: string,
  now: Date = new Date()
): SemanticCompilerState {
  return {
    ...state,
    current_stage: stage,
    status: 'failed',
    updated_at: nowIso(now),
    stages: {
      ...state.stages,
      [stage]: {
        ...state.stages[stage],
        status: 'failed',
        error,
      },
    },
  };
}

export async function saveState(filePath: string, state: SemanticCompilerState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function loadState(filePath: string): Promise<SemanticCompilerState | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as SemanticCompilerState;
  } catch {
    return null;
  }
}
