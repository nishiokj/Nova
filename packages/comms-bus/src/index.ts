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

// LogSubscriber and GraphDSubscriber live in the harness daemon layer.
