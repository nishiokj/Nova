#!/usr/bin/env node

import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

function usage() {
  console.error('Usage: node scripts/agentlab/enrich_dataset_v2.mjs <input_v1.jsonl> <output_v2.jsonl> [--workspace /testbed] [--force]');
}

function parseArgs(argv) {
  if (argv.length < 2) {
    usage();
    process.exit(1);
  }

  const input = argv[0];
  const output = argv[1];
  let workspace = '/testbed';
  let force = false;

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--workspace') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('missing value for --workspace');
      }
      workspace = value;
      index += 1;
      continue;
    }
    if (token === '--force') {
      force = true;
      continue;
    }
    throw new Error(`unknown arg: ${token}`);
  }

  return {
    input: resolve(process.cwd(), input),
    output: resolve(process.cwd(), output),
    workspace,
    force,
  };
}

function deriveTaskImage(task) {
  const instanceId = task?.swebench?.input?.instance_id;
  if (typeof instanceId !== 'string' || instanceId.trim().length === 0) {
    return null;
  }
  return `swebench/sweb.eval.x86_64.${instanceId.trim()}:latest`;
}

async function main() {
  const { input, output, workspace, force } = parseArgs(process.argv.slice(2));

  if (!existsSync(input)) {
    throw new Error(`input dataset not found: ${input}`);
  }

  if (existsSync(output) && !force) {
    console.log(`dataset exists, skipping (pass --force to rebuild): ${output}`);
    return;
  }

  mkdirSync(dirname(output), { recursive: true });

  const reader = createInterface({
    input: createReadStream(input, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const writer = createWriteStream(output, { encoding: 'utf8' });

  let total = 0;
  let enriched = 0;

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    total += 1;
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`line ${total}: expected JSON object`);
    }
    if (!row.task || typeof row.task !== 'object' || Array.isArray(row.task)) {
      throw new Error(`line ${total}: missing object field 'task'`);
    }

    const taskImage = deriveTaskImage(row.task);
    if (!taskImage) {
      throw new Error(`line ${total}: missing task.swebench.input.instance_id`);
    }

    row.schema_version = 'task_boundary_v2';
    row.task.image = taskImage;
    row.task.workspace = workspace;

    writer.write(`${JSON.stringify(row)}\n`);
    enriched += 1;
  }

  await new Promise((resolveDone, rejectDone) => {
    writer.end((error) => {
      if (error) {
        rejectDone(error);
      } else {
        resolveDone();
      }
    });
  });

  console.log(`wrote ${enriched}/${total} task rows: ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
