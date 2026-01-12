import type { SessionState } from '@shared/domain/models';

interface StatusDotProps {
  status: SessionState;
}

export function StatusDot({ status }: StatusDotProps) {
  return <span className={`status-dot ${status}`} />;
}
