export type {
  VpVersion,
  CompileStatus,
  VerificationStepKind,
  VerificationStep,
  VerificationPlan,
  RefinedInvariant,
  CompilerQuestion,
  CompiledInvariant,
  SystemSurface,
  InvariantInput,
  CompileFinding,
  CompileRequest,
  VerificationProgram,
  SemanticCompilerStage,
  StageStatus,
  StageSnapshot,
  SemanticCompilerState,
  InvariantVerdict,
  VerdictReport,
} from './types.js';

export type {
  StrategySelectionInput,
  StrategySupport,
  StrategyCompileInput,
  StrategyCompileOutput,
  VerificationStrategyPlugin,
} from './plugins.js';

export {
  DEFAULT_STRATEGY_PLUGINS,
  selectBestStrategy,
} from './plugins.js';

export {
  compileVerificationProgram,
  type CompileOptions,
} from './compiler.js';

export {
  STAGE_ORDER,
  createInitialState,
  markStageRunning,
  markStageCompleted,
  markStageWaitingUser,
  markStageFailed,
  saveState,
  loadState,
} from './stages.js';

export type {
  HarnessArtifact,
  HarnessGenerationOptions,
  HarnessGenerationResult,
} from './harness.js';

export {
  generateHarnessArtifacts,
} from './harness.js';

export type {
  EvidenceRunOptions,
  EvidenceLayoutResult,
} from './evidence.js';

export {
  prepareEvidenceLayout,
} from './evidence.js';

export type {
  EmitVerdictOptions,
  EmitVerdictResult,
} from './report.js';

export {
  emitVerdictArtifacts,
} from './report.js';

export type {
  UserReviewPrompt,
} from './adapters.js';

export {
  vpToWorkItemSpecs,
  buildUserReviewPrompts,
} from './adapters.js';
