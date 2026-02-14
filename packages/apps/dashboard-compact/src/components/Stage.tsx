import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@shared/domain/models';
import { SessionCard } from './SessionCard';

interface StageProps {
  sessions: Session[];
  onExpandSession: (session: Session) => void;
}

const ACTIVE_PAGE_SIZE = 12;

export function Stage({ sessions, onExpandSession }: StageProps) {
  // Show only active sessions
  const activeSessions = sessions.filter((s) => s.state === 'active');
  const [visibleCount, setVisibleCount] = useState(ACTIVE_PAGE_SIZE);
  const visibleSessions = useMemo(
    () => activeSessions.slice(0, visibleCount),
    [activeSessions, visibleCount]
  );
  const hasMore = visibleCount < activeSessions.length;

  useEffect(() => {
    setVisibleCount(ACTIVE_PAGE_SIZE);
  }, [activeSessions.length]);

  return (
    <main className="stage">
      {activeSessions.length === 0 ? (
        <div className="stage-empty">No active sessions</div>
      ) : (
        <>
          <div className="stage-grid">
            {visibleSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onExpand={() => onExpandSession(session)}
              />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleCount((prev) => prev + ACTIVE_PAGE_SIZE)}
              style={{
                marginTop: '12px',
                width: '100%',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-muted)',
                borderRadius: '8px',
                padding: '10px',
                cursor: 'pointer',
              }}
            >
              Load more active sessions ({activeSessions.length - visibleCount} remaining)
            </button>
          )}
        </>
      )}
    </main>
  );
}
