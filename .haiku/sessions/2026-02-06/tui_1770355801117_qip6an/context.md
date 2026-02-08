---
session: tui_1770355801117_qip6an
created: 2026-02-06T05:30:01.118Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770357058211
## Goal

. Make the control dashboard have a Markdown editor / viewer as the first class item. The screen should load without a a session selected with a blank Markdown file directly in the browser with the cursor blinking there. Make the input bar appear with "Ctrl+`" like on VSCode. Have the suggested text while in Markdown mode be "Chat about Document". You should still be able to access the other left and right panels with 1 and 3. Move the "Done" Sessions to the right Side. Then, put the Directory for your markdown files. Add ability to create folders and create files both through buttons and through keyboard only, whichever is a common keybind for that. For new file creation we should probably auto-suggest a few folders to place the new markdown file in. We also should support splitting the Markdown editor once vertically. Make the markdown editor silky, optimized nice feeling. It's the main character. We'll need some plumbing on the API system. We should have the endpoint to receive a markdown file but we also want to be able to send markdown files. Some of the use cases will be Chat + markdown edits. So like you can be talking back and forth with the agent, and it wil edit the markdown file as well as send messages. Perhaps we need to support Patches to our markdown files, or the solution would just be to send a new one every time and overwrite on our side, otherwise it may be hard to not have race conditions? or we keep version numbers and version the patches.

## Context Files

- **Salience**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770355801117_qip6an/salience.md — session goal and principles
- **Decision log**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770355801117_qip6an/decisions.jsonl — prior decisions this session
- **Work log**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770355801117_qip6an/work-log.jsonl — session activity

## Your Task

1. **Read the salience file** for goal context and operating principles.
2. **Explore minimally** — use Glob/Grep/Read to understand what needs to change.
3. **Ask questions** — use PromptUser if the goal is ambiguous. The watcher answers.
4. **Produce a plan** — output your handoffSpec when ready.

## handoffSpec Format

Your handoffSpec MUST be a valid JSON object and include:
- `goal` (string)
- `context` (string)
- `workItems` (array), each item with:
  - `id` (string)
  - `objective` (string, include file paths)
  - `delta` (string; one commit)
  - `agent` (string)
  - `domain` (string, optional)
  - `dependencies` (string[], optional)
  - `targetPaths` (string[], optional)

## Principles

- **Atomic**: Each work item = one commit
- **Parallel**: Independent items run concurrently (minimize dependencies)
- **Specific**: Include file paths in objectives
- **Bounded**: Max 5-7 work items. If bigger, split the goal first.

When ready: set `goalStateReached: true`, `action: "handoff"`, and include `handoffSpec`.

### function_call
@callId call_02d779c69e5347b7b01cf0b8
@name Read
@ts 1770357063200
@workItemId 65beeb3a
{"path":"/Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770355801117_qip6an/salience.md"}

### function_call
@callId call_7c439792784b461bb3721f9c
@name Glob
@ts 1770357063200
@workItemId 65beeb3a
{"pattern":"packages/dashboard-control/src/**/*.{tsx,ts,css}"}

### function_call_output
@callId call_02d779c69e5347b7b01cf0b8
@ts 1770357063210
@durationMs 7
@workItemId 65beeb3a
# Watcher Salience — tui_1770355801117_qip6an

**Goal**: . Make the control dashboard have a Markdown editor / viewer as the first class item. The screen should load without a a session selected with a blank Markdown file directly in the browser with the cursor blinking there. Make the input bar appear with "Ctrl+`" like on VSCode. Have the suggested text while in Markdown mode be "Chat about Document". You should still be able to access the other left and right panels with 1 and 3. Move the "Done" Sessions to the right Side. Then, put the Directory for your markdown files. Add ability to create folders and create files both through buttons and through keyboard only, whichever is a common keybind for that. For new file creation we should probably auto-suggest a few folders to place the new markdown file in. We also should support splitting the Markdown editor once vertically. Make the markdown editor silky, optimized nice feeling. It's the main character. We'll need some plumbing on the API system. We should have the endpoint to receive a markdown file but we also want to be able to send markdown files. Some of the use cases will be Chat + markdown edits. So like you can be talking back and forth with the agent, and it wil edit the markdown file as well as send messages. Perhaps we need to support Patches to our markdown files, or the solution would just be to send a new one every time and overwrite on our side, otherwise it may be hard to not have race conditions? or we keep version numbers and version the patches.
**Mode**: async
**Created**: 2026-02-06T05:50:57.999Z

## Operating Principles

1. Surface ambiguity aggressively — implicit boundaries and shared ownership are questions, not silent choices.
2. Establish invariants — record what decisions imply. Make boundaries and contracts explicit.
3. Separation of concerns is non-negotiable — detect and address concern-mixing.
4. Evidence-first oversight — never allow without concrete evidence. If evidence is missing, report it and intervene.
5. Accountability — the watcher is responsible for goal completion and system integrity. Create infra-fix work when the system fails you.
6. One work item = one git commit. Keep units of work atomic and reviewable.

## Session Notes

_No notes yet. The watcher will append observations here._

### function_call_output
@callId call_7c439792784b461bb3721f9c
@ts 1770357063210
@durationMs 7
@workItemId 65beeb3a
packages/dashboard-control/src/App.tsx
packages/dashboard-control/src/components/GoalTree.tsx
packages/dashboard-control/src/components/ProjectBrowser.tsx
packages/dashboard-control/src/components/ProjectsView.tsx
packages/dashboard-control/src/components/SessionList.tsx
packages/dashboard-control/src/components/SessionsView.tsx
packages/dashboard-control/src/components/TokenUsage.tsx
packages/dashboard-control/src/components/TracesView.tsx
packages/dashboard-control/src/components/index.ts
packages/dashboard-control/src/index.css
packages/dashboard-control/src/lib/api.ts
packages/dashboard-control/src/main.tsx

### function_call
@callId call_10372fadc0a14f50a5020969
@name Read
@ts 1770357064948
@workItemId 65beeb3a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx"}

### function_call
@callId call_56a4acf793bb4243ab7fb893
@name Read
@ts 1770357064948
@workItemId 65beeb3a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts"}

### function_call_output
@callId call_10372fadc0a14f50a5020969
@ts 1770357064950
@durationMs 2
@workItemId 65beeb3a
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

  const
... [truncated 50021 chars]

### function_call_output
@callId call_56a4acf793bb4243ab7fb893
@ts 1770357064950
@durationMs 1
@workItemId 65beeb3a
/**
 * Control Plane API Client
 *
 * Connects to harness-daemon's control-plane routes for session/project data.
 */

const API_BASE = '/control-plane';

export interface Project {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  activeGoals: number;
  activeSessions?: number;
  gitRemote?: { owner: string; repo: string } | null;
}

export interface Feature {
  id: string;
  name: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  sessionCount: number;
}

export interface Session {
  id: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: string;
  lastAccessedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

export interface GoalNode {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  deadline: string | null;
  children: GoalNode[];
}

export interface TokenUsage {
  provider: string;
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface TraceRecord {
  id: string;
  version: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash?: string }>;
    }>;
  }>;
}

export interface GitInfo {
  currentBranch: string;
  remote?: { owner: string; repo: string };
  uncommittedChanges: number;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
}

async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postAPI<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ============ Projects ============

export async function getProjects(): Promise<Project[]> {
  const data = await fetchAPI<{ projects: Project[] }>('/projects');
  return data.projects ?? [];
}

export async function getFeatures(projectPath: string): Promise<{ features: Feature[]; currentBranch: string }> {
  const encoded = encodeURIComponent(projectPath);
  return fetchAPI(`/projects/${encoded}/features`);
}

export async function getProjectSessions(projectPath: string): Promise<Session[]> {
  const encoded = encodeURIComponent(projectPath);
  const data = await fetchAPI<{ sessions: Session[] }>(`/projects/${encoded}/sessions`);
  return data.sessions ?? [];
}

// ============ Sessions ============

