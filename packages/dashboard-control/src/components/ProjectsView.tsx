/**
 * Projects View - Browse projects with Git integration
 *
 * Shows projects with active sessions, git state, and PR info.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Session, PRInfo, GitInfo } from '@/lib/api';
import { getFeatures, getPRs, getGitInfo } from '@/lib/api';

interface ProjectsViewProps {
  sessions: Session[];
}

interface ProjectData {
  path: string;
  name: string;
  sessions: Session[];
  liveSessions: Session[];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function PRCard({ pr }: { pr: PRInfo }) {
  const stateColors: Record<string, string> = {
    open: 'var(--success)',
    closed: 'var(--error)',
    merged: 'var(--accent-violet)',
  };

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block px-2 py-1.5 hover:bg-[var(--bg-hover)] rounded transition-colors"
    >
      <div className="flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: stateColors[pr.state] }}
        />
        <span className="text-[var(--text-primary)] text-xs font-medium">#{pr.number}</span>
        <span className="text-[var(--text-secondary)] text-xs truncate flex-1">{pr.title}</span>
        {pr.isDraft && <span className="text-[var(--text-muted)] text-xs">(draft)</span>}
      </div>
      <div className="flex gap-2 mt-0.5 ml-4 text-xs">
        <span className="text-[var(--success)]">+{pr.additions}</span>
        <span className="text-[var(--error)]">-{pr.deletions}</span>
        <span className="text-[var(--text-muted)]">{pr.changedFiles} files</span>
        <span className="text-[var(--text-muted)] ml-auto">{relativeTime(pr.updatedAt)}</span>
      </div>
    </a>
  );
}

function ProjectPanel({ project }: { project: ProjectData }) {
  const [expanded, setExpanded] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [prs, setPrs] = useState<PRInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    if (!expanded) return;
    setLoading(true);
    try {
      const [git, featuresData] = await Promise.all([
        getGitInfo(project.path),
        getFeatures(project.path),
      ]);
      setGitInfo(git);
      // Store features for potential future use
      void featuresData;

      // If we have git remote info, fetch PRs
      if (git?.remote) {
        const prsData = await getPRs(git.remote.owner, git.remote.repo);
        setPrs(prsData.filter(pr => pr.state === 'open').slice(0, 10));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [expanded, project.path]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const hasLive = project.liveSessions.length > 0;

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        {hasLive && (
          <span className="w-2 h-2 rounded-full bg-[var(--live)] pulse-live shrink-0" />
        )}
        <span className="text-[var(--text-primary)] font-medium text-xs truncate flex-1">
          {project.name}
        </span>
        <span className="text-[var(--text-muted)] text-xs">
          {project.liveSessions.length > 0 && (
            <span className="text-[var(--live)]">{project.liveSessions.length} live</span>
          )}
          {project.liveSessions.length > 0 && project.sessions.length > project.liveSessions.length && ' · '}
          {project.sessions.length > project.liveSessions.length && (
            <span>{project.sessions.length - project.liveSessions.length} inactive</span>
          )}
        </span>
        <svg
          className={`w-3 h-3 text-[var(--text-muted)] transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-2 py-2 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
          {loading ? (
            <div className="text-xs text-[var(--text-muted)]">Loading...</div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {/* Git Info */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Git</div>
                {gitInfo ? (
                  <div className="space-y-1 text-xs">
                    <div className="flex gap-2">
                      <span className="text-[var(--accent-cyan)]">{gitInfo.currentBranch}</span>
                      {gitInfo.uncommittedChanges > 0 && (
                        <span className="text-[var(--warning)]">
                          {gitInfo.uncommittedChanges} uncommitted
                        </span>
                      )}
                    </div>
                    {gitInfo.remote && (
                      <div className="text-[var(--text-muted)] font-mono">
                        {gitInfo.remote.owner}/{gitInfo.remote.repo}
                      </div>
                    )}
                    {gitInfo.recentCommits.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[var(--text-muted)] mb-1">Recent commits:</div>
                        {gitInfo.recentCommits.slice(0, 5).map((commit) => (
                          <div key={commit.sha} className="flex gap-2 py-0.5">
                            <span className="font-mono text-[var(--accent-cyan)]">
                              {commit.sha}
                            </span>
                            <span className="text-[var(--text-secondary)] truncate">
                              {commit.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-[var(--text-muted)]">Not a git repo</div>
                )}
              </div>

              {/* PRs */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">
                  Open PRs {prs.length > 0 && `(${prs.length})`}
                </div>
                {prs.length > 0 ? (
                  <div className="space-y-0.5 max-h-40 overflow-y-auto">
                    {prs.map((pr) => (
                      <PRCard key={pr.number} pr={pr} />
                    ))}
                  </div>
                ) : gitInfo?.remote ? (
                  <div className="text-xs text-[var(--text-muted)]">No open PRs</div>
                ) : (
                  <div className="text-xs text-[var(--text-muted)]">No GitHub remote</div>
                )}
              </div>
            </div>
          )}

          {/* Path */}
          <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
            <div className="text-xs text-[var(--text-muted)] font-mono truncate">
              {project.path}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectsView({ sessions }: ProjectsViewProps) {
  // Group sessions by project
  const projects: ProjectData[] = [];
  const projectMap = new Map<string, ProjectData>();

  for (const session of sessions) {
    const path = session.workingDir;
    if (!path) continue;

    if (!projectMap.has(path)) {
      const name = path.split('/').pop() || path;
      projectMap.set(path, { path, name, sessions: [], liveSessions: [] });
    }

    const project = projectMap.get(path)!;
    project.sessions.push(session);

    const lastAccess = new Date(session.lastAccessedAt).getTime();
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    if (session.status === 'active' || lastAccess > fiveMinutesAgo) {
      project.liveSessions.push(session);
    }
  }

  // Sort by live sessions first, then by total sessions
  projects.push(...projectMap.values());
  projects.sort((a, b) => {
    if (a.liveSessions.length !== b.liveSessions.length) {
      return b.liveSessions.length - a.liveSessions.length;
    }
    return b.sessions.length - a.sessions.length;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-[var(--text-muted)]">
          Projects with agent sessions
        </span>
        <span className="text-[var(--text-muted)] ml-auto">
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Projects List */}
      <div className="flex-1 bg-[var(--bg-surface)] rounded border border-[var(--border-subtle)] overflow-y-auto">
        {projects.length === 0 ? (
          <div className="p-4 text-center">
            <div className="text-xs text-[var(--text-muted)]">
              No projects with sessions.
            </div>
          </div>
        ) : (
          projects.map((project) => (
            <ProjectPanel key={project.path} project={project} />
          ))
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--live)]" /> Has live sessions
        </span>
      </div>
    </div>
  );
}
