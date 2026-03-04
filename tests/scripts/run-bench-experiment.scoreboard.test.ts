import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const scriptPath = join(repoRoot, 'scripts', 'run-bench-experiment.sh');
const runsRoot = join(repoRoot, '.lab', 'runs');

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('scripts/run-bench-experiment.sh scoreboard', () => {
  let runId = '';
  let runDir = '';

  beforeEach(() => {
    runId = `run_test_scoreboard_${Date.now()}_${randomBytes(4).toString('hex')}`;
    runDir = join(runsRoot, runId);
    mkdirSync(join(runDir, 'runtime'), { recursive: true });
    mkdirSync(join(runDir, 'facts'), { recursive: true });
  });

  afterEach(() => {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('treats outcome=failure as failed in variant summary', () => {
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
    } catch {
      // Local script depends on jq; skip assertion when jq is unavailable.
      return;
    }

    writeJson(join(runDir, 'runtime', 'run_control.json'), {
      schema_version: 'run_control_v2',
      run_id: runId,
      status: 'running',
      active_trials: {},
      updated_at: '2026-03-03T00:00:00Z',
    });
    writeJson(join(runDir, 'runtime', 'schedule_progress.json'), {
      schema_version: 'schedule_progress_v2',
      run_id: runId,
      total_slots: 5,
      next_schedule_index: 5,
      completed_slots: [{ schedule_index: 0 }, { schedule_index: 1 }, { schedule_index: 2 }, { schedule_index: 3 }, { schedule_index: 4 }],
      updated_at: '2026-03-03T00:00:00Z',
    });

    const trialRows = [
      { variant_id: 'codex_spark', outcome: 'failure' },
      { variant_id: 'codex_spark', outcome: 'failed' },
      { variant_id: 'codex_spark', outcome: 'error' },
      { variant_id: 'codex_spark', outcome: 'aborted' },
      { variant_id: 'codex_spark', outcome: 'success' },
    ];
    writeFileSync(
      join(runDir, 'facts', 'trials.jsonl'),
      `${trialRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );

    const output = execFileSync(
      'bash',
      [scriptPath, 'scoreboard', '--run-id', runId, '--once'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toMatch(/codex_spark:\s+total=5\s+success=1\s+failed=4/);
  });
});
