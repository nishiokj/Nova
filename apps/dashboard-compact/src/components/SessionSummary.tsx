import { useMemo } from 'react';
import type { Session, LLMCall, ToolCall } from '@shared/domain/models';
import { formatDuration } from '@shared/lib/time';
import { StatusDot } from './StatusDot';
import { TurnRow, TurnTableHeader, TOOL_COLUMNS } from './TurnRow';
import { formatTokens } from './formatters';

interface SessionSummaryProps {
  session: Session;
  onClose: () => void;
}

interface Turn {
  turnIndex: number;
  llmCall: LLMCall;
  toolCounts: Record<string, number>;
}

function computeTurns(llmCalls: LLMCall[], toolCalls: ToolCall[]): Turn[] {
  type Event =
    | { type: 'llm'; data: LLMCall; ts: number }
    | { type: 'tool'; data: ToolCall; ts: number };

  const events: Event[] = [
    ...llmCalls.map((c) => ({
      type: 'llm' as const,
      data: c,
      ts: new Date(c.timestamp).getTime(),
    })),
    ...toolCalls.map((c) => ({
      type: 'tool' as const,
      data: c,
      ts: new Date(c.timestamp).getTime(),
    })),
  ].sort((a, b) => a.ts - b.ts);

  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const event of events) {
    if (event.type === 'llm') {
      if (current) turns.push(current);
      current = {
        turnIndex: turns.length,
        llmCall: event.data,
        toolCounts: Object.fromEntries(TOOL_COLUMNS.map((t) => [t, 0])),
      };
    } else if (current) {
      const name = event.data.toolName;
      if (name in current.toolCounts) {
        current.toolCounts[name]++;
      }
    }
  }
  if (current) turns.push(current);

  return turns;
}

export function SessionSummary({ session, onClose }: SessionSummaryProps) {
  const { insights, meta } = session;
  const description = (meta.description as string) || 'No description';
  const datetime = new Date(session.createdAt).toLocaleString();

  // Aggregate all LLM calls and tool calls across all requests
  const allLlmCalls = useMemo(
    () => session.requests.flatMap((r) => r.llmCalls),
    [session.requests]
  );
  const allToolCalls = useMemo(
    () => session.requests.flatMap((r) => r.toolCalls),
    [session.requests]
  );

  const turns = useMemo(
    () => computeTurns(allLlmCalls, allToolCalls),
    [allLlmCalls, allToolCalls]
  );

  const usedTools = useMemo(() => {
    const used = new Set<string>();
    for (const turn of turns) {
      for (const [tool, count] of Object.entries(turn.toolCounts)) {
        if (count > 0) used.add(tool);
      }
    }
    return TOOL_COLUMNS.filter((t) => used.has(t)) as string[];
  }, [turns]);

  return (
    <div className="summary-overlay" onClick={onClose}>
      <div className="summary-panel" onClick={(e) => e.stopPropagation()}>
        <div className="summary-header">
          <div className="summary-title">
            <StatusDot status={session.state} />
            <span className="summary-id">{session.id}</span>
          </div>
          <button className="summary-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="summary-meta">
          <div className="summary-desc">{description}</div>
          <div className="summary-datetime">{datetime}</div>
        </div>

        <div className="summary-stats">
          <div className="stat">
            <span className="stat-label">Requests</span>
            <span className="stat-value">{insights.requestCount}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Input Tokens</span>
            <span className="stat-value text-cyan">
              {formatTokens(insights.totalInputTokens)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Output Tokens</span>
            <span className="stat-value text-green">
              {formatTokens(insights.totalOutputTokens)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Duration</span>
            <span className="stat-value">{formatDuration(insights.durationMs)}</span>
          </div>
        </div>

        <div className="summary-turns">
          {turns.length === 0 ? (
            <div className="summary-empty">No LLM calls recorded</div>
          ) : (
            <table className="turn-table">
              <TurnTableHeader usedTools={usedTools} />
              <tbody>
                {turns.map((turn) => (
                  <TurnRow
                    key={turn.llmCall.id}
                    index={turn.turnIndex}
                    llmCall={turn.llmCall}
                    toolCounts={turn.toolCounts}
                    usedTools={usedTools}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {session.requests.length > 0 && (
          <div className="summary-requests">
            <div className="summary-section-title">Requests</div>
            {session.requests.map((req, i) => (
              <div key={req.id} className="summary-request">
                <div className="summary-request-header">
                  <span className="summary-request-num">#{i + 1}</span>
                  <span className={`summary-request-state state-${req.state}`}>
                    {req.state}
                  </span>
                </div>
                <div className="summary-request-input">{req.userInput}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
