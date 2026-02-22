#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="${AGENTLAB_WORKSPACE_ROOT:-/agentlab/workspace}"
TASK_JSON="${AGENTLAB_SWEBENCH_TASK_JSON:-$WORKSPACE_ROOT/task/swebench_task.json}"
REPO_DIR="${AGENTLAB_SWEBENCH_REPO_DIR:-$WORKSPACE_ROOT/repo}"

if [[ ! -f "$TASK_JSON" ]]; then
  echo "missing SWE-bench task metadata: $TASK_JSON" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "missing required command in runtime image: git" >&2
  echo "rebuild image with: bash scripts/agentlab/build_agent_image.sh --tag rex-harness:swebench-lite" >&2
  exit 1
fi

eval "$(
  python3 - "$TASK_JSON" <<'PY'
import json
import shlex
import sys
from pathlib import Path

task_json = Path(sys.argv[1])
payload = json.loads(task_json.read_text(encoding="utf-8"))
repo = (payload.get("repo") or "").strip()
base_commit = (payload.get("base_commit") or "").strip()

if not repo or not base_commit:
    raise SystemExit("swebench_task.json is missing repo/base_commit")

print(f"SWEBENCH_REPO={shlex.quote(repo)}")
print(f"SWEBENCH_BASE_COMMIT={shlex.quote(base_commit)}")
PY
)"

REPO_URL="https://github.com/${SWEBENCH_REPO}.git"

if [[ -d "$REPO_DIR/.git" ]]; then
  EXISTING_REMOTE="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$EXISTING_REMOTE" != "$REPO_URL" ]]; then
    rm -rf "$REPO_DIR"
  fi
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  mkdir -p "$REPO_DIR"
  git init "$REPO_DIR"
  git -C "$REPO_DIR" remote add origin "$REPO_URL"
fi

if ! git -C "$REPO_DIR" fetch --depth 1 origin "$SWEBENCH_BASE_COMMIT"; then
  git -C "$REPO_DIR" fetch origin "$SWEBENCH_BASE_COMMIT"
fi

git -C "$REPO_DIR" checkout --detach --force FETCH_HEAD
git -C "$REPO_DIR" clean -ffdx
git -C "$REPO_DIR" reset --hard --quiet

cat >"$WORKSPACE_ROOT/task/swebench_workspace_setup.json" <<EOF
{
  "repo": "$SWEBENCH_REPO",
  "base_commit": "$SWEBENCH_BASE_COMMIT",
  "repo_dir": "$REPO_DIR"
}
EOF

echo "swebench workspace ready: repo=$SWEBENCH_REPO commit=$SWEBENCH_BASE_COMMIT dir=$REPO_DIR"
