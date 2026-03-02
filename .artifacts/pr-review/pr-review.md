<!-- nova-pr-review -->
## Entity Graph PR Review

Compared `c2dbbea9...4c018f33` with max depth `2`.

Summary: 27 entities changed; 14 direct and 5 transitive dependents affected; 29 warnings; 2 contract gaps (2 unresolved dependents).

### Counts
- Changed entities: 27
- Blast radius (direct): 14
- Blast radius (transitive): 5
- Risk signals: 40 (critical 0, warning 29)
- Contract impact gaps: 2
- Dead code candidates: 72

### Top Risks
| Score | Entity | File | Key factor |
|---:|---|---|---|
| 63 | `highlightCode` | `packages/apps/tui/utils/syntax.ts` | directly signature changed |
| 63 | `isLanguageSupported` | `packages/apps/tui/utils/syntax.ts` | directly signature changed |
| 63 | `createConfigFromFile` | `packages/infra/harness-daemon/src/harness/config_loader.ts` | directly body changed |
| 63 | `loadConfig` | `packages/infra/harness-daemon/src/harness/config_loader.ts` | depth 1 dependent (calls edge) |
| 61 | `BridgeClient.close` | `packages/apps/tui/bridge_client.ts` | directly signature changed |
| 58 | `EventBus` | `packages/infra/comms-bus/src/event_bus.ts` | directly signature changed |
| 55 | `BridgeClient` | `packages/apps/tui/bridge_client.ts` | directly signature changed |
| 55 | `applyHighlights` | `packages/apps/tui/utils/syntax.ts` | directly signature changed |
| 53 | `ensureParserInitStarted` | `packages/apps/tui/utils/syntax.ts` | directly signature changed |
| 53 | `highlightTree` | `packages/apps/tui/utils/syntax.ts` | depth 1 dependent (calls edge) |
| 53 | `loadConfigFile` | `packages/infra/harness-daemon/src/harness/config_loader.ts` | depth 1 dependent (calls edge) |
| 53 | `translateAgentEvent` | `packages/infra/harness-daemon/src/harness/event_translator.ts` | depth 1 dependent (calls edge) |

### Changed Entities
- `entity_added` `manifest.json` in `manifest.json`
- `signature_changed` `BridgeClient` in `packages/apps/tui/bridge_client.ts`
- `signature_changed` `BridgeClient.rpc` in `packages/apps/tui/bridge_client.ts`
- `signature_changed` `BridgeClient.close` in `packages/apps/tui/bridge_client.ts`
- `signature_changed` `ParserApi` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `loadParserApi` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `ensureParserInitStarted` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `detectLanguage` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `isLanguageSupported` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `highlightCode` in `packages/apps/tui/utils/syntax.ts`
- `signature_changed` `applyHighlights` in `packages/apps/tui/utils/syntax.ts`
- `body_changed` `EventBusProtocol` in `packages/infra/comms-bus/src/event_bus.ts`
- `signature_changed` `EventBus` in `packages/infra/comms-bus/src/event_bus.ts`
- `body_changed` `EventBus.dispatchEvent` in `packages/infra/comms-bus/src/event_bus.ts`
- `signature_changed` `EventBus.subscribe` in `packages/infra/comms-bus/src/event_bus.ts`
- `body_changed` `EventBus.subscribeRun` in `packages/infra/comms-bus/src/event_bus.ts`
- `signature_changed` `EventBus.shutdown` in `packages/infra/comms-bus/src/event_bus.ts`
- `body_changed` `expandHome` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- `signature_changed` `parseBooleanEnv` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- `body_changed` `createConfigFromFile` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- ...and 7 more

### Dead Code Candidates
- `BridgeClientOptions` in `packages/apps/tui/bridge_client.ts`
- `BridgeClient` in `packages/apps/tui/bridge_client.ts`
- `BridgeClient.rpc` in `packages/apps/tui/bridge_client.ts`
- `BridgeClient.constructor` in `packages/apps/tui/bridge_client.ts`
- `isLanguageSupported` in `packages/apps/tui/utils/syntax.ts`
- `highlightCode` in `packages/apps/tui/utils/syntax.ts`
- `EventBus` in `packages/infra/comms-bus/src/event_bus.ts`
- `EventBus.constructor` in `packages/infra/comms-bus/src/event_bus.ts`
- `EventBus.subscribe` in `packages/infra/comms-bus/src/event_bus.ts`
- `EventBus.subscribeAll` in `packages/infra/comms-bus/src/event_bus.ts`
- `EventBus.subscribeRun` in `packages/infra/comms-bus/src/event_bus.ts`
- `EventBus.shutdown` in `packages/infra/comms-bus/src/event_bus.ts`
- `createEventEmitCallback` in `packages/infra/comms-bus/src/event_bus.ts`
- `resolveRepoRoot` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- `getAgentConfig` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- `loadConfig` in `packages/infra/harness-daemon/src/harness/config_loader.ts`
- `translateAgentEvent` in `packages/infra/harness-daemon/src/harness/event_translator.ts`
- `createStatusEvent` in `packages/infra/harness-daemon/src/harness/event_translator.ts`
- `createResponseEvent` in `packages/infra/harness-daemon/src/harness/event_translator.ts`
- `createErrorEvent` in `packages/infra/harness-daemon/src/harness/event_translator.ts`
- ...and 52 more

### Unresolved Contract Dependents
- `signature_changed` on `applyHighlights` in `packages/apps/tui/utils/syntax.ts` has 1/1 direct dependents not updated: `highlightTree`
- `signature_changed` on `HarnessProviderKeyService.getApiKey` in `packages/infra/harness-daemon/src/harness/harness.ts` has 1/1 direct dependents not updated: `HarnessProviderKeyService.hasApiKey`