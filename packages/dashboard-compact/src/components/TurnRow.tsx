import type { LLMCall, WorkItem } from '@shared/domain/models';
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
  objective?: string;
}

interface UserRequestRowProps {
  requestNum: number;
  goal: string;
  colSpan: number;
}

interface ObjectiveRowProps {
  objective: string;
  colSpan: number;
}

export function TurnRow({ index, llmCall, toolCounts, usedTools, objective }: TurnRowProps) {
  return (
    <>
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
      {objective && (
        <tr className="turn-objective-row">
          <td></td>
          <td colSpan={usedTools.length + 5} className="turn-objective">{objective}</td>
        </tr>
      )}
    </>
  );
}

export function UserRequestRow({ requestNum, goal, colSpan }: UserRequestRowProps) {
  const truncatedGoal = goal.length > 80 ? goal.slice(0, 77) + '...' : goal;
  return (
    <tr className="user-request-row">
      <td className="user-request-marker">U{requestNum}</td>
      <td colSpan={colSpan} className="user-request-goal">{truncatedGoal}</td>
    </tr>
  );
}

export function TurnTableHeader({ usedTools }: { usedTools: string[] }) {
  return (
    <thead>
      <tr className="turn-header">
        <th className="turn-cell">#</th>
        <th className="turn-cell">Agt</th>
        <th className="turn-cell">Mdl</th>
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
  if (model.includes('claude-3-5-sonnet')) return 'snt';
  if (model.includes('claude-3-opus')) return 'ops';
  if (model.includes('claude-3-sonnet')) return 'sn3';
  if (model.includes('claude-3-haiku')) return 'hai';
  if (model.includes('gpt-4')) return 'g4';
  if (model.includes('gpt-3.5')) return 'g3';
  if (model.includes('llama')) return 'lla';
  const parts = model.split(/[-/]/);
  return parts.length > 2 ? parts.slice(-2).join('').slice(0, 3) : model.slice(0, 3);
}

function formatAgent(agent: string): string {
  const abbrevMap: Record<string, string> = {
    routing: 'rt',
    explorer: 'ex',
    runtime_script: 'rs',
    standard: 'st',
    linter: 'ln',
    tester: 'ts',
    context_compactor: 'cc',
    debugger: 'db',
    web_crawler: 'wc',
    orchestrator: 'or',
  };
  return abbrevMap[agent] || agent.slice(0, 2);
}

function formatToolName(tool: string): string {
  const abbrevMap: Record<string, string> = {
    Read: 'R',
    Write: 'W',
    Edit: 'E',
    Bash: 'B',
    Grep: 'Gr',
    Glob: 'Gl',
    Task: 'T',
    WebFetch: 'Wf',
    WebSearch: 'Ws',
    TodoWrite: 'Td',
    AskUserQuestion: '?',
    NotebookEdit: 'Nb',
  };
  return abbrevMap[tool] || tool.slice(0, 2);
}

export { TOOL_COLUMNS };
