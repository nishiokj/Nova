/**
 * Markdown Workspace Routes & Helpers
 *
 * All markdown workspace functions extracted from control_plane_routes.ts:
 * path/validation, versioning/hashing, scope resolution, metadata I/O,
 * file write/patch, tree/discovery, route handlers, and message context.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  type ControlPlaneContext,
  type MarkdownWorkspaceScope,
  type MarkdownWorkspaceScopeMode,
  type CockpitFilesystemRootRecord,
  type SessionRow,
  sendJson,
  readBody,
  readJsonBody,
  parseUrl,
  isRecord,
  asString,
  asNumber,
  asBoolean,
  execFileText,
  normalizeDiffPath,
  MARKDOWN_WORKSPACE_DIR,
  MARKDOWN_METADATA_DIR,
  MARKDOWN_FILE_EXTENSIONS,
  MARKDOWN_SUGGESTED_FOLDERS,
  MARKDOWN_MAX_BYTES,
  MARKDOWN_METADATA_MAX_BYTES,
  MARKDOWN_CHAT_CONTEXT_MAX_BYTES,
  COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS,
  COCKPIT_PROJECT_DISCOVERY_MAX_DEPTH,
  SESSION_PERMISSION_SETTINGS_RELATIVE_PATH,
} from './utils.js';
import { getSession, getAllSessions } from './sessions.js';
import { resolveSessionFilePath, parsePatchStats } from './git.js';

// ---------------------------------------------------------------------------
// Path & Validation
// ---------------------------------------------------------------------------

export function hasMarkdownExtension(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  for (const ext of MARKDOWN_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function normalizeWorkspaceRelativePath(rawPath: string, options?: { allowEmpty?: boolean }): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return options?.allowEmpty ? '' : null;
  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const pieces = slashNormalized.split('/').map((item) => item.trim()).filter(Boolean);
  if (pieces.length === 0) return options?.allowEmpty ? '' : null;
  if (pieces.some((piece) => piece === '.' || piece === '..')) return null;
  return pieces.join('/');
}

export function sanitizeMarkdownName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const safe = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'untitled.md';
}

export function ensureMarkdownFileName(rawName: string): string {
  const safe = sanitizeMarkdownName(rawName);
  return hasMarkdownExtension(safe) ? safe : `${safe}.md`;
}

export function ensureMarkdownExtensionOnPath(rawPath: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (normalized === null) return null;
  return hasMarkdownExtension(normalized) ? normalized : `${normalized}.md`;
}

const MARKDOWN_DRAFTS_DIR = '.drafts';
const PROJECT_DRAFTS_DIR = '.cockpit/drafts';

function sanitizeScopeToken(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const safe = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || fallback;
}

function sanitizeMarkdownDraftId(raw: string | undefined): string | null {
  if (!raw) return null;
  const safe = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : null;
}

async function materializeMarkdownDraftFromContent(
  ctx: ControlPlaneContext,
  input: {
    content: string;
    sessionKey?: string;
    projectPath?: string;
    draftId?: string;
  }
): Promise<
  | {
      ok: true;
      scope: MarkdownWorkspaceScope;
      rootDir: string;
      relativePath: string;
      absolutePath: string;
      version: number;
      updatedAt: string;
      hash: string;
      draftId: string;
    }
  | { ok: false; status: number; error: string }
> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const crypto = await import('crypto');

  const scopeResult = await resolveMarkdownWorkspaceScope(ctx, {
    sessionKey: input.sessionKey ?? null,
    projectPath: input.projectPath ?? null,
  });
  if ('error' in scopeResult) {
    return { ok: false, status: scopeResult.status, error: scopeResult.error };
  }
  const scope = scopeResult;

  const normalizedDraftId = sanitizeMarkdownDraftId(input.draftId)
    ?? crypto.randomUUID().replace(/-/g, '');
  const sessionBucket = scope.sessionKey
    ? `session-${sanitizeScopeToken(scope.sessionKey, 'session')}`
    : (scope.mode === 'project' ? 'project' : 'global');

  const rootDir = scope.mode === 'project'
    ? path.resolve(scope.workingDir)
    : path.resolve(scope.workingDir, MARKDOWN_WORKSPACE_DIR);
  const draftPrefix = scope.mode === 'project' ? PROJECT_DRAFTS_DIR : MARKDOWN_DRAFTS_DIR;
  const relativePath = normalizeWorkspaceRelativePath(`${draftPrefix}/${sessionBucket}/${normalizedDraftId}.md`);
  if (!relativePath) {
    return { ok: false, status: 400, error: 'Failed resolving markdown draft path' };
  }
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!(absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`))) {
    return { ok: false, status: 400, error: 'Draft path resolved outside markdown workspace' };
  }

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    let existing: string | null = null;
    try {
      existing = await fs.readFile(absolutePath, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== input.content) {
      await fs.writeFile(absolutePath, input.content, 'utf8');
    }
    const stat = await fs.stat(absolutePath);
    return {
      ok: true,
      scope,
      rootDir,
      relativePath,
      absolutePath,
      version: buildVersionFromMtimeMs(stat.mtimeMs),
      updatedAt: stat.mtime.toISOString(),
      hash: await buildMarkdownContentHash(input.content),
      draftId: normalizedDraftId,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `Failed materializing markdown draft: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Versioning & Hashing
// ---------------------------------------------------------------------------

export function buildVersionFromMtimeMs(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs)) return 0;
  return Math.max(0, Math.floor(mtimeMs));
}

export async function buildMarkdownContentHash(content: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function buildMarkdownWordCount(content: string): number {
  const matches = content.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

export function buildMarkdownLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

export function buildMarkdownEtag(version: number, hash: string): string {
  const shortHash = hash.slice(0, 16);
  return `W/"${Math.max(0, version)}-${shortHash}"`;
}

export async function resolveMarkdownMetadataPath(rootDir: string, relativePath: string): Promise<string> {
  const path = await import('path');
  const metadataRoot = path.resolve(rootDir, MARKDOWN_METADATA_DIR);
  const metadataPath = path.resolve(metadataRoot, `${relativePath}.meta.json`);
  if (metadataPath === metadataRoot || metadataPath.startsWith(`${metadataRoot}${path.sep}`)) {
    return metadataPath;
  }
  throw new Error('Metadata path resolved outside markdown metadata workspace');
}

// ---------------------------------------------------------------------------
// MarkdownWorkspaceFileRecord
// ---------------------------------------------------------------------------

export interface MarkdownWorkspaceFileRecord {
  path: string;
  version: number;
  updatedAt: string;
  size: number;
  hash: string;
  etag: string;
  lineCount: number;
  wordCount: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scope Resolution
// ---------------------------------------------------------------------------

export function readMarkdownScopeFromBody(body: Record<string, unknown>): {
  sessionKey?: string;
  projectPath?: string;
} {
  const sessionKey = asString(body.scopeSessionKey) ?? asString(body.workspaceSessionKey) ?? asString(body.sessionKey);
  const projectPath = asString(body.projectPath) ?? asString(body.project_path);
  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

export function normalizeProjectPathInput(rawPath: string | null | undefined): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveMarkdownWorkspaceScope(
  ctx: ControlPlaneContext,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<MarkdownWorkspaceScope | { error: string; status: number }> {
  const path = await import('path');
  const fs = await import('fs/promises');

  const sessionKey = asString(options?.sessionKey);
  if (sessionKey) {
    const session = getSession(ctx, sessionKey);
    if (!session) {
      return { error: `Session not found: ${sessionKey}`, status: 404 };
    }
    const workingDir = path.resolve(session.workingDir ?? ctx.workingDir);
    return { mode: 'session', sessionKey, workingDir };
  }

  const projectPathInput = normalizeProjectPathInput(options?.projectPath ?? null);
  if (projectPathInput) {
    const resolvedProjectPath = path.isAbsolute(projectPathInput)
      ? path.resolve(projectPathInput)
      : path.resolve(ctx.workingDir, projectPathInput);
    try {
      const stat = await fs.stat(resolvedProjectPath);
      if (!stat.isDirectory()) {
        return { error: `Project path is not a directory: ${resolvedProjectPath}`, status: 400 };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('enoent')) {
        return { error: `Project path not found: ${resolvedProjectPath}`, status: 404 };
      }
      return { error: `Unable to access project path: ${message}`, status: 400 };
    }
    return {
      mode: 'project',
      projectPath: resolvedProjectPath,
      workingDir: resolvedProjectPath,
    };
  }

  return {
    mode: 'global',
    workingDir: path.resolve(ctx.workingDir),
  };
}

export async function getCockpitMarkdownWorkspaceRootForScope(
  ctx: ControlPlaneContext,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<
  | { root: string; scope: MarkdownWorkspaceScope }
  | { error: string; status: number }
> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const scope = await resolveMarkdownWorkspaceScope(ctx, options);
  if ('error' in scope) return scope;
  // Notes/global workspace lives under .cockpit/markdown.
  // Project scope maps directly to the real project directory.
  const root = scope.mode === 'project'
    ? path.resolve(scope.workingDir)
    : path.resolve(scope.workingDir, MARKDOWN_WORKSPACE_DIR);
  if (scope.mode !== 'project') {
    await fs.mkdir(root, { recursive: true });
  }
  return { root, scope };
}

export async function resolveCockpitMarkdownWorkspacePath(
  ctx: ControlPlaneContext,
  rawPath: string,
  options?: {
    allowEmpty?: boolean;
    requireMarkdownFile?: boolean;
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<
  | { rootDir: string; relativePath: string; absolutePath: string; scope: MarkdownWorkspaceScope }
  | { error: string; status?: number }
> {
  const path = await import('path');
  const scopeRoot = await getCockpitMarkdownWorkspaceRootForScope(ctx, options);
  if ('error' in scopeRoot) {
    return {
      error: scopeRoot.error,
      status: scopeRoot.status,
    };
  }
  const rootDir = scopeRoot.root;
  const relativePath = normalizeWorkspaceRelativePath(rawPath, { allowEmpty: options?.allowEmpty });
  if (relativePath === null) {
    return { error: 'Invalid markdown path', status: 400 };
  }
  if (options?.requireMarkdownFile && relativePath && !hasMarkdownExtension(relativePath)) {
    return { error: 'Markdown files must end with .md, .markdown, or .mdx', status: 400 };
  }
  const absolutePath = relativePath
    ? path.resolve(rootDir, relativePath)
    : rootDir;
  const inWorkspace = absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`);
  if (!inWorkspace) {
    return { error: 'Path must resolve inside the markdown workspace', status: 400 };
  }
  return { rootDir, relativePath, absolutePath, scope: scopeRoot.scope };
}

// ---------------------------------------------------------------------------
// Metadata I/O
// ---------------------------------------------------------------------------

export function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (depth > 5) return undefined;
  if (typeof value === 'string') {
    return value.length > 4_000 ? value.slice(0, 4_000) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, 128)) {
      const next = sanitizeMetadataValue(item, depth + 1);
      if (next !== undefined) out.push(next);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= 128) break;
      const key = rawKey.trim();
      if (!key) continue;
      const next = sanitizeMetadataValue(rawValue, depth + 1);
      if (next === undefined) continue;
      out[key] = next;
      count += 1;
    }
    return out;
  }
  return undefined;
}

export function sanitizeMarkdownMetadata(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeMetadataValue(value, 0);
  if (!isRecord(sanitized)) return undefined;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > MARKDOWN_METADATA_MAX_BYTES) return undefined;
  return sanitized;
}

export async function readMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string
): Promise<Record<string, unknown> | undefined> {
  const fs = await import('fs/promises');
  try {
    const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
    const raw = await fs.readFile(metadataPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MARKDOWN_METADATA_MAX_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeMarkdownMetadata(parsed);
  } catch {
    return undefined;
  }
}

export async function writeMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export async function buildMarkdownWorkspaceFileRecord(
  rootDir: string,
  relativePath: string,
  content: string,
  stat: { mtimeMs: number; mtime: Date; size: number },
  metadata?: Record<string, unknown>
): Promise<MarkdownWorkspaceFileRecord> {
  const version = buildVersionFromMtimeMs(stat.mtimeMs);
  const hash = await buildMarkdownContentHash(content);
  return {
    path: relativePath,
    version,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    hash,
    etag: buildMarkdownEtag(version, hash),
    lineCount: buildMarkdownLineCount(content),
    wordCount: buildMarkdownWordCount(content),
    ...(metadata ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// File Write & Patch
// ---------------------------------------------------------------------------

export async function writeCockpitMarkdownWorkspaceFile(
  ctx: ControlPlaneContext,
  input: {
    path: string;
    content: string;
    sessionKey?: string;
    projectPath?: string;
    expectedVersion?: number;
    metadata?: Record<string, unknown>;
    operation?: 'write' | 'import' | 'patch';
    source?: string;
    baseVersion?: number;
  }
): Promise<
  | { ok: true; file: MarkdownWorkspaceFileRecord; created: boolean; previousVersion: number }
  | { ok: false; status: number; error: string; currentVersion?: number; currentUpdatedAt?: string; currentHash?: string }
> {
  const pathModule = await import('path');
  const fs = await import('fs/promises');
  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, input.path, {
    requireMarkdownFile: true,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  });
  if ('error' in resolved) {
    return {
      ok: false,
      status: resolved.status ?? 400,
      error: resolved.error,
    };
  }

  if (Buffer.byteLength(input.content, 'utf8') > MARKDOWN_MAX_BYTES) {
    return { ok: false, status: 400, error: `Markdown payload exceeds ${MARKDOWN_MAX_BYTES} bytes` };
  }

  let existing:
    | {
        version: number;
        updatedAt: string;
        size: number;
        content: string;
      }
    | undefined;
  try {
    const [stat, content] = await Promise.all([
      fs.stat(resolved.absolutePath),
      fs.readFile(resolved.absolutePath, 'utf8'),
    ]);
    if (stat.isFile()) {
      existing = {
        version: buildVersionFromMtimeMs(stat.mtimeMs),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        content,
      };
    }
  } catch {
    existing = undefined;
  }

  if (typeof input.expectedVersion === 'number' && Number.isFinite(input.expectedVersion)) {
    const expected = Math.floor(input.expectedVersion);
    const current = existing?.version ?? 0;
    if (current !== expected) {
      return {
        ok: false,
        status: 409,
        error: 'Version conflict while writing markdown file',
        currentVersion: current,
        ...(existing?.updatedAt ? { currentUpdatedAt: existing.updatedAt } : {}),
        ...(existing?.content ? { currentHash: await buildMarkdownContentHash(existing.content) } : {}),
      };
    }
  }

  await fs.mkdir(pathModule.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, input.content, 'utf8');
  const [stat, metadataBase] = await Promise.all([
    fs.stat(resolved.absolutePath),
    readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
  ]);
  const incomingMetadata = sanitizeMarkdownMetadata(input.metadata);
  const nextFile = await buildMarkdownWorkspaceFileRecord(
    resolved.rootDir,
    resolved.relativePath,
    input.content,
    stat,
  );
  const mergedMetadata = sanitizeMarkdownMetadata({
    ...(metadataBase ?? {}),
    ...(incomingMetadata ?? {}),
    source: asString(input.source)
      ?? asString(incomingMetadata?.source)
      ?? asString(metadataBase?.source)
      ?? (input.operation === 'import' ? 'import' : 'control-plane'),
    createdAt: asString(metadataBase?.createdAt) ?? nextFile.updatedAt,
    updatedAt: nextFile.updatedAt,
    lineCount: nextFile.lineCount,
    wordCount: nextFile.wordCount,
    hash: nextFile.hash,
    size: nextFile.size,
    cockpit: sanitizeMetadataValue({
      ...(isRecord(metadataBase?.cockpit) ? metadataBase.cockpit : {}),
      path: nextFile.path,
      version: nextFile.version,
      etag: nextFile.etag,
      hash: nextFile.hash,
      lineCount: nextFile.lineCount,
      wordCount: nextFile.wordCount,
      ...(typeof input.baseVersion === 'number' ? { baseVersion: Math.floor(input.baseVersion) } : {}),
      ...(typeof existing?.version === 'number' ? { previousVersion: existing.version } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      scopeMode: resolved.scope.mode,
      scopeWorkingDir: resolved.scope.workingDir,
      ...(resolved.scope.sessionKey ? { scopeSessionKey: resolved.scope.sessionKey } : {}),
      ...(resolved.scope.projectPath ? { scopeProjectPath: resolved.scope.projectPath } : {}),
      updatedAt: nextFile.updatedAt,
    }),
  });
  try {
    if (mergedMetadata) {
      await writeMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath, mergedMetadata);
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `Failed to persist markdown metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    created: !existing,
    previousVersion: existing?.version ?? 0,
    file: {
      ...nextFile,
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
    },
  };
}

export interface MarkdownPatchEditInput {
  startLine: number;
  endLine: number;
  replacement: string;
}

export function parseMarkdownPatchEdits(value: unknown): MarkdownPatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: MarkdownPatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!startLine || !endLine || replacement === undefined) continue;
    edits.push({
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

export function applyMarkdownStructuredEdits(
  content: string,
  edits: MarkdownPatchEditInput[]
): { ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number } {
  const hadTrailingNewline = content.endsWith('\n');
  const baseText = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = baseText.length > 0 ? baseText.split('\n') : [];
  let changedLines = 0;
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const edit of ordered) {
    if (edit.startLine < 1) {
      return { ok: false, status: 400, error: 'Invalid startLine in markdown edits' };
    }
    if (edit.endLine < edit.startLine - 1) {
      return { ok: false, status: 400, error: 'Invalid endLine in markdown edits' };
    }
    if (edit.endLine > lines.length) {
      return {
        ok: false,
        status: 400,
        error: `Edit range out of bounds: ${edit.startLine}-${edit.endLine} (lines=${lines.length})`,
      };
    }
    if (edit.startLine > lines.length + 1) {
      return {
        ok: false,
        status: 400,
        error: `Edit start out of bounds: ${edit.startLine} (lines=${lines.length})`,
      };
    }
    const startIdx = Math.min(lines.length, edit.startLine - 1);
    const deleteCount = Math.max(0, edit.endLine - edit.startLine + 1);
    const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
    lines.splice(startIdx, deleteCount, ...replacementLines);
    changedLines += Math.max(deleteCount, replacementLines.length);
  }
  return {
    ok: true,
    content: lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
    changedLines,
  };
}

export async function applyMarkdownUnifiedDiffPatch(
  relativePath: string,
  currentContent: string,
  patch: string
): Promise<{ ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number }> {
  const stats = parsePatchStats(patch);
  if (stats.hasBinary) {
    return { ok: false, status: 400, error: 'Binary markdown patch is not supported' };
  }
  if (stats.files.length === 0) {
    return { ok: false, status: 400, error: 'No files detected in markdown patch payload' };
  }
  const normalizedTarget = normalizeDiffPath(relativePath);
  const mismatched = stats.files.filter((filePath) => normalizeDiffPath(filePath) !== normalizedTarget);
  if (mismatched.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Markdown patch must only target ${relativePath}; found ${mismatched.join(', ')}`,
    };
  }

  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-md-patch-'));
  try {
    const targetPath = path.resolve(tempDir, normalizedTarget);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, currentContent, 'utf8');
    const patchPath = path.join(tempDir, 'markdown.patch');
    await fs.writeFile(patchPath, patch, 'utf8');
    await execFileText('git', ['apply', '--check', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileText('git', ['apply', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const nextContent = await fs.readFile(targetPath, 'utf8');
    return { ok: true, content: nextContent, changedLines: stats.changedLines };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tree & Discovery
// ---------------------------------------------------------------------------

export async function buildCockpitMarkdownWorkspaceTree(
  ctx: ControlPlaneContext,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<{
  rootDir: string;
  tree: Array<Record<string, unknown>>;
  suggestedFolders: string[];
  scope: MarkdownWorkspaceScope;
}> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const scopeRoot = await getCockpitMarkdownWorkspaceRootForScope(ctx, options);
  if ('error' in scopeRoot) {
    throw new Error(scopeRoot.error);
  }
  const rootDir = scopeRoot.root;
  const projectScope = scopeRoot.scope.mode === 'project';

  const counters = { files: 0 };
  const MAX_FILES = 1000;
  const MAX_DEPTH = 6;
  const PROJECT_IGNORED_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'coverage',
    'target',
    '.next',
    '.turbo',
    '.cache',
  ]);

  const scanDir = async (absoluteDir: string, relativeDir: string, depth: number): Promise<Array<Record<string, unknown>>> => {
    if (depth > MAX_DEPTH || counters.files >= MAX_FILES) return [];
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }> = [];
    try {
      const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
      entries = dirEntries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink) continue;

      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absPath = path.join(absoluteDir, entry.name);

      if (entry.isDirectory) {
        if (projectScope && PROJECT_IGNORED_DIRS.has(entry.name)) continue;
        const children = await scanDir(absPath, relPath, depth + 1);
        nodes.push({
          type: 'folder',
          name: entry.name,
          path: relPath,
          children,
        });
        continue;
      }

      if (!entry.isFile || !hasMarkdownExtension(entry.name)) continue;
      let statSize = 0;
      let updatedAt = new Date(0).toISOString();
      let version = 0;
      try {
        const stat = await fs.stat(absPath);
        statSize = stat.size;
        updatedAt = stat.mtime.toISOString();
        version = buildVersionFromMtimeMs(stat.mtimeMs);
      } catch {
        // Ignore flaky file metadata reads and still list the file.
      }

      counters.files += 1;
      nodes.push({
        type: 'file',
        name: entry.name,
        path: relPath,
        size: statSize,
        updatedAt,
        version,
      });
      if (counters.files >= MAX_FILES) break;
    }
    return nodes;
  };

  const tree = await scanDir(rootDir, '', 0);
  const folderSuggestions = new Set<string>(
    projectScope ? [] : MARKDOWN_SUGGESTED_FOLDERS
  );
  for (const node of tree) {
    if (node.type !== 'folder') continue;
    if (typeof node.path === 'string' && node.path.trim()) {
      folderSuggestions.add(node.path);
    }
  }
  return {
    rootDir,
    tree,
    suggestedFolders: Array.from(folderSuggestions).slice(0, 12),
    scope: scopeRoot.scope,
  };
}

export async function discoverProjectRootsFromDirectory(
  baseDir: string,
  maxDepth = COCKPIT_PROJECT_DISCOVERY_MAX_DEPTH,
  maxResults = COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS
): Promise<string[]> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(baseDir), depth: 0 }];
  const visited = new Set<string>();
  const found = new Set<string>();

  while (queue.length > 0 && found.size < maxResults) {
    const current = queue.shift();
    if (!current) break;
    const absDir = path.resolve(current.dir);
    if (visited.has(absDir)) continue;
    visited.add(absDir);

    let entries: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      const raw = await fs.readdir(absDir, { withFileTypes: true });
      entries = raw.map((item) => ({
        name: item.name,
        isDirectory: item.isDirectory(),
      }));
    } catch {
      continue;
    }

    const hasGitDir = entries.some((entry) => entry.isDirectory && entry.name === '.git');
    if (hasGitDir) {
      found.add(absDir);
      continue;
    }

    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith('.')) continue;
      queue.push({
        dir: path.join(absDir, entry.name),
        depth: current.depth + 1,
      });
      if (queue.length > maxResults * 10) break;
    }
  }

  return Array.from(found);
}

export async function buildCockpitFilesystemRoots(
  ctx: ControlPlaneContext,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<{
  cwd: string;
  roots: CockpitFilesystemRootRecord[];
}> {
  const path = await import('path');
  const cwdScope = await resolveMarkdownWorkspaceScope(ctx, {
    sessionKey: options?.sessionKey ?? null,
    projectPath: options?.projectPath ?? null,
  });
  if ('error' in cwdScope) {
    throw new Error(cwdScope.error);
  }
  const cwd = path.resolve(cwdScope.workingDir);
  const notesRoot = path.resolve(ctx.workingDir, MARKDOWN_WORKSPACE_DIR);

  const roots: CockpitFilesystemRootRecord[] = [{
    id: `notes:${notesRoot}`,
    kind: 'notes',
    label: '.cockpit/markdown',
    path: notesRoot,
    pinned: true,
    source: 'daemon',
  }];

  const seenProjectPaths = new Set<string>();
  const knownProjectCounts = new Map<string, { count: number; lastAccessedAt: number; sessionKey?: string }>();
  const { sessions } = getAllSessions(ctx, 1000);
  for (const session of sessions) {
    const wd = asString(session.workingDir);
    if (!wd) continue;
    const normalized = path.resolve(wd);
    const sessionLastAccess = Number.isFinite(session.lastAccessedAt)
      ? session.lastAccessedAt
      : 0;
    const existing = knownProjectCounts.get(normalized);
    if (existing) {
      existing.count += 1;
      if (sessionLastAccess >= existing.lastAccessedAt) {
        existing.lastAccessedAt = sessionLastAccess;
        existing.sessionKey = session.sessionKey;
      }
      continue;
    }
    knownProjectCounts.set(normalized, {
      count: 1,
      lastAccessedAt: sessionLastAccess,
      ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
    });
  }

  const sortedKnownProjects = Array.from(knownProjectCounts.entries())
    .sort((a, b) => {
      if (a[1].lastAccessedAt !== b[1].lastAccessedAt) {
        return b[1].lastAccessedAt - a[1].lastAccessedAt;
      }
      if (a[1].count !== b[1].count) {
        return b[1].count - a[1].count;
      }
      return a[0].localeCompare(b[0]);
    });
  for (const [projectPath, info] of sortedKnownProjects) {
    if (seenProjectPaths.has(projectPath)) continue;
    seenProjectPaths.add(projectPath);
    roots.push({
      id: `project:${projectPath}`,
      kind: 'project',
      label: path.basename(projectPath) || projectPath,
      path: projectPath,
      pinned: false,
      source: 'session-db',
      sessionCount: info.count,
      ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
    });
  }

  const discoveryAnchors = new Set<string>([
    cwd,
    path.dirname(cwd),
    path.resolve(ctx.workingDir),
  ]);
  for (const anchor of discoveryAnchors) {
    const discovered = await discoverProjectRootsFromDirectory(anchor).catch(() => [] as string[]);
    for (const projectPath of discovered) {
      if (seenProjectPaths.has(projectPath)) continue;
      seenProjectPaths.add(projectPath);
      roots.push({
        id: `project:${projectPath}`,
        kind: 'project',
        label: path.basename(projectPath) || projectPath,
        path: projectPath,
        pinned: false,
        source: 'discovered',
      });
      if (roots.length >= COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS + 1) break;
    }
    if (roots.length >= COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS + 1) break;
  }

  const pinned = roots.filter((root) => root.pinned);
  const projects = roots
    .filter((root) => !root.pinned)
    .slice(0, COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS);

  return {
    cwd,
    roots: [...pinned, ...projects],
  };
}

// ---------------------------------------------------------------------------
// Markdown Route Handlers
// ---------------------------------------------------------------------------

export async function handleGetCockpitMarkdownTree(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<void> {
  try {
    const data = await buildCockpitMarkdownWorkspaceTree(ctx, options);
    sendJson(res, {
      rootDir: data.rootDir,
      tree: data.tree,
      suggestedFolders: data.suggestedFolders,
      scope: data.scope,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.toLowerCase().includes('not found') ? 404 : 500;
    sendJson(
      res,
      { error: `Failed to load markdown tree: ${message}` },
      status
    );
  }
}

export async function handleGetCockpitMarkdownFile(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  rawPath: string | null,
  options?: {
    sessionKey?: string | null;
    projectPath?: string | null;
  }
): Promise<void> {
  const filePath = asString(rawPath);
  if (!filePath) {
    sendJson(res, { error: 'Missing required query parameter: path' }, 400);
    return;
  }

  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, filePath, {
    requireMarkdownFile: true,
    ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options?.projectPath ? { projectPath: options.projectPath } : {}),
  });
  if ('error' in resolved) {
    sendJson(res, { error: resolved.error }, resolved.status ?? 400);
    return;
  }

  try {
    const fs = await import('fs/promises');
    const [content, stat, metadata] = await Promise.all([
      fs.readFile(resolved.absolutePath, 'utf8'),
      fs.stat(resolved.absolutePath),
      readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
    ]);
    const record = await buildMarkdownWorkspaceFileRecord(
      resolved.rootDir,
      resolved.relativePath,
      content,
      stat,
      metadata,
    );
    res.setHeader('ETag', record.etag);
    sendJson(res, {
      rootDir: resolved.rootDir,
      scope: resolved.scope,
      file: { ...record, content },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      sendJson(res, { error: `Markdown file not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { error: `Failed to read markdown file: ${message}` }, 500);
  }
}

export async function handlePostCockpitMarkdownFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const scope = readMarkdownScopeFromBody(body);
  const filePath = asString(body.path) ?? asString(body.filePath);
  if (!filePath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const content = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : '';
  const expectedVersion = asNumber(body.expectedVersion);
  const metadata = sanitizeMarkdownMetadata(body.metadata);

  const result = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: filePath,
    content,
    ...scope,
    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    ...(metadata ? { metadata } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : {}),
    operation: 'write',
  });
  if (!result.ok) {
    sendJson(
      res,
      {
        success: false,
        error: result.error,
        ...(typeof result.currentVersion === 'number' ? { currentVersion: result.currentVersion } : {}),
        ...(result.currentUpdatedAt ? { currentUpdatedAt: result.currentUpdatedAt } : {}),
        ...(result.currentHash ? { currentHash: result.currentHash } : {}),
      },
      result.status
    );
    return;
  }

  sendJson(
    res,
    {
      success: true,
      created: result.created,
      previousVersion: result.previousVersion,
      file: result.file,
    },
    result.created ? 201 : 200
  );
}

export async function handlePostCockpitMarkdownFolder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const scope = readMarkdownScopeFromBody(body);
  const rawPath = asString(body.path)
    ?? (
      asString(body.parentPath) && asString(body.name)
        ? `${asString(body.parentPath)}/${asString(body.name)}`
        : undefined
    );
  if (!rawPath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, rawPath, {
    allowEmpty: false,
    ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    ...(scope.projectPath ? { projectPath: scope.projectPath } : {}),
  });
  if ('error' in resolved) {
    sendJson(res, { success: false, error: resolved.error }, resolved.status ?? 400);
    return;
  }
  try {
    const fs = await import('fs/promises');
    await fs.mkdir(resolved.absolutePath, { recursive: true });
    sendJson(res, { success: true, folder: { path: resolved.relativePath } }, 201);
  } catch (error) {
    sendJson(
      res,
      { success: false, error: `Failed creating folder: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

export async function handlePostCockpitMarkdownDelete(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const scope = readMarkdownScopeFromBody(body);
  const rawPath = asString(body.path) ?? asString(body.filePath);
  const requestedType = asString(body.type)?.toLowerCase();
  const recursive = asBoolean(body.recursive) === true;

  if (!rawPath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  if (requestedType !== 'file' && requestedType !== 'folder') {
    sendJson(res, { success: false, error: "Invalid type. Expected 'file' or 'folder'." }, 400);
    return;
  }

  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, rawPath, {
    allowEmpty: false,
    ...(requestedType === 'file' ? { requireMarkdownFile: true } : {}),
    ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    ...(scope.projectPath ? { projectPath: scope.projectPath } : {}),
  });
  if ('error' in resolved) {
    sendJson(res, { success: false, error: resolved.error }, resolved.status ?? 400);
    return;
  }
  if (resolved.scope.mode === 'project') {
    if (requestedType === 'folder') {
      sendJson(
        res,
        { success: false, error: 'Folder deletion is disabled in project scope' },
        400
      );
      return;
    }
    if (!hasMarkdownExtension(resolved.relativePath)) {
      sendJson(
        res,
        { success: false, error: 'Only markdown files can be deleted in project scope' },
        400
      );
      return;
    }
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      sendJson(res, { success: false, error: `Path not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { success: false, error: `Failed reading path metadata: ${message}` }, 500);
    return;
  }

  if (requestedType === 'file' && !stat.isFile()) {
    sendJson(res, { success: false, error: `Path is not a file: ${resolved.relativePath}` }, 400);
    return;
  }
  if (requestedType === 'folder' && !stat.isDirectory()) {
    sendJson(res, { success: false, error: `Path is not a folder: ${resolved.relativePath}` }, 400);
    return;
  }

  try {
    if (requestedType === 'file') {
      await fs.unlink(resolved.absolutePath);
      const metadataPath = await resolveMarkdownMetadataPath(resolved.rootDir, resolved.relativePath);
      await fs.unlink(metadataPath).catch(() => undefined);
    } else if (recursive) {
      await fs.rm(resolved.absolutePath, { recursive: true, force: false });
      const metadataRoot = path.resolve(resolved.rootDir, MARKDOWN_METADATA_DIR);
      const metadataDir = path.resolve(metadataRoot, resolved.relativePath);
      if (metadataDir === metadataRoot || metadataDir.startsWith(`${metadataRoot}${path.sep}`)) {
        await fs.rm(metadataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      await fs.rmdir(resolved.absolutePath);
      const metadataRoot = path.resolve(resolved.rootDir, MARKDOWN_METADATA_DIR);
      const metadataDir = path.resolve(metadataRoot, resolved.relativePath);
      if (metadataDir === metadataRoot || metadataDir.startsWith(`${metadataRoot}${path.sep}`)) {
        await fs.rmdir(metadataDir).catch(() => undefined);
      }
    }
    sendJson(res, {
      success: true,
      deleted: {
        path: resolved.relativePath,
        type: requestedType,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes('enotempty') && requestedType === 'folder' && !recursive) {
      sendJson(
        res,
        {
          success: false,
          error: `Folder is not empty: ${resolved.relativePath}. Retry with recursive=true.`,
        },
        409
      );
      return;
    }
    if (lower.includes('enoent')) {
      sendJson(res, { success: false, error: `Path not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { success: false, error: `Failed deleting path: ${message}` }, 500);
  }
}

export async function handlePostCockpitMarkdownImport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const sourceSessionKey = asString(body.sessionKey);
  const destinationSessionKey = asString(body.scopeSessionKey) ?? asString(body.workspaceSessionKey);
  const destinationProjectPath = asString(body.projectPath) ?? asString(body.project_path);
  const sourceContent = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : null;

  let markdownContent = sourceContent;
  let sourcePath: string | undefined;
  if (!markdownContent) {
    const markdownPath = asString(body.markdownPath) ?? asString(body.sourcePath) ?? asString(body.filePath);
    if (!sourceSessionKey || !markdownPath) {
      sendJson(
        res,
        { success: false, error: 'Provide content or provide sessionKey + markdownPath for markdown import' },
        400
      );
      return;
    }
    const session = getSession(ctx, sourceSessionKey);
    if (!session) {
      sendJson(res, { success: false, error: `Session not found: ${sourceSessionKey}` }, 404);
      return;
    }
    const resolved = await resolveSessionFilePath(session.workingDir ?? ctx.workingDir, markdownPath);
    if (!resolved.resolvedPath || resolved.error) {
      sendJson(res, { success: false, error: resolved.error ?? 'Invalid markdownPath for source session' }, 400);
      return;
    }
    try {
      const fs = await import('fs/promises');
      markdownContent = await fs.readFile(resolved.resolvedPath, 'utf8');
      sourcePath = resolved.relativePath;
    } catch (error) {
      sendJson(
        res,
        { success: false, error: `Failed reading source markdownPath: ${error instanceof Error ? error.message : String(error)}` },
        400
      );
      return;
    }
  }

  if (!markdownContent) {
    sendJson(res, { success: false, error: 'No markdown content provided' }, 400);
    return;
  }

  const path = await import('path');
  const destinationFolder = normalizeWorkspaceRelativePath(
    asString(body.folder) ?? asString(body.directory) ?? 'packets',
    { allowEmpty: true }
  );
  if (destinationFolder === null) {
    sendJson(res, { success: false, error: 'Invalid destination folder' }, 400);
    return;
  }

  const desiredPath = asString(body.destinationPath) ?? asString(body.path);
  const destinationPath = desiredPath
    ? ensureMarkdownExtensionOnPath(desiredPath)
    : `${destinationFolder ? `${destinationFolder}/` : ''}${ensureMarkdownFileName(
      asString(body.filename)
      ?? (sourcePath ? path.basename(sourcePath) : `import-${Date.now()}.md`)
    )}`;
  if (!destinationPath) {
    sendJson(res, { success: false, error: 'Invalid destination markdown path' }, 400);
    return;
  }

  const expectedVersion = asNumber(body.expectedVersion);
  const metadata = sanitizeMarkdownMetadata(body.metadata);
  const importMetadata = sanitizeMarkdownMetadata({
    ...(metadata ?? {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
    importAt: new Date().toISOString(),
  });
  const writeResult = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: destinationPath,
    content: markdownContent,
    ...(destinationSessionKey ? { sessionKey: destinationSessionKey } : {}),
    ...(destinationProjectPath ? { projectPath: destinationProjectPath } : {}),
    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    ...(importMetadata ? { metadata: importMetadata } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : { source: 'import' }),
    operation: 'import',
  });

  if (!writeResult.ok) {
    sendJson(
      res,
      {
        success: false,
        error: writeResult.error,
        ...(typeof writeResult.currentVersion === 'number' ? { currentVersion: writeResult.currentVersion } : {}),
        ...(writeResult.currentHash ? { currentHash: writeResult.currentHash } : {}),
      },
      writeResult.status
    );
    return;
  }

  sendJson(
    res,
    {
      success: true,
      created: writeResult.created,
      previousVersion: writeResult.previousVersion,
      file: writeResult.file,
      ...(sourcePath ? { sourcePath } : {}),
    },
    writeResult.created ? 201 : 200
  );
}

export async function handlePostCockpitMarkdownPatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const scope = readMarkdownScopeFromBody(body);
  const filePath = asString(body.path) ?? asString(body.filePath);
  if (!filePath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const expectedVersionRaw = asNumber(body.expectedVersion ?? body.baseVersion);
  if (expectedVersionRaw === undefined) {
    sendJson(res, { success: false, error: 'Missing required field: expectedVersion' }, 400);
    return;
  }
  const expectedVersion = Math.max(0, Math.floor(expectedVersionRaw));

  const fullContent = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : undefined;
  const patch = typeof body.patch === 'string' ? body.patch : undefined;
  const edits = parseMarkdownPatchEdits(body.edits);
  const modeCount = (typeof fullContent === 'string' ? 1 : 0) + (patch ? 1 : 0) + (edits.length > 0 ? 1 : 0);
  if (modeCount !== 1) {
    sendJson(res, {
      success: false,
      error: 'Provide exactly one markdown patch mode: content, patch, or edits',
    }, 400);
    return;
  }

  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, filePath, {
    requireMarkdownFile: true,
    ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    ...(scope.projectPath ? { projectPath: scope.projectPath } : {}),
  });
  if ('error' in resolved) {
    sendJson(res, { success: false, error: resolved.error }, resolved.status ?? 400);
    return;
  }

  const fs = await import('fs/promises');
  let currentContent = '';
  let currentStat: { mtimeMs: number; mtime: Date; size: number } | null = null;
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(resolved.absolutePath, 'utf8'),
      fs.stat(resolved.absolutePath),
    ]);
    currentContent = content;
    currentStat = stat;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      sendJson(res, { success: false, error: `Markdown file not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { success: false, error: `Failed reading markdown file: ${message}` }, 500);
    return;
  }

  const currentVersion = buildVersionFromMtimeMs(currentStat.mtimeMs);
  if (currentVersion !== expectedVersion) {
    const currentHash = await buildMarkdownContentHash(currentContent);
    sendJson(res, {
      success: false,
      error: 'Version conflict while applying markdown patch',
      currentVersion,
      currentUpdatedAt: currentStat.mtime.toISOString(),
      currentHash,
    }, 409);
    return;
  }

  let nextContent = currentContent;
  let changedLines = 0;
  let mode: 'content' | 'patch' | 'edits' = 'content';
  if (typeof fullContent === 'string') {
    nextContent = fullContent;
    mode = 'content';
    changedLines = Math.max(
      buildMarkdownLineCount(currentContent),
      buildMarkdownLineCount(nextContent),
    );
  } else if (patch) {
    const result = await applyMarkdownUnifiedDiffPatch(resolved.relativePath, currentContent, patch);
    if (!result.ok) {
      sendJson(res, { success: false, error: result.error }, result.status);
      return;
    }
    nextContent = result.content;
    changedLines = result.changedLines;
    mode = 'patch';
  } else {
    const result = applyMarkdownStructuredEdits(currentContent, edits);
    if (!result.ok) {
      sendJson(res, { success: false, error: result.error }, result.status);
      return;
    }
    nextContent = result.content;
    changedLines = result.changedLines;
    mode = 'edits';
  }

  if (Buffer.byteLength(nextContent, 'utf8') > MARKDOWN_MAX_BYTES) {
    sendJson(res, { success: false, error: `Markdown payload exceeds ${MARKDOWN_MAX_BYTES} bytes` }, 400);
    return;
  }

  const metadata = sanitizeMarkdownMetadata(body.metadata);
  const writeResult = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: resolved.relativePath,
    content: nextContent,
    ...scope,
    expectedVersion,
    ...(metadata ? {
      metadata: sanitizeMarkdownMetadata({
        ...metadata,
        patchMode: mode,
        changedLines,
      }) ?? metadata,
    } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : { source: 'patch' }),
    operation: 'patch',
    baseVersion: expectedVersion,
  });
  if (!writeResult.ok) {
    sendJson(res, {
      success: false,
      error: writeResult.error,
      ...(typeof writeResult.currentVersion === 'number' ? { currentVersion: writeResult.currentVersion } : {}),
      ...(writeResult.currentUpdatedAt ? { currentUpdatedAt: writeResult.currentUpdatedAt } : {}),
      ...(writeResult.currentHash ? { currentHash: writeResult.currentHash } : {}),
    }, writeResult.status);
    return;
  }

  sendJson(res, {
    success: true,
    mode,
    changedLines,
    previousVersion: writeResult.previousVersion,
    file: writeResult.file,
  });
}

// ---------------------------------------------------------------------------
// Markdown Message Context
// ---------------------------------------------------------------------------

export async function buildMarkdownMessageContext(
  ctx: ControlPlaneContext,
  value: unknown,
  options?: {
    defaultSessionKey?: string;
  }
): Promise<
  | {
      ok: true;
      contextText?: string;
      contextMetadata?: Record<string, unknown>;
    }
  | { ok: false; status: number; error: string }
> {
  if (!isRecord(value)) return { ok: true };

  const rawPath = asString(value.path) ?? asString(value.markdownPath) ?? asString(value.filePath);
  const metadataRecord = isRecord(value.metadata) ? value.metadata : {};
  const draftIdFromClient = asString(value.draftId)
    ?? asString(value.clientDraftId)
    ?? asString(metadataRecord.draftId)
    ?? asString(metadataRecord.clientDraftId);
  const explicitScopeSessionKey = asString(value.scopeSessionKey)
    ?? asString(value.workspaceSessionKey)
    ?? asString(metadataRecord.scopeSessionKey)
    ?? asString(metadataRecord.workspaceSessionKey);
  const scopeProjectPath = asString(value.projectPath)
    ?? asString(value.workspaceProjectPath)
    ?? asString(metadataRecord.scopeProjectPath)
    ?? asString(metadataRecord.workspaceProjectPath);
  const workspaceScopeRaw = asString(value.workspaceScope)
    ?? asString(value.scopeMode)
    ?? asString(metadataRecord.workspaceScope)
    ?? asString(metadataRecord.scopeMode);
  const workspaceScope = workspaceScopeRaw === 'global' || workspaceScopeRaw === 'session' || workspaceScopeRaw === 'project'
    ? workspaceScopeRaw
    : undefined;
  const scopeSessionKey = explicitScopeSessionKey
    ?? (
      scopeProjectPath
        ? undefined
        : (
          workspaceScope === 'global' || workspaceScope === 'project'
            ? undefined
            : options?.defaultSessionKey
        )
    );
  let content = typeof value.content === 'string'
    ? value.content
    : typeof value.markdown === 'string'
      ? value.markdown
      : undefined;
  if (!rawPath && content === undefined) return { ok: true };

  let resolvedPath: string | undefined;
  let resolvedVersion: number | undefined = asNumber(value.version);
  let resolvedUpdatedAt: string | undefined = asString(value.updatedAt);
  let resolvedMetadata: Record<string, unknown> | undefined;
  let resolvedScopeMode: MarkdownWorkspaceScopeMode | undefined = workspaceScope;
  let resolvedScopeSessionKey: string | undefined;
  let resolvedScopeProjectPath: string | undefined;
  let resolvedRootDir: string | undefined;
  let resolvedAbsolutePath: string | undefined;
  let resolvedDraftId: string | undefined = sanitizeMarkdownDraftId(draftIdFromClient) ?? undefined;

  if (!rawPath && typeof content === 'string') {
    const draftSessionKey = scopeSessionKey
      ?? (
        !scopeProjectPath
          ? options?.defaultSessionKey
          : undefined
      );
    const draftResult = await materializeMarkdownDraftFromContent(ctx, {
      content,
      ...(draftSessionKey ? { sessionKey: draftSessionKey } : {}),
      ...(scopeProjectPath ? { projectPath: scopeProjectPath } : {}),
      ...(resolvedDraftId ? { draftId: resolvedDraftId } : {}),
    });
    if (!draftResult.ok) {
      return { ok: false, status: draftResult.status, error: draftResult.error };
    }
    resolvedPath = draftResult.relativePath;
    resolvedScopeMode = draftResult.scope.mode;
    resolvedScopeSessionKey = draftResult.scope.sessionKey;
    resolvedScopeProjectPath = draftResult.scope.projectPath;
    resolvedRootDir = draftResult.rootDir;
    resolvedAbsolutePath = draftResult.absolutePath;
    resolvedVersion = resolvedVersion ?? draftResult.version;
    resolvedUpdatedAt = resolvedUpdatedAt ?? draftResult.updatedAt;
    resolvedMetadata = sanitizeMarkdownMetadata({
      ...(resolvedMetadata ?? {}),
      source: 'draft',
      draftId: draftResult.draftId,
      draftPath: draftResult.relativePath,
      draftAbsolutePath: draftResult.absolutePath,
      draftScopeMode: draftResult.scope.mode,
      ...(draftResult.scope.projectPath ? { draftScopeProjectPath: draftResult.scope.projectPath } : {}),
      hash: draftResult.hash,
    });
    resolvedDraftId = draftResult.draftId;
  }

  if (rawPath) {
    const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, rawPath, {
      requireMarkdownFile: true,
      ...(scopeSessionKey ? { sessionKey: scopeSessionKey } : {}),
      ...(scopeProjectPath ? { projectPath: scopeProjectPath } : {}),
    });
    if ('error' in resolved) {
      return { ok: false, status: resolved.status ?? 400, error: resolved.error };
    }
    resolvedPath = resolved.relativePath;
    resolvedScopeMode = resolved.scope.mode;
    resolvedScopeSessionKey = resolved.scope.sessionKey;
    resolvedScopeProjectPath = resolved.scope.projectPath;
    resolvedRootDir = resolved.rootDir;
    resolvedAbsolutePath = resolved.absolutePath;
    try {
      const fs = await import('fs/promises');
      const [stat, persistedContent, persistedMetadata] = await Promise.all([
        fs.stat(resolved.absolutePath),
        content === undefined ? fs.readFile(resolved.absolutePath, 'utf8') : Promise.resolve(undefined),
        readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
      ]);
      if (content === undefined && typeof persistedContent === 'string') {
        content = persistedContent;
      }
      resolvedVersion = resolvedVersion ?? buildVersionFromMtimeMs(stat.mtimeMs);
      resolvedUpdatedAt = resolvedUpdatedAt ?? stat.mtime.toISOString();
      resolvedMetadata = persistedMetadata;
      if (!resolvedDraftId) {
        resolvedDraftId = sanitizeMarkdownDraftId(
          asString(persistedMetadata?.draftId) ?? asString(persistedMetadata?.clientDraftId)
        ) ?? undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof content === 'string') {
        resolvedVersion = resolvedVersion ?? 0;
        resolvedUpdatedAt = resolvedUpdatedAt ?? new Date().toISOString();
        resolvedMetadata = resolvedMetadata ?? undefined;
      } else if (message.toLowerCase().includes('enoent')) {
        return { ok: false, status: 404, error: `Markdown file not found: ${resolved.relativePath}` };
      } else {
        return { ok: false, status: 500, error: `Failed loading markdown context: ${message}` };
      }
    }
  }

  if (typeof content !== 'string') return { ok: true };

  const selectionStart = asNumber(value.selectionStart ?? value.cursorStart);
  const selectionEnd = asNumber(value.selectionEnd ?? value.cursorEnd);
  const isDirty = asBoolean(value.isDirty) === true;
  const clientMetadata = sanitizeMarkdownMetadata(value.metadata);
  const mergedMetadata = sanitizeMarkdownMetadata({
    ...(resolvedMetadata ?? {}),
    ...(clientMetadata ?? {}),
  });

  const originalBytes = Buffer.byteLength(content, 'utf8');
  const fullContentHash = await buildMarkdownContentHash(content);
  let truncated = false;
  if (originalBytes > MARKDOWN_CHAT_CONTEXT_MAX_BYTES) {
    content = Buffer
      .from(content, 'utf8')
      .subarray(0, MARKDOWN_CHAT_CONTEXT_MAX_BYTES)
      .toString('utf8');
    truncated = true;
  }
  const payloadHash = truncated ? await buildMarkdownContentHash(content) : fullContentHash;
  const workspaceRelativePath = resolvedPath ?? rawPath ?? null;
  const isDraftContext = typeof workspaceRelativePath === 'string'
    && (
      workspaceRelativePath.startsWith(`${MARKDOWN_DRAFTS_DIR}/`)
      || workspaceRelativePath.startsWith(`${PROJECT_DRAFTS_DIR}/`)
    );
  const workspacePath = workspaceRelativePath
    ? (
      resolvedScopeMode === 'project'
        ? workspaceRelativePath
        : `${MARKDOWN_WORKSPACE_DIR}/${workspaceRelativePath}`
    )
    : null;
  const contextMetadata = sanitizeMarkdownMetadata({
    source: 'markdown-editor',
    path: workspaceRelativePath,
    workspacePath,
    workspaceRoot: resolvedRootDir ?? null,
    absolutePath: resolvedAbsolutePath ?? null,
    writeTargetPath: resolvedAbsolutePath ?? null,
    scopeMode: resolvedScopeMode ?? null,
    scopeSessionKey: scopeSessionKey ?? resolvedScopeSessionKey ?? null,
    scopeProjectPath: scopeProjectPath ?? resolvedScopeProjectPath ?? null,
    isDraft: isDraftContext,
    draftId: resolvedDraftId ?? null,
    version: resolvedVersion ?? null,
    updatedAt: resolvedUpdatedAt ?? null,
    isDirty,
    selectionStart: typeof selectionStart === 'number' ? Math.max(0, Math.floor(selectionStart)) : null,
    selectionEnd: typeof selectionEnd === 'number' ? Math.max(0, Math.floor(selectionEnd)) : null,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    originalBytes,
    truncated,
    hash: fullContentHash,
    payloadHash,
  }) ?? {
    source: 'markdown-editor',
    path: workspaceRelativePath,
    workspacePath,
    writeTargetPath: resolvedAbsolutePath ?? null,
    scopeMode: resolvedScopeMode ?? null,
    isDraft: isDraftContext,
    draftId: resolvedDraftId ?? null,
    hash: fullContentHash,
    payloadHash,
    truncated,
  };

  let metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : '{}';
  if (Buffer.byteLength(metadataJson, 'utf8') > 8_000) {
    metadataJson = `${metadataJson.slice(0, 8_000)}...`;
  }
  const contextText = [
    'Control-plane active markdown context:',
    `path: ${contextMetadata.path ?? 'unknown'}`,
    `workspacePath: ${contextMetadata.workspacePath ?? 'unknown'}`,
    `workspaceRoot: ${contextMetadata.workspaceRoot ?? 'unknown'}`,
    `absolutePath: ${contextMetadata.absolutePath ?? 'unknown'}`,
    `scopeMode: ${contextMetadata.scopeMode ?? 'unknown'}`,
    `isDraft: ${contextMetadata.isDraft === true ? 'true' : 'false'}`,
    `draftId: ${asString(contextMetadata.draftId) ?? 'none'}`,
    `version: ${contextMetadata.version ?? 'unknown'}`,
    `updatedAt: ${contextMetadata.updatedAt ?? 'unknown'}`,
    `dirty: ${contextMetadata.isDirty === true ? 'true' : 'false'}`,
    `selectionStart: ${contextMetadata.selectionStart ?? 'none'}`,
    `selectionEnd: ${contextMetadata.selectionEnd ?? 'none'}`,
    `hash: ${contextMetadata.hash ?? 'unknown'}`,
    `truncated: ${contextMetadata.truncated === true ? 'true' : 'false'}`,
    'metadata:',
    metadataJson,
    'markdown:',
    '```markdown',
    content,
    '```',
    'Treat this markdown snapshot as authoritative for the current user request.',
    'If the user requests document edits, persist changes to writeTargetPath/absolutePath above (not similarly named files elsewhere).',
    ...(isDraftContext
      ? ['This document is a draft artifact. Keep edits confined to writeTargetPath until the user promotes/saves it to a project path.']
      : []),
  ].join('\n');

  return {
    ok: true,
    contextText,
    contextMetadata,
  };
}
