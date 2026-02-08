/**
 * Entity Subgraph — extract filepaths from session agent_events,
 * query entity_graph DB for relevant nodes and edges, return a
 * capped subgraph for the cockpit entity-graph panel.
 */

import type { EntityKind } from 'entity-graph';
import nodePath from 'path';
import { isRecord, asString, asBoolean } from './routes/utils.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SessionFile {
  filepath: string;
  status: 'read' | 'edited';
}

export interface SubgraphNode {
  id: string;
  kind: EntityKind;
  name: string;
  filepath: string;
  startLine: number | null;
  endLine: number | null;
  exported: boolean;
  edited: boolean;
}

export interface SubgraphEdge {
  type: 'calls' | 'owns';
  sourceId: string;
  targetId: string;
  meta?: string;
}

export interface SubgraphResponse {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  stats: {
    readFiles: number;
    editedFiles: number;
    totalNodes: number;
    totalEdges: number;
  };
}

// ── Filepath extraction ─────────────────────────────────────────────

const FILE_TOOLS: Record<string, 'read' | 'edited'> = {
  read: 'read',
  fileread: 'read',
  write: 'edited',
  filewrite: 'edited',
  edit: 'edited',
  fileedit: 'edited',
  batchedit: 'edited',
};

function normalizeSessionFilePath(filepath: string, workingDir?: string): string | null {
  const trimmed = filepath.trim();
  if (!trimmed) return null;

  const normalized = nodePath.normalize(trimmed).replace(/\\/g, '/');
  if (normalized.startsWith('./')) return normalized.slice(2);

  if (!workingDir || !nodePath.isAbsolute(normalized)) {
    return normalized;
  }

  const relative = nodePath.relative(workingDir, normalized).replace(/\\/g, '/');
  if (relative && !relative.startsWith('../') && relative !== '..' && !nodePath.isAbsolute(relative)) {
    return relative.startsWith('./') ? relative.slice(2) : relative;
  }

  return normalized;
}

function eventWorkItemId(entry: Record<string, unknown>): string | null {
  const topLevel = asString(entry.work_item_id) ?? asString(entry.workItemId) ?? asString(entry.workId);
  if (topLevel) return topLevel;

  const data = isRecord(entry.data) ? entry.data : {};
  return asString(data.work_item_id) ?? asString(data.workItemId) ?? asString(data.workId) ?? null;
}

export function extractSessionFiles(
  agentEvents: unknown[],
  options: { workingDir?: string; workItemId?: string } = {}
): SessionFile[] {
  const fileMap = new Map<string, 'read' | 'edited'>();

  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'tool_call') continue;
    if (options.workItemId && eventWorkItemId(entry) !== options.workItemId) continue;

    const data = isRecord(entry.data) ? entry.data : {};
    const rawToolName = asString(data.tool_name) ?? asString(data.toolName) ?? '';
    const normalized = rawToolName.toLowerCase().replace(/[_\s-]+/g, '');
    const classification = FILE_TOOLS[normalized];
    if (!classification) continue;

    // Only count completed+successful tool calls for edits; any call for reads
    const phase = asString(data.phase)?.toLowerCase();
    const success = asBoolean(data.success);
    if (classification === 'edited' && (phase !== 'completed' || success !== true)) continue;

    const args = isRecord(data.arguments) ? data.arguments : {};
    const rawFilepath = asString(args.path)
      ?? asString(args.file_path)
      ?? asString(args.filePath)
      ?? asString(args.absolute_path);
    if (!rawFilepath) continue;

    const filepath = normalizeSessionFilePath(rawFilepath, options.workingDir);
    if (!filepath) continue;

    const existing = fileMap.get(filepath);
    // edited trumps read
    if (!existing || (existing === 'read' && classification === 'edited')) {
      fileMap.set(filepath, classification);
    }
  }

  return Array.from(fileMap.entries()).map(([filepath, status]) => ({ filepath, status }));
}

// ── Subgraph query ──────────────────────────────────────────────────

const NODE_CAP = 50;

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  start_line: number | null;
  end_line: number | null;
  exported: boolean;
}

interface CallEdgeRow {
  caller_id: string;
  callee_id: string;
  site_line: number | null;
}

interface OwnsEdgeRow {
  owner_id: string;
  owned_id: string;
}

