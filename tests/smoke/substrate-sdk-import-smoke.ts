import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Environment } from '@substrate/sdk';

const substrateBin =
  process.env.SUBSTRATE_BIN ??
  '/Users/jevinnishioka/Desktop/substrate/target/release/executioner';

const workspace = process.cwd();
const smokeDir = join(workspace, '.tmp');
await mkdir(smokeDir, { recursive: true });
const smokePath = `.tmp/substrate-agent-import-smoke-${randomUUID()}.txt`;

const env = await Environment.create({
  binaryPath: substrateBin,
  workspace: { kind: 'existing', root: workspace },
  worker: { kind: 'managed', id: 'nova-substrate-import-smoke-worker', idleSleepMs: 1 },
});
const session = await env.createSession();

try {
  const write = await session.submit({
    toolName: 'Write',
    arguments: {
      path: smokePath,
      content: 'hello from nova via substrate',
    },
  });

  const read = await session.submit({
    toolName: 'Read',
    arguments: {
      path: smokePath,
    },
  });

  const edit = await session.edit({
    path: smokePath,
    oldString: 'hello from nova via substrate',
    newString: 'hello from nova via substrate edit',
  });

  const editedRead = await session.submit({
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
