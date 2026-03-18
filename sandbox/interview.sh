#!/usr/bin/env bash
#
# Sandboxed interview runner (macOS sandbox-exec).
#
# Usage:
#   sandbox/interview.sh --repo-root /path/to/repo --contracts-dir /path/to/contracts -- <agent-command...>
#
# The agent process runs under a seatbelt profile that:
#   - Denies all file access by default
#   - Allows read-only access to a file tree listing
#   - Allows read-write access to the contracts directory
#   - Allows system libs, network, and process operations
#
# The agent cannot read source code files — only the file tree listing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SB_TEMPLATE="${SCRIPT_DIR}/interview.sb"

REPO_ROOT=""
CONTRACTS_DIR=""
AGENT_CMD=()

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --contracts-dir)
      CONTRACTS_DIR="$2"
      shift 2
      ;;
    --)
      shift
      AGENT_CMD=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_ROOT" ]]; then
  echo "Error: --repo-root is required" >&2
  exit 1
fi

if [[ -z "$CONTRACTS_DIR" ]]; then
  CONTRACTS_DIR="${REPO_ROOT}/contracts"
fi

if [[ ${#AGENT_CMD[@]} -eq 0 ]]; then
  echo "Error: agent command required after --" >&2
  exit 1
fi

# --- Generate file tree ---
FILETREE_PATH="$(mktemp /tmp/interview-filetree.XXXXXX.txt)"
find "$REPO_ROOT" -type f \( \
  -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
  -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '*.md' \
\) | sort > "$FILETREE_PATH"

# --- Substitute template variables ---
SB_PROFILE="$(mktemp /tmp/interview.XXXXXX.sb)"
sed \
  -e "s|__CONTRACTS_DIR__|${CONTRACTS_DIR}|g" \
  -e "s|__FILETREE_PATH__|${FILETREE_PATH}|g" \
  "$SB_TEMPLATE" > "$SB_PROFILE"

# --- Ensure contracts dir exists ---
mkdir -p "$CONTRACTS_DIR"

# --- Run sandboxed ---
cleanup() {
  rm -f "$FILETREE_PATH" "$SB_PROFILE"
}
trap cleanup EXIT

sandbox-exec -f "$SB_PROFILE" "${AGENT_CMD[@]}"
