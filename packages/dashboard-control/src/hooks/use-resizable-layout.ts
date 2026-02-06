import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizableLayoutState {
  leftWidth: number;
  rightWidth: number;
}

const MIN_LEFT_WIDTH = 180; // 11.25rem
const MAX_LEFT_WIDTH = 500; // 31.25rem
const MIN_RIGHT_WIDTH = 220; // 13.75rem
const MAX_RIGHT_WIDTH = 600; // 37.5rem
const STORAGE_KEY = 'cockpit-layout';

// Default sizes
const DEFAULTS: ResizableLayoutState = {
  leftWidth: 224, // 14rem
  rightWidth: 320, // 20rem
};

function loadFromStorage(): Partial<ResizableLayoutState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      leftWidth: typeof parsed.leftWidth === 'number' ? Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, parsed.leftWidth)) : undefined,
      rightWidth: typeof parsed.rightWidth === 'number' ? Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, parsed.rightWidth)) : undefined,
    };
  } catch {
    return null;
  }
}

function saveToStorage(state: ResizableLayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

export function useResizableLayout() {
  const [layout, setLayout] = useState<ResizableLayoutState>(() => {
    const saved = loadFromStorage();
    return {
      leftWidth: saved?.leftWidth ?? DEFAULTS.leftWidth,
      rightWidth: saved?.rightWidth ?? DEFAULTS.rightWidth,
    };
  });

  // Persist changes to localStorage
  useEffect(() => {
    saveToStorage(layout);
  }, [layout]);

  const setLeftWidth = useCallback((width: number) => {
    setLayout(prev => ({ ...prev, leftWidth: Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, width)) }));
  }, []);

  const setRightWidth = useCallback((width: number) => {
    setLayout(prev => ({ ...prev, rightWidth: Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, width)) }));
  }, []);

  return {
    layout,
    setLeftWidth,
    setRightWidth,
    bounds: {
      left: { min: MIN_LEFT_WIDTH, max: MAX_LEFT_WIDTH },
      right: { min: MIN_RIGHT_WIDTH, max: MAX_RIGHT_WIDTH },
    },
  };
}

// Hook for handling drag-to-resize
export function useDragResize(
  onResize: (delta: number) => void,
  direction: 'horizontal' | 'vertical' = 'horizontal'
) {
  const isDraggingRef = useRef(false);
  const startPosRef = useRef(0);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const startDrag = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const isHorizontal = direction === 'horizontal';
    startPosRef.current = isHorizontal
      ? ('clientX' in e ? e.clientX : e.touches[0].clientX)
      : ('clientY' in e ? e.clientY : e.touches[0].clientY);

    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;
      const clientPos = isHorizontal
        ? ('clientX' in moveEvent ? moveEvent.clientX : moveEvent.touches[0].clientX)
        : ('clientY' in moveEvent ? moveEvent.clientY : moveEvent.touches[0].clientY);
      const delta = clientPos - startPosRef.current;
      startPosRef.current = clientPos;
      onResizeRef.current(delta);
    };

    const handleEnd = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction]);

  return { startDrag };
}
