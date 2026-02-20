/**
 * Semantic Compiler Ability Tests
 *
 * These are NOT sanity tests. They exercise whether the compiler actually
 * produces useful output for realistic, challenging invariant specifications.
 *
 * Dimensions tested:
 *   1. Strategy selection accuracy under ambiguity
 *   2. Refinement quality — actionable operational definitions
 *   3. Question quality — precision of clarification requests
 *   4. Finding detection — catching real problems in specs
 *   5. Multi-invariant coherence — cross-invariant consistency
 *   6. Full pipeline — compile → harness → evidence → report
 *   7. Edge case resilience
 */
import { compileVerificationProgram } from 'semantic-compiler/compiler.js';
import { vpToWorkItemSpecs, buildUserReviewPrompts } from 'semantic-compiler/adapters.js';
import { generateHarnessArtifacts } from 'semantic-compiler/harness.js';
import { prepareEvidenceLayout } from 'semantic-compiler/evidence.js';
import { emitVerdictArtifacts } from 'semantic-compiler/report.js';
import { selectBestStrategy, DEFAULT_STRATEGY_PLUGINS } from 'semantic-compiler/plugins.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CompileRequest, SystemSurface, InvariantVerdict } from 'semantic-compiler/types.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `sc-ability-${prefix}-`));
}

// ---------------------------------------------------------------------------
// Realistic system surfaces
// ---------------------------------------------------------------------------

const ecommerceSurface: SystemSurface = {
  services: ['web-frontend', 'api-gateway', 'cart-service', 'payment-service', 'inventory-service', 'notification-service'],
  storage: ['postgres orders_db', 'redis cart_cache', 'elasticsearch product_index'],
  ui_surfaces: ['product listing page', 'product detail page', 'shopping cart', 'checkout flow', 'order confirmation'],
  external_dependencies: ['stripe payment gateway', 'sendgrid email', 'warehouse fulfillment API'],
  main_flows: ['browse → add to cart → checkout → payment → order confirmation', 'search → filter → compare → purchase'],
};

const saasAuthSurface: SystemSurface = {
  services: ['auth-service', 'user-management', 'rbac-service', 'audit-logger', 'web-app'],
  storage: ['postgres auth_db', 'redis session_store', 'postgres audit_log'],
  ui_surfaces: ['login page', 'registration page', 'MFA setup', 'admin dashboard', 'user profile'],
  external_dependencies: ['google oauth provider', 'twilio SMS', 'datadog APM'],
  main_flows: ['registration → email verification → first login → MFA setup', 'login → MFA → dashboard', 'admin user management → role assignment'],
};

const realtimeSurface: SystemSurface = {
  services: ['websocket-gateway', 'message-broker', 'presence-service', 'notification-service', 'api-server'],
  storage: ['postgres messages_db', 'redis presence_cache', 'redis pubsub'],
  ui_surfaces: ['chat room', 'member list', 'message thread', 'notification panel'],
  external_dependencies: ['push notification service', 'CDN for media'],
  main_flows: ['connect → join room → send message → receive confirmation', 'user goes offline → presence update → reconnect → message sync'],
};

// ---------------------------------------------------------------------------
// 1. Strategy Selection Under Ambiguity
// ---------------------------------------------------------------------------

