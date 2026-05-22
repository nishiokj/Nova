#!/usr/bin/env bun

declare const __NOVA_VERSION__: string | undefined;

const VERSION = typeof __NOVA_VERSION__ === "string" ? __NOVA_VERSION__ : "dev";

function printUsage(): void {
  console.log(`Usage: nova run [options]\n\nCommands:\n  run                 Execute a headless harness run\n\nOptions:\n  -h, --help          Show this help\n  -v, --version       Print version\n\nExamples:\n  nova run --input-file /agentlab/in/task.json --output /agentlab/out/result.json\n  nova run --help`);
}

async function runCli(args: string[]): Promise<void> {
  const { runHarnessRunCli } = await import("../src/cli/run.js");
  await runHarnessRunCli(args);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h") {
    printUsage();
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(`nova ${VERSION}`);
    return;
  }
  if (first === "run") {
    await runCli(args.slice(1));
    return;
  }
  if (first.startsWith("-")) {
    await runCli(args);
    return;
  }

  console.error(`Unknown subcommand: ${first}`);
  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error("[nova] Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
