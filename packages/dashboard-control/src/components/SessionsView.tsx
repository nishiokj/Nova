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
