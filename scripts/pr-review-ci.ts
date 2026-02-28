#!/usr/bin/env bun

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { EntityGraph } from '../packages/plugins/entity-graph/src/index.ts';
import type { PRReview } from '../packages/plugins/entity-graph/src/pr-review/types.ts';

export const COMMENT_MARKER = '<!-- nova-pr-review -->';
const OUTPUT_DIR = '.artifacts/pr-review';

type Comment = {
  id: number;
  body: string;
  user?: { login?: string; type?: string };
};

export async function main(): Promise<void> {
  const {
    BASE_SHA,
    HEAD_SHA,
    ENTITY_GRAPH_DATABASE_URL,
    DATABASE_URL,
    PR_NUMBER,
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_API_URL,
    PR_REVIEW_MAX_DEPTH,
  } = process.env;

  const baseSha = BASE_SHA || resolveDefaultBaseSha();
  const headSha = HEAD_SHA || resolveDefaultHeadSha();
  const databaseUrl = ENTITY_GRAPH_DATABASE_URL || DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('Missing ENTITY_GRAPH_DATABASE_URL or DATABASE_URL env var');
  }

  const maxDepth = parsePositiveInt(PR_REVIEW_MAX_DEPTH, 2);
  const diffText = buildDiff(baseSha, headSha);
  const review = await runReview(databaseUrl, diffText, maxDepth);
  const markdown = formatReviewMarkdown(baseSha, headSha, maxDepth, review);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  await writeFile(`${OUTPUT_DIR}/pr-review.json`, JSON.stringify(review, null, 2), 'utf-8');
  await writeFile(`${OUTPUT_DIR}/pr-review.md`, markdown, 'utf-8');

  if (GITHUB_TOKEN && PR_NUMBER && GITHUB_REPOSITORY) {
    const apiBase = GITHUB_API_URL || 'https://api.github.com';
    try {
      await upsertPrComment(apiBase, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, markdown);
      console.log(`Posted PR review comment on #${PR_NUMBER}`);
    } catch (error) {
      if (isGithubPermissionError(error)) {
        console.warn(`[pr-review-ci] Skipping PR comment publish: ${String((error as Error).message ?? error)}`);
      } else {
        throw error;
      }
    }
  } else {
    console.log('Skipping PR comment publish (missing GITHUB_TOKEN/PR_NUMBER/GITHUB_REPOSITORY)');
  }
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildDiff(baseSha: string, headSha: string): string {
  const maxBuffer = 50 * 1024 * 1024;
  try {
    return execSync(`git diff --find-renames --unified=3 ${baseSha}...${headSha}`, {
      encoding: 'utf-8',
      maxBuffer,
    });
  } catch {
    return execSync(`git diff --find-renames --unified=3 ${baseSha} ${headSha}`, {
      encoding: 'utf-8',
      maxBuffer,
    });
  }
}

function runGit(command: string): string {
  return execSync(command, { encoding: 'utf-8' }).trim();
}

export function resolveDefaultBaseSha(): string {
  try {
    return runGit('git merge-base HEAD origin/main');
  } catch {
    try {
      return runGit('git rev-parse HEAD~1');
    } catch {
      return runGit('git rev-parse HEAD');
    }
  }
}

export function resolveDefaultHeadSha(): string {
  return runGit('git rev-parse HEAD');
}

