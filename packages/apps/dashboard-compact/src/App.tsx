import { useState } from 'react';
import type { Session } from '@shared/domain/models';
import { useSessionState } from './hooks/useSessionState';
import { Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { SessionSummary } from './components/SessionSummary';
import { AnalyticsView } from './components/AnalyticsView';

type ViewType = 'sessions' | 'analytics';

export default function App() {
  const { sessions, loading, error, connected } = useSessionState();
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [view, setView] = useState<ViewType>('sessions');

  if (loading && sessions.length === 0) {
    return (
      <div className="app-layout">
        <div className="stage-empty">Loading sessions...</div>
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className="app-layout">
        <div className="stage-empty" style={{ color: 'var(--red)' }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="view-tabs">
        <button
          className={`view-tab ${view === 'sessions' ? 'active' : ''}`}
          onClick={() => setView('sessions')}
        >
          Sessions
        </button>
        <button
          className={`view-tab ${view === 'analytics' ? 'active' : ''}`}
          onClick={() => setView('analytics')}
        >
          Analytics
        </button>
        <span
          className="live-indicator"
          title={connected ? 'Connected to live event bus' : 'Disconnected - using polling'}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            color: connected ? 'var(--green)' : 'var(--text-muted)',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: connected ? 'var(--green)' : 'var(--text-muted)',
              animation: connected ? 'pulse 2s infinite' : 'none',
            }}
          />
          {connected ? 'LIVE' : 'POLLING'}
        </span>
      </div>

      {view === 'sessions' ? (
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
      ) : (
        <AnalyticsView sessions={sessions} />
      )}
    </div>
  );
}
