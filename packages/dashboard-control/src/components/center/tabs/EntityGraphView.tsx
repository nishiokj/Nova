import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '@/hooks/use-polling';
import { getCockpitEntityGraph } from '@/lib/api';
import type { SubgraphResponse } from '@/lib/api';

const POLL_INTERVAL = 5000;
const MAX_FILES = 120;
const MAX_FILES_PER_SYSTEM = 18;
const MIN_CANVAS_WIDTH = 840;
const MIN_CANVAS_HEIGHT = 300;

const SYSTEM_NODE_WIDTH = 220;
const SYSTEM_NODE_HEIGHT = 56;
const FILE_NODE_WIDTH = 220;
const FILE_NODE_HEIGHT = 34;
const FILE_COL_GAP = 18;
const FILE_ROW_GAP = 10;
const SYSTEM_BLOCK_GAP = 20;
const PADDING_X = 20;
const PADDING_Y = 18;

interface FocusFile {
  id: string;
  filepath: string;
  label: string;
  edited: boolean;
  systemId: string;
}

interface FocusSystem {
  id: string;
  label: string;
  files: FocusFile[];
  hiddenFiles: number;
  editedCount: number;
  readCount: number;
}

interface FocusModel {
  systems: FocusSystem[];
  totalEdited: number;
  totalRead: number;
  totalVisibleFiles: number;
  totalFiles: number;
}

interface LayoutFile {
  file: FocusFile;
  x: number;
  y: number;
}

interface LayoutBlock {
  system: FocusSystem;
  x: number;
  y: number;
  width: number;
  height: number;
  systemX: number;
  systemY: number;
  files: LayoutFile[];
}

interface FocusLayout {
  width: number;
  height: number;
  blocks: LayoutBlock[];
}

function graphSignature(graph: SubgraphResponse): string {
  const nodes = graph.nodes
    .map((n) => [n.id, n.kind, n.name, n.filepath, n.startLine ?? '', n.endLine ?? '', n.exported ? 1 : 0, n.edited ? 1 : 0].join('|'))
    .sort();
  const edges = graph.edges
    .map((e) => [e.type, e.sourceId, e.targetId, e.meta ?? ''].join('|'))
    .sort();
  const stats = [graph.stats.readFiles, graph.stats.editedFiles, graph.stats.totalNodes, graph.stats.totalEdges].join('|');
  return `${stats}::${nodes.join('||')}::${edges.join('||')}`;
}

function filenameOf(filepath: string): string {
  const parts = filepath.split('/');
  return parts[parts.length - 1] || filepath;
}

function dirnameOf(filepath: string): string {
  const parts = filepath.split('/');
  if (parts.length <= 1) return '.';
  return parts.slice(0, -1).join('/');
}

