import type { Session } from '@shared/domain/models';
import { StatusDot } from './StatusDot';

interface SidebarItemProps {
  session: Session;
  onClick: () => void;
}

export function SidebarItem({ session, onClick }: SidebarItemProps) {
  const shortId = session.id.slice(0, 8);
  const description =
    (session.meta.description as string) ||
    session.requests[0]?.userInput?.slice(0, 50) ||
    'No description';
  const datetime = new Date(session.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="sidebar-item" onClick={onClick}>
      <div className="sidebar-item-header">
        <StatusDot status={session.state} />
        <span className="sidebar-item-id">{shortId}</span>
        <span className="sidebar-item-time">{datetime}</span>
      </div>
      <div className="sidebar-item-desc">{description}</div>
    </div>
  );
}
