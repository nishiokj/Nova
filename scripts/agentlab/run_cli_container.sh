#!/usr/bin/env bash
set -euo pipefail

# Runner executes this from /workspace. The actual harness runtime is baked
# into the image at /opt/rex so trial workspaces don't need node_modules.
if [[ ! -f /opt/rex/scripts/agentlab/run_cli.ts ]]; then
  echo "container runtime missing /opt/rex/scripts/agentlab/run_cli.ts" >&2
  exit 2
fi

export NODE_PATH="/opt/rex/node_modules${NODE_PATH:+:$NODE_PATH}"

# In docker mode, runner provides AGENTLAB_TRIAL_INPUT/OUTPUT paths.
# Use the input file explicitly so we do not depend on docker stdin wiring.
if [[ -n "${AGENTLAB_TRIAL_INPUT:-}" && -f "${AGENTLAB_TRIAL_INPUT}" ]]; then
  exec bun /opt/rex/scripts/agentlab/run_cli.ts < "${AGENTLAB_TRIAL_INPUT}"
fi

exec bun /opt/rex/scripts/agentlab/run_cli.ts
