export type SessionEscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

export interface EscalationResolutionInput {
  optionId?: string;
  freeformResponse?: string;
  resolvedBy: 'user' | 'system' | 'timeout';
}

export interface SessionEscalationRecord {
  id: string;
  escalationType: string;
  sessionKey: string;
  workItemId?: string;
  title: string;
  context: string;
  tradeoffs?: string[];
  options?: Array<{ id: string; label: string; description: string; implications: string[]; recommended: boolean }>;
  references: Array<{ type: string; label: string; target: string; preview?: string }>;
  trigger?: string;
  status: SessionEscalationStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolution?: EscalationResolutionInput;
}

interface ResolveEscalationStateResult {
  found: boolean;
  alreadyTerminal: boolean;
  resolved?: SessionEscalationRecord;
  escalations: SessionEscalationRecord[];
  pendingCount: number;
}

const VALID_ESCALATION_STATUSES: ReadonlySet<SessionEscalationStatus> = new Set([
  'pending',
  'acknowledged',
  'resolved',
  'dismissed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeStatus(value: unknown): SessionEscalationStatus {
  return typeof value === 'string' && VALID_ESCALATION_STATUSES.has(value as SessionEscalationStatus)
    ? value as SessionEscalationStatus
    : 'pending';
}

function coerceResolution(value: unknown): EscalationResolutionInput | undefined {
  if (!isRecord(value)) return undefined;
  const resolvedBy = value.resolvedBy;
  if (resolvedBy !== 'user' && resolvedBy !== 'system' && resolvedBy !== 'timeout') {
    return undefined;
  }

  const optionId = asString(value.optionId);
  const freeformResponse = asString(value.freeformResponse);
  return {
    resolvedBy,
    ...(optionId ? { optionId } : {}),
    ...(freeformResponse ? { freeformResponse } : {}),
  };
}

function coerceEscalationRecord(input: unknown): SessionEscalationRecord | null {
  if (!isRecord(input)) return null;

  const id = asString(input.id);
  const escalationType = asString(input.escalationType);
  const sessionKey = asString(input.sessionKey);
  const title = asString(input.title);
  const context = asString(input.context);

  if (!id || !escalationType || !sessionKey || !title || !context) {
    return null;
  }

  const references = Array.isArray(input.references)
    ? input.references.filter((entry): entry is { type: string; label: string; target: string; preview?: string } => {
        if (!isRecord(entry)) return false;
        return !!asString(entry.type) && !!asString(entry.label) && !!asString(entry.target);
      }).map((entry) => ({
        type: entry.type,
        label: entry.label,
        target: entry.target,
        ...(typeof entry.preview === 'string' ? { preview: entry.preview } : {}),
      }))
    : [];

  const options = Array.isArray(input.options)
    ? input.options.filter((entry): entry is { id: string; label: string; description: string; implications: string[]; recommended: boolean } => {
        if (!isRecord(entry)) return false;
        return !!asString(entry.id) && !!asString(entry.label) && !!asString(entry.description) &&
          Array.isArray(entry.implications) && typeof entry.recommended === 'boolean';
      }).map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        implications: entry.implications.filter((item): item is string => typeof item === 'string'),
        recommended: entry.recommended,
      }))
    : undefined;

  const tradeoffs = Array.isArray(input.tradeoffs)
    ? input.tradeoffs.filter((item): item is string => typeof item === 'string')
    : undefined;

  const workItemId = asString(input.workItemId) ?? undefined;
  const trigger = asString(input.trigger) as string | null;
  const createdAt = asTimestamp(input.createdAt) ?? Date.now();
  const updatedAt = asTimestamp(input.updatedAt) ?? createdAt;
  const resolvedAt = asTimestamp(input.resolvedAt) ?? undefined;
  const resolution = coerceResolution(input.resolution);

  return {
    id,
    escalationType: escalationType as string,
    sessionKey,
    ...(workItemId ? { workItemId } : {}),
    title,
    context,
    ...(tradeoffs && tradeoffs.length > 0 ? { tradeoffs } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    references,
    ...(trigger ? { trigger } : {}),
    status: normalizeStatus(input.status),
    createdAt,
    updatedAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

export function parseSessionEscalations(value: unknown): SessionEscalationRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => coerceEscalationRecord(entry))
    .filter((entry): entry is SessionEscalationRecord => entry !== null);
}

export function resolveSessionEscalationState(
  escalations: SessionEscalationRecord[],
  escalationId: string,
  resolution: EscalationResolutionInput,
  now: number = Date.now()
): ResolveEscalationStateResult {
  let found = false;
  let alreadyTerminal = false;
  let resolved: SessionEscalationRecord | undefined;

  const nextEscalations = escalations.map((escalation) => {
    if (escalation.id !== escalationId) {
      return escalation;
    }

    found = true;

    if (escalation.status === 'resolved' || escalation.status === 'dismissed') {
      alreadyTerminal = true;
      resolved = escalation;
      return escalation;
    }

    const next: SessionEscalationRecord = {
      ...escalation,
      status: 'resolved',
      resolution,
      resolvedAt: now,
      updatedAt: now,
    };
    resolved = next;
    return next;
  });

  const pendingCount = nextEscalations.reduce((count, escalation) => (
    escalation.status === 'pending' || escalation.status === 'acknowledged' ? count + 1 : count
  ), 0);

  return {
    found,
    alreadyTerminal,
    resolved,
    escalations: nextEscalations,
    pendingCount,
  };
}

export function buildEscalationResolutionGuidance(
  escalation: SessionEscalationRecord,
  resolution: EscalationResolutionInput
): string {
  const details: string[] = [];
  if (resolution.optionId) {
    details.push(`Selected option: ${resolution.optionId}`);
  }
  if (resolution.freeformResponse) {
    details.push(`Resolution notes: ${resolution.freeformResponse}`);
  }

  const detailsLine = details.length > 0
    ? details.join(' | ')
    : 'No additional notes were provided.';

  return [
    `[Escalation Resolved] ${escalation.title}`,
    `Escalation ID: ${escalation.id} (${escalation.escalationType})`,
    `Resolved by: ${resolution.resolvedBy}`,
    detailsLine,
    'Continue execution using this decision as the latest source of truth.',
  ].join('\n');
}