describe('strategy selection accuracy', () => {
  test('disambiguates UI-heavy invariant from API-heavy when both have signals', () => {
    // "click" is UI signal, "/" is API signal — the UI signal should win because it's more specific
    const uiResult = selectBestStrategy({
      invariant: { text: 'User clicks the checkout button and sees the order confirmation screen within 2 seconds.' },
      system_surface: ecommerceSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    expect(uiResult.plugin?.id).toBe('ui_scenario');

    const apiResult = selectBestStrategy({
      invariant: { text: 'POST /api/orders returns 201 with order_id and delivery estimate in the response body.' },
      system_surface: ecommerceSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    expect(apiResult.plugin?.id).toBe('api_scenario');
  });

  test('picks restart_persistence over UI when restart is the core concern', () => {
    // Contains both "login" (UI signal) and "restart" — restart should dominate since its score is 0.95
    const result = selectBestStrategy({
      invariant: { text: 'After a user logs in and the server process restarts, the user session persists without re-authentication.' },
      system_surface: saasAuthSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    expect(result.plugin?.id).toBe('restart_persistence');
    expect(result.support.score).toBeGreaterThanOrEqual(0.9);
  });

  test('picks trace_checker for temporal/event-stream invariants', () => {
    const result = selectBestStrategy({
      invariant: { text: 'The system never emits a payment_charged event without a preceding cart_validated event in the same trace.' },
      system_surface: ecommerceSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    expect(result.plugin?.id).toBe('trace_checker');
  });

  test('returns null strategy for invariants with no recognizable verification signal', () => {
    const result = selectBestStrategy({
      invariant: { text: 'The architecture should be scalable and maintainable.' },
      system_surface: ecommerceSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    // This is a pure quality attribute — no concrete verification strategy
    expect(result.support.score).toBe(0);
    expect(result.plugin).toBeNull();
  });

  test('prefers higher-confidence strategy when multiple match', () => {
    // "remain signed in" triggers restart_persistence (0.95), "login" triggers ui_scenario (0.8)
    const result = selectBestStrategy({
      invariant: { text: 'User can login via the UI and remain signed in after app restart.' },
      system_surface: saasAuthSurface,
    }, DEFAULT_STRATEGY_PLUGINS);

    expect(result.plugin?.id).toBe('restart_persistence');
  });
});

// ---------------------------------------------------------------------------
// 2. Refinement Quality — Are operational definitions actionable?
// ---------------------------------------------------------------------------

describe('refinement quality', () => {
  test('produces non-generic operational definitions for restart persistence', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-REFINE-001',
      system_surface: saasAuthSurface,
      invariants: [{ text: 'After Google OAuth login and app restart, the user remains authenticated.' }],
    });

    const inv = vp.invariants[0];
    expect(inv.refined.operational_definition.length).toBeGreaterThanOrEqual(2);
    // Operational definitions should reference concrete actions, not vague platitudes
    const opDefText = inv.refined.operational_definition.join(' ').toLowerCase();
    expect(opDefText).toMatch(/auth|login|restart|session/);
  });

  test('scope references actual system surface components, not invented ones', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-REFINE-002',
      system_surface: ecommerceSurface,
      invariants: [{ text: 'GET /api/products returns HTTP 200 with a valid JSON array.' }],
    });

    const inv = vp.invariants[0];
    // Scope should pull from actual system surface, not hallucinate services
    for (const scopeItem of inv.refined.scope) {
      const combined = [
        ...ecommerceSurface.services,
        ...ecommerceSurface.storage,
        ...ecommerceSurface.ui_surfaces,
        ...ecommerceSurface.external_dependencies,
        ...ecommerceSurface.main_flows,
      ].map(s => s.toLowerCase());

      // Either it matches a real surface component, or it's a fallback keyword
      const isFromSurface = combined.some(c => c.includes(scopeItem.toLowerCase()) || scopeItem.toLowerCase().includes(c));
      const isFallbackKeyword = ['api', 'service', 'http', 'backend'].includes(scopeItem.toLowerCase());
      expect(isFromSurface || isFallbackKeyword).toBe(true);
    }
  });

  test('verification plan steps are typed and non-empty for compiled invariants', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-REFINE-003',
      system_surface: realtimeSurface,
      invariants: [
        { text: 'The system never delivers a message to a user who has left the room.' },
        { text: 'When a user reconnects, all missed messages are delivered in order.' },
      ],
    });

    for (const inv of vp.invariants) {
      if (inv.compile_status === 'failed') continue;
      expect(inv.verification_plan.steps.length).toBeGreaterThan(0);
      for (const step of inv.verification_plan.steps) {
        expect(['harness_setup', 'action', 'assert', 'trace_check']).toContain(step.kind);
        expect(step.spec.length).toBeGreaterThan(5);
      }
    }
  });

  test('assumptions list is specific to the invariant, not boilerplate', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-REFINE-004',
      system_surface: ecommerceSurface,
      invariants: [
        { text: 'POST /api/checkout processes payment and creates an order within 5 seconds.' },
      ],
    });

    const inv = vp.invariants[0];
    expect(inv.assumptions.length).toBeGreaterThan(0);
    // Assumptions should mention something specific to the domain
    const assumptionText = inv.assumptions.join(' ').toLowerCase();
    expect(assumptionText.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 3. Question Quality — Precision of Clarification Requests
// ---------------------------------------------------------------------------

describe('question quality', () => {
  test('asks targeted restart semantics question for ambiguous restart language', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-Q-001',
      system_surface: saasAuthSurface,
      invariants: [{ text: 'User sessions survive restart and users remain signed in.' }],
    });

    const inv = vp.invariants[0];
    expect(inv.compile_status).toBe('needs_user_answer');
    const questions = inv.questions ?? [];

    // Should ask about what "restart" means
    const restartQ = questions.find(q => q.question.toLowerCase().includes('restart'));
    expect(restartQ).toBeDefined();
    expect(restartQ!.options).toBeDefined();
    expect(restartQ!.options!.length).toBeGreaterThanOrEqual(2);

    // Should ask about what "signed in" means
    const authQ = questions.find(q => q.question.toLowerCase().includes('signed in'));
    expect(authQ).toBeDefined();
  });

  test('does NOT ask clarification questions for fully-specified API invariants', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-Q-002',
      system_surface: ecommerceSurface,
      invariants: [{ text: 'GET /api/products returns HTTP 200 with Content-Type application/json.' }],
    });

    const inv = vp.invariants[0];
    // Fully specified — no ambiguity to clarify
    expect(inv.compile_status).toBe('compiled');
    expect(inv.questions ?? []).toHaveLength(0);
  });

  test('flags unverifiable qualitative terms — but KNOWN GAP: no questions when no strategy matches', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-Q-003',
      system_surface: ecommerceSurface,
      invariants: [{ text: 'The checkout flow should be fast and seamless for all users.' }],
    });

    const inv = vp.invariants[0];

    // Compile findings DO detect the unverifiable terms
    const termFindings = vp.compile_findings.filter(f => f.code === 'unverifiable_term');
    expect(termFindings.length).toBeGreaterThanOrEqual(2); // "fast" and "seamless"

    // KNOWN GAP: since no strategy matches ("checkout flow" has no UI/API/restart/trace keywords),
    // the invariant fails with strategy_unavailable BEFORE targetedQuestions() is ever called.
    // This means the user gets a "failed" invariant with no clarification questions to help them
    // reformulate it into something compilable.
    expect(inv.compile_status).toBe('failed');
    expect(inv.questions ?? []).toHaveLength(0);
    expect(vp.compile_findings.some(f => f.code === 'strategy_unavailable')).toBe(true);
  });

  test('deduplicates questions across multiple invariants referencing same ambiguity', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-Q-004',
      system_surface: saasAuthSurface,
      invariants: [
        { text: 'After restart, the user remains signed in on the dashboard.' },
        { text: 'After restart, the user remains signed in on the profile page.' },
      ],
    });

    // Both invariants ask about "restart" — but within each invariant, questions should be unique
    for (const inv of vp.invariants) {
      const questions = inv.questions ?? [];
      const ids = questions.map(q => q.question_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('questions have rationale explaining why they are asked', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-Q-005',
      system_surface: saasAuthSurface,
      invariants: [{ text: 'User can login via the click-through onboarding in 3 clicks and remain signed in after restart.' }],
    });

    const inv = vp.invariants[0];
    const questions = inv.questions ?? [];
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.rationale.length).toBeGreaterThan(10);
      expect(q.rationale).not.toBe(q.question); // Rationale is distinct from question
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Finding Detection — Catching Real Problems
// ---------------------------------------------------------------------------

