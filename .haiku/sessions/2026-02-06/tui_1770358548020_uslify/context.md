---
session: tui_1770358548020_uslify
created: 2026-02-06T06:15:48.020Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770358649690
reduce the size of the header in the Sessions view in the control dashboard. remove what isn't necessary including the Show Preview, the session control stuff. Then make sure the tool call status doesn't get stale. Finally, do not show any of the hook_call, iteration_started, llm_call, memory_injected or any of those kind of events. We do not need those slowing down the server and the UI. 

### function_call
@callId call_c8b246eb6e244ac69c10c5ba
@name explorer
@ts 1770358657073
@workItemId 5040fed0
{"objective":"Find the Sessions view in the control dashboard. Look for:\n1. The header component in Sessions view\n2. Show Preview and session control components\n3. Where tool call status is displayed\n4. Where events like hook_call, iteration_started, llm_call, memory_injected are shown","delta":"Understanding the Sessions view structure to identify what needs to be reduced/removed"}

### function_call_output
@callId call_c8b246eb6e244ac69c10c5ba
@ts 1770358754948
@isError true
@durationMs 97874
@workItemId 5040fed0
Sub-agent 'explorer' failed (reason: invalid_action): Explorer read 4 files but extracted 0 artifacts. This is a hard failure. Every file read MUST produce artifacts. Files read: /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionsView.tsx, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionList.tsx, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/TracesView.tsx, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx
Tools called: 11 (8 succeeded, 3 failed)
Tool errors: Glob: Tool execution timed out after 15000ms; Glob: Tool execution timed out after 15000ms; Glob: Tool execution timed out after 15000ms
Partial output:
I'll help you find the Sessions view in the control dashboard and locate all the components you mentioned. Let me start by exploring the codebase structure.

### function_call
@callId call_d88ef44ebc764fbba12a14ac
@name Read
@ts 1770358762240
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionsView.tsx"}

### function_call
@callId call_906c468a23034ec4ad215b88
@name Read
@ts 1770358762240
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionList.tsx"}

### function_call
@callId call_78bf11b8b1e746f39c58920b
@name Read
@ts 1770358762240
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/TracesView.tsx"}

### function_call_output
@callId call_d88ef44ebc764fbba12a14ac
@ts 1770358762243
@durationMs 0
@workItemId 5040fed0
/**
 * Sessions View - Dense multi-session management
 *
 * Shows live sessions with key metrics: patches, tool calls, status.
 * Optimized for managing many async agents at once.
 */

import { useState } from 'react';
import type { Session } from '@/lib/api';
import { getSessionMessages, type Message } from '@/lib/api';

