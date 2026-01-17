import { useMemo } from 'react';
import type { Session, LLMCall } from '@shared/domain/models';
import { formatTokens } from './formatters';

interface AnalyticsViewProps {
  sessions: Session[];
}

interface ProviderStats {
  provider: string;
  today: number;
  week: number;
  month: number;
}

interface Metrics {
  requestsPerDay: number;
  llmCallsPerRequest: number;
  // Per request averages
  inputPerRequest: number;
  outputPerRequest: number;
  // Per LLM call averages
  inputPerCall: number;
  outputPerCall: number;
  // Totals
  totalRequests: number;
  totalLlmCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// Daily metrics for rolling 10-day charts
interface DailyMetrics {
  date: string; // YYYY-MM-DD
  dateLabel: string; // MM/DD
  totalInput: number;
  totalOutput: number;
  requests: number;
  llmCalls: number;
  inputPerCall: number;
  outputPerCall: number;
  inputPerRequest: number;
  outputPerRequest: number;
  llmCallsPerRequest: number;
}

function isWithinDays(timestamp: string, days: number): boolean {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}

function getDateKey(timestamp: string): string {
  // Use local date to match how we generate day buckets
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateLabel(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  return `${month}/${day}`;
}

function computeDailyMetrics(sessions: Session[]): DailyMetrics[] {
  // Generate last 10 days using local dates
  const days: string[] = [];
  const now = new Date();
  for (let i = 9; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    days.push(`${year}-${month}-${day}`);
  }

  // Initialize daily buckets
  const buckets = new Map<string, {
    input: number;
    output: number;
    requests: Set<string>;
    llmCalls: number;
  }>();

  for (const day of days) {
    buckets.set(day, { input: 0, output: 0, requests: new Set(), llmCalls: 0 });
  }

  // Aggregate data
  for (const session of sessions) {
    for (const request of session.requests) {
      for (const call of request.llmCalls) {
        const dayKey = getDateKey(call.timestamp);
        const bucket = buckets.get(dayKey);
        if (bucket) {
          bucket.input += call.promptTokens;
          bucket.output += call.completionTokens;
          bucket.requests.add(request.id);
          bucket.llmCalls++;
        }
      }
    }
  }

  // Convert to array
  return days.map(day => {
    const bucket = buckets.get(day)!;
    const requests = bucket.requests.size;
    const llmCalls = bucket.llmCalls;
    return {
      date: day,
      dateLabel: getDateLabel(day),
      totalInput: bucket.input,
      totalOutput: bucket.output,
      requests,
      llmCalls,
      inputPerCall: llmCalls > 0 ? bucket.input / llmCalls : 0,
      outputPerCall: llmCalls > 0 ? bucket.output / llmCalls : 0,
      inputPerRequest: requests > 0 ? bucket.input / requests : 0,
      outputPerRequest: requests > 0 ? bucket.output / requests : 0,
      llmCallsPerRequest: requests > 0 ? llmCalls / requests : 0,
    };
  });
}

// Daily metrics table component
function DailyMetricsTable({ data }: { data: DailyMetrics[] }) {
  return (
    <table className="analytics-table daily-table">
      <thead>
        <tr>
          <th className="analytics-th">Date</th>
          <th className="analytics-th analytics-num text-cyan">Input</th>
          <th className="analytics-th analytics-num text-green">Output</th>
          <th className="analytics-th analytics-num">Reqs</th>
          <th className="analytics-th analytics-num">LLM Calls</th>
          <th className="analytics-th analytics-num text-cyan">In/Call</th>
          <th className="analytics-th analytics-num text-green">Out/Call</th>
          <th className="analytics-th analytics-num text-cyan">In/Req</th>
          <th className="analytics-th analytics-num text-green">Out/Req</th>
          <th className="analytics-th analytics-num">Calls/Req</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.date} className="analytics-row">
            <td className="analytics-td">{d.dateLabel}</td>
            <td className="analytics-td analytics-num text-cyan">{formatTokens(d.totalInput)}</td>
            <td className="analytics-td analytics-num text-green">{formatTokens(d.totalOutput)}</td>
            <td className="analytics-td analytics-num">{d.requests}</td>
            <td className="analytics-td analytics-num">{d.llmCalls}</td>
            <td className="analytics-td analytics-num text-cyan">{formatTokens(d.inputPerCall)}</td>
            <td className="analytics-td analytics-num text-green">{formatTokens(d.outputPerCall)}</td>
            <td className="analytics-td analytics-num text-cyan">{formatTokens(d.inputPerRequest)}</td>
            <td className="analytics-td analytics-num text-green">{formatTokens(d.outputPerRequest)}</td>
            <td className="analytics-td analytics-num">{d.llmCallsPerRequest.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function computeAnalytics(sessions: Session[]): { byProvider: ProviderStats[]; metrics: Metrics } {
  const allLlmCalls: LLMCall[] = sessions.flatMap(s => s.requests.flatMap(r => r.llmCalls));

  // Group by provider and time bucket
  const providerMap = new Map<string, { today: number; week: number; month: number }>();

  for (const call of allLlmCalls) {
    const provider = call.provider || 'unknown';
    const tokens = call.promptTokens + call.completionTokens;

    if (!providerMap.has(provider)) {
      providerMap.set(provider, { today: 0, week: 0, month: 0 });
    }

    const stats = providerMap.get(provider)!;
    if (isWithinDays(call.timestamp, 1)) {
      stats.today += tokens;
    }
    if (isWithinDays(call.timestamp, 7)) {
      stats.week += tokens;
    }
    if (isWithinDays(call.timestamp, 30)) {
      stats.month += tokens;
    }
  }

  const byProvider = Array.from(providerMap.entries())
    .map(([provider, stats]) => ({ provider, ...stats }))
    .sort((a, b) => b.month - a.month);

  // Compute metrics
  const totalRequests = sessions.reduce((sum, s) => sum + s.requests.length, 0);
  const totalLlmCalls = allLlmCalls.length;

  // Calculate days span from oldest to newest session
  const timestamps = sessions.map(s => new Date(s.createdAt).getTime());
  const oldestMs = Math.min(...timestamps);
  const newestMs = Math.max(...timestamps);
  const daySpan = Math.max(1, (newestMs - oldestMs) / (1000 * 60 * 60 * 24));

  const requestsPerDay = totalRequests / daySpan;
  const llmCallsPerRequest = totalRequests > 0 ? totalLlmCalls / totalRequests : 0;

  const totalInputTokens = allLlmCalls.reduce((sum, c) => sum + c.promptTokens, 0);
  const totalOutputTokens = allLlmCalls.reduce((sum, c) => sum + c.completionTokens, 0);

  // Per request averages
  const inputPerRequest = totalRequests > 0 ? totalInputTokens / totalRequests : 0;
  const outputPerRequest = totalRequests > 0 ? totalOutputTokens / totalRequests : 0;

  // Per LLM call averages
  const inputPerCall = totalLlmCalls > 0 ? totalInputTokens / totalLlmCalls : 0;
  const outputPerCall = totalLlmCalls > 0 ? totalOutputTokens / totalLlmCalls : 0;

  return {
    byProvider,
    metrics: {
      requestsPerDay,
      llmCallsPerRequest,
      inputPerRequest,
      outputPerRequest,
      inputPerCall,
      outputPerCall,
      totalRequests,
      totalLlmCalls,
      totalInputTokens,
      totalOutputTokens,
    },
  };
}

export function AnalyticsView({ sessions }: AnalyticsViewProps) {
  const { byProvider, metrics } = useMemo(() => computeAnalytics(sessions), [sessions]);
  const dailyMetrics = useMemo(() => computeDailyMetrics(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <div className="analytics-view">
        <div className="analytics-empty">No data available</div>
      </div>
    );
  }

  return (
    <div className="analytics-view">
      {/* Rolling 10-day table */}
      <div className="analytics-section">
        <div className="analytics-section-title">Rolling 10 Days</div>
        <DailyMetricsTable data={dailyMetrics} />
      </div>

      <div className="analytics-section">
        <div className="analytics-section-title">Tokens by Provider</div>
        <table className="analytics-table">
          <thead>
            <tr>
              <th className="analytics-th">Provider</th>
              <th className="analytics-th analytics-num">Today</th>
              <th className="analytics-th analytics-num">Week</th>
              <th className="analytics-th analytics-num">Month</th>
            </tr>
          </thead>
          <tbody>
            {byProvider.map((row) => (
              <tr key={row.provider} className="analytics-row">
                <td className="analytics-td">{row.provider}</td>
                <td className="analytics-td analytics-num">{formatTokens(row.today)}</td>
                <td className="analytics-td analytics-num">{formatTokens(row.week)}</td>
                <td className="analytics-td analytics-num">{formatTokens(row.month)}</td>
              </tr>
            ))}
            {byProvider.length === 0 && (
              <tr>
                <td colSpan={4} className="analytics-td text-muted">No LLM calls</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="analytics-section">
        <div className="analytics-section-title">Per Request</div>
        <table className="analytics-table">
          <thead>
            <tr>
              <th className="analytics-th">Metric</th>
              <th className="analytics-th analytics-num text-cyan">Input</th>
              <th className="analytics-th analytics-num text-green">Output</th>
            </tr>
          </thead>
          <tbody>
            <tr className="analytics-row">
              <td className="analytics-td">Tokens/req</td>
              <td className="analytics-td analytics-num text-cyan">{formatTokens(metrics.inputPerRequest)}</td>
              <td className="analytics-td analytics-num text-green">{formatTokens(metrics.outputPerRequest)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="analytics-section">
        <div className="analytics-section-title">Per LLM Call</div>
        <table className="analytics-table">
          <thead>
            <tr>
              <th className="analytics-th">Metric</th>
              <th className="analytics-th analytics-num text-cyan">Input</th>
              <th className="analytics-th analytics-num text-green">Output</th>
            </tr>
          </thead>
          <tbody>
            <tr className="analytics-row">
              <td className="analytics-td">Tokens/call</td>
              <td className="analytics-td analytics-num text-cyan">{formatTokens(metrics.inputPerCall)}</td>
              <td className="analytics-td analytics-num text-green">{formatTokens(metrics.outputPerCall)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="analytics-section">
        <div className="analytics-section-title">Activity</div>
        <table className="analytics-table">
          <tbody>
            <tr className="analytics-row">
              <td className="analytics-td">Requests/day</td>
              <td className="analytics-td analytics-num">{metrics.requestsPerDay.toFixed(1)}</td>
            </tr>
            <tr className="analytics-row">
              <td className="analytics-td">LLM calls/req</td>
              <td className="analytics-td analytics-num">{metrics.llmCallsPerRequest.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="analytics-section">
        <div className="analytics-section-title">Totals</div>
        <div className="analytics-totals">
          <div className="analytics-total">
            <span className="analytics-total-value">{metrics.totalRequests}</span>
            <span className="analytics-total-label">requests</span>
          </div>
          <div className="analytics-total">
            <span className="analytics-total-value">{metrics.totalLlmCalls}</span>
            <span className="analytics-total-label">LLM calls</span>
          </div>
          <div className="analytics-total">
            <span className="analytics-total-value text-cyan">{formatTokens(metrics.totalInputTokens)}</span>
            <span className="analytics-total-label">input tokens</span>
          </div>
          <div className="analytics-total">
            <span className="analytics-total-value text-green">{formatTokens(metrics.totalOutputTokens)}</span>
            <span className="analytics-total-label">output tokens</span>
          </div>
        </div>
      </div>
    </div>
  );
}
