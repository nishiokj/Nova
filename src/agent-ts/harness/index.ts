/**
 * Harness module - Barrel export.
 */

export { AgentHarness, createHarnessFromEnv } from './harness.js';
export {
  translateWizardEvent,
  createStreamEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
} from './event_translator.js';
export type {
  AgentRunParams,
  AgentRunResult,
  AgentRunHandle,
  BridgeEvent,
  BridgeEventType,
  Tier,
  UserPromptInfo,
  StatusEventData,
  ProgressEventData,
  StreamEventData,
  ResponseEventData,
  ReadyEventData,
  UserPromptEventData,
  ErrorEventData,
} from './types.js';

// Re-export EventBus for external subscribers
export { EventBus, type EventBusProtocol } from '../communication/event_bus.js';

// Config loading
export {
  loadConfig,
  loadConfigFile,
  getLLMConfigForTier,
  createConfigFromFile,
  createConfigFromEnv,
  resolveApiKey,
} from './config_loader.js';
export type {
  Tier as ConfigTier,
  LLMProvider,
  TieredLLMConfig,
  HarnessConfigFile,
  FullHarnessConfig,
  ResolvedLLMConfig,
  AgentConfigSection,
  ToolsConfigSection,
  GraphDConfigSection,
  SkillsConfigSection,
  HooksConfigSection,
} from './config_types.js';
export {
  DEFAULT_TIER_TOOL_LIMITS,
  DEFAULT_TIER_MAX_TOKENS,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_GRAPHD_CONFIG,
} from './config_types.js';

// Skills and hooks loading
export {
  loadSkillDefinitions,
  loadHookDefinitions,
} from './skills_loader.js';
export type {
  SkillDefinitionStub,
  HookDefinitionStub,
} from './skills_loader.js';
