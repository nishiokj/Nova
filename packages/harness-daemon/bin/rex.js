#!/usr/bin/env bun
import { runHarnessDaemon } from '../src/harness/daemon.js';

runHarnessDaemon().catch((error) => {
  console.error('[rex] Fatal error:', error);
  process.exit(1);
});
