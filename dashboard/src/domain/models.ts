export type ISODateTime = string;
export type KV = Record<string, string>;

export type Environment = 'prod' | 'staging' | 'dev';

export type SessionState = 'active' | 'idle' | 'ended' | 'error';
export type RequestState = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type LatencyPercentiles = {
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
};

export type RequestInsights = {
  /** Derived duration between startedAt and endedAt (ms). */
  durationMs?: number;
  /** Placeholder for per-request percentiles when applicable (e.g. streaming/chunked). */
  latency?: LatencyPercentiles;
};

export type SessionInsights = {
  /** Derived session duration between startedAt and endedAt/now (ms). */
  durationMs: number;
  /** errorCount / totalRequests */
  errorRate: number;
  /** Aggregated latency percentiles for requests (placeholder if no durations). */
  latency: LatencyPercentiles;
};

export type Request = {
  id: string;
  sessionId: string;

  state: RequestState;
  method: HttpMethod;
  path: string;

  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;

  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;

  /** Client/server provided metadata */
  meta: KV;

  /** Computed fields for UI */
  insights: RequestInsights;
};

export type Session = {
  id: string;
  userId: string;

  state: SessionState;
  env: Environment;

  createdAt: ISODateTime;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;

  tags: string[];
  meta: KV;

  requests: Request[];

  /** Computed fields for UI */
  insights: SessionInsights;
};

export function msBetween(a: ISODateTime, b: ISODateTime): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function computeRequestInsights(r: Omit<Request, 'insights'>): RequestInsights {
  const durationMs = r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined;
  return {
    durationMs,
    latency: undefined,
  };
}

export function computeSessionInsights(s: Omit<Session, 'insights'>): SessionInsights {
  const now = new Date().toISOString();
  const end = s.endedAt ?? now;
  const durationMs = msBetween(s.startedAt, end);

  const total = s.requests.length || 1;
  const errors = s.requests.filter((r) => r.state === 'error').length;
  const errorRate = clamp01(errors / total);

  const durs = s.requests
    .map((r) => (r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined))
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);

  const percentile = (p: number): number | undefined => {
    if (!durs.length) return undefined;
    const idx = Math.min(durs.length - 1, Math.max(0, Math.floor((p / 100) * durs.length)));
    return durs[idx];
  };

  return {
    durationMs,
    errorRate,
    latency: {
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
    },
  };
}
