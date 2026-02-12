import { EventBus } from 'comms-bus';
import { createEvent } from 'types';

import { createGraphDSubscriber } from 'harness-daemon/subscribers/graphd_subscriber.js';

describe('GraphDSubscriber', () => {
  it('persists agent_message stream events', async () => {
    const eventBus = new EventBus();
    const metadataPatches: Array<{ sessionKey: string; patch: Record<string, unknown> }> = [];

    const graphd = {
      sessionUpdateMetadata: (sessionKey: string, patch: Record<string, unknown>) => {
        metadataPatches.push({ sessionKey, patch });
        return { success: true };
      },
      checkpoint: () => {},
    };

    const subscriber = createGraphDSubscriber(
      eventBus,
      graphd as unknown as import('graphd').GraphDManager,
      { batchMode: false }
    );

    eventBus.publish(createEvent('agent_message', { agentType: 'standard', message: 'hello' }, 'wk-1', 'req-1', 'sess-1'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      metadataPatches.some((entry) => (
        entry.sessionKey === 'sess-1'
        && Array.isArray(entry.patch.agent_events)
        && entry.patch.agent_events.some((event) =>
          typeof event === 'object'
          && event !== null
          && (event as Record<string, unknown>).type === 'agent_message')
      ))
    ).toBe(true);

    subscriber.close();
  });
});
