export type VpVersion = '0.1';

export type CompileStatus = 'compiled' | 'needs_user_answer' | 'failed';

export type VerificationStepKind = 'harness_setup' | 'action' | 'assert' | 'trace_check';

export interface VerificationStep {
  kind: VerificationStepKind;
  spec: string;
}

export interface VerificationPlan {
  strategy_id: string;
  steps: VerificationStep[];
  evidence: string[];
}

export interface RefinedInvariant {
  intent: string;
  scope: string[];
  operational_definition: string[];
}

export interface CompilerQuestion {
  question_id: string;
  invariant_id: string;
  question: string;
  rationale: string;
  options?: string[];
}

export interface CompiledInvariant {
  inv_id: string;
  original_text: string;
  refined: RefinedInvariant;
  assumptions: string[];
  verification_plan: VerificationPlan;
  verdict_rule: string;
  compile_status: CompileStatus;
  questions?: CompilerQuestion[];
}

export interface SystemSurface {
  services: string[];
  storage: string[];
  ui_surfaces: string[];
  external_dependencies: string[];
  main_flows: string[];
}

export interface InvariantInput {
  inv_id?: string;
  text: string;
  context?: string;
}

export interface CompileFinding {
  finding_id: string;
  severity: 'info' | 'warning' | 'error';
  code:
    | 'missing_system_surface'
    | 'unverifiable_term'
    | 'contradiction'
    | 'strategy_unavailable'
    | 'agent_unavailable'
    | 'agent_error';
  message: string;
  invariant_id?: string;
}

export interface CompileRequest {
  uow_id: string;
  invariants: InvariantInput[];
  system_surface: SystemSurface;
  repo_metadata?: Record<string, unknown>;
}

export interface VerificationProgram {
  vp_version: VpVersion;
  uow_id: string;
  generated_at: string;
  system_surface: SystemSurface;
  invariants: CompiledInvariant[];
  compile_findings: CompileFinding[];
}

export type SemanticCompilerStage =
  | 'stage0_parse'
  | 'stage1_compile_invariants'
  | 'stage2_user_review_gate'
  | 'stage3_generate_harness'
  | 'stage4_run_verification'
  | 'stage5_emit_verdict';

export type StageStatus = 'pending' | 'running' | 'waiting_user' | 'completed' | 'failed';

export interface StageSnapshot {
  stage: SemanticCompilerStage;
  status: StageStatus;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface SemanticCompilerState {
  version: VpVersion;
  uow_id: string;
  current_stage: SemanticCompilerStage;
  status: 'idle' | 'running' | 'waiting_user' | 'failed' | 'completed';
  updated_at: string;
  stages: Record<SemanticCompilerStage, StageSnapshot>;
  pending_questions: CompilerQuestion[];
  findings: CompileFinding[];
  artifacts: {
    vp_path?: string;
    harness_manifest_path?: string;
    verdict_json_path?: string;
    verdict_summary_path?: string;
  };
}

export interface InvariantVerdict {
  inv_id: string;
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  evidence_path: string;
  assumptions_used?: string[];
  counterexample?: string;
  notes?: string;
}

export interface VerdictReport {
  uow_id: string;
  generated_at: string;
  invariant_results: InvariantVerdict[];
}
