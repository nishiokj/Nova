import type { CockpitFilesystemRoot } from '@/lib/api';

export const NEW_PROJECT_SCOPE_VALUE = '__new_project_scope__';
export const MAX_RECENT_PROJECT_SCOPE_OPTIONS = 5;

function buildScratchFallbackRoot(rootDir: string): CockpitFilesystemRoot {
  return {
    id: 'notes:fallback',
    kind: 'notes',
    label: '.cockpit',
    path: rootDir,
    pinned: true,
    source: 'daemon',
  };
}

export function getWorkspaceScopeOptionLabel(root: CockpitFilesystemRoot): string {
  if (root.kind === 'notes') return '.cockpit';
  return root.label || root.path;
}

export function buildWorkspaceScopeOptions(input: {
  filesystemRoots: CockpitFilesystemRoot[];
  rootDir: string;
  scopeMode: 'global' | 'session' | 'project';
  scopeProjectPath: string | null;
}): CockpitFilesystemRoot[] {
  const discoveredRoots = input.filesystemRoots.length > 0
    ? [...input.filesystemRoots]
    : [buildScratchFallbackRoot(input.rootDir)];
  const scratchRoot = discoveredRoots.find((root) => root.kind === 'notes')
    ?? buildScratchFallbackRoot(input.rootDir);
  const dedupedProjects: CockpitFilesystemRoot[] = [];
  const seenProjectPaths = new Set<string>();
  for (const root of discoveredRoots) {
    if (root.kind !== 'project') continue;
    if (seenProjectPaths.has(root.path)) continue;
    seenProjectPaths.add(root.path);
    dedupedProjects.push(root);
    if (dedupedProjects.length >= MAX_RECENT_PROJECT_SCOPE_OPTIONS) break;
  }
  const base: CockpitFilesystemRoot[] = [scratchRoot, ...dedupedProjects];

  if (
    input.scopeMode === 'project'
    && input.scopeProjectPath
    && !base.some((root) => root.kind === 'project' && root.path === input.scopeProjectPath)
  ) {
    base.push({
      id: `project:custom:${input.scopeProjectPath}`,
      kind: 'project',
      label: input.scopeProjectPath.split('/').filter(Boolean).pop() || input.scopeProjectPath,
      path: input.scopeProjectPath,
      pinned: false,
      source: 'discovered',
    });
  }

  return base;
}

export function getSelectedWorkspaceScopeId(input: {
  options: CockpitFilesystemRoot[];
  scopeMode: 'global' | 'session' | 'project';
  scopeProjectPath: string | null;
}): string {
  if (input.scopeMode === 'project' && input.scopeProjectPath) {
    const matched = input.options.find((root) => root.kind === 'project' && root.path === input.scopeProjectPath);
    if (matched) return matched.id;
  }
  return input.options.find((root) => root.kind === 'notes')?.id ?? input.options[0]?.id ?? '';
}
