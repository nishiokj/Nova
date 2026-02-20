#!/usr/bin/env bun
/**
 * Inter-process compatibility smoke test.
 *
 * Verifies split deployment compatibility across:
 * - graphd
 * - harness-daemon
 * - control-plane
 *
 * Checks:
 * - health/start/stop
 * - bridge command round trip
 * - event streaming (SSE connect frame)
 * - session operations
 * - permissions route flow
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessClient } from 'harness-client';

type JsonRecord = Record<string, unknown>;

interface ManagedProcess {
  name: string;
  proc: ChildProcess;
  logs: string[];
}

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function spawnManaged(
  name: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string }
): ManagedProcess {
  const proc = spawn('bun', args, {
    cwd: options?.cwd ?? process.cwd(),
    env: options?.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  proc.stdout?.on('data', (chunk: Buffer | string) => {
    logs.push(`[stdout] ${String(chunk).trimEnd()}`);
  });
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    logs.push(`[stderr] ${String(chunk).trimEnd()}`);
  });

  return { name, proc, logs };
}

async function stopManaged(processInfo: ManagedProcess | null): Promise<void> {
  if (!processInfo) return;
  if (processInfo.proc.exitCode !== null) return;

  processInfo.proc.kill('SIGINT');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      processInfo.proc.once('exit', () => resolve(true));
    }),
    sleep(5_000).then(() => false),
  ]);

  if (!exited && processInfo.proc.exitCode === null) {
    processInfo.proc.kill('SIGKILL');
  }
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function fetchJson(
  url: string,
  options?: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: JsonRecord;
    expectedStatus?: number;
  }
): Promise<{ status: number; data: JsonRecord }> {
  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const status = response.status;
  const text = await response.text();
  const data = (text ? JSON.parse(text) : {}) as JsonRecord;

  if (typeof options?.expectedStatus === 'number') {
    assertOk(
      status === options.expectedStatus,
      `Expected status ${options.expectedStatus} for ${url}, got ${status} with body ${text}`
    );
  } else {
    assertOk(
      status >= 200 && status < 300,
      `Expected 2xx for ${url}, got ${status} with body ${text}`
    );
  }

  return { status, data };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const runDir = await mkdtemp(join(tmpdir(), 'rex-interprocess-smoke-'));
  const graphdPort = 9944;
  const busHost = '127.0.0.1';
  const busPort = 9955;
  const wsPort = 9956;
  const controlPlanePort = 9957;
  const controlPlaneBase = `http://127.0.0.1:${controlPlanePort}`;

  let graphd: ManagedProcess | null = null;
  let daemon: ManagedProcess | null = null;
  let controlPlane: ManagedProcess | null = null;
  let tempConfigPath = '';

  try {
    const defaultsRaw = await readFile(join(repoRoot, 'config/defaults.json'), 'utf8');
    const defaults = JSON.parse(defaultsRaw) as JsonRecord;
    const graphdConfig = (defaults.graphd ?? {}) as JsonRecord;
    const entityGraphConfig = (defaults.entity_graph ?? {}) as JsonRecord;
    const memoryConfig = (defaults.memory ?? {}) as JsonRecord;

    graphdConfig.host = '127.0.0.1';
    graphdConfig.port = graphdPort;
    graphdConfig.db_path = join(runDir, 'graphd-smoke.db');
    graphdConfig.enabled = true;
    entityGraphConfig.enabled = false;
    memoryConfig.enabled = false;

    defaults.graphd = graphdConfig;
    defaults.entity_graph = entityGraphConfig;
    defaults.memory = memoryConfig;

    tempConfigPath = join(runDir, 'smoke-config.json');
    await writeFile(tempConfigPath, JSON.stringify(defaults, null, 2));

    graphd = spawnManaged('graphd', [
      'run',
      'packages/infra/graphd/src/graphd.ts',
      '--host', '127.0.0.1',
      '--port', String(graphdPort),
      '--db-path', join(runDir, 'graphd-smoke.db'),
      '--root', repoRoot,
    ]);

    await waitFor(async () => {
      try {
        const { data } = await fetchJson(`http://127.0.0.1:${graphdPort}/health`);
        return data.status === 'ok';
      } catch {
        return false;
      }
    }, 20_000);

    daemon = spawnManaged(
      'harness-daemon',
      [
        'run',
        'packages/infra/harness-daemon/src/index.ts',
        '--host', busHost,
        '--port', String(busPort),
        '--ws-port', String(wsPort),
        '--idle-timeout', '0',
        '--config', tempConfigPath,
      ],
      {
        env: {
          ...process.env,
          EVENT_BUS_HOST: busHost,
          EVENT_BUS_PORT: String(busPort),
        },
      }
    );

    // Bridge command round trip (direct bus client)
    await waitFor(async () => {
      const client = new HarnessClient({
        host: busHost,
        port: busPort,
        requestTimeout: 2_000,
        maxReconnectAttempts: 0,
      });
      try {
        await client.connect();
        const result = await client.request<{ success?: boolean }>('control_plane_memory_info', {});
        return result.success === true;
      } catch {
        return false;
      } finally {
        client.close();
      }
    }, 20_000);

    controlPlane = spawnManaged(
      'control-plane',
      [
        'run',
        'packages/apps/control-plane/src/control-plane.ts',
        '--host', '127.0.0.1',
        '--port', String(controlPlanePort),
        '--bus-host', busHost,
        '--bus-port', String(busPort),
        '--config', tempConfigPath,
      ],
      {
        env: {
          ...process.env,
          EVENT_BUS_HOST: busHost,
          EVENT_BUS_PORT: String(busPort),
        },
      }
    );

    await waitFor(async () => {
      try {
        const response = await fetch(`${controlPlaneBase}/control-plane/sessions?limit=1`);
        return response.ok;
      } catch {
        return false;
      }
    }, 20_000);

    // Session operations
    const create = await fetchJson(`${controlPlaneBase}/control-plane/cockpit/session/create`, {
      method: 'POST',
      body: {
        goal: 'Inter-process smoke test',
        metadata: { source: 'cockpit-document' },
      },
    });
    assertOk(create.data.success === true, 'Session create failed');
    const sessionKey = String(create.data.sessionKey ?? '');
    assertOk(sessionKey.length > 0, 'Session create did not return sessionKey');

    await fetchJson(`${controlPlaneBase}/control-plane/sessions/${encodeURIComponent(sessionKey)}`);
    const list = await fetchJson(`${controlPlaneBase}/control-plane/sessions?limit=20`);
    const sessions = Array.isArray(list.data.sessions) ? list.data.sessions : [];
    assertOk(
      sessions.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const row = item as JsonRecord;
        const candidate =
          row.sessionKey
          ?? row.session_key
          ?? row.id
          ?? row.sessionId
          ?? row.session_id;
        return candidate === sessionKey;
      }),
      `Created session ${sessionKey} was not found in sessions list`
    );

    // Bridge-backed model route round trip via control-plane
    const setModel = await fetchJson(
      `${controlPlaneBase}/control-plane/cockpit/session/${encodeURIComponent(sessionKey)}/model`,
      {
        method: 'POST',
        body: {
          agentType: 'standard',
          provider: 'openai',
          model: 'gpt-4o-mini',
        },
      }
    );
    assertOk(setModel.data.success === true, 'Session model set failed');
    const getModel = await fetchJson(
      `${controlPlaneBase}/control-plane/cockpit/session/${encodeURIComponent(sessionKey)}/model`
    );
    assertOk(getModel.data.selections && typeof getModel.data.selections === 'object', 'Session model get failed');

    // Permission flow
    await fetchJson(`${controlPlaneBase}/control-plane/cockpit/session/${encodeURIComponent(sessionKey)}/permissions`);
    const updatePerms = await fetchJson(
      `${controlPlaneBase}/control-plane/cockpit/session/${encodeURIComponent(sessionKey)}/permissions`,
      {
        method: 'POST',
        body: {
          writesNoDeletes: true,
          webSearchEnabled: false,
        },
      }
    );
    assertOk(updatePerms.data.success === true, 'Permission update failed');
    const permissionResponse = await fetchJson(`${controlPlaneBase}/control-plane/cockpit/permissions/response`, {
      method: 'POST',
      body: {
        sessionKey,
        requestId: 'smoke-permission-request',
        decision: 'allow',
      },
    });
    assertOk(permissionResponse.data.success === true, 'Permission response forwarding failed');

    // Event streaming (SSE)
    const sseResponse = await fetch(`${controlPlaneBase}/control-plane/cockpit/events/stream`);
    assertOk(sseResponse.ok, `SSE endpoint failed with status ${sseResponse.status}`);
    assertOk(sseResponse.body, 'SSE endpoint missing response body');
    const reader = sseResponse.body.getReader();
    const firstChunk = await Promise.race([
      reader.read(),
      sleep(5_000).then(() => ({ done: true, value: undefined })),
    ]);
    const decoded = firstChunk.value ? new TextDecoder().decode(firstChunk.value) : '';
    await reader.cancel();
    assertOk(decoded.includes('"type":"connected"'), `SSE did not emit connected frame. Got: ${decoded}`);

    console.log('Inter-process smoke test passed.');
  } catch (error) {
    console.error('Inter-process smoke test failed:', error instanceof Error ? error.message : String(error));
    for (const proc of [graphd, daemon, controlPlane]) {
      if (!proc) continue;
      console.error(`\n--- ${proc.name} logs (tail) ---`);
      const tail = proc.logs.slice(-40);
      for (const line of tail) {
        console.error(line);
      }
    }
    throw error;
  } finally {
    await stopManaged(controlPlane);
    await stopManaged(daemon);
    await stopManaged(graphd);
    if (tempConfigPath) {
      await rm(runDir, { recursive: true, force: true });
    }
  }
}

main().catch(() => {
  process.exit(1);
});
