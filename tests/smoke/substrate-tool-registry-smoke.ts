import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Environment } from '@substrate/sdk';
import {
  DANGEROUS_PATTERNS,
  ToolRegistry,
  builtinToolOptions,
  executionerToolOptions,
  withExecutionerToolExecutors,
} from 'tools';

const substrateBin =
  process.env.SUBSTRATE_BIN ??
  '/Users/jevinnishioka/Desktop/substrate/target/release/executioner';

const workspace = process.cwd();
const smokeDir = join(workspace, '.tmp');
const smokeFile = `.tmp/substrate-tool-registry-smoke-${randomUUID()}.txt`;

await mkdir(smokeDir, { recursive: true });

const env = await Environment.create({
  binaryPath: substrateBin,
  workspace: { kind: 'existing', root: workspace },
  worker: { kind: 'managed', id: 'nova-substrate-tool-registry-smoke-worker', idleSleepMs: 1 },
  policy: {
    process: {
      allowExec: true,
      deniedCommands: [...DANGEROUS_PATTERNS],
    },
  },
});
const session = await env.createSession();

try {
  const registry = new ToolRegistry({}, workspace);
  for (const option of withExecutionerToolExecutors(
    executionerToolOptions(builtinToolOptions),
    session,
    workspace
  )) {
    registry.register(option);
  }

  const definitions = registry.getDefinitions().map((tool) => tool.name).sort();
  const bash = await registry.execute('Bash', { command: 'printf substrate-bash-smoke' }, { cwd: workspace });
  const write = await registry.execute('Write', { path: smokeFile, content: 'alpha\nneedle\nomega\n' }, { cwd: workspace });
  const edit = await registry.execute('Edit', { path: smokeFile, oldString: 'needle', newString: 'pin' }, { cwd: workspace });
  const read = await registry.execute('Read', { path: smokeFile }, { cwd: workspace });
  const grep = await registry.execute('Grep', { pattern: 'pin', path: '.tmp' }, { cwd: workspace });
  const glob = await registry.execute('Glob', { pattern: '.tmp/substrate-tool-registry-smoke-*.txt' }, { cwd: workspace });
  const batchEdit = await registry.execute('BatchEdit', {
    edits: [{ path: smokeFile, oldString: 'pin', newString: 'needle' }],
  }, { cwd: workspace });
  const blocked = await registry.execute('Bash', { command: 'mkfs /tmp/nope' }, { cwd: workspace });

  console.log(JSON.stringify({
    definitions,
    bash: {
      status: bash.status,
      output: bash.output,
      substrate: bash.metadata?.substrate,
      returnCode: bash.metadata?.returnCode,
    },
    read: {
      status: read.status,
      output: read.output,
      substrate: read.metadata?.substrate,
    },
    write: {
      status: write.status,
      substrate: write.metadata?.substrate,
    },
    edit: {
      status: edit.status,
      substrate: edit.metadata?.substrate,
    },
    grep: {
      status: grep.status,
      substrate: grep.metadata?.substrate,
    },
    glob: {
      status: glob.status,
      substrate: glob.metadata?.substrate,
    },
    disabledNativeTool: {
      status: batchEdit.status,
      error: batchEdit.error,
    },
    blockedBash: {
      status: blocked.status,
      error: blocked.error,
      substrate: blocked.metadata?.substrate,
    },
  }, null, 2));
} finally {
  await env.close();
  await rm(join(workspace, smokeFile), { force: true });
  await rmdir(smokeDir).catch(() => undefined);
}
