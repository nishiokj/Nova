/**
 * Project Browser - Navigate projects, features, and PRs
 */

import { useState, useEffect, useCallback } from 'react';
import type { Project, Feature, PRInfo } from '@/lib/api';
import { getProjects, getFeatures, getPRs } from '@/lib/api';

interface ProjectBrowserProps {
  onSelectPR?: (pr: PRInfo, project: Project, feature: Feature) => void;
}

export function ProjectBrowser({ onSelectPR }: ProjectBrowserProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
  const [prs, setPrs] = useState<PRInfo[]>([]);
  const [loading, setLoading] = useState({ projects: true, features: false, prs: false });
  const [error, setError] = useState<string | null>(null);

  // Load projects on mount
  useEffect(() => {
    setError(null);
    getProjects()
      .then(setProjects)
      .catch((err) => {
        console.error('Failed to load projects:', err);
        setError(String(err));
      })
      .finally(() => setLoading((l) => ({ ...l, projects: false })));
  }, []);

  // Load features when project selected
  const selectProject = useCallback(async (project: Project) => {
    setSelectedProject(project);
    setSelectedFeature(null);
    setPrs([]);
    setLoading((l) => ({ ...l, features: true }));
    try {
      const data = await getFeatures(project.path);
      setFeatures(data.features);
      setCurrentBranch(data.currentBranch);
    } catch (err) {
      console.error('Failed to load features:', err);
    } finally {
      setLoading((l) => ({ ...l, features: false }));
    }
  }, []);

  // Load PRs when feature selected
  const selectFeature = useCallback(async (feature: Feature) => {
    setSelectedFeature(feature);
    setLoading((l) => ({ ...l, prs: true }));
    try {
      // Extract owner/repo from project path or use defaults
      const prsData = await getPRs('owner', 'repo', feature.branch);
      setPrs(prsData);
    } catch (err) {
      console.error('Failed to load PRs:', err);
      setPrs([]);
    } finally {
      setLoading((l) => ({ ...l, prs: false }));
    }
  }, []);

  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      {/* Projects Column */}
      <div className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border-subtle)] overflow-hidden">
        <div className="p-3 border-b border-[var(--border-subtle)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Projects</h3>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {loading.projects ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : error ? (
            <div className="p-4 text-sm text-red-400">{error}</div>
          ) : projects.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No projects found</div>
          ) : (
            projects.map((project) => (
              <div
                key={project.id}
                className={`p-3 cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${selectedProject?.id === project.id ? 'bg-[var(--bg-elevated)]' : ''}`}
                onClick={() => selectProject(project)}
              >
                <div className="text-sm text-[var(--text-primary)] font-medium">{project.name}</div>
                <div className="text-xs text-[var(--text-muted)] truncate">{project.path}</div>
                <div className="flex gap-3 mt-1 text-xs text-[var(--text-muted)]">
                  <span>{project.sessionCount} sessions</span>
                  <span>{project.activeGoals} goals</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Features Column */}
      <div className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border-subtle)] overflow-hidden">
        <div className="p-3 border-b border-[var(--border-subtle)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">
            Features {currentBranch && <span className="text-[var(--text-muted)] font-normal">({currentBranch})</span>}
          </h3>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {!selectedProject ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Select a project</div>
          ) : loading.features ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : features.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No features found</div>
          ) : (
            features.map((feature) => (
              <div
                key={feature.id}
                className={`p-3 cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${selectedFeature?.id === feature.id ? 'bg-[var(--bg-elevated)]' : ''}`}
                onClick={() => selectFeature(feature)}
              >
                <div className="text-sm text-[var(--text-primary)] font-medium">{feature.name}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-[var(--accent-cyan)]">{feature.branch}</span>
                  <span className="text-xs text-[var(--text-muted)]">→ {feature.baseBranch}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1">{feature.sessionCount} sessions</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* PRs Column */}
      <div className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border-subtle)] overflow-hidden">
        <div className="p-3 border-b border-[var(--border-subtle)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Pull Requests</h3>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {!selectedFeature ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Select a feature</div>
          ) : loading.prs ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : prs.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No PRs found</div>
          ) : (
            prs.map((pr) => {
              const stateColors: Record<string, string> = {
                open: 'var(--success)',
                closed: 'var(--error)',
                merged: 'var(--accent-violet)',
              };
              return (
                <div
                  key={pr.number}
                  className="p-3 cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                  onClick={() => onSelectPR?.(pr, selectedProject!, selectedFeature)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: stateColors[pr.state] }}
                    />
                    <span className="text-sm text-[var(--text-primary)] font-medium">#{pr.number}</span>
                    {pr.isDraft && <span className="text-xs text-[var(--text-muted)]">(draft)</span>}
                  </div>
                  <div className="text-sm text-[var(--text-secondary)] truncate mt-1">{pr.title}</div>
                  <div className="flex gap-3 mt-2 text-xs">
                    <span className="text-[var(--success)]">+{pr.additions}</span>
                    <span className="text-[var(--error)]">-{pr.deletions}</span>
                    <span className="text-[var(--text-muted)]">{pr.changedFiles} files</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
