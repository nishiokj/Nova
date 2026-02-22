#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-rex-harness:swebench-lite}"
BASE_IMAGE="${BASE_IMAGE:-oven/bun:1.2.22-slim}"
PULL=0
NO_CACHE=0

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/build_agent_image.sh [options]

Build the AgentLab runtime image from an inline Dockerfile.
The image includes built dist artifacts and installs `rex` in PATH.

Options:
  --tag <image:tag>      Docker image tag (default: rex-harness:swebench-lite)
  --base-image <image>   Base image (default: oven/bun:1.2.22-slim)
  --pull                 Pull newer base layers
  --no-cache             Disable build cache
  -h, --help             Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --base-image)
      BASE_IMAGE="$2"
      shift 2
      ;;
    --pull)
      PULL=1
      shift
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found in PATH" >&2
  exit 1
fi

TMP_DOCKERFILE="$(mktemp -t agentlab-image-XXXXXX.Dockerfile)"
cleanup() {
  rm -f "$TMP_DOCKERFILE"
}
trap cleanup EXIT

cat > "$TMP_DOCKERFILE" <<DOCKERFILE
FROM ${BASE_IMAGE}

WORKDIR /opt/rex

RUN apt-get update \\
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY harness_manifest.json ./
COPY config ./config
COPY scripts ./scripts
COPY packages ./packages

RUN bun install --frozen-lockfile
RUN bun run build:packages && bun run build:apps
RUN test -f /opt/rex/packages/apps/launcher/dist/index.js
RUN printf '#!/usr/bin/env sh\nexec bun /opt/rex/packages/apps/launcher/dist/index.js "\$@"\n' > /usr/local/bin/rex \
  && chmod +x /usr/local/bin/rex

ENV NODE_ENV=production
DOCKERFILE

BUILD_ARGS=(
  -f "$TMP_DOCKERFILE"
  -t "$IMAGE_TAG"
)
if [[ "$PULL" -eq 1 ]]; then
  BUILD_ARGS+=(--pull)
fi
if [[ "$NO_CACHE" -eq 1 ]]; then
  BUILD_ARGS+=(--no-cache)
fi

cd "$ROOT_DIR"
echo "building image: $IMAGE_TAG"
docker build "${BUILD_ARGS[@]}" .

echo "built image: $IMAGE_TAG"
docker image inspect "$IMAGE_TAG" --format '{{.Id}}'
echo "runtime command example: rex run --provider z.ai-coder --model glm-5 /in/task.json /out/result.json"
