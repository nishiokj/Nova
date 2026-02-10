import type {
  CompileFinding,
  CompileRequest,
  CompileStatus,
  CompilerQuestion,
  CompiledInvariant,
  VerificationProgram,
} from './types.js';
import {
  DEFAULT_STRATEGY_PLUGINS,
  selectBestStrategy,
  type VerificationStrategyPlugin,
} from './plugins.js';

const UNVERIFIABLE_TERMS = ['fast', 'seamless', 'robust', 'intuitive', 'easy'];

function makeInvariantId(index: number): string {
  return `INV-${String(index + 1).padStart(3, '0')}`;
}

function makeFindingId(index: number): string {
  return `FND-${String(index + 1).padStart(3, '0')}`;
}

function pushFinding(
  findings: CompileFinding[],
  finding: Omit<CompileFinding, 'finding_id'>
): void {
  findings.push({
    finding_id: makeFindingId(findings.length),
    ...finding,
  });
}

function detectGlobalContradictions(request: CompileRequest): CompileFinding[] {
  const findings: CompileFinding[] = [];
  const normalized = request.invariants.map((inv) => inv.text.toLowerCase()).join('\n');

  if (normalized.includes('no interface changes') && normalized.includes('new required param')) {
    pushFinding(findings, {
      severity: 'error',
      code: 'contradiction',
      message: 'Invariant set contains contradiction: "no interface changes" conflicts with "new required param".',
    });
  }

  return findings;
}

function detectSystemSurfaceFindings(request: CompileRequest): CompileFinding[] {
  const findings: CompileFinding[] = [];

  if (request.system_surface.services.length === 0) {
    pushFinding(findings, {
      severity: 'error',
      code: 'missing_system_surface',
      message: 'System surface must define at least one service/module in system_surface.services.',
    });
  }

  if (request.system_surface.main_flows.length === 0) {
    pushFinding(findings, {
      severity: 'error',
      code: 'missing_system_surface',
      message: 'System surface must define at least one end-to-end flow in system_surface.main_flows.',
    });
  }

  return findings;
}

function detectInvariantFindings(invId: string, text: string): CompileFinding[] {
  const findings: CompileFinding[] = [];
  const normalized = text.toLowerCase();

  for (const term of UNVERIFIABLE_TERMS) {
    if (normalized.includes(term)) {
      pushFinding(findings, {
        severity: 'warning',
        code: 'unverifiable_term',
        invariant_id: invId,
        message: `Invariant ${invId} uses unverifiable term "${term}"; operationalization is required.`,
      });
    }
  }

  return findings;
}

function dedupeQuestions(questions: CompilerQuestion[]): CompilerQuestion[] {
  const seen = new Set<string>();
  const result: CompilerQuestion[] = [];
  for (const question of questions) {
    const key = `${question.invariant_id}::${question.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(question);
  }
  return result;
}

function targetedQuestions(invId: string, text: string): CompilerQuestion[] {
  const normalized = text.toLowerCase();
  const questions: CompilerQuestion[] = [];
  const base = `Q-${invId}-`;
  let seq = 1;

  if ((normalized.includes('3 click') || normalized.includes('three click')) && !normalized.includes('happy path')) {
    questions.push({
      question_id: `${base}${String(seq++).padStart(2, '0')}`,
      invariant_id: invId,
      question: 'Is the click-count requirement for the happy path only, or all paths including retries/errors?',
      rationale: 'Click-count constraints are ambiguous without path scope.',
      options: ['happy path only', 'all paths', 'happy + recoverable error paths'],
    });
  }

  if (normalized.includes('restart')) {
    questions.push({
      question_id: `${base}${String(seq++).padStart(2, '0')}`,
      invariant_id: invId,
      question: 'Does "restart" mean app process restart, container restart, or full machine reboot?',
      rationale: 'Restart semantics change harness strategy and evidence requirements.',
      options: ['app process restart', 'container restart', 'machine reboot'],
    });
  }

  if (normalized.includes('signed in') || normalized.includes('logged in') || normalized.includes('authenticated')) {
    questions.push({
      question_id: `${base}${String(seq++).padStart(2, '0')}`,
      invariant_id: invId,
      question: 'What is the authoritative definition of "signed in" for this invariant?',
      rationale: 'Authentication state must bind to observable assertions.',
      options: ['UI avatar/session indicator', 'server session valid', 'API /me returns 200'],
    });
  }

  if (UNVERIFIABLE_TERMS.some((term) => normalized.includes(term))) {
    questions.push({
      question_id: `${base}${String(seq++).padStart(2, '0')}`,
      invariant_id: invId,
      question: 'What measurable threshold should replace qualitative language (latency, error rate, retries, etc.)?',
      rationale: 'Qualitative terms are not machine-checkable.',
      options: ['p95 latency target', 'max error rate', 'completion time threshold'],
    });
  }

  return questions;
}

export interface CompileOptions {
  plugins?: VerificationStrategyPlugin[];
  now?: Date;
}

export function compileVerificationProgram(
  request: CompileRequest,
  options: CompileOptions = {}
): VerificationProgram {
  const plugins = options.plugins ?? DEFAULT_STRATEGY_PLUGINS;
  const now = options.now ?? new Date();

  const compileFindings: CompileFinding[] = [
    ...detectSystemSurfaceFindings(request),
    ...detectGlobalContradictions(request),
  ];

  const invariants: CompiledInvariant[] = request.invariants.map((invariantInput, index) => {
    const invId = invariantInput.inv_id ?? makeInvariantId(index);
    const invariantFindings = detectInvariantFindings(invId, invariantInput.text);
    compileFindings.push(...invariantFindings);

    const selection = selectBestStrategy(
      {
        invariant: invariantInput,
        system_surface: request.system_surface,
        repo_metadata: request.repo_metadata,
      },
      plugins
    );

    if (!selection.plugin || selection.support.score <= 0) {
      pushFinding(compileFindings, {
        severity: 'error',
        code: 'strategy_unavailable',
        invariant_id: invId,
        message: `No verification strategy could compile invariant ${invId}.`,
      });

      return {
        inv_id: invId,
        original_text: invariantInput.text,
        refined: {
          intent: 'Unresolved invariant',
          scope: [],
          operational_definition: [],
        },
        assumptions: [],
        verification_plan: {
          strategy_id: 'none',
          steps: [],
          evidence: [],
        },
        verdict_rule: 'unavailable',
        compile_status: 'failed' as const,
      };
    }

    const compiled = selection.plugin.compile({
      inv_id: invId,
      original_text: invariantInput.text,
      system_surface: request.system_surface,
      repo_metadata: request.repo_metadata,
    });

    const questions = dedupeQuestions([
      ...(compiled.questions ?? []),
      ...targetedQuestions(invId, invariantInput.text),
    ]);

    const hasErrorFinding = compileFindings.some(
      (finding) => finding.invariant_id === invId && finding.severity === 'error'
    );

    let status: CompileStatus = 'compiled';
    if (hasErrorFinding) status = 'failed';
    else if (questions.length > 0) status = 'needs_user_answer';

    return {
      inv_id: invId,
      original_text: invariantInput.text,
      refined: compiled.refined,
      assumptions: compiled.assumptions,
      verification_plan: compiled.verification_plan,
      verdict_rule: compiled.verdict_rule,
      compile_status: status,
      ...(questions.length > 0 ? { questions } : {}),
    };
  });

  return {
    vp_version: '0.1',
    uow_id: request.uow_id,
    generated_at: now.toISOString(),
    system_surface: request.system_surface,
    invariants,
    compile_findings: compileFindings,
  };
}
