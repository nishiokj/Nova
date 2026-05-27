export interface RpcRequest {
  rpc: 1;
  method: string;
  id: string;
  params?: unknown;
}

export interface RpcSuccess<T = unknown> {
  rpc: 1;
  id: string;
  result: T;
}

export interface RpcError {
  rpc: 1;
  id: string;
  error: {
    code: number;
    message: string;
  };
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcError;

export interface ServiceHealth {
  success: boolean;
  status: 'ok' | 'degraded';
  protocolVersion: string;
  uptimeMs: number;
  connections: number;
  serviceAuthRequired: boolean;
  state: 'idle' | 'error';
  error?: string;
}

export interface ServiceReadiness {
  success: boolean;
  ready: boolean;
  checks: {
    daemon: boolean;
    harness: boolean;
    bus: boolean;
    graphd?: boolean;
  };
  error?: string;
}

export interface Procedures {
  'config.get': { input: Record<string, never>; output: Record<string, unknown> };
  'status.get': { input: Record<string, never>; output: Record<string, unknown> };
  'service.health': { input: Record<string, never>; output: ServiceHealth };
  'service.readiness': { input: Record<string, never>; output: ServiceReadiness };
  'models.list': { input: Record<string, never>; output: Record<string, unknown> };
  'models.delete': { input: { model?: string; model_id?: string }; output: Record<string, unknown> };

  'skills.list': { input: Record<string, never>; output: Record<string, unknown> };
  'skills.get': { input: { id?: string }; output: Record<string, unknown> };
  'skills.create': { input: { skill?: Record<string, unknown> }; output: Record<string, unknown> };
  'skills.update': { input: { id?: string; updates?: Record<string, unknown> }; output: Record<string, unknown> };
  'skills.delete': { input: { id?: string }; output: Record<string, unknown> };
  'skills.enable': { input: { id?: string }; output: Record<string, unknown> };
  'skills.disable': { input: { id?: string }; output: Record<string, unknown> };
  'skills.run': { input: Record<string, never>; output: Record<string, unknown> };

  'hooks.list': { input: Record<string, never>; output: Record<string, unknown> };
  'hooks.get': { input: { id?: string }; output: Record<string, unknown> };
  'hooks.create': { input: { hook?: Record<string, unknown> }; output: Record<string, unknown> };
  'hooks.update': { input: { id?: string; updates?: Record<string, unknown> }; output: Record<string, unknown> };
  'hooks.delete': { input: { id?: string }; output: Record<string, unknown> };
  'hooks.enable': { input: { id?: string }; output: Record<string, unknown> };
  'hooks.disable': { input: { id?: string }; output: Record<string, unknown> };

  'auth.start': { input: { device?: string }; output: { success: boolean; authUrl?: string; stateToken?: string; error?: string } };
  'auth.poll': { input: { stateToken: string }; output: { success: boolean; pending?: boolean; sessionToken?: string; userId?: string; email?: string; name?: string | null; error?: string } };
  'auth.verify': { input: { sessionToken: string }; output: { success: boolean; valid?: boolean; user?: { id: string; email: string; name: string | null }; error?: string } };
  'auth.logout': { input: { sessionToken: string }; output: { success: boolean } };

  'providers.list': { input: { sessionToken?: string }; output: { success: boolean; providers?: { provider: string; configured: boolean; updatedAt?: number }[]; error?: string } };
  'providers.save': { input: { provider: string; apiKey: string; sessionToken?: string }; output: { success: boolean; error?: string } };
  'providers.delete': { input: { provider: string; sessionToken?: string }; output: { success: boolean; error?: string } };
  'providers.test': { input: { provider: string; sessionToken?: string }; output: { success: boolean; valid?: boolean; error?: string } };

