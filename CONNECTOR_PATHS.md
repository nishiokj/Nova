# Fix connector config paths (daemon running required)

The CLI talks to the sync daemon over HTTP. If the daemon isn’t reachable, config updates won’t persist.

## 1) Ensure the sync daemon is running
From `packages/agent-memory`:
```
bun run daemon
```

## 2) Update Claude connector to the new folder
```
bun run scripts/sync-api-cli.ts connectors config claude_sessions '{"projectsPath":"/Users/jevinnishioka/Desktop/sessions/claude"}'
```

## 3) Update Rex connector to the new folder
```
bun run scripts/sync-api-cli.ts connectors config rex_sessions '{"sessionsPath":"/Users/jevinnishioka/Desktop/sessions/jimmy"}'
```

## 4) Verify
```
bun run scripts/sync-api-cli.ts connectors claude_sessions
bun run scripts/sync-api-cli.ts connectors rex_sessions
```

If a connector isn’t registered yet, register it once:
```
bun run scripts/sync-api-cli.ts connectors register claude_sessions
bun run scripts/sync-api-cli.ts connectors register rex_sessions
```
