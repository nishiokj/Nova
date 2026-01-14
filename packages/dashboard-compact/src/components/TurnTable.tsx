import { useMemo } from 'react';
import type { LLMCall, ToolCall } from '@shared/domain/models';
import { formatDuration } from '@shared/lib/time';

const TOOL_COLUMNS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
  'AskUserQuestion', 'NotebookEdit'
] as const;

interface TurnRow {
  turnIndex: number;
  llmCall: LLMCall;
  toolCounts: Record<string, number>;
}

function computeTurns(llmCalls: LLMCall[], toolCalls: ToolCall[]): TurnRow[] {
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

  const turns: TurnRow[] = [];
  let current: TurnRow | null = null;

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

interface TurnTableProps {
  llmCalls: LLMCall[];
  toolCalls: ToolCall[];
}

export function TurnTable({ llmCalls, toolCalls }: TurnTableProps) {
  const turns = useMemo(
    () => computeTurns(llmCalls, toolCalls),
    [llmCalls, toolCalls]
  );

  const usedTools = useMemo(() => {
    const used = new Set<string>();
    for (const turn of turns) {
      for (const [tool, count] of Object.entries(turn.toolCounts)) {
        if (count > 0) used.add(tool);
      }
    }
    return TOOL_COLUMNS.filter((t) => used.has(t));
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="text-muted text-xs" style={{ padding: '8px 0' }}>
        No LLM calls
      </div>
    );
  }

  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-muted border-b">
        <tr>
          <th className="py-1 px-1">#</th>
          <th className="py-1 px-1">Agent</th>
          <th className="py-1 px-1">Model</th>
          {usedTools.map((tool) => (
            <th key={tool} className="py-1 px-1 text-center">
              {tool}
            </th>
          ))}
          <th className="py-1 px-1 text-right">In</th>
          <th className="py-1 px-1 text-right">Out</th>
          <th className="py-1 px-1 text-right">Latency</th>
        </tr>
      </thead>
      <tbody>
        {turns.map((turn) => (
          <tr key={turn.llmCall.id} className="border-b">
            <td className="py-1 px-1 text-muted">{turn.turnIndex + 1}</td>
            <td className="py-1 px-1">{turn.llmCall.agentType}</td>
            <td className="py-1 px-1 text-muted">{formatModel(turn.llmCall.model)}</td>
            {usedTools.map((tool) => (
              <td key={tool} className="py-1 px-1 text-center">
                {turn.toolCounts[tool] || '-'}
              </td>
            ))}
            <td className="py-1 px-1 text-right text-cyan">
              {turn.llmCall.promptTokens.toLocaleString()}
            </td>
            <td className="py-1 px-1 text-right text-green">
              {turn.llmCall.completionTokens.toLocaleString()}
            </td>
            <td className="py-1 px-1 text-right">
              {formatDuration(turn.llmCall.durationMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatModel(model: string): string {
  // Shorten common model names
  if (model.includes('claude-3-5-sonnet')) return 'sonnet-3.5';
  if (model.includes('claude-3-opus')) return 'opus-3';
  if (model.includes('claude-3-sonnet')) return 'sonnet-3';
  if (model.includes('claude-3-haiku')) return 'haiku-3';
  if (model.includes('gpt-4')) return 'gpt-4';
  if (model.includes('gpt-3.5')) return 'gpt-3.5';
  // Return last part after last dash/slash or full name if short
  const parts = model.split(/[-/]/);
  return parts.length > 2 ? parts.slice(-2).join('-') : model;
}
