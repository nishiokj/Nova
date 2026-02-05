/**
 * Jobs Panel - Task orchestration overview
 */

import type { JobsOverview } from '@/lib/api';

interface JobsPanelProps {
  data: JobsOverview | null;
  loading: boolean;
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-[var(--bg-surface)] rounded-lg p-3 border border-[var(--border-subtle)]">
      <div className="text-xs text-[var(--text-muted)] mb-1">{label}</div>
      <div
        className="text-2xl font-semibold"
        style={{ color: color || 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  );
}

export function JobsPanel({ data, loading }: JobsPanelProps) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        Loading job status...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        No job data available
      </div>
    );
  }

  const { stats, circuitOpenTasks, recentJobs } = data;

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Tasks" value={stats.totalTasks} />
        <StatCard label="Enabled" value={stats.enabledTasks} color="var(--success)" />
        <StatCard label="Pending Jobs" value={stats.pendingJobs} color="var(--running)" />
        <StatCard label="Running" value={stats.runningJobs} color="var(--accent-cyan)" />
        <StatCard label="Completed" value={stats.completedJobs} color="var(--success)" />
        <StatCard label="Failed" value={stats.failedJobs} color="var(--error)" />
        <StatCard
          label="Circuit Open"
          value={stats.circuitOpen}
          color={stats.circuitOpen > 0 ? 'var(--warning)' : undefined}
        />
      </div>

      {/* Circuit Breaker Status */}
      {circuitOpenTasks.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">
            Circuit Breakers Open
          </h3>
          <div className="space-y-2">
            {circuitOpenTasks.map((task) => (
              <div
                key={task.id}
                className="bg-[var(--bg-surface)] rounded-lg p-3 border border-[var(--warning)]"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{task.name}</span>
                  <span className="text-xs text-[var(--warning)]">{task.consecutiveFailures} failures</span>
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate">{task.lastError}</div>
                <div className="text-xs text-[var(--text-muted)] mt-1">
                  Opens until: {new Date(task.openUntil).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Jobs */}
      <div>
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">Recent Jobs</h3>
        <div className="space-y-1">
          {recentJobs.slice(0, 10).map((job) => {
            const statusColors: Record<string, string> = {
              pending: 'var(--text-muted)',
              running: 'var(--running)',
              completed: 'var(--success)',
              failed: 'var(--error)',
            };
            return (
              <div
                key={job.id}
                className="flex items-center gap-2 py-1.5 px-2 rounded bg-[var(--bg-surface)] text-sm"
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: statusColors[job.status] || 'var(--text-muted)' }}
                />
                <span className="text-[var(--text-secondary)] truncate flex-1">{job.taskId}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(job.createdAt).toLocaleTimeString()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
