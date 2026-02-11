import type {
  CompilerQuestion,
  VerificationProgram,
} from './types.js';

/**
 * Minimal compatible shape for protocol.WorkItemSpec.
 * Kept local to avoid hard package dependency from semantic-compiler core.
 */
export interface WorkItemSpec {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: {
    maxToolCalls?: number;
    maxLlmCalls?: number;
    maxDurationMs?: number;
  };
  semantic?: unknown;
}

export interface UserReviewPrompt {
  question: string;
  options: Array<{ label: string; description: string }>;
  context: string;
  multiSelect: boolean;
}

function formatVerificationObjective(invariant: VerificationProgram['invariants'][number]): string {
  const stepList = invariant.verification_plan.steps
    .map((step, index) => `${index + 1}. [${step.kind}] ${step.spec}`)
    .join('\n');

  return [
    `Verify invariant ${invariant.inv_id}.`,
    `Intent: ${invariant.refined.intent}`,
    'Operational definition:',
    ...invariant.refined.operational_definition.map((line) => `- ${line}`),
    'Verification steps:',
    stepList,
    `Verdict rule: ${invariant.verdict_rule}`,
  ].join('\n');
}

export function vpToWorkItemSpecs(
  vp: VerificationProgram,
  options: { includeReviewGate?: boolean; goal?: string } = {}
): WorkItemSpec[] {
  const includeReviewGate = options.includeReviewGate !== false;
  const goal = options.goal ?? `Verify compiled invariants for ${vp.uow_id}`;
  const specs: WorkItemSpec[] = [];

  const hasQuestions = vp.invariants.some((inv) => (inv.questions?.length ?? 0) > 0);
  const reviewGateId = 'review_gate';

  if (includeReviewGate && hasQuestions) {
    specs.push({
      id: reviewGateId,
      goal,
      objective: 'Review and resolve semantic compiler clarification questions before execution.',
      agent: 'watcher',
      domain: 'verification',
    });
  }

  const verifyIds: string[] = [];
  for (const invariant of vp.invariants) {
    if (invariant.compile_status === 'failed') continue;

    const id = `verify_${invariant.inv_id.toLowerCase()}`;
    verifyIds.push(id);

    const dependencies: string[] = [];
    if (includeReviewGate && hasQuestions) dependencies.push(reviewGateId);

    specs.push({
      id,
      goal,
      objective: formatVerificationObjective(invariant),
      agent: 'test-runner',
      domain: 'verification',
      dependencies,
    });
  }

  if (verifyIds.length > 0) {
    specs.push({
      id: 'emit_verdict',
      goal,
      objective: 'Emit invariant_results.json and 99_summary.md using collected evidence.',
      agent: 'coder',
      domain: 'verification',
      dependencies: verifyIds,
    });
  }

  return specs;
}

function questionOptions(question: CompilerQuestion): Array<{ label: string; description: string }> {
  if (question.options && question.options.length > 0) {
    return question.options.map((option, index) => ({
      label: option,
      description: index === 0 ? `${option} (Recommended)` : option,
    }));
  }

  return [
    { label: 'Use default operationalization', description: 'Accept compiler default assumptions and continue. (Recommended)' },
    { label: 'Escalate for clarification', description: 'Pause and require explicit user answer before compile completion.' },
  ];
}

export function buildUserReviewPrompts(vp: VerificationProgram): UserReviewPrompt[] {
  const prompts: UserReviewPrompt[] = [];

  for (const invariant of vp.invariants) {
    for (const question of invariant.questions ?? []) {
      prompts.push({
        question: question.question,
        options: questionOptions(question),
        context: `Invariant ${question.invariant_id}: ${invariant.original_text}\nWhy asked: ${question.rationale}`,
        multiSelect: false,
      });
    }
  }

  return prompts;
}
