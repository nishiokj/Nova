/**
 * Harness module - Barrel export.
 */

export { AgentHarness, createHarnessFromEnv } from './harness.js';
export { BridgeGateway } from './bridge_gateway.js';
export { HarnessDaemon, runHarnessDaemon, type HarnessDaemonOptions } from './daemon.js';
export {
  translateAgentEvent,
  createStreamEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
  createUserPromptEvent,
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
export { EventBus, type EventBusProtocol } from 'comms-bus';

// Config loading and types
export {
  loadConfig,
  loadConfigFile,
  getAgentConfig,
  createConfigFromFile,
} from './config_loader.js';
export type {
  LLMProvider,
  ReasoningEffort,
  AgentType,
  AgentLLMConfig,
  AgentBudgetConfig,
  AgentConfigEntry,
  HarnessConfigFile,
  FullHarnessConfig,
  ResolvedLLMConfig,
  ResolvedAgentConfig,
  ToolsConfigSection,
  GraphDConfigSection,
  ContextConfigSection,
  SkillsConfigSection,
  HooksConfigSection,
  SkillConfigEntry,
  HookConfigEntry,
} from './config.js';
export {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_GRAPHD_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_HOOKS_CONFIG,
} from './config.js';

// Skills and hooks loading
export {
  loadSkillDefinitions,
  loadHookDefinitions,
} from './skills_loader.js';
export type {
  SkillDefinitionStub,
  HookDefinitionStub,
} from './skills_loader.js';

// Connectors and webhooks
export {
  TelegramConnector,
  WebhookServer,
  registerTelegramWebhook,
  createTelegramWebhookHandler,
} from '../connectors/index.js';
export type {
  TelegramConnectorConfig,
  TelegramUpdate,
  TelegramMessage,
  TelegramUser,
  TelegramChat,
  TelegramSendMessageOptions,
  WebhookServerConfig,
  WebhookRoute,
} from '../connectors/index.js';
