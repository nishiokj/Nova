#!/usr/bin/env bun
/**
 * Harness daemon entrypoint.
 */

import { profiler } from 'shared';
import { runHarnessDaemon } from './harness/daemon.js';

// Initialize profiler for daemon (enabled via PROFILE=1 env var)
profiler.init('harness-daemon', './profile-daemon.json');

runHarnessDaemon().catch((error) => {
  console.error('[harness-daemon] fatal error:', error);
  process.exit(1);
});
