#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import {
  buildUserReviewPrompts,
  compileVerificationProgram,
  createInitialState,
  emitVerdictArtifacts,
  generateHarnessArtifacts,
  markStageCompleted,
  markStageRunning,
  markStageWaitingUser,
  prepareEvidenceLayout,
  saveState,
} from './index.js';
import type {
  CompileRequest,
  InvariantVerdict,
  VerificationProgram,
  VerdictReport,
} from './types.js';

interface ParsedArgs {
  command: string | null;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? null;
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }
    flags[key] = value;
    i += 1;
  }

  return { command, flags };
}

function usage(): string {
  return [
    'uow semantic compiler CLI',
    '',
    'Commands:',
    '  uow compile --input <compile-request.json> --out <dir> [--state <state.json>]',
    '  uow verify --vp <vp.json> --out <dir> [--run-id <id>] [--seed <number>]',
    '  uow report --vp <vp.json> --verdicts <invariant_results.json> --out <dir>',
    '',
    'Notes:',
    '  - compile writes vp.json and compile_findings.md.',
    '  - verify generates harness artifacts and evidence layout.',
    '  - report emits reports/invariant_results.json and reports/99_summary.md.',
  ].join('\n');
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function toFindingsMarkdown(vp: VerificationProgram): string {
  const lines: string[] = [];
  lines.push('# Compile Findings');
  lines.push('');

  if (vp.compile_findings.length === 0) {
    lines.push('- No findings.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  for (const finding of vp.compile_findings) {
    const target = finding.invariant_id ? ` (${finding.invariant_id})` : '';
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.code}${target}: ${finding.message}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function runCompile(flags: Record<string, string>): Promise<void> {
  const inputPath = flags.input;
  const outDir = flags.out;
  const statePath = flags.state;

  if (!inputPath || !outDir) {
    throw new Error('compile requires --input and --out');
  }

  const request = await readJson<CompileRequest>(inputPath);
  const now = new Date();
  const vp = compileVerificationProgram(request, { now });
  const prompts = buildUserReviewPrompts(vp);

  await fs.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'vp.json'), vp);
  await fs.writeFile(path.join(outDir, 'compile_findings.md'), toFindingsMarkdown(vp), 'utf8');

  if (statePath) {
    let state = createInitialState(request.uow_id, now);
    state = markStageRunning(state, 'stage1_compile_invariants', now);
    state.findings = vp.compile_findings;
    if (prompts.length > 0) {
      const questions = vp.invariants.flatMap((item) => item.questions ?? []);
      state = markStageWaitingUser(state, 'stage2_user_review_gate', questions, vp.compile_findings, now);
    } else {
      state = markStageCompleted(state, 'stage1_compile_invariants', now);
    }
    await saveState(statePath, state);
  }

  process.stdout.write(
    `compiled ${vp.invariants.length} invariants; findings=${vp.compile_findings.length}; ` +
      `needs_user_answer=${vp.invariants.filter((inv) => inv.compile_status === 'needs_user_answer').length}\n`
  );
}

async function runVerify(flags: Record<string, string>): Promise<void> {
  const vpPath = flags.vp;
  const outDir = flags.out;
  const runId = flags['run-id'] ?? `RUN-${Date.now()}`;
  const seed = Number(flags.seed ?? '42');

  if (!vpPath || !outDir) {
    throw new Error('verify requires --vp and --out');
  }
  if (!Number.isFinite(seed)) {
    throw new Error('verify --seed must be a finite number');
  }

  const vp = await readJson<VerificationProgram>(vpPath);
  const harness = await generateHarnessArtifacts(vp, { output_dir: outDir });
  const evidence = await prepareEvidenceLayout(vp, { output_dir: outDir, run_id: runId, seed });

  process.stdout.write(
    `generated harness artifacts=${harness.artifacts.length}; evidence_invariants=${evidence.invariant_directories.length}\n`
  );
}

async function runReport(flags: Record<string, string>): Promise<void> {
  const vpPath = flags.vp;
  const verdictsPath = flags.verdicts;
  const outDir = flags.out;

  if (!vpPath || !verdictsPath || !outDir) {
    throw new Error('report requires --vp, --verdicts, and --out');
  }

  const vp = await readJson<VerificationProgram>(vpPath);
  const maybeReport = await readJson<VerdictReport | InvariantVerdict[]>(verdictsPath);
  const verdicts = Array.isArray(maybeReport) ? maybeReport : maybeReport.invariant_results;
  const emitted = await emitVerdictArtifacts(vp, verdicts, { output_dir: outDir });
  process.stdout.write(`wrote ${emitted.json_path} and ${emitted.summary_path}\n`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'compile') {
    await runCompile(flags);
    return;
  }

  if (command === 'verify') {
    await runVerify(flags);
    return;
  }

  if (command === 'report') {
    await runReport(flags);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`uow error: ${message}\n`);
  process.exit(1);
});
