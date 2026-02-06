import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyCockpitPatch,
  getCockpitBrowserState,
  getCockpitCommitRollups,
  getCockpitDiff,
  getCockpitDailyMetrics,
  getCockpitEscalationRollups,
  getCockpitFocus,
  getCockpitPreview,
  getCockpitPRRollups,
  getCockpitSessionEvents,
  getCockpitSessionRollups,
  getCockpitTestReport,
  getCockpitTestReports,
  getCockpitTraces,
  postCockpitBrowserAction,
  postCockpitBrowserRunbook,
  postCockpitSessionMessage,
  postCockpitSessionReviewDecision,
  resolveCockpitEscalation,
  searchCockpitRepoLens,
  type CommitRollup,
  type CockpitBrowserActionInput,
  type CockpitBrowserState,
  type CockpitDiff,
  type CockpitTestReport,
  type DailyMetrics,
  type EscalationRollup,
  type FocusData,
  type NormalizedSessionEvent,
  type PRRollup,
  type RepoLensMatch,
  type SessionRollup,
  type TraceRecord,
} from './lib/api';

const POLL_INTERVAL_MS = 5000;

type FocusTarget =
  | { type: 'session'; id: string }
  | { type: 'escalation'; id: string };

type FocusTab = 'packet' | 'diff' | 'tests' | 'trace' | 'lens' | 'browser';
type PanelFocus = 'left' | 'center' | 'right' | 'input';
type LeftSection = 'running' | 'ready' | 'done' | 'metrics';
type RightSection = 'queue' | 'commits' | 'prs';
type TrustTier = 'proven' | 'computed' | 'heuristic';
type EventFilter = 'signal' | 'all' | 'messages' | 'tools' | 'failures' | 'audit';

const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'done', 'metrics'];
const RIGHT_SECTIONS: RightSection[] = ['queue', 'commits', 'prs'];
const CENTER_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;
const DEFAULT_BROWSER_RUNBOOK = [
  '# One command per line',
  '# open https://example.com',
  '# snapshot -i -c',
  '# click @e1',
  '# fill @e2 \"search query\"',
  '# press Enter',
  '# screenshot smoke-check',
].join('\n');

interface PacketFrontmatter {
  type?: string;
  sessionKey?: string;
  workItemId?: string;
  requestedDecision?: string;
  priority?: string;
  links: Array<{ label: string; target: string }>;
  refs: Array<{ type: string; target: string }>;
}

interface ParsedPacketMarkdown {
  frontmatter: PacketFrontmatter | null;
  bodyMarkdown: string;
}

function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePacketMarkdown(markdown: string): ParsedPacketMarkdown {
  if (!markdown.startsWith('---')) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  let endIndex = -1;
  for (let idx = 1; idx < lines.length; idx += 1) {
    if (lines[idx].trim() === '---') {
      endIndex = idx;
      break;
    }
  }
  if (endIndex < 0) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }

  const scalar: Record<string, string> = {};
  const links: Array<{ label: string; target: string }> = [];
  const refs: Array<{ type: string; target: string }> = [];
  let section: string | null = null;

  for (const rawLine of lines.slice(1, endIndex)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const isRoot = !rawLine.startsWith(' ') && !rawLine.startsWith('\t');
    if (isRoot) {
      const rootMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!rootMatch) {
        section = null;
        continue;
      }
      const key = rootMatch[1];
      const value = rootMatch[2];
      if (value) {
        scalar[key] = unquoteYamlValue(value);
        section = null;
      } else {
        section = key.toLowerCase();
      }
      continue;
    }

    const nested = trimmed;
    if (section === 'links') {
      const linkMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (linkMatch) {
        links.push({
          label: linkMatch[1],
          target: unquoteYamlValue(linkMatch[2]),
        });
      }
      continue;
    }

    if (section === 'refs') {
      const refMatch = nested.match(/^-+\s*([A-Za-z0-9_-]+):\s*(.+)$/);
      if (refMatch) {
        refs.push({
          type: refMatch[1],
          target: unquoteYamlValue(refMatch[2]),
        });
      }
    }
  }

  const frontmatter: PacketFrontmatter | null = (
    Object.keys(scalar).length > 0 || links.length > 0 || refs.length > 0
  )
    ? {
        type: scalar.type,
        sessionKey: scalar.sessionKey,
        workItemId: scalar.workItemId,
        requestedDecision: scalar.requestedDecision,
        priority: scalar.priority,
        links,
        refs,
      }
    : null;

  let bodyMarkdown = lines.slice(endIndex + 1).join('\n');
  while (bodyMarkdown.startsWith('\n')) {
    bodyMarkdown = bodyMarkdown.slice(1);
  }

  return {
    frontmatter,
    bodyMarkdown,
  };
}

function cycleList<T>(list: T[], current: T, delta = 1): T {
  const index = list.indexOf(current);
  const currentIndex = index >= 0 ? index : 0;
  const next = (currentIndex + delta + list.length) % list.length;
  return list[next];
}

function cycleIndex(length: number, current: number, delta: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return length - 1;
  if (next >= length) return 0;
  return next;
}

function shaShortMatches(candidate: string | undefined, target: string): boolean {
  if (!candidate) return false;
  const left = candidate.toLowerCase();
  const right = target.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function trustTone(tier: TrustTier): string {
  if (tier === 'proven') return 'text-[var(--success)] bg-[var(--success)]/10';
  if (tier === 'computed') return 'text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/10';
  return 'text-[var(--warning)] bg-[var(--warning)]/10';
}

function formatRelativeFromIso(iso: string): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function eventLabel(event: NormalizedSessionEvent): string {
  if (isMessageLikeEvent(event)) {
    const role = messageRoleForEvent(event);
    return role;
  }
  if (event.type === 'tool') {
    const data = event.payload.data as Record<string, unknown> | undefined;
    const tool = typeof data?.tool_name === 'string' ? data.tool_name : event.payload.eventType;
    return String(tool ?? 'tool');
  }
  return String(event.payload.eventType ?? event.type);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeMessageRole(role: unknown): 'assistant' | 'user' | 'system' | 'message' {
  const normalized = String(role ?? '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'agent') return 'assistant';
  if (normalized === 'user') return 'user';
  if (normalized === 'system') return 'system';
  return 'message';
}

function isMessageLikeEvent(event: NormalizedSessionEvent): boolean {
  if (event.type === 'message') return true;
  const eventType = String(event.payload.eventType ?? '').trim().toLowerCase();
  if (!eventType) return false;
  return eventType.includes('message') || eventType === 'send_text' || eventType === 'response';
}

function messageRoleForEvent(event: NormalizedSessionEvent): 'assistant' | 'user' | 'system' | 'message' {
  const normalizedRole = normalizeMessageRole(event.payload.role);
  if (normalizedRole !== 'message') return normalizedRole;
  const eventType = String(event.payload.eventType ?? '').trim().toLowerCase();
  if (eventType === 'send_text' || eventType === 'user_message') return 'user';
  if (eventType === 'agent_message' || eventType === 'response') return 'assistant';
  return normalizedRole;
}

function extractTextValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextValue(item))
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  const record = asRecord(value);
  if (!record) return '';
  const directText = record.text;
  if (typeof directText === 'string' && directText.trim()) return directText.trim();
  const nestedContent = record.content;
  if (nestedContent !== undefined) {
    const nested = extractTextValue(nestedContent);
    if (nested) return nested;
  }
  const message = record.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const chunk = record.chunk;
  if (typeof chunk === 'string' && chunk.trim()) return chunk.trim();
  const response = record.response;
  if (typeof response === 'string' && response.trim()) return response.trim();
  const output = record.output;
  if (typeof output === 'string' && output.trim()) return output.trim();
  return '';
}

function extractMessageContent(payload: Record<string, unknown>): string {
  const topLevelContent = extractTextValue(payload.content);
  if (topLevelContent) return topLevelContent;
  const topLevelMessage = extractTextValue(payload.message);
  if (topLevelMessage) return topLevelMessage;
  const topLevelText = extractTextValue(payload.text);
  if (topLevelText) return topLevelText;
  const topLevelResponse = extractTextValue(payload.response);
  if (topLevelResponse) return topLevelResponse;
  const data = asRecord(payload.data);
  const contentFromData = extractTextValue(data?.content);
  if (contentFromData) return contentFromData;
  const messageFromData = extractTextValue(data?.message);
  if (messageFromData) return messageFromData;
  const chunkFromData = extractTextValue(data?.chunk);
  if (chunkFromData) return chunkFromData;
  const textFromData = extractTextValue(data?.text);
  if (textFromData) return textFromData;
  const responseFromData = extractTextValue(data?.response);
  if (responseFromData) return responseFromData;
  return '';
}

function toolLabelFromName(name: string, isBrowser = false): { icon: string; label: string } {
  if (isBrowser) {
    return { icon: '\u25C9', label: `Browser ${name}` };
  }
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) {
    return { icon: '>', label: 'Bash' };
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) {
    return { icon: '\u270E', label: 'Edit' };
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return { icon: '\u2315', label: 'Search' };
  }
  return { icon: '\u2699', label: name };
}

function describeLatestToolSignal(events: NormalizedSessionEvent[]): { icon: string; label: string; detail: string } | null {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (event.type !== 'tool') continue;
    const data = asRecord(event.payload.data);
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    if (eventType.includes('memory') || eventType.includes('inject')) continue;

    const browserName = eventType.startsWith('browser_')
      ? eventType.replace('browser_', '').replace(/_/g, ' ')
      : null;
    const toolName = typeof data?.tool_name === 'string' && data.tool_name.trim()
      ? data.tool_name.trim()
      : null;
    const name = browserName ?? toolName ?? (eventType || 'tool');
    const display = toolLabelFromName(name, !!browserName);

    const status = String(data?.status ?? data?.phase ?? data?.state ?? '').trim().toLowerCase();
    const detailParts: string[] = [];
    if (status) {
      detailParts.push(status === 'started' ? 'running' : status);
    }
    if (typeof data?.duration_ms === 'number') {
      detailParts.push(`${data.duration_ms}ms`);
    }
    detailParts.push(`${formatRelativeFromIso(event.at)} ago`);

    return {
      icon: display.icon,
      label: display.label,
      detail: detailParts.join(' · '),
    };
  }
  return null;
}

function isFailureEvent(event: NormalizedSessionEvent): boolean {
  const payload = event.payload ?? {};
  const eventType = String(payload.eventType ?? '').toLowerCase();
  const data = asRecord(payload.data);

  if (event.type === 'test') {
    const verdict = String(data?.verdict ?? payload.verdict ?? '').toLowerCase();
    if (verdict === 'fail' || verdict === 'failed' || verdict === 'error') return true;
    return eventType.includes('fail') || eventType.includes('error');
  }

  if (event.type === 'tool') {
    const success = data?.success;
    if (success === false) return true;
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return true;
    return eventType.includes('error') || eventType.includes('fail');
  }

  if (event.type === 'workflow') {
    return eventType.includes('error') || eventType.includes('fail') || eventType.includes('blocked');
  }

  return false;
}