interface SessionsViewProps {
  sessions: Session[];
  liveSessions: Session[];
  loading: boolean;
  onRefresh: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function StatusDot({ status, lastAccess }: { status: string; lastAccess: string }) {
  const lastAccessTime = new Date(lastAccess).getTime();
  const isRecent = Date.now() - lastAccessTime < 5 * 60 * 1000;
  const isLive = status === 'active' || isRecent;

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${isLive ? 'bg-[var(--live)] pulse-live' : 'bg-[var(--text-muted)]'}`}
      title={isLive ? 'Live' : 'Inactive'}
    />
  );
}

function SessionRow({
  session,
  isExpanded,
  onToggle,
}: {
  session: Session;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const handleToggle = async () => {
    if (!isExpanded && messages.length === 0) {
      setLoadingMsgs(true);
      try {
        const msgs = await getSessionMessages(session.id);
        setMessages(msgs);
      } catch {
        // ignore
      } finally {
        setLoadingMsgs(false);
      }
    }
    onToggle();
  };

  const projectName = session.workingDir?.split('/').pop() || 'unknown';
  const meta = session.metadata || {};
  const toolCalls = (meta.tool_calls as number) || 0;
  const edits = (meta.edits as number) || 0;
  const model = (meta.model as string)?.split('/').pop()?.slice(0, 12) || '';


  return (
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      <button
        onClick={handleToggle}
        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        <StatusDot status={session.status} lastAccess={session.lastAccessedAt} />
        <span className="text-[var(--text-primary)] font-medium truncate min-w-0 w-24">
          {projectName}
        </span>
        <span className="text-[var(--text-muted)] text-xs w-16">
          {session.clientType}
        </span>
        <span className="text-[var(--accent-cyan)] text-xs w-20">
          {model}
        </span>
        <span className="text-[var(--text-muted)] text-xs flex gap-2 w-24">
          {toolCalls > 0 && <span title="Tool calls">🔧{toolCalls}</span>}
          {edits > 0 && <span title="Edits">✏️{edits}</span>}
        </span>
        <span className="text-[var(--text-muted)] text-xs w-12 text-right">
          {relativeTime(session.lastAccessedAt)}
        </span>
        <span className="text-[var(--text-muted)] ml-auto text-xs font-mono truncate max-w-48">
          {session.id.slice(0, 16)}
        </span>
        <svg
          className={`w-3 h-3 text-[var(--text-muted)] transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-2 py-2 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs mb-2">
            <span className="text-[var(--text-muted)]">Path:</span>
            <span className="text-[var(--text-secondary)] font-mono truncate">{session.workingDir}</span>
            <span className="text-[var(--text-muted)]">Created:</span>
            <span className="text-[var(--text-secondary)]">{new Date(session.createdAt).toLocaleString()}</span>
            <span className="text-[var(--text-muted)]">Session:</span>
            <span className="text-[var(--text-secondary)] font-mono">{session.id}</span>
          </div>

          {loadingMsgs ? (
            <div className="text-xs text-[var(--text-muted)]">Loading...</div>
          ) : messages.length > 0 ? (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              <div className="text-xs text-[var(--text-muted)] mb-1">
                {messages.length} messages
              </div>
              {messages.slice(-10).map((msg) => (
                <div
                  key={msg.id}
                  className={`px-2 py-1 rounded text-xs ${
                    msg.role === 'user'
                      ? 'bg-[var(--running)]/10 border-l border-[var(--running)]'
                      : 'bg-[var(--bg-surface)]'
                  }`}
                >
                  <span className="text-[var(--text-muted)]">{msg.role}:</span>{' '}
                  <span className="text-[var(--text-secondary)]">
                    {msg.content.slice(0, 200)}{msg.content.length > 200 && '...'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">No messages</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionsView({ sessions, liveSessions, loading }: SessionsViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'live'>('live');

  const displaySessions = filter === 'live' ? liveSessions : sessions;

  return (
    <div className="h-full flex flex-col">
      {/* Filters */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex gap-1 text-xs">
          <button
            onClick={() => setFilter('live')}
            className={`px-2 py-0.5 rounded ${
              filter === 'live'
                ? 'bg-[var(--live)]/20 text-[var(--live)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Live ({liveSessions.length})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-2 py-0.5 rounded ${
              filter === 'all'
                ? 'bg-[var(--running)]/20 text-[var(--running)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            All ({sessions.length})
          </button>
        </div>
        <div className="text-xs text-[var(--text-muted)] ml-auto">
          {filter === 'live' && liveSessions.length === 0 && 'No active sessions'}
        </div>
      </div>

      {/* Sessions List */}
      <div className="flex-1 bg-[var(--bg-surface)] rounded border border-[var(--border-subtle)] overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-[var(--text-muted)] text-center">Loading...</div>
        ) : displaySessions.length === 0 ? (
          <div className="p-4 text-center">
            <div className="text-xs text-[var(--text-muted)]">
              {filter === 'live'
                ? 'No live sessions. Start a TUI session to see it here.'
                : 'No sessions found.'}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 opacity-60">
              Sessions appear here when agents are actively working.
            </div>
          </div>
        ) : (
          displaySessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isExpanded={expandedId === session.id}
              onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
            />
          ))
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--live)]" /> Live
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--text-muted)]" /> Inactive
        </span>
      </div>
    </div>
  );
}


### function_call_output
@callId call_906c468a23034ec4ad215b88
@ts 1770358762243
@durationMs 1
@workItemId 5040fed0
/**
 * Session List - Display all sessions from GraphD
 */

import { useState } from 'react';
import type { Session } from '@/lib/api';
import { getSessionMessages, type Message } from '@/lib/api';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return `${days} days ago`;
  }
  return date.toLocaleDateString();
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/20 text-green-400',
    inactive: 'bg-yellow-500/20 text-yellow-400',
    closed: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${colors[status] || colors.closed}`}>
      {status}
    </span>
  );
}

function SessionCard({
  session,
  expanded,
  onToggle,
}: {
  session: Session;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const handleToggle = async () => {
    if (!expanded && messages.length === 0) {
      setLoadingMessages(true);
      try {
        const msgs = await getSessionMessages(session.id);
        setMessages(msgs);
      } catch (e) {
        console.error('Failed to load messages:', e);
      } finally {
        setLoadingMessages(false);
      }
    }
    onToggle();
  };

  const projectName = session.workingDir?.split('/').pop() || 'Unknown';

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <svg
            className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{projectName}</span>
              <StatusBadge status={session.status} />
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              {session.clientType} · {formatDate(session.lastAccessedAt)}
            </div>
          </div>
        </div>
        <div className="text-xs text-[var(--text-muted)] font-mono">
          {session.id.slice(0, 20)}...
        </div>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-[var(--border-subtle)] p-4">
          {/* Session Details */}
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div>
              <div className="text-xs text-[var(--text-muted)] mb-1">Working Directory</div>
              <div className="text-[var(--text-secondary)] font-mono text-xs truncate">
                {session.workingDir || 'N/A'}
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)] mb-1">Created</div>
              <div className="text-[var(--text-secondary)]">
                {new Date(session.createdAt).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Messages */}
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-2">
              Messages ({messages.length})
            </div>
            {loadingMessages ? (
              <div className="text-sm text-[var(--text-muted)] py-2">Loading messages...</div>
            ) : messages.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)] py-2">No messages</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {messages.slice(0, 20).map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-2 rounded text-sm ${
                      msg.role === 'user'
                        ? 'bg-blue-500/10 border-l-2 border-blue-500'
                        : 'bg-[var(--bg-elevated)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-[var(--text-muted)]">
                        {msg.role}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {formatDate(msg.createdAt)}
                      </span>
                    </div>
                    <div className="text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-3">
                      {msg.content.slice(0, 500)}
                      {msg.content.length > 500 && '...'}
                    </div>
                  </div>
                ))}
                {messages.length > 20 && (
                  <div className="text-xs text-[var(--text-muted)] py-2">
                    + {messages.length - 20} more messages
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionList({ sessions, loading }: SessionListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        No sessions found. Start a TUI session to see it here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          expanded={expandedId === session.id}
          onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
        />
      ))}
    </div>
  );
}


### function_call_output
@callId call_78bf11b8b1e746f39c58920b
@ts 1770358762244
@durationMs 1
@workItemId 5040fed0
/**
 * Traces View - Git commit traces with AI attribution
 *
 * Shows agent-trace records tied to git commits.
 * Each trace shows which files were modified by which model/session.
 */

import { useState } from 'react';
import type { TraceRecord } from '@/lib/api';

interface TracesViewProps {
  traces: TraceRecord[];
  loading: boolean;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function TraceCard({ trace, isExpanded, onToggle }: { trace: TraceRecord; isExpanded: boolean; onToggle: () => void }) {
  const totalLines = trace.files.reduce((sum, f) =>
    sum + f.conversations.reduce((s, c) =>
      s + c.ranges.reduce((r, range) => r + (range.end_line - range.start_line + 1), 0), 0), 0);

  const models = new Set<string>();
  trace.files.forEach(f =>
    f.conversations.forEach(c => {
      if (c.contributor.model_id) models.add(c.contributor.model_id.split('/').pop() || 'unknown');
    })
  );

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        <span className="font-mono text-[var(--accent-cyan)] text-xs w-16 shrink-0">
          {trace.vcs.revision.slice(0, 7)}
        </span>
        <span className="text-[var(--text-primary)] text-xs truncate flex-1">
          {trace.files.length} file{trace.files.length !== 1 ? 's' : ''} · {totalLines} lines
        </span>
        <span className="text-[var(--accent-violet)] text-xs truncate max-w-32">
          {Array.from(models).join(', ')}
        </span>
        <span className="text-[var(--text-muted)] text-xs w-16 text-right shrink-0">
          {relativeTime(trace.timestamp)}
        </span>
        <svg
          className={`w-3 h-3 text-[var(--text-muted)] transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-2 py-2 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs mb-2">
            <span className="text-[var(--text-muted)]">Revision:</span>
            <span className="text-[var(--text-secondary)] font-mono">{trace.vcs.revision}</span>
            <span className="text-[var(--text-muted)]">Tool:</span>
            <span className="text-[var(--text-secondary)]">{trace.tool.name} v{trace.tool.version}</span>
            <span className="text-[var(--text-muted)]">Time:</span>
            <span className="text-[var(--text-secondary)]">{new Date(trace.timestamp).toLocaleString()}</span>
          </div>

          <div className="text-xs text-[var(--text-muted)] mb-1">Files modified:</div>
          <div className="space-y-1">
            {trace.files.map((file, i) => (
              <div key={i} className="bg-[var(--bg-surface)] rounded px-2 py-1">
                <div className="font-mono text-[var(--text-primary)] text-xs truncate">
                  {file.path}
                </div>
                {file.conversations.map((conv, j) => (
                  <div key={j} className="flex items-center gap-2 mt-1 text-xs">
                    <span className="text-[var(--accent-violet)]">
                      {conv.contributor.model_id?.split('/').pop() || 'ai'}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {conv.ranges.map(r => `L${r.start_line}-${r.end_line}`).join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TracesView({ traces, loading }: TracesViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-[var(--text-muted)]">
          Agent traces tied to git commits
        </span>
        <span className="text-[var(--text-muted)] ml-auto">
          {traces.length} trace{traces.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Traces List */}
      <div className="flex-1 bg-[var(--bg-surface)] rounded border border-[var(--border-subtle)] overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-[var(--text-muted)] text-center">Loading...</div>
        ) : traces.length === 0 ? (
          <div className="p-4 text-center">
            <div className="text-xs text-[var(--text-muted)]">
              No traces yet.
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 opacity-60">
              Traces are created when agents make git commits.
            </div>
          </div>
        ) : (
          traces.map((trace) => (
            <TraceCard
              key={trace.id}
              trace={trace}
              isExpanded={expandedId === trace.id}
              onToggle={() => setExpandedId(expandedId === trace.id ? null : trace.id)}
            />
          ))
        )}
      </div>

      {/* Help text */}
      <div className="mt-2 text-xs text-[var(--text-muted)] opacity-60">
        Traces record AI contributions per file/line range. Stored in .agent-trace/
      </div>
    </div>
  );
}


### function_call
@callId call_7c0ebcf236f949498c7edb03
@name Read
@ts 1770358769204
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_7c0ebcf236f949498c7edb03
@ts 1770358769206
@durationMs 0
@workItemId 5040fed0
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

### function_call
@callId call_51d4810479674873aabb30c0
@name Grep
@ts 1770358865311
@workItemId 5040fed0
{"pattern":"Show Preview|showPreview|Preview","path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control"}

### function_call
@callId call_93105a6d492a41fd91b826e0
@name Grep
@ts 1770358865311
@workItemId 5040fed0
{"pattern":"session control|sessionControl|SessionControl","path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control"}

### function_call_output
@callId call_51d4810479674873aabb30c0
@ts 1770358865710
@durationMs 398
@workItemId 5040fed0
packages/dashboard-control/COCKPIT_SPEC.md:162:3:  preview?: string;           // Snippet for inline display
packages/dashboard-control/COCKPIT_IMPLEMENTATION.md:84:54:interface EscalationReference { type, label, target, preview? }
packages/dashboard-control/COCKPIT_IMPLEMENTATION.md:176:48:      references: Array<{ type, label, target, preview? }>;
packages/dashboard-control/package.json:10:6:    "preview": "bunx --bun vite preview"
packages/dashboard-control/src/lib/api.ts:283:62:  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
packages/dashboard-control/src/lib/api.ts:400:3:  preview: string;
packages/dashboard-control/src/lib/api.ts:486:15:  lastSnapshotPreview?: string;
packages/dashboard-control/src/lib/api.ts:650:33:export async function getCockpitPreview(options: {
packages/dashboard-control/src/lib/api.ts:658:83:    return await fetchAPI<{ url: string; source: 'query' | 'session' }>(`/cockpit/preview?${params.toString()}`);
packages/dashboard-control/COCKPIT_UI_DESIGN.md:151:7:Embed preview of running web apps via iframe proxy:
packages/dashboard-control/COCKPIT_UI_DESIGN.md:152:12:- Route: `/preview?port=3000` proxies to `localhost:3000`
packages/dashboard-control/src/App.tsx:12:13:  getCockpitPreview,
packages/dashboard-control/src/App.tsx:794:10:  const [previewVisible, setPreviewVisible] = useState(false);
packages/dashboard-control/src/App.tsx:795:10:  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
packages/dashboard-control/src/App.tsx:796:10:  const [previewLoading, setPreviewLoading] = useState(false);
packages/dashboard-control/src/App.tsx:890:10:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:891:10:      setPreviewUrl(null);
packages/dashboard-control/src/App.tsx:910:10:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:911:10:      setPreviewUrl(null);
packages/dashboard-control/src/App.tsx:943:16:    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
...[truncated at 20 results]

### function_call_output
@callId call_93105a6d492a41fd91b826e0
@ts 1770358865710
@durationMs 397
@workItemId 5040fed0
packages/dashboard-control/CONTROL_STATE_PATCH_SPEC.md:81:41:   - Harness is sole writer for durable session control metadata (`status`, `escalations`, `paused_state`, `paused_work_items`).
packages/dashboard-control/src/lib/api.ts:418:25:export interface CockpitSessionControlInput {
packages/dashboard-control/src/lib/api.ts:784:34:export async function postCockpitSessionControl(
packages/dashboard-control/src/lib/api.ts:786:17:  input: CockpitSessionControlInput
packages/dashboard-control/src/App.tsx:2084:15:              Session control via chat: <code>/fork</code>, <code>/stop</code>

### function_call
@callId call_b68285afda4a462c964485dd
@name Grep
@ts 1770358870290
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"Show Preview|previewVisible|setPreviewVisible"}

### function_call
@callId call_d310a152867c43d98794951a
@name Grep
@ts 1770358870290
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"header|Header"}

### function_call_output
@callId call_b68285afda4a462c964485dd
@ts 1770358870735
@durationMs 445
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:794:10:  const [previewVisible, setPreviewVisible] = useState(false);
packages/dashboard-control/src/App.tsx:890:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:910:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:1354:7:      setPreviewVisible(true);
packages/dashboard-control/src/App.tsx:1465:9:    if (previewVisible) {
packages/dashboard-control/src/App.tsx:1466:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:1478:7:      setPreviewVisible(true);
packages/dashboard-control/src/App.tsx:1484:26:  }, [focus?.sessionKey, previewVisible]);
packages/dashboard-control/src/App.tsx:2093:52:                  {previewLoading ? 'Loading...' : previewVisible ? 'Hide Preview (V)' : 'Show Preview (V)'}
packages/dashboard-control/src/App.tsx:2813:12:          {previewVisible && previewUrl && (

### function_call_output
@callId call_d310a152867c43d98794951a
@ts 1770358870735
@durationMs 444
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:943:47:    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
packages/dashboard-control/src/App.tsx:944:19:      ? focusData.header.previewUrl
packages/dashboard-control/src/App.tsx:1002:37:  const focusStatus = typeof focus?.header?.status === 'string'
packages/dashboard-control/src/App.tsx:1003:13:    ? focus.header.status
packages/dashboard-control/src/App.tsx:1131:25:      if (typeof focus?.header?.activeWorkItemId === 'string' && focus.header.activeWorkItemId === target) return true;
packages/dashboard-control/src/App.tsx:1156:12:    focus?.header?.activeWorkItemId,
packages/dashboard-control/src/App.tsx:1917:8:      <header className="h-9 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 flex items-center justify-between">
packages/dashboard-control/src/App.tsx:1930:9:      </header>
packages/dashboard-control/src/App.tsx:2052:32:                {typeof focus?.header?.title === 'string' ? focus.header.title : 'Focus'}

### function_call
@callId call_9065e90375a543f7ae71883b
@name Grep
@ts 1770358872592
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"hook_call|iteration_started|llm_call|memory_injected|memory|inject"}

### function_call_output
@callId call_9065e90375a543f7ae71883b
@ts 1770358872598
@durationMs 5
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:396:29:    if (eventType.includes('memory') || eventType.includes('inject')) continue;
packages/dashboard-control/src/App.tsx:1052:43:    // Audit filter: show all tool calls, memory injections, and status-only events
packages/dashboard-control/src/App.tsx:1060:35:          if (eventType.includes('memory') || eventType.includes('inject')) return true;
packages/dashboard-control/src/App.tsx:2868:43:                  title="Show tool calls, memory injections, and diagnostics"

### function_call
@callId call_ca9ab56a0c534555aeee9aa7
@name Grep
@ts 1770358875072
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src","pattern":"hook_call|iteration_started|llm_call|memory_injected"}

### function_call_output
@callId call_ca9ab56a0c534555aeee9aa7
@ts 1770358875282
@durationMs 209
@workItemId 5040fed0
packages/harness-daemon/src/harness/harness.ts:2808:19:    registerHook('memory_injected', async (event: InternalHookEvent, ctx: InternalHookContext) => {
packages/harness-daemon/src/harness/harness.ts:2809:27:      if (event.type !== 'memory_injected') return;
packages/harness-daemon/src/harness/harness.ts:2812:49:      const itemLog = await getWorkItemLogSafe('memory_injected', ctx.workId, ctx.agentType, ctx.objective);
packages/harness-daemon/src/harness/harness.ts:2814:54:        await safeAppend('WorkItem log write failed (memory_injected)', () => itemLog.append({
packages/harness-daemon/src/harness/harness.ts:2833:42:      this.eventBus.publish(createEvent('memory_injected', {
packages/harness-daemon/src/harness/types.ts:78:6:  | 'llm_call';
packages/harness-daemon/src/harness/event_translator.ts:181:11:    case 'llm_call': {
packages/harness-daemon/src/harness/event_translator.ts:192:18:      // Forward llm_call event to TUI for context window tracking
packages/harness-daemon/src/harness/event_translator.ts:194:16:        type: 'llm_call',
packages/harness-daemon/src/harness/control_plane_routes.ts:654:35:    if (asString(entry.type) !== 'llm_call') continue;

### function_call
@callId call_a260fc2a1a28449482e46d7f
@name Read
@ts 1770358877193
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":640,"endLine":720}

### function_call_output
@callId call_a260fc2a1a28449482e46d7f
@ts 1770358877195
@durationMs 1
@workItemId 5040fed0
// Lines 640-720 of 3077 total
    tree,
    suggestedFolders: Array.from(folderSuggestions).slice(0, 12),
  };
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

### function_call
@callId call_3825de0a539b423a8f38a9e5
@name Grep
@ts 1770358882614
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"getSessionEvents|session.*events|events.*endpoint"}

### function_call_output
@callId call_3825de0a539b423a8f38a9e5
@ts 1770358882621
@durationMs 6
@workItemId 5040fed0
packages/harness-daemon/src/harness/control_plane_routes.ts:908:13:function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
packages/harness-daemon/src/harness/control_plane_routes.ts:909:32:  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
packages/harness-daemon/src/harness/control_plane_routes.ts:932:14:function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
packages/harness-daemon/src/harness/control_plane_routes.ts:943:22:  const commits = getSessionCommitEvents(session);
packages/harness-daemon/src/harness/control_plane_routes.ts:2836:15:function buildSessionEvents(
packages/harness-daemon/src/harness/control_plane_routes.ts:2862:37:  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
packages/harness-daemon/src/harness/control_plane_routes.ts:3192:33:  // GET /control-plane/cockpit/session/:sessionKey/events?cursor=...&limit=...
packages/harness-daemon/src/harness/control_plane_routes.ts:3193:47:  params = matchRoute('/control-plane/cockpit/session/:sessionKey/events', pathname);
packages/harness-daemon/src/harness/control_plane_routes.ts:3197:21:    handleGetCockpitSessionEvents(res, ctx, params.sessionKey, limit, cursor);
packages/harness-daemon/src/harness/control_plane_routes.ts:3363:13:      const sessionCommitEvents = repoSessions.flatMap((session) => getSessionCommitEvents(session));
packages/harness-daemon/src/harness/control_plane_routes.ts:3366:29:        const matched = findSessionCommitBySha(sessionCommitEvents, commit.sha);
packages/harness-daemon/src/harness/control_plane_routes.ts:3577:43:          events: `/control-plane/cockpit/session/${encodeURIComponent(session.sessionKey)}/events`,
packages/harness-daemon/src/harness/control_plane_routes.ts:3627:43:          events: `/control-plane/cockpit/session/${encodeURIComponent(escalation.sessionKey)}/events`,
packages/harness-daemon/src/harness/control_plane_routes.ts:4692:26:function handleGetCockpitSessionEvents(
packages/harness-daemon/src/harness/control_plane_routes.ts:4712:39:  const { events, nextCursor } = buildSessionEvents(

### function_call
@callId call_f5fec8e844324fb09debc7f8
@name Read
@ts 1770358886434
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":2836,"endLine":2950}

### function_call
@callId call_9985e3245ce848e8a3c1b438
@name Read
@ts 1770358886434
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":4692,"endLine":4800}

### function_call_output
@callId call_f5fec8e844324fb09debc7f8
@ts 1770358886437
@durationMs 2
@workItemId 5040fed0
// Lines 2836-2950 of 3077 total
function buildSessionEvents(
  session: SessionRow,
  messages: MessageRow[],
  limit: number,
  cursor?: number
): { events: NormalizedSessionEvent[]; nextCursor: number | null } {
  const normalized: Array<{ ts: number; event: NormalizedSessionEvent }> = [];

  for (const message of messages) {
    const ts = message.createdAt * 1000;
    const event: NormalizedSessionEvent = {
      at: new Date(ts).toISOString(),
      type: 'message',
      payload: {
        id: message.id,
        role: message.role,
        content: message.content,
        requestId: message.requestId,
        metadata: message.metadata ?? {},
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({ ts, event });
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    const normalizedType = normalizeAgentEventType(type);
    const data = isRecord(entry.data) ? entry.data : {};
    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';
    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;
    const messageContent = extractText(data.content)
      ?? extractText(data.message)
      ?? extractText(data.chunk)
      ?? extractText(data.text)
      ?? extractText(data.response)
      ?? extractText(entry.content)
      ?? extractText(entry.message)
      ?? '';
    const event: NormalizedSessionEvent = {
      at: new Date(ts).toISOString(),
      type: normalizedType,
      payload: {
        eventType: type,
        requestId: asString(entry.request_id),
        workItemId: asString(entry.work_item_id),
        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),
        data,
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({ ts, event });
  }

  normalized.sort((a, b) => a.ts - b.ts);
  const filtered = cursor
    ? normalized.filter((entry) => entry.ts > cursor)
    : normalized;
  const sliced = filtered.slice(-limit);
  const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].ts : null;

  return {
    events: sliced.map((entry) => entry.event),
    nextCursor,
  };
}

/**
 * Handle control-plane API requests
 * Returns true if the request was handled, false otherwise
 */
export function handleControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): boolean {
  const { pathname, query } = parseUrl(req);

  // Only handle /control-plane/* routes
  if (!pathname.startsWith('/control-plane/')) {
    return false;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Route handling
  let params: Record<string, string> | null;

  // GET /control-plane/projects
  if (pathname === '/control-plane/projects' && req.method === 'GET') {
    handleGetProjects(res, ctx);
    return true;
  }

  // GET /control-plane/projects/:id/features
  params = matchRoute('/control-plane/projects/:id/features', pathname);
  if (params && req.method === 'GET') {
    void handleGetFeatures(res, ctx, params.id);
    return true;
  }

### function_call_output
@callId call_9985e3245ce848e8a3c1b438
@ts 1770358886438
@durationMs 1
@workItemId 5040fed0
// Lines 4692-3077 of 3077 total


### function_call
@callId call_c57c05b226c64a1aaaeaef84
@name Grep
@ts 1770358888702
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"function handleGetCockpitSessionEvents"}

### function_call_output
@callId call_c57c05b226c64a1aaaeaef84
@ts 1770358889660
@durationMs 957
@workItemId 5040fed0
packages/harness-daemon/src/harness/control_plane_routes.ts:4692:1:function handleGetCockpitSessionEvents(

### function_call
@callId call_c21ad3c4f1684c6fa5a546a4
@name Read
@ts 1770358968419
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":4692,"endLine":4780}

### function_call_output
@callId call_c21ad3c4f1684c6fa5a546a4
@ts 1770358968430
@durationMs 5
@workItemId 5040fed0
// Lines 4692-3077 of 3077 total


### function_call
@callId call_cba5683f43d948f9982aedd2
@name Bash
@ts 1770358984549
@workItemId 5040fed0
{"command":"wc -l /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_cba5683f43d948f9982aedd2
@ts 1770358984564
@durationMs 12
@workItemId 5040fed0
5814 /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts


### function_call
@callId call_7aefacf42a6f4e919e21b866
@name Read
@ts 1770358986552
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":4692,"endLine":4780}

### function_call_output
@callId call_7aefacf42a6f4e919e21b866
@ts 1770358986557
@durationMs 3
@workItemId 5040fed0
// Lines 4692-3077 of 3077 total


### function_call
@callId call_1fb56ef5c2f0427894c91bec
@name Bash
@ts 1770358991027
@workItemId 5040fed0
{"command":"grep -n \"function handleGetCockpitSessionEvents\" /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_1fb56ef5c2f0427894c91bec
@ts 1770358991043
@durationMs 13
@workItemId 5040fed0
4692:function handleGetCockpitSessionEvents(


### function_call
@callId call_7174980756464ee69467a5c5
@name Bash
@ts 1770359017300
@workItemId 5040fed0
{"command":"sed -n '4692,4780p' /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_7174980756464ee69467a5c5
@ts 1770359017317
@durationMs 14
@workItemId 5040fed0
function handleGetCockpitSessionEvents(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  limit: number,
  cursorRaw: string | null
): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { events: [], nextCursor: null, error: 'GraphD not available' });
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { events: [], nextCursor: null, error: 'Session not found' }, 404);
    return;
  }
  const messagesResult = ctx.graphd.messagesGet(sessionKey, Math.max(limit * 2, 200), 0) as {
    messages?: MessageRow[];
  };
  const cursor = cursorRaw ? Number(cursorRaw) : undefined;
  const { events, nextCursor } = buildSessionEvents(
    session,
    messagesResult.messages ?? [],
    limit,
    Number.isFinite(cursor) ? cursor : undefined
  );
  sendJson(res, { events, nextCursor });
}

function handleGetCockpitSessionPackets(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  limit: number
): void {
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { packets: [], error: 'Session not found' }, 404);
    return;
  }

  const packets = parsePackets(session.metadata?.packets);
  // Do not synthesize packets server-side; return only harness-provided packet markdown.
  sendJson(res, { packets: packets.slice(0, limit) });
}

async function handlePostCockpitPacket(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { success: false, error: 'GraphD not available' }, 503);
    return;
  }

  const body = await readJsonBody(req);
  const sessionKey = asString(body.sessionKey);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required field: sessionKey' }, 400);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const { markdown, sourcePath, error } = await loadPacketMarkdown(
    session.workingDir ?? ctx.workingDir,
    body
  );
  if (!markdown || error) {
    sendJson(res, { success: false, error: error ?? 'Missing packet markdown content' }, 400);
    return;
  }
  if (Buffer.byteLength(markdown, 'utf8') > 1_000_000) {
    sendJson(res, { success: false, error: 'Packet markdown exceeds 1MB limit' }, 400);
    return;
  }

  const packetId = asString(body.packetId) ?? buildPacketId();
  const packetTypeResult = parsePacketType(body.type);
  if (packetTypeResult.error) {
    sendJson(res, { success: false, error: packetTypeResult.error }, 400);
    return;
  }
  const packetType = packetTypeResult.type;


### function_call
@callId call_e7ccd09832ed4964835690aa
@name Grep
@ts 1770359021648
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"normalizeAgentEventType|getSignalPriority|isStatusOnlyEvent"}

### function_call_output
@callId call_e7ccd09832ed4964835690aa
@ts 1770359021659
@durationMs 8
@workItemId 5040fed0
packages/harness-daemon/src/harness/control_plane_routes.ts:2754:10:function normalizeAgentEventType(type: string): NormalizedSessionEvent['type'] {
packages/harness-daemon/src/harness/control_plane_routes.ts:2771:10:function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {
packages/harness-daemon/src/harness/control_plane_routes.ts:2832:10:function isStatusOnlyEvent(event: NormalizedSessionEvent): boolean {
packages/harness-daemon/src/harness/control_plane_routes.ts:2833:10:  return getSignalPriority(event) === 'status';
packages/harness-daemon/src/harness/control_plane_routes.ts:2857:28:    event.signalPriority = getSignalPriority(event);
packages/harness-daemon/src/harness/control_plane_routes.ts:2858:26:    event.isStatusOnly = isStatusOnlyEvent(event);
packages/harness-daemon/src/harness/control_plane_routes.ts:2868:28:    const normalizedType = normalizeAgentEventType(type);
packages/harness-daemon/src/harness/control_plane_routes.ts:2891:28:    event.signalPriority = getSignalPriority(event);
packages/harness-daemon/src/harness/control_plane_routes.ts:2892:26:    event.isStatusOnly = isStatusOnlyEvent(event);

### function_call
@callId call_be88ec58dfdb4310adcd4260
@name Read
@ts 1770359024110
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":2754,"endLine":2835}

### function_call_output
@callId call_be88ec58dfdb4310adcd4260
@ts 1770359024116
@durationMs 3
@workItemId 5040fed0
// Lines 2754-2835 of 3077 total
function normalizeAgentEventType(type: string): NormalizedSessionEvent['type'] {
  if (type === 'agent_message' || type === 'user_message' || type === 'send_text' || type === 'response') return 'message';
  if (type === 'tool_call') return 'tool';
  if (type === 'git_commit') return 'trace';
  if (type.startsWith('browser_')) return 'tool';
  if (type.includes('test')) return 'test';
  if (type.includes('packet')) return 'packet';
  return 'workflow';
}

/**
 * Compute signal priority for an event
 * High: substantial assistant messages, packet events, test failures
 * Medium: user messages, meaningful errors
 * Low: routine tool calls, internal diagnostics
 * Status: events that shouldn't appear in message stream (only for UI indicators)
 */
function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {
  if (event.type === 'packet') return 'high';
  
  if (event.type === 'test') {
    const data = event.payload.data as Record<string, unknown> | undefined;
    const verdict = String(data?.verdict ?? event.payload.verdict ?? '').toLowerCase();
    if (verdict === 'fail' || verdict === 'error') return 'high';
    return 'medium';
  }

  if (event.type === 'message') {
    const role = String(event.payload.role ?? '');
    const content = typeof event.payload.content === 'string' ? event.payload.content : '';
    
    if (role === 'assistant') {
      if (content.length > 120) return 'high';
      if (content.length > 0) return 'medium';
      return 'low';
    }
    
    if (role === 'user') return 'medium';
    
    // System messages are usually low priority unless they contain substantial info
    if (content.length > 100) return 'medium';
    return 'low';
  }

  if (event.type === 'tool') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    const data = event.payload.data as Record<string, unknown> | undefined;
    
    // Failed tools are high priority
    const success = data?.success;
    if (success === false) return 'high';
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return 'high';
    
    // Memory injections are status only (go to Audit)
    if (eventType.includes('memory') || eventType.includes('inject')) return 'status';
    
    // Browser actions are status only (they appear in active tool indicator)
    if (eventType.startsWith('browser_')) return 'status';
    
    // Other tools are low priority
    return 'low';
  }

  if (event.type === 'workflow') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    if (eventType.includes('error') || eventType.includes('fail')) return 'high';
    if (eventType.includes('escalation')) return 'high';
    return 'low';
  }

  return 'low';
}

/**
 * Determine if an event should appear in the main message stream
 * vs being used only for status indicators
 */
function isStatusOnlyEvent(event: NormalizedSessionEvent): boolean {
  return getSignalPriority(event) === 'status';
}


### function_call
@callId call_0dbb743e7d674e6ca2b7210d
@name Edit
@ts 1770359086054
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","oldString":"function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {\n  if (event.type === 'packet') return 'high';\n  \n  if (event.type === 'test') {\n    const data = event.payload.data as Record<string, unknown> | undefined;\n    const verdict = String(data?.verdict ?? event.payload.verdict ?? '').toLowerCase();\n    if (verdict === 'fail' || verdict === 'error') return 'high';\n    return 'medium';\n  }\n\n  if (event.type === 'message') {\n    const role = String(event.payload.role ?? '');\n    const content = typeof event.payload.content === 'string' ? event.payload.content : '';\n    \n    if (role === 'assistant') {\n      if (content.length > 120) return 'high';\n      if (content.length > 0) return 'medium';\n      return 'low';\n    }\n    \n    if (role === 'user') return 'medium';\n    \n    // System messages are usually low priority unless they contain substantial info\n    if (content.length > 100) return 'medium';\n    return 'low';\n  }\n\n  if (event.type === 'tool') {\n    const eventType = String(event.payload.eventType ?? '').toLowerCase();\n    const data = event.payload.data as Record<string, unknown> | undefined;\n    \n    // Failed tools are high priority\n    const success = data?.success;\n    if (success === false) return 'high';\n    const status = String(data?.status ?? '').toLowerCase();\n    if (status === 'error' || status === 'failed' || status === 'fail') return 'high';\n    \n    // Memory injections are status only (go to Audit)\n    if (eventType.includes('memory') || eventType.includes('inject')) return 'status';\n    \n    // Browser actions are status only (they appear in active tool indicator)\n    if (eventType.startsWith('browser_')) return 'status';\n    \n    // Other tools are low priority\n    return 'low';\n  }\n\n  if (event.type === 'workflow') {\n    const eventType = String(event.payload.eventType ?? '').toLowerCase();\n    if (eventType.includes('error') || eventType.includes('fail')) return 'high';\n    if (eventType.includes('escalation')) return 'high';\n    return 'low';\n  }\n\n  return 'low';\n}","newString":"function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {\n  if (event.type === 'packet') return 'high';\n  \n  if (event.type === 'test') {\n    const data = event.payload.data as Record<string, unknown> | undefined;\n    const verdict = String(data?.verdict ?? event.payload.verdict ?? '').toLowerCase();\n    if (verdict === 'fail' || verdict === 'error') return 'high';\n    return 'medium';\n  }\n\n  if (event.type === 'message') {\n    const role = String(event.payload.role ?? '');\n    const content = typeof event.payload.content === 'string' ? event.payload.content : '';\n    \n    if (role === 'assistant') {\n      if (content.length > 120) return 'high';\n      if (content.length > 0) return 'medium';\n      return 'low';\n    }\n    \n    if (role === 'user') return 'medium';\n    \n    // System messages are usually low priority unless they contain substantial info\n    if (content.length > 100) return 'medium';\n    return 'low';\n  }\n\n  if (event.type === 'tool') {\n    const eventType = String(event.payload.eventType ?? '').toLowerCase();\n    const data = event.payload.data as Record<string, unknown> | undefined;\n    \n    // Failed tools are high priority\n    const success = data?.success;\n    if (success === false) return 'high';\n    const status = String(data?.status ?? '').toLowerCase();\n    if (status === 'error' || status === 'failed' || status === 'fail') return 'high';\n    \n    // Memory injections are status only (go to Audit)\n    if (eventType.includes('memory') || eventType.includes('inject')) return 'status';\n    \n    // Browser actions are status only (they appear in active tool indicator)\n    if (eventType.startsWith('browser_')) return 'status';\n    \n    // Other tools are low priority\n    return 'low';\n  }\n\n  if (event.type === 'workflow') {\n    const eventType = String(event.payload.eventType ?? '').toLowerCase();\n    if (eventType.includes('error') || eventType.includes('fail')) return 'high';\n    if (eventType.includes('escalation')) return 'high';\n    // Internal events that should not appear in UI\n    if (eventType === 'llm_call' || eventType === 'hook_call' || eventType === 'iteration_started' || \n        eventType === 'memory_injected' || eventType.includes('memory') || eventType.includes('inject')) {\n      return 'status';\n    }\n    return 'low';\n  }\n\n  return 'low';\n}"}

### function_call_output
@callId call_0dbb743e7d674e6ca2b7210d
@ts 1770359086086
@durationMs 4
@workItemId 5040fed0
Edited /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts
Replaced 1 occurrence(s)
Context after edit:
2770:  */
2771: function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {
2772:   if (event.type === 'packet') return 'high';
2773:   
2774:   if (event.type === 'test') {
2775:     const data = event.payload.data as Record<string, unknown> | undefined;
2776:     const verdict = String(data?.verdict ?? event.payload.verdict ?? '').toLowerCase();
2777:     if (verdict === 'fail' || verdict === 'error') return 'high';
2778:     return 'medium';
2779:   }
2780: 
2781:   if (event.type === 'message') {
2782:     const role = String(event.payload.role ?? '');
2783:     const content = typeof event.payload.content === 'string' ? event.payload.content : '';
2784:     
2785:     if (role === 'assistant') {
2786:       if (content.length > 120) return 'high';
2787:       if (content.length > 0) return 'medium';
2788:       return 'low';
2789:     }
2790:     
2791:     if (role === 'user') return 'medium';
2792:     
2793:     // System messages are usually low priority unless they contain substantial info
2794:     if (content.length > 100) return 'medium';
2795:     return 'low';
2796:   }
2797: 
2798:   if (event.type === 'tool') {
2799:     const eventType = String(event.payload.eventType ?? '').toLowerCase();
2800:     const data = event.payload.data as Record<string, unknown> | undefined;
2801:     
2802:     // Failed tools are high priority
2803:     const success = data?.success;
2804:     if (success === false) return 'high';
2805:     const status = String(data?.status ?? '').toLowerCase();
2806:     if (status === 'error' || status === 'failed' || status === 'fail') return 'high';
2807:     
2808:     // Memory injections are status only (go to Audit)
2809:     if (eventType.includes('memory') || eventType.includes('inject')) return 'status';
2810:     
2811:     // Browser actions are status only (they appear in active tool indicator)
2812:     if (eventType.startsWith('browser_')) return 'status';
2813:     
2814:     // Other tools are low priority
2815:     return 'low';
2816:   }
2817: 
2818:   if (event.type === 'workflow') {
2819:     const eventType = String(event.payload.eventType ?? '').toLowerCase();
2820:     if (eventType.includes('error') || eventType.includes('fail')) return 'high';
2821:     if (eventType.includes('escalation')) return 'high';
2822:     // Internal events that should not appear in UI
2823:     if (eventType === 'llm_call' || eventType === 'hook_call' || eventType === 'iteration_started' || 
2824:         eventType === 'memory_injected' || eventType.includes('memory') || eventType.includes('inject')) {
2825:       return 'status';
2826:     }
2827:     return 'low';
2828:   }
2829: 
2830:   return 'low';
2831: }
2832: 
2833: /**

### function_call
@callId call_7090d0d7afcf4f75a7430f41
@name Edit
@ts 1770359096753
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","oldString":"  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];\n  for (const entry of agentEvents) {\n    if (!isRecord(entry)) continue;\n    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    const normalizedType = normalizeAgentEventType(type);\n    const data = isRecord(entry.data) ? entry.data : {};\n    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';\n    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;\n    const messageContent = extractText(data.content)\n      ?? extractText(data.message)\n      ?? extractText(data.chunk)\n      ?? extractText(data.text)\n      ?? extractText(data.response)\n      ?? extractText(entry.content)\n      ?? extractText(entry.message)\n      ?? '';\n    const event: NormalizedSessionEvent = {\n      at: new Date(ts).toISOString(),\n      type: normalizedType,\n      payload: {\n        eventType: type,\n        requestId: asString(entry.request_id),\n        workItemId: asString(entry.work_item_id),\n        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),\n        data,\n      },\n    };\n    event.signalPriority = getSignalPriority(event);\n    event.isStatusOnly = isStatusOnlyEvent(event);\n    normalized.push({ ts, event });\n  }","newString":"  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];\n  for (const entry of agentEvents) {\n    if (!isRecord(entry)) continue;\n    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    \n    // Skip internal events that slow down server and UI\n    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || \n        type === 'memory_injected' || type.includes('memory') && type.includes('inject')) {\n      continue;\n    }\n    \n    const normalizedType = normalizeAgentEventType(type);\n    const data = isRecord(entry.data) ? entry.data : {};\n    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';\n    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;\n    const messageContent = extractText(data.content)\n      ?? extractText(data.message)\n      ?? extractText(data.chunk)\n      ?? extractText(data.text)\n      ?? extractText(data.response)\n      ?? extractText(entry.content)\n      ?? extractText(entry.message)\n      ?? '';\n    const event: NormalizedSessionEvent = {\n      at: new Date(ts).toISOString(),\n      type: normalizedType,\n      payload: {\n        eventType: type,\n        requestId: asString(entry.request_id),\n        workItemId: asString(entry.work_item_id),\n        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),\n        data,\n      },\n    };\n    event.signalPriority = getSignalPriority(event);\n    event.isStatusOnly = isStatusOnlyEvent(event);\n    normalized.push({ ts, event });\n  }"}

### function_call_output
@callId call_7090d0d7afcf4f75a7430f41
@ts 1770359096776
@isError true
@durationMs 3
@workItemId 5040fed0
old_string not found in /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts. Verify the exact text including whitespace.

### function_call
@callId call_094fe3c6ee974fb4a80957ce
@name Read
@ts 1770359098818
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":2860,"endLine":2900}

### function_call_output
@callId call_094fe3c6ee974fb4a80957ce
@ts 1770359098825
@durationMs 2
@workItemId 5040fed0
// Lines 2860-2900 of 3075 total
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({ ts, event });
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    const normalizedType = normalizeAgentEventType(type);
    const data = isRecord(entry.data) ? entry.data : {};
    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';
    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;
    const messageContent = extractText(data.content)
      ?? extractText(data.message)
      ?? extractText(data.chunk)
      ?? extractText(data.text)
      ?? extractText(data.response)
      ?? extractText(entry.content)
      ?? extractText(entry.message)
      ?? '';
    const event: NormalizedSessionEvent = {
      at: new Date(ts).toISOString(),
      type: normalizedType,
      payload: {
        eventType: type,
        requestId: asString(entry.request_id),
        workItemId: asString(entry.work_item_id),
        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),
        data,
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({ ts, event });
  }


### function_call
@callId call_72b7d75984c1443dbc797520
@name Edit
@ts 1770359120430
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","oldString":"  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];\n  for (const entry of agentEvents) {\n    if (!isRecord(entry)) continue;\n    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    const normalizedType = normalizeAgentEventType(type);","newString":"  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];\n  for (const entry of agentEvents) {\n    if (!isRecord(entry)) continue;\n    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    \n    // Skip internal events that slow down server and UI\n    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || \n        type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {\n      continue;\n    }\n    \n    const normalizedType = normalizeAgentEventType(type);"}

### function_call_output
@callId call_72b7d75984c1443dbc797520
@ts 1770359120446
@isError true
@durationMs 2
@workItemId 5040fed0
old_string not found in /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts. Verify the exact text including whitespace.

### function_call
@callId call_db701dff2b30416796e6a4e7
@name Bash
@ts 1770359122542
@workItemId 5040fed0
{"command":"sed -n '2870,2880p' /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts | cat -A"}

### function_call_output
@callId call_db701dff2b30416796e6a4e7
@ts 1770359122556
@durationMs 12
@workItemId 5040fed0
    const type = asString(entry.type);$
    const ts = parseTimestampMs(entry.timestamp);$
    if (!type || !ts) continue;$
    const normalizedType = normalizeAgentEventType(type);$
    const data = isRecord(entry.data) ? entry.data : {};$
    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';$
    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;$
    const messageContent = extractText(data.content)$
      ?? extractText(data.message)$
      ?? extractText(data.chunk)$
      ?? extractText(data.text)$


### function_call
@callId call_77aa8d99682f4e27905f1f4f
@name Edit
@ts 1770359126923
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","oldString":"    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    const normalizedType = normalizeAgentEventType(type);","newString":"    const type = asString(entry.type);\n    const ts = parseTimestampMs(entry.timestamp);\n    if (!type || !ts) continue;\n    \n    // Skip internal events that slow down server and UI\n    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || \n        type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {\n      continue;\n    }\n    \n    const normalizedType = normalizeAgentEventType(type);"}

### function_call_output
@callId call_77aa8d99682f4e27905f1f4f
@ts 1770359126935
@durationMs 2
@workItemId 5040fed0
Edited /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts
Replaced 1 occurrence(s)
Context after edit:
2869:     if (!isRecord(entry)) continue;
2870:     const type = asString(entry.type);
2871:     const ts = parseTimestampMs(entry.timestamp);
2872:     if (!type || !ts) continue;
2873:     
2874:     // Skip internal events that slow down server and UI
2875:     if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || 
2876:         type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {
2877:       continue;
2878:     }
2879:     
2880:     const normalizedType = normalizeAgentEventType(type);
2881:     const data = isRecord(entry.data) ? entry.data : {};
2882:     const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';

### function_call
@callId call_d1bd4e6dc98046a08bde5c5f
@name Read
@ts 1770359130613
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":1910,"endLine":1960}

### function_call_output
@callId call_d1bd4e6dc98046a08bde5c5f
@ts 1770359130620
@durationMs 4
@workItemId 5040fed0
// Lines 1910-1960 of 2662 total
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

### function_call
@callId call_66265c8201284f5b8175512d
@name Grep
@ts 1770359132466
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"Show Preview.*V"}

### function_call_output
@callId call_66265c8201284f5b8175512d
@ts 1770359132483
@durationMs 11
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:2460:91:                  {previewLoading ? 'Loading...' : previewVisible ? 'Hide Preview (V)' : 'Show Preview (V)'}

### function_call
@callId call_30fa32b2256541b59d2c44af
@name Read
@ts 1770359134240
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2430,"endLine":2550}

### function_call_output
@callId call_30fa32b2256541b59d2c44af
@ts 1770359134246
@durationMs 3
@workItemId 5040fed0
// Lines 2430-2550 of 2662 total
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
                onClick={() => setFocusTab('markdown')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'markdown'
                    ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Markdown (M)
              </button>
              <button
                onClick={() => setFocusTab('packet')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'packet'
                    ? 'bg-[var(--running)]/20 text-[var(--running)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Packet (X)
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

### function_call
@callId call_7e1ffa88dda74889b34af212
@name Edit
@ts 1770359147668
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","oldString":"            {recentAssistantMessage && (\n              <div className=\"text-[11px] text-[var(--text-secondary)] mt-0.5 truncate\">\n                Latest: {recentAssistantMessage}\n              </div>\n            )}\n            <div className=\"text-[10px] text-[var(--text-muted)] mt-1\">\n              Session control via chat: <code>/fork</code>, <code>/stop</code>\n            </div>\n            {focus?.sessionKey && (\n              <div className=\"mt-2 flex items-center gap-1\">\n                <button\n                  onClick={() => void handleTogglePreview()}\n                  disabled={previewLoading || !focus?.sessionKey}\n                  className=\"px-2 py-0.5 text-[11px] rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60\"\n                >\n                  {previewLoading ? 'Loading...' : previewVisible ? 'Hide Preview (V)' : 'Show Preview (V)'}\n                </button>\n                {focusStatus === 'ready' && (\n                  <>\n                    <button\n                      onClick={() => void handleReviewDecision('accept')}\n                      disabled={reviewDecisionAction !== null}\n                      className=\"px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60\"\n                    >\n                      {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}\n                    </button>\n                    <button\n                      onClick={() => void handleReviewDecision('request_changes')}\n                      disabled={reviewDecisionAction !== null}\n                      className=\"px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60\"\n                    >\n                      {reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}\n                    </button>\n                  </>\n                )}\n              </div>\n            )}","newString":"            {recentAssistantMessage && (\n              <div className=\"text-[11px] text-[var(--text-secondary)] mt-0.5 truncate\">\n                Latest: {recentAssistantMessage}\n              </div>\n            )}\n            {focusStatus === 'ready' && (\n              <div className=\"mt-1 flex items-center gap-1\">\n                <button\n                  onClick={() => void handleReviewDecision('accept')}\n                  disabled={reviewDecisionAction !== null}\n                  className=\"px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60\"\n                >\n                  {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}\n                </button>\n                <button\n                  onClick={() => void handleReviewDecision('request_changes')}\n                  disabled={reviewDecisionAction !== null}\n                  className=\"px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60\"\n                >\n                  {reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}\n                </button>\n              </div>\n            )}"}

### function_call_output
@callId call_7e1ffa88dda74889b34af212
@ts 1770359147689
@durationMs 4
@workItemId 5040fed0
Edited /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx
Replaced 1 occurrence(s)
Context after edit:
2444:             )}
2445:             {recentAssistantMessage && (
2446:               <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
2447:                 Latest: {recentAssistantMessage}
2448:               </div>
2449:             )}
2450:             {focusStatus === 'ready' && (
2451:               <div className="mt-1 flex items-center gap-1">
2452:                 <button
2453:                   onClick={() => void handleReviewDecision('accept')}
2454:                   disabled={reviewDecisionAction !== null}
2455:                   className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
2456:                 >
2457:                   {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}
2458:                 </button>
2459:                 <button
2460:                   onClick={() => void handleReviewDecision('request_changes')}
2461:                   disabled={reviewDecisionAction !== null}
2462:                   className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
2463:                 >
2464:                   {reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}
2465:                 </button>
2466:               </div>
2467:             )}
2468:             <div className="mt-2 flex items-center gap-1 text-[11px]">
2469:               <button

[entity-graph] 1 file(s) depend on "packages/dashboard-control/src/App.tsx": packages/dashboard-control/src/main.tsx

### function_call
@callId call_a7cf5f6cb4b44cb78f62807b
@name Read
@ts 1770359169977
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionsView.tsx","startLine":1,"endLine":50}

### function_call_output
@callId call_a7cf5f6cb4b44cb78f62807b
@ts 1770359169994
@durationMs 12
@workItemId 5040fed0
// Lines 1-50 of 231 total
/**
 * Sessions View - Dense multi-session management
 *
 * Shows live sessions with key metrics: patches, tool calls, status.
 * Optimized for managing many async agents at once.
 */

import { useState } from 'react';
import type { Session } from '@/lib/api';
import { getSessionMessages, type Message } from '@/lib/api';

interface SessionsViewProps {
  sessions: Session[];
  liveSessions: Session[];
  loading: boolean;
  onRefresh: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function StatusDot({ status, lastAccess }: { status: string; lastAccess: string }) {
  const lastAccessTime = new Date(lastAccess).getTime();
  const isRecent = Date.now() - lastAccessTime < 5 * 60 * 1000;
  const isLive = status === 'active' || isRecent;

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${isLive ? 'bg-[var(--live)] pulse-live' : 'bg-[var(--text-muted)]'}`}
      title={isLive ? 'Live' : 'Inactive'}
    />
  );
}

function SessionRow({
  session,
  isExpanded,
  onToggle,
}: {
  session: Session;
  isExpanded: boolean;
  onToggle: () => void;
}) {

### function_call
@callId call_1ef739e070e64c728038ad2f
@name Read
@ts 1770359172844
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/SessionsView.tsx","startLine":170,"endLine":231}

### function_call_output
@callId call_1ef739e070e64c728038ad2f
@ts 1770359172852
@durationMs 3
@workItemId 5040fed0
// Lines 170-231 of 231 total
                ? 'bg-[var(--live)]/20 text-[var(--live)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Live ({liveSessions.length})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-2 py-0.5 rounded ${
              filter === 'all'
                ? 'bg-[var(--running)]/20 text-[var(--running)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            All ({sessions.length})
          </button>
        </div>
        <div className="text-xs text-[var(--text-muted)] ml-auto">
          {filter === 'live' && liveSessions.length === 0 && 'No active sessions'}
        </div>
      </div>

      {/* Sessions List */}
      <div className="flex-1 bg-[var(--bg-surface)] rounded border border-[var(--border-subtle)] overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-[var(--text-muted)] text-center">Loading...</div>
        ) : displaySessions.length === 0 ? (
          <div className="p-4 text-center">
            <div className="text-xs text-[var(--text-muted)]">
              {filter === 'live'
                ? 'No live sessions. Start a TUI session to see it here.'
                : 'No sessions found.'}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 opacity-60">
              Sessions appear here when agents are actively working.
            </div>
          </div>
        ) : (
          displaySessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isExpanded={expandedId === session.id}
              onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
            />
          ))
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--live)]" /> Live
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--text-muted)]" /> Inactive
        </span>
      </div>
    </div>
  );
}


