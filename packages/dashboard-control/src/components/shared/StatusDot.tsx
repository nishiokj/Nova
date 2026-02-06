import { statusColor } from '@/lib/format';

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: statusColor(status) }}
    />
  );
}
