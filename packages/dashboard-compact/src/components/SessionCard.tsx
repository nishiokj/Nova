import { useMemo, useState } from 'react';
import type { Session, LLMCall, ToolCall, AgentRequest, WorkItem } from '@shared/domain/models';
import { StatusDot } from './StatusDot';
import { TurnRow, TurnTableHeader, UserRequestRow, TOOL_COLUMNS } from './TurnRow';

type TabType = 'turns' | 'logs' | 'files';

interface SessionCardProps {
  session: Session;
  onExpand: () => void;
}

interface Turn {
  turnIndex: number;
  llmCall: LLMCall;
  toolCounts: Record<string, number>;
  objective?: string;
  requestId: string;
}

interface RequestGroup {
  requestId: string;
  requestNum: number;
  goal: string;
  turns: Turn[];
}

function findWorkItemObjective(
  llmCall: LLMCall,
  workItems: WorkItem[]
): string | undefined {
  // Try to find matching work item by workItemId
  if (llmCall.workItemId) {
    const match = workItems.find(w => w.workId === llmCall.workItemId);
    if (match?.objective) return match.objective;
  }
  // Fallback: find in-progress work item
  const inProgress = workItems.find(w => w.status === 'in_progress');
  return inProgress?.objective;
}

function computeTurnsByRequest(requests: AgentRequest[]): RequestGroup[] {
  const groups: RequestGroup[] = [];
  let globalTurnIndex = 0;

  for (let reqIdx = 0; reqIdx < requests.length; reqIdx++) {
    const req = requests[reqIdx];
    const workItems = req.plan?.workItems ?? [];
    const goal = req.plan?.goal || req.userInput || `Request ${reqIdx + 1}`;

    // Build events timeline for this request
    type Event =
      | { type: 'llm'; data: LLMCall; ts: number }
      | { type: 'tool'; data: ToolCall; ts: number };

    const events: Event[] = [
      ...req.llmCalls.map((c) => ({
        type: 'llm' as const,
        data: c,
        ts: new Date(c.timestamp).getTime(),
      })),
      ...req.toolCalls.map((c) => ({
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
        const objective = findWorkItemObjective(event.data, workItems);
        current = {
          turnIndex: globalTurnIndex++,
          llmCall: event.data,
          toolCounts: Object.fromEntries(TOOL_COLUMNS.map((t) => [t, 0])),
          objective,
          requestId: req.id,
        };
      } else if (current) {
        const name = event.data.toolName;
        if (name in current.toolCounts) {
          current.toolCounts[name]++;
        }
      }
    }
    if (current) turns.push(current);

    groups.push({
      requestId: req.id,
      requestNum: reqIdx + 1,
      goal,
      turns,
    });
  }

  return groups;
}

const MAX_VISIBLE_TURNS = 12;
const MAX_VISIBLE_LOGS = 8;
const MAX_VISIBLE_FILES = 12;

export function SessionCard({ session, onExpand }: SessionCardProps) {
  const [activeTab, setActiveTab] = useState<TabType>('turns');

  const shortId = session.id.slice(0, 8);

  // Get goal from first request's plan, or first user input
  const firstRequest = session.requests[0];
  const description =
    firstRequest?.plan?.goal?.slice(0, 60) ||
    (session.meta.description as string)?.slice(0, 60) ||
    firstRequest?.userInput?.slice(0, 60) ||
    'Active session';

  // Compute turns grouped by request
  const requestGroups = useMemo(
    () => computeTurnsByRequest(session.requests),
    [session.requests]
  );

  const totalTurns = useMemo(
    () => requestGroups.reduce((sum, g) => sum + g.turns.length, 0),
    [requestGroups]
  );

  // Aggregate all tool calls for file extraction
  const allToolCalls = useMemo(
    () => session.requests.flatMap((r) => r.toolCalls),
    [session.requests]
  );

  const usedTools = useMemo(() => {
    const used = new Set<string>();
    for (const group of requestGroups) {
      for (const turn of group.turns) {
        for (const [tool, count] of Object.entries(turn.toolCounts)) {
          if (count > 0) used.add(tool);
        }
      }
    }
    return TOOL_COLUMNS.filter((t) => used.has(t)) as string[];
  }, [requestGroups]);

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

  // Extract files touched (from tool calls) - FIXED: check both path and file_path
  const filesTouched = useMemo(() => {
    const files = new Map<string, { reads: number; writes: number; edits: number }>();
    for (const tc of allToolCalls) {
      const args = tc.arguments as Record<string, unknown>;
      let filePath: string | undefined;

      if (tc.toolName === 'Read' || tc.toolName === 'Write' || tc.toolName === 'Edit') {
        filePath = (args.path as string) || (args.file_path as string);
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

  const visibleFiles = filesTouched.slice(0, MAX_VISIBLE_FILES);
  const hasMoreFiles = filesTouched.length > MAX_VISIBLE_FILES;
  const visibleErrors = errors.slice(0, MAX_VISIBLE_LOGS);
  const hasMoreErrors = errors.length > MAX_VISIBLE_LOGS;

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
          Turns ({totalTurns})
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
            requestGroups={requestGroups}
            usedTools={usedTools}
            maxTurns={MAX_VISIBLE_TURNS}
            totalTurns={totalTurns}
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
  requestGroups,
  usedTools,
  maxTurns,
  totalTurns,
}: {
  requestGroups: RequestGroup[];
  usedTools: string[];
  maxTurns: number;
  totalTurns: number;
}) {
  if (totalTurns === 0) {
    return <div className="tab-empty">Waiting for LLM calls...</div>;
  }

  // Collect all turns with their request info, then take last N
  const allItems: Array<{ type: 'request'; data: RequestGroup } | { type: 'turn'; data: Turn; requestNum: number }> = [];

  for (const group of requestGroups) {
    // Always include request header if showing any turns from this group
    allItems.push({ type: 'request', data: group });
    for (const turn of group.turns) {
      allItems.push({ type: 'turn', data: turn, requestNum: group.requestNum });
    }
  }

  // Take from end, but make sure we include the request header for any shown turns
  const turnsToShow = Math.min(maxTurns, totalTurns);
  const hasMore = totalTurns > maxTurns;

  // Smart truncation: show last N turns while preserving request boundaries
  let visibleItems = allItems;
  if (hasMore) {
    // Count from end, keep track of which requests have visible turns
    let turnCount = 0;
    let cutoffIdx = allItems.length;
    for (let i = allItems.length - 1; i >= 0 && turnCount < turnsToShow; i--) {
      if (allItems[i].type === 'turn') {
        turnCount++;
      }
      cutoffIdx = i;
    }
    // Include preceding request header if needed
    if (cutoffIdx > 0 && allItems[cutoffIdx].type === 'turn') {
      // Find the request header for this turn
      for (let i = cutoffIdx - 1; i >= 0; i--) {
        if (allItems[i].type === 'request') {
          cutoffIdx = i;
          break;
        }
      }
    }
    visibleItems = allItems.slice(cutoffIdx);
  }

  const colSpan = usedTools.length + 5; // agent + model + tools + in + out + latency

  return (
    <>
      {hasMore && (
        <div className="tab-truncated">
          Last {turnsToShow} of {totalTurns}
        </div>
      )}
      <table className="turn-table">
        <TurnTableHeader usedTools={usedTools} />
        <tbody>
          {visibleItems.map((item, idx) => {
            if (item.type === 'request') {
              // Only show request row if there are multiple requests or it's not the first
              if (requestGroups.length > 1 || item.data.requestNum > 1) {
                return (
                  <UserRequestRow
                    key={`req-${item.data.requestId}`}
                    requestNum={item.data.requestNum}
                    goal={item.data.goal}
                    colSpan={colSpan}
                  />
                );
              }
              return null;
            }
            return (
              <TurnRow
                key={item.data.llmCall.id}
                index={item.data.turnIndex}
                llmCall={item.data.llmCall}
                toolCounts={item.data.toolCounts}
                usedTools={usedTools}
                objective={item.data.objective}
              />
            );
          })}
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
          {errors.length} of {totalCount}
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
          {files.length} of {totalCount}
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
