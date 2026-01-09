import fs from 'fs';
import { createAdapter } from '../packages/agent-core/src/llm/adapter.js';
import { ToolRegistry } from '../packages/agent-core/src/tools/registry.js';
import { builtinToolOptions } from '../packages/agent-core/src/tools/builtins/index.js';
import { createLogger } from '../packages/agent-core/src/shared/logger.js';
import { GraphStore, generateSessionKey } from '../packages/graphd/src/index.js';
import { loadKernelConfig } from './config.js';
import { createKernelAgentRegistry } from './agents.js';
import { BenchmarkRunner } from './benchmark.js';
import { ContextManager } from './context.js';
import { FlipFlopDetector } from './flipflop.js';
import { HealthCollector } from './health.js';
import { persistCheckpoint, restoreCheckpoint } from './checkpoint.js';
import { runIteration } from './loop.js';
import { prepareUpgrade, triggerUpgrade } from './upgrade.js';
import { WorktreeManager } from './worktree.js';

async function main(): Promise<void> {
  const config = loadKernelConfig();
  const logger = createLogger({
    backend: config.log.backend,
    format: config.log.format,
    level: config.log.level,
    path: config.log.path,
    maxSizeBytes: config.log.maxSizeBytes,
  });

  const store = new GraphStore(config.graphdDbPath);
  store.initialize();
  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };

  const sessionId = generateSessionKey('sias');
  const worktreeManager = new WorktreeManager(store, sessionId, logger, {
    baseDir: config.worktreeBaseDir,
    installDependencies: false,
    maxVersionsToKeep: 5,
  });

  if (!fs.existsSync(config.worktreeBaseDir)) {
    fs.mkdirSync(config.worktreeBaseDir, { recursive: true });
  }

  const currentVersion = await worktreeManager.getCurrentVersion();
  let state = await restoreCheckpoint(store, sessionId, currentVersion);

  const toolRegistry = new ToolRegistry({
    enabledTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  }, process.cwd());

  for (const tool of builtinToolOptions) {
    toolRegistry.register(tool);
  }

  const agentRegistry = createKernelAgentRegistry(config);
  const adapterLogger = {
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  };

  const apiKeys: Record<string, string> = {};
  for (const [agentType, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.apiKey) continue;
    if (agentConfig.provider === 'unknown') continue;
    const existing = apiKeys[agentConfig.provider];
    if (existing && existing !== agentConfig.apiKey) {
      logger.warn('[kernel] Conflicting API keys for provider', {
        provider: agentConfig.provider,
        agent: agentType,
      });
      continue;
    }
    apiKeys[agentConfig.provider] = agentConfig.apiKey;
  }

  const llm = createAdapter({ apiKeys }, adapterLogger);

  const contextManager = new ContextManager(sessionId, 200000);
  const health = new HealthCollector(logger, currentVersion);
  const benchmarkRunner = new BenchmarkRunner(sessionId, store, logger);
  const flipFlopDetector = new FlipFlopDetector(store, logger);

  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('[kernel] Shutdown requested, persisting checkpoint...');
    await persistCheckpoint(store, state);
    closeStore();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  const checkpointHandler = async () => {
    await persistCheckpoint(store, state);
    const checkpoints = store.listSiasCheckpoints(state.sessionId, 1);
    health.recordCheckpoint(Date.now(), checkpoints.length, store.listSiasPatches(state.sessionId).length, store.listSiasDecisions(state.sessionId).length);
  };

  const updateHealthWorktree = async () => {
    const currentVersion = await worktreeManager.getCurrentVersion();
    const wipVersion = await worktreeManager.getWipVersion();
    const totalVersions = store.listSiasWorktrees().length;
    const session = store.getSiasSession(sessionId);
    const rollbackCount = (session?.metadata as { rollbackCount?: number } | undefined)?.rollbackCount ?? 0;
    health.recordWorktree(currentVersion, wipVersion, totalVersions, rollbackCount);
  };

  const rollbackHandler = async () => {
    const currentVersion = await worktreeManager.getCurrentVersion();
    const currentWorktree = store.getSiasWorktree(currentVersion);
    const currentAnchor =
      currentWorktree?.promotedAt ??
      currentWorktree?.createdAt ??
      Number.MAX_SAFE_INTEGER;
    const candidates = store
      .listSiasWorktrees()
      .filter((worktree) => worktree.version !== currentVersion && worktree.status === 'active')
      .filter((worktree) => {
        const anchor = worktree.promotedAt ?? worktree.createdAt ?? 0;
        return anchor > 0 && anchor < currentAnchor;
      })
      .sort(
        (a, b) =>
          (b.promotedAt ?? b.createdAt ?? 0) - (a.promotedAt ?? a.createdAt ?? 0)
      );
    const target = candidates.at(0)?.version;
    if (target) {
      await worktreeManager.rollbackToVersion(target);
    } else {
      logger.warn('[kernel] No rollback target found', { currentVersion });
    }
  };

  const pauseHandler = async () => {
    logger.warn('[kernel] Pausing iteration loop');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  };

  const rotateLogsHandler = async () => {
    logger.info('[kernel] Rotating logs');
    if (logger.forceRotate) {
      logger.forceRotate();
    }
  };

  const updateLogMetrics = () => {
    const filePath = logger.getFilePath?.() ?? null;
    const fileSize = logger.getFileSizeBytes?.() ?? 0;
    health.recordLogFile(filePath, fileSize);
  };

  while (!shuttingDown) {
    try {
      const iterationResult = await runIteration(state, {
        config,
        store,
        logger,
        llm,
        toolRegistry,
        agentRegistry,
        contextManager,
        health,
        benchmarkRunner,
        flipFlopDetector,
        oncallHandler: async () => undefined,
        checkpointHandler,
        rollbackHandler,
        pauseHandler,
        rotateLogsHandler,
      });

      await updateHealthWorktree();
      updateLogMetrics();

      state.iteration = iterationResult.iteration;
      if (iterationResult.status === 'upgraded') {
        state.lastUpgradeIteration = state.iteration;
        await persistCheckpoint(store, state);
        const newPath = await prepareUpgrade(worktreeManager);
        await triggerUpgrade(newPath, config.upgradeSignalFile, logger);
        break;
      }

      if (state.iteration % config.checkpointEveryIterations === 0) {
        await checkpointHandler();
      }
    } catch (error) {
      logger.error('[kernel] Iteration failed', { error });
      await persistCheckpoint(store, state);

      if (isTransientError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      closeStore();
      process.exit(1);
    }
  }

  closeStore();
}

main().catch((error) => {
  console.error('[kernel] Fatal error', error);
  process.exit(1);
});

function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const code =
    typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code?: string }).code).toLowerCase()
      : '';

  return [
    'timeout',
    'timed out',
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'enetunreach',
    'rate limit',
    'temporary',
    'overloaded',
    'throttled',
  ].some((token) => message.includes(token) || code.includes(token));
}
