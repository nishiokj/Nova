import type { Session, AgentRequest } from '@shared/domain/models';
import { formatDuration } from '@shared/lib/time';
import { TurnTable } from './TurnTable';
import { StatusDot } from './StatusDot';
import { formatTokens } from './formatters';

interface SessionRowProps {
  session: Session;
  expanded: boolean;
  onToggle: () => void;
}

export function SessionRow({ session, expanded, onToggle }: SessionRowProps) {
  const { insights, meta } = session;
  const shortId = session.id.slice(0, 8);
  const description = (meta.description as string) || session.requests[0]?.userInput || '-';

  return (
    <>
      <tr
        onClick={onToggle}
        className="bg-hover cursor-pointer border-b"
      >
        <td className="py-1 px-2">
          <StatusDot status={session.state} />
        </td>
        <td className="py-1 px-2 font-mono text-xs">{shortId}</td>
        <td className="py-1 px-2 truncate max-w-xs">{description}</td>
        <td className="py-1 px-2 text-right tabular-nums">
          {insights.requestCount}
        </td>
        <td className="py-1 px-2 text-right tabular-nums text-cyan">
          {formatTokens(insights.totalInputTokens)}
        </td>
        <td className="py-1 px-2 text-right tabular-nums text-green">
          {formatTokens(insights.totalOutputTokens)}
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {formatDuration(insights.durationMs)}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <div className="bg-elevated border-b p-2">
              {session.requests.map((req, i) => (
                <RequestDetail key={req.id} request={req} index={i} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface RequestDetailProps {
  request: AgentRequest;
  index: number;
}

function RequestDetail({ request, index }: RequestDetailProps) {
  const inputTruncated = request.userInput.length > 100
    ? request.userInput.slice(0, 100) + '...'
    : request.userInput;

  return (
    <div style={{ marginBottom: index < 1000 ? '12px' : 0 }}>
      <div
        className="text-muted text-xs"
        style={{ marginBottom: '4px' }}
      >
        Request {index + 1}: {inputTruncated}
      </div>
      <TurnTable llmCalls={request.llmCalls} toolCalls={request.toolCalls} />
    </div>
  );
}
