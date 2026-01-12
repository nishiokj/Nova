#!/usr/bin/env bun
/**
 * Harness daemon entrypoint.
 */

import { runHarnessDaemon } from './harness/daemon.js';

runHarnessDaemon().catch((error) => {
  console.error('[harness-daemon] fatal error:', error);
  process.exit(1);
});
