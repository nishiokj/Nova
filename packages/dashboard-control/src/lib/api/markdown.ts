import { fetchAPI, postAPI, postAPIResult } from './fetch';
import type {
  CockpitMarkdownFile,
  CockpitMarkdownScope,
  CockpitMarkdownScopeInput,
  CockpitMarkdownTreeNode,
} from './types';

export async function getCockpitMarkdownTree(scope: CockpitMarkdownScopeInput = {}): Promise<{
  rootDir: string;
  tree: CockpitMarkdownTreeNode[];
  suggestedFolders: string[];
  scope?: CockpitMarkdownScope;
}> {
  const params = new URLSearchParams();
  if (scope.sessionKey) params.set('sessionKey', scope.sessionKey);
  if (scope.projectPath) params.set('projectPath', scope.projectPath);
  const data = await fetchAPI<{
    rootDir: string;
    tree: CockpitMarkdownTreeNode[];
    suggestedFolders: string[];
    scope?: CockpitMarkdownScope;
  }>(`/cockpit/markdown/tree?${params.toString()}`);
  return {
    rootDir: data.rootDir ?? '.cockpit/markdown',
    tree: data.tree ?? [],
    suggestedFolders: data.suggestedFolders ?? [],
    ...(data.scope ? { scope: data.scope } : {}),
  };
}

export async function getCockpitMarkdownFile(
  filePath: string,
  scope: CockpitMarkdownScopeInput = {}
): Promise<CockpitMarkdownFile> {
  const params = new URLSearchParams();
  params.set('path', filePath);
  if (scope.sessionKey) params.set('sessionKey', scope.sessionKey);
  if (scope.projectPath) params.set('projectPath', scope.projectPath);
  const data = await fetchAPI<{ file: CockpitMarkdownFile }>(
    `/cockpit/markdown/file?${params.toString()}`
  );
  return data.file;
}

export async function postCockpitMarkdownFile(input: {
  path: string;
  content: string;
  sessionKey?: string;
  projectPath?: string;
  expectedVersion?: number;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  created?: boolean;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  currentVersion?: number;
  currentHash?: string;
  statusCode?: number;
  error?: string;
}> {
  return postAPIResult('/cockpit/markdown/file', input);
}

export async function postCockpitMarkdownFolder(input: {
  path: string;
  sessionKey?: string;
  projectPath?: string;
}): Promise<{ success: boolean; folder?: { path: string } }> {
  return postAPI('/cockpit/markdown/folder', input);
}

export async function postCockpitMarkdownDelete(input: {
  path: string;
  type: 'file' | 'folder';
  recursive?: boolean;
  sessionKey?: string;
  projectPath?: string;
}): Promise<{
  success: boolean;
  deleted?: { path: string; type: 'file' | 'folder' };
  statusCode?: number;
  error?: string;
}> {
  return postAPIResult('/cockpit/markdown/delete', input);
}

export async function importCockpitMarkdownFile(input: {
  sessionKey?: string;
  markdownPath?: string;
  scopeSessionKey?: string;
  projectPath?: string;
  destinationPath?: string;
  folder?: string;
  filename?: string;
  content?: string;
  expectedVersion?: number;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  created?: boolean;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  sourcePath?: string;
  currentVersion?: number;
  currentHash?: string;
  statusCode?: number;
  error?: string;
}> {
  return postAPIResult('/cockpit/markdown/import', input);
}

export async function postCockpitMarkdownPatch(input: {
  path: string;
  expectedVersion: number;
  sessionKey?: string;
  projectPath?: string;
  content?: string;
  patch?: string;
  edits?: Array<{ startLine: number; endLine: number; replacement: string }>;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  mode?: 'content' | 'patch' | 'edits';
  changedLines?: number;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  currentVersion?: number;
  currentHash?: string;
  statusCode?: number;
  error?: string;
}> {
  return postAPIResult('/cockpit/markdown/patch', input);
}