export async function getSessions(limit = 50): Promise<Session[]> {
  const data = await fetchAPI<{ sessions: Session[] }>(`/sessions?limit=${limit}`);
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await fetchAPI<{ session: Session | null }>(`/sessions/${encodeURIComponent(sessionId)}`);
  return data.session;
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const data = await fetchAPI<{ messages: Message[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  return data.messages ?? [];
}

// ============ Git Integration ============

export async function getPRs(owner: string, repo: string, branch?: string): Promise<PRInfo[]> {
  const encoded = encodeURIComponent(branch || '');
  const data = await fetchAPI<{ prs: PRInfo[] }>(`/features/${encoded}/prs?owner=${owner}&repo=${repo}`);
  return data.prs ?? [];
}

// ============ Goals ============

export async function getGoalHierarchy(): Promise<GoalNode[]> {
  const data = await fetchAPI<{ goals: GoalNode[]; note?: string }>('/goals/hierarchy');
  return data.goals ?? [];
}

// ============ Token Usage ============

export async function getTokenUsage(): Promise<TokenUsage[]> {
  const data = await fetchAPI<{ usage: TokenUsage[] }>('/token-usage');
  return data.usage ?? [];
}

// ============ Traces ============

export async function getTraces(limit = 50): Promise<TraceRecord[]> {
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/traces?limit=${limit}`);
  return data.traces ?? [];
}

export async function getTraceByRevision(revision: string): Promise<TraceRecord | null> {
  try {
    const data = await fetchAPI<{ trace: TraceRecord }>(`/traces/revision/${revision}`);
    return data.trace;
  } catch {
    return null;
  }
}

// ============ Git Info ============

export async function getGitInfo(projectPath: string): Promise<GitInfo | null> {
  try {
    const encoded = encodeURIComponent(projectPath);
    return fetchAPI<GitInfo>(`/projects/${encoded}/git`);
  } catch {
    return null;
  }
}

// ============ Session Actions ============

export async function sendSessionMessage(sessionId: string, message: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/message`, { message });
}

export async function stopSession(sessionId: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}

// ============ Cockpit v0.1 ============ 

export type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
export type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

export interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

export interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

export interface DailyMetrics {
  tokens: number;
  locTouched: number;
  commits: number;
  prs: number;
  tests: number;
  sessions: {
    running: number;
    ready: number;
    done: number;
  };
  escalationsOpen: number;
}

export interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

export interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

export interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

export interface FocusData {
  type: 'session' | 'escalation';
  id: string;
  sessionKey: string;
  header: Record<string, unknown>;
  packet: FocusPacket | null;
  pointers: Record<string, string>;
}

export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

export interface CockpitDiff {
  baseSha: string;
  headSha: string;
  source: 'query' | 'session' | 'git-parent' | 'unknown';
  summary: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  hotspots: DiffHotspot[];
  patch: string | null;
}

export interface CockpitTestReport {
  id: string;
  sessionKey: string;
  workItemId: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
  cliOutput: string;
  command: string;
  coverage: Record<string, unknown> | null;
  mutationScore: number | null;
  agentNote: string;
  durationMs: number;
  createdAt: string;
}

export interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface PostCockpitPacketInput {
  sessionKey: string;
  packetId?: string;
  workItemId?: string;
  escalationId?: string;
  type?: 'escalation' | 'review' | 'session' | 'ready' | 'ready_review' | 'pr_review';
  markdown?: string;
  contentMarkdown?: string;
  markdownPath?: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  createdAt?: string | number;
  source?: string;
  requestId?: string;
}

export interface CockpitSessionControlInput {
  action: 'start' | 'stop' | 'fork';
  message?: string;
  note?: string;
  targetSessionKey?: string;
}

export interface CockpitSessionReviewDecisionInput {
  decision: 'accept' | 'request_changes';
  note?: string;
  requestId?: string;
}

export interface CockpitPatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface CockpitPatchApplyInput {
  sessionKey: string;
  baseSha?: string;
  patch?: string;
  edits?: CockpitPatchEditInput[];
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserActionInput {
  sessionKey: string;
  action: 'open' | 'back' | 'forward' | 'reload' | 'snapshot' | 'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll' | 'get_url' | 'get_title' | 'screenshot' | 'close';
  url?: string;
  target?: string;
  text?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserEvidence {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

export interface CockpitBrowserState {
  sessionKey: string;
  browserSession: string;
  available: boolean;
  connected: boolean;
  currentUrl?: string;
  title?: string;
  lastActionAt?: string;
  actions: Array<Record<string, unknown>>;
  evidence: CockpitBrowserEvidence[];
  lastSnapshotPath?: string;
  lastSnapshotPreview?: string;
}

export async function getCockpitSessionRollups(
  status: SessionPanelStatus,
  limit = 100
): Promise<SessionRollup[]> {
  const data = await fetchAPI<{ rollups: SessionRollup[] }>(
    `/cockpit/rollups/sessions?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitEscalationRollups(limit = 100): Promise<EscalationRollup[]> {
  const data = await fetchAPI<{ rollups: EscalationRollup[] }>(
    `/cockpit/rollups/escalations?status=open&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitCommitRollups(limit = 50): Promise<CommitRollup[]> {
  const data = await fetchAPI<{ rollups: CommitRollup[] }>(`/cockpit/rollups/commits?limit=${limit}`);
  return data.rollups ?? [];
}

export async function getCockpitPRRollups(
  status: 'open' | 'closed' | 'merged' = 'open',
  limit = 50
): Promise<PRRollup[]> {
  const data = await fetchAPI<{ rollups: PRRollup[] }>(
    `/cockpit/rollups/prs?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitDailyMetrics(date?: string): Promise<DailyMetrics | null> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const data = await fetchAPI<{ metrics: DailyMetrics | null }>(`/cockpit/metrics/daily${query}`);
  return data.metrics ?? null;
}

export async function getCockpitFocus(
  type: 'session' | 'escalation',
  id: string,
  packetId?: string
): Promise<FocusData | null> {
  const packetQuery = packetId ? `&packetId=${encodeURIComponent(packetId)}` : '';
  const data = await fetchAPI<{ focus: FocusData | null }>(
    `/cockpit/focus?type=${type}&id=${encodeURIComponent(id)}${packetQuery}`
  );
  return data.focus ?? null;
}

export async function getCockpitSessionEvents(
  sessionKey: string,
  options: { cursor?: number; limit?: number } = {}
): Promise<{ events: NormalizedSessionEvent[]; nextCursor: number | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 200));
  if (typeof options.cursor === 'number') {
    params.set('cursor', String(options.cursor));
  }
  const data = await fetchAPI<{ events: NormalizedSessionEvent[]; nextCursor: number | null }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/events?${params.toString()}`
  );
  return {
    events: data.events ?? [],
    nextCursor: data.nextCursor ?? null,
  };
}

export async function getCockpitSessionPackets(
  sessionKey: string,
  limit = 20
): Promise<FocusPacket[]> {
  const data = await fetchAPI<{ packets: FocusPacket[] }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/packets?limit=${limit}`
  );
  return data.packets ?? [];
}

export async function getCockpitTraces(
  sessionKey: string,
  options: { workItemId?: string; limit?: number } = {}
): Promise<TraceRecord[]> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  params.set('limit', String(options.limit ?? 200));
  if (options.workItemId) params.set('workItemId', options.workItemId);
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/cockpit/traces?${params.toString()}`);
  return data.traces ?? [];
}

export async function getCockpitDiff(options: {
  sessionKey?: string;
  base?: string;
  head?: string;
  file?: string;
}): Promise<CockpitDiff> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.base) params.set('base', options.base);
  if (options.head) params.set('head', options.head);
  if (options.file) params.set('file', options.file);
  return fetchAPI<CockpitDiff>(`/cockpit/diff?${params.toString()}`);
}

export async function getCockpitTestReports(
  options: { sessionKey?: string; workItemId?: string; limit?: number } = {}
): Promise<CockpitTestReport[]> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.workItemId) params.set('workItemId', options.workItemId);
  params.set('limit', String(options.limit ?? 20));
  const data = await fetchAPI<{ reports: CockpitTestReport[] }>(`/cockpit/tests?${params.toString()}`);
  return data.reports ?? [];
}

export async function getCockpitTestReport(testReportId: string): Promise<CockpitTestReport | null> {
  try {
    const data = await fetchAPI<{ report: CockpitTestReport | null }>(
      `/cockpit/tests/${encodeURIComponent(testReportId)}`
    );
    return data.report ?? null;
  } catch {
    return null;
  }
}

export async function searchCockpitRepoLens(options: {
  sessionKey?: string;
  q: string;
  kind?: 'all' | 'defs' | 'refs' | 'text';
  limit?: number;
}): Promise<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }> {
  const params = new URLSearchParams();
  params.set('q', options.q);
  params.set('kind', options.kind ?? 'all');
  params.set('limit', String(options.limit ?? 120));
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  const data = await fetchAPI<{
    results: { defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] };
  }>(`/cockpit/repo/lens?${params.toString()}`);
  return data.results ?? { defs: [], refs: [], text: [] };
}

export async function getCockpitPreview(options: {
  sessionKey?: string;
  url?: string;
}): Promise<{ url: string; source: 'query' | 'session' } | null> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.url) params.set('url', options.url);
  try {
    return await fetchAPI<{ url: string; source: 'query' | 'session' }>(`/cockpit/preview?${params.toString()}`);
  } catch {
    return null;
  }
}

export async function getCockpitBrowserState(sessionKey: string): Promise<CockpitBrowserState | null> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  try {
    const data = await fetchAPI<{ state: CockpitBrowserState }>(`/cockpit/browser/state?${params.toString()}`);
    return data.state ?? null;
  } catch {
    return null;
  }
}

export async function postCockpitBrowserAction(
  input: CockpitBrowserActionInput
): Promise<{
  success: boolean;
  action?: string;
  browserSession?: string;
  data?: unknown;
  output?: string;
  artifactPath?: string;
  currentUrl?: string;
  title?: string;
  evidence?: CockpitBrowserEvidence;
  error?: string;
}> {
  return postAPI('/cockpit/browser/action', input);
}

export async function postCockpitBrowserRunbook(input: {
  sessionKey: string;
  script: string;
  stopOnError?: boolean;
  workItemId?: string;
  requestId?: string;
}): Promise<{
  success: boolean;
  browserSession?: string;
  stopOnError?: boolean;
  steps?: Array<Record<string, unknown>>;
  evidence?: CockpitBrowserEvidence[];
  currentUrl?: string;
  title?: string;
}> {
  return postAPI('/cockpit/browser/runbook', input);
}

export async function resolveCockpitEscalation(
  escalationId: string,
  input: {
    optionId?: string;
    freeformResponse?: string;
    note?: string;
  } = {}
): Promise<{ success: boolean; escalation?: Record<string, unknown>; result?: Record<string, unknown> }> {
  return postAPI(`/cockpit/escalations/${encodeURIComponent(escalationId)}/resolve`, input);
}