### function_call
@callId call_63f206c10c8e4f79a8d1860a
@name Grep
@ts 1770359177532
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"SessionsView|SessionList"}

### function_call_output
@callId call_63f206c10c8e4f79a8d1860a
@ts 1770359177548
@durationMs 10
@workItemId 5040fed0
No matches found for pattern: SessionsView|SessionList

### function_call
@callId call_df3cdb0b3db94f2e8f365228
@name Grep
@ts 1770359181199
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src","pattern":"import.*SessionsView|from.*SessionsView"}

### function_call_output
@callId call_df3cdb0b3db94f2e8f365228
@ts 1770359181222
@durationMs 14
@workItemId 5040fed0
packages/dashboard-control/src/components/index.ts:5:25:export { SessionsView } from './SessionsView';

### function_call
@callId call_f314c5227c8044faa4fcc73a
@name Grep
@ts 1770359183541
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control","pattern":"SessionsView"}

### function_call_output
@callId call_f314c5227c8044faa4fcc73a
@ts 1770359183555
@durationMs 11
@workItemId 5040fed0
packages/dashboard-control/src/components/SessionsView.tsx:12:11:interface SessionsViewProps {
packages/dashboard-control/src/components/SessionsView.tsx:155:17:export function SessionsView({ sessions, liveSessions, loading }: SessionsViewProps) {
packages/dashboard-control/src/components/index.ts:5:10:export { SessionsView } from './SessionsView';

### function_call
@callId call_ec8ba5d5b2694014ba2610b3
@name Read
@ts 1770359201971
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":390,"endLine":430}

### function_call_output
@callId call_ec8ba5d5b2694014ba2610b3
@ts 1770359201986
@durationMs 4
@workItemId 5040fed0
// Lines 390-430 of 2660 total
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

### function_call
@callId call_29b1bdd8f9ad4ec4bdcd4fd7
@name Grep
@ts 1770359211284
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"const toolSignal|toolSignal = useMemo"}

### function_call_output
@callId call_29b1bdd8f9ad4ec4bdcd4fd7
@ts 1770359211303
@durationMs 11
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:1320:3:  const toolSignal = useMemo(() => describeLatestToolSignal(events), [events]);

### function_call
@callId call_30e0e1398db546548483addf
@name Grep
@ts 1770359214876
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"useEffect.*refreshFocus|refreshFocus.*useEffect"}

