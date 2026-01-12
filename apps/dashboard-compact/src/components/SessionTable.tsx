import { useState } from 'react';
import type { Session } from '@shared/domain/models';
import { SessionRow } from './SessionRow';

interface SessionTableProps {
  sessions: Session[];
  loading: boolean;
}

export function SessionTable({ sessions, loading }: SessionTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (sessions.length === 0) {
    return <div className="loading text-muted">No sessions found</div>;
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="text-muted border-b">
          <th className="py-1 px-2 w-6"></th>
          <th className="py-1 px-2">ID</th>
          <th className="py-1 px-2">Description</th>
          <th className="py-1 px-2 text-right">Reqs</th>
          <th className="py-1 px-2 text-right">In Tok</th>
          <th className="py-1 px-2 text-right">Out Tok</th>
          <th className="py-1 px-2 text-right">Duration</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            expanded={expandedId === session.id}
            onToggle={() =>
              setExpandedId(expandedId === session.id ? null : session.id)
            }
          />
        ))}
      </tbody>
    </table>
  );
}