describe('finding detection', () => {
  test('detects contradiction between invariants', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-FIND-001',
      system_surface: ecommerceSurface,
      invariants: [
        { text: 'No interface changes should be required for this release.' },
        { text: 'A new required param must be added to the checkout endpoint.' },
      ],
    });

    const contradictions = vp.compile_findings.filter(f => f.code === 'contradiction');
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    // Contradiction should fail all invariants
    for (const inv of vp.invariants) {
      expect(inv.compile_status).toBe('failed');
    }
  });

  test('reports missing services as global error preventing compilation', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-FIND-002',
      system_surface: {
        services: [],
        storage: ['postgres'],
        ui_surfaces: ['login page'],
        external_dependencies: [],
        main_flows: [],
      },
      invariants: [{ text: 'User can login successfully.' }],
    });

    const surfaceErrors = vp.compile_findings.filter(f => f.code === 'missing_system_surface');
    expect(surfaceErrors.length).toBeGreaterThanOrEqual(1);
    expect(vp.invariants[0].compile_status).toBe('failed');
  });

  test('finding IDs are globally unique across all findings', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-FIND-003',
      system_surface: ecommerceSurface,
      invariants: [
        { text: 'The checkout flow should be fast.' },
        { text: 'The search should be intuitive and robust.' },
        { text: 'Cart operations must never fail silently.' },
      ],
    });

    const ids = vp.compile_findings.map(f => f.finding_id);
    expect(new Set(ids).size).toBe(ids.length);
    // All IDs follow FND-XXX pattern
    for (const id of ids) {
      expect(id).toMatch(/^FND-\d{3}$/);
    }
  });

  test('correctly attributes invariant-level findings to the right invariant', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-FIND-004',
      system_surface: ecommerceSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'GET /health returns 200.' },
        { inv_id: 'INV-002', text: 'Checkout should be fast and seamless.' },
      ],
    });

    const inv1Findings = vp.compile_findings.filter(f => f.invariant_id === 'INV-001');
    const inv2Findings = vp.compile_findings.filter(f => f.invariant_id === 'INV-002');

    // INV-001 is clean — no unverifiable terms
    expect(inv1Findings.filter(f => f.code === 'unverifiable_term')).toHaveLength(0);
    // INV-002 has "fast" and "seamless"
    expect(inv2Findings.filter(f => f.code === 'unverifiable_term').length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-Invariant Coherence
// ---------------------------------------------------------------------------

describe('multi-invariant coherence', () => {
  test('compiles mixed-strategy invariant set without cross-contamination', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-MULTI-001',
      system_surface: saasAuthSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'GET /api/users returns HTTP 200 with user list.' },
        { inv_id: 'INV-002', text: 'User clicks login button and sees the dashboard.' },
        { inv_id: 'INV-003', text: 'Session persists after app restart without re-login.' },
        { inv_id: 'INV-004', text: 'The system never allows two concurrent sessions for the same user.' },
      ],
    });

    expect(vp.invariants).toHaveLength(4);

    // Each gets the right strategy
    expect(vp.invariants[0].verification_plan.strategy_id).toBe('api_scenario');
    expect(vp.invariants[1].verification_plan.strategy_id).toBe('ui_scenario');
    expect(vp.invariants[2].verification_plan.strategy_id).toBe('restart_persistence');
    expect(vp.invariants[3].verification_plan.strategy_id).toBe('trace_checker');

    // Each has distinct verification steps — not copy-pasted
    const stepSets = vp.invariants.map(inv =>
      inv.verification_plan.steps.map(s => s.spec).join('|')
    );
    const uniqueStepSets = new Set(stepSets);
    expect(uniqueStepSets.size).toBe(4);
  });

  test('work item specs form valid dependency DAG', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-MULTI-002',
      system_surface: saasAuthSurface,
      invariants: [
        { text: 'User can login via the UI and remain signed in after restart.' },
        { text: 'GET /api/me returns 200 when authenticated.' },
      ],
    });

    const specs = vpToWorkItemSpecs(vp);
    const ids = new Set(specs.map(s => s.id));

    // All dependency references exist
    for (const spec of specs) {
      for (const dep of spec.dependencies ?? []) {
        expect(ids.has(dep)).toBe(true);
      }
    }

    // No self-references
    for (const spec of specs) {
      expect(spec.dependencies ?? []).not.toContain(spec.id);
    }

    // emit_verdict depends on all verify_* tasks
    const verdictSpec = specs.find(s => s.id === 'emit_verdict');
    if (verdictSpec) {
      const verifySpecs = specs.filter(s => s.id?.startsWith('verify_'));
      for (const vs of verifySpecs) {
        expect(verdictSpec.dependencies).toContain(vs.id);
      }
    }
  });

  test('user review prompts cover all invariants with questions', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-MULTI-003',
      system_surface: saasAuthSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'After restart, the user remains signed in on the dashboard.' },
        { inv_id: 'INV-002', text: 'GET /health returns 200.' },
        { inv_id: 'INV-003', text: 'After restart, admin sessions persist across server reboots.' },
      ],
    });

    const prompts = buildUserReviewPrompts(vp);
    const invariantsWithQuestions = vp.invariants.filter(inv => (inv.questions?.length ?? 0) > 0);

    // Every invariant with questions should have at least one prompt
    for (const inv of invariantsWithQuestions) {
      const relatedPrompts = prompts.filter(p => p.context.includes(inv.inv_id));
      expect(relatedPrompts.length).toBeGreaterThan(0);
    }

    // INV-002 (clean API check) should have no prompts
    const inv002Prompts = prompts.filter(p => p.context.includes('INV-002'));
    expect(inv002Prompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Full Pipeline — compile → harness → evidence → report
// ---------------------------------------------------------------------------

describe('full pipeline end-to-end', () => {
  test('compile → harness artifacts for restart_persistence invariant', async () => {
    const outDir = await makeTempDir('pipeline-restart');

    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-PIPE-001',
      system_surface: saasAuthSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'After Google OAuth login and app restart, user session persists.' },
      ],
    });

    const harness = await generateHarnessArtifacts(vp, { output_dir: outDir });

    // Should produce both playwright spec AND docker compose (restart needs both)
    const playwrightArtifacts = harness.artifacts.filter(a => a.type === 'playwright_spec');
    const dockerArtifacts = harness.artifacts.filter(a => a.type === 'docker_compose');
    expect(playwrightArtifacts.length).toBeGreaterThanOrEqual(1);
    expect(dockerArtifacts.length).toBeGreaterThanOrEqual(1);

    // Verify files actually exist on disk
    for (const artifact of [...playwrightArtifacts, ...dockerArtifacts]) {
      const stat = await fs.stat(path.join(outDir, artifact.path));
      expect(stat.isFile()).toBe(true);
    }
  });

  test('compile → evidence layout creates proper directory structure', async () => {
    const outDir = await makeTempDir('pipeline-evidence');

    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-PIPE-002',
      system_surface: ecommerceSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'GET /api/products returns HTTP 200.' },
        { inv_id: 'INV-002', text: 'POST /api/orders creates an order and returns 201.' },
      ],
    });

    const evidence = await prepareEvidenceLayout(vp, {
      output_dir: outDir,
      run_id: 'ABILITY-RUN-001',
      seed: 42,
    });

    expect(evidence.invariant_directories).toHaveLength(2);

    // Each invariant directory has the required structure
    for (const invDir of evidence.invariant_directories) {
      const runJson = JSON.parse(await fs.readFile(path.join(invDir, 'run.json'), 'utf8'));
      expect(runJson.inv_id).toBeDefined();
      expect(runJson.strategy_id).toBeDefined();

      // trace.jsonl, stdout.txt, stderr.txt exist
      await fs.stat(path.join(invDir, 'trace.jsonl'));
      await fs.stat(path.join(invDir, 'stdout.txt'));
      await fs.stat(path.join(invDir, 'stderr.txt'));

      // Subdirectories exist
      await fs.stat(path.join(invDir, 'artifacts'));
      await fs.stat(path.join(invDir, 'diffs'));
    }

    // Run manifest contains correct metadata
    const runManifest = JSON.parse(await fs.readFile(evidence.run_manifest_path, 'utf8'));
    expect(runManifest.run_id).toBe('ABILITY-RUN-001');
    expect(runManifest.seed).toBe(42);
  });

  test('compile → report produces actionable verdict summary', async () => {
    const outDir = await makeTempDir('pipeline-report');

    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-PIPE-003',
      system_surface: ecommerceSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'GET /api/products returns HTTP 200.' },
        { inv_id: 'INV-002', text: 'Cart total reflects item prices multiplied by quantity.' },
        { inv_id: 'INV-003', text: 'Payment gateway timeout results in order status "pending".' },
      ],
    });

    const verdicts: InvariantVerdict[] = [
      { inv_id: 'INV-001', verdict: 'pass', evidence_path: 'evidence/inv-001' },
      { inv_id: 'INV-002', verdict: 'fail', evidence_path: 'evidence/inv-002', counterexample: 'quantity=0 yields NaN total' },
      { inv_id: 'INV-003', verdict: 'error', evidence_path: 'evidence/inv-003', notes: 'Payment stub did not simulate timeout' },
    ];

    const report = await emitVerdictArtifacts(vp, verdicts, { output_dir: outDir });

    // JSON report has all verdicts
    const jsonReport = JSON.parse(await fs.readFile(report.json_path, 'utf8'));
    expect(jsonReport.invariant_results).toHaveLength(3);
    expect(jsonReport.invariant_results[0].verdict).toBe('pass');
    expect(jsonReport.invariant_results[1].verdict).toBe('fail');

    // Summary markdown includes counterexample for failed invariant
    const summary = await fs.readFile(report.summary_path, 'utf8');
    expect(summary).toContain('INV-001');
    expect(summary).toContain('PASS');
    expect(summary).toContain('INV-002');
    expect(summary).toContain('FAIL');
    expect(summary).toContain('NaN total');
    expect(summary).toContain('INV-003');
    expect(summary).toContain('ERROR');
  });

  test('full pipeline with mixed verdicts produces complete work item DAG', async () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-PIPE-004',
      system_surface: saasAuthSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'GET /api/users returns HTTP 200 for authenticated admin.' },
        { inv_id: 'INV-002', text: 'User clicks login and sees dashboard after MFA.' },
        { inv_id: 'INV-003', text: 'Session persists after app restart.' },
      ],
    });

    const specs = vpToWorkItemSpecs(vp);

    // Should have: review_gate (if questions) + verify tasks + emit_verdict
    const verifyTasks = specs.filter(s => s.id?.startsWith('verify_'));
    const emitTask = specs.find(s => s.id === 'emit_verdict');

    // At least the non-failed invariants get verify tasks
    const compiledCount = vp.invariants.filter(inv => inv.compile_status !== 'failed').length;
    expect(verifyTasks).toHaveLength(compiledCount);

    if (compiledCount > 0) {
      expect(emitTask).toBeDefined();
      // Each verify task has an agent assigned
      for (const task of verifyTasks) {
        expect(task.agent).toBe('test-runner');
      }
      // emit_verdict uses coder agent
      expect(emitTask!.agent).toBe('coder');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Edge Cases & Resilience
// ---------------------------------------------------------------------------

describe('edge case resilience', () => {
  test('handles very long invariant text without crashing', () => {
    const longText = 'When the user ' + 'performs an action and '.repeat(100) + 'clicks the submit button, the form submits.';
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-001',
      system_surface: ecommerceSurface,
      invariants: [{ text: longText }],
    });

    expect(vp.invariants).toHaveLength(1);
    expect(vp.invariants[0].original_text).toBe(longText);
    // Should still compile — just verbose
    expect(['compiled', 'needs_user_answer']).toContain(vp.invariants[0].compile_status);
  });

  test('handles 20+ invariants without performance degradation or crashes', () => {
    const invariants = Array.from({ length: 20 }, (_, i) => ({
      text: `GET /api/resource-${i} returns HTTP 200 with valid response body.`,
    }));

    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-002',
      system_surface: ecommerceSurface,
      invariants,
    });

    expect(vp.invariants).toHaveLength(20);
    // All should compile since they're clean API invariants
    for (const inv of vp.invariants) {
      expect(inv.compile_status).toBe('compiled');
    }
    // Each gets a unique ID
    const ids = new Set(vp.invariants.map(inv => inv.inv_id));
    expect(ids.size).toBe(20);
  });

  test('handles invariants with special characters and unicode', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-003',
      system_surface: ecommerceSurface,
      invariants: [
        { text: 'GET /api/products?q=café&price>100 returns filtered results.' },
        { text: 'User searches for "日本語" and gets localized results.' },
      ],
    });

    expect(vp.invariants).toHaveLength(2);
    // Should not crash on unicode or special chars
    for (const inv of vp.invariants) {
      expect(inv.original_text.length).toBeGreaterThan(0);
    }
  });

  test('handles single-word invariant gracefully', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-004',
      system_surface: ecommerceSurface,
      invariants: [{ text: 'Works.' }],
    });

    // Should still compile (may fail to find strategy, but shouldn't crash)
    expect(vp.invariants).toHaveLength(1);
  });

  test('duplicate invariants are compiled independently', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-005',
      system_surface: ecommerceSurface,
      invariants: [
        { text: 'GET /health returns HTTP 200.' },
        { text: 'GET /health returns HTTP 200.' },
      ],
    });

    expect(vp.invariants).toHaveLength(2);
    expect(vp.invariants[0].inv_id).not.toBe(vp.invariants[1].inv_id);
    // Both should compile the same way
    expect(vp.invariants[0].verification_plan.strategy_id).toBe(vp.invariants[1].verification_plan.strategy_id);
  });

  test('custom inv_ids are preserved, not overwritten', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-EDGE-006',
      system_surface: ecommerceSurface,
      invariants: [
        { inv_id: 'CUSTOM-A', text: 'GET /health returns 200.' },
        { inv_id: 'CUSTOM-B', text: 'POST /orders creates an order.' },
      ],
    });

    expect(vp.invariants[0].inv_id).toBe('CUSTOM-A');
    expect(vp.invariants[1].inv_id).toBe('CUSTOM-B');
  });

  test('compileVerificationProgramWithAgent degrades gracefully without agent', async () => {
    const { compileVerificationProgramWithAgent } = await import('semantic-compiler/compiler.js');

    const vp = await compileVerificationProgramWithAgent({
      uow_id: 'ABILITY-EDGE-007',
      system_surface: ecommerceSurface,
      invariants: [{ text: 'GET /health returns 200.' }],
    });

    // Without agent in agent_required mode, should fail with finding
    const agentFinding = vp.compile_findings.find(f => f.code === 'agent_unavailable');
    expect(agentFinding).toBeDefined();
    expect(vp.invariants[0].compile_status).toBe('failed');
  });

  test('compileVerificationProgramWithAgent in rules_only mode bypasses agent', async () => {
    const { compileVerificationProgramWithAgent } = await import('semantic-compiler/compiler.js');

    const vp = await compileVerificationProgramWithAgent(
      {
        uow_id: 'ABILITY-EDGE-008',
        system_surface: ecommerceSurface,
        invariants: [{ text: 'GET /health returns 200.' }],
      },
      { mode: 'rules_only' }
    );

    // rules_only should work without agent
    expect(vp.invariants[0].compile_status).toBe('compiled');
    expect(vp.compile_findings.find(f => f.code === 'agent_unavailable')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Usefulness Assessment — Does the output actually help?
// ---------------------------------------------------------------------------

describe('usefulness assessment', () => {
  test('compiled VP for a realistic e-commerce scenario — reveals strategy coverage gaps', () => {
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-USE-001',
      system_surface: ecommerceSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'Adding an item to cart from the product page increases cart count by 1.' },
        { inv_id: 'INV-002', text: 'POST /api/checkout with valid cart returns 201 and order_id.' },
        { inv_id: 'INV-003', text: 'The system never charges a customer without a confirmed cart.' },
      ],
    });

    // KNOWN GAP: INV-001 is a textbook UI scenario but the keyword list for ui_scenario
    // only checks: ['ui', 'click', 'screen', 'onboarding', 'button', 'login'].
    // "cart", "product page", "item" don't match. The compiler fails to recognize this as UI.
    expect(vp.invariants[0].verification_plan.strategy_id).toBe('none');
    expect(vp.invariants[0].compile_status).toBe('failed');

    // INV-002: API scenario works correctly — "/" triggers api_scenario
    expect(vp.invariants[1].verification_plan.strategy_id).toBe('api_scenario');
    expect(vp.invariants[1].compile_status).toBe('compiled');

    // INV-003: Trace checker works correctly — "never" triggers trace_checker
    expect(vp.invariants[2].verification_plan.strategy_id).toBe('trace_checker');
    const traceSteps = vp.invariants[2].verification_plan.steps.map(s => s.spec.toLowerCase()).join(' ');
    expect(traceSteps).toMatch(/trace|predicate|invariant/);

    // Compiled invariants have evidence and verdict rules
    for (const inv of vp.invariants.filter(i => i.compile_status !== 'failed')) {
      expect(inv.verification_plan.evidence.length).toBeGreaterThan(0);
      expect(inv.verdict_rule.length).toBeGreaterThan(5);
    }
  });

  test('harness artifacts are strategy-appropriate', async () => {
    const outDir = await makeTempDir('usefulness-harness');
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-USE-002',
      system_surface: saasAuthSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'User logs in via Google OAuth, restarts app, remains authenticated.' },
      ],
    });

    const harness = await generateHarnessArtifacts(vp, { output_dir: outDir });

    // Restart persistence should produce BOTH playwright (for login flow) AND docker compose (for restart)
    const types = new Set(harness.artifacts.map(a => a.type));
    expect(types.has('playwright_spec')).toBe(true);
    expect(types.has('docker_compose')).toBe(true);
    expect(types.has('trace_vocab')).toBe(true);
    expect(types.has('manifest')).toBe(true);

    // Playwright spec should reference the invariant
    const playwrightArtifact = harness.artifacts.find(a => a.type === 'playwright_spec')!;
    const specContent = await fs.readFile(path.join(outDir, playwrightArtifact.path), 'utf8');
    expect(specContent).toContain('INV-001');
    expect(specContent).toContain("import { test, expect } from '@playwright/test'");
  });

  test('verdict report is human-readable and contains all necessary context', async () => {
    const outDir = await makeTempDir('usefulness-report');
    const vp = compileVerificationProgram({
      uow_id: 'ABILITY-USE-003',
      system_surface: realtimeSurface,
      invariants: [
        { inv_id: 'INV-001', text: 'Messages are never delivered to users who left the room.' },
        { inv_id: 'INV-002', text: 'Reconnected users receive all missed messages in order.' },
      ],
    });

    const verdicts: InvariantVerdict[] = [
      { inv_id: 'INV-001', verdict: 'pass', evidence_path: 'evidence/inv-001', assumptions_used: ['Event vocabulary is normalized across environments'] },
      { inv_id: 'INV-002', verdict: 'fail', evidence_path: 'evidence/inv-002', counterexample: 'Messages 7,8 delivered out of order after 30s disconnect' },
    ];

    const report = await emitVerdictArtifacts(vp, verdicts, { output_dir: outDir });
    const summary = await fs.readFile(report.summary_path, 'utf8');

    // Summary contains both pass and fail
    expect(summary).toContain('PASS');
    expect(summary).toContain('FAIL');
    // Counterexample is surfaced
    expect(summary).toContain('out of order');
    // Original invariant text is included for context
    expect(summary).toContain('never delivered');
    expect(summary).toContain('missed messages');
    // Assumptions are documented
    expect(summary).toContain('Event vocabulary');
  });
});
