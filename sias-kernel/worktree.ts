import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type { GraphStore } from '../packages/graphd/src/index.js';

interface WorktreeManagerOptions {
  baseDir: string;
  installDependencies?: boolean;
  maxVersionsToKeep?: number;
}

interface SessionMetadata {
  currentVersion: string;
  wipVersion: string;
  rollbackCount: number;
}

export class WorktreeManager {
  private baseDir: string;
  private installDependencies: boolean;
  private maxVersionsToKeep: number;

  constructor(
    private readonly store: GraphStore,
    private readonly sessionId: string,
    private readonly logger: Logger,
    options: WorktreeManagerOptions
  ) {
    this.baseDir = options.baseDir;
    this.installDependencies = options.installDependencies ?? false;
    this.maxVersionsToKeep = options.maxVersionsToKeep ?? 5;
  }

  async getCurrentVersion(): Promise<string> {
    const metadata = this.getSessionMetadata();
    return metadata.currentVersion || 'v000';
  }

  async getWipVersion(): Promise<string> {
    const metadata = this.getSessionMetadata();
    if (metadata.wipVersion) {
      return metadata.wipVersion;
    }
    const next = incrementVersion(await this.getCurrentVersion());
    return `${next}-wip`;
  }

  async createWip(): Promise<string> {
    const currentVersion = await this.getCurrentVersion();
    const nextVersion = incrementVersion(currentVersion);
    const wipVersion = `${nextVersion}-wip`;
    const wipPath = path.join(this.baseDir, wipVersion);

    await execCommand('git', ['worktree', 'add', wipPath, 'HEAD']);
    if (this.installDependencies) {
      await execCommand('bun', ['install'], wipPath);
    }

    this.store.upsertSiasWorktree({
      version: wipVersion,
      path: wipPath,
      status: 'wip',
      createdAt: Date.now() / 1000,
      promotedAt: null,
      archivedAt: null,
      iterationsRun: 0,
      benchmarkScore: 0,
      failureCount: 0,
      failureReason: null,
      failureIteration: null,
      gitCommit: null,
      patchesIncludedJson: null,
      benchmarkScoresJson: null,
    });

    this.updateSessionMetadata({
      currentVersion,
      wipVersion,
      rollbackCount: this.getSessionMetadata().rollbackCount,
    });

    return wipPath;
  }

  async promoteWip(): Promise<string> {
    const wipVersion = await this.getWipVersion();
    const wipPath = path.join(this.baseDir, wipVersion);
    const finalVersion = wipVersion.replace(/-wip$/, '');
    const finalPath = path.join(this.baseDir, finalVersion);

    try {
      await fs.access(wipPath);
    } catch {
      throw new Error(`WIP directory does not exist: ${wipPath}. Call createWip() first.`);
    }

    await fs.rename(wipPath, finalPath);

    this.store.upsertSiasWorktree({
      version: finalVersion,
      path: finalPath,
      status: 'active',
      createdAt: Date.now() / 1000,
      promotedAt: Date.now() / 1000,
      archivedAt: null,
      iterationsRun: 0,
      benchmarkScore: 0,
      failureCount: 0,
      failureReason: null,
      failureIteration: null,
      gitCommit: null,
      patchesIncludedJson: null,
      benchmarkScoresJson: null,
    });

    const metadata = this.getSessionMetadata();
    this.updateSessionMetadata({
      currentVersion: finalVersion,
      wipVersion: '',
      rollbackCount: metadata.rollbackCount,
    });

    await this.createWip();
    await this.garbageCollect();

    return finalPath;
  }

  async rollbackToVersion(version: string): Promise<void> {
    const metadata = this.getSessionMetadata();
    const previous = metadata.currentVersion;
    this.store.upsertSiasWorktree({
      version: previous,
      path: path.join(this.baseDir, previous),
      status: 'failed',
      createdAt: Date.now() / 1000,
      promotedAt: null,
      archivedAt: null,
      iterationsRun: 0,
      benchmarkScore: 0,
      failureCount: (metadata.rollbackCount ?? 0) + 1,
      failureReason: 'rollback',
      failureIteration: null,
      gitCommit: null,
      patchesIncludedJson: null,
      benchmarkScoresJson: null,
    });

    this.updateSessionMetadata({
      currentVersion: version,
      wipVersion: metadata.wipVersion,
      rollbackCount: metadata.rollbackCount + 1,
    });
  }

  async garbageCollect(): Promise<void> {
    const worktrees = this.store.listSiasWorktrees();
    if (worktrees.length <= this.maxVersionsToKeep) return;

    const sorted = worktrees.sort((a, b) => b.createdAt - a.createdAt);
    const metadata = this.getSessionMetadata();
    const keep = new Set<string>([metadata.currentVersion, metadata.wipVersion]);

    for (const worktree of sorted.slice(0, this.maxVersionsToKeep)) {
      keep.add(worktree.version);
    }

    for (const worktree of worktrees) {
      if (!keep.has(worktree.version)) {
        try {
          if (worktree.status === 'failed') {
            await fs.rename(worktree.path, `${worktree.path}-archived`);
          } else {
            await execCommand('git', ['worktree', 'remove', worktree.path, '--force']);
          }
        } catch (error) {
          this.logger.warn('Worktree cleanup failed', { version: worktree.version, error: String(error) });
        }
      }
    }
  }

  private getSessionMetadata(): SessionMetadata {
    const session = this.store.getSiasSession(this.sessionId);
    const metadata = (session?.metadata as SessionMetadata | undefined) ?? {
      currentVersion: 'v000',
      wipVersion: '',
      rollbackCount: 0,
    };
    return {
      currentVersion: metadata.currentVersion ?? 'v000',
      wipVersion: metadata.wipVersion ?? '',
      rollbackCount: metadata.rollbackCount ?? 0,
    };
  }

  private updateSessionMetadata(metadata: SessionMetadata): void {
    this.store.updateSiasSession(this.sessionId, { metadata });
  }
}

export function incrementVersion(version: string): string {
  const match = version.match(/v(\d+)/);
  if (!match) return 'v001';
  const next = Number(match[1]) + 1;
  return `v${String(next).padStart(match[1].length, '0')}`;
}

function execCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
