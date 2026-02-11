import fs from 'fs/promises';
import path from 'path';
import type { VerificationProgram } from './types.js';

export interface EvidenceRunOptions {
  output_dir: string;
  run_id: string;
  seed: number;
}

export interface EvidenceLayoutResult {
  run_manifest_path: string;
  invariant_directories: string[];
}

export async function prepareEvidenceLayout(
  vp: VerificationProgram,
  options: EvidenceRunOptions
): Promise<EvidenceLayoutResult> {
  const evidenceRoot = path.join(options.output_dir, 'evidence');
  await fs.mkdir(evidenceRoot, { recursive: true });

  const runManifestPath = path.join(evidenceRoot, 'run.json');
  await fs.writeFile(runManifestPath, JSON.stringify({
    uow_id: vp.uow_id,
    run_id: options.run_id,
    seed: options.seed,
    generated_at: new Date().toISOString(),
    vp_version: vp.vp_version,
  }, null, 2), 'utf8');

  const invariantDirs: string[] = [];
  for (const invariant of vp.invariants) {
    const invDir = path.join(evidenceRoot, invariant.inv_id.toLowerCase());
    const artifactsDir = path.join(invDir, 'artifacts');
    const diffsDir = path.join(invDir, 'diffs');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.mkdir(diffsDir, { recursive: true });

    await fs.writeFile(path.join(invDir, 'run.json'), JSON.stringify({
      inv_id: invariant.inv_id,
      compile_status: invariant.compile_status,
      assumptions: invariant.assumptions,
      strategy_id: invariant.verification_plan.strategy_id,
    }, null, 2), 'utf8');

    await fs.writeFile(path.join(invDir, 'trace.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(invDir, 'stdout.txt'), '', 'utf8');
    await fs.writeFile(path.join(invDir, 'stderr.txt'), '', 'utf8');

    invariantDirs.push(invDir);
  }

  return {
    run_manifest_path: runManifestPath,
    invariant_directories: invariantDirs,
  };
}
