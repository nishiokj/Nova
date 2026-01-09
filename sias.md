# SIAS Launcher

## Running the Launcher

```bash
bash sias-launcher.sh [kernel_path]
```

**Default kernel path:** `./sias-kernel`

**Example:**
```bash
# Run with default kernel
bash sias-launcher.sh

# Run with custom kernel path
bash sias-launcher.sh ./worktrees/v002
```

The launcher spawns the kernel process and monitors it for crashes and upgrade signals.

## Logs

**Default location:** `./logs/sias-kernel.log`

**Configuration via `config/sias_kernel.json`:**
```json
{
  "log": {
    "backend": "file",
    "format": "pretty",
    "level": "info",
    "path": "logs/sias-kernel.log",
    "maxSizeBytes": 52428800
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GRAPHD_URL` | GraphD database URL | `http://127.0.0.1:9444` |
| `SIAS_UPGRADE_SIGNAL_FILE` | Upgrade signal file path | `/tmp/sias-upgrade-signal` |
| `SIAS_CONFIG_PATH` | Path to kernel config JSON | `config/sias_kernel.json` |
| `SIAS_GRAPHD_DB_PATH` | Override GraphD database path | `.graphd/graphd.db` |
| `SIAS_WORKTREE_BASE_DIR` | Working tree base directory | `worktrees` |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |

## Launcher Behavior

- **Failure tracking:** After 3 consecutive failures, rolls back to last known good kernel path
- **Startup validation:** Kernel must survive 5 seconds to be considered running
- **Upgrade detection:** Watches `$SIAS_UPGRADE_SIGNAL_FILE` for new kernel paths
- **Cleanup:** On SIGINT/SIGTERM, kills kernel and removes signal file

## Quick Start

```bash
# Set API keys
export OPENAI_API_KEY="sk-..."

# Create logs directory
mkdir -p logs

# Run launcher
bash ./sias-launcher.sh ./sias-kernel
```
