#!/usr/bin/env bash
# Per-trial workspace setup and agent run for bench v0.
#
# Invoked by lab-cli as the agent command inside the bench-v0 container.
# Expects: AGENTLAB_TASK_PATH, WORKSPACE (set by lab-cli),
#           BENCH_ROOT (baked into image env).
set -euo pipefail

BENCH_ROOT="${BENCH_ROOT:-/opt/bench}"
WORKSPACE="${WORKSPACE:-/workspace}"
TASK_PATH="${AGENTLAB_TASK_PATH:?AGENTLAB_TASK_PATH not set}"

# ── 1. Extract task_dir from the task payload ────────────────────────────────
task_dir="$(python3 -c "
import json, sys
p = json.load(open('$TASK_PATH'))
t = p.get('task', p)
d = t.get('task_dir') or (t.get('bench', {}) or {}).get('task_dir') or ''
if not d:
    tid = t.get('id', '')
    suite = (t.get('bench', {}) or {}).get('suite', 'v0')
    d = 'tasks/' + suite + '/' + tid
print(d)
")"

if [[ -z "$task_dir" ]]; then
  echo "error: could not resolve task_dir from $TASK_PATH" >&2
  exit 1
fi

# Resolve to absolute path under BENCH_ROOT if relative.
if [[ "$task_dir" != /* ]]; then
  task_dir="$BENCH_ROOT/$task_dir"
fi

echo "bench-v0: task_dir=$task_dir workspace=$WORKSPACE"

# ── 2. Copy pre-unpacked snapshot to workspace ───────────────────────────────
cp -a /workspace-base/. "$WORKSPACE/"

# ── 3. Apply injection patch ─────────────────────────────────────────────────
injection_patch="$task_dir/injection.patch"
if [[ -f "$injection_patch" ]]; then
  echo "applying injection patch..."
  git -C "$WORKSPACE" apply --whitespace=nowarn "$injection_patch"
else
  echo "no injection patch at $injection_patch (skipping)"
fi

# ── 4. Stage public artifacts and issue ──────────────────────────────────────
public_dir="$task_dir/public"
if [[ -d "$public_dir" ]]; then
  mkdir -p "$WORKSPACE/.bench_public"
  cp -a "$public_dir/." "$WORKSPACE/.bench_public/"
fi

issue_file="$task_dir/issue.md"
if [[ -f "$issue_file" ]]; then
  cp "$issue_file" "$WORKSPACE/ISSUE.md"
fi

# ── 5. Run the agent (nova) ─────────────────────────────────────────────────
# Do NOT exec — we need control back for the diff capture in step 6.
NOVA_EXIT=0
/opt/agent/bin/nova "$@" || NOVA_EXIT=$?

# ── 6. Capture workspace diff ───────────────────────────────────────────────
# The grader reads $WORKSPACE/patch.diff to score the agent's changes.
git -C "$WORKSPACE" add -A
git -C "$WORKSPACE" diff --cached --binary --no-color HEAD -- . > "$WORKSPACE/patch.diff" || true

echo "bench-v0: patch.diff written ($(wc -c < "$WORKSPACE/patch.diff") bytes), nova exit=$NOVA_EXIT"

exit "$NOVA_EXIT"
