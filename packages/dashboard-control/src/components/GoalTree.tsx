/**
 * Collapsible Goal Hierarchy Tree
 */

import { useState } from 'react';
import type { GoalNode } from '@/lib/api';

interface GoalTreeItemProps {
  goal: GoalNode;
  level: number;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'var(--running)';
    case 'completed':
      return 'var(--success)';
    case 'failed':
      return 'var(--error)';
    case 'paused':
      return 'var(--warning)';
    default:
      return 'var(--text-muted)';
  }
}

function GoalTreeItem({ goal, level }: GoalTreeItemProps) {
  const [expanded, setExpanded] = useState(level < 2);
  const hasChildren = goal.children.length > 0;
  const rotateClass = expanded ? 'rotate-90' : '';

  return (
    <div style={{ marginLeft: level > 0 ? 16 : 0 }}>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          <svg
            className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${rotateClass}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        ) : (
          <div className="w-4" />
        )}

        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: statusColor(goal.status) }}
        />

        <span className="text-sm text-[var(--text-primary)] truncate flex-1">
          {goal.title}
        </span>

        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: statusColor(goal.status) + '20',
            color: statusColor(goal.status),
          }}
        >
          {goal.status}
        </span>

        {goal.priority > 0 && (
          <span className="text-xs text-[var(--text-muted)]">P{goal.priority}</span>
        )}
      </div>

      {goal.description && expanded && (
        <p
          className="text-xs text-[var(--text-muted)] pl-8 pr-2 pb-1"
          style={{ marginLeft: 16 }}
        >
          {goal.description}
        </p>
      )}

      {expanded && hasChildren && (
        <div className="border-l border-[var(--border-subtle)] ml-3">
          {goal.children.map((child) => (
            <GoalTreeItem key={child.id} goal={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

interface GoalTreeProps {
  goals: GoalNode[];
}

export function GoalTree({ goals }: GoalTreeProps) {
  if (goals.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        No goals defined
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {goals.map((goal) => (
        <GoalTreeItem key={goal.id} goal={goal} level={0} />
      ))}
    </div>
  );
}
