import type { Session } from '@shared/domain/models';
import { SidebarItem } from './SidebarItem';

interface SidebarProps {
  sessions: Session[];
  onSelectSession: (session: Session) => void;
}

export function Sidebar({ sessions, onSelectSession }: SidebarProps) {
  // Show only non-active (historical) sessions, latest first, max 10
  const historicalSessions = sessions
    .filter((s) => s.state !== 'active')
    .slice(0, 10);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">History</div>
      <div className="sidebar-list">
        {historicalSessions.length === 0 ? (
          <div className="sidebar-empty">No historical sessions</div>
        ) : (
          historicalSessions.map((session) => (
            <SidebarItem
              key={session.id}
              session={session}
              onClick={() => onSelectSession(session)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
