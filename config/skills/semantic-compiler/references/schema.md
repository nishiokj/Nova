# Semantic Compiler Schema

Use this schema for compiled outputs.

## Types (TypeScript)

```ts
export type CompileStatus = 'compiled' | 'needs_user_answer' | 'failed';

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

export interface RefinedInvariant {
  intent: string;
  scope: string[];
  operational_definition: string[];
}

export type VerificationStrategyId =
  | 'ui_scenario'
  | 'api_scenario'
  | 'restart_persistence'
  | 'trace_checker';

export type Assertion =
  | { kind: 'equals'; left: string; right: string | number | boolean }
  | { kind: 'contains'; left: string; right: string }
  | { kind: 'exists'; target: string }
  | { kind: 'count_lte'; target: string; max: number }
  | { kind: 'status_code'; target: string; expected: number }
  | { kind: 'json_path_equals'; source: string; path: string; expected: string | number | boolean }
  | { kind: 'event_occurs'; event: string; min_count?: number }
  | { kind: 'event_order'; before: string; after: string }
  | { kind: 'eventually'; assertion: Exclude<Assertion, { kind: 'eventually' }>; timeout_ms: number };

export type VerificationStep =
  | {
      kind: 'harness_setup';
      spec: string;
      deterministic_seed?: number;
      fixtures?: string[];
    }
  | {
      kind: 'action';
      spec: string;
      actor?: 'user' | 'system' | 'harness';
    }
  | {
      kind: 'assert';
      spec: string;
      assertion: Assertion;
    }
  | {
      kind: 'trace_check';
      spec: string;
      predicate: string;
      trace_source: string;
    };

export interface VerificationPlan {
  strategy_id: VerificationStrategyId;
  steps: VerificationStep[];
  evidence: string[];
}

export interface CompilerQuestion {
  question_id: string;
  invariant_id: string;
  question: string;
  rationale: string;
  options?: string[];
}

export interface CompileFinding {
  finding_id: string;
  severity: 'info' | 'warning' | 'error';
  code:
    | 'missing_system_surface'
    | 'unverifiable_term'
    | 'contradiction'
    | 'strategy_unavailable'
    | 'non_assertable_claim'
    | 'schema_nonconformant';
  message: string;
  invariant_id?: string;
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

export interface VerificationProgram {
  vp_version: '0.1';
  uow_id: string;
  generated_at: string;
  system_surface: SystemSurface;
  invariants: CompiledInvariant[];
  compile_findings: CompileFinding[];
}
```

## Compilation Report Shape

```ts
export interface CompilationReport {
  uow_id: string;
  generated_at: string;
  compile_findings: CompileFinding[];
  unresolved_questions: CompilerQuestion[];
  invariants: Array<{
    inv_id: string;
    compile_status: CompileStatus;
    refined_intent: string;
    strategy_id: VerificationStrategyId | 'none';
    assumptions: string[];
  }>;
}
```

## Approval Result Shape

```ts
export interface ApprovalDecision {
  approved: boolean;
  edited_invariants?: Array<{
    inv_id: string;
    text: string;
    context?: string;
  }>;
  answers?: Array<{
    question_id: string;
    answer: string;
  }>;
  notes?: string;
}
```

## One-Retry Rule

Use this status transition policy:
- `compiled` -> ready for approval.
- `needs_user_answer` -> ask targeted questions, recompile once.
- second unresolved pass -> `failed` with concrete blocker and rewrite suggestion.

## Conformance Policy

If output violates field names or required structure, set:
- `compile_status: failed` for affected invariants
- `compile_findings[].code = "schema_nonconformant"`
- clear message naming the exact invalid keys/paths
