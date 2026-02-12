/**
 * Browser-related control plane routes and utilities.
 *
 * Extracted from control_plane_routes.ts — handles browser automation
 * via `agent-browser` CLI: actions, runbooks, evidence, state queries.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import nodePath from 'path';
import {
  type ControlPlaneContext,
  type BrowserActionName,
  type BrowserActionInput,
  type BrowserActionResult,
  type BrowserRunbookStep,
  type BrowserEvidenceItem,
  type SessionRow,
  sendJson,
  readJsonBody,
  isRecord,
  asString,
  asNumber,
  asBoolean,
  execFileAsync,
  toStringOutput,
  execFileText,
} from './utils.js';
import { getSession } from './sessions.js';
import { resolveSessionFilePath } from './git.js';
import { buildCockpitFilesystemRoots } from './markdown.js';

// ---------------------------------------------------------------------------
// Browser availability cache
// ---------------------------------------------------------------------------

let agentBrowserAvailabilityCache: { available: boolean; checkedAtMs: number } | null = null;

// ---------------------------------------------------------------------------
// Normalisation / parsing helpers
// ---------------------------------------------------------------------------

function normalizeBrowserSessionName(sessionKey: string): string {
  const safe = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normalized = safe || 'session';
  return `cockpit-${normalized}`.slice(0, 72);
}

function sanitizeArtifactToken(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'artifact';
}

function browserTimestampToken(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function toActionError(action: BrowserActionName, message: string): { error: string } {
  return { error: `${action}: ${message}` };
}

function normalizeBrowserActionName(value: string | undefined): BrowserActionName | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'open') return 'open';
  if (normalized === 'back') return 'back';
  if (normalized === 'forward') return 'forward';
  if (normalized === 'reload') return 'reload';
  if (normalized === 'snapshot') return 'snapshot';
  if (normalized === 'click') return 'click';
  if (normalized === 'fill') return 'fill';
  if (normalized === 'type') return 'type';
  if (normalized === 'press') return 'press';
  if (normalized === 'wait') return 'wait';
  if (normalized === 'scroll') return 'scroll';
  if (normalized === 'get_url' || normalized === 'geturl') return 'get_url';
  if (normalized === 'get_title' || normalized === 'gettitle') return 'get_title';
  if (normalized === 'screenshot') return 'screenshot';
  if (normalized === 'close') return 'close';
  return null;
}

function parseBrowserActionInput(value: Record<string, unknown>): { input?: BrowserActionInput; error?: string } {
  const action = normalizeBrowserActionName(asString(value.action));
  if (!action) {
    return { error: 'Invalid browser action. Allowed: open, back, forward, reload, snapshot, click, fill, type, press, wait, scroll, get_url, get_title, screenshot, close.' };
  }

  const target = asString(value.target);
  const text = asString(value.text) ?? asString(value.value);
  const url = asString(value.url);
  const interactive = asBoolean(value.interactive);
  const compact = asBoolean(value.compact);
  const depth = asNumber(value.depth);
  const selector = asString(value.selector);
  const directionRaw = asString(value.direction)?.toLowerCase();
  const direction = directionRaw === 'up' || directionRaw === 'down' || directionRaw === 'left' || directionRaw === 'right'
    ? directionRaw
    : undefined;
  const pixels = asNumber(value.pixels);
  const waitMs = asNumber(value.waitMs ?? value.wait_ms);
  const label = asString(value.label);

  if (action === 'open' && !url) return toActionError(action, 'Missing required field: url');
  if (action === 'click' && !target) return toActionError(action, 'Missing required field: target');
  if ((action === 'fill' || action === 'type') && (!target || text === undefined)) {
    return toActionError(action, 'Missing required fields: target and text');
  }
  if (action === 'press' && !text && !target) {
    return toActionError(action, 'Missing required field: text (or target)');
  }
  if (action === 'wait' && waitMs === undefined && !target) {
    return toActionError(action, 'Missing required field: waitMs or target');
  }
  if (action === 'snapshot' && depth !== undefined && (depth < 1 || depth > 25)) {
    return toActionError(action, 'depth must be between 1 and 25');
  }
  if (action === 'scroll' && directionRaw && !direction) {
    return toActionError(action, 'direction must be one of up|down|left|right');
  }

  return {
    input: {
      action,
      ...(target ? { target } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(url ? { url } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
      ...(compact !== undefined ? { compact } : {}),
      ...(typeof depth === 'number' ? { depth: Math.floor(depth) } : {}),
      ...(selector ? { selector } : {}),
      ...(direction ? { direction } : {}),
      ...(typeof pixels === 'number' ? { pixels: Math.floor(pixels) } : {}),
      ...(typeof waitMs === 'number' ? { waitMs: Math.max(1, Math.floor(waitMs)) } : {}),
      ...(label ? { label } : {}),
    },
  };
}

function buildBrowserActionArgs(input: BrowserActionInput, artifactPath?: string): string[] {
  switch (input.action) {
    case 'open':
      return ['open', input.url ?? ''];
    case 'back':
      return ['back'];
    case 'forward':
      return ['forward'];
    case 'reload':
      return ['reload'];
    case 'snapshot': {
      const args = ['snapshot'];
      if (input.interactive) args.push('--interactive');
      if (input.compact) args.push('--compact');
      if (typeof input.depth === 'number') args.push('--depth', String(input.depth));
      if (input.selector) args.push('--selector', input.selector);
      return args;
    }
    case 'click':
      return ['click', input.target ?? ''];
    case 'fill':
      return ['fill', input.target ?? '', input.text ?? ''];
    case 'type':
      return ['type', input.target ?? '', input.text ?? ''];
    case 'press':
      return ['press', input.text ?? input.target ?? ''];
    case 'wait':
      return ['wait', String(input.waitMs ?? input.target ?? '1000')];
    case 'scroll': {
      const args = ['scroll', input.direction ?? 'down'];
      if (typeof input.pixels === 'number') args.push(String(input.pixels));
      return args;
    }
    case 'get_url':
      return ['get', 'url'];
    case 'get_title':
      return ['get', 'title'];
    case 'screenshot':
      return artifactPath ? ['screenshot', artifactPath] : ['screenshot'];
    case 'close':
      return ['close'];
  }
}

function summarizeBrowserData(data: unknown, maxChars = 1600): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') {
    return data.length > maxChars ? `${data.slice(0, maxChars)}...` : data;
  }
  try {
    const json = JSON.stringify(data);
    if (!json) return undefined;
    return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
  } catch {
    return undefined;
  }
}

function parseBrowserCliJson(raw: string): { success: boolean; data?: unknown; error?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const success = typeof parsed.success === 'boolean' ? parsed.success : true;
    const error = asString(parsed.error);
    return {
      success,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return null;
  }
}

async function checkAgentBrowserAvailable(workingDir: string): Promise<boolean> {
  const nowMs = Date.now();
  if (agentBrowserAvailabilityCache && nowMs - agentBrowserAvailabilityCache.checkedAtMs < 60_000) {
    return agentBrowserAvailabilityCache.available;
  }
  try {
    await execFileText('agent-browser', ['session', 'list', '--json'], {
      cwd: workingDir,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    agentBrowserAvailabilityCache = { available: true, checkedAtMs: nowMs };
    return true;
  } catch {
    agentBrowserAvailabilityCache = { available: false, checkedAtMs: nowMs };
    return false;
  }
}

function buildBrowserEvidenceId(sessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bev_${sanitizeArtifactToken(sessionKey)}_${Date.now().toString(36)}_${suffix}`;
}

function parseBrowserEvidence(value: unknown): BrowserEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const evidence: BrowserEvidenceItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const typeRaw = asString(entry.type);
    const type = typeRaw === 'snapshot' ? 'snapshot' : typeRaw === 'screenshot' ? 'screenshot' : null;
    const artifactPath = asString(entry.path);
    const createdAt = asString(entry.createdAt);
    if (!id || !type || !artifactPath || !createdAt) continue;
    evidence.push({
      id,
      type,
      path: artifactPath,
      createdAt,
      ...(asString(entry.label) ? { label: asString(entry.label) } : {}),
      ...(asString(entry.url) ? { url: asString(entry.url) } : {}),
      ...(asString(entry.title) ? { title: asString(entry.title) } : {}),
    });
  }
  return evidence.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ---------------------------------------------------------------------------
// Artifact & Runbook
// ---------------------------------------------------------------------------

async function allocateBrowserArtifactPath(
  workingDir: string,
  sessionKey: string,
  type: 'screenshots' | 'snapshots',
  ext: 'png' | 'json' = 'png',
  label?: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const baseDir = path.join(
    workingDir,
    '.cockpit',
    'browser',
    sanitizeArtifactToken(sessionKey),
    type
  );
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = browserTimestampToken();
  const suffix = label ? `_${sanitizeArtifactToken(label)}` : '';
  const fileName = `${stamp}${suffix}.${ext}`;
  const absolutePath = path.join(baseDir, fileName);
  const relativePath = path.relative(workingDir, absolutePath);
  return { absolutePath, relativePath };
}

function tokenizedRunbookLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseBrowserRunbook(script: string): { steps: BrowserRunbookStep[]; error?: string } {
  const lines = script.split('\n');
  const steps: BrowserRunbookStep[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = tokenizedRunbookLine(trimmed);
    if (tokens.length === 0) continue;
    const lineNo = idx + 1;
    const command = tokens[0].toLowerCase();

    const withInput = (input: BrowserActionInput) => {
      steps.push({ line: lineNo, input });
    };

    if (command === 'open') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: open requires a URL` };
      withInput({ action: 'open', url: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'click') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: click requires a target` };
      withInput({ action: 'click', target: tokens[1] });
      continue;
    }
    if (command === 'fill' || command === 'type') {
      if (!tokens[1] || tokens.length < 3) {
        return { steps: [], error: `Runbook line ${lineNo}: ${command} requires target + text` };
      }
      withInput({
        action: command,
        target: tokens[1],
        text: tokens.slice(2).join(' '),
      });
      continue;
    }
    if (command === 'press') {
      if (tokens.length < 2) return { steps: [], error: `Runbook line ${lineNo}: press requires a key` };
      withInput({ action: 'press', text: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'wait') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: wait requires milliseconds or a selector` };
      const waitMs = Number(tokens[1]);
      if (Number.isFinite(waitMs)) {
        withInput({ action: 'wait', waitMs: Math.max(1, Math.floor(waitMs)) });
      } else {
        withInput({ action: 'wait', target: tokens.slice(1).join(' ') });
      }
      continue;
    }
    if (command === 'scroll') {
      const direction = (tokens[1] ?? 'down').toLowerCase();
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return { steps: [], error: `Runbook line ${lineNo}: invalid scroll direction "${direction}"` };
      }
      const pixels = tokens[2] ? Number(tokens[2]) : undefined;
      withInput({
        action: 'scroll',
        direction,
        ...(Number.isFinite(pixels) ? { pixels: Math.floor(Number(pixels)) } : {}),
      });
      continue;
    }
    if (command === 'snapshot') {
      let interactive = false;
      let compact = false;
      let depth: number | undefined;
      let selector: string | undefined;
      for (let t = 1; t < tokens.length; t += 1) {
        const token = tokens[t];
        if (token === '-i' || token === '--interactive') {
          interactive = true;
          continue;
        }
        if (token === '-c' || token === '--compact') {
          compact = true;
          continue;
        }
        if ((token === '-d' || token === '--depth') && tokens[t + 1]) {
          const parsed = Number(tokens[t + 1]);
          if (Number.isFinite(parsed)) depth = Math.floor(parsed);
          t += 1;
          continue;
        }
        if ((token === '-s' || token === '--selector') && tokens[t + 1]) {
          selector = tokens[t + 1];
          t += 1;
        }
      }
      withInput({
        action: 'snapshot',
        interactive,
        compact,
        ...(typeof depth === 'number' ? { depth } : {}),
        ...(selector ? { selector } : {}),
      });
      continue;
    }
    if (command === 'screenshot') {
      withInput({
        action: 'screenshot',
        ...(tokens[1] ? { label: tokens.slice(1).join(' ') } : {}),
      });
      continue;
    }
    if (command === 'get') {
      const what = (tokens[1] ?? '').toLowerCase();
      if (what === 'url') {
        withInput({ action: 'get_url' });
        continue;
      }
      if (what === 'title') {
        withInput({ action: 'get_title' });
        continue;
      }
      return { steps: [], error: `Runbook line ${lineNo}: get supports only "url" or "title"` };
    }
    if (command === 'back' || command === 'forward' || command === 'reload' || command === 'close') {
      withInput({ action: command });
      continue;
    }

    return { steps: [], error: `Runbook line ${lineNo}: unsupported command "${tokens[0]}"` };
  }

  if (steps.length === 0) {
    return { steps: [], error: 'Runbook is empty. Add at least one command.' };
  }
  if (steps.length > 40) {
    return { steps: [], error: `Runbook exceeds step limit: ${steps.length} > 40` };
  }
  return { steps };
}

// ---------------------------------------------------------------------------
// Browser action execution
// ---------------------------------------------------------------------------

async function runBrowserAction(
  workingDir: string,
  browserSession: string,
  sessionKey: string,
  input: BrowserActionInput
): Promise<BrowserActionResult> {
  let artifactPath: string | undefined;
  let snapshotArtifactAbsPath: string | undefined;
  if (input.action === 'screenshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'screenshots',
      'png',
      input.label
    );
    artifactPath = artifact.relativePath;
    const args = buildBrowserActionArgs(input, artifact.absolutePath);
    const result = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
      cwd: workingDir,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    } as any).then((output) => ({
      stdout: toStringOutput((output as any).stdout),
      stderr: toStringOutput((output as any).stderr),
      error: null as Error | null,
    })).catch((error) => ({
      stdout: toStringOutput((error as any).stdout),
      stderr: toStringOutput((error as any).stderr),
      error: error as Error,
    }));
    const parsed = parseBrowserCliJson(result.stdout) ?? parseBrowserCliJson(result.stderr);
    if (parsed) {
      if (parsed.success) {
        return {
          success: true,
          action: input.action,
          args,
          stdout: result.stdout,
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          ...(artifactPath ? { artifactPath } : {}),
        };
      }
      return {
        success: false,
        action: input.action,
        args,
        stdout: result.stdout,
        error: parsed.error ?? result.error?.message ?? 'Browser command failed',
      };
    }
    return {
      success: !result.error,
      action: input.action,
      args,
      stdout: result.stdout || result.stderr,
      ...(result.error ? { error: result.error.message || result.stderr || 'Browser command failed' } : {}),
      ...(artifactPath && !result.error ? { artifactPath } : {}),
    };
  }

  if (input.action === 'snapshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'snapshots',
      'json'
    );
    snapshotArtifactAbsPath = artifact.absolutePath;
    artifactPath = artifact.relativePath;
  }

  const args = buildBrowserActionArgs(input);
  const rawResult = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
    cwd: workingDir,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  } as any).then((output) => ({
    stdout: toStringOutput((output as any).stdout),
    stderr: toStringOutput((output as any).stderr),
    error: null as Error | null,
  })).catch((error) => ({
    stdout: toStringOutput((error as any).stdout),
    stderr: toStringOutput((error as any).stderr),
    error: error as Error,
  }));

  const parsed = parseBrowserCliJson(rawResult.stdout) ?? parseBrowserCliJson(rawResult.stderr);
  if (parsed && parsed.success && input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    await fs.writeFile(snapshotArtifactAbsPath, JSON.stringify(parsed.data ?? {}, null, 2), 'utf8').catch(() => {});
  }
  if (parsed) {
    return {
      success: parsed.success,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.success && artifactPath ? { artifactPath } : {}),
    };
  }

  if (rawResult.error) {
    return {
      success: false,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      error: rawResult.error.message || rawResult.stderr || 'Browser command failed',
    };
  }
  if (input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    const fallback = rawResult.stdout || rawResult.stderr || '{}';
    await fs.writeFile(snapshotArtifactAbsPath, fallback, 'utf8').catch(() => {});
  }
  return {
    success: true,
    action: input.action,
    args,
    stdout: rawResult.stdout,
    ...(artifactPath ? { artifactPath } : {}),
  };
}

export function parseBrowserStateFromMetadata(
  metadata: Record<string, unknown> | undefined
): {
  actions: Array<Record<string, unknown>>;
  evidence: BrowserEvidenceItem[];
  lastActionAt?: string;
  lastKnownUrl?: string;
  lastKnownTitle?: string;
} {
  const actions: Array<Record<string, unknown>> = [];
  const evidence = parseBrowserEvidence(metadata?.browser_evidence);
  const agentEvents = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let lastActionAt: string | undefined;
  let lastActionAtMs = 0;
  let lastKnownUrl: string | undefined;
  let lastKnownTitle: string | undefined;
  for (const event of agentEvents) {
    if (!isRecord(event)) continue;
    const type = asString(event.type);
    if (type !== 'browser_action' && type !== 'browser_evidence_captured') continue;
    const at = asString(event.timestamp);
    const data = isRecord(event.data) ? event.data : {};
    if (type === 'browser_action') {
      const atMs = at ? Date.parse(at) : NaN;
      actions.push({
        at,
        action: asString(data.action),
        success: data.success === false ? false : true,
        error: asString(data.error),
        outputPreview: asString(data.outputPreview),
        artifactPath: asString(data.artifactPath),
        line: asNumber(data.line),
      });
      if (Number.isFinite(atMs) && atMs >= lastActionAtMs) {
        lastActionAtMs = atMs;
        if (at) lastActionAt = at;
        const eventUrl = asString(data.currentUrl);
        const eventTitle = asString(data.title);
        if (eventUrl) lastKnownUrl = eventUrl;
        if (eventTitle) lastKnownTitle = eventTitle;
      } else if (!lastActionAt && at) {
        lastActionAt = at;
      }
      continue;
    }
    const id = asString(data.id);
    const typeRaw = asString(data.type);
    const path = asString(data.path);
    const createdAt = asString(data.createdAt) ?? at;
    if (!id || !typeRaw || !path || !createdAt) continue;
    if (typeRaw !== 'snapshot' && typeRaw !== 'screenshot') continue;
    evidence.push({
      id,
      type: typeRaw,
      path,
      createdAt,
      ...(asString(data.label) ? { label: asString(data.label) } : {}),
      ...(asString(data.url) ? { url: asString(data.url) } : {}),
      ...(asString(data.title) ? { title: asString(data.title) } : {}),
    });
  }
  actions.sort((a, b) => Date.parse(String(b.at ?? '')) - Date.parse(String(a.at ?? '')));
  const evidenceByKey = new Map<string, BrowserEvidenceItem>();
  for (const item of evidence) {
    const key = `${item.id}\u001f${item.path}\u001f${item.createdAt}`;
    if (!evidenceByKey.has(key)) {
      evidenceByKey.set(key, item);
    }
  }
  const dedupedEvidence = Array.from(evidenceByKey.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    actions: actions.slice(0, 80),
    evidence: dedupedEvidence.slice(0, 80),
    ...(lastActionAt ? { lastActionAt } : {}),
    ...(lastKnownUrl ? { lastKnownUrl } : {}),
    ...(lastKnownTitle ? { lastKnownTitle } : {}),
  };
}

// ---------------------------------------------------------------------------
// Browser read / probe helpers
// ---------------------------------------------------------------------------

function readBrowserString(data: unknown): string | undefined {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!isRecord(data)) return undefined;
  return asString(data.url) ?? asString(data.title) ?? asString(data.value) ?? asString(data.text);
}

async function probeBrowserPage(
  workingDir: string,
  browserSession: string,
  sessionKey: string
): Promise<{ currentUrl?: string; title?: string; connected: boolean }> {
  const [urlResult, titleResult] = await Promise.all([
    runBrowserAction(workingDir, browserSession, sessionKey, { action: 'get_url' }),
    runBrowserAction(workingDir, browserSession, sessionKey, { action: 'get_title' }),
  ]);
  const currentUrl = urlResult.success ? readBrowserString(urlResult.data) : undefined;
  const title = titleResult.success ? readBrowserString(titleResult.data) : undefined;
  return {
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    connected: Boolean(currentUrl || title),
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleGetCockpitBrowserState(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKeyRaw: string | null
): Promise<void> {
  const sessionKey = asString(sessionKeyRaw);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required query param: sessionKey' }, 400);
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: 'Session not found' }, 404);
    return;
  }

  const workingDir = session.workingDir ?? ctx.workingDir;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const parsed = parseBrowserStateFromMetadata(session.metadata);
  const available = await checkAgentBrowserAvailable(workingDir);
  let connected = false;
  let currentUrl = parsed.lastKnownUrl;
  let title = parsed.lastKnownTitle;

  if (available) {
    let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
    try {
      probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
    } catch {
      probe = { connected: false };
    }
    connected = probe.connected;
    if (probe.currentUrl) currentUrl = probe.currentUrl;
    if (probe.title) title = probe.title;
  }

  let lastSnapshotPreview: string | undefined;
  const latestSnapshot = parsed.evidence.find((item) => item.type === 'snapshot');
  if (latestSnapshot) {
    const resolved = await resolveSessionFilePath(workingDir, latestSnapshot.path);
    if (resolved.resolvedPath) {
      const fs = await import('fs/promises');
      const preview = await fs.readFile(resolved.resolvedPath, 'utf8').catch(() => '');
      if (preview) {
        lastSnapshotPreview = preview.slice(0, 3000);
      }
    }
  }

  const filesystem = await buildCockpitFilesystemRoots(ctx).catch(() => null);

  sendJson(res, {
    success: true,
    state: {
      sessionKey,
      cwd: workingDir,
      browserSession,
      available,
      connected,
      ...(currentUrl ? { currentUrl } : {}),
      ...(title ? { title } : {}),
      ...(parsed.lastActionAt ? { lastActionAt: parsed.lastActionAt } : {}),
      actions: parsed.actions,
      evidence: parsed.evidence,
      ...(filesystem ? { filesystemRoots: filesystem.roots } : {}),
      ...(latestSnapshot ? { lastSnapshotPath: latestSnapshot.path } : {}),
      ...(lastSnapshotPreview ? { lastSnapshotPreview } : {}),
    },
  });
}

export async function handlePostCockpitBrowserAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const sessionKey = asString(body.sessionKey);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required field: sessionKey' }, 400);
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }
  const workingDir = session.workingDir ?? ctx.workingDir;
  const available = await checkAgentBrowserAvailable(workingDir);
  if (!available) {
    sendJson(res, { success: false, error: 'agent-browser is not available or failed to start' }, 503);
    return;
  }

  const parsedInput = parseBrowserActionInput(body);
  if (!parsedInput.input || parsedInput.error) {
    sendJson(res, { success: false, error: parsedInput.error ?? 'Invalid browser action payload' }, 400);
    return;
  }
  const input = parsedInput.input;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const result = await runBrowserAction(workingDir, browserSession, sessionKey, input);
  const nowIso = new Date().toISOString();

  let currentUrl = input.action === 'get_url' ? readBrowserString(result.data) : undefined;
  let title = input.action === 'get_title' ? readBrowserString(result.data) : undefined;
  if (result.success && input.action !== 'close' && (!currentUrl || !title)) {
    let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
    try {
      probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
    } catch {
      probe = { connected: false };
    }
    if (!currentUrl && probe.currentUrl) currentUrl = probe.currentUrl;
    if (!title && probe.title) title = probe.title;
  }

  const outputPreview = summarizeBrowserData(result.data) ?? summarizeBrowserData(result.stdout);
  const actionEvent: Record<string, unknown> = {
    type: 'browser_action',
    timestamp: nowIso,
    ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
    ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
    data: {
      action: input.action,
      success: result.success,
      browserSession,
      args: result.args,
      ...(outputPreview ? { outputPreview } : {}),
      ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(title ? { title } : {}),
      ...(result.error ? { error: result.error } : {}),
    },
  };

  let evidenceItem: BrowserEvidenceItem | undefined;
  if (result.success && result.artifactPath && (input.action === 'snapshot' || input.action === 'screenshot')) {
    evidenceItem = {
      id: buildBrowserEvidenceId(sessionKey),
      type: input.action === 'snapshot' ? 'snapshot' : 'screenshot',
      path: result.artifactPath,
      createdAt: nowIso,
      ...(input.label ? { label: input.label } : {}),
      ...(currentUrl ? { url: currentUrl } : {}),
      ...(title ? { title } : {}),
    };
  }

  if (ctx.graphd) {
    const agentEvents: Record<string, unknown>[] = [actionEvent];
    if (evidenceItem) {
      agentEvents.push({
        type: 'browser_evidence_captured',
        timestamp: nowIso,
        ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
        ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
        data: evidenceItem,
      });
    }
    const metadataPatch: Record<string, unknown> = {
      agent_events: agentEvents,
      ...(result.success && currentUrl ? { previewUrl: currentUrl } : {}),
      ...(evidenceItem ? { browser_evidence: [evidenceItem] } : {}),
      ...(input.action === 'snapshot' && result.success && result.artifactPath
        ? { browser_last_snapshot_path: result.artifactPath }
        : {}),
    };
    ctx.graphd.sessionUpdateMetadata(sessionKey, metadataPatch);
  }

  if (!result.success) {
    sendJson(
      res,
      {
        success: false,
        action: input.action,
        browserSession,
        error: result.error ?? 'Browser action failed',
        ...(result.stdout ? { output: result.stdout } : {}),
      },
      400
    );
    return;
  }

  sendJson(res, {
    success: true,
    action: input.action,
    browserSession,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.stdout ? { output: result.stdout } : {}),
    ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    ...(evidenceItem ? { evidence: evidenceItem } : {}),
  });
}

export async function handlePostCockpitBrowserRunbook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const sessionKey = asString(body.sessionKey);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required field: sessionKey' }, 400);
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }
  const workingDir = session.workingDir ?? ctx.workingDir;
  const available = await checkAgentBrowserAvailable(workingDir);
  if (!available) {
    sendJson(res, { success: false, error: 'agent-browser is not available or failed to start' }, 503);
    return;
  }
  const script = typeof body.script === 'string' ? body.script : '';
  if (!script.trim()) {
    sendJson(res, { success: false, error: 'Missing required field: script' }, 400);
    return;
  }
  if (Buffer.byteLength(script, 'utf8') > 50_000) {
    sendJson(res, { success: false, error: 'Runbook script exceeds 50KB limit' }, 400);
    return;
  }
  const parsed = parseBrowserRunbook(script);
  if (parsed.error) {
    sendJson(res, { success: false, error: parsed.error }, 400);
    return;
  }
  const steps = parsed.steps;
  const stopOnError = asBoolean(body.stopOnError) !== false;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const results: Array<Record<string, unknown>> = [];
  const agentEvents: Record<string, unknown>[] = [];
  const evidenceItems: BrowserEvidenceItem[] = [];
  const nowIso = new Date().toISOString();

  for (const step of steps) {
    const stepResult = await runBrowserAction(workingDir, browserSession, sessionKey, step.input);
    const outputPreview = summarizeBrowserData(stepResult.data) ?? summarizeBrowserData(stepResult.stdout);
    let evidenceItem: BrowserEvidenceItem | undefined;
    if (stepResult.success && stepResult.artifactPath && (step.input.action === 'snapshot' || step.input.action === 'screenshot')) {
      evidenceItem = {
        id: buildBrowserEvidenceId(sessionKey),
        type: step.input.action === 'snapshot' ? 'snapshot' : 'screenshot',
        path: stepResult.artifactPath,
        createdAt: nowIso,
        ...(step.input.label ? { label: step.input.label } : {}),
      };
      evidenceItems.push(evidenceItem);
      agentEvents.push({
        type: 'browser_evidence_captured',
        timestamp: new Date().toISOString(),
        ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
        ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
        data: evidenceItem,
      });
    }

    agentEvents.push({
      type: 'browser_action',
      timestamp: new Date().toISOString(),
      ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
      ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
      data: {
        action: step.input.action,
        line: step.line,
        success: stepResult.success,
        browserSession,
        args: stepResult.args,
        ...(outputPreview ? { outputPreview } : {}),
        ...(stepResult.artifactPath ? { artifactPath: stepResult.artifactPath } : {}),
        ...(stepResult.error ? { error: stepResult.error } : {}),
      },
    });

    results.push({
      line: step.line,
      action: step.input.action,
      success: stepResult.success,
      ...(stepResult.error ? { error: stepResult.error } : {}),
      ...(stepResult.data !== undefined ? { data: stepResult.data } : {}),
      ...(stepResult.artifactPath ? { artifactPath: stepResult.artifactPath } : {}),
      ...(outputPreview ? { outputPreview } : {}),
    });
    if (!stepResult.success && stopOnError) {
      break;
    }
  }

  let currentUrl: string | undefined;
  let title: string | undefined;
  let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
  try {
    probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
  } catch {
    probe = { connected: false };
  }
  if (probe.currentUrl) currentUrl = probe.currentUrl;
  if (probe.title) title = probe.title;

  if (ctx.graphd) {
    const metadataPatch: Record<string, unknown> = {
      agent_events: agentEvents,
      ...(evidenceItems.length > 0 ? { browser_evidence: evidenceItems } : {}),
      ...(currentUrl ? { previewUrl: currentUrl } : {}),
    };
    ctx.graphd.sessionUpdateMetadata(sessionKey, metadataPatch);
  }

  const succeeded = results.every((item) => item.success !== false);
  sendJson(res, {
    success: succeeded,
    browserSession,
    stopOnError,
    steps: results,
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    ...(evidenceItems.length > 0 ? { evidence: evidenceItems } : {}),
  });
}
