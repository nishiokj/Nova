#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import {
  compileVerificationProgram,
} from './index.js';
import type {
  CompileRequest,
  VerificationProgram,
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
    '  uow compile --input <compile-request.json> --out <dir>',
    '',
    'Notes:',
    '  - compile writes vp.json and compile_findings.md.',
    '  - Agent-driven compilation (conditions) should be invoked via skills.',
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

  if (!inputPath || !outDir) {
    throw new Error('compile requires --input and --out');
  }

  const request = await readJson<CompileRequest>(inputPath);
  const now = new Date();
  const vp = compileVerificationProgram(request, { now });

  await fs.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'vp.json'), vp);
  await fs.writeFile(path.join(outDir, 'compile_findings.md'), toFindingsMarkdown(vp), 'utf8');

  process.stdout.write(
    `compiled ${vp.invariants.length} invariants; findings=${vp.compile_findings.length}; ` +
      `needs_user_answer=${vp.invariants.filter((inv) => inv.compile_status === 'needs_user_answer').length}\n`
  );
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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`uow error: ${message}\n`);
  process.exit(1);
});
