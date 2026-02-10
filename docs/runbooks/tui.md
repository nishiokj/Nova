# TUI Runbook

## Start

```bash
bun run start:tui
```

The TUI expects the runtime daemon bus to be available.

## Health

Operational check:

- TUI process starts without immediate exit
- Session list/status renders
- Commands can be submitted to a session

CI deployability check uses build:

```bash
bun run --cwd packages/tui build
```

## Stop

- If foreground: `Ctrl+C`
