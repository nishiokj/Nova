import fs from 'fs/promises';
import path from 'path';
import type { VerificationProgram } from './types.js';

export interface HarnessArtifact {
  type: 'playwright_spec' | 'docker_compose' | 'trace_vocab' | 'manifest';
  path: string;
  invariant_id?: string;
}

export interface HarnessGenerationOptions {
  output_dir: string;
  write_files?: boolean;
}

export interface HarnessGenerationResult {
  artifacts: HarnessArtifact[];
  manifest_path: string;
}

function wantsPlaywright(vpInvariant: VerificationProgram['invariants'][number]): boolean {
  return vpInvariant.verification_plan.steps.some((step) => step.spec.toLowerCase().includes('playwright'));
}

function wantsDocker(vpInvariant: VerificationProgram['invariants'][number]): boolean {
  return vpInvariant.verification_plan.steps.some((step) => {
    const normalized = step.spec.toLowerCase();
    return normalized.includes('docker compose') || normalized.includes('restart(app)') || normalized.includes('restart');
  });
}

function renderPlaywrightSpec(invId: string, objective: string): string {
  return `import { test, expect } from '@playwright/test';

test('${invId}', async ({ page }) => {
  // Generated from VP invariant: ${objective}
  // TODO: replace with deterministic scenario setup and assertions.
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
});
`;
}

function renderDockerComposeTemplate(): string {
  return `services:
  app:
    image: your-app:latest
  db:
    image: postgres:16
  oauth_stub:
    image: ghcr.io/example/oauth-stub:latest
`;
}

const TRACE_VOCABULARY = {
  events: [
    'ui.click',
    'auth.login.start',
    'auth.login.end',
    'session.persisted',
    'session.restored',
    'agent.response.emitted',
    'process.start',
    'process.stop',
  ],
};

export async function generateHarnessArtifacts(
  vp: VerificationProgram,
  options: HarnessGenerationOptions
): Promise<HarnessGenerationResult> {
  const writeFiles = options.write_files !== false;
  const harnessRoot = path.join(options.output_dir, 'harness');
  const artifacts: HarnessArtifact[] = [];

  if (writeFiles) {
    await fs.mkdir(harnessRoot, { recursive: true });
  }

  for (const inv of vp.invariants) {
    if (wantsPlaywright(inv)) {
      const relPath = path.join('harness', 'playwright', `${inv.inv_id.toLowerCase()}.spec.ts`);
      if (writeFiles) {
        const abs = path.join(options.output_dir, relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, renderPlaywrightSpec(inv.inv_id, inv.refined.intent), 'utf8');
      }
      artifacts.push({ type: 'playwright_spec', path: relPath, invariant_id: inv.inv_id });
    }

    if (wantsDocker(inv)) {
      const relPath = path.join('harness', 'docker', `${inv.inv_id.toLowerCase()}.compose.yml`);
      if (writeFiles) {
        const abs = path.join(options.output_dir, relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, renderDockerComposeTemplate(), 'utf8');
      }
      artifacts.push({ type: 'docker_compose', path: relPath, invariant_id: inv.inv_id });
    }
  }

  const traceVocabPath = path.join('harness', 'trace-vocabulary.json');
  if (writeFiles) {
    const abs = path.join(options.output_dir, traceVocabPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(TRACE_VOCABULARY, null, 2), 'utf8');
  }
  artifacts.push({ type: 'trace_vocab', path: traceVocabPath });

  const manifestPath = path.join('harness', 'manifest.json');
  if (writeFiles) {
    const abs = path.join(options.output_dir, manifestPath);
    await fs.writeFile(abs, JSON.stringify({
      uow_id: vp.uow_id,
      generated_at: new Date().toISOString(),
      artifacts,
    }, null, 2), 'utf8');
  }
  artifacts.push({ type: 'manifest', path: manifestPath });

  return {
    artifacts,
    manifest_path: manifestPath,
  };
}
