import fs from 'fs/promises';
import path from 'path';
import type {
  InvariantVerdict,
  VerificationProgram,
  VerdictReport,
} from './types.js';

export interface EmitVerdictOptions {
  output_dir: string;
}

export interface EmitVerdictResult {
  json_path: string;
  summary_path: string;
}

function renderSummary(vp: VerificationProgram, verdicts: InvariantVerdict[]): string {
  const lines: string[] = [];
  lines.push('# Verification Summary');
  lines.push('');
  lines.push(`- UoW: ${vp.uow_id}`);
  lines.push(`- VP version: ${vp.vp_version}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');

  for (const verdict of verdicts) {
    const invariant = vp.invariants.find((item) => item.inv_id === verdict.inv_id);
    lines.push(`## ${verdict.inv_id} — ${verdict.verdict.toUpperCase()}`);
    if (invariant) {
      lines.push(`- Original: ${invariant.original_text}`);
      lines.push(`- Intent: ${invariant.refined.intent}`);
    }
    lines.push(`- Evidence: ${verdict.evidence_path}`);
    if (verdict.assumptions_used && verdict.assumptions_used.length > 0) {
      lines.push(`- Assumptions: ${verdict.assumptions_used.join('; ')}`);
    }
    if (verdict.counterexample) {
      lines.push(`- Counterexample: ${verdict.counterexample}`);
    }
    if (verdict.notes) {
      lines.push(`- Notes: ${verdict.notes}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function emitVerdictArtifacts(
  vp: VerificationProgram,
  verdicts: InvariantVerdict[],
  options: EmitVerdictOptions
): Promise<EmitVerdictResult> {
  const report: VerdictReport = {
    uow_id: vp.uow_id,
    generated_at: new Date().toISOString(),
    invariant_results: verdicts,
  };

  const reportDir = path.join(options.output_dir, 'reports');
  await fs.mkdir(reportDir, { recursive: true });

  const jsonPath = path.join(reportDir, 'invariant_results.json');
  const summaryPath = path.join(reportDir, '99_summary.md');

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(summaryPath, renderSummary(vp, verdicts), 'utf8');

  return {
    json_path: jsonPath,
    summary_path: summaryPath,
  };
}
