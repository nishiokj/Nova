import { describe, expect, test } from 'bun:test';
import { compileVerificationProgram } from './compiler.js';
import { vpToWorkItemSpecs, buildUserReviewPrompts } from './adapters.js';
import { createInitialState, markStageRunning, markStageWaitingUser } from './stages.js';

describe('compileVerificationProgram', () => {
  test('compiles restart persistence invariant and emits targeted questions', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0007',
      system_surface: {
        services: ['web', 'auth-service'],
        storage: ['postgres session_store'],
        ui_surfaces: ['login page', 'dashboard'],
        external_dependencies: ['google oauth stub'],
        main_flows: ['user login and return session'],
      },
      invariants: [
        {
          text: 'A new user can login with Google OAuth, restart the app, and remain signed in.',
        },
      ],
    }, { now: new Date('2026-02-10T00:00:00.000Z') });

    expect(vp.vp_version).toBe('0.1');
    expect(vp.invariants).toHaveLength(1);
    expect(vp.invariants[0].verification_plan.strategy_id).toBe('restart_persistence');
    expect(vp.invariants[0].compile_status).toBe('needs_user_answer');
    expect((vp.invariants[0].questions ?? []).length).toBeGreaterThan(0);
  });

  test('compiles checkable API invariant without clarification gate', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0008',
      system_surface: {
        services: ['api-service'],
        storage: ['none'],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: ['health endpoint checks'],
      },
      invariants: [
        {
          text: 'GET /health returns HTTP 200 and includes a version field in JSON body.',
        },
      ],
    });

    expect(vp.invariants[0].verification_plan.strategy_id).toBe('api_scenario');
    expect(vp.invariants[0].compile_status).toBe('compiled');
  });

  test('fails all invariants when global system surface errors exist', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0011',
      system_surface: {
        services: [],
        storage: [],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: [],
      },
      invariants: [
        {
          text: 'GET /health returns HTTP 200.',
        },
      ],
    });

    expect(vp.compile_findings.some((finding) => finding.severity === 'error')).toBe(true);
    expect(vp.invariants[0].compile_status).toBe('failed');
  });

  test('assigns unique finding IDs across global and invariant findings', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0012',
      system_surface: {
        services: ['svc'],
        storage: [],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: ['flow'],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'No interface changes and new required param should be fast.',
        },
      ],
    });

    const findingIds = vp.compile_findings.map((finding) => finding.finding_id);
    const uniqueFindingIds = new Set(findingIds);
    expect(uniqueFindingIds.size).toBe(findingIds.length);
  });
});

describe('adapters', () => {
  test('maps VP to work item specs with review gate', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0009',
      system_surface: {
        services: ['web'],
        storage: ['db'],
        ui_surfaces: ['onboarding'],
        external_dependencies: [],
        main_flows: ['onboarding'],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'Onboarding finishes in 3 clicks max.',
        },
      ],
    });

    const specs = vpToWorkItemSpecs(vp);
    expect(specs[0].id).toBe('review_gate');
    expect(specs.some((item) => item.id === 'emit_verdict')).toBe(true);

    const prompts = buildUserReviewPrompts(vp);
    expect(prompts.length).toBeGreaterThan(0);
  });

  test('does not schedule failed invariants for verification', () => {
    const vp = compileVerificationProgram({
      uow_id: 'UOW-2026-02-10-0013',
      system_surface: {
        services: [],
        storage: [],
        ui_surfaces: [],
        external_dependencies: [],
        main_flows: [],
      },
      invariants: [
        {
          inv_id: 'INV-001',
          text: 'GET /health returns HTTP 200.',
        },
      ],
    });

    const specs = vpToWorkItemSpecs(vp);
    expect(specs.some((item) => item.id.startsWith('verify_'))).toBe(false);
    expect(specs.some((item) => item.id === 'emit_verdict')).toBe(false);
  });
});

describe('state machine', () => {
  test('enters waiting_user state at review gate', () => {
    const initial = createInitialState('UOW-2026-02-10-0010');
    const running = markStageRunning(initial, 'stage2_user_review_gate');
    const waiting = markStageWaitingUser(running, 'stage2_user_review_gate', [
      {
        question_id: 'Q-INV-001-01',
        invariant_id: 'INV-001',
        question: 'Clarify signed in definition',
        rationale: 'Need assertion target',
      },
    ]);

    expect(waiting.status).toBe('waiting_user');
    expect(waiting.pending_questions).toHaveLength(1);
    expect(waiting.stages.stage2_user_review_gate.status).toBe('waiting_user');
  });
});
