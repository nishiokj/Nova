import { spawn } from "bun";
import { resolve } from "path";

const appsDir = import.meta.dirname!;

const apps = [
  
  { name: "tui", cwd: resolve(appsDir, "tui"), cmd: ["bun", "run", "start"] },
];

const procs: ReturnType<typeof spawn>[] = [];

async function startAll() {
  for (const app of apps) {
    console.log(`Starting ${app.name}...`);
    const proc = spawn({
      cmd: app.cmd,
      cwd: app.cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    procs.push(proc);
    await Bun.sleep(500);
  }
  console.log("All apps started.");
}

function cleanup() {
  console.log("\nShutting down...");
  for (const proc of procs) {
    proc.kill();
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await startAll();
await Promise.all(procs.map((p) => p.exited));
