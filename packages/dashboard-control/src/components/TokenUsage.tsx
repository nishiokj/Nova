/**
 * Token Usage - Display token consumption by provider/model
 */

import type { TokenUsage } from '@/lib/api';

interface TokenUsageProps {
  data: TokenUsage[];
  loading: boolean;
}

export function TokenUsagePanel({ data, loading }: TokenUsageProps) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        Loading token usage...
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        No token usage data available
      </div>
    );
  }

  const totalTokens = data.reduce((sum, item) => sum + item.totalTokens, 0);
  const totalSessions = data.reduce((sum, item) => sum + item.sessionCount, 0);

  // Group by provider
  const byProvider = data.reduce((acc, item) => {
    if (!acc[item.provider]) {
      acc[item.provider] = [];
    }
    acc[item.provider].push(item);
    return acc;
  }, {} as Record<string, TokenUsage[]>);

  const formatNumber = (n: number) => n.toLocaleString();

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-[var(--bg-surface)] rounded-lg p-4 border border-[var(--border-subtle)]">
          <div className="text-xs text-[var(--text-muted)] mb-1">Total Tokens</div>
          <div className="text-3xl font-semibold text-[var(--text-primary)]">
            {formatNumber(totalTokens)}
          </div>
        </div>
        <div className="bg-[var(--bg-surface)] rounded-lg p-4 border border-[var(--border-subtle)]">
          <div className="text-xs text-[var(--text-muted)] mb-1">Sessions</div>
          <div className="text-3xl font-semibold text-[var(--text-primary)]">
            {formatNumber(totalSessions)}
          </div>
        </div>
      </div>

      {/* By Provider */}
      {Object.entries(byProvider).map(([provider, models]) => {
        const providerTotal = models.reduce((sum, m) => sum + m.totalTokens, 0);
        return (
          <div key={provider}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">{provider}</h3>
              <span className="text-sm text-[var(--text-muted)]">{formatNumber(providerTotal)} tokens</span>
            </div>
            <div className="space-y-2">
              {models.map((model) => {
                const percentage = totalTokens > 0 ? (model.totalTokens / totalTokens) * 100 : 0;
                return (
                  <div
                    key={model.model}
                    className="bg-[var(--bg-surface)] rounded-lg p-3 border border-[var(--border-subtle)]"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-[var(--text-primary)]">{model.model}</span>
                      <span className="text-sm text-[var(--text-secondary)]">{formatNumber(model.totalTokens)}</span>
                    </div>
                    <div className="h-2 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--running)] rounded-full transition-all"
                        style={{ width: percentage + '%' }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-[var(--text-muted)]">{model.sessionCount} sessions</span>
                      <span className="text-xs text-[var(--text-muted)]">{percentage.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