### function_call_output
@callId call_30e0e1398db546548483addf
@ts 1770359214894
@durationMs 15
@workItemId 5040fed0
No matches found for pattern: useEffect.*refreshFocus|refreshFocus.*useEffect

### function_call
@callId call_13ba564ee411403682553811
@name Grep
@ts 1770359217234
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"refreshFocus\\(|setFocusTarget"}

### function_call_output
@callId call_13ba564ee411403682553811
@ts 1770359217252
@durationMs 11
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:887:23:  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
packages/dashboard-control/src/App.tsx:989:5:    setFocusTarget((current) => {
packages/dashboard-control/src/App.tsx:1093:10:    void refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1696:15:        await refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1717:7:      setFocusTarget(null);
packages/dashboard-control/src/App.tsx:1742:13:      await refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1756:13:      await refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1828:13:      await refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1929:13:      await refreshFocus(focusTarget);
packages/dashboard-control/src/App.tsx:1941:5:    setFocusTarget({ type: 'session', id: row.sessionKey });
packages/dashboard-control/src/App.tsx:1952:7:      setFocusTarget({ type: 'session', id: row.sessionKey });
packages/dashboard-control/src/App.tsx:2158:13:            setFocusTarget({ type: 'session', id: runningSessions[leftSelection.running].sessionKey });
packages/dashboard-control/src/App.tsx:2162:13:            setFocusTarget({ type: 'session', id: readySessions[leftSelection.ready].sessionKey });
packages/dashboard-control/src/App.tsx:2176:13:            setFocusTarget({ type: 'session', id: doneSessions[rightSelection.done].sessionKey });
packages/dashboard-control/src/App.tsx:2180:13:            setFocusTarget({ type: 'escalation', id: escalations[rightSelection.queue].escalationId });
packages/dashboard-control/src/App.tsx:2352:19:                  setFocusTarget({ type: 'session', id: row.sessionKey });
packages/dashboard-control/src/App.tsx:2378:19:                  setFocusTarget({ type: 'session', id: row.sessionKey });
packages/dashboard-control/src/App.tsx:3603:23:                      setFocusTarget({ type: 'session', id: row.sessionKey });
packages/dashboard-control/src/App.tsx:3624:23:                      setFocusTarget({ type: 'escalation', id: row.escalationId });

### function_call
@callId call_e0aba0cacee143adade5bfac
@name Grep
@ts 1770359220075
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"useEffect.*\\(\\(\\) =>.*\\{","maxResults":30}

### function_call_output
@callId call_e0aba0cacee143adade5bfac
@ts 1770359220089
@durationMs 11
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:1084:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1092:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1096:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1100:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1105:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1300:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1548:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1560:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1567:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1576:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1582:3:  useEffect(() => {
packages/dashboard-control/src/App.tsx:1957:3:  useEffect(() => {

### function_call
@callId call_6fe0f7bbf74e4c6db1af207f
@name Read
@ts 1770359221922
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":1090,"endLine":1105}

### function_call_output
@callId call_6fe0f7bbf74e4c6db1af207f
@ts 1770359221935
@durationMs 6
@workItemId 5040fed0
// Lines 1090-1105 of 2660 total
  }, [refreshAll]);

  useEffect(() => {
    void refreshFocus(focusTarget);
  }, [focusTarget, lastUpdate, refreshFocus]);

  useEffect(() => {
    void refreshMarkdownWorkspace();
  }, [refreshMarkdownWorkspace]);

  useEffect(() => {
    if (markdownDirty) return;
    void refreshMarkdownWorkspace(markdownSelectedPath);
  }, [lastUpdate, markdownDirty, markdownSelectedPath, refreshMarkdownWorkspace]);

  useEffect(() => {

### function_call
@callId call_944eabbb3a704f548bb8e753
@name Grep
@ts 1770359224552
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"POLL_INTERVAL_MS"}

### function_call_output
@callId call_944eabbb3a704f548bb8e753
@ts 1770359224565
@durationMs 9
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:43:7:const POLL_INTERVAL_MS = 5000;
packages/dashboard-control/src/App.tsx:1088:8:    }, POLL_INTERVAL_MS);

### function_call
@callId call_a63fdfe5eb8e47ddbd621ddb
@name Read
@ts 1770359228254
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":1080,"endLine":1105}

### function_call_output
@callId call_a63fdfe5eb8e47ddbd621ddb
@ts 1770359228262
@durationMs 4
@workItemId 5040fed0
// Lines 1080-1105 of 2660 total
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

  useEffect(() => {
    void refreshMarkdownWorkspace();
  }, [refreshMarkdownWorkspace]);

  useEffect(() => {
    if (markdownDirty) return;
    void refreshMarkdownWorkspace(markdownSelectedPath);
  }, [lastUpdate, markdownDirty, markdownSelectedPath, refreshMarkdownWorkspace]);

  useEffect(() => {

### function_call
@callId call_06a9bd4c7194479fa7afca64
@name Grep
@ts 1770359234293
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","pattern":"previewVisible|previewLoading|previewUrl|setPreview"}

### function_call_output
@callId call_06a9bd4c7194479fa7afca64
@ts 1770359234304
@durationMs 8
@workItemId 5040fed0
packages/dashboard-control/src/App.tsx:917:10:  const [previewVisible, setPreviewVisible] = useState(false);
packages/dashboard-control/src/App.tsx:918:10:  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
packages/dashboard-control/src/App.tsx:919:10:  const [previewLoading, setPreviewLoading] = useState(false);
packages/dashboard-control/src/App.tsx:1013:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:1014:7:      setPreviewUrl(null);
packages/dashboard-control/src/App.tsx:1033:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:1034:7:      setPreviewUrl(null);
packages/dashboard-control/src/App.tsx:1066:16:    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
packages/dashboard-control/src/App.tsx:1067:26:      ? focusData.header.previewUrl
packages/dashboard-control/src/App.tsx:1069:53:    setBrowserUrlDraft((current) => current || focusPreviewUrl);
packages/dashboard-control/src/App.tsx:1673:7:      setPreviewVisible(true);
packages/dashboard-control/src/App.tsx:1784:9:    if (previewVisible) {
packages/dashboard-control/src/App.tsx:1785:7:      setPreviewVisible(false);
packages/dashboard-control/src/App.tsx:1789:5:    setPreviewLoading(true);
packages/dashboard-control/src/App.tsx:1796:7:      setPreviewUrl(preview.url);
packages/dashboard-control/src/App.tsx:1797:7:      setPreviewVisible(true);
packages/dashboard-control/src/App.tsx:1801:7:      setPreviewLoading(false);
packages/dashboard-control/src/App.tsx:1803:26:  }, [focus?.sessionKey, previewVisible]);
packages/dashboard-control/src/App.tsx:1825:9:        setPreviewUrl(response.currentUrl);
packages/dashboard-control/src/App.tsx:1926:9:        setPreviewUrl(result.currentUrl);
...[truncated at 20 results]

### function_call
@callId call_72f2d5f06e7a4a5babd107dd
@name Bash
@ts 1770359245802
@workItemId 5040fed0
{"command":"git diff packages/harness-daemon/src/harness/control_plane_routes.ts | head -100"}

### function_call_output
@callId call_72f2d5f06e7a4a5babd107dd
@ts 1770359245829
@durationMs 20
@workItemId 5040fed0
diff --git a/packages/harness-daemon/src/harness/control_plane_routes.ts b/packages/harness-daemon/src/harness/control_plane_routes.ts
index 12c3583..0aef8a7 100644
--- a/packages/harness-daemon/src/harness/control_plane_routes.ts
+++ b/packages/harness-daemon/src/harness/control_plane_routes.ts
@@ -346,6 +346,10 @@ const ALL_SESSION_STATUSES = [
   'inactive',
   'expired',
 ] as const;
+const MARKDOWN_WORKSPACE_DIR = '.cockpit/markdown';
+const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
+const MARKDOWN_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch', 'handoffs'];
+const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
@@ -387,6 +391,257 @@ function asStringArray(value: unknown): string[] {
   return value.filter((item): item is string => typeof item === 'string');
 }
 
+function hasMarkdownExtension(pathValue: string): boolean {
+  const lower = pathValue.toLowerCase();
+  for (const ext of MARKDOWN_FILE_EXTENSIONS) {
+    if (lower.endsWith(ext)) return true;
+  }
+  return false;
+}
+
+function normalizeWorkspaceRelativePath(rawPath: string, options?: { allowEmpty?: boolean }): string | null {
+  const trimmed = rawPath.trim();
+  if (!trimmed) return options?.allowEmpty ? '' : null;
+  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
+  const pieces = slashNormalized.split('/').map((item) => item.trim()).filter(Boolean);
+  if (pieces.length === 0) return options?.allowEmpty ? '' : null;
+  if (pieces.some((piece) => piece === '.' || piece === '..')) return null;
+  return pieces.join('/');
+}
+
+function sanitizeMarkdownName(rawName: string): string {
+  const normalized = rawName
+    .trim()
+    .replace(/\\/g, '/')
+    .split('/')
+    .pop() ?? '';
+  const safe = normalized
+    .replace(/[^a-zA-Z0-9._-]+/g, '-')
+    .replace(/-+/g, '-')
+    .replace(/^-+|-+$/g, '');
+  return safe || 'untitled.md';
+}
+
+function ensureMarkdownFileName(rawName: string): string {
+  const safe = sanitizeMarkdownName(rawName);
+  return hasMarkdownExtension(safe) ? safe : `${safe}.md`;
+}
+
+function ensureMarkdownExtensionOnPath(rawPath: string): string | null {
+  const normalized = normalizeWorkspaceRelativePath(rawPath);
+  if (normalized === null) return null;
+  return hasMarkdownExtension(normalized) ? normalized : `${normalized}.md`;
+}
+
+function buildVersionFromMtimeMs(mtimeMs: number): number {
+  if (!Number.isFinite(mtimeMs)) return 0;
+  return Math.max(0, Math.floor(mtimeMs));
+}
+
+async function getCockpitMarkdownWorkspaceRoot(ctx: ControlPlaneContext): Promise<string> {
+  const path = await import('path');
+  const fs = await import('fs/promises');
+  const root = path.resolve(ctx.workingDir, MARKDOWN_WORKSPACE_DIR);
+  await fs.mkdir(root, { recursive: true });
+  return root;
+}
+
+async function resolveCockpitMarkdownWorkspacePath(
+  ctx: ControlPlaneContext,
+  rawPath: string,
+  options?: { allowEmpty?: boolean; requireMarkdownFile?: boolean }
+): Promise<{ rootDir: string; relativePath: string; absolutePath: string } | { error: string }> {
+  const path = await import('path');
+  const rootDir = await getCockpitMarkdownWorkspaceRoot(ctx);
+  const relativePath = normalizeWorkspaceRelativePath(rawPath, { allowEmpty: options?.allowEmpty });
+  if (relativePath === null) {
+    return { error: 'Invalid markdown path' };
+  }
+  if (options?.requireMarkdownFile && relativePath && !hasMarkdownExtension(relativePath)) {
+    return { error: 'Markdown files must end with .md, .markdown, or .mdx' };
+  }
+  const absolutePath = relativePath
+    ? path.resolve(rootDir, relativePath)
+    : rootDir;
+  const inWorkspace = absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`);
+  if (!inWorkspace) {
+    return { error: 'Path must resolve inside the markdown workspace' };
+  }
+  return { rootDir, relativePath, absolutePath };
+}
+
+interface MarkdownWorkspaceFileRecord {
+  path: string;


### function_call
@callId call_6c9bcd75d2cc4c1bb4d9146d
@name Bash
@ts 1770359251440
@workItemId 5040fed0
{"command":"git diff packages/harness-daemon/src/harness/control_plane_routes.ts | grep -A 10 -B 5 \"llm_call\\|hook_call\\|iteration_started\\|memory_injected\""}

### function_call_output
@callId call_6c9bcd75d2cc4c1bb4d9146d
@ts 1770359251472
@durationMs 22
@workItemId 5040fed0
@@ -2556,6 +2819,11 @@ function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | '
     const eventType = String(event.payload.eventType ?? '').toLowerCase();
     if (eventType.includes('error') || eventType.includes('fail')) return 'high';
     if (eventType.includes('escalation')) return 'high';
+    // Internal events that should not appear in UI
+    if (eventType === 'llm_call' || eventType === 'hook_call' || eventType === 'iteration_started' || 
+        eventType === 'memory_injected' || eventType.includes('memory') || eventType.includes('inject')) {
+      return 'status';
+    }
     return 'low';
   }
 
@@ -2602,6 +2870,13 @@ function buildSessionEvents(
     const type = asString(entry.type);
     const ts = parseTimestampMs(entry.timestamp);
     if (!type || !ts) continue;
+    
+    // Skip internal events that slow down server and UI
+    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || 
+        type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {
+      continue;
+    }
+    
     const normalizedType = normalizeAgentEventType(type);
     const data = isRecord(entry.data) ? entry.data : {};
     const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';
@@ -2895,6 +3170,37 @@ export function handleControlPlaneRequest(
     return true;
   }
 


### function_call
@callId call_a9bd073bd5d743928b1762df
@name Bash
@ts 1770359261583
@workItemId 5040fed0
{"command":"git diff packages/dashboard-control/src/App.tsx | head -100"}

### function_call_output
@callId call_a9bd073bd5d743928b1762df
@ts 1770359261604
@durationMs 17
@workItemId 5040fed0
diff --git a/packages/dashboard-control/src/App.tsx b/packages/dashboard-control/src/App.tsx
index 7cae2be..57c3f18 100644
--- a/packages/dashboard-control/src/App.tsx
+++ b/packages/dashboard-control/src/App.tsx
@@ -7,6 +7,8 @@ import {
   getCockpitDailyMetrics,
   getCockpitEscalationRollups,
   getCockpitFocus,
+  getCockpitMarkdownFile,
+  getCockpitMarkdownTree,
   getCockpitPreview,
   getCockpitPRRollups,
   getCockpitSessionEvents,
@@ -16,6 +18,8 @@ import {
   getCockpitTraces,
   postCockpitBrowserAction,
   postCockpitBrowserRunbook,
+  postCockpitMarkdownFile,
+  postCockpitMarkdownFolder,
   postCockpitSessionMessage,
   postCockpitSessionReviewDecision,
   resolveCockpitEscalation,
@@ -24,6 +28,7 @@ import {
   type CockpitBrowserActionInput,
   type CockpitBrowserState,
   type CockpitDiff,
+  type CockpitMarkdownTreeNode,
   type CockpitTestReport,
   type DailyMetrics,
   type EscalationRollup,
@@ -41,17 +46,19 @@ type FocusTarget =
   | { type: 'session'; id: string }
   | { type: 'escalation'; id: string };
 
-type FocusTab = 'packet' | 'diff' | 'tests' | 'trace' | 'lens' | 'browser';
+type FocusTab = 'markdown' | 'packet' | 'diff' | 'tests' | 'trace' | 'lens' | 'browser';
 type PanelFocus = 'left' | 'center' | 'right' | 'input';
-type LeftSection = 'running' | 'ready' | 'done' | 'metrics';
-type RightSection = 'queue' | 'commits' | 'prs';
+type LeftSection = 'running' | 'ready' | 'metrics';
+type RightSection = 'directory' | 'done' | 'queue' | 'commits' | 'prs';
 type TrustTier = 'proven' | 'computed' | 'heuristic';
 type EventFilter = 'signal' | 'all' | 'messages' | 'tools' | 'failures' | 'audit';
 
-const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'done', 'metrics'];
-const RIGHT_SECTIONS: RightSection[] = ['queue', 'commits', 'prs'];
-const CENTER_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
+const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'metrics'];
+const RIGHT_SECTIONS: RightSection[] = ['directory', 'done', 'queue', 'commits', 'prs'];
+const CENTER_TABS: FocusTab[] = ['markdown', 'packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
 const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;
+const DEFAULT_MARKDOWN_TEXT = '';
+const DEFAULT_MARKDOWN_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch'];
 const DEFAULT_BROWSER_RUNBOOK = [
   '# One command per line',
   '# open https://example.com',
@@ -198,6 +205,60 @@ function cycleIndex(length: number, current: number, delta: number): number {
   return next;
 }
 
+function normalizeDocPath(rawPath: string): string | null {
+  const trimmed = rawPath.trim();
+  if (!trimmed) return null;
+  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
+  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
+  if (parts.length === 0) return null;
+  if (parts.some((part) => part === '.' || part === '..')) return null;
+  const joined = parts.join('/');
+  return /\.(md|markdown|mdx)$/i.test(joined) ? joined : `${joined}.md`;
+}
+
+function normalizeWorkspacePathForClient(rawPath: string, allowEmpty = false): string | null {
+  const trimmed = rawPath.trim();
+  if (!trimmed) return allowEmpty ? '' : null;
+  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
+  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
+  if (parts.length === 0) return allowEmpty ? '' : null;
+  if (parts.some((part) => part === '.' || part === '..')) return null;
+  return parts.join('/');
+}
+
+function flattenMarkdownFiles(tree: CockpitMarkdownTreeNode[]): string[] {
+  const files: string[] = [];
+  const visit = (node: CockpitMarkdownTreeNode) => {
+    if (node.type === 'file') {
+      files.push(node.path);
+      return;
+    }
+    for (const child of node.children ?? []) {
+      visit(child);
+    }
+  };
+  for (const node of tree) {
+    visit(node);
+  }
+  return files;
+}
+
+function gatherMarkdownFolders(tree: CockpitMarkdownTreeNode[]): string[] {
+  const folders = new Set<string>();


### function_call
@callId call_7d525939bf394a0da07ff680
@name Bash
@ts 1770359265290
@workItemId 5040fed0
{"command":"git diff packages/dashboard-control/src/App.tsx | grep -A 20 -B 5 \"Show Preview\\|session control\""}

### function_call_output
@callId call_7d525939bf394a0da07ff680
@ts 1770359265315
@durationMs 16
@workItemId 5040fed0
-                  className="px-2 py-0.5 text-[11px] rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
+                  onClick={() => void handleReviewDecision('accept')}
+                  disabled={reviewDecisionAction !== null}
+                  className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                 >
-                  {previewLoading ? 'Loading...' : previewVisible ? 'Hide Preview (V)' : 'Show Preview (V)'}
+                  {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}
+                </button>
+                <button
+                  onClick={() => void handleReviewDecision('request_changes')}
+                  disabled={reviewDecisionAction !== null}
+                  className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
+                >
+                  {reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}
                 </button>
-                {focusStatus === 'ready' && (
-                  <>
-                    <button
-                      onClick={() => void handleReviewDecision('accept')}
-                      disabled={reviewDecisionAction !== null}
-                      className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
-                    >
-                      {reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept (Done)'}
-                    </button>
-                    <button
-                      onClick={() => void handleReviewDecision('request_changes')}


### function_call
@callId call_58b2ac469bb242c483bdd806
@name Bash
@ts 1770359271421
@workItemId 5040fed0
{"command":"git diff --stat"}

### function_call_output
@callId call_58b2ac469bb242c483bdd806
@ts 1770359271444
@durationMs 19
@workItemId 5040fed0
 .../2026-02-06/tui_1770355801117_qip6an/context.md |   7 +-
 packages/dashboard-control/src/App.tsx             | 907 ++++++++++++++++++---
 packages/dashboard-control/src/index.css           |  15 +
 packages/dashboard-control/src/lib/api.ts          |  68 ++
 .../src/harness/control_plane_routes.ts            | 638 ++++++++++++++-
 5 files changed, 1493 insertions(+), 142 deletions(-)


### function_call
@callId call_ff047c2ed7ff409cbe7bfc01
@name Bash
@ts 1770359281118
@workItemId 5040fed0
{"command":"git status"}

### function_call_output
@callId call_ff047c2ed7ff409cbe7bfc01
@ts 1770359281145
@durationMs 23
@workItemId 5040fed0
On branch testWatcherAsync
Your branch is up to date with 'origin/testWatcherAsync'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   .haiku/sessions/2026-02-06/tui_1770355801117_qip6an/context.md
	modified:   packages/dashboard-control/src/App.tsx
	modified:   packages/dashboard-control/src/index.css
	modified:   packages/dashboard-control/src/lib/api.ts
	modified:   packages/harness-daemon/src/harness/control_plane_routes.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.haiku/sessions/2026-02-06/tui_1770357870575_rqplzg/
	.haiku/sessions/2026-02-06/tui_1770358026455_hckt8k/
	.haiku/sessions/2026-02-06/tui_1770358129978_805rks/
	.haiku/sessions/2026-02-06/tui_1770358193388_3nygy0/
	.haiku/sessions/2026-02-06/tui_1770358206351_o84jdn/
	.haiku/sessions/2026-02-06/tui_1770358237170_rendo5/
	.haiku/sessions/2026-02-06/tui_1770358548020_uslify/

no changes added to commit (use "git add" and/or "git commit -a")


### function_call
@callId call_e78fffbae7074336b51d4c4d
@name Read
@ts 1770359291892
@workItemId 5040fed0
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2440,"endLine":2475}

### function_call_output
@callId call_e78fffbae7074336b51d4c4d
@ts 1770359291899
@durationMs 4
@workItemId 5040fed0
// Lines 2440-2475 of 2660 total
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
            {focusStatus === 'ready' && (
              <div className="mt-1 flex items-center gap-1">
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
              </div>
            )}
            <div className="mt-2 flex items-center gap-1 text-[11px]">
              <button
                onClick={() => setFocusTab('markdown')}
                className={`px-1.5 py-0.5 rounded ${
                  focusTab === 'markdown'
                    ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}

### message:assistant
@ts 1770360315713
<tool_call>Read<arg_key>path</arg_key><arg_value>/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts</arg_value><arg_key>startLine</arg_key><arg_value>2818</arg_value><arg_key>endLine</arg_key><arg_value>2835</arg_value></tool_call>
