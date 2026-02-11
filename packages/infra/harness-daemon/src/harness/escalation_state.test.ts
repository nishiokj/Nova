import { describe, expect, it } from 'bun:test';
import {
  buildEscalationResolutionGuidance,
  parseSessionEscalations,
  resolveSessionEscalationState,
  type EscalationResolutionInput,
} from './escalation_state.js';

describe('escalation_state', () => {
  it('parses valid escalation metadata and drops invalid rows', () => {
    const parsed = parseSessionEscalations([
      {
        id: 'esc_1',
        escalationType: 'review',
        sessionKey: 'session_1',
        title: 'Needs review',
        context: 'Quality gate failed',
        status: 'pending',
        createdAt: 100,
        updatedAt: 100,
        references: [{ type: 'workitem', label: 'Work item', target: 'work_1' }],
      },
      {
        id: '',
        escalationType: 'review',
        sessionKey: 'session_1',
      },
    ]);

    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe('esc_1');
    expect(parsed[0].status).toBe('pending');
  });

  it('resolves escalation and returns pending count', () => {
    const input = parseSessionEscalations([
      {
        id: 'esc_1',
        escalationType: 'review',
        sessionKey: 'session_1',
        title: 'Needs review',
        context: 'Quality gate failed',
        status: 'pending',
        createdAt: 100,
        updatedAt: 100,
        references: [{ type: 'workitem', label: 'Work item', target: 'work_1' }],
      },
      {
        id: 'esc_2',
        escalationType: 'failure',
        sessionKey: 'session_1',
        title: 'Needs decision',
        context: 'Agent error',
        status: 'pending',
        createdAt: 101,
        updatedAt: 101,
        references: [{ type: 'workitem', label: 'Work item', target: 'work_2' }],
      },
    ]);

    const resolution: EscalationResolutionInput = {
      resolvedBy: 'user',
      optionId: 'accept_risk',
      freeformResponse: 'Proceed with mitigation',
    };

    const result = resolveSessionEscalationState(input, 'esc_1', resolution, 999);

    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(false);
    expect(result.resolved?.status).toBe('resolved');
    expect(result.resolved?.resolution?.optionId).toBe('accept_risk');
    expect(result.pendingCount).toBe(1);
  });

  it('keeps terminal escalation untouched for idempotent resolve', () => {
    const input = parseSessionEscalations([
      {
        id: 'esc_1',
        escalationType: 'review',
        sessionKey: 'session_1',
        title: 'Already resolved',
        context: 'done',
        status: 'resolved',
        createdAt: 100,
        updatedAt: 200,
        resolvedAt: 200,
        resolution: { resolvedBy: 'user' },
        references: [{ type: 'workitem', label: 'Work item', target: 'work_1' }],
      },
    ]);

    const result = resolveSessionEscalationState(input, 'esc_1', { resolvedBy: 'user' }, 500);

    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.escalations[0].updatedAt).toBe(200);
    expect(result.pendingCount).toBe(0);
  });

  it('builds resolution guidance with option and notes', () => {
    const escalation = parseSessionEscalations([
      {
        id: 'esc_1',
        escalationType: 'review',
        sessionKey: 'session_1',
        title: 'Need human decision',
        context: 'context',
        status: 'pending',
        createdAt: 100,
        updatedAt: 100,
        references: [{ type: 'workitem', label: 'Work item', target: 'work_1' }],
      },
    ])[0];

    const guidance = buildEscalationResolutionGuidance(escalation, {
      resolvedBy: 'user',
      optionId: 'option_a',
      freeformResponse: 'Proceed',
    });

    expect(guidance).toContain('Escalation ID: esc_1');
    expect(guidance).toContain('Selected option: option_a');
    expect(guidance).toContain('Resolution notes: Proceed');
  });
});
