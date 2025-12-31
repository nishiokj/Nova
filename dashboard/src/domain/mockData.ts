import { computeRequestInsights, computeSessionInsights, type Request, type Session } from './models';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function req(partial: Omit<Request, 'insights'>): Request {
  return { ...partial, insights: computeRequestInsights(partial) };
}

function sess(partial: Omit<Session, 'insights'>): Session {
  return { ...partial, insights: computeSessionInsights(partial) };
}

export const mockSessions: Session[] = [
  sess({
    id: 'S-1042',
    userId: 'user_81b2',
    state: 'active',
    env: 'prod',
    createdAt: iso(1000 * 60 * 40),
    startedAt: iso(1000 * 60 * 34),
    tags: ['paid', 'web', 'us-east'],
    meta: {
      plan: 'pro',
      region: 'us-east-1',
      appVersion: '1.18.0',
      device: 'desktop',
    },
    requests: [
      req({
        id: 'R-1',
        sessionId: 'S-1042',
        state: 'success',
        method: 'GET',
        path: '/api/sessions',
        createdAt: iso(1000 * 60 * 33),
        startedAt: iso(1000 * 60 * 33),
        endedAt: iso(1000 * 60 * 33 - 180),
        httpStatus: 200,
        meta: { cache: 'HIT', traceId: 'tr_aa12', host: 'edge-3' },
      }),
      req({
        id: 'R-2',
        sessionId: 'S-1042',
        state: 'error',
        method: 'POST',
        path: '/api/checkout',
        createdAt: iso(1000 * 60 * 31),
        startedAt: iso(1000 * 60 * 31),
        endedAt: iso(1000 * 60 * 31 - 820),
        httpStatus: 502,
        errorCode: 'UPSTREAM_TIMEOUT',
        errorMessage: 'Gateway timeout contacting payments',
        meta: { traceId: 'tr_bb39', retries: '2', provider: 'stripe' },
      }),
      req({
        id: 'R-3',
        sessionId: 'S-1042',
        state: 'running',
        method: 'GET',
        path: '/api/recommendations',
        createdAt: iso(1000 * 60 * 2),
        startedAt: iso(1000 * 60 * 2),
        meta: { traceId: 'tr_cc01', model: 'ranker-v3' },
      }),
    ],
  }),
  sess({
    id: 'S-1043',
    userId: 'user_1f0a',
    state: 'idle',
    env: 'staging',
    createdAt: iso(1000 * 60 * 15),
    startedAt: iso(1000 * 60 * 12),
    tags: ['trial', 'mobile'],
    meta: {
      plan: 'trial',
      region: 'eu-west-1',
      appVersion: '1.18.0-rc.2',
      device: 'ios',
    },
    requests: [
      req({
        id: 'R-4',
        sessionId: 'S-1043',
        state: 'success',
        method: 'GET',
        path: '/api/profile',
        createdAt: iso(1000 * 60 * 11),
        startedAt: iso(1000 * 60 * 11),
        endedAt: iso(1000 * 60 * 11 - 240),
        httpStatus: 200,
        meta: { cache: 'MISS', traceId: 'tr_dd88' },
      }),
      req({
        id: 'R-5',
        sessionId: 'S-1043',
        state: 'queued',
        method: 'GET',
        path: '/api/events?limit=50',
        createdAt: iso(1000 * 12),
        meta: { traceId: 'tr_ee90', backlog: 'high' },
      }),
    ],
  }),
];
