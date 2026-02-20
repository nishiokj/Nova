#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKERFILE="${DOCKERFILE:-Dockerfile.rex-harness}"
IMAGE_TAG="${IMAGE_TAG:-rex-harness:swebench-lite}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dockerfile)
      DOCKERFILE="$2"
      shift 2
      ;;
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"
echo "building ${IMAGE_TAG} from ${DOCKERFILE}"
docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" .
echo "built ${IMAGE_TAG}"
