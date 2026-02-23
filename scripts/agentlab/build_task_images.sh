#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${AGENTLAB_SWEBENCH_VENV:-$ROOT_DIR/.venv_swebench}"
IDS_FILE="$ROOT_DIR/bench/agentlab/swebench_lite_curated_ids.txt"
MAX_WORKERS="${AGENTLAB_IMAGE_BUILD_WORKERS:-1}"

# swebench requires Python 3.10+ (uses X | Y type union syntax)
PYTHON_BIN="${AGENTLAB_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
  if [[ -z "$PYTHON_BIN" ]]; then
    echo "python 3.10+ required but not found. install via brew or set AGENTLAB_PYTHON." >&2
    exit 1
  fi
fi

if [[ ! -d "$VENV" ]]; then
  echo "creating swebench venv at $VENV (using $PYTHON_BIN)..."
  "$PYTHON_BIN" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet swebench docker datasets
fi

if [[ ! -f "$IDS_FILE" ]]; then
  echo "instance IDs file not found: $IDS_FILE" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon unavailable." >&2
  exit 1
fi

"$VENV/bin/python" - "$IDS_FILE" "$MAX_WORKERS" <<'PYTHON'
import sys
from pathlib import Path

ids_file = sys.argv[1]
max_workers = int(sys.argv[2])

instance_ids = [
    line.strip()
    for line in Path(ids_file).read_text().splitlines()
    if line.strip() and not line.strip().startswith("#")
]
print(f"building images for {len(instance_ids)} instances (max_workers={max_workers})")

from datasets import load_dataset
from swebench.harness.docker_build import build_env_images, build_instance_images
import docker

client = docker.from_env()
dataset = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
subset = [row for row in dataset if row["instance_id"] in set(instance_ids)]
print(f"matched {len(subset)}/{len(instance_ids)} instances in HF dataset")

if len(subset) != len(instance_ids):
    found = {row["instance_id"] for row in subset}
    missing = [i for i in instance_ids if i not in found]
    print(f"missing from HF dataset: {missing}")
    sys.exit(1)

print("building instance images...")
build_instance_images(client, subset, max_workers=max_workers, tag="latest", env_image_tag="latest")

print("done")
PYTHON
