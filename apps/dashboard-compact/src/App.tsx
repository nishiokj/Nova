import { useSessions } from './hooks/useSessions';
import { SessionTable } from './components/SessionTable';

export default function App() {
  const { sessions, state, error, refetch } = useSessions();

  return (
    <div className="container">
      <header>
        <h1>Sessions</h1>
        <button
          onClick={refetch}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            padding: '4px 12px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          Refresh
        </button>
      </header>
      {state === 'loading' && (
        <div className="loading">Loading sessions...</div>
      )}
      {state === 'error' && (
        <div className="error">{error}</div>
      )}
      {state === 'success' && (
        <SessionTable sessions={sessions} loading={false} />
      )}
    </div>
  );
}
