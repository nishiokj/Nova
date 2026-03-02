# memory

Unified optional plugin for Nova memory features.

## What It Includes

- `agent-memory`
- `memory-injector`
- `entity-graph`
- `postgres` wiring for entity graph initialization

## Install

```bash
bun add memory
```

## Notes

- Core Nova remains installable without this plugin.
- Enabling `memory.enabled` and/or `entity_graph.enabled` expects this plugin to be installed.
