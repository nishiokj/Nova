import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionerEnvironment } from '@executioner/sdk';

const executionerBin =
  process.env.EXECUTIONER_BIN ??
  '/Users/jevinnishioka/Desktop/executioner/target/release/executioner';

const workspace = process.cwd();
const smokeDir = join(workspace, '.tmp');
await mkdir(smokeDir, { recursive: true });
const smokePath = `.tmp/executioner-agent-import-smoke-${randomUUID()}.txt`;

const env = await ExecutionerEnvironment.create({
  binaryPath: executionerBin,
  workspace: { kind: 'existing', root: workspace },
  worker: { kind: 'managed', id: 'agent-import-smoke-worker', idleSleepMs: 1 },
});

try {
  const write = await env.submit({
    toolName: 'Write',
    arguments: {
      path: smokePath,
      content: 'hello from agent via executioner',
    },
  });

  const read = await env.submit({
    toolName: 'Read',
    arguments: {
      path: smokePath,
    },
  });

  const edit = await env.edit({
    path: smokePath,
    oldString: 'hello from agent via executioner',
    newString: 'hello from agent via executioner edit',
  });

  const editedRead = await env.submit({
    toolName: 'Read',
    arguments: {
      path: smokePath,
    },
  });

  console.log(JSON.stringify({
    imported: true,
    writeStatus: write.status,
    readOutput: read.output,
    editStatus: edit.status,
    editedReadOutput: editedRead.output,
  }, null, 2));
} finally {
  await env.close();
  await rm(join(workspace, smokePath), { force: true });
  await rmdir(smokeDir).catch(() => undefined);
}
