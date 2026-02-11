import { memo } from 'react';
import { useDragResize } from '@/hooks/use-resizable-layout';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  'aria-label'?: string;
}

export const ResizeHandle = memo(function ResizeHandle({ direction, onResize, 'aria-label': ariaLabel }: ResizeHandleProps) {
  const { startDrag } = useDragResize(onResize, direction);

  return (
    <div
      onMouseDown={startDrag}
      onTouchStart={startDrag}
      aria-label={ariaLabel ?? `Resize ${direction}`}
      className={`
        ${direction === 'horizontal'
          ? 'w-1.5 cursor-col-resize hover:bg-[var(--accent-cyan)]/10 active:bg-[var(--accent-cyan)]/20 border-l border-r border-transparent hover:border-[var(--accent-cyan)]/20'
          : 'h-1.5 cursor-row-resize hover:bg-[var(--accent-cyan)]/10 active:bg-[var(--accent-cyan)]/20 border-t border-b border-transparent hover:border-[var(--accent-cyan)]/20'
        }
        flex-shrink-0 transition-colors duration-150 touch-none select-none
        after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2
        ${direction === 'horizontal'
          ? 'after:w-0.5 after:h-4 after:bg-[var(--border-subtle)] after:rounded-full'
          : 'after:w-4 after:h-0.5 after:bg-[var(--border-subtle)] after:rounded-full'
        }
      `}
      style={{ position: 'relative' }}
    />
  );
});
