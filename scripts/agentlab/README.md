# AgentLab Scripts (Rex Harness)

These scripts run AgentLab experiments against the real `/jesus` harness.

## 1) Build curated SWE-bench Lite inputs

```bash
node scripts/agentlab/build_curated_swebench_lite.mjs --count 50 --max-per-repo 6
```

Outputs:

- `bench/agentlab/swebench_lite_curated.jsonl`
- `bench/agentlab/swebench_lite_curated_ids.txt`
- `bench/agentlab/swebench_lite_curated.meta.json`

## 2) Generate experiment config with SDK

```bash
node scripts/agentlab/run_swebench_lite_experiment_sdk.mjs --write-only
```

Writes:

- `.lab/experiments/swebench_lite_curated.yaml`

Harness command is the real harness adapter:

- `bun ./scripts/agentlab/run_cli.ts`
- Integration levels supported by this adapter: `cli_basic`, `cli_events`

## 3) Describe / run (non-dev mode, container)

```bash
node scripts/agentlab/run_swebench_lite_experiment_sdk.mjs --describe-only --runner-bin ./lab
node scripts/agentlab/run_swebench_lite_experiment_sdk.mjs --runner-bin ./lab --executor local_docker --materialize full
```

Defaults:

- Container image: `oven/bun:1.2.22`
- Network mode: `allowlist_enforced`
- Allowed hosts: `api.openai.com`
- Executor: `local_docker`
- Materialization: `full`

Override examples:

```bash
AGENTLAB_SANDBOX_IMAGE='oven/bun:1.2.22' \
AGENTLAB_NETWORK_MODE='allowlist_enforced' \
AGENTLAB_ALLOWED_HOSTS='api.openai.com' \
AGENTLAB_REPLICATIONS='1' \
AGENTLAB_INTEGRATION_LEVEL='cli_events' \
AGENTLAB_EXECUTOR='local_docker' \
AGENTLAB_MATERIALIZE='outputs_only' \
node scripts/agentlab/run_swebench_lite_experiment_sdk.mjs --runner-bin ./lab
```

Remote executor scaffolding (runner-side) can be targeted with:

```bash
node scripts/agentlab/run_swebench_lite_experiment_sdk.mjs \
  --runner-bin ./lab \
  --executor remote \
  --remote-endpoint http://localhost:8080 \
  --remote-token-env AGENTLAB_REMOTE_TOKEN
```