export async function postCockpitPacket(
  input: PostCockpitPacketInput
): Promise<{ success: boolean; packet?: Record<string, unknown> }> {
  return postAPI('/cockpit/packets', input);
}

export async function postCockpitSessionMessage(
  sessionKey: string,
  message: string
): Promise<{ success: boolean; requestId?: string; queued?: boolean }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/message`, { message });
}

export async function postCockpitSessionControl(
  sessionKey: string,
  input: CockpitSessionControlInput
): Promise<{ success: boolean; requestId?: string; targetSessionKey?: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/control`, input);
}

export async function postCockpitSessionReviewDecision(
  sessionKey: string,
  input: CockpitSessionReviewDecisionInput
): Promise<{ success: boolean; sessionKey: string; decision: string; fromStatus: string; toStatus: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/review`, input);
}

export async function applyCockpitPatch(
  input: CockpitPatchApplyInput
): Promise<{
  success: boolean;
  mode?: 'patch' | 'edits';
  files?: string[];
  changedLines?: number;
  warning?: string;
}> {
  return postAPI('/cockpit/patch/apply', input);
}

### function_call
@callId call_266b1aa3a2a2464c9f382ce5
@name Read
@ts 1770357081878
@workItemId 65beeb3a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":1400,"endLine":1600}

### function_call
@callId call_ff042a4ea486428585bd62d6
@name Grep
@ts 1770357081878
@workItemId 65beeb3a
{"pattern":"key.*1|key.*3|keydown|keyup","path":"packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_266b1aa3a2a2464c9f382ce5
@ts 1770357082664
@durationMs 5
@workItemId 65beeb3a
// Lines 1400-1600 of 2501 total
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

### function_call_output
@callId call_ff042a4ea486428585bd62d6
@ts 1770357082664
@durationMs 785
@workItemId 65beeb3a
packages/dashboard-control/src/App.tsx:127:13:      const key = rootMatch[1];
packages/dashboard-control/src/App.tsx:487:17:            <h1 key={idx} className="text-lg font-semibold text-[var(--text-primary)] mb-1">
packages/dashboard-control/src/App.tsx:628:23:          {row.sessionKey.slice(0, 12)} · {Math.floor(row.ageSec / 60)}m
packages/dashboard-control/src/App.tsx:854:41:      getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => []),
packages/dashboard-control/src/App.tsx:1573:13:    const onKeyDown = (event: KeyboardEvent) => {
packages/dashboard-control/src/App.tsx:1596:17:      if (event.key === '1') {
packages/dashboard-control/src/App.tsx:1604:17:      if (event.key === '3') {
packages/dashboard-control/src/App.tsx:1627:27:      const alpha = event.key.length === 1 && /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : null;
packages/dashboard-control/src/App.tsx:1667:29:        const delta = event.key === 'ArrowUp' ? -1 : 1;
packages/dashboard-control/src/App.tsx:1775:30:    window.addEventListener('keydown', onKeyDown);
packages/dashboard-control/src/App.tsx:1776:46:    return () => window.removeEventListener('keydown', onKeyDown);
packages/dashboard-control/src/App.tsx:2380:32:                          <div key={`${trace.id}-${file.path}`} className="font-mono text-[11px] text-[var(--text-secondary)] truncate">
packages/dashboard-control/src/App.tsx:2401:23:                    onKeyDown={(event) => {
packages/dashboard-control/src/App.tsx:2833:24:                  <div key={`${event.at}-${idx}`} className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${isFailure ? 'bg-[var(--error)]/5' : ''} ${isHighSignal ? 'bg-[var(--success)]/5' :

### function_call
@callId call_4ab9ac252fe14317aa3df933
@name PromptUser
@ts 1770357154261
@workItemId 65beeb3a
{"question":"I need to clarify some architectural decisions for the Markdown editor integration:\n\n**1. Markdown File Storage**\nWhere should markdown files be stored?\n- A) Browser localStorage/sessionStorage (client-side only)\n- B) Harness-daemon filesystem (server-side, persisted)\n- C) A new markdown-specific database table\n- D) Mix: Local filesystem + browser cache\n\n**2. Markdown Editor Library**\nWhich editor approach?\n- A) CodeMirror 6 (performant, extensible, VSCode-like)\n- B) Monaco Editor (full VSCode experience, heavier)\n- C) Simple textarea with react-markdown preview (lighter, less features)\n- D) UI library like EasyMDE or Markdown-it\n\n**3. Split Editor Behavior**\nWhat should the vertical split do?\n- A) View the same file in two panes (different scroll positions)\n- B) Edit two different files simultaneously\n- C) Edit + Preview split view\n\n**4. Chat + Markdown Sync Strategy**\nHow should agent edits sync?\n- A) Patches (like git diff/unified diff format)\n- B) Versioned documents with optimistic locking (version number on each save)\n- C) Full document replacement (simple but conflicts possible)\n\n**5. Default Keyboard Shortcuts**\nFor file operations:\n- A) Ctrl+N = New File, Ctrl+Shift+N = New Folder (VSCode standard)\n- B) Alt+N = New File, Alt+Shift+N = New Folder\n- C) Custom (specify)\n\n**6. File Organization**\nHow should files be organized?\n- A) Full hierarchy with nested folders\n- B) Single-level folders only\n- C) Flat list with tags/categories\n\nPlease answer each (A, B, C, or D, or specify):","questionType":"multiple_choice","options":[{"label":"Option A - Local storage / CodeMirror / Same file / Patches / VSCode shortcuts / Hierarchy","description":"Client-side storage with CodeMirror, same-file split view, patches, VSCode standard shortcuts, full folder hierarchy"},{"label":"Option B - Server-side / Monaco / Different files / Versioned / Custom / Flat","description":"Server storage with Monaco, different-file split, versioned docs, custom shortcuts, flat structure"},{"label":"Option C - Database / Simple textarea / Edit+Preview / Full replacement / Alt shortcuts / Single-level","description":"Database storage, simple editor, edit+preview split, full doc replacement, Alt shortcuts, single-level folders"},{"label":"Option D - Mix approach (will specify per question)","description":"I want to customize each decision separately"}],"multiSelect":false}

### function_call_output
@callId call_4ab9ac252fe14317aa3df933
@ts 1770357154261
@workItemId 65beeb3a
Waiting for user input...

### message:assistant
@ts 1770357154272
Let me explore a bit more to understand the current layout and identify what needs to change.

### message:system
@ts 1770357197398
These choices align with the 'silky, optimized' requirement and the Chat+markdown integration use case. Server-side storage enables the API endpoints mentioned in the goal. Versioned documents are simpler than patches but prevent race conditions.

### message:user
@ts 1770357197399
**Architecture Decisions:**

1. **Markdown File Storage**: B) Harness-daemon filesystem (server-side, persisted)
   - Rationale: Goal mentions API endpoint plumbing and sending/receiving markdown files. Server storage enables this. Harness-daemon is already present.

2. **Markdown Editor Library**: A) CodeMirror 6 (performant, extensible, VSCode-like)
   - Rationale: Goal demands 'silky, optimized' experience with VSCode-like behavior (Ctrl+`). CodeMirror 6 is production-proven, lighter than Monaco.

3. **Split Editor Behavior**: C) Edit + Preview split view
   - Rationale: Vertical split should show edit pane + live markdown preview. Supports Chat+markdown workflows where users can see rendered content while editing.

4. **Chat + Markdown Sync Strategy**: B) Versioned documents with optimistic locking (version number on each save)
   - Rationale: Simpler than patches, avoids conflicts of full replacement. Version numbers enable race condition detection.

5. **Default Keyboard Shortcuts**: A) Ctrl+N = New File, Ctrl+Shift+N = New Folder (VSCode standard)
   - Rationale: Goal references VSCode-style behavior. Standard shortcuts align with user expectations.

6. **File Organization**: A) Full hierarchy with nested folders
   - Rationale: Goal mentions 'create folders' and 'directory for your markdown files'. Hierarchy supports real-world document organization.

**Proceed with these decisions.**

### function_call
@callId call_cb15a1fbdaae4c99a8595eb8
@name Grep
@ts 1770357230077
@workItemId 4b090577
{"pattern":"LEFT_SECTIONS|RIGHT_SECTIONS|CENTER_TABS","path":"packages/dashboard-control/src/App.tsx"}

### function_call
@callId call_75906ada126847559c428e3b
@name Grep
@ts 1770357230077
@workItemId 4b090577
{"pattern":"control-plane|harness-daemon","path":"packages/harness-daemon/src"}

### function_call_output
@callId call_cb15a1fbdaae4c99a8595eb8
@ts 1770357230086
@durationMs 7
@workItemId 4b090577
packages/dashboard-control/src/App.tsx:51:7:const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'done', 'metrics'];
packages/dashboard-control/src/App.tsx:52:7:const RIGHT_SECTIONS: RightSection[] = ['queue', 'commits', 'prs'];
packages/dashboard-control/src/App.tsx:53:7:const CENTER_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
packages/dashboard-control/src/App.tsx:1612:49:          setLeftSection((current) => cycleList(LEFT_SECTIONS, current));
packages/dashboard-control/src/App.tsx:1616:50:          setRightSection((current) => cycleList(RIGHT_SECTIONS, current));
packages/dashboard-control/src/App.tsx:1620:46:          setFocusTab((current) => cycleList(CENTER_TABS, current));

