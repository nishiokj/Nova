export type ISODateTime = string;
export type KV = Record<string, string>;

export type Environment = 'prod' | 'staging' | 'dev';

export type SessionState = 'active' | 'idle' | 'ended' | 'error';
export type RequestState = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ============================================
// AGENT EXECUTION TYPES
// ============================================

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type StepPhase = 'discovery' | 'execution';

export interface PlanStep {
  stepNum: number;
  objective: string;
  status: StepStatus;
  phase: StepPhase;
  toolHint?: string;
  required: boolean;
  durationMs?: number;
  error?: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs: number;
  timestamp: ISODateTime;
}

export type ReflectionVerdict = 'accept' | 'accept_extend' | 'redo' | 'abort_step' | 'abort_goal';

export interface Reflection {
  verdict: ReflectionVerdict;
  confidence: number;
  qualityScore: number;
  reasoning?: string;
  issues: string[];
}

export type TaskState = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export interface AgentTask {
  id: string;
  sessionId: string;
  state: TaskState;
  userInput: string;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;

  // Execution data
  plan?: {
    goal: string;
    steps: PlanStep[];
  };
  toolCalls: ToolCall[];
  reflection?: Reflection;

  // Metrics
  stepsCompleted: number;
  stepsTotal: number;
  totalToolCalls: number;
  durationMs?: number;

  // Errors
  errorMessage?: string;
}

export interface TaskInsights {
  durationMs?: number;
  stepProgress: number; // 0-1
  hasErrors: boolean;
  qualityScore?: number;
}

// ============================================
// LEGACY TYPES (kept for compatibility)
// ============================================

export type LatencyPercentiles = {
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
};

export type RequestInsights = {
  durationMs?: number;
  latency?: LatencyPercentiles;
};

export type SessionInsights = {
  durationMs: number;
  errorRate: number;
  latency: LatencyPercentiles;
  // New task-based metrics
  taskCount: number;
  tasksRunning: number;
  tasksFailed: number;
  tasksCompleted: number;
  avgQuality?: number;
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
  meta: KV;
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
  tasks: AgentTask[];
  insights: SessionInsights;
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

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

export function computeTaskInsights(t: AgentTask): TaskInsights {
  const durationMs = t.startedAt && t.endedAt ? msBetween(t.startedAt, t.endedAt) : undefined;
  const stepProgress = t.stepsTotal > 0 ? t.stepsCompleted / t.stepsTotal : 0;

  return {
    durationMs,
    stepProgress,
    hasErrors: t.state === 'error' || (t.plan?.steps.some(s => s.status === 'failed') ?? false),
    qualityScore: t.reflection?.qualityScore,
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

  // Task metrics
  const taskCount = s.tasks.length;
  const tasksRunning = s.tasks.filter(t => t.state === 'running').length;
  const tasksFailed = s.tasks.filter(t => t.state === 'error').length;
  const tasksCompleted = s.tasks.filter(t => t.state === 'success').length;

  const qualityScores = s.tasks
    .map(t => t.reflection?.qualityScore)
    .filter((q): q is number => typeof q === 'number');
  const avgQuality = qualityScores.length > 0
    ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
    : undefined;

  return {
    durationMs,
    errorRate,
    latency: {
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
    },
    taskCount,
    tasksRunning,
    tasksFailed,
    tasksCompleted,
    avgQuality,
  };
}

// ============================================
// FILTER TYPES
// ============================================

export type FilterType = 'all' | 'errors' | 'running' | 'completed';

export interface FilterCounts {
  all: number;
  errors: number;
  running: number;
  completed: number;
}
