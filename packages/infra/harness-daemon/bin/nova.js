#!/usr/bin/env bun
import { runHarnessDaemon } from '../src/harness/daemon.js';
import { runHarnessRunCli } from '../src/cli/run.js';

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === 'run') {
    await runHarnessRunCli(args);
    return;
  }

  await runHarnessDaemon();
}

main().catch((error) => {
  console.error('[nova] Fatal error:', error);
  process.exit(1);
});