### function_call_output
@callId call_75906ada126847559c428e3b
@ts 1770357230086
@durationMs 7
@workItemId 4b090577
packages/harness-daemon/src/index.ts:10:16:profiler.init('harness-daemon', './profile-daemon.json');
packages/harness-daemon/src/index.ts:13:19:  console.error('[harness-daemon] fatal error:', error);
packages/harness-daemon/src/harness/daemon.ts:86:19:    console.log(`[harness-daemon] No clients connected, will shutdown in ${this.idleTimeoutMs / 1000}s`);
packages/harness-daemon/src/harness/daemon.ts:90:23:        console.log('[harness-daemon] Idle timeout reached, shutting down');
packages/harness-daemon/src/harness/daemon.ts:98:19:    console.log(`[harness-daemon] Client connected: ${connectionId}`);
packages/harness-daemon/src/harness/daemon.ts:106:19:    console.log(`[harness-daemon] Client disconnected: ${connectionId}, remaining: ${remaining}`);
packages/harness-daemon/src/harness/daemon.ts:128:23:        console.log('[harness-daemon] Auth service initialized');
packages/harness-daemon/src/harness/daemon.ts:180:19:    console.log(`[harness-daemon] WebSocket bridge listening on ws://${wsAddress.host}:${wsAddress.port}`);
packages/harness-daemon/src/harness/daemon.ts:185:21:      console.log(`[harness-daemon] Dashboard available at http://${dashboardAddress.host}:${dashboardAddress.port}`);
packages/harness-daemon/src/harness/daemon.ts:289:33:                console.error('[harness-daemon] cockpit session message run failed', {
packages/harness-daemon/src/harness/daemon.ts:408:20:    console.warn('[harness-daemon] setDangerousMode() is deprecated - dangerous mode is now per-session. Use set_dangerous_mode command via bridge.');
packages/harness-daemon/src/harness/daemon.ts:430:21:      console.log('[harness-daemon] WARNING: Running in dangerous mode - all permission checks disabled');
packages/harness-daemon/src/harness/daemon.ts:457:17:  console.log(`[harness-daemon] bus listening on ${address.host}:${address.port}`);
packages/harness-daemon/src/harness/daemon.ts:460:19:    console.log(`[harness-daemon] received ${signal}, shutting down`);
packages/harness-daemon/src/harness/daemon.ts:471:21:    console.error('[harness-daemon] fatal error:', error);
packages/harness-daemon/src/harness/config_loader.ts:54:18: * In dev:  apps/harness-daemon/src/harness/config_loader.ts -> ../../../../
packages/harness-daemon/src/harness/config_loader.ts:55:18: * In dist: apps/harness-daemon/dist/harness/config_loader.js -> ../../../../
packages/harness-daemon/src/harness/config_loader.ts:60:53:  // Always 4 levels up: harness/ -> (src|dist)/ -> harness-daemon/ -> apps/ -> root
packages/harness-daemon/src/harness/auth_service.ts:2:21: * Auth service for harness-daemon.
packages/harness-daemon/src/harness/harness.ts:2413:32:  // Watcher Agent: LLM-backed control-plane hooks
...[truncated at 20 results]

### function_call
@callId call_558ec264d02046bdbc38c693
@name Read
@ts 1770357251003
@workItemId 4b090577
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call
@callId call_c41694e3790a43b596221c0d
@name Grep
@ts 1770357251003
@workItemId 4b090577
{"path":"packages/dashboard-control/package.json","pattern":"codemirror|monaco|markdown|react-markdown"}

### function_call_output
@callId call_558ec264d02046bdbc38c693
@ts 1770357251015
@durationMs 6
@workItemId 4b090577
/**
 * Control Plane API Routes for harness-daemon
 *
 * Provides REST endpoints for the Control Plane dashboard:
 * - Project/Session listing (from GraphD)
 * - Goal hierarchy (placeholder)
 * - Git integration via gh CLI
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GraphDManager } from 'graphd';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  parseSessionEscalations,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ControlPlaneContext {
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
  dispatchSessionInput?: (
    sessionKey: string,
    message: string
  ) => {
    success: boolean;
    requestId?: string;
    queued?: boolean;
    error?: string;
  };
  stopSession?: (
    sessionKey: string,
    note?: string
  ) => {
    success: boolean;
    requestId?: string;
    error?: string;
  };
  forkSession?: (
    sourceSessionKey: string,
    targetSessionKey?: string
  ) => {
    success: boolean;
    targetSessionKey?: string;
    error?: string;
  };
  resolveSessionEscalation?: (
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ) => {
    success: boolean;
    escalationId: string;
    pendingCount?: number;
    sessionStatus?: string;
    resumed?: boolean;
    resumeRequestId?: string;
    alreadyResolved?: boolean;
    error?: string;
  };
}

interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

interface GitRemote {
  owner: string;
  repo: string;
}

interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface SessionRow {
  sessionKey: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: number;
  lastAccessedAt: number;
  goal?: string | null;
  currentWorkItemId?: string | null;
  currentObjective?: string | null;
  lastUserMessagePreview?: string | null;
  metadata?: Record<string, unknown>;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

interface TraceSummary {
  filesTouched: number;
  lastFile?: string;
  lastLine?: number;
  latestTimestampMs?: number;
}

interface TestReportSummary {
  sessionKey: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  createdAtMs: number;
  invariantsPassed?: number;
  invariantsTotal?: number;
}

interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

interface TestReportRecord {
  id: string;
  session_key: string;
  work_item_id: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: unknown[];
  cases: unknown[];
  cli_output: string | null;
  command: string | null;
  coverage: Record<string, unknown> | null;
  mutation_score: number | null;
  agent_note: string | null;
  duration_ms: number | null;
  created_at: Date | string | number;
}

const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

interface SessionCommitEvent {
  sha: string;
  headSha: string;
  baseSha?: string;
  timestampMs: number;
  sessionKey: string;
  workItemId?: string;
}

interface PatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

type BrowserActionName =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'get_url'
  | 'get_title'
  | 'screenshot'
  | 'close';

interface BrowserActionInput {
  action: BrowserActionName;
  target?: string;
  text?: string;
  url?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
}

interface BrowserActionResult {
  success: boolean;
  action: BrowserActionName;
  args: string[];
  stdout?: string;
  data?: unknown;
  error?: string;
  artifactPath?: string;
}

interface BrowserRunbookStep {
  line: number;
  input: BrowserActionInput;
}

interface BrowserEvidenceItem {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const gitRemoteCache = new Map<string, { data: GitRemote | null; fetchedAt: number }>();
const GIT_CACHE_TTL_MS = 60 * 1000; // 1 minute
const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join('\n').trim();
  }
  if (!isRecord(value)) return undefined;
  return (
    extractText(value.text)
    ?? extractText(value.content)
    ?? extractText(value.message)
    ?? extractText(value.chunk)
    ?? extractText(value.response)
    ?? extractText(value.output)
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number
): number {
  const events = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let total = 0;
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'llm_call') continue;
    const ts = parseTimestampMs(entry.timestamp);
    if (!ts || ts < startMs || ts >= endMs) continue;
    const data = isRecord(entry.data) ? entry.data : {};
    const prompt = asNumber(data.prompt_tokens ?? data.promptTokens) ?? 0;
    const completion = asNumber(data.completion_tokens ?? data.completionTokens) ?? 0;
    total += prompt + completion;
  }
  return total;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Execute gh CLI command
 */
async function ghCommand(args: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      timeout: 30000,
      cwd,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (error) {
    console.error('[control-plane] gh command failed:', args, error);
    throw error;
  }
}

/**
 * Get PRs for a repository
 */
async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const result = await ghCommand(
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft,headRefName,baseRefName,body`
    );
    const prs: PRInfo[] = JSON.parse(result).map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.state as string).toLowerCase() as PRInfo['state'],
      author: (pr.author as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.url as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changedFiles as number) ?? 0,
      createdAt: pr.createdAt as string,
      updatedAt: pr.updatedAt as string,
      isDraft: (pr.isDraft as boolean) ?? false,
      headRefName: pr.headRefName as string,
      baseRefName: pr.baseRefName as string,
      body: pr.body as string,
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
  } catch {
    return [];
  }
}

/**
 * Parse git remote URL to extract owner/repo
 */
function parseGitRemote(remoteUrl: string): GitRemote | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Get git remote info for a project
 */
async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
  const cached = gitRemoteCache.get(projectPath);
  if (cached && Date.now() - cached.fetchedAt < GIT_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
      timeout: 5000,
    });
    const remote = parseGitRemote(stdout.trim());
    gitRemoteCache.set(projectPath, { data: remote, fetchedAt: Date.now() });
    return remote;
  } catch {
    gitRemoteCache.set(projectPath, { data: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Get recent commits for a project
 */
async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
  try {
    const { stdout } = await execAsync(
      `git log -${limit} --pretty=format:'{"sha":"%h","message":"%s","author":"%an","date":"%ci"}'`,
      { cwd: projectPath, timeout: 10000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Parse URL and extract path/query
 */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Route matcher for path patterns like /control-plane/projects/:id/features
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Format session row for API response
 */
function formatSession(row: SessionRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  const lastAccessedAt = row.lastAccessedAt ? new Date(row.lastAccessedAt * 1000).toISOString() : null;
  return {
    id: row.sessionKey,
    clientType: row.clientType,
    workingDir: row.workingDir,
    status: row.status,
    createdAt,
    lastAccessedAt,
    metadata: row.metadata,
  };
}

/**
 * Format message row for API response
 */
function formatMessage(row: MessageRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    requestId: row.requestId,
    createdAt,
    metadata: row.metadata,
  };
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

async function execFileText(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 15_000,
    maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
    encoding: 'utf8',
  } as any);
  return toStringOutput((result as any).stdout);
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function shaMatches(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const commits: SessionCommitEvent[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'git_commit') continue;
    const ts = parseTimestampMs(entry.timestamp);
    const data = isRecord(entry.data) ? entry.data : null;
    const sha = asString(data?.sha);
    if (!sha || !ts) continue;
    const headSha = asString(data?.head_sha) ?? asString(data?.headSha) ?? sha;
    const baseSha = asString(data?.base_sha) ?? asString(data?.baseSha);
    commits.push({
      sha: headSha,
      headSha,
      ...(baseSha ? { baseSha } : {}),
      timestampMs: ts,
      sessionKey: session.sessionKey,
      ...(asString(entry.work_item_id) ? { workItemId: asString(entry.work_item_id) } : {}),
    });
  }
  return commits.sort((a, b) => a.timestampMs - b.timestampMs);
}

function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
  for (const event of events) {
    if (shaMatches(event.sha, sha)) return event;
  }
  return undefined;
}

function getLatestRevisionRange(
  session: SessionRow,
  requestedHeadSha?: string
): { baseSha?: string; headSha?: string } {
  const commits = getSessionCommitEvents(session);
  if (commits.length === 0) {
    const metadata = session.metadata ?? {};
    const baseSha = asString(metadata.baseSha) ?? asString(metadata.base_sha);
    const headSha = requestedHeadSha
      ?? asString(metadata.headSha)
      ?? asString(metadata.head_sha)
      ?? asString(metadata.commitSha)
      ?? asString(metadata.commit_sha)
      ?? asString(metadata.revision);
    return { baseSha, headSha };
  }

  if (requestedHeadSha) {
    const index = commits.findIndex((entry) => shaMatches(entry.headSha, requestedHeadSha) || shaMatches(entry.sha, requestedHeadSha));
    if (index >= 0) {
      const matched = commits[index];
      return {
        ...(matched.baseSha
          ? { baseSha: matched.baseSha }
          : index > 0
            ? { baseSha: commits[index - 1].headSha }
            : {}),
        headSha: matched.headSha,
      };
    }
    return { headSha: requestedHeadSha };
  }

  const head = commits[commits.length - 1];
  return {
    ...(head.baseSha
      ? { baseSha: head.baseSha }
      : commits.length > 1
        ? { baseSha: commits[commits.length - 2].headSha }
        : {}),
    headSha: head.headSha,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type DiffLineRange = { start: number; end: number; added: number; deleted: number };

function parseLineRangesFromPatch(patch: string): Map<string, DiffLineRange[]> {
  const ranges = new Map<string, DiffLineRange[]>();
  const lines = patch.split('\n');
  let currentFile: string | null = null;
  let currentStart: number | null = null;
  let rangeAdded = 0;
  let rangeDeleted = 0;
  let lineNum = 0;

  for (const line of lines) {
    // Match file header: +++ b/path/to/file
    const fileMatch = line.match(/^\+\+\+\s+b\/(.+)/);
    if (fileMatch) {
      // Save previous range if exists
      if (currentFile && currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentFile = fileMatch[1].trim();
      currentStart = null;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && currentFile) {
      // Save previous range if exists
      if (currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum - 1, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentStart = parseInt(hunkMatch[1], 10);
      lineNum = currentStart;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Count additions and deletions
    if (currentStart !== null) {
      if (line.startsWith('+') && !line.startsWith('++')) {
        rangeAdded++;
        lineNum++;
      } else if (line.startsWith('-') && !line.startsWith('--')) {
        rangeDeleted++;
        // Don't increment lineNum for deletions
      } else if (line.startsWith(' ')) {
        lineNum++;
      }
    }
  }

  // Save final range
  if (currentFile && currentStart !== null) {
    const fileRanges = ranges.get(currentFile) || [];
    fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
    ranges.set(currentFile, fileRanges);
  }

  return ranges;
}

function parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');

  // Parse line ranges from patch if provided
  const lineRanges = patch ? parseLineRangesFromPatch(patch) : new Map<string, DiffLineRange[]>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    if (Number.isFinite(added)) totalAdded += added;
    if (Number.isFinite(deleted)) totalDeleted += deleted;
    filesTouched += 1;

    const hotspot: DiffHotspot = {
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    };

    // Add line ranges if available
    const fileRanges = lineRanges.get(path);
    if (fileRanges && fileRanges.length > 0) {
      // Add up to 3 most significant line ranges (most changes)
      const topRanges = fileRanges
        .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
        .slice(0, 3);
      if (topRanges.length > 0) {
        hotspot.lineRanges = topRanges;
      }
    }

    hotspots.push(hotspot);
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  return {
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched,
    },
    hotspots,
  };
}

function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
  const commits: CommitRollup[] = [];
  const lines = stdout.split('\n');
  let current: CommitRollup | null = null;

  for (const raw of lines) {
    if (raw.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const payload = raw.slice('__COMMIT__'.length);
      const [shaRaw, authorRaw, timeRaw, messageRaw] = payload.split('\u001f');
      const sha = (shaRaw ?? '').trim();
      const author = (authorRaw ?? '').trim();
      const time = (timeRaw ?? '').trim();
      const message = (messageRaw ?? '').trim();
      if (!sha || !time) {
        current = null;
        continue;
      }
      current = {
        sha,
        message,
        author: author || 'unknown',
        time,
        diffstat: { added: 0, deleted: 0, filesTouched: 0 },
        projectPath,
      };
      continue;
    }

    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    if (Number.isFinite(added)) current.diffstat.added += added;
    if (Number.isFinite(deleted)) current.diffstat.deleted += deleted;
    current.diffstat.filesTouched += 1;
  }
  if (current) commits.push(current);

  return commits;
}

async function loadSessionDiffstats(
  sessions: SessionRow[]
): Promise<Map<string, { added: number; deleted: number; filesTouched: number }>> {
  const bySession = new Map<string, { added: number; deleted: number; filesTouched: number }>();
  const cachedByRange = new Map<string, { added: number; deleted: number; filesTouched: number }>();

  for (const session of sessions) {
    const workingDir = session.workingDir;
    if (!workingDir) continue;
    const range = getLatestRevisionRange(session);
    if (!range.baseSha || !range.headSha) continue;
    const cacheKey = `${workingDir}\u001f${range.baseSha}\u001f${range.headSha}`;
    const cached = cachedByRange.get(cacheKey);
    if (cached) {
      bySession.set(session.sessionKey, cached);
      continue;
    }
    try {
      const numstat = await execFileText(
        'git',
        ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
        { cwd: workingDir, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const parsed = parseNumstatOutput(numstat).summary;
      cachedByRange.set(cacheKey, parsed);
      bySession.set(session.sessionKey, parsed);
    } catch {
      // Keep trace fallback when git diffstat is unavailable.
    }
  }

  return bySession;
}

function mapTestReportRow(row: TestReportRecord): Record<string, unknown> {
  const createdAtMs = row.created_at instanceof Date
    ? row.created_at.getTime()
    : parseTimestampMs(row.created_at) ?? Date.now();
  return {
    id: row.id,
    sessionKey: row.session_key,
    workItemId: row.work_item_id,
    verdict: row.verdict,
    categories: Array.isArray(row.categories) ? row.categories : [],
    cases: Array.isArray(row.cases) ? row.cases : [],
    cliOutput: row.cli_output ?? '',
    command: row.command ?? '',
    coverage: row.coverage ?? null,
    mutationScore: row.mutation_score ?? null,
    agentNote: row.agent_note ?? '',
    durationMs: row.duration_ms ?? 0,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function isLockfilePath(filePath: string): boolean {
  const name = filePath.trim().toLowerCase();
  return (
    name.endsWith('/package-lock.json') || name === 'package-lock.json'
    || name.endsWith('/yarn.lock') || name === 'yarn.lock'
    || name.endsWith('/pnpm-lock.yaml') || name === 'pnpm-lock.yaml'
    || name.endsWith('/bun.lock') || name === 'bun.lock'
    || name.endsWith('/bun.lockb') || name === 'bun.lockb'
    || name.endsWith('/cargo.lock') || name === 'cargo.lock'
  );
}

function normalizeDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/')
    ? trimmed.slice(2)
    : trimmed;
  return withoutPrefix.replace(/^"+|"+$/g, '');
}

function parsePatchStats(patch: string): {
  files: string[];
  changedLines: number;
  hasBinary: boolean;
} {
  const files = new Set<string>();
  let changedLines = 0;
  let hasBinary = false;
  const lines = patch.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      hasBinary = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim();
      if (candidate !== '/dev/null') {
        files.add(normalizeDiffPath(candidate));
      }
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      changedLines += 1;
    }
  }
  return { files: Array.from(files), changedLines, hasBinary };
}

function parsePatchEdits(value: unknown): PatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: PatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const filePath = asString(entry.path);
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!filePath || !startLine || !endLine || replacement === undefined) continue;
    edits.push({
      path: filePath,
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

async function resolveSessionFilePath(workingDir: string, relativePath: string): Promise<{
  resolvedPath?: string;
  relativePath?: string;
  error?: string;
}> {
  const path = await import('path');
  const baseDir = path.resolve(workingDir);
  const resolvedPath = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(baseDir, relativePath);
  const inWorkingDir = resolvedPath === baseDir || resolvedPath.startsWith(`${baseDir}${path.sep}`);
  if (!inWorkingDir) {
    return { error: 'Patch paths must resolve inside the session working directory' };
  }
  return {
    resolvedPath,
    relativePath: path.relative(baseDir, resolvedPath),
  };
}

async function enforcePatchConstraints(
  mode: 'patch' | 'edits',
  files: string[],
  changedLines: number
): Promise<{ ok: boolean; error?: string }> {
  if (files.length === 0) {
    return { ok: false, error: `No files detected in ${mode}` };
  }
  if (files.length > 3) {
    return { ok: false, error: `Patch exceeds file limit: ${files.length} > 3` };
  }
  if (changedLines > 30) {
    return { ok: false, error: `Patch exceeds changed-line limit: ${changedLines} > 30` };
  }
  for (const filePath of files) {
    if (isLockfilePath(filePath)) {
      return { ok: false, error: `Lockfile edits are blocked by default: ${filePath}` };
    }
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return { ok: false, error: `Unsafe path in patch: ${filePath}` };
    }
  }
  return { ok: true };
}

let agentBrowserAvailabilityCache: { available: boolean; checkedAtMs: number } | null = null;

function normalizeBrowserSessionName(sessionKey: string): string {
  const safe = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normalized = safe || 'session';
  return `cockpit-${normalized}`.slice(0, 72);
}

function sanitizeArtifactToken(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'artifact';
}

function browserTimestampToken(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function toActionError(action: BrowserActionName, message: string): { error: string } {
  return { error: `${action}: ${message}` };
}

function normalizeBrowserActionName(value: string | undefined): BrowserActionName | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'open') return 'open';
  if (normalized === 'back') return 'back';
  if (normalized === 'forward') return 'forward';
  if (normalized === 'reload') return 'reload';
  if (normalized === 'snapshot') return 'snapshot';
  if (normalized === 'click') return 'click';
  if (normalized === 'fill') return 'fill';
  if (normalized === 'type') return 'type';
  if (normalized === 'press') return 'press';
  if (normalized === 'wait') return 'wait';
  if (normalized === 'scroll') return 'scroll';
  if (normalized === 'get_url' || normalized === 'geturl') return 'get_url';
  if (normalized === 'get_title' || normalized === 'gettitle') return 'get_title';
  if (normalized === 'screenshot') return 'screenshot';
  if (normalized === 'close') return 'close';
  return null;
}

function parseBrowserActionInput(value: Record<string, unknown>): { input?: BrowserActionInput; error?: string } {
  const action = normalizeBrowserActionName(asString(value.action));
  if (!action) {
    return { error: 'Invalid browser action. Allowed: open, back, forward, reload, snapshot, click, fill, type, press, wait, scroll, get_url, get_title, screenshot, close.' };
  }

  const target = asString(value.target);
  const text = asString(value.text) ?? asString(value.value);
  const url = asString(value.url);
  const interactive = asBoolean(value.interactive);
  const compact = asBoolean(value.compact);
  const depth = asNumber(value.depth);
  const selector = asString(value.selector);
  const directionRaw = asString(value.direction)?.toLowerCase();
  const direction = directionRaw === 'up' || directionRaw === 'down' || directionRaw === 'left' || directionRaw === 'right'
    ? directionRaw
    : undefined;
  const pixels = asNumber(value.pixels);
  const waitMs = asNumber(value.waitMs ?? value.wait_ms);
  const label = asString(value.label);

  if (action === 'open' && !url) return toActionError(action, 'Missing required field: url');
  if (action === 'click' && !target) return toActionError(action, 'Missing required field: target');
  if ((action === 'fill' || action === 'type') && (!target || text === undefined)) {
    return toActionError(action, 'Missing required fields: target and text');
  }
  if (action === 'press' && !text && !target) {
    return toActionError(action, 'Missing required field: text (or target)');
  }
  if (action === 'wait' && waitMs === undefined && !target) {
    return toActionError(action, 'Missing required field: waitMs or target');
  }
  if (action === 'snapshot' && depth !== undefined && (depth < 1 || depth > 25)) {
    return toActionError(action, 'depth must be between 1 and 25');
  }
  if (action === 'scroll' && directionRaw && !direction) {
    return toActionError(action, 'direction must be one of up|down|left|right');
  }

  return {
    input: {
      action,
      ...(target ? { target } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(url ? { url } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
      ...(compact !== undefined ? { compact } : {}),
      ...(typeof depth === 'number' ? { depth: Math.floor(depth) } : {}),
      ...(selector ? { selector } : {}),
      ...(direction ? { direction } : {}),
      ...(typeof pixels === 'number' ? { pixels: Math.floor(pixels) } : {}),
      ...(typeof waitMs === 'number' ? { waitMs: Math.max(1, Math.floor(waitMs)) } : {}),
      ...(label ? { label } : {}),
    },
  };
}

function buildBrowserActionArgs(input: BrowserActionInput, artifactPath?: string): string[] {
  switch (input.action) {
    case 'open':
      return ['open', input.url ?? ''];
    case 'back':
      return ['back'];
    case 'forward':
      return ['forward'];
    case 'reload':
      return ['reload'];
    case 'snapshot': {
      const args = ['snapshot'];
      if (input.interactive) args.push('--interactive');
      if (input.compact) args.push('--compact');
      if (typeof input.depth === 'number') args.push('--depth', String(input.depth));
      if (input.selector) args.push('--selector', input.selector);
      return args;
    }
    case 'click':
      return ['click', input.target ?? ''];
    case 'fill':
      return ['fill', input.target ?? '', input.text ?? ''];
    case 'type':
      return ['type', input.target ?? '', input.text ?? ''];
    case 'press':
      return ['press', input.text ?? input.target ?? ''];
    case 'wait':
      return ['wait', String(input.waitMs ?? input.target ?? '1000')];
    case 'scroll': {
      const args = ['scroll', input.direction ?? 'down'];
      if (typeof input.pixels === 'number') args.push(String(input.pixels));
      return args;
    }
    case 'get_url':
      return ['get', 'url'];
    case 'get_title':
      return ['get', 'title'];
    case 'screenshot':
      return artifactPath ? ['screenshot', artifactPath] : ['screenshot'];
    case 'close':
      return ['close'];
  }
}

function summarizeBrowserData(data: unknown, maxChars = 1600): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') {
    return data.length > maxChars ? `${data.slice(0, maxChars)}...` : data;
  }
  try {
    const json = JSON.stringify(data);
    if (!json) return undefined;
    return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
  } catch {
    return undefined;
  }
}

function parseBrowserCliJson(raw: string): { success: boolean; data?: unknown; error?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const success = typeof parsed.success === 'boolean' ? parsed.success : true;
    const error = asString(parsed.error);
    return {
      success,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return null;
  }
}

async function checkAgentBrowserAvailable(workingDir: string): Promise<boolean> {
  const nowMs = Date.now();
  if (agentBrowserAvailabilityCache && nowMs - agentBrowserAvailabilityCache.checkedAtMs < 60_000) {
    return agentBrowserAvailabilityCache.available;
  }
  try {
    await execFileText('agent-browser', ['session', 'list', '--json'], {
      cwd: workingDir,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    agentBrowserAvailabilityCache = { available: true, checkedAtMs: nowMs };
    return true;
  } catch {
    agentBrowserAvailabilityCache = { available: false, checkedAtMs: nowMs };
    return false;
  }
}

async function allocateBrowserArtifactPath(
  workingDir: string,
  sessionKey: string,
  type: 'screenshots' | 'snapshots',
  ext: 'png' | 'json' = 'png',
  label?: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const baseDir = path.join(
    workingDir,
    '.cockpit',
    'browser',
    sanitizeArtifactToken(sessionKey),
    type
  );
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = browserTimestampToken();
  const suffix = label ? `_${sanitizeArtifactToken(label)}` : '';
  const fileName = `${stamp}${suffix}.${ext}`;
  const absolutePath = path.join(baseDir, fileName);
  const relativePath = path.relative(workingDir, absolutePath);
  return { absolutePath, relativePath };
}

function tokenizedRunbookLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseBrowserRunbook(script: string): { steps: BrowserRunbookStep[]; error?: string } {
  const lines = script.split('\n');
  const steps: BrowserRunbookStep[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = tokenizedRunbookLine(trimmed);
    if (tokens.length === 0) continue;
    const lineNo = idx + 1;
    const command = tokens[0].toLowerCase();

    const withInput = (input: BrowserActionInput) => {
      steps.push({ line: lineNo, input });
    };

    if (command === 'open') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: open requires a URL` };
      withInput({ action: 'open', url: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'click') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: click requires a target` };
      withInput({ action: 'click', target: tokens[1] });
      continue;
    }
    if (command === 'fill' || command === 'type') {
      if (!tokens[1] || tokens.length < 3) {
        return { steps: [], error: `Runbook line ${lineNo}: ${command} requires target + text` };
      }
      withInput({
        action: command,
        target: tokens[1],
        text: tokens.slice(2).join(' '),
      });
      continue;
    }
    if (command === 'press') {
      if (tokens.length < 2) return { steps: [], error: `Runbook line ${lineNo}: press requires a key` };
      withInput({ action: 'press', text: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'wait') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: wait requires milliseconds or a selector` };
      const waitMs = Number(tokens[1]);
      if (Number.isFinite(waitMs)) {
        withInput({ action: 'wait', waitMs: Math.max(1, Math.floor(waitMs)) });
      } else {
        withInput({ action: 'wait', target: tokens.slice(1).join(' ') });
      }
      continue;
    }
    if (command === 'scroll') {
      const direction = (tokens[1] ?? 'down').toLowerCase();
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return { steps: [], error: `Runbook line ${lineNo}: invalid scroll direction "${direction}"` };
      }
      const pixels = tokens[2] ? Number(tokens[2]) : undefined;
      withInput({
        action: 'scroll',
        direction,
        ...(Number.isFinite(pixels) ? { pixels: Math.floor(Number(pixels)) } : {}),
      });
      continue;
    }
    if (command === 'snapshot') {
      let interactive = false;
      let compact = false;
      let depth: number | undefined;
      let selector: string | undefined;
      for (let t = 1; t < tokens.length; t += 1) {
        const token = tokens[t];
        if (token === '-i' || token === '--interactive') {
          interactive = true;
          continue;
        }
        if (token === '-c' || token === '--compact') {
          compact = true;
          continue;
        }
        if ((token === '-d' || token === '--depth') && tokens[t + 1]) {
          const parsed = Number(tokens[t + 1]);
          if (Number.isFinite(parsed)) depth = Math.floor(parsed);
          t += 1;
          continue;
        }
        if ((token === '-s' || token === '--selector') && tokens[t + 1]) {
          selector = tokens[t + 1];
          t += 1;
        }
      }
      withInput({
        action: 'snapshot',
        interactive,
        compact,
        ...(typeof depth === 'number' ? { depth } : {}),
        ...(selector ? { selector } : {}),
      });
      continue;
    }
    if (command === 'screenshot') {
      withInput({
        action: 'screenshot',
        ...(tokens[1] ? { label: tokens.slice(1).join(' ') } : {}),
      });
      continue;
    }
    if (command === 'get') {
      const what = (tokens[1] ?? '').toLowerCase();
      if (what === 'url') {
        withInput({ action: 'get_url' });
        continue;
      }
      if (what === 'title') {
        withInput({ action: 'get_title' });
        continue;
      }
      return { steps: [], error: `Runbook line ${lineNo}: get supports only "url" or "title"` };
    }
    if (command === 'back' || command === 'forward' || command === 'reload' || command === 'close') {
      withInput({ action: command });
      continue;
    }

    return { steps: [], error: `Runbook line ${lineNo}: unsupported command "${tokens[0]}"` };
  }

  if (steps.length === 0) {
    return { steps: [], error: 'Runbook is empty. Add at least one command.' };
  }
  if (steps.length > 40) {
    return { steps: [], error: `Runbook exceeds step limit: ${steps.length} > 40` };
  }
  return { steps };
}

