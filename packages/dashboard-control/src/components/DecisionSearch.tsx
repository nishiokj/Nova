/**
 * Decision Search - Search and browse decisions
 */

import { useState, useCallback } from 'react';
import type { Decision } from '@/lib/api';
import { searchDecisions } from '@/lib/api';

interface DecisionSearchProps {
  initialDecisions?: Decision[];
}

export function DecisionSearch({ initialDecisions = [] }: DecisionSearchProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [decisions, setDecisions] = useState<Decision[]>(initialDecisions);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const handleSearch = useCallback(async () => {
    setLoading(true);
    try {
      const results = await searchDecisions(query, { category: category || undefined, limit: 50 });
      setDecisions(results);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  }, [query, category]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const categories = ['architecture', 'implementation', 'testing', 'refactoring', 'bugfix'];

  return (
    <div className="space-y-4">
      {/* Search Controls */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search decisions..."
          className="flex-1 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--running)]"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--running)]"
        >
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="bg-[var(--running)] text-white px-4 py-2 rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Results */}
      <div className="space-y-2">
        {decisions.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--text-muted)]">
            {query ? 'No decisions found' : 'Enter a search query to find decisions'}
          </div>
        ) : (
          decisions.map((decision) => (
            <div
              key={decision.id}
              className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border-subtle)] overflow-hidden"
            >
              <div
                className="flex items-center gap-2 p-3 cursor-pointer hover:bg-[var(--bg-hover)]"
                onClick={() => toggleExpand(decision.id)}
              >
                <svg
                  className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${expanded.has(decision.id) ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--accent-violet)] text-white">
                  {decision.category}
                </span>
                <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{decision.decision}</span>
              </div>

              {expanded.has(decision.id) && (
                <div className="px-3 pb-3 border-t border-[var(--border-subtle)]">
                  <div className="pt-3">
                    <div className="text-xs text-[var(--text-muted)] mb-1">Rationale</div>
                    <p className="text-sm text-[var(--text-secondary)]">{decision.rationale}</p>
                  </div>
                  {decision.keywords.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {decision.keywords.map((keyword, idx) => (
                        <span
                          key={idx}
                          className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]"
                        >
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
