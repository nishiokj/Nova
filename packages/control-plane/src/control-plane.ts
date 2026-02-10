#!/usr/bin/env bun
/**
 * Control plane server entrypoint.
 */

import { profiler } from 'shared';
import { runControlPlaneServer } from './harness/control_plane_server.js';

profiler.init('control-plane', './profile-control-plane.json');

runControlPlaneServer().catch((error) => {
  console.error('[control-plane] fatal error:', error);
  process.exit(1);
});