function buildBrowserEvidenceId(sessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bev_${sanitizeArtifactToken(sessionKey)}_${Date.now().toString(36)}_${suffix}`;
}

function parseBrowserEvidence(value: unknown): BrowserEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const evidence: BrowserEvidenceItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const typeRaw = asString(entry.type);
    const type = typeRaw === 'snapshot' ? 'snapshot' : typeRaw === 'screenshot' ? 'screenshot' : null;
    const artifactPath = asString(entry.path);
    const createdAt = asString(entry.createdAt);
    if (!id || !type || !artifactPath || !createdAt) continue;
    evidence.push({
      id,
      type,
      path: artifactPath,
      createdAt,
      ...(asString(entry.label) ? { label: asString(entry.label) } : {}),
      ...(asString(entry.url) ? { url: asString(entry.url) } : {}),
      ...(asString(entry.title) ? { title: asString(entry.title) } : {}),
    });
  }
  return evidence.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function runBrowserAction(
  workingDir: string,
  browserSession: string,
  sessionKey: string,
  input: BrowserActionInput
): Promise<BrowserActionResult> {
  let artifactPath: string | undefined;
  let snapshotArtifactAbsPath: string | undefined;
  if (input.action === 'screenshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'screenshots',
      'png',
      input.label
    );
    artifactPath = artifact.relativePath;
    const args = buildBrowserActionArgs(input, artifact.absolutePath);
    const result = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
      cwd: workingDir,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    } as any).then((output) => ({
      stdout: toStringOutput((output as any).stdout),
      stderr: toStringOutput((output as any).stderr),
      error: null as Error | null,
    })).catch((error) => ({
      stdout: toStringOutput((error as any).stdout),
      stderr: toStringOutput((error as any).stderr),
      error: error as Error,
    }));
    const parsed = parseBrowserCliJson(result.stdout) ?? parseBrowserCliJson(result.stderr);
    if (parsed) {
      if (parsed.success) {
        return {
          success: true,
          action: input.action,
          args,
          stdout: result.stdout,
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          ...(artifactPath ? { artifactPath } : {}),
        };
      }
      return {
        success: false,
        action: input.action,
        args,
        stdout: result.stdout,
        error: parsed.error ?? result.error?.message ?? 'Browser command failed',
      };
    }
    return {
      success: !result.error,
      action: input.action,
      args,
      stdout: result.stdout || result.stderr,
      ...(result.error ? { error: result.error.message || result.stderr || 'Browser command failed' } : {}),
      ...(artifactPath && !result.error ? { artifactPath } : {}),
    };
  }

  if (input.action === 'snapshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'snapshots',
      'json'
    );
    snapshotArtifactAbsPath = artifact.absolutePath;
    artifactPath = artifact.relativePath;
  }

  const args = buildBrowserActionArgs(input);
  const rawResult = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
    cwd: workingDir,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  } as any).then((output) => ({
    stdout: toStringOutput((output as any).stdout),
    stderr: toStringOutput((output as any).stderr),
    error: null as Error | null,
  })).catch((error) => ({
    stdout: toStringOutput((error as any).stdout),
    stderr: toStringOutput((error as any).stderr),
    error: error as Error,
  }));

  const parsed = parseBrowserCliJson(rawResult.stdout) ?? parseBrowserCliJson(rawResult.stderr);
  if (parsed && parsed.success && input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    await fs.writeFile(snapshotArtifactAbsPath, JSON.stringify(parsed.data ?? {}, null, 2), 'utf8').catch(() => {});
  }
  if (parsed) {
    return {
      success: parsed.success,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.success && artifactPath ? { artifactPath } : {}),
    };
  }

  if (rawResult.error) {
    return {
      success: false,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      error: rawResult.error.message || rawResult.stderr || 'Browser command failed',
    };
  }
  if (input.action === 'snapshot' && snapshotArtifactAbsPat
... [truncated 50040 chars]

### function_call_output
@callId call_c41694e3790a43b596221c0d
@ts 1770357251015
@durationMs 5
@workItemId 4b090577
No matches found for pattern: codemirror|monaco|markdown|react-markdown

### function_call
@callId call_532560d0641c46ec80b656ef
@name Read
@ts 1770357260489
@workItemId 4b090577
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/package.json"}

### function_call
@callId call_7313a7276a7c4e1ca093cb43
@name Grep
@ts 1770357260489
@workItemId 4b090577
{"path":"packages/harness-daemon/src/harness","pattern":"registerRoute|router|handleControlPlane"}

### function_call_output
@callId call_532560d0641c46ec80b656ef
@ts 1770357260501
@durationMs 2
@workItemId 4b090577
{
  "name": "dashboard-control",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "bunx --bun vite",
    "build": "bunx --bun vite build",
    "typecheck": "bunx tsc --noEmit",
    "preview": "bunx --bun vite preview"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.18",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.1",
    "autoprefixer": "^10.4.23",
    "postcss": "^8.5.6",
    "tailwindcss": "^4.1.18",
    "typescript": "~5.9.3",
    "vite": "^7.2.4"
  }
}

### function_call_output
@callId call_7313a7276a7c4e1ca093cb43
@ts 1770357260501
@durationMs 10
@workItemId 4b090577
packages/harness-daemon/src/harness/control_plane_routes.ts:2650:17:export function handleControlPlaneRequest(
packages/harness-daemon/src/harness/daemon.ts:18:10:import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';
packages/harness-daemon/src/harness/daemon.ts:353:11:      if (handleControlPlaneRequest(req, res, controlPlaneCtx)) {

### function_call
@callId call_12648d16f7984c0c847d5c88
@name PromptUser
@ts 1770357282691
@workItemId 4b090577
{"question":"I need to clarify a few key implementation details:\n\n**1. Markdown File Storage Location**\nWhere should markdown files be stored on the server?\n- A) In each session's working directory (e.g., `.cockpit/markdown/`)\n- B) In a centralized markdown workspace (e.g., `~/cockpit-markdown/`)\n- C) In the repository root under a `docs/` folder\n\n**2. \"Done\" Sessions to Right Side**\nCurrently LEFT_SECTIONS is ['running', 'ready', 'done', 'metrics']. Should:\n- A) Move 'done' from left to right sections completely (LEFT: ['running', 'ready', 'metrics'], RIGHT: ['queue', 'done', 'commits', 'prs'])\n- B) Keep 'done' in both left and right (as a reference)\n- C) Different organization?\n\n**3. Initial Loading Behavior**\n\"Screen should load without a session selected with a blank markdown file\" means:\n- A) Default view is Markdown editor, session panels are hidden until user presses 1 or 3\n- B) Markdown editor replaces the center panel's default state, but side panels still visible\n- C) Create a special \"markdown-only\" mode that can be toggled\n\n**4. Chat + Markdown Context**\nWhen chatting \"about Document\", what context should the agent receive?\n- A) Current markdown file content sent as context to agent\n- B) Agent has access to markdown file path via filesystem tools\n- C) Both: content as context + filesystem access\n\n**5. Version Numbers**\nHow should versioning work?\n- A) Increment a number on each save (stored in file metadata)\n- B) Use git commit SHA when file is under version control\n- C) Custom version string (e.g., timestamp-based)\n\nPlease answer each question (A, B, C):","questionType":"multiple_choice","options":[{"label":"Option A for all questions","description":"Session working directory, move done to right, markdown-only mode, content+filesystem, increment number"},{"label":"Option B for all questions","description":"Centralized workspace, done in both, replaces center panel, filesystem only, git SHA"},{"label":"Option C for all questions","description":"Repository docs folder, different org, toggle-able mode, both content+git, timestamp version"},{"label":"Mixed - I'll specify per question","description":"I want to customize each decision separately"}],"multiSelect":false}

### function_call_output
@callId call_12648d16f7984c0c847d5c88
@ts 1770357282691
@workItemId 4b090577
Waiting for user input...

### message:system
@ts 1770357333653
These choices support a centralized, session-agnostic markdown workspace that serves as the dashboard's primary interface. The initial markdown-only view creates a clean entry point, while keyboard shortcuts (1/3/Ctrl+`) enable rapid panel access. Both content context and filesystem access give the agent full capabilities for the Chat+markdown integration use case.