function renderInlineRefs(
  text: string,
  onRefClick: (refType: string, target: string) => void,
  isRefResolved: (refType: string, target: string) => boolean
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > index) {
      nodes.push(<span key={`txt-${index}`}>{text.slice(index, match.index)}</span>);
    }
    const refType = match[1];
    const target = match[2];
    const resolved = isRefResolved(refType, target);
    nodes.push(
      <button
        key={`ref-${match.index}-${target}`}
        onClick={() => resolved && onRefClick(refType, target)}
        disabled={!resolved}
        title={resolved ? `Open ${refType}(${target})` : `Unresolved reference ${refType}(${target})`}
        className={`underline ${
          resolved
            ? 'text-[var(--accent-cyan)] hover:text-[var(--running)]'
            : 'text-[var(--error)] decoration-wavy cursor-not-allowed opacity-80'
        }`}
      >
        @{refType}({target})
      </button>
    );
    index = match.index + match[0].length;
  }

  if (index < text.length) {
    nodes.push(<span key={`txt-end-${index}`}>{text.slice(index)}</span>);
  }

  return nodes;
}

function parseFileRefTarget(target: string): { path: string; line?: number } {
  const [pathPart, fragment] = target.split('#');
  if (!fragment) return { path: pathPart };
  const lineMatch = fragment.match(/L(\d+)/i);
  if (!lineMatch) return { path: pathPart };
  return {
    path: pathPart,
    line: Number(lineMatch[1]),
  };
}

function PacketBody({
  markdown,
  onRefClick,
  isRefResolved,
}: {
  markdown: string;
  onRefClick: (refType: string, target: string) => void;
  isRefResolved: (refType: string, target: string) => boolean;
}) {
  const lines = markdown.split('\n');
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trimEnd();
        if (!line.trim()) {
          return <div key={`empty-${idx}`} className="h-2" />;
        }
        if (line.startsWith('### ')) {
          return (
            <h3 key={idx} className="text-sm font-semibold text-[var(--text-primary)] mt-2">
              {renderInlineRefs(line.slice(4), onRefClick, isRefResolved)}
            </h3>
          );
        }
        if (line.startsWith('## ')) {
          return (
            <h2 key={idx} className="text-base font-semibold text-[var(--text-primary)] mt-2">
              {renderInlineRefs(line.slice(3), onRefClick, isRefResolved)}
            </h2>
          );
        }
        if (line.startsWith('# ')) {
          return (
            <h1 key={idx} className="text-lg font-semibold text-[var(--text-primary)] mb-1">
              {renderInlineRefs(line.slice(2), onRefClick, isRefResolved)}
            </h1>
          );
        }
        const numbered = line.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">{numbered[1]}.</span>
              <span>{renderInlineRefs(numbered[2], onRefClick, isRefResolved)}</span>
            </div>
          );
        }
        if (line.startsWith('- ')) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">-</span>
              <span>{renderInlineRefs(line.slice(2), onRefClick, isRefResolved)}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="text-[var(--text-secondary)]">
            {renderInlineRefs(line, onRefClick, isRefResolved)}
          </p>
        );
      })}
    </div>
  );
}

function TrustBadge({ tier, label }: { tier: TrustTier; label: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${trustTone(tier)}`}>
      {tier}: {label}
    </span>
  );
}

function statusColor(status: string): string {
  if (status === 'running') return 'var(--running)';
  if (status === 'blocked') return 'var(--warning)';
  if (status === 'ready') return 'var(--accent-cyan)';
  if (status === 'done') return 'var(--success)';
  return 'var(--text-muted)';
}

function SessionRow({
  row,
  selected,
  onSelect,
}: {
  row: SessionRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = statusColor(row.status);
  const isBlocked = row.blocking.unresolvedEscalationsCount > 0;
  const hasActivity = row.currentActivity.tool !== 'idle';
  const hasFile = !!row.currentActivity.file;
  const hasDiffstat = row.diffstat.added > 0 || row.diffstat.deleted > 0 || row.diffstat.filesTouched > 0;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors ${
        selected ? 'bg-[var(--bg-hover)] border-l-2' : 'border-l-2 border-l-transparent'
      }`}
      style={selected ? { borderLeftColor: color } : undefined}
    >
      {/* Title / Goal - the headline */}
      <div className="text-[13px] text-[var(--text-primary)] leading-snug line-clamp-2">{row.title}</div>

      {/* Status row: badge + elapsed + session key */}
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium"
          style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
          {isBlocked ? `blocked (${row.blocking.unresolvedEscalationsCount})` : row.status}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">{formatElapsed(row.elapsedSec)}</span>
        <span className="text-[10px] text-[var(--text-muted)] font-mono opacity-60 ml-auto">
          {row.sessionKey.slice(-8)}
        </span>
      </div>

      {/* Current activity */}
      {(hasActivity || hasFile) && (
        <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--accent-cyan)]">
          <span className="opacity-80">\u2699</span>
          <span className="truncate">{row.currentActivity.tool}</span>
          {hasFile && (
            <span className="text-[var(--text-muted)] truncate">
              {row.currentActivity.file}{typeof row.currentActivity.line === 'number' ? `:${row.currentActivity.line}` : ''}
            </span>
          )}
        </div>
      )}

      {/* What changed */}
      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--text-muted)]">
        {hasDiffstat && (
          <span className="text-[var(--success)]">
            +{row.diffstat.added}/-{row.diffstat.deleted}
          </span>
        )}
        {row.diffstat.filesTouched > 0 && (
          <span>{row.diffstat.filesTouched} files</span>
        )}
      </div>
    </button>
  );
}

function EscalationRow({
  row,
  selected,
  onSelect,
  onResolve,
  resolving,
}: {
  row: EscalationRollup;
  selected: boolean;
  onSelect: () => void;
  onResolve: () => void;
  resolving: boolean;
}) {
  return (
    <div
      className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${
        selected ? 'bg-[var(--warning)]/10 border-l-2 border-l-[var(--warning)]' : ''
      }`}
    >
      <button onClick={onSelect} className="w-full text-left hover:bg-[var(--bg-hover)] rounded px-1 py-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--warning)] uppercase">{row.requestedDecision}</span>
          <span className="text-xs text-[var(--text-primary)] truncate flex-1">{row.headline}</span>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
          {row.sessionKey.slice(0, 12)} · {Math.floor(row.ageSec / 60)}m
        </div>
      </button>
      <div className="mt-1">
        <button
          onClick={onResolve}
          disabled={resolving}
          className="px-1.5 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
        >
          {resolving ? 'Resolving...' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}

function CommitRow({
  row,
  selected,
  onSelect,
}: {
  row: CommitRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${
        selected ? 'bg-[var(--accent-cyan)]/10 border-l-2 border-l-[var(--accent-cyan)]' : ''
      }`}
    >
      <div className="font-mono text-[11px] text-[var(--text-secondary)]">{row.sha.slice(0, 8)}</div>
      <div className="text-xs text-[var(--text-primary)] truncate">{row.message}</div>
      <div className="text-[10px] text-[var(--text-muted)]">
        {row.author} · +{row.diffstat.added}/-{row.diffstat.deleted}
      </div>
    </button>
  );
}

