import { describe, expect, it } from 'vitest';
import type { NormalizedSessionEvent } from '@/lib/api';
import { deriveLiveWorkItems } from './LiveTab';

function event(input: {
  at: string;
  workItemId?: string;
  status?: string;
  objective?: string;
  agent?: string;
  eventType?: string;
}): NormalizedSessionEvent {
  return {
    at: input.at,
    type: 'workflow',
    payload: {
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      eventType: input.eventType ?? 'workitem_status',
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      },
    },
  };
}

describe('deriveLiveWorkItems', () => {
  it('keeps objective as primary label and orders live items first', () => {
    const rows = deriveLiveWorkItems([
      event({
        at: '2026-02-08T10:00:00.000Z',
        workItemId: 'work-1',
        status: 'started',
        objective: 'Build auth flow',
        agent: 'explorer',
      }),
      event({
        at: '2026-02-08T10:01:00.000Z',
        workItemId: 'work-2',
        status: 'completed',
        objective: 'Fix docs',
        agent: 'standard',
      }),
    ], { nowMs: Date.parse('2026-02-08T10:01:10.000Z') });

    expect(rows[0]?.objective).toBe('Build auth flow');
    expect(rows[0]?.agent).toBe('explorer');
    expect(rows[0]?.isLive).toBe(true);
    expect(rows[1]?.objective).toBe('Fix docs');
    expect(rows[1]?.isLive).toBe(false);
  });

  it('maps coding/coder agents to coder visual lane and limits to three items', () => {
    const rows = deriveLiveWorkItems([
      event({ at: '2026-02-08T10:00:04.000Z', workItemId: 'w1', status: 'started', objective: 'A', agent: 'coding' }),
      event({ at: '2026-02-08T10:00:01.000Z', workItemId: 'w2', status: 'started', objective: 'B', agent: 'watcher' }),
      event({ at: '2026-02-08T10:00:02.000Z', workItemId: 'w3', status: 'started', objective: 'C', agent: 'explorer' }),
      event({ at: '2026-02-08T10:00:03.000Z', workItemId: 'w4', status: 'started', objective: 'D', agent: 'standard' }),
    ], { nowMs: Date.parse('2026-02-08T10:00:10.000Z') });

    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.agent === 'coder')).toBe(true);
  });

  it('injects active work item even when no events include it', () => {
    const rows = deriveLiveWorkItems([], {
      activeWorkItemId: 'active-1',
      activeObjective: 'Ship checkout API',
      nowMs: Date.parse('2026-02-08T10:00:00.000Z'),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: 'active-1',
      objective: 'Ship checkout API',
      isLive: true,
      status: 'started',
    });
  });

  it('derives work item identity from payload.workId', () => {
    const rows = deriveLiveWorkItems([
      {
        at: '2026-02-08T10:00:00.000Z',
        type: 'workflow',
        payload: {
          workId: 'wk-7',
          eventType: 'workitem_status',
          data: {
            status: 'started',
            objective: 'Render all cards',
            agent: 'standard',
          },
        },
      },
    ], { nowMs: Date.parse('2026-02-08T10:00:01.000Z') });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: 'wk-7',
      objective: 'Render all cards',
      isLive: true,
    });
  });

  it('uses payload-level objective when present', () => {
    const rows = deriveLiveWorkItems([
      {
        at: '2026-02-08T10:00:00.000Z',
        type: 'workflow',
        payload: {
          workItemId: 'wk-8',
          objective: 'Top-level objective',
          eventType: 'workitem_status',
          data: { status: 'started' },
        },
      },
    ], { nowMs: Date.parse('2026-02-08T10:00:01.000Z') });

    expect(rows[0]?.objective).toBe('Top-level objective');
  });

  it('uses neutral fallback label when objective is unknown', () => {
    const rows = deriveLiveWorkItems([
      {
        at: '2026-02-08T10:00:00.000Z',
        type: 'workflow',
        payload: {
          workItemId: 'wk-9',
          eventType: 'workitem_status',
          data: { status: 'started' },
        },
      },
    ], { nowMs: Date.parse('2026-02-08T10:00:01.000Z') });

    expect(rows[0]?.objective).toBe('Work item wk-9');
  });

  it('drops stale non-terminal work items so idle cards are not rendered', () => {
    const rows = deriveLiveWorkItems([
      event({
        at: '2026-02-08T10:00:00.000Z',
        workItemId: 'idle-1',
        objective: 'Old background task',
      }),
      event({
        at: '2026-02-08T10:01:00.000Z',
        workItemId: 'active-1',
        status: 'started',
        objective: 'Current task',
      }),
    ], { nowMs: Date.parse('2026-02-08T10:02:00.000Z') });

    expect(rows.map((row) => row.workItemId)).toEqual(['active-1']);
  });
});