### message:user
@ts 1770357333654
**Implementation Decisions:**

**1. Markdown File Storage Location:** Option B - Centralized markdown workspace (e.g., `~/cockpit-markdown/`)
   - Rationale: Enables cross-session document access, aligns with first-class status, and separates user documents from session-specific data. Centralized location makes directory navigation and folder/file creation UI more coherent.

**2. "Done" Sessions to Right Side:** Option A - Move 'done' from left to right completely
   - LEFT_SECTIONS: ['running', 'ready', 'metrics']
   - RIGHT_SECTIONS: ['queue', 'done', 'commits', 'prs']
   - Rationale: Goal explicitly says "Move the 'Done' Sessions to the right Side" - this is a clear directive to relocate, not duplicate.

**3. Initial Loading Behavior:** Option A - Default view is Markdown editor, session panels hidden until user presses 1 or 3
   - Rationale: Goal says "screen should load without a session selected with a blank markdown file directly in the browser" - this implies markdown is the primary initial state. The panels are accessible via keyboard shortcuts (1/3) as specified.

**4. Chat + Markdown Context:** Option C - Both: content as context + filesystem access
   - Rationale: Goal mentions "Chat about Document" and "Chat + markdown edits" use cases. Having both immediate content (for fast context) and filesystem access (for persistence, navigation, and more complex operations) provides maximum flexibility for the agent.

