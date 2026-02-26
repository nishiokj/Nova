#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_PATH="${1:-${AGENTLAB_AGENT_ARTIFACT:-$ROOT_DIR/.lab/agents/nova-current.tar.gz}}"
BUILD_BEFORE_FREEZE="${AGENTLAB_FREEZE_BUILD:-1}"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/freeze_agent.sh [output_tar_gz]

Creates a portable runtime artifact tarball for per-task image execution.

Environment overrides:
  AGENTLAB_AGENT_ARTIFACT  Output path when positional arg is omitted.
  AGENTLAB_FREEZE_BUILD    1 (default) runs bun build before freezing; 0 skips.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but not found in PATH" >&2
  exit 1
fi

if [[ "$BUILD_BEFORE_FREEZE" == "1" ]]; then
  (
    cd "$ROOT_DIR"
    bun run build >/dev/null
  )
fi

LAUNCHER_DIST="$ROOT_DIR/packages/apps/launcher/dist/index.js"
if [[ ! -f "$LAUNCHER_DIST" ]]; then
  echo "missing launcher dist artifact: $LAUNCHER_DIST" >&2
  echo "run 'bun run build' first, or keep AGENTLAB_FREEZE_BUILD=1" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "missing node_modules at $ROOT_DIR/node_modules" >&2
  echo "run 'bun install' first" >&2
  exit 1
fi

OUT_ABS="$OUT_PATH"
if [[ "$OUT_ABS" != /* ]]; then
  OUT_ABS="$ROOT_DIR/$OUT_ABS"
fi

STAGE_DIR="$(mktemp -d -t agentlab-freeze-XXXXXX)"
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/packages" "$STAGE_DIR/config" "$STAGE_DIR/scripts"

BUN_BIN="$(command -v bun)"
cp "$BUN_BIN" "$STAGE_DIR/bin/bun"
cp "$ROOT_DIR/package.json" "$STAGE_DIR/package.json"
cp "$ROOT_DIR/bun.lock" "$STAGE_DIR/bun.lock"
cp -R "$ROOT_DIR/node_modules" "$STAGE_DIR/node_modules"
cp -R "$ROOT_DIR/packages" "$STAGE_DIR/packages"
cp -R "$ROOT_DIR/config" "$STAGE_DIR/config"
cp -R "$ROOT_DIR/scripts" "$STAGE_DIR/scripts"

cat >"$STAGE_DIR/bin/nova" <<'ENTRY'
#!/usr/bin/env sh
exec /opt/agent/bin/bun /opt/agent/packages/apps/launcher/dist/index.js "$@"
ENTRY
chmod +x "$STAGE_DIR/bin/nova"

SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
FROZEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$STAGE_DIR/manifest.json" <<JSON
{
  "schema_version": "agent_artifact_v1",
  "id": "nova",
  "platform": "linux-x64",
  "entrypoint": "bin/nova",
  "frozen_at": "$FROZEN_AT",
  "source_commit": "$SOURCE_COMMIT"
}
JSON

mkdir -p "$(dirname "$OUT_ABS")"
tar czf "$OUT_ABS" -C "$STAGE_DIR" .

SIZE_HUMAN="$(du -h "$OUT_ABS" | awk '{print $1}')"
echo "wrote agent artifact: $OUT_ABS ($SIZE_HUMAN)"
