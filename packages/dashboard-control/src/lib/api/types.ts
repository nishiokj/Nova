/**
 * Control Plane API — shared type definitions.
 * Zero runtime cost — all erased at compile time.
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  activeGoals: number;
  activeSessions?: number;
  gitRemote?: { owner: string; repo: string } | null;
}

export interface Feature {
  id: string;
  name: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  sessionCount: number;
}

export interface Session {
  id: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: string;
  lastAccessedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

export interface GoalNode {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  deadline: string | null;
  children: GoalNode[];
}

export interface TokenUsage {
  provider: string;
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface TraceRecord {
  id: string;
  version: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash?: string }>;
    }>;
  }>;
}

export interface GitInfo {
  currentBranch: string;
  remote?: { owner: string; repo: string };
  uncommittedChanges: number;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
}

export type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
export type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

export interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

export interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

export interface DailyMetrics {
  tokens: number;
  locTouched: number;
  commits: number;
  prs: number;
  tests: number;
  sessions: {
    running: number;
    ready: number;
    done: number;
  };
  escalationsOpen: number;
}

export interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

export interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

export interface CockpitRollupSnapshot {
  runningSessions: SessionRollup[];
  readySessions: SessionRollup[];
  doneSessions: SessionRollup[];
  escalations: EscalationRollup[];
  commitRollups: CommitRollup[];
  prRollups: PRRollup[];
  metrics: DailyMetrics | null;
  metricsDate: string;
  generatedAt: string;
  error?: string;
}

export interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

export interface FocusData {
  type: 'session' | 'escalation';
  id: string;
  sessionKey: string;
  header: Record<string, unknown>;
  packet: FocusPacket | null;
  pointers: Record<string, string>;
}

export interface CockpitSessionPermissionRule {
  tool: 'Bash' | 'Write' | 'Edit';
  pattern: string;
}

export interface CockpitSessionPermissionState {
  persistent: {
    allow: CockpitSessionPermissionRule[];
    deny: CockpitSessionPermissionRule[];
  };
  sessionGrants: CockpitSessionPermissionRule[];
  sessionDenials: CockpitSessionPermissionRule[];
  dangerousMode: boolean;
  allowOutsideRoot?: boolean;
  webSearchEnabled?: boolean;
  writesNoDeletes?: boolean;
  restrictWriteToPaths?: string[];
}

export interface CockpitSessionPermissions {
  sessionKey: string;
  workingDir: string;
  rootLabel: string;
  state: CockpitSessionPermissionState;
  customConfigPath: string;
  customConfigExists: boolean;
  customConfigJson: string | null;
  warning?: string;
}

export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

export interface CockpitDiff {
  baseSha: string;
  headSha: string;
  source: 'query' | 'session' | 'git-parent' | 'working-tree' | 'unknown';
  summary: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  hotspots: DiffHotspot[];
  patch: string | null;
}

export interface CockpitTestReport {
  id: string;
  sessionKey: string;
  workItemId: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
  cliOutput: string;
  command: string;
  coverage: Record<string, unknown> | null;
  mutationScore: number | null;
  agentNote: string;
  durationMs: number;
  createdAt: string;
}

export interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface PostCockpitPacketInput {
  sessionKey: string;
  packetId?: string;
  workItemId?: string;
  escalationId?: string;
  type?: 'escalation' | 'review' | 'session' | 'ready' | 'ready_review' | 'pr_review';
  markdown?: string;
  contentMarkdown?: string;
  markdownPath?: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  createdAt?: string | number;
  source?: string;
  requestId?: string;
}

export interface CockpitSessionControlInput {
  action: 'start' | 'stop' | 'fork';
  message?: string;
  note?: string;
  targetSessionKey?: string;
}

export interface CockpitSessionReviewDecisionInput {
  decision: 'accept' | 'request_changes';
  note?: string;
  requestId?: string;
}

export interface CockpitSessionPermissionUpdateInput {
  profile?: 'default' | 'writes_only' | 'websearch_enabled' | 'outside_root' | 'custom';
  dangerousMode?: boolean;
  allowOutsideRoot?: boolean;
  webSearchEnabled?: boolean;
  writesNoDeletes?: boolean;
  restrictWriteToPaths?: string[] | null;
  customJson?: string;
}

export interface CockpitPatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface CockpitPatchApplyInput {
  sessionKey: string;
  baseSha?: string;
  patch?: string;
  edits?: CockpitPatchEditInput[];
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserActionInput {
  sessionKey: string;
  action: 'open' | 'back' | 'forward' | 'reload' | 'snapshot' | 'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll' | 'get_url' | 'get_title' | 'screenshot' | 'close';
  url?: string;
  target?: string;
  text?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserEvidence {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

export interface CockpitFilesystemRoot {
  id: string;
  kind: 'notes' | 'project';
  label: string;
  path: string;
  pinned: boolean;
  source: 'daemon' | 'session-db' | 'discovered';
  sessionCount?: number;
  sessionKey?: string;
}

export interface CockpitBrowserState {
  sessionKey: string;
  cwd: string;
  browserSession: string;
  available: boolean;
  connected: boolean;
  currentUrl?: string;
  title?: string;
  lastActionAt?: string;
  actions: Array<Record<string, unknown>>;
  evidence: CockpitBrowserEvidence[];
  filesystemRoots?: CockpitFilesystemRoot[];
  lastSnapshotPath?: string;
  lastSnapshotPreview?: string;
}

export interface CockpitFilesystemState {
  cwd: string;
  roots: CockpitFilesystemRoot[];
}

export interface CockpitMarkdownScope {
  mode: 'global' | 'session' | 'project';
  workingDir: string;
  sessionKey?: string;
  projectPath?: string;
}

export interface CockpitMarkdownScopeInput {
  sessionKey?: string;
  projectPath?: string;
}

export interface CockpitMarkdownTreeNode {
  type: 'folder' | 'file';
  name: string;
  path: string;
  children?: CockpitMarkdownTreeNode[];
  size?: number;
  updatedAt?: string;
  version?: number;
}

export interface CockpitMarkdownFile {
  path: string;
  content: string;
  version: number;
  updatedAt: string;
  size: number;
  hash?: string;
  etag?: string;
  lineCount?: number;
  wordCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CockpitMarkdownContextInput {
  path?: string;
  workspaceScope?: 'global' | 'session' | 'project';
  scopeMode?: 'global' | 'session' | 'project';
  scopeSessionKey?: string;
  workspaceSessionKey?: string;
  projectPath?: string;
  workspaceProjectPath?: string;
  version?: number;
  updatedAt?: string;
  content?: string;
  isDirty?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  metadata?: Record<string, unknown>;
}

export type EntityKind = 'file' | 'class' | 'function' | 'method' | 'type' | 'interface' | 'enum';

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

export interface WorkItemSpec {
  id: string;
  objective: string;
  agent: string;
  dependencies: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkItemTemplate {
  id: string;
  name: string;
  description: string;
  specs: WorkItemSpec[];
  createdAt?: string | number;
  updatedAt?: string | number;
}
