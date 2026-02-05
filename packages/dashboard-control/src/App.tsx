/**
 * Control Plane Dashboard - Main Application
 *
 * Shows session/project data from GraphD via harness-daemon's control-plane API.
 */

import { useState, useEffect } from 'react';
import { ProjectBrowser } from './components/ProjectBrowser';
import { GoalTree } from './components/GoalTree';
import { TokenUsagePanel } from './components/TokenUsage';
import { SessionList } from './components/SessionList';
import {
  getGoalHierarchy,
  getTokenUsage,
  getSessions,
  type GoalNode,
  type TokenUsage,
  type Session,
} from './lib/api';

type View = 'projects' | 'sessions' | 'goals' | 'tokens';

const navItems: { id: View; label: string; icon: string }[] = [
  { id: 'projects', label: 'Projects', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
  { id: 'sessions', label: 'Sessions', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  { id: 'goals', label: 'Goals', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'tokens', label: 'Tokens', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
];

export default function App() {
  const [view, setView] = useState<View>('projects');
  const [goals, setGoals] = useState<GoalNode[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tokenData, setTokenData] = useState<TokenUsage[]>([]);
  const [loading, setLoading] = useState({ goals: false, sessions: false, tokens: false });
  const [error, setError] = useState<string | null>(null);

  // Load data based on view
  useEffect(() => {
    setError(null);

    if (view === 'goals' && goals.length === 0) {
      setLoading((l) => ({ ...l, goals: true }));
      getGoalHierarchy()
        .then(setGoals)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading((l) => ({ ...l, goals: false })));
    }
    if (view === 'sessions' && sessions.length === 0) {
      setLoading((l) => ({ ...l, sessions: true }));
      getSessions(100)
        .then(setSessions)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading((l) => ({ ...l, sessions: false })));
    }
    if (view === 'tokens' && tokenData.length === 0) {
      setLoading((l) => ({ ...l, tokens: true }));
      getTokenUsage()
        .then(setTokenData)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading((l) => ({ ...l, tokens: false })));
    }
  }, [view, goals.length, sessions.length, tokenData.length]);

  const refresh = () => {
    if (view === 'sessions') {
      setLoading((l) => ({ ...l, sessions: true }));
      getSessions(100)
        .then(setSessions)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading((l) => ({ ...l, sessions: false })));
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <nav className="w-56 bg-[var(--bg-surface)] border-r border-[var(--border-default)] flex flex-col">
        <div className="p-4 border-b border-[var(--border-default)]">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Control Plane</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">Session Browser</p>
        </div>

        <div className="flex-1 py-2">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                view === item.id
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border-r-2 border-[var(--running)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
              </svg>
              {item.label}
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-[var(--border-default)]">
          <div className="text-xs text-[var(--text-muted)]">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${error ? 'bg-[var(--error)]' : 'bg-[var(--success)]'}`}></div>
              {error ? 'Error' : 'Connected'}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-[var(--text-primary)]">
              {navItems.find((n) => n.id === view)?.label}
            </h2>
            {view === 'sessions' && (
              <button
                onClick={refresh}
                className="px-3 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border-default)] rounded hover:bg-[var(--bg-hover)] transition-colors"
              >
                Refresh
              </button>
            )}
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
              {error}
            </div>
          )}

          {/* View Content */}
          {view === 'projects' && <ProjectBrowser />}
          {view === 'sessions' && <SessionList sessions={sessions} loading={loading.sessions} />}
          {view === 'goals' && <GoalTree goals={goals} />}
          {view === 'tokens' && <TokenUsagePanel data={tokenData} loading={loading.tokens} />}
        </div>
      </main>
    </div>
  );
}
