import { describe, expect, it } from 'bun:test';
import { detectAtMention, rankByQuery, rankPathSuggestions } from './autocomplete';

describe('detectAtMention', () => {
  it('detects a mention token at the cursor', () => {
    const text = 'open @notes/plan';
    expect(detectAtMention(text, text.length)).toEqual({
      from: 5,
      to: text.length,
      query: 'notes/plan',
    });
  });

  it('does not treat email-like text as a mention', () => {
    expect(detectAtMention('name@example', 'name@example'.length)).toBeNull();
  });
});

describe('rankPathSuggestions', () => {
  it('prioritizes exact and extensionless basename matches', () => {
    const paths = [
      'notes/cockpit-reviewing.md',
      'notes/cockpit-review.md',
      'plans/review-cockpit.md',
    ];

    expect(rankPathSuggestions(paths, 'cockpit-review', 3)).toEqual([
      'notes/cockpit-review.md',
      'notes/cockpit-reviewing.md',
    ]);
  });

  it('supports fuzzy subsequence matching on filenames', () => {
    const paths = [
      'notes/session-detail.md',
      'notes/semantic-diff.md',
      'notes/roadmap.md',
    ];

    expect(rankPathSuggestions(paths, 'smdf', 2)).toEqual(['notes/semantic-diff.md']);
  });

  it('de-prioritizes hidden paths when visible matches exist', () => {
    const paths = [
      '.internal/plan.md',
      'notes/plan.md',
      'scratch/plan-draft.md',
    ];

    expect(rankPathSuggestions(paths, 'plan', 3)).toEqual([
      'notes/plan.md',
      'scratch/plan-draft.md',
      '.internal/plan.md',
    ]);
  });
});

describe('rankByQuery', () => {
  const items = [
    {
      id: 'a',
      title: 'Refine cockpit autocomplete scoring',
      sessionKey: 'session-1234abcd',
      status: 'running',
      kind: 'refactor',
      tool: 'write',
      file: 'notes/autocomplete-scoring.md',
    },
    {
      id: 'b',
      title: 'Fix browser tab polling',
      sessionKey: 'session-8888beef',
      status: 'ready',
      kind: 'feature',
      tool: 'browser',
      file: 'scratch/browser-tab.md',
    },
  ];

  const rank = (query: string) => rankByQuery(
    items,
    query,
    (item) => ([
      { text: item.title, weight: 1 },
      { text: item.sessionKey, weight: 1.1 },
      { text: item.status, weight: 1.2 },
      { text: item.kind, weight: 1.3 },
      { text: item.tool, weight: 1.4 },
      { text: item.file, weight: 1.6 },
    ]),
    5,
  ).map((item) => item.id);

  it('ranks multi-token fuzzy queries by best combined field matches', () => {
    expect(rank('auto scor')).toEqual(['a']);
  });

  it('matches session keys and preserves unmatched exclusion', () => {
    expect(rank('beef')).toEqual(['b']);
    expect(rank('does-not-exist')).toEqual([]);
  });
});
