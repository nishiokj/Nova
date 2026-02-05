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
