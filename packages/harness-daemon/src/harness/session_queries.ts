import type { GraphDManager, GraphDSession } from 'graphd';

export const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;

export interface SessionListOptions {
  clientType?: string;
  workingDir?: string;
  status?: string | string[];
  limit?: number;
  includePreview?: boolean;
}

export interface SessionListResult {
  success: boolean;
  sessions: GraphDSession[];
  error?: string;
}

export interface SessionDeleteResult {
  success: boolean;
  deleted: boolean;
  error?: string;
}

export interface TokenUsageEntry {
  provider: string;
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface TokenUsageResult {
  success: boolean;
  usage: TokenUsageEntry[];
  sessions: GraphDSession[];
  error?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  activeGoals: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseSessionMetadata(session: GraphDSession): GraphDSession {
  if (session.metadata && isRecord(session.metadata)) {
    return session;
  }

  if (!session.metadataJson || session.metadataJson.trim().length === 0) {
    return session;
  }

  try {
    const parsed = JSON.parse(session.metadataJson) as unknown;
    if (isRecord(parsed)) {
      return { ...session, metadata: parsed };
    }
  } catch {
    // Ignore malformed metadata; callers can continue with metadataJson-only sessions.
  }

  return session;
}

export function listSessions(
  graphd: GraphDManager | null,
  options: SessionListOptions = {}
): SessionListResult {
  if (!graphd) {
    return { success: false, sessions: [], error: 'GraphD not available' };
  }

  const result = graphd.sessionsList(options) as { sessions?: GraphDSession[]; error?: string };
  const hydrated = (result.sessions ?? []).map(parseSessionMetadata);
  return {
    success: !result.error,
    sessions: hydrated,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function deleteSession(graphd: GraphDManager | null, sessionKey: string): SessionDeleteResult {
  if (!graphd) {
    return { success: false, deleted: false, error: 'GraphD not available' };
  }

  try {
    return { success: true, deleted: graphd.sessionDelete(sessionKey) };
  } catch (error) {
    return {
      success: false,
      deleted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeTokenUsage(sessions: GraphDSession[]): TokenUsageEntry[] {
  const usageMap = new Map<string, TokenUsageEntry>();

  for (const session of sessions) {
    const metadata = session.metadata;
    if (!metadata || !isRecord(metadata)) continue;

    const provider = typeof metadata.provider === 'string' && metadata.provider.trim().length > 0
      ? metadata.provider
      : 'unknown';
    const model = typeof metadata.model === 'string' && metadata.model.trim().length > 0
      ? metadata.model
      : 'unknown';
    const tokens = asNumber(metadata.total_tokens ?? metadata.totalTokens) ?? 0;
    const key = `${provider}:${model}`;

    const existing = usageMap.get(key);
    if (existing) {
      existing.totalTokens += tokens;
      existing.sessionCount += 1;
    } else {
      usageMap.set(key, {
        provider,
        model,
        totalTokens: tokens,
        sessionCount: 1,
      });
    }
  }

  return Array.from(usageMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

export function getTokenUsage(
  graphd: GraphDManager | null,
  options: { limit?: number; status?: string | string[] } = {}
): TokenUsageResult {
  const sessionsResult = listSessions(graphd, {
    status: options.status ?? [...ALL_SESSION_STATUSES],
    limit: options.limit ?? 1000,
    includePreview: false,
  });

  if (!sessionsResult.success && sessionsResult.sessions.length === 0) {
    return { success: false, usage: [], sessions: [], ...(sessionsResult.error ? { error: sessionsResult.error } : {}) };
  }

  const usage = summarizeTokenUsage(sessionsResult.sessions);
  return {
    success: sessionsResult.success,
    usage,
    sessions: sessionsResult.sessions,
    ...(sessionsResult.error ? { error: sessionsResult.error } : {}),
  };
}

export function buildProjectSummaries(sessions: GraphDSession[]): ProjectSummary[] {
  const projectMap = new Map<string, { count: number; lastAccessed: number }>();

  for (const session of sessions) {
    const workingDir = session.workingDir;
    if (!workingDir) continue;

    const existing = projectMap.get(workingDir);
    if (existing) {
      existing.count += 1;
      existing.lastAccessed = Math.max(existing.lastAccessed, session.lastAccessedAt);
    } else {
      projectMap.set(workingDir, { count: 1, lastAccessed: session.lastAccessedAt });
    }
  }

  return Array.from(projectMap.entries())
    .map(([projectPath, data]) => {
      const parts = projectPath.split('/');
      const name = parts[parts.length - 1] || projectPath;
      return {
        id: projectPath,
        name,
        path: projectPath,
        sessionCount: data.count,
        activeGoals: 0,
      };
    })
    .sort((a, b) => b.sessionCount - a.sessionCount);
}
