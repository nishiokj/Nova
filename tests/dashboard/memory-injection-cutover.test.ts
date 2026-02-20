import { mapGraphDSession } from '../../packages/apps/dashboard/src/lib/mappers';

describe('dashboard memory injection hard cutover', () => {
  it('maps memory_injected without removed compatibility fields', () => {
    const rawSession = {
      session_key: 'session-1',
      client_type: 'api',
      created_at: 1_700_000_000,
      last_accessed_at: 1_700_000_010,
      expires_at: null,
      working_dir: '/tmp/work',
      status: 'active',
      metadata_json: JSON.stringify({
        agent_events: [
          {
            type: 'memory_injected',
            request_id: 'req-1',
            timestamp: 1_700_000_001,
            data: {
              query: 'compat field event',
              itemCount: 1,
              success: true,
              iteration: 0,
              version: 'v1',
              fallback_to_v1: true,
            },
          },
        ],
      }),
    };

    const session = mapGraphDSession(rawSession);
    const injection = session.requests[0]?.memoryInjections[0];

    expect(injection).toBeDefined();
    expect(
      injection
        ? Object.prototype.hasOwnProperty.call(injection, 'version')
        : false
    ).toBe(false);
    expect(
      injection
        ? Object.prototype.hasOwnProperty.call(injection, 'fallbackToV1')
        : false
    ).toBe(false);
  });
});
