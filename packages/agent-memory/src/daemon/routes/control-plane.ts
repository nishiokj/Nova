/**
 * Control Plane API Routes
 *
 * Provides endpoints for the Control Plane dashboard:
 * - Project/Feature/PR grouping
 * - Decision provenance
 * - Trace annotations
 * - Job orchestration overview
 */

import type { HttpServer } from '../server.js';
import type { SyncDaemon } from '../index.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Types for Control Plane data structures
interface Project {
  id: string;
  name: string;
  path: string;
  features: Feature[];
  sessionCount: number;
  activeGoals: number;
}

interface Feature {
  id: string;
  name: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  prs: PRInfo[];
  sessionCount: number;
}

interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
}

interface DecisionProvenance {
  sessionId: string;
  requestId: string;
  decisionId: string;
  decision: string;
  rationale: string;
  timestamp: string;
  filesAffected: string[];
  confidence: string;
}

interface TraceAnnotation {
  file: string;
  line: number;
  requestId: string;
  toolName: string;
  action: 'read' | 'write' | 'edit';
  timestamp: string;
  success: boolean;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Execute gh CLI command
 */
async function ghCommand(args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      timeout: 30000,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (error) {
    console.error('[control-plane] gh command failed:', args, error);
    throw error;
  }
}

/**
 * Get PRs for a repository
 */
async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const result = await ghCommand(
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft`
    );
    const prs: PRInfo[] = JSON.parse(result).map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.state as string).toLowerCase() as PRInfo['state'],
      author: (pr.author as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.url as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changedFiles as number) ?? 0,
      createdAt: pr.createdAt as string,
      updatedAt: pr.updatedAt as string,
      isDraft: (pr.isDraft as boolean) ?? false,
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
  } catch {
    return [];
  }
}

/**
 * Get diff for a PR
 */
async function getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
  try {
    return await ghCommand(`pr diff ${prNumber} --repo ${owner}/${repo}`);
  } catch {
    return '';
  }
}

/**
 * Extract file paths from a git diff
 */
function extractFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  const lines = diff.split('\n');

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const match = line.match(/diff --git a\/(.+) b\//);
      if (match) {
        files.push(match[1]);
      }
    }
  }

  return [...new Set(files)];
}

/**
 * Register Control Plane routes
 */
export function registerControlPlaneRoutes(server: HttpServer, daemon: SyncDaemon): void {
  /**
   * GET /control-plane/projects
   * List projects (derived from working directories in sessions)
   */
  server.get('/control-plane/projects', async () => {
    try {
      const sql = daemon.sql;

      // Get unique working directories from sessions
      const sessions = await sql<{ working_dir: string; session_count: string }[]>`
        SELECT working_dir, COUNT(*)::text as session_count
        FROM sessions
        WHERE working_dir IS NOT NULL
        GROUP BY working_dir
        ORDER BY COUNT(*) DESC
        LIMIT 100
      `;

      if (!sessions || sessions.length === 0) {
        return { body: { projects: [] } };
      }

      const projects: Project[] = sessions.map((row, idx) => {
        const parts = row.working_dir.split('/');
        const name = parts[parts.length - 1] || row.working_dir;
        return {
          id: `project-${idx}`,
          name,
          path: row.working_dir,
          features: [],
          sessionCount: parseInt(row.session_count, 10),
          activeGoals: 0,
        };
      });

      // Get active goals count per project
      if (daemon.goalsRepo) {
        const goals = await daemon.goalsRepo.getActiveGoals(100);
        // Group by working directory from metadata
        for (const goal of goals) {
          const meta = goal.metadata as Record<string, unknown> | null;
          const workDir = meta?.workingDir as string | undefined;
          if (workDir) {
            const project = projects.find(p => p.path === workDir);
            if (project) {
              project.activeGoals++;
            }
          }
        }
      }

      return { body: { projects } };
    } catch (error) {
      console.error('[control-plane] Error listing projects:', error);
      return { body: { projects: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/projects/:id/features
   * List features (branches) for a project
   */
  server.get('/control-plane/projects/:id/features', async (req) => {
    try {
      const workingDir = decodeURIComponent(req.params.id);

      // Get branches via git
      let branches: string[] = [];
      try {
        const { stdout } = await execAsync('git branch -a --format="%(refname:short)"', {
          cwd: workingDir,
          timeout: 10000,
        });
        branches = stdout.trim().split('\n').filter(Boolean);
      } catch {
        branches = [];
      }

      // Get current branch
      let currentBranch = 'main';
      try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
          cwd: workingDir,
          timeout: 5000,
        });
        currentBranch = stdout.trim();
      } catch {
        // ignore
      }

      // Get sessions per branch
      const sql = daemon.sql;
      const sessions = await sql<{ metadata_json: string | null }[]>`
        SELECT metadata_json FROM sessions WHERE working_dir = ${workingDir}
      `;

      const branchSessionCounts = new Map<string, number>();
      for (const row of sessions ?? []) {
        try {
          const meta = JSON.parse(row.metadata_json || '{}');
          const branch = meta.branch || currentBranch;
          branchSessionCounts.set(branch, (branchSessionCounts.get(branch) ?? 0) + 1);
        } catch {
          // ignore
        }
      }

      const features: Feature[] = branches.slice(0, 50).map((branch, idx) => ({
        id: `feature-${idx}`,
        name: branch,
        branch,
        baseBranch: 'main',
        projectId: req.params.id,
        prs: [],
        sessionCount: branchSessionCounts.get(branch) ?? 0,
      }));

      return { body: { features, currentBranch } };
    } catch (error) {
      console.error('[control-plane] Error listing features:', error);
      return { body: { features: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/features/:id/prs
   * List PRs for a feature (via GitHub CLI)
   */
  server.get('/control-plane/features/:id/prs', async (req) => {
    try {
      const owner = req.query.owner;
      const repo = req.query.repo;
      const branch = decodeURIComponent(req.params.id);

      if (!owner || !repo) {
        return { body: { prs: [], error: 'Missing owner or repo query params' } };
      }

      const allPrs = await getPRs(owner, repo);

      // Filter PRs by head branch if specified
      const prs = branch
        ? allPrs.filter(pr => pr.title.toLowerCase().includes(branch.toLowerCase()))
        : allPrs;

      return { body: { prs } };
    } catch (error) {
      console.error('[control-plane] Error listing PRs:', error);
      return { body: { prs: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/prs/:num/provenance
   * Get decisions and goals that influenced a PR's changes
   */
  server.get('/control-plane/prs/:num/provenance', async (req) => {
    try {
      const owner = req.query.owner;
      const repo = req.query.repo;
      const prNumber = parseInt(req.params.num, 10);

      if (!owner || !repo || isNaN(prNumber)) {
        return { body: { provenance: [], error: 'Missing owner, repo, or invalid PR number' } };
      }

      // Get PR diff to find affected files
      const diff = await getPRDiff(owner, repo, prNumber);
      const affectedFiles = extractFilesFromDiff(diff);

      // Query decisions that mention these files
      const provenance: DecisionProvenance[] = [];

      if (daemon.decisionsRepo && affectedFiles.length > 0) {
        for (const file of affectedFiles.slice(0, 20)) {
          const decisions = await daemon.decisionsRepo.search(file, { limit: 5 });
          for (const decision of decisions) {
            provenance.push({
              sessionId: '',
              requestId: '',
              decisionId: decision.id,
              decision: decision.decision,
              rationale: decision.rationale ?? '',
              timestamp: new Date().toISOString(),
              filesAffected: [file],
              confidence: 'medium',
            });
          }
        }
      }

      return {
        body: {
          provenance,
          affectedFiles,
          prNumber,
        },
      };
    } catch (error) {
      console.error('[control-plane] Error getting provenance:', error);
      return { body: { provenance: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/sessions/:id/trace-annotations
   * Get trace data mapped to code lines
   */
  server.get('/control-plane/sessions/:id/trace-annotations', async (req) => {
    try {
      const sessionId = req.params.id;

      // Get session events from database
      const sql = daemon.sql;
      const sessions = await sql<{ metadata_json: string | null }[]>`
        SELECT metadata_json FROM sessions WHERE session_key = ${sessionId}
      `;

      if (!sessions || sessions.length === 0) {
        return { body: { annotations: [], error: 'Session not found' } };
      }

      const meta = JSON.parse(sessions[0].metadata_json || '{}');
      const agentEvents = meta.agent_events ?? [];

      const annotations: TraceAnnotation[] = [];

      for (const event of agentEvents as Array<Record<string, unknown>>) {
        if (event.type === 'tool_call') {
          const data = (event.data ?? {}) as Record<string, unknown>;
          const toolName = (data.tool_name ?? data.toolName ?? '') as string;
          const args = (data.arguments ?? {}) as Record<string, unknown>;

          // Extract file and action from tool call
          const file = (args.file_path ?? args.path ?? args.file ?? '') as string;
          let line = 1;
          let action: TraceAnnotation['action'] = 'read';

          if (toolName === 'Read' || toolName === 'file_read') {
            action = 'read';
          } else if (toolName === 'Write' || toolName === 'file_write') {
            action = 'write';
          } else if (toolName === 'Edit') {
            action = 'edit';
            // Extract line from old_string match position
            line = (args.line as number) ?? 1;
          }

          if (file) {
            annotations.push({
              file,
              line,
              requestId: (event.request_id ?? event.requestId ?? '') as string,
              toolName,
              action,
              timestamp: typeof event.timestamp === 'number'
                ? new Date(event.timestamp * 1000).toISOString()
                : new Date().toISOString(),
              success: (data.success as boolean) ?? true,
            });
          }
        }
      }

      return { body: { annotations } };
    } catch (error) {
      console.error('[control-plane] Error getting trace annotations:', error);
      return { body: { annotations: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/goals/hierarchy
   * Get goal hierarchy tree
   */
  server.get('/control-plane/goals/hierarchy', async () => {
    try {
      if (!daemon.goalsRepo) {
        return { body: { goals: [] } };
      }

      // Get all goals
      const allGoals = await daemon.goalsRepo.findMany({ limit: 500 });

      // Build tree structure
      const rootGoals = allGoals.filter(g => !g.parent_id);

      interface GoalTreeNode {
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: number;
        deadline: Date | null;
        children: GoalTreeNode[];
      }

      const buildTree = (goal: typeof allGoals[0]): GoalTreeNode => ({
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        priority: goal.priority,
        deadline: goal.deadline,
        children: allGoals
          .filter(g => g.parent_id === goal.id)
          .map(buildTree),
      });

      return { body: { goals: rootGoals.map(buildTree) } };
    } catch (error) {
      console.error('[control-plane] Error getting goal hierarchy:', error);
      return { body: { goals: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/jobs/overview
   * Get job orchestration overview
   */
  server.get('/control-plane/jobs/overview', async () => {
    try {
      const tasks = await daemon.derivedTaskRepo?.findAll() ?? [];

      const jobsResult = await daemon.derivedJobRepo?.findRecent({ limit: 100 });
      const jobs = jobsResult?.items ?? [];

      // Compute stats
      const pendingJobs = jobs.filter(j => j.status === 'pending').length;
      const runningJobs = jobs.filter(j => j.status === 'running').length;
      const failedJobs = jobs.filter(j => j.status === 'failed').length;
      const completedJobs = jobs.filter(j => j.status === 'completed').length;

      const circuitOpenTasks = tasks.filter(t =>
        t.circuit_open_until && new Date(t.circuit_open_until) > new Date()
      );

      return {
        body: {
          stats: {
            totalTasks: tasks.length,
            enabledTasks: tasks.filter(t => t.enabled).length,
            circuitOpen: circuitOpenTasks.length,
            pendingJobs,
            runningJobs,
            failedJobs,
            completedJobs,
          },
          circuitOpenTasks: circuitOpenTasks.map(t => ({
            id: t.id,
            name: t.name,
            openUntil: t.circuit_open_until,
            lastError: t.last_error,
            consecutiveFailures: t.consecutive_failures,
          })),
          recentJobs: jobs.slice(0, 20).map(j => ({
            id: j.id,
            taskId: j.task_id,
            status: j.status,
            createdAt: j.created_at,
            completedAt: j.completed_at,
            lastError: j.last_error,
          })),
        },
      };
    } catch (error) {
      console.error('[control-plane] Error getting jobs overview:', error);
      return { body: { stats: {}, error: String(error) } };
    }
  });

  /**
   * GET /control-plane/decisions/search
   * Search decisions with advanced filtering
   */
  server.get('/control-plane/decisions/search', async (req) => {
    try {
      const query = req.query.q ?? '';
      const category = req.query.category;
      const limit = parseInt(req.query.limit ?? '50', 10);

      if (!daemon.decisionsRepo) {
        return { body: { decisions: [] } };
      }

      const results = await daemon.decisionsRepo.search(query, {
        category: category ?? undefined,
        limit,
      });

      return {
        body: {
          decisions: results,
          query,
          totalCount: results.length,
        },
      };
    } catch (error) {
      console.error('[control-plane] Error searching decisions:', error);
      return { body: { decisions: [], error: String(error) } };
    }
  });

  /**
   * GET /control-plane/token-usage
   * Get token usage metrics
   */
  server.get('/control-plane/token-usage', async (req) => {
    try {
      const sql = daemon.sql;
      const since = req.query.since;

      // Query token usage from session metadata
      // Note: This uses PostgreSQL JSONB syntax
      const result = since
        ? await sql<{ provider: string; model: string; total_tokens: string; session_count: string }[]>`
            SELECT
              metadata_json->>'provider' as provider,
              metadata_json->>'model' as model,
              COALESCE(SUM((metadata_json->>'total_tokens')::numeric), 0)::text as total_tokens,
              COUNT(*)::text as session_count
            FROM sessions
            WHERE created_at > ${since}::timestamp
            GROUP BY provider, model
            ORDER BY SUM((metadata_json->>'total_tokens')::numeric) DESC NULLS LAST
          `
        : await sql<{ provider: string; model: string; total_tokens: string; session_count: string }[]>`
            SELECT
              metadata_json->>'provider' as provider,
              metadata_json->>'model' as model,
              COALESCE(SUM((metadata_json->>'total_tokens')::numeric), 0)::text as total_tokens,
              COUNT(*)::text as session_count
            FROM sessions
            GROUP BY provider, model
            ORDER BY SUM((metadata_json->>'total_tokens')::numeric) DESC NULLS LAST
          `;

      return {
        body: {
          usage: result?.map(r => ({
            provider: r.provider ?? 'unknown',
            model: r.model ?? 'unknown',
            totalTokens: parseInt(r.total_tokens, 10) || 0,
            sessionCount: parseInt(r.session_count, 10) || 0,
          })) ?? [],
        },
      };
    } catch (error) {
      console.error('[control-plane] Error getting token usage:', error);
      return { body: { usage: [], error: String(error) } };
    }
  });
}