function PRRow({
  row,
  selected,
  onSelect,
}: {
  row: PRRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${
        selected ? 'bg-[var(--running)]/10 border-l-2 border-l-[var(--running)]' : ''
      }`}
    >
      <div className="text-[11px] text-[var(--text-muted)]">#{row.number} · {row.status}</div>
      <div className="text-xs text-[var(--text-primary)] truncate">{row.title}</div>
      <div className="text-[10px] text-[var(--text-muted)]">{row.author}</div>
    </button>
  );
}

function selectDefaultTarget(
  escalations: EscalationRollup[],
  running: SessionRollup[],
  ready: SessionRollup[],
  done: SessionRollup[]
): FocusTarget | null {
  if (escalations.length > 0) return { type: 'escalation', id: escalations[0].escalationId };
  if (running.length > 0) return { type: 'session', id: running[0].sessionKey };
  if (ready.length > 0) return { type: 'session', id: ready[0].sessionKey };
  if (done.length > 0) return { type: 'session', id: done[0].sessionKey };
  return null;
}

export default function App() {
  const [runningSessions, setRunningSessions] = useState<SessionRollup[]>([]);
  const [readySessions, setReadySessions] = useState<SessionRollup[]>([]);
  const [doneSessions, setDoneSessions] = useState<SessionRollup[]>([]);
  const [escalations, setEscalations] = useState<EscalationRollup[]>([]);
  const [commitRollups, setCommitRollups] = useState<CommitRollup[]>([]);
  const [prRollups, setPrRollups] = useState<PRRollup[]>([]);
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [focus, setFocus] = useState<FocusData | null>(null);
  const [events, setEvents] = useState<NormalizedSessionEvent[]>([]);
  const [focusTab, setFocusTab] = useState<FocusTab>('packet');
  const [diffData, setDiffData] = useState<CockpitDiff | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [testReports, setTestReports] = useState<CockpitTestReport[]>([]);
  const [selectedTestReportId, setSelectedTestReportId] = useState<string | null>(null);
  const [selectedTestReport, setSelectedTestReport] = useState<CockpitTestReport | null>(null);
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [patchDraft, setPatchDraft] = useState('');
  const [patchApplyStatus, setPatchApplyStatus] = useState<string | null>(null);
  const [applyingPatch, setApplyingPatch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [resolvingEscalationId, setResolvingEscalationId] = useState<string | null>(null);
  const [reviewDecisionAction, setReviewDecisionAction] = useState<'accept' | 'request_changes' | null>(null);
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [lensQuery, setLensQuery] = useState('');
  const [lensResults, setLensResults] = useState<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }>({
    defs: [],
    refs: [],
    text: [],
  });
  const [lensLoading, setLensLoading] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [browserState, setBrowserState] = useState<CockpitBrowserState | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserActionStatus, setBrowserActionStatus] = useState<string | null>(null);
  const [browserUrlDraft, setBrowserUrlDraft] = useState('');
  const [browserActionType, setBrowserActionType] = useState<'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll'>('click');
  const [browserTargetDraft, setBrowserTargetDraft] = useState('');
  const [browserValueDraft, setBrowserValueDraft] = useState('');
  const [browserDirectionDraft, setBrowserDirectionDraft] = useState<'up' | 'down' | 'left' | 'right'>('down');
  const [browserSnapshotInteractive, setBrowserSnapshotInteractive] = useState(true);
  const [browserSnapshotCompact, setBrowserSnapshotCompact] = useState(true);
  const [browserRunbook, setBrowserRunbook] = useState(DEFAULT_BROWSER_RUNBOOK);
  const [browserRunningRunbook, setBrowserRunningRunbook] = useState(false);
  const [panelFocus, setPanelFocus] = useState<PanelFocus>('left');
  const [leftSection, setLeftSection] = useState<LeftSection>('running');
  const [rightSection, setRightSection] = useState<RightSection>('queue');
  const [leftSelection, setLeftSelection] = useState<{ running: number; ready: number; done: number }>({
    running: 0,
    ready: 0,
    done: 0,
  });
  const [rightSelection, setRightSelection] = useState<{ queue: number; commits: number; prs: number }>({
    queue: 0,
    commits: 0,
    prs: 0,
  });
  const [pendingCommitRange, setPendingCommitRange] = useState<{
    sessionKey: string;
    base?: string;
    head?: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshRollups = useCallback(async () => {
    const [running, blocked, ready, done, escalationRows, commits, prs, dailyMetrics] = await Promise.all([
      getCockpitSessionRollups('running', 120),
      getCockpitSessionRollups('blocked', 120),
      getCockpitSessionRollups('ready', 120),
      getCockpitSessionRollups('done', 120),
      getCockpitEscalationRollups(120),
      getCockpitCommitRollups(50),
      getCockpitPRRollups('open', 50),
      getCockpitDailyMetrics(),
    ]);

    // Blocked sessions appear in the RUNNING section (spec §3.1) but are distinguishable
    // by their status field and blocking.unresolvedEscalationsCount > 0
    setRunningSessions([...blocked, ...running]);
    setReadySessions(ready);
    setDoneSessions(done);
    setEscalations(escalationRows);
    setCommitRollups(commits);
    setPrRollups(prs);
    setMetrics(dailyMetrics);

    setFocusTarget((current) => {
      const fallback = selectDefaultTarget(escalationRows, running, ready, done);
      if (!current) return fallback;
      if (current.type === 'escalation') {
        const exists = escalationRows.some((row) => row.escalationId === current.id);
        return exists ? current : fallback;
      }
      const sessionExists = [...running, ...ready, ...done].some((row) => row.sessionKey === current.id);
      return sessionExists ? current : fallback;
    });
  }, []);

  const refreshFocus = useCallback(async (target: FocusTarget | null) => {
    if (!target) {
      setFocus(null);
      setEvents([]);
      setDiffData(null);
      setSelectedDiffFile(null);
      setTestReports([]);
      setSelectedTestReport(null);
      setSelectedTestReportId(null);
      setTraces([]);
      setPatchDraft('');
      setPatchApplyStatus(null);
      setLensResults({ defs: [], refs: [], text: [] });
      setPreviewVisible(false);
      setPreviewUrl(null);
      setBrowserState(null);
      setBrowserActionStatus(null);
      return;
    }

    const focusData = await getCockpitFocus(target.type, target.id);
    if (!focusData) {
      setFocus(null);
      setEvents([]);
      setDiffData(null);
      setSelectedDiffFile(null);
      setTestReports([]);
      setSelectedTestReport(null);
      setSelectedTestReportId(null);
      setTraces([]);
      setPatchDraft('');
      setPatchApplyStatus(null);
      setLensResults({ defs: [], refs: [], text: [] });
      setPreviewVisible(false);
      setPreviewUrl(null);
      setBrowserState(null);
      setBrowserActionStatus(null);
      return;
    }

    setFocus(focusData);
    const [eventResponse, traceRows, reportRows, diffResponse] = await Promise.all([
      getCockpitSessionEvents(focusData.sessionKey, { limit: 200 }),
      getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => []),
      getCockpitTestReports({ sessionKey: focusData.sessionKey, limit: 20 }).catch(() => []),
      getCockpitDiff({ sessionKey: focusData.sessionKey }).catch(() => null),
    ]);
    setEvents(eventResponse.events);
    setTraces(traceRows);
    setTestReports(reportRows);
    setSelectedTestReportId((current) =>
      current && reportRows.some((item) => item.id === current)
        ? current
        : reportRows[0]?.id ?? null
    );
    setSelectedTestReport((current) => {
      if (current && reportRows.some((item) => item.id === current.id)) {
        return current;
      }
      return reportRows[0] ?? null;
    });
    setDiffData(diffResponse);
    setSelectedDiffFile(diffResponse?.hotspots?.[0]?.path ?? null);
    setPatchApplyStatus(null);
    setLensResults({ defs: [], refs: [], text: [] });
    setBrowserActionStatus(null);
    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
      ? focusData.header.previewUrl
      : '';
    setBrowserUrlDraft((current) => current || focusPreviewUrl);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await refreshRollups();
      setError(null);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshRollups]);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => {
      void refreshAll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    void refreshFocus(focusTarget);
  }, [focusTarget, lastUpdate, refreshFocus]);

  const refreshBrowserState = useCallback(async (sessionKey: string | null | undefined) => {
    if (!sessionKey) {
      setBrowserState(null);
      return;
    }
    setBrowserLoading(true);
    try {
      const state = await getCockpitBrowserState(sessionKey);
      setBrowserState(state);
      if (state?.currentUrl) {
        setBrowserUrlDraft((current) => current || state.currentUrl || '');
      }
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  useEffect(() => {
    if (focusTab !== 'browser') return;
    void refreshBrowserState(focus?.sessionKey);
  }, [focus?.sessionKey, focusTab, lastUpdate, refreshBrowserState]);

  const focusEscalationId = useMemo(() => {
    if (focus?.type === 'escalation') return focus.id;
    return null;
  }, [focus]);

  const focusStatus = typeof focus?.header?.status === 'string'
    ? focus.header.status
    : null;

  const focusRollup = useMemo(() => {
    const sessionKey = focus?.sessionKey;
    if (!sessionKey) return null;
    return [...runningSessions, ...readySessions, ...doneSessions].find((row) => row.sessionKey === sessionKey) ?? null;
  }, [focus?.sessionKey, runningSessions, readySessions, doneSessions]);

  const toolSignal = useMemo(() => describeLatestToolSignal(events), [events]);

  const recentAssistantMessage = useMemo(() => {
    for (let idx = events.length - 1; idx >= 0; idx -= 1) {
      const event = events[idx];
      if (!isMessageLikeEvent(event)) continue;
      const role = messageRoleForEvent(event);
      if (role !== 'assistant') continue;
      const content = extractMessageContent(event.payload);
      if (!content) continue;
      return content;
    }
    return null;
  }, [events]);

  const focusDiffSummary = useMemo(() => {
    const summary = diffData?.summary;
    if (summary) return summary;
    return focusRollup?.diffstat ?? null;
  }, [diffData?.summary, focusRollup?.diffstat]);

  const filteredEvents = useMemo(() => {
    // Signal filter: show only high/medium priority events (substantial content, packets, failures)
    if (eventFilter === 'signal') {
      return events.filter((event) => {
        // Use server-provided priority if available
        const priority = event.signalPriority;
        if (priority) return priority === 'high' || priority === 'medium';
        // Fallback to client-side detection for events without priority
        if (event.type === 'packet') return true;
        if (isMessageLikeEvent(event)) {
          const role = messageRoleForEvent(event);
          const content = extractMessageContent(event.payload);
          if (role === 'assistant' && content.length > 50) return true;
          if (role === 'user') return true;
        }
        return isFailureEvent(event);
      });
    }
    
    // Audit filter: show all tool calls, memory injections, and status-only events
    if (eventFilter === 'audit') {
      return events.filter((event) => {
        // Use server-provided isStatusOnly if available
        if (event.isStatusOnly) return true;
        // Fallback to client-side detection
        if (event.type === 'tool') {
          const eventType = String(event.payload.eventType ?? '').toLowerCase();
          if (eventType.includes('memory') || eventType.includes('inject')) return true;
          if (eventType.startsWith('browser_')) return true;
          return true; // All tools in audit view
        }
        return false;
      });
    }
    
    if (eventFilter === 'messages') return events.filter((event) => isMessageLikeEvent(event));
    if (eventFilter === 'tools') return events.filter((event) => event.type === 'tool');
    if (eventFilter === 'failures') return events.filter((event) => isFailureEvent(event));
    if (eventFilter === 'all') {
      return events.filter((event) => event.type !== 'tool' || isFailureEvent(event));
    }
    return events;
  }, [events, eventFilter]);

  const allSessionKeys = useMemo(
    () => new Set([...runningSessions, ...readySessions, ...doneSessions].map((row) => row.sessionKey)),
    [runningSessions, readySessions, doneSessions]
  );

  const diffHotspotPaths = useMemo(
    () => new Set((diffData?.hotspots ?? []).map((hotspot) => hotspot.path)),
    [diffData]
  );

  const traceFilePaths = useMemo(() => {
    const set = new Set<string>();
    for (const trace of traces) {
      for (const file of trace.files ?? []) {
        if (file.path) set.add(file.path);
      }
    }
    return set;
  }, [traces]);

  const traceRevisions = useMemo(() => {
    const set = new Set<string>();
    for (const trace of traces) {
      const revision = trace.vcs?.revision;
      if (revision) set.add(revision);
    }
    return set;
  }, [traces]);

  const resolvePacketRef = useCallback((refTypeRaw: string, targetRaw: string): boolean => {
    const refType = refTypeRaw.trim().toLowerCase();
    const target = targetRaw.trim();
    if (!refType || !target) return false;

    if (refType === 'commit') {
      if (shaShortMatches(diffData?.headSha, target) || shaShortMatches(diffData?.baseSha, target)) return true;
      return commitRollups.some((row) => shaShortMatches(row.sha, target))
        || Array.from(traceRevisions).some((revision) => shaShortMatches(revision, target));
    }

    if (refType === 'file') {
      const parsed = parseFileRefTarget(target);
      return diffHotspotPaths.has(parsed.path) || traceFilePaths.has(parsed.path);
    }

    if (refType === 'testreport') {
      return testReports.some((report) => report.id === target);
    }

    if (refType === 'trace') {
      return traces.some((trace) => trace.id === target || shaShortMatches(trace.vcs?.revision, target));
    }

    if (refType === 'workitem') {
      if (typeof focus?.header?.activeWorkItemId === 'string' && focus.header.activeWorkItemId === target) return true;
      return events.some((event) => String(event.payload.workItemId ?? '') === target);
    }

    if (refType === 'session') {
      return (focus?.sessionKey === target) || allSessionKeys.has(target);
    }

    if (refType === 'pr') {
      const parsedNumber = Number(target.replace(/^#/, '').trim());
      return prRollups.some((row) =>
        row.prId === target
        || row.url.includes(target)
        || (Number.isFinite(parsedNumber) && row.number === parsedNumber)
      );
    }

    return false;
  }, [
    allSessionKeys,
    commitRollups,
    diffData?.baseSha,
    diffData?.headSha,
    diffHotspotPaths,
    events,
    focus?.header?.activeWorkItemId,
    focus?.sessionKey,
    prRollups,
    testReports,
    traceFilePaths,
    traces,
    traceRevisions,
  ]);

  const parsedPacket = useMemo(
    () => parsePacketMarkdown(focus?.packet?.contentMarkdown ?? ''),
    [focus?.packet?.contentMarkdown]
  );

  const packetEvidence = useMemo(() => {
    if (!parsedPacket.bodyMarkdown && !parsedPacket.frontmatter) {
      return {
        summaryBullets: 0,
        evidenceBackedBullets: 0,
        totalRefs: 0,
        resolvedRefs: 0,
        brokenRefs: [] as string[],
      };
    }

    const lines = parsedPacket.bodyMarkdown.split('\n');
    let summaryBullets = 0;
    let evidenceBackedBullets = 0;
    let totalRefs = 0;
    let resolvedRefs = 0;
    const brokenRefs = new Set<string>();

    for (const ref of parsedPacket.frontmatter?.refs ?? []) {
      totalRefs += 1;
      const resolved = resolvePacketRef(ref.type, ref.target);
      if (resolved) {
        resolvedRefs += 1;
      } else {
        brokenRefs.add(`@${ref.type}(${ref.target})`);
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const refs: Array<{ type: string; target: string; resolved: boolean }> = [];
      const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const type = match[1];
        const target = match[2];
        const resolved = resolvePacketRef(type, target);
        refs.push({ type, target, resolved });
      }
      totalRefs += refs.length;
      for (const ref of refs) {
        if (ref.resolved) {
          resolvedRefs += 1;
        } else {
          brokenRefs.add(`@${ref.type}(${ref.target})`);
        }
      }

      const isSummaryBullet = line.startsWith('- ') || /^\d+\.\s+/.test(line);
      if (!isSummaryBullet) continue;
      summaryBullets += 1;
      if (refs.some((ref) => ref.resolved)) {
        evidenceBackedBullets += 1;
      }
    }

    return {
      summaryBullets,
      evidenceBackedBullets,
      totalRefs,
      resolvedRefs,
      brokenRefs: Array.from(brokenRefs),
    };
  }, [parsedPacket.bodyMarkdown, parsedPacket.frontmatter, resolvePacketRef]);

  useEffect(() => {
    if (!selectedTestReportId) return;
    const existing = testReports.find((item) => item.id === selectedTestReportId);
    if (existing) {
      setSelectedTestReport(existing);
      return;
    }
    void getCockpitTestReport(selectedTestReportId).then((report) => {
      if (report) setSelectedTestReport(report);
    });
  }, [selectedTestReportId, testReports]);

  useEffect(() => {
    setLeftSelection((current) => ({
      running: runningSessions.length > 0 ? Math.min(current.running, runningSessions.length - 1) : 0,
      ready: readySessions.length > 0 ? Math.min(current.ready, readySessions.length - 1) : 0,
      done: doneSessions.length > 0 ? Math.min(current.done, doneSessions.length - 1) : 0,
    }));
  }, [runningSessions, readySessions, doneSessions]);

  useEffect(() => {
    setRightSelection((current) => ({
      queue: escalations.length > 0 ? Math.min(current.queue, escalations.length - 1) : 0,
      commits: commitRollups.length > 0 ? Math.min(current.commits, commitRollups.length - 1) : 0,
      prs: prRollups.length > 0 ? Math.min(current.prs, prRollups.length - 1) : 0,
    }));
  }, [escalations, commitRollups, prRollups]);

  useEffect(() => {
    if (!pendingCommitRange || !focus?.sessionKey) return;
    if (pendingCommitRange.sessionKey !== focus.sessionKey) return;
    void getCockpitDiff({
      sessionKey: focus.sessionKey,
      ...(pendingCommitRange.base ? { base: pendingCommitRange.base } : {}),
      ...(pendingCommitRange.head ? { head: pendingCommitRange.head } : {}),
    }).then((response) => {
      setDiffData(response);
      setSelectedDiffFile(response.hotspots[0]?.path ?? null);
      setFocusTab('diff');
    }).catch(() => {}).finally(() => setPendingCommitRange(null));
  }, [focus?.sessionKey, pendingCommitRange]);

  const handlePacketRefClick = useCallback(async (refType: string, target: string) => {
    setSelectedRef(`@${refType}(${target})`);
    if (!focus?.sessionKey) return;
    const type = refType.toLowerCase();

    if (type === 'commit') {
      setFocusTab('diff');
      const response = await getCockpitDiff({ sessionKey: focus.sessionKey, head: target }).catch(() => null);
      if (response) {
        setDiffData(response);
        setSelectedDiffFile(response.hotspots[0]?.path ?? null);
      }
      return;
    }

    if (type === 'file') {
      const parsed = parseFileRefTarget(target);
      setFocusTab('diff');
      setSelectedDiffFile(parsed.path);
      const response = await getCockpitDiff({
        sessionKey: focus.sessionKey,
        file: parsed.path,
      }).catch(() => null);
      if (response) {
        setDiffData(response);
      }
      return;
    }

    if (type === 'testreport') {
      setFocusTab('tests');
      setSelectedTestReportId(target);
      return;
    }

    if (type === 'trace') {
      setFocusTab('trace');
    }
  }, [focus?.sessionKey]);

  const handlePacketLinkClick = useCallback(async (target: string) => {
    if (!target) return;
    let parsed: URL;
    try {
      parsed = new URL(target, window.location.origin);
    } catch {
      return;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes('/diff')) {
      setFocusTab('diff');
      if (focus?.sessionKey) {
        const response = await getCockpitDiff({
          sessionKey: focus.sessionKey,
          ...(parsed.searchParams.get('base') ? { base: String(parsed.searchParams.get('base')) } : {}),
          ...(parsed.searchParams.get('head') ? { head: String(parsed.searchParams.get('head')) } : {}),
        }).catch(() => null);
        if (response) {
          setDiffData(response);
          setSelectedDiffFile(response.hotspots[0]?.path ?? null);
        }
      }
      return;
    }
    if (pathname.includes('/tests')) {
      setFocusTab('tests');
      const reportId = parsed.searchParams.get('id');
      if (reportId) {
        setSelectedTestReportId(reportId);
      }
      return;
    }
    if (pathname.includes('/trace')) {
      setFocusTab('trace');
      return;
    }
    if (pathname.includes('/preview')) {
      setPreviewVisible(true);
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    }
  }, [focus?.sessionKey]);

  const handleApplyPatch = useCallback(async () => {
    if (!focus?.sessionKey || !patchDraft.trim()) return;
    setApplyingPatch(true);
    setPatchApplyStatus(null);
    try {
      const response = await applyCockpitPatch({
        sessionKey: focus.sessionKey,
        patch: patchDraft,
        ...(diffData?.baseSha ? { baseSha: diffData.baseSha } : {}),
      });
      if (response.success) {
        setPatchApplyStatus(
          `Applied ${response.mode ?? 'patch'}: ${response.files?.length ?? 0} files, ${response.changedLines ?? 0} lines`
        );
        setPatchDraft('');
        await refreshFocus(focusTarget);
        await refreshAll();
      } else {
        setPatchApplyStatus('Patch apply failed');
      }
    } catch (err) {
      setPatchApplyStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingPatch(false);
    }
  }, [focus?.sessionKey, patchDraft, diffData?.baseSha, refreshAll, refreshFocus, focusTarget]);

  const handleResolveEscalation = useCallback(async (escalationId: string) => {
    const freeformResponse = window.prompt('Resolution note (optional):');
    if (freeformResponse === null) return;

    setResolvingEscalationId(escalationId);
    try {
      await resolveCockpitEscalation(escalationId, {
        freeformResponse: freeformResponse.trim() || undefined,
      });
      setFocusTarget(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingEscalationId(null);
    }
  }, [refreshAll]);

  const handleReviewDecision = useCallback(async (decision: 'accept' | 'request_changes') => {
    if (!focus?.sessionKey) return;
    const note = window.prompt(
      decision === 'accept'
        ? 'Optional acceptance note:'
        : 'Optional request-changes note:'
    );
    if (note === null) return;

    setReviewDecisionAction(decision);
    try {
      await postCockpitSessionReviewDecision(focus.sessionKey, {
        decision,
        note: note.trim() || undefined,
      });
      await refreshAll();
      await refreshFocus(focusTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewDecisionAction(null);
    }
  }, [focus?.sessionKey, refreshAll, refreshFocus, focusTarget]);

  const handleSendMessage = useCallback(async () => {
    if (!focus?.sessionKey || !messageDraft.trim()) return;
    setSendingMessage(true);
    try {
      await postCockpitSessionMessage(focus.sessionKey, messageDraft.trim());
      setMessageDraft('');
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingMessage(false);
    }
  }, [focus?.sessionKey, messageDraft, refreshAll, refreshFocus, focusTarget]);

  const handleRunLensSearch = useCallback(async () => {
    if (!focus?.sessionKey || !lensQuery.trim()) return;
    setLensLoading(true);
    try {
      const results = await searchCockpitRepoLens({
        sessionKey: focus.sessionKey,
        q: lensQuery.trim(),
        kind: 'all',
        limit: 120,
      });
      setLensResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLensLoading(false);
    }
  }, [focus?.sessionKey, lensQuery]);

  const handleTogglePreview = useCallback(async () => {
    if (previewVisible) {
      setPreviewVisible(false);
      return;
    }
    if (!focus?.sessionKey) return;
    setPreviewLoading(true);
    try {
      const preview = await getCockpitPreview({ sessionKey: focus.sessionKey });
      if (!preview?.url) {
        setError('No preview URL available for this session.');
        return;
      }
      setPreviewUrl(preview.url);
      setPreviewVisible(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [focus?.sessionKey, previewVisible]);

  const handleBrowserAction = useCallback(async (input: Omit<CockpitBrowserActionInput, 'sessionKey'>) => {
    if (!focus?.sessionKey) return;
    setBrowserLoading(true);
    setBrowserActionStatus(null);
    try {
      const response = await postCockpitBrowserAction({
        sessionKey: focus.sessionKey,
        ...input,
      });
      if (!response.success) {
        setBrowserActionStatus(response.error ?? 'Browser action failed');
        return;
      }
      const actionLabel = response.action ?? input.action;
      const outputSummary = response.artifactPath
        ? `${actionLabel} ok · ${response.artifactPath}`
        : `${actionLabel} ok`;
      setBrowserActionStatus(outputSummary);
      if (response.currentUrl) {
        setBrowserUrlDraft(response.currentUrl);
        setPreviewUrl(response.currentUrl);
      }
      await refreshBrowserState(focus.sessionKey);
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserLoading(false);
    }
  }, [focus?.sessionKey, refreshAll, refreshBrowserState, refreshFocus, focusTarget]);

  const handleRunBrowserAction = useCallback(async () => {
    if (!focus?.sessionKey) return;
    if (browserActionType === 'click') {
      if (!browserTargetDraft.trim()) {
        setBrowserActionStatus('click requires a target (for example @e1)');
        return;
      }
      await handleBrowserAction({ action: 'click', target: browserTargetDraft.trim() });
      return;
    }
    if (browserActionType === 'fill') {
      if (!browserTargetDraft.trim() || !browserValueDraft.trim()) {
        setBrowserActionStatus('fill requires target + text');
        return;
      }
      await handleBrowserAction({
        action: 'fill',
        target: browserTargetDraft.trim(),
        text: browserValueDraft,
      });
      return;
    }
    if (browserActionType === 'type') {
      if (!browserTargetDraft.trim() || !browserValueDraft.trim()) {
        setBrowserActionStatus('type requires target + text');
        return;
      }
      await handleBrowserAction({
        action: 'type',
        target: browserTargetDraft.trim(),
        text: browserValueDraft,
      });
      return;
    }
    if (browserActionType === 'press') {
      if (!browserValueDraft.trim()) {
        setBrowserActionStatus('press requires a key (for example Enter)');
        return;
      }
      await handleBrowserAction({ action: 'press', text: browserValueDraft.trim() });
      return;
    }
    if (browserActionType === 'wait') {
      const ms = Number(browserValueDraft.trim());
      if (Number.isFinite(ms) && ms > 0) {
        await handleBrowserAction({ action: 'wait', waitMs: Math.floor(ms) });
      } else if (browserTargetDraft.trim()) {
        await handleBrowserAction({ action: 'wait', target: browserTargetDraft.trim() });
      } else {
        setBrowserActionStatus('wait requires milliseconds or a selector');
      }
      return;
    }
    if (browserActionType === 'scroll') {
      const px = Number(browserValueDraft.trim());
      await handleBrowserAction({
        action: 'scroll',
        direction: browserDirectionDraft,
        ...(Number.isFinite(px) ? { pixels: Math.floor(px) } : {}),
      });
    }
  }, [
    focus?.sessionKey,
    browserActionType,
    browserDirectionDraft,
    browserTargetDraft,
    browserValueDraft,
    handleBrowserAction,
  ]);

  const handleRunBrowserRunbook = useCallback(async () => {
    if (!focus?.sessionKey || !browserRunbook.trim()) return;
    setBrowserRunningRunbook(true);
    setBrowserActionStatus(null);
    try {
      const result = await postCockpitBrowserRunbook({
        sessionKey: focus.sessionKey,
        script: browserRunbook,
        stopOnError: true,
      });
      const steps = result.steps ?? [];
      const failed = steps.filter((step) => step.success === false).length;
      setBrowserActionStatus(
        failed > 0
          ? `Runbook finished with ${failed} failed step(s)`
          : `Runbook completed (${steps.length} step${steps.length === 1 ? '' : 's'})`
      );
      if (result.currentUrl) {
        setBrowserUrlDraft(result.currentUrl);
        setPreviewUrl(result.currentUrl);
      }
      await refreshBrowserState(focus.sessionKey);
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserRunningRunbook(false);
    }
  }, [focus?.sessionKey, browserRunbook, refreshAll, refreshBrowserState, refreshFocus, focusTarget]);

  const handleSelectCommit = useCallback((row: CommitRollup, index: number) => {
    setRightSelection((current) => ({ ...current, commits: index }));
    if (!row.sessionKey) return;
    setFocusTarget({ type: 'session', id: row.sessionKey });
    setPendingCommitRange({
      sessionKey: row.sessionKey,
      ...(row.baseSha ? { base: row.baseSha } : {}),
      ...(row.headSha ? { head: row.headSha } : {}),
    });
  }, []);

  const handleSelectPR = useCallback((row: PRRollup, index: number) => {
    setRightSelection((current) => ({ ...current, prs: index }));
    if (row.sessionKey) {
      setFocusTarget({ type: 'session', id: row.sessionKey });
    }
    window.open(row.url, '_blank', 'noopener,noreferrer');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target.isContentEditable
      );

      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        void handleSendMessage();
        return;
      }

      if (event.key === 'Escape') {
        setPanelFocus('input');
        inputRef.current?.focus();
        return;
      }

      if (isTypingTarget || event.metaKey || event.altKey) return;

      if (event.key === '1') {
        setPanelFocus('left');
        return;
      }
      if (event.key === '2') {
        setPanelFocus('center');
        return;
      }
      if (event.key === '3') {
        setPanelFocus('right');
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        if (panelFocus === 'left') {
          setLeftSection((current) => cycleList(LEFT_SECTIONS, current));
          return;
        }
        if (panelFocus === 'right') {
          setRightSection((current) => cycleList(RIGHT_SECTIONS, current));
          return;
        }
        if (panelFocus === 'center') {
          setFocusTab((current) => cycleList(CENTER_TABS, current));
          return;
        }
        setPanelFocus('left');
        return;
      }

      const alpha = event.key.length === 1 && /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : null;
      if (alpha && panelFocus === 'left') {
        const rows = leftSection === 'running'
          ? runningSessions
          : leftSection === 'ready'
            ? readySessions
            : leftSection === 'done'
              ? doneSessions
              : [];
        const matchIndex = rows.findIndex((row) => row.title.trim().toLowerCase().startsWith(alpha));
        if (matchIndex >= 0) {
          if (leftSection === 'running') {
            setLeftSelection((current) => ({ ...current, running: matchIndex }));
          } else if (leftSection === 'ready') {
            setLeftSelection((current) => ({ ...current, ready: matchIndex }));
          } else if (leftSection === 'done') {
            setLeftSelection((current) => ({ ...current, done: matchIndex }));
          }
        }
        return;
      }
      if (alpha && panelFocus === 'right') {
        if (rightSection === 'queue') {
          const matchIndex = escalations.findIndex((row) => row.headline.trim().toLowerCase().startsWith(alpha));
          if (matchIndex >= 0) setRightSelection((current) => ({ ...current, queue: matchIndex }));
          return;
        }
        if (rightSection === 'commits') {
          const matchIndex = commitRollups.findIndex((row) => row.message.trim().toLowerCase().startsWith(alpha));
          if (matchIndex >= 0) setRightSelection((current) => ({ ...current, commits: matchIndex }));
          return;
        }
        if (rightSection === 'prs') {
          const matchIndex = prRollups.findIndex((row) => row.title.trim().toLowerCase().startsWith(alpha));
          if (matchIndex >= 0) setRightSelection((current) => ({ ...current, prs: matchIndex }));
          return;
        }
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        if (panelFocus === 'left') {
          event.preventDefault();
          if (leftSection === 'running') {
            setLeftSelection((current) => ({
              ...current,
              running: cycleIndex(runningSessions.length, current.running, delta),
            }));
            return;
          }
          if (leftSection === 'ready') {
            setLeftSelection((current) => ({
              ...current,
              ready: cycleIndex(readySessions.length, current.ready, delta),
            }));
            return;
          }
          if (leftSection === 'done') {
            setLeftSelection((current) => ({
              ...current,
              done: cycleIndex(doneSessions.length, current.done, delta),
            }));
            return;
          }
        }
        if (panelFocus === 'right') {
          event.preventDefault();
          if (rightSection === 'queue') {
            setRightSelection((current) => ({
              ...current,
              queue: cycleIndex(escalations.length, current.queue, delta),
            }));
            return;
          }
          if (rightSection === 'commits') {
            setRightSelection((current) => ({
              ...current,
              commits: cycleIndex(commitRollups.length, current.commits, delta),
            }));
            return;
          }
          if (rightSection === 'prs') {
            setRightSelection((current) => ({
              ...current,
              prs: cycleIndex(prRollups.length, current.prs, delta),
            }));
            return;
          }
        }
      }

      if (event.key === 'Enter') {
        if (panelFocus === 'left') {
          event.preventDefault();
          if (leftSection === 'running' && runningSessions[leftSelection.running]) {
            setFocusTarget({ type: 'session', id: runningSessions[leftSelection.running].sessionKey });
            return;
          }
          if (leftSection === 'ready' && readySessions[leftSelection.ready]) {
            setFocusTarget({ type: 'session', id: readySessions[leftSelection.ready].sessionKey });
            return;
          }
          if (leftSection === 'done' && doneSessions[leftSelection.done]) {
            setFocusTarget({ type: 'session', id: doneSessions[leftSelection.done].sessionKey });
            return;
          }
        }
        if (panelFocus === 'right') {
          event.preventDefault();
          if (rightSection === 'queue' && escalations[rightSelection.queue]) {
            setFocusTarget({ type: 'escalation', id: escalations[rightSelection.queue].escalationId });
            return;
          }
          if (rightSection === 'commits' && commitRollups[rightSelection.commits]) {
            handleSelectCommit(commitRollups[rightSelection.commits], rightSelection.commits);
            return;
          }
          if (rightSection === 'prs' && prRollups[rightSelection.prs]) {
            handleSelectPR(prRollups[rightSelection.prs], rightSelection.prs);
            return;
          }
        }
      }

      if (event.key === 'd' || event.key === 'D') setFocusTab('diff');
      if (event.key === 't' || event.key === 'T') setFocusTab('tests');
      if (event.key === 'l' || event.key === 'L') setFocusTab('trace');
      if (event.key === 'm' || event.key === 'M') setFocusTab('packet');
      if (event.key === 'q' || event.key === 'Q') setFocusTab('lens');
      if (event.key === 'b' || event.key === 'B') setFocusTab('browser');
      if ((event.key === 'r' || event.key === 'R') && focusEscalationId) {
        void handleResolveEscalation(focusEscalationId);
      }
      if ((event.key === 'a' || event.key === 'A') && focusStatus === 'ready') {
        void handleReviewDecision('accept');
      }
      if ((event.key === 'c' || event.key === 'C') && focusStatus === 'ready') {
        void handleReviewDecision('request_changes');
      }
      if (event.key === 'p' || event.key === 'P') {
        const selectedPr = prRollups[rightSelection.prs] ?? prRollups[0];
        if (selectedPr) handleSelectPR(selectedPr, rightSelection.prs);
      }
      if (event.key === 'v' || event.key === 'V') {
        void handleTogglePreview();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    panelFocus,
    leftSection,
    rightSection,
    runningSessions,
    readySessions,
    doneSessions,
    escalations,
    commitRollups,
    prRollups,
    leftSelection,
    rightSelection,
    focusEscalationId,
    focusStatus,
    handleResolveEscalation,
    handleReviewDecision,
    handleSelectCommit,
    handleSelectPR,
    handleSendMessage,
    handleTogglePreview,
  ]);

  const lastEditedLineByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const trace of traces) {
      for (const file of trace.files ?? []) {
        if (!file.path) continue;
        const lines = (file.conversations ?? [])
          .flatMap((conversation) => conversation.ranges ?? [])
          .map((range) => range.end_line)
          .filter((value): value is number => typeof value === 'number');
        const line = lines.length > 0 ? lines[lines.length - 1] : undefined;
        if (typeof line === 'number') {
          map.set(file.path, line);
        }
      }
    }
    return map;
  }, [traces]);

  const traceDerivedDiffstat = useMemo(() => {
    const files = new Set<string>();
    let lineTouches = 0;
    for (const trace of traces) {
      for (const file of trace.files ?? []) {
        if (!file.path) continue;
        files.add(file.path);
        for (const conversation of file.conversations ?? []) {
          for (const range of conversation.ranges ?? []) {
            const span = Math.max(0, (range.end_line ?? 0) - (range.start_line ?? 0) + 1);
            lineTouches += span;
          }
        }
      }
    }
    return {
      filesTouched: files.size,
      lineTouches,
    };
  }, [traces]);

  const diffDrift = useMemo(() => {
    if (!diffData) return null;
    if (traceDerivedDiffstat.filesTouched <= 0) return null;
    const fileDrift = diffData.summary.filesTouched !== traceDerivedDiffstat.filesTouched;
    if (!fileDrift) return null;
    return {
      gitFiles: diffData.summary.filesTouched,
      traceFiles: traceDerivedDiffstat.filesTouched,
    };
  }, [diffData, traceDerivedDiffstat]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="h-9 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[var(--text-primary)] font-semibold">Cockpit</span>
          <span className="text-xs text-[var(--text-muted)]">
            Running {runningSessions.length} · Ready {readySessions.length} · Done {doneSessions.length}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          <span>Updated {lastUpdate.toLocaleTimeString()}</span>
          <button onClick={() => void refreshAll()} className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]">
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[24rem_minmax(0,1fr)_22rem] gap-2 p-2 overflow-hidden">
        <section
          onClick={() => setPanelFocus('left')}
          className={`min-h-0 border border-[var(--border-subtle)] rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col ${
            panelFocus === 'left' ? 'ring-1 ring-[var(--accent-cyan)]' : ''
          }`}
        >
          <div className="px-2 py-1 text-xs text-[var(--text-muted)] border-b border-[var(--border-subtle)] flex items-center justify-between">
            <span>Sessions ({runningSessions.length + readySessions.length + doneSessions.length})</span>
            <span className="text-[10px] text-[var(--text-muted)]">Tab cycles sections</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <button
              onClick={() => setLeftSection('running')}
              className={`w-full text-left text-[10px] uppercase tracking-wide px-2 py-1 ${
                leftSection === 'running'
                  ? 'text-[var(--running)] bg-[var(--running)]/10'
                  : 'text-[var(--running)] bg-[var(--bg-elevated)]'
              }`}
            >
              Running {runningSessions.length > 0 && `(${runningSessions.length})`}
            </button>
            {runningSessions.map((row) => (
              <SessionRow
                key={row.sessionKey}
                row={row}
                selected={
                  (focusTarget?.type === 'session' && focusTarget.id === row.sessionKey)
                  || (panelFocus === 'left' && leftSection === 'running' && runningSessions[leftSelection.running]?.sessionKey === row.sessionKey)
                }
                onSelect={() => {
                  setLeftSection('running');
                  setFocusTarget({ type: 'session', id: row.sessionKey });
                  setPanelFocus('left');
                }}
              />
            ))}

            <button
              onClick={() => setLeftSection('ready')}
              className={`w-full text-left text-[10px] uppercase tracking-wide px-2 py-1 ${
                leftSection === 'ready'
                  ? 'text-[var(--warning)] bg-[var(--warning)]/10'
                  : 'text-[var(--warning)] bg-[var(--bg-elevated)]'
              }`}
            >
              Ready {readySessions.length > 0 && `(${readySessions.length})`}
            </button>
            {readySessions.map((row) => (
              <SessionRow
                key={row.sessionKey}
                row={row}
                selected={
                  (focusTarget?.type === 'session' && focusTarget.id === row.sessionKey)
                  || (panelFocus === 'left' && leftSection === 'ready' && readySessions[leftSelection.ready]?.sessionKey === row.sessionKey)
                }
                onSelect={() => {
                  setLeftSection('ready');
                  setFocusTarget({ type: 'session', id: row.sessionKey });
                  setPanelFocus('left');
                }}
              />
            ))}

            <button
              onClick={() => setLeftSection('done')}
              className={`w-full text-left text-[10px] uppercase tracking-wide px-2 py-1 ${
                leftSection === 'done'
                  ? 'text-[var(--text-primary)] bg-[var(--text-muted)]/10'
                  : 'text-[var(--text-muted)] bg-[var(--bg-elevated)]'
              }`}
            >
              Done {doneSessions.length > 0 && `(${doneSessions.length})`}
            </button>
            {doneSessions.slice(0, 20).map((row) => (
              <SessionRow
                key={row.sessionKey}
                row={row}
                selected={
                  (focusTarget?.type === 'session' && focusTarget.id === row.sessionKey)
                  || (panelFocus === 'left' && leftSection === 'done' && doneSessions[leftSelection.done]?.sessionKey === row.sessionKey)
                }
                onSelect={() => {
                  setLeftSection('done');
                  setFocusTarget({ type: 'session', id: row.sessionKey });
                  setPanelFocus('left');
                }}
              />
            ))}
          </div>
          <button
            onClick={() => setLeftSection('metrics')}
            className={`border-t border-[var(--border-subtle)] px-2 py-1 text-[11px] text-left ${
              leftSection === 'metrics'
                ? 'text-[var(--text-primary)] bg-[var(--accent-cyan)]/10'
                : 'text-[var(--text-muted)]'
            }`}
          >
            <div className="flex items-center gap-1 mb-1">
              <TrustBadge tier="computed" label="rollups" />
            </div>
            {metrics ? (
              <span>
                Tokens {metrics.tokens} · LOC {metrics.locTouched} · Commits {metrics.commits}
              </span>
            ) : (
              <span>Metrics unavailable</span>
            )}
          </button>
        </section>

        <section
          onClick={() => setPanelFocus('center')}
          className={`min-h-0 border border-[var(--border-subtle)] rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col ${
            panelFocus === 'center' ? 'ring-1 ring-[var(--accent-cyan)]' : ''
          }`}
        >
          <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-primary)] font-medium">
                {typeof focus?.header?.title === 'string' ? focus.header.title : 'Focus'}
              </span>
              {focus?.type === 'escalation' && (
                <span className="text-[11px] uppercase text-[var(--warning)]">Escalation</span>
              )}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              <span>{focus?.sessionKey ?? 'Select a session or escalation'}</span>
              {toolSignal ? (
                <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)]">
                  <span aria-hidden>{toolSignal.icon}</span>
                  <span>{toolSignal.label}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{toolSignal.detail}</span>
                </span>
              ) : (
                <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)]">
                  <span aria-hidden>◯</span>
                  <span>Idle</span>
                </span>
              )}
            </div>
            {focusDiffSummary && (
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                LOC +{focusDiffSummary.added}/-{focusDiffSummary.deleted} · {focusDiffSummary.filesTouched} files touched
              </div>
            )}
            {recentAssistantMessage && (
              <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
                Latest: {recentAssistantMessage}
              </div>
            )}
            <div className="text-[10px] text-[var(--text-muted)] mt-1">
              Session control via chat: <code>/fork</code>, <code>/stop</code>
            </div>
            {focus?.sessionKey && (
              <div className="mt-2 flex items-center gap-1">
                <button
                  onClick={() => void handleTogglePreview()}
                  disabled={previewLoading || !focus?.sessionKey}
                  className="px-2 py-0.5 text-[11px] rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
                >
                  {previewLoading ? 'Loading...' : previewVisible ? 'Hide Preview (V)' : 'Show Preview (V)'}
                </button>
                {focusStatus === 'ready' && (
                  <>
                    <button
                      onClick={() => void handleReviewDecision('accept')}
                      disabled={reviewDecisionAction !== null}
                      className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                    >
                      {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}
                    </button>
                    <button
                      onClick={() => void handleReviewDecision('request_changes')}
                      disabled={reviewDecisionAction !== null}
                      className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
                    >
                      {reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1 text-[11px]">
              <button
                onClick={() => setFocusTab('packet')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'packet'
                    ? 'bg-[var(--running)]/20 text-[var(--running)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Packet (M)
              </button>
              <button
                onClick={() => setFocusTab('diff')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'diff'
                    ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Diff (D)
              </button>
              <button
                onClick={() => setFocusTab('tests')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'tests'
                    ? 'bg-[var(--success)]/20 text-[var(--success)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Tests (T)
              </button>
              <button
                onClick={() => setFocusTab('trace')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'trace'
                    ? 'bg-[var(--warning)]/20 text-[var(--warning)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Trace (L)
              </button>
              <button
                onClick={() => setFocusTab('lens')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'lens'
                    ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Lens (Q)
              </button>
              <button
                onClick={() => setFocusTab('browser')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'browser'
                    ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Browser (B)
              </button>
            </div>
            {selectedRef && (
              <div className="mt-1 text-[11px] text-[var(--accent-cyan)]">Reference: {selectedRef}</div>
            )}
            {focusEscalationId && (
              <div className="mt-2">
                <button
                  onClick={() => void handleResolveEscalation(focusEscalationId)}
                  disabled={resolvingEscalationId === focusEscalationId}
                  className="px-2 py-0.5 text-xs rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                >
                  {resolvingEscalationId === focusEscalationId ? 'Resolving...' : 'Resolve Escalation'}
                </button>
              </div>
            )}
          </div>

          <div className="flex-[3] min-h-0 overflow-y-auto p-3">
            {focusTab === 'packet' && (
              focus?.packet ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <TrustBadge tier="proven" label="packet persisted" />
                    {parsedPacket.frontmatter && <TrustBadge tier="computed" label="frontmatter parsed" />}
                    <TrustBadge tier="computed" label="evidence coverage" />
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Bullets {packetEvidence.evidenceBackedBullets}/{packetEvidence.summaryBullets || 0} backed
                      {' · '}Refs {packetEvidence.resolvedRefs}/{packetEvidence.totalRefs || 0} resolved
                    </span>
                  </div>
                  {parsedPacket.frontmatter && (
                    <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2 text-[11px]">
                      <div className="flex flex-wrap items-center gap-1">
                        {parsedPacket.frontmatter.type && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--running)]/15 text-[var(--running)] uppercase">
                            {parsedPacket.frontmatter.type}
                          </span>
                        )}
                        {parsedPacket.frontmatter.requestedDecision && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] uppercase">
                            decision: {parsedPacket.frontmatter.requestedDecision}
                          </span>
                        )}
                        {parsedPacket.frontmatter.priority && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)] uppercase">
                            priority: {parsedPacket.frontmatter.priority}
                          </span>
                        )}
                        {parsedPacket.frontmatter.workItemId && (
                          <span className="font-mono text-[var(--text-muted)]">{parsedPacket.frontmatter.workItemId}</span>
                        )}
                      </div>
                      {parsedPacket.frontmatter.links.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          {parsedPacket.frontmatter.links.map((link) => (
                            <button
                              key={`${link.label}:${link.target}`}
                              onClick={() => void handlePacketLinkClick(link.target)}
                              className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/20"
                            >
                              {link.label}
                            </button>
                          ))}
                        </div>
                      )}
                      {parsedPacket.frontmatter.refs.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          {parsedPacket.frontmatter.refs.map((ref, idx) => {
                            const resolved = resolvePacketRef(ref.type, ref.target);
                            return (
                              <button
                                key={`${ref.type}:${ref.target}:${idx}`}
                                onClick={() => resolved && void handlePacketRefClick(ref.type, ref.target)}
                                disabled={!resolved}
                                className={`px-1.5 py-0.5 rounded ${
                                  resolved
                                    ? 'bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/20'
                                    : 'bg-[var(--error)]/10 text-[var(--error)] cursor-not-allowed'
                                }`}
                              >
                                @{ref.type}({ref.target})
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {focus.packet.validationWarnings && focus.packet.validationWarnings.length > 0 && (
                    <div className="text-[11px] text-[var(--warning)]">
                      Packet warnings: {focus.packet.validationWarnings.join(' · ')}
                    </div>
                  )}
                  {packetEvidence.brokenRefs.length > 0 && (
                    <div className="text-[11px] text-[var(--error)]">
                      Broken refs: {packetEvidence.brokenRefs.slice(0, 6).join(', ')}
                    </div>
                  )}
                  <PacketBody
                    markdown={parsedPacket.bodyMarkdown}
                    onRefClick={(refType, target) => void handlePacketRefClick(refType, target)}
                    isRefResolved={resolvePacketRef}
                  />
                </div>
              ) : (
                <div className="text-xs text-[var(--text-muted)]">No packet loaded</div>
              )
            )}

            {focusTab === 'diff' && (
              diffData ? (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-1">
                    <TrustBadge tier="proven" label="git diffstat" />
                    <TrustBadge tier="computed" label="hotspot ranking" />
                    <TrustBadge tier="computed" label="trace attribution" />
                    {diffDrift && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-[var(--warning)] bg-[var(--warning)]/10">
                        drift git:{diffDrift.gitFiles} trace:{diffDrift.traceFiles}
                      </span>
                    )}
                  </div>
                  <div className="text-[var(--text-muted)]">
                    <span className="text-[var(--text-primary)]">{diffData.baseSha.slice(0, 8)}</span>
                    {' -> '}
                    <span className="text-[var(--text-primary)]">{diffData.headSha.slice(0, 8)}</span>
                    {' · '}
                    {diffData.summary.filesTouched} files · +{diffData.summary.added} / -{diffData.summary.deleted}
                  </div>
                  <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                    <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">Hotspots</div>
                    {diffData.hotspots.length === 0 ? (
                      <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
                    ) : (
                      diffData.hotspots.slice(0, 20).map((hotspot) => (
                        <button
                          key={hotspot.path}
                          onClick={() => {
                            setSelectedDiffFile(hotspot.path);
                            if (focus?.sessionKey) {
                              void getCockpitDiff({
                                sessionKey: focus.sessionKey,
                                base: diffData.baseSha,
                                head: diffData.headSha,
                                file: hotspot.path,
                              }).then((response) => setDiffData(response)).catch(() => {});
                            }
                          }}
                          className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                            selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
                          }`}
                        >
                          <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
                          <div className="text-[10px] text-[var(--text-muted)]">
                            +{hotspot.added} / -{hotspot.deleted}
                            {typeof lastEditedLineByPath.get(hotspot.path) === 'number'
                              ? ` · last L${lastEditedLineByPath.get(hotspot.path)}`
                              : ''}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  {diffData.patch && (
                    <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] overflow-x-auto whitespace-pre-wrap">
                      {diffData.patch}
                    </pre>
                  )}
                  <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                    <div className="text-[var(--text-muted)]">Patch Pad (max 3 files / 30 lines)</div>
                    <textarea
                      value={patchDraft}
                      onChange={(event) => setPatchDraft(event.target.value)}
                      placeholder="Paste unified diff here..."
                      className="w-full min-h-28 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleApplyPatch()}
                        disabled={applyingPatch || !patchDraft.trim()}
                        className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                      >
                        {applyingPatch ? 'Applying...' : 'Apply Patch'}
                      </button>
                      {patchApplyStatus && (
                        <span className="text-[10px] text-[var(--text-muted)]">{patchApplyStatus}</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-[var(--text-muted)]">No diff range available for this session.</div>
              )
            )}

            {focusTab === 'tests' && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="testreport records" />
                  <TrustBadge tier="computed" label="category rollups" />
                </div>
                {testReports.length === 0 ? (
                  <div className="text-[var(--text-muted)]">No test reports available.</div>
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-[16rem_minmax(0,1fr)] gap-3">
                    <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                      {testReports.map((report) => (
                        <button
                          key={report.id}
                          onClick={() => setSelectedTestReportId(report.id)}
                          className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                            selectedTestReportId === report.id ? 'bg-[var(--success)]/10' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{report.id.slice(0, 8)}</span>
                            <span className="uppercase text-[10px] text-[var(--text-muted)]">{report.verdict}</span>
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)]">{formatRelativeFromIso(report.createdAt)}</div>
                        </button>
                      ))}
                    </div>
                    <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                      {selectedTestReport ? (
                        <>
                          <div className="text-[var(--text-primary)] font-medium">
                            {selectedTestReport.command || 'Test Report'}
                          </div>
                          <div className="text-[var(--text-muted)]">
                            Verdict {selectedTestReport.verdict} · Duration {selectedTestReport.durationMs}ms
                          </div>
                          <div className="space-y-1">
                            {selectedTestReport.categories.map((category, idx) => (
                              <div key={`cat-${idx}`} className="text-[var(--text-secondary)]">
                                {String(category.category ?? category.name ?? 'category')}:{' '}
                                {String(category.verdict ?? 'unknown')}
                              </div>
                            ))}
                          </div>
                          {selectedTestReport.agentNote && (
                            <p className="text-[var(--text-secondary)] whitespace-pre-wrap">{selectedTestReport.agentNote}</p>
                          )}
                        </>
                      ) : (
                        <div className="text-[var(--text-muted)]">Select a report</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {focusTab === 'trace' && (
              <div className="space-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="trace records" />
                  <TrustBadge tier="computed" label="timeline ordering" />
                </div>
                {traces.length === 0 ? (
                  <div className="text-[var(--text-muted)]">No traces available.</div>
                ) : (
                  traces.slice(0, 50).map((trace) => (
                    <div key={trace.id} className="border border-[var(--border-subtle)] rounded p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[var(--text-primary)]">{trace.vcs.revision.slice(0, 8)}</span>
                        <span className="text-[var(--text-muted)]">{formatRelativeFromIso(trace.timestamp)}</span>
                        <span className="text-[var(--text-muted)] ml-auto">{trace.files.length} files</span>
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {trace.files.slice(0, 6).map((file) => (
                          <div key={`${trace.id}-${file.path}`} className="font-mono text-[11px] text-[var(--text-secondary)] truncate">
                            {file.path}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {focusTab === 'lens' && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="text matches" />
                  <TrustBadge tier="heuristic" label="defs/refs classification" />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={lensQuery}
                    onChange={(event) => setLensQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleRunLensSearch();
                      }
                    }}
                    placeholder="Search code..."
                    className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                  />
                  <button
                    onClick={() => void handleRunLensSearch()}
                    disabled={!focus?.sessionKey || !lensQuery.trim() || lensLoading}
                    className="px-2 py-1 rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
                  >
                    {lensLoading ? 'Searching...' : 'Search'}
                  </button>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
                  {([
                    ['Definitions', lensResults.defs],
                    ['References', lensResults.refs],
                    ['Text', lensResults.text],
                  ] as Array<[string, RepoLensMatch[]]>).map(([label, rows]) => (
                    <div key={label} className="border border-[var(--border-subtle)] rounded overflow-hidden">
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                        {label} ({rows.length})
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                        {rows.length === 0 ? (
                          <div className="px-2 py-2 text-[var(--text-muted)]">No matches</div>
                        ) : (
                          rows.slice(0, 60).map((match, idx) => (
                            <button
                              key={`${label}-${match.kind}-${match.path}-${match.line}-${idx}`}
                              onClick={() => {
                                setSelectedRef(`@file(${match.path}#L${match.line})`);
                                setFocusTab('diff');
                                setSelectedDiffFile(match.path);
                                if (focus?.sessionKey) {
                                  void getCockpitDiff({
                                    sessionKey: focus.sessionKey,
                                    file: match.path,
                                  }).then((response) => setDiffData(response)).catch(() => {});
                                }
                              }}
                              className="w-full text-left px-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]"
                            >
                              <div className="font-mono text-[10px] text-[var(--text-secondary)] truncate">
                                {match.path}:{match.line}
                              </div>
                              <div className="text-[10px] text-[var(--text-muted)] truncate">{match.preview}</div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {focusTab === 'browser' && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="browser action logs" />
                  <TrustBadge tier="proven" label="captured evidence" />
                  <TrustBadge tier="computed" label="runbook execution" />
                </div>
                <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[var(--text-muted)]">Session</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {browserState?.browserSession ?? 'not attached'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      browserState?.available
                        ? 'text-[var(--success)] bg-[var(--success)]/10'
                        : 'text-[var(--warning)] bg-[var(--warning)]/10'
                    }`}>
                      {browserState?.available ? 'agent-browser available' : 'agent-browser unavailable'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      browserState?.connected
                        ? 'text-[var(--running)] bg-[var(--running)]/10'
                        : 'text-[var(--text-muted)] bg-[var(--text-muted)]/10'
                    }`}>
                      {browserState?.connected ? 'connected' : 'not connected'}
                    </span>
                  </div>
                  {browserState?.currentUrl && (
                    <div className="text-[var(--text-muted)] truncate">
                      URL: <span className="text-[var(--text-secondary)]">{browserState.currentUrl}</span>
                    </div>
                  )}
                  {browserState?.title && (
                    <div className="text-[var(--text-muted)] truncate">
                      Title: <span className="text-[var(--text-secondary)]">{browserState.title}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input
                      value={browserUrlDraft}
                      onChange={(event) => setBrowserUrlDraft(event.target.value)}
                      placeholder="https://..."
                      className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                    />
                    <button
                      onClick={() => void handleBrowserAction({ action: 'open', url: browserUrlDraft.trim() })}
                      disabled={!focus?.sessionKey || !browserUrlDraft.trim() || browserLoading}
                      className="px-2 py-1 rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => void handleBrowserAction({
                        action: 'snapshot',
                        interactive: browserSnapshotInteractive,
                        compact: browserSnapshotCompact,
                      })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-2 py-1 rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-60"
                    >
                      Snapshot
                    </button>
                    <button
                      onClick={() => void handleBrowserAction({ action: 'screenshot', label: 'cockpit' })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-2 py-1 rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                    >
                      Screenshot
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={browserSnapshotInteractive}
                        onChange={(event) => setBrowserSnapshotInteractive(event.target.checked)}
                      />
                      interactive snapshot
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={browserSnapshotCompact}
                        onChange={(event) => setBrowserSnapshotCompact(event.target.checked)}
                      />
                      compact
                    </label>
                    <button
                      onClick={() => void handleBrowserAction({ action: 'back' })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => void handleBrowserAction({ action: 'forward' })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
                    >
                      Forward
                    </button>
                    <button
                      onClick={() => void handleBrowserAction({ action: 'reload' })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
                    >
                      Reload
                    </button>
                    <button
                      onClick={() => void handleBrowserAction({ action: 'close' })}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                  <div className="text-[var(--text-muted)]">Interactive Action</div>
                  <div className="grid grid-cols-1 xl:grid-cols-4 gap-2">
                    <select
                      value={browserActionType}
                      onChange={(event) => setBrowserActionType(event.target.value as typeof browserActionType)}
                      className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                    >
                      <option value="click">click</option>
                      <option value="fill">fill</option>
                      <option value="type">type</option>
                      <option value="press">press</option>
                      <option value="wait">wait</option>
                      <option value="scroll">scroll</option>
                    </select>
                    <input
                      value={browserTargetDraft}
                      onChange={(event) => setBrowserTargetDraft(event.target.value)}
                      placeholder={browserActionType === 'wait' ? 'selector (optional)' : 'target (@e1, #id, etc)'}
                      className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                    />
                    {browserActionType === 'scroll' ? (
                      <select
                        value={browserDirectionDraft}
                        onChange={(event) => setBrowserDirectionDraft(event.target.value as typeof browserDirectionDraft)}
                        className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                      >
                        <option value="down">down</option>
                        <option value="up">up</option>
                        <option value="left">left</option>
                        <option value="right">right</option>
                      </select>
                    ) : (
                      <input
                        value={browserValueDraft}
                        onChange={(event) => setBrowserValueDraft(event.target.value)}
                        placeholder={
                          browserActionType === 'wait'
                            ? 'milliseconds (or leave blank to wait selector)'
                            : browserActionType === 'press'
                              ? 'key (Enter, Tab, Control+a)'
                              : 'text/value'
                        }
                        className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
                      />
                    )}
                    <button
                      onClick={() => void handleRunBrowserAction()}
                      disabled={!focus?.sessionKey || browserLoading}
                      className="px-2 py-1 rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
                    >
                      Run Action
                    </button>
                  </div>
                </div>

                <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                  <div className="text-[var(--text-muted)]">Runbook (automation)</div>
                  <textarea
                    value={browserRunbook}
                    onChange={(event) => setBrowserRunbook(event.target.value)}
                    className="w-full min-h-32 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleRunBrowserRunbook()}
                      disabled={!focus?.sessionKey || !browserRunbook.trim() || browserRunningRunbook}
                      className="px-2 py-0.5 rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-60"
                    >
                      {browserRunningRunbook ? 'Running...' : 'Run Runbook'}
                    </button>
                    <button
                      onClick={() => setBrowserRunbook(DEFAULT_BROWSER_RUNBOOK)}
                      className="px-2 py-0.5 rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30"
                    >
                      Reset Template
                    </button>
                    <button
                      onClick={() => void refreshBrowserState(focus?.sessionKey)}
                      disabled={browserLoading}
                      className="px-2 py-0.5 rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
                    >
                      {browserLoading ? 'Loading...' : 'Refresh Browser State'}
                    </button>
                  </div>
                  {browserActionStatus && (
                    <div className="text-[11px] text-[var(--text-muted)]">{browserActionStatus}</div>
                  )}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                  <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                      Recent Browser Actions ({browserState?.actions?.length ?? 0})
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {(browserState?.actions ?? []).length === 0 ? (
                        <div className="px-2 py-2 text-[var(--text-muted)]">No browser actions yet.</div>
                      ) : (
                        (browserState?.actions ?? []).slice(0, 40).map((item, idx) => {
                          const action = typeof item.action === 'string' ? item.action : 'action';
                          const success = item.success !== false;
                          const at = typeof item.at === 'string' ? item.at : '';
                          const preview = typeof item.outputPreview === 'string' ? item.outputPreview : '';
                          const err = typeof item.error === 'string' ? item.error : '';
                          return (
                            <div
                              key={`browser-action-${idx}-${action}`}
                              className="px-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0"
                            >
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] uppercase ${success ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                                  {action}
                                </span>
                                <span className="text-[10px] text-[var(--text-muted)]">{at ? formatRelativeFromIso(at) : ''}</span>
                              </div>
                              {preview && (
                                <div className="text-[10px] text-[var(--text-muted)] truncate">{preview}</div>
                              )}
                              {err && (
                                <div className="text-[10px] text-[var(--error)] truncate">{err}</div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                      Evidence ({browserState?.evidence?.length ?? 0})
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {(browserState?.evidence ?? []).length === 0 ? (
                        <div className="px-2 py-2 text-[var(--text-muted)]">No screenshots or snapshots captured.</div>
                      ) : (
                        (browserState?.evidence ?? []).slice(0, 40).map((evidence) => (
                          <div
                            key={evidence.id}
                            className="px-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] uppercase text-[var(--running)]">{evidence.type}</span>
                              <span className="text-[10px] text-[var(--text-muted)]">{formatRelativeFromIso(evidence.createdAt)}</span>
                            </div>
                            <div className="font-mono text-[10px] text-[var(--text-secondary)] truncate">{evidence.path}</div>
                            {evidence.url && (
                              <div className="text-[10px] text-[var(--text-muted)] truncate">{evidence.url}</div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {browserState?.lastSnapshotPreview && (
                  <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] overflow-x-auto whitespace-pre-wrap">
                    {browserState.lastSnapshotPreview}
                  </pre>
                )}
              </div>
            )}
          </div>

          {previewVisible && previewUrl && (
            <div className="h-56 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
              <iframe
                title="Cockpit Preview"
                src={previewUrl}
                className="w-full h-full"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              />
            </div>
          )}

          <div className="flex-[2] min-h-0 border-t border-[var(--border-subtle)] overflow-y-auto">
            <div className="px-2 py-1 text-xs text-[var(--text-muted)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
              <span>Messages and Events</span>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={() => setEventFilter('signal')}
                  className={`px-1.5 py-0.5 rounded ${
                    eventFilter === 'signal'
                      ? 'bg-[var(--success)]/20 text-[var(--success)]'
                      : 'hover:bg-[var(--bg-hover)]'
                  }`}
                  title="Show only high-value content (messages, packets, failures)"
                >
                  Signal
                </button>
                <button
                  onClick={() => setEventFilter('all')}
                  className={`px-1.5 py-0.5 rounded ${
                    eventFilter === 'all'
                      ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                      : 'hover:bg-[var(--bg-hover)]'
                  }`}
                  title="Show timeline events (tool spam moved to Audit)"
                >
                  All
                </button>
                <button
                  onClick={() => setEventFilter('failures')}
                  className={`px-1.5 py-0.5 rounded ${
                    eventFilter === 'failures'
                      ? 'bg-[var(--warning)]/20 text-[var(--warning)]'
                      : 'hover:bg-[var(--bg-hover)]'
                  }`}
                  title="Show only failures and errors"
                >
                  Failures
                </button>
                <button
                  onClick={() => setEventFilter('audit')}
                  className={`px-1.5 py-0.5 rounded ${
                    eventFilter === 'audit'
                      ? 'bg-[var(--text-muted)]/20 text-[var(--text-muted)]'
                      : 'hover:bg-[var(--bg-hover)]'
                  }`}
                  title="Show tool calls, memory injections, and diagnostics"
                >
                  Audit
                </button>
              </div>
            </div>
            {filteredEvents.length === 0 ? (
              <div className="p-3 text-xs text-[var(--text-muted)]">No events available.</div>
            ) : (
              filteredEvents.map((event, idx) => {
                const data = asRecord(event.payload.data);
                const isTool = event.type === 'tool';
                const isMessage = isMessageLikeEvent(event);
                const isFailure = isFailureEvent(event);
                const messageRole = isMessage ? messageRoleForEvent(event) : 'message';
                const messageContent = isMessage ? extractMessageContent(event.payload) : '';
                const toolName = isTool ? (typeof data?.tool_name === 'string' ? data.tool_name : null) : null;
                const toolPhase = isTool ? (typeof data?.phase === 'string' ? data.phase : null) : null;
                const toolDuration = isTool && typeof data?.duration_ms === 'number' ? data.duration_ms : null;
                const toolArgs = isTool && data?.arguments ? data.arguments as Record<string, unknown> : null;
                const showToolDetail = eventFilter === 'audit' || isFailure;
                const toolFile = typeof toolArgs?.file_path === 'string' ? toolArgs.file_path
                  : typeof toolArgs?.path === 'string' ? toolArgs.path
                  : typeof toolArgs?.command === 'string' ? toolArgs.command.slice(0, 80)
                  : null;
                
                // Signal highlighting: prioritize events based on priority
                const signalPriority = event.signalPriority;
                const isHighSignal = signalPriority === 'high' || (!signalPriority && isMessage && messageRole === 'assistant' && messageContent.length > 50);

                return (
                  <div key={`${event.at}-${idx}`} className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${isFailure ? 'bg-[var(--error)]/5' : ''} ${isHighSignal ? 'bg-[var(--success)]/5' : ''}`}>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={`uppercase font-medium ${
                        isMessage ? 'text-[var(--running)]'
                        : isTool ? 'text-[var(--accent-cyan)]'
                        : isFailure ? 'text-[var(--error)]'
                        : 'text-[var(--text-muted)]'
                      }`}>
                        {isMessage ? messageRole : event.type}
                      </span>
                      {toolName && (
                        <span className="text-[var(--text-primary)] font-mono text-[11px]">{toolName}</span>
                      )}
                      {!toolName && !isMessage && (
                        <span className="text-[var(--text-muted)]">{eventLabel(event)}</span>
                      )}
                      {toolPhase === 'completed' && toolDuration !== null && (
                        <span className="text-[10px] text-[var(--text-muted)]">{toolDuration}ms</span>
                      )}
                      <span className="text-[var(--text-muted)] ml-auto shrink-0">{formatRelativeFromIso(event.at)}</span>
                    </div>
                    {showToolDetail && toolFile && (
                      <div className="text-[11px] text-[var(--text-muted)] mt-0.5 font-mono truncate pl-4">
                        {toolFile}
                      </div>
                    )}
                    {isMessage && messageContent && (
                      <div className="text-xs text-[var(--text-secondary)] mt-0.5 whitespace-pre-wrap break-words line-clamp-6">
                        {messageContent.slice(0, 500)}
                      </div>
                    )}
                    {isFailure && !isMessage && (
                      <div className="text-[11px] text-[var(--error)] mt-0.5 truncate">
                        {typeof data?.error === 'string' ? data.error.slice(0, 200)
                          : typeof event.payload.eventType === 'string' ? event.payload.eventType : ''}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div
            className={`shrink-0 border-t border-[var(--border-subtle)] p-2 space-y-2 ${
              panelFocus === 'input' ? 'bg-[var(--accent-cyan)]/10' : ''
            }`}
          >
            <div className="text-[11px] text-[var(--text-muted)]">Input (Esc, Ctrl+Enter to send, /fork, /stop)</div>
            <textarea
              ref={inputRef}
              value={messageDraft}
              onFocus={() => setPanelFocus('input')}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder={focus?.sessionKey ? `Message ${focus.sessionKey}` : 'Select a session first'}
              className="w-full min-h-16 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[12px] text-[var(--text-secondary)]"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)]">1/2/3 switch panels, Tab cycles sections</span>
              <button
                onClick={() => void handleSendMessage()}
                disabled={sendingMessage || !focus?.sessionKey || !messageDraft.trim()}
                className="px-2 py-0.5 text-[11px] rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-60"
              >
                {sendingMessage ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </section>

        <section
          onClick={() => setPanelFocus('right')}
          className={`min-h-0 border border-[var(--border-subtle)] rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col ${
            panelFocus === 'right' ? 'ring-1 ring-[var(--accent-cyan)]' : ''
          }`}
        >
          <div className="px-2 py-1 text-xs text-[var(--text-muted)] border-b border-[var(--border-subtle)] flex items-center justify-between">
            <span>Queue (3)</span>
            <span className="text-[10px] text-[var(--text-muted)]">Tab cycles</span>
          </div>
          <div className="px-1 py-1 border-b border-[var(--border-subtle)] flex items-center gap-1 text-[11px]">
            <button
              onClick={() => setRightSection('queue')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'queue'
                  ? 'bg-[var(--warning)]/20 text-[var(--warning)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Escalations ({escalations.length})
            </button>
            <button
              onClick={() => setRightSection('commits')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'commits'
                  ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Commits ({commitRollups.length})
            </button>
            <button
              onClick={() => setRightSection('prs')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'prs'
                  ? 'bg-[var(--running)]/20 text-[var(--running)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Open PRs ({prRollups.length})
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightSection === 'queue' && (
              escalations.length === 0 ? (
                <div className="p-3 text-xs text-[var(--text-muted)]">No open escalations.</div>
              ) : (
                escalations.map((row, index) => (
                  <EscalationRow
                    key={row.escalationId}
                    row={row}
                    selected={
                      (focusTarget?.type === 'escalation' && focusTarget.id === row.escalationId)
                      || (panelFocus === 'right' && rightSection === 'queue' && rightSelection.queue === index)
                    }
                    onSelect={() => {
                      setRightSection('queue');
                      setRightSelection((current) => ({ ...current, queue: index }));
                      setFocusTarget({ type: 'escalation', id: row.escalationId });
                    }}
                    onResolve={() => void handleResolveEscalation(row.escalationId)}
                    resolving={resolvingEscalationId === row.escalationId}
                  />
                ))
              )
            )}
            {rightSection === 'commits' && (
              commitRollups.length === 0 ? (
                <div className="p-3 text-xs text-[var(--text-muted)]">No recent commits.</div>
              ) : (
                commitRollups.map((row, index) => (
                  <CommitRow
                    key={`${row.sha}-${index}`}
                    row={row}
                    selected={panelFocus === 'right' && rightSection === 'commits' && rightSelection.commits === index}
                    onSelect={() => handleSelectCommit(row, index)}
                  />
                ))
              )
            )}
            {rightSection === 'prs' && (
              prRollups.length === 0 ? (
                <div className="p-3 text-xs text-[var(--text-muted)]">No open PRs.</div>
              ) : (
                prRollups.map((row, index) => (
                  <PRRow
                    key={`${row.prId}-${index}`}
                    row={row}
                    selected={panelFocus === 'right' && rightSection === 'prs' && rightSelection.prs === index}
                    onSelect={() => handleSelectPR(row, index)}
                  />
                ))
              )
            )}
          </div>

          <div className="border-t border-[var(--border-subtle)] p-2 text-[11px] text-[var(--text-muted)] space-y-1">
            <div>Open escalations: {metrics?.escalationsOpen ?? escalations.length}</div>
            <div>Commits today: {metrics?.commits ?? 0}</div>
            <div>Tests today: {metrics?.tests ?? 0}</div>
          </div>
        </section>
      </main>

      {error && (
        <div className="px-3 py-1 text-xs text-[var(--error)] border-t border-[var(--error)]/40 bg-[var(--error)]/10">
          {error}
        </div>
      )}
    </div>
  );
}