  'session.fork': { input: Record<string, never>; output: { success: boolean; newSessionKey?: string; sourceSessionKey?: string; error?: string } };
  'session.close': { input: Record<string, never>; output: { success: boolean; sessionKey?: string; message?: string; error?: string } };
  'session.delete': { input: { sessionKey?: string; session_key?: string }; output: { success: boolean; deleted: boolean; error?: string } };
  'session.list': { input: { workingDir?: string; status?: string | string[]; limit?: number }; output: { success: boolean; sessions: { sessionKey: string; clientType: string; createdAt: number; lastAccessedAt: number; workingDir: string | null; status: string; lastUserMessagePreview?: string | null }[]; error?: string } };

  'usage.summary': { input: { status?: string | string[]; limit?: number }; output: { success: boolean; usage?: { provider: string; model: string; totalTokens: number; sessionCount: number }[]; sessions?: { sessionKey: string; clientType: string; createdAt: number; lastAccessedAt: number; workingDir: string | null; status: string; metadataJson: string | null; metadata?: Record<string, unknown>; lastUserMessagePreview?: string | null; goal?: string | null; currentWorkItemId?: string | null; currentObjective?: string | null }[]; error?: string } };

  'context.compact': { input: Record<string, never>; output: Record<string, unknown> };
  'model.set': { input: { agent_type?: string; provider?: string; model?: string; reasoning?: string; api_key?: string; reset?: boolean }; output: Record<string, unknown> };
  'model.get': { input: { agent_type?: string; all?: boolean }; output: Record<string, unknown> };

  'dangerous_mode.set': { input: { enabled: boolean }; output: { success: boolean; enabled?: boolean; sessionKey?: string; error?: string } };

  'async.start': { input: { goal: string; working_dir?: string; session_key?: string }; output: { success: boolean; sessionKey?: string; requestId?: string; goal?: string; error?: string } };
  'async.cancel': { input: { session_key?: string }; output: { success: boolean; requestId?: string; goal?: string; quiesced?: boolean; error?: string } };
  'async.status': { input: { session_key?: string }; output: { success: boolean; running?: boolean; requestId?: string; goal?: string; startedAt?: number; elapsedMs?: number; error?: string } };

  'control.dispatch': { input: { session_key: string; message: string; context?: string; metadata?: Record<string, unknown>; request_id?: string; working_dir?: string }; output: Record<string, unknown> };
  'control.stop': { input: { session_key: string; note?: string; action?: 'cancel' | 'pause' | 'resume'; timeout_ms?: number; working_dir?: string }; output: Record<string, unknown> };
  'control.fork': { input: { source_session_key: string; target_session_key?: string }; output: Record<string, unknown> };
  'control.permissions.get': { input: { session_key: string; working_dir?: string }; output: Record<string, unknown> };
  'control.permissions.update': { input: { session_key: string; working_dir?: string; update: Record<string, unknown> }; output: Record<string, unknown> };
  'control.memory_info': { input: Record<string, never>; output: Record<string, unknown> };
  'control.model.get': { input: { session_key: string }; output: Record<string, unknown> };
  'control.model.set': { input: { session_key: string; agent_type?: string; provider: string; model: string; reasoning?: string; api_key?: string }; output: Record<string, unknown> };

  'voice.start': { input: Record<string, never>; output: Record<string, unknown> };
  'voice.stop': { input: Record<string, never>; output: Record<string, unknown> };
}

export type ProcedureMethod = keyof Procedures;
export type ProcedureInput<M extends ProcedureMethod> = Procedures[M]['input'];
export type ProcedureOutput<M extends ProcedureMethod> = Procedures[M]['output'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value)) return false;
  if (value.rpc !== 1) return false;
  if (typeof value.method !== 'string' || value.method.length === 0) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  return true;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value)) return false;
  if (value.rpc !== 1) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;

  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) {
    return false;
  }

  if (!hasError) {
    return true;
  }

  if (!isRecord(value.error)) return false;
  return typeof value.error.code === 'number' && Number.isFinite(value.error.code)
    && typeof value.error.message === 'string';
}
