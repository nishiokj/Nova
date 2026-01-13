import type { LLMCall } from '@shared/domain/models';
import { formatDuration } from '@shared/lib/time';
import { formatTokens } from './formatters';

const TOOL_COLUMNS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
  'AskUserQuestion', 'NotebookEdit'
] as const;

interface TurnRowProps {
  index: number;
  llmCall: LLMCall;
  toolCounts: Record<string, number>;
  usedTools: string[];
}

export function TurnRow({ index, llmCall, toolCounts, usedTools }: TurnRowProps) {
  return (
    <tr className="turn-row">
      <td className="turn-cell turn-index">{index + 1}</td>
      <td className="turn-cell turn-agent">{formatAgent(llmCall.agentType)}</td>
      <td className="turn-cell turn-model">{formatModel(llmCall.model)}</td>
      {usedTools.map((tool) => (
        <td key={tool} className="turn-cell turn-tool">
          {toolCounts[tool] || '-'}
        </td>
      ))}
      <td className="turn-cell turn-in">{formatTokens(llmCall.promptTokens)}</td>
      <td className="turn-cell turn-out">{formatTokens(llmCall.completionTokens)}</td>
      <td className="turn-cell turn-latency">{formatDuration(llmCall.durationMs)}</td>
    </tr>
  );
}

export function TurnTableHeader({ usedTools }: { usedTools: string[] }) {
  return (
    <thead>
      <tr className="turn-header">
        <th className="turn-cell">#</th>
        <th className="turn-cell">Agent</th>
        <th className="turn-cell">Model</th>
        {usedTools.map((tool) => (
          <th key={tool} className="turn-cell turn-tool-header">
            {formatToolName(tool)}
          </th>
        ))}
        <th className="turn-cell turn-in">In</th>
        <th className="turn-cell turn-out">Out</th>
        <th className="turn-cell">Lat</th>
      </tr>
    </thead>
  );
}

function formatModel(model: string): string {
  if (model.includes('claude-3-5-sonnet')) return 'son3.5';
  if (model.includes('claude-3-opus')) return 'opus3';
  if (model.includes('claude-3-sonnet')) return 'son3';
  if (model.includes('claude-3-haiku')) return 'hai3';
  if (model.includes('gpt-4')) return 'gpt4';
  if (model.includes('gpt-3.5')) return 'gpt3';
  const parts = model.split(/[-/]/);
  return parts.length > 2 ? parts.slice(-2).join('-').slice(0, 6) : model.slice(0, 6);
}

function formatAgent(agent: string): string {
  const abbrevMap: Record<string, string> = {
    routing: 'rout',
    explorer: 'expl',
    runtime_script: 'run',
    standard: 'std',
    linter: 'lint',
    tester: 'test',
    context_compactor: 'comp',
    debugger: 'dbg',
    web_crawler: 'web',
    orchestrator: 'orch',
  };
  return abbrevMap[agent] || agent.slice(0, 4);
}

function formatToolName(tool: string): string {
  const abbrevMap: Record<string, string> = {
    Read: 'Rd',
    Write: 'Wr',
    Edit: 'Ed',
    Bash: 'Bsh',
    Grep: 'Grp',
    Glob: 'Glb',
    Task: 'Tsk',
    WebFetch: 'WF',
    WebSearch: 'WS',
    TodoWrite: 'Td',
    AskUserQuestion: 'Ask',
    NotebookEdit: 'Nb',
  };
  return abbrevMap[tool] || tool.slice(0, 3);
}

export { TOOL_COLUMNS };