export async function buildSubgraph(
  sql: any,
  sessionFiles: SessionFile[]
): Promise<SubgraphResponse> {
  if (sessionFiles.length === 0) {
    return { nodes: [], edges: [], stats: { readFiles: 0, editedFiles: 0, totalNodes: 0, totalEdges: 0 } };
  }

  const editedPaths = new Set(sessionFiles.filter(f => f.status === 'edited').map(f => f.filepath));
  const readPaths = new Set(sessionFiles.filter(f => f.status === 'read').map(f => f.filepath));
  const allPaths = [...editedPaths, ...readPaths];

  // Fetch all entities for all session files in one query
  const allEntities: EntityRow[] = await sql`
    SELECT id, kind, name, filepath, start_line, end_line, exported
    FROM entity_graph.entities
    WHERE filepath = ANY(${allPaths})
    ORDER BY filepath, start_line ASC NULLS LAST
  `;

  // Separate: edited files get all entities, read-only files get only file-kind entities
  const nodeMap = new Map<string, SubgraphNode>();
  const editedEntityIds: string[] = [];

  for (const row of allEntities) {
    const isEdited = editedPaths.has(row.filepath);
    if (isEdited || row.kind === 'file') {
      nodeMap.set(row.id, {
        id: row.id,
        kind: row.kind as EntityKind,
        name: row.name,
        filepath: row.filepath,
        startLine: row.start_line,
        endLine: row.end_line,
        exported: row.exported,
        edited: isEdited,
      });
      if (isEdited && row.kind !== 'file') {
        editedEntityIds.push(row.id);
      }
    }
  }

  // Fetch 1-hop inbound callers for edited function/method entities
  const callerNodeIds = new Set<string>();
  if (editedEntityIds.length > 0) {
    const callerRows: EntityRow[] = await sql`
      SELECT DISTINCT e.id, e.kind, e.name, e.filepath, e.start_line, e.end_line, e.exported
      FROM entity_graph.entities e
      JOIN entity_graph.calls c ON c.caller_id = e.id
      WHERE c.callee_id = ANY(${editedEntityIds})
        AND e.id != ALL(${editedEntityIds})
    `;
    for (const row of callerRows) {
      if (!nodeMap.has(row.id)) {
        nodeMap.set(row.id, {
          id: row.id,
          kind: row.kind as EntityKind,
          name: row.name,
          filepath: row.filepath,
          startLine: row.start_line,
          endLine: row.end_line,
          exported: row.exported,
          edited: false,
        });
        callerNodeIds.add(row.id);
      }
    }
  }

  // Enforce NODE_CAP with priority pruning
  if (nodeMap.size > NODE_CAP) {
    pruneNodes(nodeMap, callerNodeIds, editedPaths, readPaths);
  }

  // Fetch edges (calls + owns) between surviving nodes
  const nodeIds = Array.from(nodeMap.keys());
  if (nodeIds.length === 0) {
    return {
      nodes: [],
      edges: [],
      stats: { readFiles: readPaths.size, editedFiles: editedPaths.size, totalNodes: 0, totalEdges: 0 },
    };
  }

  const [callEdges, ownsEdges]: [CallEdgeRow[], OwnsEdgeRow[]] = await Promise.all([
    sql`
      SELECT caller_id, callee_id, site_line
      FROM entity_graph.calls
      WHERE caller_id = ANY(${nodeIds}) AND callee_id = ANY(${nodeIds})
    `,
    sql`
      SELECT owner_id, owned_id
      FROM entity_graph.owns
      WHERE owner_id = ANY(${nodeIds}) AND owned_id = ANY(${nodeIds})
    `,
  ]);

  const edges: SubgraphEdge[] = [];
  for (const e of callEdges) {
    edges.push({
      type: 'calls',
      sourceId: e.caller_id,
      targetId: e.callee_id,
      ...(e.site_line != null ? { meta: String(e.site_line) } : {}),
    });
  }
  for (const e of ownsEdges) {
    edges.push({
      type: 'owns',
      sourceId: e.owner_id,
      targetId: e.owned_id,
    });
  }

  const nodes = Array.from(nodeMap.values());
  return {
    nodes,
    edges,
    stats: {
      readFiles: readPaths.size,
      editedFiles: editedPaths.size,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    },
  };
}

// ── Pruning ─────────────────────────────────────────────────────────

function pruneNodes(
  nodeMap: Map<string, SubgraphNode>,
  callerNodeIds: Set<string>,
  editedPaths: Set<string>,
  readPaths: Set<string>
): void {
  // Phase 1: drop 1-hop callers from non-edited files
  if (nodeMap.size > NODE_CAP) {
    for (const id of callerNodeIds) {
      const node = nodeMap.get(id);
      if (node && !editedPaths.has(node.filepath)) {
        nodeMap.delete(id);
        callerNodeIds.delete(id);
        if (nodeMap.size <= NODE_CAP) break;
      }
    }
  }

  // Phase 2: drop remaining 1-hop callers
  if (nodeMap.size > NODE_CAP) {
    for (const id of callerNodeIds) {
      nodeMap.delete(id);
      if (nodeMap.size <= NODE_CAP) break;
    }
  }

  // Phase 3: drop read-only file nodes (least connected → by id order as proxy)
  if (nodeMap.size > NODE_CAP) {
    for (const [id, node] of nodeMap) {
      if (readPaths.has(node.filepath) && !editedPaths.has(node.filepath)) {
        nodeMap.delete(id);
        if (nodeMap.size <= NODE_CAP) break;
      }
    }
  }
}
