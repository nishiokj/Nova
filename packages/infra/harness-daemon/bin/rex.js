#!/usr/bin/env bun
import { runHarnessDaemon } from '../src/harness/daemon.js';
import { runHarnessTrialCli } from '../src/cli/run_trial.js';
import { runHarnessAgentLoopCli } from '../src/cli/run_agent_loop.js';

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === 'run-trial') {
    await runHarnessTrialCli(args);
    return;
  }
  if (subcommand === 'run-agent-loop') {
    await runHarnessAgentLoopCli();
    return;
  }

  await runHarnessDaemon();
}

main().catch((error) => {
  console.error('[rex] Fatal error:', error);
  process.exit(1);
});
