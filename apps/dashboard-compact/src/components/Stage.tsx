import type { Session } from '@shared/domain/models';
import { SessionCard } from './SessionCard';

interface StageProps {
  sessions: Session[];
  onExpandSession: (session: Session) => void;
}

export function Stage({ sessions, onExpandSession }: StageProps) {
  // Show only active sessions
  const activeSessions = sessions.filter((s) => s.state === 'active');

  return (
    <main className="stage">
      {activeSessions.length === 0 ? (
        <div className="stage-empty">No active sessions</div>
      ) : (
        <div className="stage-grid">
          {activeSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onExpand={() => onExpandSession(session)}
            />
          ))}
        </div>
      )}
    </main>
  );
}
