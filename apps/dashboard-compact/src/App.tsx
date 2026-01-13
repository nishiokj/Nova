import { useState } from 'react';
import type { Session } from '@shared/domain/models';
import { useSessions } from './hooks/useSessions';
import { Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { SessionSummary } from './components/SessionSummary';

export default function App() {
  const { sessions, state, error } = useSessions(1000);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  if (state === 'loading') {
    return (
      <div className="app-layout">
        <div className="stage-empty">Loading sessions...</div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="app-layout">
        <div className="stage-empty" style={{ color: 'var(--red)' }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar sessions={sessions} onSelectSession={setSelectedSession} />
      <Stage sessions={sessions} onExpandSession={setSelectedSession} />
      {selectedSession && (
        <SessionSummary
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}
