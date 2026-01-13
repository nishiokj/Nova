import { useMemo, useState } from 'react';
import type { Session, LLMCall, ToolCall } from '@shared/domain/models';
import { StatusDot } from './StatusDot';
import { TurnRow, TurnTableHeader, TOOL_COLUMNS } from './TurnRow';

type TabType = 'turns' | 'logs' | 'files';

interface SessionCardProps {
  session: Session;
  onExpand: () => void;
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

const MAX_VISIBLE_TURNS = 8;
const MAX_VISIBLE_LOGS = 6;
const MAX_VISIBLE_FILES = 10;

export function SessionCard({ session, onExpand }: SessionCardProps) {
  const [activeTab, setActiveTab] = useState<TabType>('turns');

  const shortId = session.id.slice(0, 8);
  const description =
    (session.meta.description as string) ||
    session.requests[0]?.userInput?.slice(0, 40) ||
    'Active session';

  // Aggregate all data across all requests
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

  // Extract errors from requests
  const errors = useMemo(() => {
    const errs: Array<{ requestId: string; message: string }> = [];
    for (const req of session.requests) {
      if (req.state === 'error' && req.errorMessage) {
        errs.push({ requestId: req.id.slice(0, 8), message: req.errorMessage });
      }
    }
    return errs;
  }, [session.requests]);

  // Extract files touched (from tool calls)
  const filesTouched = useMemo(() => {
    const files = new Map<string, { reads: number; writes: number; edits: number }>();
    for (const tc of allToolCalls) {
      const args = tc.arguments as Record<string, unknown>;
      let filePath: string | undefined;

      if (tc.toolName === 'Read' || tc.toolName === 'Write' || tc.toolName === 'Edit') {
        filePath = args.file_path as string | undefined;
      }

      if (filePath) {
        const existing = files.get(filePath) || { reads: 0, writes: 0, edits: 0 };
        if (tc.toolName === 'Read') existing.reads++;
        else if (tc.toolName === 'Write') existing.writes++;
        else if (tc.toolName === 'Edit') existing.edits++;
        files.set(filePath, existing);
      }
    }
    return Array.from(files.entries()).map(([path, counts]) => ({
      path,
      ...counts,
    }));
  }, [allToolCalls]);

  const visibleTurns = turns.slice(-MAX_VISIBLE_TURNS);
  const hasMoreTurns = turns.length > MAX_VISIBLE_TURNS;
  const visibleErrors = errors.slice(0, MAX_VISIBLE_LOGS);
  const hasMoreErrors = errors.length > MAX_VISIBLE_LOGS;
  const visibleFiles = filesTouched.slice(0, MAX_VISIBLE_FILES);
  const hasMoreFiles = filesTouched.length > MAX_VISIBLE_FILES;

  return (
    <div className="session-card">
      <div className="session-card-header" onClick={onExpand}>
        <StatusDot status={session.state} />
        <span className="session-card-id">{shortId}</span>
        <span className="session-card-desc">{description}</span>
      </div>

      <div className="session-card-tabs">
        <button
          className={`tab ${activeTab === 'turns' ? 'active' : ''}`}
          onClick={() => setActiveTab('turns')}
        >
          Turns ({turns.length})
        </button>
        <button
          className={`tab ${activeTab === 'logs' ? 'active' : ''} ${errors.length > 0 ? 'has-errors' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Logs {errors.length > 0 && `(${errors.length})`}
        </button>
        <button
          className={`tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          Files ({filesTouched.length})
        </button>
      </div>

      <div className="session-card-body">
        {activeTab === 'turns' && (
          <TurnsTab
            turns={visibleTurns}
            usedTools={usedTools}
            hasMore={hasMoreTurns}
            totalCount={turns.length}
          />
        )}
        {activeTab === 'logs' && (
          <LogsTab
            errors={visibleErrors}
            hasMore={hasMoreErrors}
            totalCount={errors.length}
          />
        )}
        {activeTab === 'files' && (
          <FilesTab
            files={visibleFiles}
            hasMore={hasMoreFiles}
            totalCount={filesTouched.length}
          />
        )}
      </div>
    </div>
  );
}

function TurnsTab({
  turns,
  usedTools,
  hasMore,
  totalCount,
}: {
  turns: Turn[];
  usedTools: string[];
  hasMore: boolean;
  totalCount: number;
}) {
  if (turns.length === 0) {
    return <div className="tab-empty">Waiting for LLM calls...</div>;
  }

  return (
    <>
      {hasMore && (
        <div className="tab-truncated">
          Showing last {turns.length} of {totalCount} turns
        </div>
      )}
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
    </>
  );
}

function LogsTab({
  errors,
  hasMore,
  totalCount,
}: {
  errors: Array<{ requestId: string; message: string }>;
  hasMore: boolean;
  totalCount: number;
}) {
  if (errors.length === 0) {
    return <div className="tab-empty">No errors</div>;
  }

  return (
    <>
      {hasMore && (
        <div className="tab-truncated">
          Showing {errors.length} of {totalCount} errors
        </div>
      )}
      <div className="error-list">
        {errors.map((err, i) => (
          <div key={i} className="error-item">
            <span className="error-req">{err.requestId}</span>
            <span className="error-msg">{err.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function FilesTab({
  files,
  hasMore,
  totalCount,
}: {
  files: Array<{ path: string; reads: number; writes: number; edits: number }>;
  hasMore: boolean;
  totalCount: number;
}) {
  if (files.length === 0) {
    return <div className="tab-empty">No files touched</div>;
  }

  return (
    <>
      {hasMore && (
        <div className="tab-truncated">
          Showing {files.length} of {totalCount} files
        </div>
      )}
      <div className="file-list">
        {files.map((file, i) => {
          const shortPath = file.path.split('/').slice(-2).join('/');
          const ops: string[] = [];
          if (file.reads > 0) ops.push(`R${file.reads}`);
          if (file.writes > 0) ops.push(`W${file.writes}`);
          if (file.edits > 0) ops.push(`E${file.edits}`);
          return (
            <div key={i} className="file-item">
              <span className="file-path">{shortPath}</span>
              <span className="file-ops">{ops.join(' ')}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