function systemForFilepath(filepath: string): { id: string; label: string } {
  const parts = filepath.split('/').filter(Boolean);
  if (parts.length === 0) return { id: 'root', label: 'root' };

  if (parts[0] === 'packages' && parts[1]) {
    const label = `packages/${parts[1]}`;
    return { id: label, label };
  }
  if (parts[0] === 'apps' && parts[1]) {
    const label = `apps/${parts[1]}`;
    return { id: label, label };
  }
  if (parts[0] === 'services' && parts[1]) {
    const label = `services/${parts[1]}`;
    return { id: label, label };
  }
  if (parts[0] === 'src' && parts[1]) {
    const label = `src/${parts[1]}`;
    return { id: label, label };
  }
  return { id: parts[0], label: parts[0] };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function buildFocusModel(data: SubgraphResponse): FocusModel {
  const fileByPath = new Map<string, FocusFile>();

  for (const node of data.nodes) {
    if (node.kind !== 'file') continue;
    const filepath = node.filepath || node.name;
    const existing = fileByPath.get(filepath);
    if (existing) {
      if (node.edited) existing.edited = true;
      continue;
    }
    const system = systemForFilepath(filepath);
    fileByPath.set(filepath, {
      id: node.id,
      filepath,
      label: filenameOf(filepath),
      edited: node.edited,
      systemId: system.id,
    });
  }

  const allFiles = Array.from(fileByPath.values()).sort((a, b) => {
    if (a.edited !== b.edited) return a.edited ? -1 : 1;
    return a.filepath.localeCompare(b.filepath);
  });

  const totalFiles = allFiles.length;
  const cappedFiles = allFiles.slice(0, MAX_FILES);
  const systemsMap = new Map<string, FocusSystem>();

  for (const file of cappedFiles) {
    const { id, label } = systemForFilepath(file.filepath);
    const existing = systemsMap.get(id);
    if (existing) {
      existing.files.push(file);
      if (file.edited) existing.editedCount += 1;
      else existing.readCount += 1;
      continue;
    }
    systemsMap.set(id, {
      id,
      label,
      files: [file],
      hiddenFiles: 0,
      editedCount: file.edited ? 1 : 0,
      readCount: file.edited ? 0 : 1,
    });
  }

  const systems = Array.from(systemsMap.values())
    .map((system) => {
      const sortedFiles = [...system.files].sort((a, b) => {
        if (a.edited !== b.edited) return a.edited ? -1 : 1;
        return a.filepath.localeCompare(b.filepath);
      });
      const visibleFiles = sortedFiles.slice(0, MAX_FILES_PER_SYSTEM);
      return {
        ...system,
        files: visibleFiles,
        hiddenFiles: Math.max(0, sortedFiles.length - visibleFiles.length),
      };
    })
    .sort((a, b) => {
      if (a.editedCount !== b.editedCount) return b.editedCount - a.editedCount;
      const aTotal = a.editedCount + a.readCount;
      const bTotal = b.editedCount + b.readCount;
      if (aTotal !== bTotal) return bTotal - aTotal;
      return a.label.localeCompare(b.label);
    });

  const totalEdited = cappedFiles.filter((f) => f.edited).length;
  const totalRead = cappedFiles.length - totalEdited;
  return {
    systems,
    totalEdited,
    totalRead,
    totalVisibleFiles: cappedFiles.length,
    totalFiles,
  };
}

function buildLayout(model: FocusModel, width: number, minHeight: number): FocusLayout {
  if (model.systems.length === 0) {
    return { width, height: minHeight, blocks: [] };
  }

  const fileAreaX = PADDING_X + SYSTEM_NODE_WIDTH + 84;
  const availableFileWidth = Math.max(1, width - fileAreaX - PADDING_X);
  const fileColumns = Math.max(
    1,
    Math.min(4, Math.floor((availableFileWidth + FILE_COL_GAP) / (FILE_NODE_WIDTH + FILE_COL_GAP)))
  );

  const blocks: LayoutBlock[] = [];
  let cursorY = PADDING_Y;

  for (const system of model.systems) {
    const fileRows = Math.max(1, Math.ceil(system.files.length / fileColumns));
    const fileGridHeight = fileRows * FILE_NODE_HEIGHT + Math.max(0, fileRows - 1) * FILE_ROW_GAP;
    const footerHeight = system.hiddenFiles > 0 ? 18 : 0;
    const blockHeight = Math.max(SYSTEM_NODE_HEIGHT + 8, fileGridHeight + 20 + footerHeight);

    const files: LayoutFile[] = [];
    for (let idx = 0; idx < system.files.length; idx += 1) {
      const row = Math.floor(idx / fileColumns);
      const col = idx % fileColumns;
      const x = fileAreaX + col * (FILE_NODE_WIDTH + FILE_COL_GAP);
      const y = cursorY + 10 + row * (FILE_NODE_HEIGHT + FILE_ROW_GAP);
      files.push({ file: system.files[idx], x, y });
    }

    const systemY = cursorY + (blockHeight - SYSTEM_NODE_HEIGHT) / 2;
    blocks.push({
      system,
      x: PADDING_X,
      y: cursorY,
      width: width - PADDING_X * 2,
      height: blockHeight,
      systemX: PADDING_X,
      systemY,
      files,
    });

    cursorY += blockHeight + SYSTEM_BLOCK_GAP;
  }

  const height = Math.max(minHeight, cursorY + PADDING_Y);
  return { width, height, blocks };
}

export function EntityGraphView({ sessionKey }: { sessionKey?: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastSignatureRef = useRef<string | null>(null);
  const [data, setData] = useState<SubgraphResponse | null>(null);
  const [viewport, setViewport] = useState({ width: MIN_CANVAS_WIDTH, height: MIN_CANVAS_HEIGHT });

  const fetchGraph = useCallback(async () => {
    if (!sessionKey) {
      lastSignatureRef.current = null;
      setData(null);
      return;
    }
    const result = await getCockpitEntityGraph(sessionKey);
    const nextSignature = `${sessionKey}::${graphSignature(result)}`;
    if (lastSignatureRef.current === nextSignature) return;
    lastSignatureRef.current = nextSignature;
    setData(result);
  }, [sessionKey]);

  usePolling(fetchGraph, POLL_INTERVAL);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const syncSize = () => {
      setViewport({
        width: Math.max(MIN_CANVAS_WIDTH, el.clientWidth),
        height: Math.max(MIN_CANVAS_HEIGHT, el.clientHeight),
      });
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => (data ? buildFocusModel(data) : null), [data]);
  const layout = useMemo(
    () => (model ? buildLayout(model, viewport.width, viewport.height) : null),
    [model, viewport.width, viewport.height]
  );

  if (!sessionKey) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No session selected</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">
          Select a session to view its focus map.
        </div>
      </div>
    );
  }

  if (!model || model.totalVisibleFiles === 0 || !layout) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No focus data yet</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">
          The map appears after the agent reads or edits files.
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full w-full min-h-0">
      <div className="shrink-0 px-2 py-1 text-[11px] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
        Focus Map
        {' · '}
        {model.systems.length} systems
        {' · '}
        {model.totalEdited} edited
        {' · '}
        {model.totalRead} read
        {model.totalFiles > model.totalVisibleFiles && (
          <>
            {' · '}
            showing {model.totalVisibleFiles}/{model.totalFiles} files
          </>
        )}
      </div>

      <div ref={viewportRef} className="flex-1 min-h-0 relative overflow-auto">
        <svg width={layout.width} height={layout.height} className="block">
          {layout.blocks.map((block) => {
            const systemCenterY = block.systemY + SYSTEM_NODE_HEIGHT / 2;
            const systemRightX = block.systemX + SYSTEM_NODE_WIDTH;
            return (
              <g key={block.system.id}>
                <rect
                  x={block.x}
                  y={block.y}
                  width={block.width}
                  height={block.height}
                  rx={8}
                  fill="var(--bg-surface)"
                  stroke="var(--border-subtle)"
                  strokeWidth={1}
                  opacity={0.9}
                />

                <rect
                  x={block.systemX}
                  y={block.systemY}
                  width={SYSTEM_NODE_WIDTH}
                  height={SYSTEM_NODE_HEIGHT}
                  rx={8}
                  fill={block.system.editedCount > 0 ? 'var(--accent-cyan)' : 'var(--bg-elevated)'}
                  fillOpacity={block.system.editedCount > 0 ? 0.18 : 0.8}
                  stroke={block.system.editedCount > 0 ? 'var(--running)' : 'var(--border-default)'}
                  strokeWidth={1}
                />
                <text
                  x={block.systemX + 10}
                  y={block.systemY + 21}
                  fill="var(--text-primary)"
                  fontSize="12"
                  fontWeight="600"
                >
                  {truncate(block.system.label, 26)}
                </text>
                <text
                  x={block.systemX + 10}
                  y={block.systemY + 38}
                  fill="var(--text-secondary)"
                  fontSize="10"
                >
                  {block.system.editedCount} edited, {block.system.readCount} read
                </text>

                {block.files.map(({ file, x, y }) => (
                  <g key={file.id}>
                    <line
                      x1={systemRightX}
                      y1={systemCenterY}
                      x2={x}
                      y2={y + FILE_NODE_HEIGHT / 2}
                      stroke={file.edited ? 'var(--running)' : 'var(--border-default)'}
                      strokeOpacity={file.edited ? 0.55 : 0.35}
                      strokeWidth={file.edited ? 1.2 : 1}
                    />
                    <rect
                      x={x}
                      y={y}
                      width={FILE_NODE_WIDTH}
                      height={FILE_NODE_HEIGHT}
                      rx={6}
                      fill={file.edited ? 'var(--running)' : 'var(--bg-elevated)'}
                      fillOpacity={file.edited ? 0.14 : 0.85}
                      stroke={file.edited ? 'var(--running)' : 'var(--border-default)'}
                      strokeWidth={1}
                    >
                      <title>{file.filepath}</title>
                    </rect>
                    <text
                      x={x + 8}
                      y={y + 14}
                      fill={file.edited ? 'var(--text-primary)' : 'var(--text-secondary)'}
                      fontSize="10"
                      fontWeight={file.edited ? '600' : '500'}
                    >
                      {truncate(file.label, 30)}
                    </text>
                    <text
                      x={x + 8}
                      y={y + 26}
                      fill="var(--text-muted)"
                      fontSize="9"
                    >
                      {truncate(dirnameOf(file.filepath), 34)}
                    </text>
                  </g>
                ))}

                {block.system.hiddenFiles > 0 && (
                  <text
                    x={block.systemX + SYSTEM_NODE_WIDTH + 88}
                    y={block.y + block.height - 6}
                    fill="var(--text-muted)"
                    fontSize="10"
                  >
                    +{block.system.hiddenFiles} more files
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
