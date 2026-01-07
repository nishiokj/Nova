/**
 * Communication module - Event bus and related utilities.
 */

export {
  EventBus,
  type EventBusProtocol,
  createEventEmitCallback,
} from './event_bus.js';

export {
  BusClient,
  type BusClientOptions,
} from './bus_client.js';

export {
  BusServer,
  type BusServerOptions,
  type BusPublishHandler,
} from './bus_server.js';

export {
  BRIDGE_COMMAND_CHANNEL,
  runChannel,
  sessionChannel,
} from './bus_channels.js';

export type {
  BusClientMessage,
  BusServerMessage,
  BusMessage,
} from './bus_types.js';

export {
  LogSubscriber,
  createLogSubscriber,
  type LogSubscriberConfig,
} from './log_subscriber.js';

export {
  GraphDSubscriber,
  createGraphDSubscriber,
  type GraphDSubscriberConfig,
} from './graphd_subscriber.js';
