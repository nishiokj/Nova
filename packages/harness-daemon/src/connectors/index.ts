/**
 * Connectors
 *
 * External service integrations for the harness daemon.
 */

export {
  TelegramConnector,
  createTelegramWebhookHandler,
  type TelegramConnectorConfig,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUser,
  type TelegramChat,
  type TelegramSendMessageOptions,
} from './telegram.js';

export {
  WebhookServer,
  registerTelegramWebhook,
  type WebhookServerConfig,
  type WebhookRoute,
} from './webhook_server.js';
