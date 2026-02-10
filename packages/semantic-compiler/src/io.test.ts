import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'bun:test';
import { compileVerificationProgram } from './compiler.js';
import { generateHarnessArtifacts } from './harness.js';
import { prepareEvidenceLayout } from './evidence.js';
import { emitVerdictArtifacts } from './report.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

describe('harness/evidence/report I/O', () => {
  test('writes harness artifacts and manifest', async () => {
    const outDir = await makeTempDir('semantic-compiler-harness');
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0014',
      system_surface: {
        services: ['web', 'auth'],
        storage: ['postgres'],
        ui_surfaces: ['login'],
        external_dependencies: ['oauth stub'],
        main_flows: ['login and restore session'],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'User can login, restart app, and remain signed in.',
        },
      ],
    });

    const result = await generateHarnessArtifacts(vp, { output_dir: outDir });
    expect(result.artifacts.length).toBeGreaterThan(0);

    const manifestPath = path.join(outDir, result.manifest_path);
    const stat = await fs.stat(manifestPath);
    expect(stat.isFile()).toBe(true);
  });

  test('creates evidence directory layout', async () => {
    const outDir = await makeTempDir('semantic-compiler-evidence');
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0015',
      system_surface: {
        services: ['api'],
        storage: [],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: ['healthcheck'],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'GET /health returns HTTP 200.',
        },
      ],
    });

    const layout = await prepareEvidenceLayout(vp, {
      output_dir: outDir,
      run_id: 'RUN-001',
      seed: 42,
    });

    const runManifest = await fs.readFile(layout.run_manifest_path, 'utf8');
    expect(runManifest.includes('"run_id": "RUN-001"')).toBe(true);
    expect(layout.invariant_directories).toHaveLength(1);

    const invDir = layout.invariant_directories[0];
    const traceStat = await fs.stat(path.join(invDir, 'trace.jsonl'));
    expect(traceStat.isFile()).toBe(true);
  });

  test('emits verdict json and markdown summary', async () => {
    const outDir = await makeTempDir('semantic-compiler-report');
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0016',
      system_surface: {
        services: ['api'],
        storage: [],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: ['healthcheck'],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'GET /health returns HTTP 200.',
        },
      ],
    });

    const emitted = await emitVerdictArtifacts(
      vp,
      [
        {
          inv_id: 'INV-001',
          verdict: 'pass',
          evidence_path: 'evidence/inv-001',
        },
      ],
      { output_dir: outDir }
    );

    const jsonStat = await fs.stat(emitted.json_path);
    const summaryStat = await fs.stat(emitted.summary_path);
    expect(jsonStat.isFile()).toBe(true);
    expect(summaryStat.isFile()).toBe(true);
  });
});