**5. Version Numbers:** Option A - Increment a number on each save (stored in file metadata)
   - Rationale: Simple, predictable, doesn't require the files to be in a git repository. The metadata version can support the patch-based updates mentioned in the goal ("we should probably support Patches to our markdown files") without overcomplicating.

### message:system
@ts 1770357453662
[Escalation esc_0a7979861cf949a38085251fdb4b628a] Awaiting cockpit resolution.

### message:system
@ts 1770357453663
[escalation:esc_0a7979861cf949a38085251fdb4b628a] Oversight unavailable (Watcher timeout after 120000ms): Insufficient evidence to allow

### function_call
@callId call_6d9f8b13169a4de9a3e06b94
@name Read
@ts 1770357467190
@workItemId 59a8532e
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":1700,"endLine":1900}

### function_call
@callId call_12e07b33b99d4cc7821d4aeb
@name Grep
@ts 1770357467190
@workItemId 59a8532e
{"path":"packages/dashboard-control/src/App.tsx","pattern":"panelFocus|setPanelFocus"}

### function_call_output
@callId call_6d9f8b13169a4de9a3e06b94
@ts 1770357467409
@durationMs 4
@workItemId 59a8532e
// Lines 1700-1900 of 2501 total
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

### function_call_output
@callId call_12e07b33b99d4cc7821d4aeb
@ts 1770357467409
@durationMs 215
@workItemId 59a8532e
packages/dashboard-control/src/App.tsx:45:6:type PanelFocus = 'left' | 'center' | 'right' | 'input';
packages/dashboard-control/src/App.tsx:757:10:  const [panelFocus, setPanelFocus] = useState<PanelFocus>('left');
packages/dashboard-control/src/App.tsx:1589:9:        setPanelFocus('input');
packages/dashboard-control/src/App.tsx:1597:9:        setPanelFocus('left');
packages/dashboard-control/src/App.tsx:1601:9:        setPanelFocus('center');
packages/dashboard-control/src/App.tsx:1605:9:        setPanelFocus('right');
packages/dashboard-control/src/App.tsx:1611:13:        if (panelFocus === 'left') {
packages/dashboard-control/src/App.tsx:1615:13:        if (panelFocus === 'right') {
packages/dashboard-control/src/App.tsx:1619:13:        if (panelFocus === 'center') {
packages/dashboard-control/src/App.tsx:1623:9:        setPanelFocus('left');
packages/dashboard-control/src/App.tsx:1628:20:      if (alpha && panelFocus === 'left') {
packages/dashboard-control/src/App.tsx:1648:20:      if (alpha && panelFocus === 'right') {
packages/dashboard-control/src/App.tsx:1668:13:        if (panelFocus === 'left') {
packages/dashboard-control/src/App.tsx:1692:13:        if (panelFocus === 'right') {
packages/dashboard-control/src/App.tsx:1719:13:        if (panelFocus === 'left') {
packages/dashboard-control/src/App.tsx:1734:13:        if (panelFocus === 'right') {
packages/dashboard-control/src/App.tsx:1778:5:    panelFocus,
packages/dashboard-control/src/App.tsx:1868:26:          onClick={() => setPanelFocus('left')}
packages/dashboard-control/src/App.tsx:1870:13:            panelFocus === 'left' ? 'ring-1 ring-[var(--accent-cyan)]' : ''
packages/dashboard-control/src/App.tsx:1894:23:                  || (panelFocus === 'left' && leftSection === 'running' && runningSessions[leftSelection.running]?.sessionKey === row.sessionKey)
...[truncated at 20 results]

### function_call
@callId call_e120ce5240564c4fa03a761c
@name Read
@ts 1770357544261
@workItemId 59a8532e
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/daemon.ts","startLine":1,"endLine":100}

### function_call_output
@callId call_e120ce5240564c4fa03a761c
@ts 1770357544265
@durationMs 2
@workItemId 59a8532e
// Lines 1-100 of 475 total
/**
 * Harness daemon entrypoint for JSONL/TCP bridge.
 *
 * Supports:
 * - TCP/JSONL bus for client connections (TUI, external integrations via harness-client)
 */

import { pathToFileURL, fileURLToPath } from 'url';
import { createServer as createHttpServer, type Server as HttpServerType, type IncomingMessage, type ServerResponse } from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer, WsBridgeServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromConfig, type AuthService } from './auth_service.js';
import { translateAgentEvent } from './event_translator.js';
import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  /** WebSocket port for browser dashboard access (default: port + 1, e.g., 9556) */
  wsPort?: number;
  /** HTTP port for serving the Control Plane dashboard. Set to enable dashboard serving. */
  dashboardPort?: number;
  /** Path to dashboard static files (default: auto-detect dashboard-control/dist) */
  dashboardPath?: string;
  workingDir?: string;
  configPath?: string;
  /** Idle timeout in ms before daemon shuts down when no clients connected. Set to 0 to disable. */
  idleTimeoutMs?: number;
  /** Dangerous mode - bypasses all permission checks. Use with extreme caution. */
  dangerousMode?: boolean;
}

// Default idle timeout: 5 seconds
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly wsPort: number;
  private readonly dashboardPort?: number;
  private readonly dashboardPath?: string;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly idleTimeoutMs: number;
  private readonly dangerousMode: boolean;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private wsBridge: WsBridgeServer | null = null;
  private dashboardServer: HttpServerType | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;
  private authConfig: { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    const rawPort = options.port ?? 9555;
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.wsPort = options.wsPort ?? this.port + 1; // Default: 9556
    this.dashboardPort = options.dashboardPort;
    this.dashboardPath = options.dashboardPath;
    this.workingDir = options.workingDir ?? process.cwd();
    this.configPath = options.configPath;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.dangerousMode = options.dangerousMode ?? false;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startIdleTimer(): void {
    if (this.idleTimeoutMs <= 0 || this.shutdownRequested) return;

    this.cancelIdleTimer();
    console.log(`[harness-daemon] No clients connected, will shutdown in ${this.idleTimeoutMs / 1000}s`);

    this.idleTimer = setTimeout(() => {
      if (this.bus && this.bus.getConnectionCount() === 0) {
        console.log('[harness-daemon] Idle timeout reached, shutting down');
        this.shutdownRequested = true;
        void this.stop().then(() => process.exit(0));
      }
    }, this.idleTimeoutMs);
  }

  private handleConnect(connectionId: string): void {
    console.log(`[harness-daemon] Client connected: ${connectionId}`);
    this.cancelIdleTimer();
  }

### message:assistant
@ts 1770357619897
Now I have sufficient context to create a comprehensive plan. Let me produce the handoffSpec.

### message:user
@ts 1770358074916
continue