export async function runReview(databaseUrl: string, diffText: string, maxDepth: number): Promise<PRReview> {
  const sql = postgres(databaseUrl, { max: 5, idle_timeout: 30, connect_timeout: 10 });
  try {
    const graph = new EntityGraph(sql as any, {
      sourceRoot: process.cwd(),
      include: ['**/*.{ts,tsx,js,jsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      startupScan: true,
    });
    await graph.initialize();
    await graph.waitForScan();
    return await graph.reviewDiff(diffText, maxDepth);
  } finally {
    await sql.end();
  }
}

export function formatReviewMarkdown(
  baseSha: string,
  headSha: string,
  maxDepth: number,
  review: PRReview,
): string {
  const critical = review.risks.filter(r => r.score >= 70);
  const warnings = review.risks.filter(r => r.score >= 40 && r.score < 70);
  const topRisks = review.risks.slice(0, 12);
  const changed = review.changedEntities.slice(0, 20);
  const deadCode = review.deadCode.slice(0, 20);

  const lines: string[] = [];
  lines.push(COMMENT_MARKER);
  lines.push('## Entity Graph PR Review');
  lines.push('');
  lines.push(`Compared \`${shortSha(baseSha)}...${shortSha(headSha)}\` with max depth \`${maxDepth}\`.`);
  lines.push('');
  lines.push(`Summary: ${review.summary}`);
  lines.push('');
  lines.push('### Counts');
  lines.push(`- Changed entities: ${review.changedEntities.length}`);
  lines.push(`- Blast radius (direct): ${review.blastRadius.direct.length}`);
  lines.push(`- Blast radius (transitive): ${review.blastRadius.transitive.length}`);
  lines.push(`- Risk signals: ${review.risks.length} (critical ${critical.length}, warning ${warnings.length})`);
  lines.push(`- Contract impact gaps: ${review.impactGaps.length}`);
  lines.push(`- Dead code candidates: ${review.deadCode.length}`);

  if (topRisks.length > 0) {
    lines.push('');
    lines.push('### Top Risks');
    lines.push('| Score | Entity | File | Key factor |');
    lines.push('|---:|---|---|---|');
    for (const risk of topRisks) {
      const factor = sanitizeCell(risk.factors[0] || '');
      lines.push(`| ${risk.score} | \`${sanitizeCell(risk.entity.name)}\` | \`${sanitizeCell(risk.entity.filepath)}\` | ${factor} |`);
    }
  }

  if (changed.length > 0) {
    lines.push('');
    lines.push('### Changed Entities');
    for (const item of changed) {
      lines.push(`- \`${item.changeKind}\` \`${item.entity.name}\` in \`${item.entity.filepath}\``);
    }
    if (review.changedEntities.length > changed.length) {
      lines.push(`- ...and ${review.changedEntities.length - changed.length} more`);
    }
  }

  if (deadCode.length > 0) {
    lines.push('');
    lines.push('### Dead Code Candidates');
    for (const entity of deadCode) {
      lines.push(`- \`${entity.name}\` in \`${entity.filepath}\``);
    }
    if (review.deadCode.length > deadCode.length) {
      lines.push(`- ...and ${review.deadCode.length - deadCode.length} more`);
    }
  }

  if (review.impactGaps.length > 0) {
    lines.push('');
    lines.push('### Unresolved Contract Dependents');
    for (const gap of review.impactGaps.slice(0, 12)) {
      lines.push(
        `- \`${gap.seedChangeKind}\` on \`${gap.seed.name}\` in \`${gap.seed.filepath}\` ` +
        `has ${gap.unresolvedDependents.length}/${gap.directDependents.length} direct dependents not updated: ` +
        gap.unresolvedDependents.slice(0, 5).map(dep => `\`${sanitizeCell(dep.name)}\``).join(', '),
      );
    }
    if (review.impactGaps.length > 12) {
      lines.push(`- ...and ${review.impactGaps.length - 12} more`);
    }
  }

  const markdown = lines.join('\n');
  return markdown.length > 60000
    ? `${markdown.slice(0, 60000)}\n\n_Comment truncated due to size._`
    : markdown;
}

export function sanitizeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export async function upsertPrComment(
  apiBase: string,
  token: string,
  repo: string,
  prNumber: string,
  body: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const commentsUrl = `${apiBase}/repos/${repo}/issues/${prNumber}/comments`;
  const existing = await findExistingComment(commentsUrl, headers);

  if (existing) {
    const updateUrl = `${apiBase}/repos/${repo}/issues/comments/${existing.id}`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!updateResponse.ok) {
      throw new Error(`Failed to update PR comment: ${updateResponse.status} ${await updateResponse.text()}`);
    }
    return;
  }

  const createResponse = await fetch(commentsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!createResponse.ok) {
    throw new Error(`Failed to create PR comment: ${createResponse.status} ${await createResponse.text()}`);
  }
}

export async function findExistingComment(
  commentsUrl: string,
  headers: Record<string, string>,
): Promise<Comment | undefined> {
  const perPage = 100;
  let page = 1;
  const maxPages = 10;
  while (page <= maxPages) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    });
    const pageUrl = `${commentsUrl}?${params.toString()}`;
    const listResponse = await fetch(pageUrl, { headers });
    if (!listResponse.ok) {
      throw new Error(`Failed to list PR comments: ${listResponse.status} ${await listResponse.text()}`);
    }
    const comments = (await listResponse.json()) as Comment[];
    const existing = comments.find(c => c.body?.includes(COMMENT_MARKER));
    if (existing) {
      return existing;
    }
    if (comments.length < perPage) {
      break;
    }
    page += 1;
  }
  return undefined;
}

export function isGithubPermissionError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /Failed to (list PR comments|update PR comment|create PR comment):\s*(401|403|404)\b/.test(message);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[pr-review-ci] Failed:', error);
    process.exit(1);
  });
}
