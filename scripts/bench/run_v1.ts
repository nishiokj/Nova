import { BridgeClient } from '../../packages/apps/tui/bridge_client.ts';
import { GraphStore } from '../../packages/infra/graphd/src/store.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function resolveDbPath(rawPath, rootDir) {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(rootDir, rawPath);
}

function getGitInfo() {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return { sha, branch, dirty: status.length > 0 };
  } catch {
    return {};
  }
}

async function waitForReady(client, sessionKey, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', handler);
      reject(new Error('Timed out waiting for ready event'));
    }, timeoutMs);

    const handler = (event) => {
      if (event.type !== 'ready') return;
      const data = event.data ?? {};
      if (data.session_key === sessionKey) {
        clearTimeout(timer);
        client.off('event', handler);
        resolve();
      }
    };

    client.on('event', handler);
  });
}

async function waitForCompletion(client, requestId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', handler);
      reject(new Error('Timed out waiting for run completion'));
    }, timeoutMs);

    const handler = (event) => {
      if (event.type === 'response') {
        const data = event.data ?? {};
        if (data.request_id === requestId) {
          clearTimeout(timer);
          client.off('event', handler);
          resolve({ success: Boolean(data.success), durationMs: Number(data.duration_ms ?? 0) });
        }
      }

      if (event.type === 'error') {
        clearTimeout(timer);
        client.off('event', handler);
        resolve({ success: false, durationMs: 0 });
      }

      if (event.type === 'user_prompt') {
        clearTimeout(timer);
        client.off('event', handler);
        resolve({ success: false, durationMs: 0 });
      }
    };

    client.on('event', handler);
  });
}

function aggregateMetrics(events, requestId) {
  const llmEvents = events.filter((event) => event.type === 'llm_call' && event.request_id === requestId);
  const toolNames = new Set();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let totalToolCalls = 0;

  for (const event of llmEvents) {
    const data = event.data ?? {};
    promptTokens += Number(data.prompt_tokens ?? 0);
    completionTokens += Number(data.completion_tokens ?? 0);
    totalTokens += Number(data.total_tokens ?? 0);
    totalToolCalls += Number(data.tool_calls_count ?? 0);

    const tools = Array.isArray(data.tool_names) ? data.tool_names : [];
    for (const tool of tools) {
      if (typeof tool === 'string') toolNames.add(tool);
    }
  }

  return {
    total_llm_calls: llmEvents.length,
    total_tool_calls: totalToolCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    tool_names: Array.from(toolNames),
  };
}

async function loadSessionEvents(dbPath, sessionKey, requestId) {
  const store = new GraphStore(dbPath);
  try {
    const session = store.getSession(sessionKey);
    if (!session || !session.metadata) return { session: null, events: [] };
    const events = Array.isArray(session.metadata.agent_events)
      ? session.metadata.agent_events
      : [];
    const requestEvents = events.filter((event) => event.request_id === requestId);
    return { session, events: requestEvents };
  } finally {
    store.close();
  }
}

async function pollForEvents(dbPath, sessionKey, requestId) {
  const maxAttempts = 20;
  const delayMs = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { session, events } = await loadSessionEvents(dbPath, sessionKey, requestId);
    if (session && events.length > 0) {
      return { session, events };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { session: null, events: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptText = args.prompt ?? 'Benchmark v1: hello';
  const promptId = args.prompt_id ?? 'v1_default';
  const outPath = args.out ?? 'bench/results.jsonl';
  const workingDir = args.working_dir ?? process.cwd();

  const sessionKey = args.session_key ?? `bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestId = args.request_id ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const host = process.env.EVENT_BUS_HOST ?? '127.0.0.1';
  const port = Number(process.env.EVENT_BUS_PORT ?? '9555');

  const client = new BridgeClient({ host, port });
  await client.connect();

  client.send({
    type: 'init',
    data: {
      session_key: sessionKey,
      working_dir: workingDir,
    },
  });

  await waitForReady(client, sessionKey);

  client.send({
    type: 'send_text',
    data: {
      text: promptText,
      client_request_id: requestId,
      working_dir: workingDir,
    },
  });

  const completion = await waitForCompletion(client, requestId);
  client.close();

  const configPath = path.resolve(process.cwd(), 'config/harness_config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (!config.graphd?.enabled || !config.graphd.db_path) {
    throw new Error('GraphD is not enabled in config; cannot validate run in DB');
  }

  const dbPath = resolveDbPath(config.graphd.db_path, process.cwd());
  const { session, events } = await pollForEvents(dbPath, sessionKey, requestId);

  const metrics = aggregateMetrics(events, requestId);
  const gitInfo = getGitInfo();

  const result = {
    request_id: requestId,
    session_key: sessionKey,
    provider: typeof session?.metadata?.provider === 'string' ? session.metadata.provider : undefined,
    model: typeof session?.metadata?.model === 'string' ? session.metadata.model : undefined,
    prompt_id: promptId,
    prompt_text: promptText,
    total_llm_calls: metrics.total_llm_calls,
    total_tool_calls: metrics.total_tool_calls,
    prompt_tokens: metrics.prompt_tokens,
    completion_tokens: metrics.completion_tokens,
    total_tokens: metrics.total_tokens,
    duration_ms: completion.durationMs,
    tool_names: metrics.tool_names,
    success: completion.success,
    git_sha: gitInfo.sha,
    git_branch: gitInfo.branch,
    git_dirty: gitInfo.dirty,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, `${JSON.stringify(result)}\n`);

  if (metrics.total_llm_calls === 0) {
    console.warn('Warning: no llm_call events found in GraphD for this request.');
  }

  console.log(`Wrote benchmark result to ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
