#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = {
    input: 'bench/agentlab/swebench_lite_smoke_1.jsonl',
    output: '.lab/experiments/data/swebench_lite_smoke_1.task_boundary_v1.jsonl',
    limit: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' && next) {
      args.input = next;
      i += 1;
      continue;
    }
    if (arg === '--output' && next) {
      args.output = next;
      i += 1;
      continue;
    }
    if (arg === '--limit' && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit must be a positive integer (got: ${next})`);
      }
      args.limit = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown or malformed arg: ${arg}`);
  }
  return args;
}

function coalescePrompt(row) {
  return (
    row?.problem_statement ??
    row?.prompt ??
    row?.instruction ??
    row?.question ??
    row?.input?.prompt ??
    JSON.stringify(row)
  );
}

function toBoundaryRow(row, idx) {
  const prompt = coalescePrompt(row);
  const taskId = row?.task_id ?? row?.input?.instance_id ?? `task_${idx}`;
  const sourceRepo = row?.input?.repo ?? row?.repo ?? null;
  const baseCommit = row?.input?.base_commit ?? row?.base_commit ?? null;
  const taskContext = {
    task_id: taskId,
    source: row?.source ?? null,
    repo: sourceRepo,
    base_commit: baseCommit,
    instance_id: row?.input?.instance_id ?? row?.instance_id ?? null,
    metadata: row?.metadata ?? null,
  };
  return {
    schema_version: 'task_boundary_v1',
    task: {
      id: taskId,
      input: {
        prompt,
      },
      prompt,
      swebench: row,
    },
    workspace_files: [
      {
        path: 'task/prompt.txt',
        content: prompt,
        encoding: 'utf8',
      },
      {
        path: 'task/swebench_task.json',
        content: JSON.stringify(taskContext, null, 2),
        encoding: 'utf8',
      },
    ],
    mount_references: [],
    limits: {},
  };
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const raw = readFileSync(inputPath, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = args.limit ? lines.slice(0, args.limit) : lines;
  const mapped = selected.map((line, idx) => {
    const row = JSON.parse(line);
    return JSON.stringify(toBoundaryRow(row, idx));
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${mapped.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${mapped.length} task boundary rows to ${outputPath}`);
}

main();
