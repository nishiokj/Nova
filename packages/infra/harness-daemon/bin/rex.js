#!/usr/bin/env bun
import { runHarnessDaemon } from '../src/harness/daemon.js';
import { runHarnessTrialCli } from '../src/harness/trial_cli.js';

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === 'run-trial') {
    await runHarnessTrialCli(args);
    return;
  }

  await runHarnessDaemon();
}

main().catch((error) => {
  console.error('[rex] Fatal error:', error);
  process.exit(1);
});
