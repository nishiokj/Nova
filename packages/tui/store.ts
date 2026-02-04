import { computeInputLayout, InputBuffer } from "./buffer.js";
import type { MessageEntry, Role, TUIState, UIMode, WizardType, AgentQuestion, QuestionType, EventLevel, EventKind, ResponseContent, ModelEntry, SessionEntry, UsageSessionSummary, UsageDayStats, UsageProviderStats, RalphCompletionReason, PermissionRequestData, TextSegment } from "./types.js";
import { fuzzyMatch } from "./file_cache.js";
import { SLASH_COMMANDS } from "./commands.js";
import { highlightCode, isLanguageSupported } from "./utils/syntax.js";
import { toGatewayModel } from "types";

/**
 * TUI Store - Central state management for the terminal UI
 *
 * DOMAINS:
 *   Core         - state, status, progress, session, request count
 *   History      - message history, pruning, caching
 *   Streaming    - response streaming with throttling
 *   Reasoning    - extended thinking display
 *   Input        - text buffer, cursor, autocomplete
 *   UI Mode      - mode switching, scroll, visibility flags
 *   Question     - interactive prompts, multi-question sequences
 *   Models       - model list, cursor, selection per agent type
 *   Sessions     - session list, cursor
 *   Usage        - usage analytics, stats
 *   Ralph Loop   - autonomous loop state
 *   Wizard       - multi-step configuration flows
 *   Skills/Hooks - extension lists
 *   Capabilities - system feature flags
 *   Paste        - large paste handling
 *   Theme        - theme selection cursor
 *   Plan Mode    - planning mode flag
 *   Response     - modal content display
 *
 * PATTERNS:
 *   - List domains (models, sessions, usage): list + cursor + move + getSelected
 *   - All mutations call emit() at the end
 *   - batch() groups mutations into single emit
 *   - Streaming uses throttled emit for performance
 *
 * ADDING NEW STATE:
 *   1. Add private field in the appropriate domain section below
 *   2. Add to StoreSnapshot interface
 *   3. Add to getSnapshot() method
 *   4. Add methods in the corresponding METHODS section
 */

// Resource limits to prevent memory exhaustion
const MAX_STREAMING_BYTES = 5 * 1024 * 1024;  // 5MB - cap streaming text
const MAX_INPUT_LENGTH = 100 * 1024;           // 100KB - cap input buffer

const GATEWAY_PROVIDER_ID = "vercel-gateway";
const GATEWAY_MODEL_PROVIDERS = new Set<string>([
  "anthropic",
  "openai",
  "cerebras",
  "groq",
  "gemini",
  "z.ai-coder",
  "claude",
]);

function expandGatewayModels(models: ModelEntry[]): ModelEntry[] {
  if (models.length === 0) return models;

  const expanded: ModelEntry[] = [...models];
  const seen = new Set(models.map((model) => `${model.provider ?? ""}:${model.id}`));

  for (const model of models) {
    const provider = model.provider;
    if (!provider || provider === GATEWAY_PROVIDER_ID) continue;
    if (!GATEWAY_MODEL_PROVIDERS.has(provider)) continue;

    let gatewayId: string;
    try {
      gatewayId = toGatewayModel(model.id, provider);
    } catch {
      continue;
    }

    const key = `${GATEWAY_PROVIDER_ID}:${gatewayId}`;
    if (seen.has(key)) continue;

    expanded.push({
      ...model,
      id: gatewayId,
      provider: GATEWAY_PROVIDER_ID,
      name: model.provider ? `${model.name} (${model.provider})` : model.name,
    });
    seen.add(key);
  }

  return expanded;
}

export interface AutocompleteState {
  active: boolean;
  suggestions: string[];
  selected: number;
  startIndex: number;
}

export interface HistoryLine {
  id: string;
  text: string;
  /** Optional styled segments (overrides text for rendering if present) */
  segments?: TextSegment[];
  role?: Role;
  requestId?: string;
  isBlockStart?: boolean;  // First line of a message block
  isBlockEnd?: boolean;    // Last line of a message block (before separator)
}

export interface StoreSnapshot {
  state: TUIState;
  statusMessage: string;
  progressMessage: string;
  /** Semantic level of current progress for coloring */
  progressLevel: EventLevel | null;
  /** Kind of current progress for categorization */
  progressKind: EventKind | null;
  inputText: string;
  cursor: number;
  inputScrollOffset: number;
  autocomplete: AutocompleteState;
  history: MessageEntry[];
  streamingText: string;
  streamingRequestId: string | null;
  /** Reasoning/thinking content being streamed (displayed distinctly from response) */
  reasoningText: string;
  reasoningRequestId: string | null;
  scrollOffset: number;
  newMessages: boolean;
  voiceMode: boolean;
  helpVisible: boolean;
  sessionKey: string | null;
  uiMode: UIMode;
  wizardType: WizardType | null;
  wizardStepIndex: number;
  wizardData: Record<string, unknown>;
  wizardErrors: string[];
  skillsList: Record<string, unknown>[];
  hooksList: Record<string, unknown>[];
  skillsErrors: string[];
  hooksErrors: string[];
  capabilities: {
    voiceAvailable: boolean;
    streamingSupported: boolean;
  };
  requestCount: number;
  historyVersion: number;
  // Question flow state
  activeQuestion: AgentQuestion | null;
  questionSelection: number[];
  questionCursor: number;
  questionInput: string;
  questionQueue: AgentQuestion[];
  questionAnswers: Map<string, unknown>;
  questionRequestId: string | null;
  // Paste state
  pasteInProgress: boolean;
  pasteBytesReceived: number;
  // Theme selection
  themeCursor: number;
  // Plan mode
  planMode: boolean;
  // Response pane content
  responseContent: ResponseContent | null;
  // Models selection
  modelsList: ModelEntry[];
  modelsCursor: number;
  modelDeletePending: boolean;
  modelSelections: Map<string, { model: string; provider: string; reasoning?: string }>;
  stagedModelSelections: Map<string, { model: string; provider: string; reasoning?: string }>;
  modelsActiveTab: string;
  // Sessions selection
  sessionsList: SessionEntry[];
  sessionsCursor: number;
  // Usage view
  usageSessions: UsageSessionSummary[];
  usageCursor: number;
  usageViewMode: "list" | "detail" | "analytics";
  usageDayStats: UsageDayStats[];
  usageProviderStats: UsageProviderStats[];
  usageLoading: boolean;
  // Ralph Loop state
  ralphActive: boolean;
  ralphIteration: number;
  ralphMaxIterations: number;
  ralphCompletionPromise: string | null;
  // Permission prompt state
  activePermissionRequest: PermissionRequestData | null;
  permissionCursor: number;
  // Context window state
  contextInputTokens: number | null;
  contextMaxWindowSize: number | null;
  cachedInput: string | null;
  // LLM call state (last seen)
  lastLlmAgentType: string | null;
  lastLlmModel: string | null;
  lastLlmProvider: string | null;
}

const DEFAULT_MAX_HISTORY = 500;

export class Store {
  // ═══════════════════════════════════════════════════════════════════════════
  // STATE - All private fields grouped by domain
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Core ───
  private state: TUIState = "idle";
  private statusMessage = "Ready";
  private progressMessage = "";
  private progressLevel: EventLevel | null = null;
  private progressKind: EventKind | null = null;
  private sessionKey: string | null = null;
  private requestCount = 0;
  private listeners = new Set<() => void>();
  private batchDepth = 0;
  private batchDirty = false;

  // ─── History ───
  private history: MessageEntry[] = [];
  private historyStart = 0;
  private historyVersion = 0;
  private historyCache: { width: number; version: number; lines: HistoryLine[] } | null = null;
  private maxHistory: number;

  // ─── Streaming ───
  private streamingText = "";
  private streamingRequestId: string | null = null;
  private streamingTruncated = false;
  private streamingThrottleMs = 11; // ~90fps
  private lastStreamingEmit = 0;

  // ─── Reasoning ───
  private reasoningText = "";
  private reasoningRequestId: string | null = null;

  // ─── Input ───
  private inputBuffer = new InputBuffer();
  private inputScrollOffset = 0;
  private autocomplete: AutocompleteState = { active: false, suggestions: [], selected: 0, startIndex: -1 };

  // ─── UI Mode ───
  private uiMode: UIMode = "chat";
  private scrollOffset = 0;
  private newMessages = false;
  private helpVisible = false;
  private voiceMode = false;

  // ─── Question Flow ───
  private activeQuestion: AgentQuestion | null = null;
  private questionSelection: number[] = [];
  private questionCursor = 0;
  private questionInput = "";
  private questionQueue: AgentQuestion[] = [];
  private questionAnswers = new Map<string, unknown>();
  private questionRequestId: string | null = null;
  private questionProcessing = false;

  // ─── Models ───
  private modelsList: ModelEntry[] = [];
  private modelsCursor = 0;
  private modelDeletePending = false;
  private modelSelections = new Map<string, { model: string; provider: string; reasoning?: string }>();
  private stagedModelSelections = new Map<string, { model: string; provider: string; reasoning?: string }>();
  private modelsActiveTab = 'standard';

  // ─── Sessions ───
  private sessionsList: SessionEntry[] = [];
  private sessionsCursor = 0;

  // ─── Usage ───
  private usageSessions: UsageSessionSummary[] = [];
  private usageCursor = 0;
  private usageViewMode: "list" | "detail" | "analytics" = "list";
  private usageDayStats: UsageDayStats[] = [];
  private usageProviderStats: UsageProviderStats[] = [];
  private usageLoading = false;

  // ─── Ralph Loop ───
  private ralphActive = false;
  private ralphIteration = 0;
  private ralphMaxIterations = 0;
  private ralphCompletionPromise: string | null = null;

  // ─── Wizard ───
  private wizardType: WizardType | null = null;
  private wizardStepIndex = 0;
  private wizardData: Record<string, unknown> = {};
  private wizardErrors: string[] = [];

  // ─── Skills/Hooks ───
  private skillsList: Record<string, unknown>[] = [];
  private hooksList: Record<string, unknown>[] = [];
  private skillsErrors: string[] = [];
  private hooksErrors: string[] = [];

  // ─── Capabilities ───
  private capabilities = { voiceAvailable: false, streamingSupported: true };

  // ─── Paste ───
  private pasteInProgress = false;
  private pasteBytesReceived = 0;

  // ─── Theme ───
  private themeCursor = 0;

  // ─── Plan Mode ───
  private planMode = false;

  // ─── Response Pane ───
  private responseContent: ResponseContent | null = null;

  // ─── Permission Prompt ───
  private activePermissionRequest: PermissionRequestData | null = null;
  private permissionCursor = 0; // 0=Allow, 1=Always Allow, 2=Deny

  // ─── Context Window ───
  private contextInputTokens: number | null = null;
  private contextMaxWindowSize: number | null = null;
  private cachedInput: string | null = null;
  // ─── LLM Call ───
  private lastLlmAgentType: string | null = null;
  private lastLlmModel: string | null = null;
  private lastLlmProvider: string | null = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════════════════

  constructor(maxHistory = DEFAULT_MAX_HISTORY) {
    this.maxHistory = maxHistory;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CORE METHODS - subscribe, snapshot, emit, batch
  // ═══════════════════════════════════════════════════════════════════════════

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): StoreSnapshot {
    return {
      state: this.state,
      statusMessage: this.statusMessage,
      progressMessage: this.progressMessage,
      progressLevel: this.progressLevel,
      progressKind: this.progressKind,
      inputText: this.inputBuffer.getText(),
      cursor: this.inputBuffer.getCursor(),
      inputScrollOffset: this.inputScrollOffset,
      autocomplete: { ...this.autocomplete },
      history: this.history.slice(this.historyStart),
      streamingText: this.streamingText,
      streamingRequestId: this.streamingRequestId,
      reasoningText: this.reasoningText,
      reasoningRequestId: this.reasoningRequestId,
      scrollOffset: this.scrollOffset,
      newMessages: this.newMessages,
      voiceMode: this.voiceMode,
      helpVisible: this.helpVisible,
      sessionKey: this.sessionKey,
      uiMode: this.uiMode,
      wizardType: this.wizardType,
      wizardStepIndex: this.wizardStepIndex,
      wizardData: { ...this.wizardData },
      wizardErrors: [...this.wizardErrors],
      skillsList: [...this.skillsList],
      hooksList: [...this.hooksList],
      skillsErrors: [...this.skillsErrors],
      hooksErrors: [...this.hooksErrors],
      capabilities: { ...this.capabilities },
      requestCount: this.requestCount,
      historyVersion: this.historyVersion,
      // Question flow state
      activeQuestion: this.activeQuestion,
      questionSelection: [...this.questionSelection],
      questionCursor: this.questionCursor,
      questionInput: this.questionInput,
      questionQueue: [...this.questionQueue],
      questionAnswers: new Map(this.questionAnswers),
      questionRequestId: this.questionRequestId,
      // Paste state
      pasteInProgress: this.pasteInProgress,
      pasteBytesReceived: this.pasteBytesReceived,
      // Theme selection
      themeCursor: this.themeCursor,
      // Plan mode
      planMode: this.planMode,
      // Response pane content
      responseContent: this.responseContent,
      // Models selection
      modelsList: [...this.modelsList],
      modelsCursor: this.modelsCursor,
      modelDeletePending: this.modelDeletePending,
      modelSelections: new Map(this.modelSelections),
      stagedModelSelections: new Map(this.stagedModelSelections),
      modelsActiveTab: this.modelsActiveTab,
      // Sessions selection
      sessionsList: [...this.sessionsList],
      sessionsCursor: this.sessionsCursor,
      // Usage view
      usageSessions: [...this.usageSessions],
      usageCursor: this.usageCursor,
      usageViewMode: this.usageViewMode,
      usageDayStats: [...this.usageDayStats],
      usageProviderStats: [...this.usageProviderStats],
      usageLoading: this.usageLoading,
      // Ralph Loop state
      ralphActive: this.ralphActive,
      ralphIteration: this.ralphIteration,
      ralphMaxIterations: this.ralphMaxIterations,
      ralphCompletionPromise: this.ralphCompletionPromise,
      // Permission prompt state
      activePermissionRequest: this.activePermissionRequest,
      permissionCursor: this.permissionCursor,
      // Context window state
      contextInputTokens: this.contextInputTokens,
      contextMaxWindowSize: this.contextMaxWindowSize,
      cachedInput: this.cachedInput,
      // LLM call state
      lastLlmAgentType: this.lastLlmAgentType,
      lastLlmModel: this.lastLlmModel,
      lastLlmProvider: this.lastLlmProvider,
    };
  }

  private emit(): void {
    // If we're in a batch, mark dirty and defer
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    // Clone listeners to prevent modification during iteration
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      listener();
    }
  }

  private pruneHistory(): void {
    const activeLength = this.history.length - this.historyStart;
    if (activeLength <= this.maxHistory) {
      return;
    }

    this.historyStart += activeLength - this.maxHistory;

    if (this.historyStart > this.maxHistory && this.historyStart > 1000) {
      this.history = this.history.slice(this.historyStart);
      this.historyStart = 0;
    }
  }

  /**
   * Batch multiple mutations into a single emit.
   * Nested batches are supported - only the outermost batch triggers emit.
   */
  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        // Clone listeners to prevent modification during iteration
        const listeners = [...this.listeners];
        for (const listener of listeners) {
          listener();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setSessionKey(key: string | null): void {
    this.sessionKey = key;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI MODE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setUIMode(mode: UIMode): void {
    const previousMode = this.uiMode;
    this.uiMode = mode;

    // Reset scroll position based on mode type
    // Chat: start at bottom (newest content)
    // Lists (skills/hooks): start at top (first items)
    if (mode !== previousMode) {
      if (mode === "skills" || mode === "hooks") {
        // Will be clamped to maxScroll by the render logic
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
      } else {
        // Chat and other modes: start at bottom
        this.scrollOffset = 0;
      }
      this.newMessages = false;
    }

    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WIZARD METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  startWizard(type: WizardType, data: Record<string, unknown>): void {
    this.uiMode = "wizard";
    this.wizardType = type;
    this.wizardStepIndex = 0;
    this.wizardData = { ...data };
    this.wizardErrors = [];
    this.emit();
  }

  updateWizard(data: Record<string, unknown>, stepIndex?: number): void {
    this.wizardData = { ...data };
    if (stepIndex !== undefined) {
      this.wizardStepIndex = stepIndex;
    }
    this.wizardErrors = [];
    this.emit();
  }

  setWizardErrors(errors: string[]): void {
    this.wizardErrors = [...errors];
    this.emit();
  }

  exitWizard(): void {
    this.uiMode = "chat";
    this.wizardType = null;
    this.wizardStepIndex = 0;
    this.wizardData = {};
    this.wizardErrors = [];
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SKILLS/HOOKS METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setSkillsList(items: Record<string, unknown>[], errors?: string[]): void {
    this.skillsList = [...items];
    this.skillsErrors = errors ? [...errors] : [];
    this.emit();
  }

  setHooksList(items: Record<string, unknown>[], errors?: string[]): void {
    this.hooksList = [...items];
    this.hooksErrors = errors ? [...errors] : [];
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAPABILITIES METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setCapabilities(capabilities: { voiceAvailable?: boolean; streamingSupported?: boolean }): void {
    this.capabilities = {
      voiceAvailable: capabilities.voiceAvailable ?? this.capabilities.voiceAvailable,
      streamingSupported: capabilities.streamingSupported ?? this.capabilities.streamingSupported,
    };
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS/STATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setState(state: TUIState, message?: string): void {
    this.state = state;
    if (message) {
      this.statusMessage = message;
    } else if (!this.progressMessage) {
      this.statusMessage = defaultStatusFor(state);
    }
    this.emit();
  }

  setStatus(message: string): void {
    this.statusMessage = message;
    this.emit();
  }

  setProgress(message: string, level?: EventLevel, kind?: EventKind): void {
    this.progressMessage = message;
    this.progressLevel = level ?? null;
    this.progressKind = kind ?? null;
    this.emit();
  }

  clearProgress(): void {
    this.progressMessage = "";
    this.progressLevel = null;
    this.progressKind = null;
    this.emit();
  }

  setError(message: string): void {
    this.state = "error";
    this.statusMessage = message;
    this.emit();
  }

  clearError(): void {
    if (this.state === "error") {
      this.state = "idle";
      this.statusMessage = "Ready";
      this.emit();
    }
  }

  /**
   * Invalidates the history cache, forcing a full re-wrap on next render.
   * Call this on terminal resize to ensure text is re-wrapped for new width.
   */
  invalidateHistoryCache(): void {
    this.historyCache = null;
    this.historyVersion += 1;
    this.emit();
  }

  setVoiceMode(enabled: boolean): void {
    this.voiceMode = enabled;
    this.emit();
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.emit();
  }

  setHelpVisible(visible: boolean): void {
    this.helpVisible = visible;
    this.emit();
  }

  incrementRequestCount(): number {
    this.requestCount += 1;
    this.emit();
    return this.requestCount;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HISTORY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  addMessage(role: Role, text: string, meta?: string, requestId?: string): void {
    const entry: MessageEntry = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role,
      text,
      timestamp: Date.now(),
      meta,
      requestId,
    };

    this.history.push(entry);
    this.pruneHistory();

    if (this.scrollOffset > 0) {
      this.newMessages = true;
    }

    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  updateMessageMeta(requestId: string, meta: string): void {
    for (let i = this.historyStart; i < this.history.length; i += 1) {
      const entry = this.history[i];
      if (entry.requestId === requestId) {
        entry.meta = meta;
        this.historyVersion += 1;
        this.historyCache = null;
        this.emit();
        return;
      }
    }
  }

  updateMessageText(requestId: string, text: string, meta?: string): void {
    for (let i = this.historyStart; i < this.history.length; i += 1) {
      const entry = this.history[i];
      if (entry.requestId === requestId) {
        entry.text = text;
        if (meta !== undefined) {
          entry.meta = meta;
        }
        this.historyVersion += 1;
        this.historyCache = null;
        this.emit();
        return;
      }
    }
  }

  clearHistory(): void {
    this.history = [];
    this.historyStart = 0;
    this.historyVersion += 1;
    this.historyCache = null;
    this.scrollOffset = 0;
    this.newMessages = false;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STREAMING METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setStreaming(requestId: string, text: string): void {
    this.streamingRequestId = requestId;
    this.streamingText = text;
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  appendStreaming(chunk: string): void {
    // Enforce streaming limit to prevent memory exhaustion
    if (this.streamingText.length + chunk.length > MAX_STREAMING_BYTES) {
      if (!this.streamingTruncated) {
        this.streamingTruncated = true;
        this.streamingText += '\n[Response truncated - exceeded 5MB limit]';
      }
      return;
    }

    this.streamingText += chunk;

    // Throttle emissions during streaming for better performance
    const now = Date.now();
    if (now - this.lastStreamingEmit >= this.streamingThrottleMs) {
      this.lastStreamingEmit = now;
      this.historyVersion += 1;  // Only increment when emitting
      this.emit();
    }
  }

  finalizeStreaming(): void {
    this.streamingRequestId = null;
    this.streamingText = "";
    this.streamingTruncated = false;
    this.historyVersion += 1;
    this.historyCache = null;
    // Always emit immediately on finalize - user needs to see the final response
    this.lastStreamingEmit = 0;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REASONING METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setReasoning(requestId: string, text: string): void {
    this.reasoningRequestId = requestId;
    this.reasoningText = text;
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  appendReasoning(chunk: string): void {
    // Use same limit as streaming to prevent memory exhaustion
    if (this.reasoningText.length + chunk.length > MAX_STREAMING_BYTES) {
      return;
    }

    this.reasoningText += chunk;

    // Throttle emissions during streaming for better performance
    const now = Date.now();
    if (now - this.lastStreamingEmit >= this.streamingThrottleMs) {
      this.lastStreamingEmit = now;
      this.historyVersion += 1;  // Only increment when emitting
      this.emit();
    }
  }

  finalizeReasoning(): void {
    this.reasoningRequestId = null;
    this.reasoningText = "";
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCROLL METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, offset);
    if (this.scrollOffset === 0) {
      this.newMessages = false;
    }
    this.emit();
  }

  scrollBy(delta: number, maxScroll: number): void {
    const next = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
    this.scrollOffset = next;
    if (this.scrollOffset === 0) {
      this.newMessages = false;
    }
    this.emit();
  }

  scrollToTop(maxScroll: number): void {
    this.scrollOffset = maxScroll;
    this.emit();
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
    this.newMessages = false;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INPUT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  insertInput(text: string): void {
    this.inputBuffer.insertText(text);
    this.emit();
  }

  replaceInput(text: string): void {
    this.inputBuffer.setText(text);
    this.emit();
  }

  clearInput(): void {
    this.inputBuffer.clear();
    this.clearAutocomplete();
    this.inputScrollOffset = 0;
    this.emit();
  }

  backspace(): void {
    this.inputBuffer.backspace();
    this.emit();
  }

  deleteForward(): void {
    this.inputBuffer.deleteForward();
    this.emit();
  }

  moveCursor(delta: number): void {
    this.inputBuffer.moveCursor(delta);
    this.emit();
  }

  moveCursorTo(position: number): void {
    this.inputBuffer.moveCursorTo(position);
    this.emit();
  }

  moveCursorUp(width: number, prompt: string): void {
    this.inputBuffer.moveCursorUp(width, prompt);
    this.emit();
  }

  moveCursorDown(width: number, prompt: string): void {
    this.inputBuffer.moveCursorDown(width, prompt);
    this.emit();
  }

  deleteWordBack(): void {
    this.inputBuffer.deleteWordBack();
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOCOMPLETE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  updateAutocomplete(fileCache: { getFiles: () => string[] }): void {
    const text = this.inputBuffer.getText();
    const cursor = this.inputBuffer.getCursor();

    // Check for slash command autocomplete first
    const slashTrigger = findSlashCommandTrigger(text, cursor);
    if (slashTrigger) {
      const { startIndex, query } = slashTrigger;
      const lowerQuery = query.toLowerCase();
      const suggestions = SLASH_COMMANDS.filter((cmd) =>
        cmd.toLowerCase().startsWith(lowerQuery)
      );
      if (suggestions.length > 0) {
        this.autocomplete = {
          active: true,
          suggestions,
          selected: Math.min(this.autocomplete.selected, suggestions.length - 1),
          startIndex,
        };
        this.emit();
        return;
      }
    }

    // Check for file autocomplete (@)
    const trigger = findAutocompleteTrigger(text, cursor);

    if (!trigger) {
      this.clearAutocomplete();
      return;
    }

    const { startIndex, query } = trigger;
    if (!query || /\s/.test(query)) {
      this.clearAutocomplete();
      return;
    }

    const suggestions = fuzzyMatch(query, fileCache.getFiles(), 8);
    if (!suggestions.length) {
      this.clearAutocomplete();
      return;
    }

    this.autocomplete = {
      active: true,
      suggestions,
      selected: Math.min(this.autocomplete.selected, suggestions.length - 1),
      startIndex,
    };
    this.emit();
  }

  selectAutocomplete(delta: number): void {
    if (!this.autocomplete.active) {
      return;
    }
    const count = this.autocomplete.suggestions.length;
    if (count === 0) {
      return;
    }
    const next = (this.autocomplete.selected + delta + count) % count;
    this.autocomplete.selected = next;
    this.emit();
  }

  acceptAutocomplete(): boolean {
    if (!this.autocomplete.active) {
      return false;
    }

    const suggestion = this.autocomplete.suggestions[this.autocomplete.selected];
    if (!suggestion) {
      return false;
    }

    const startIndex = this.autocomplete.startIndex;
    const cursor = this.inputBuffer.getCursor();
    // Slash commands already include the "/" prefix, file paths need "@" prefix
    const replacement = suggestion.startsWith("/") ? suggestion : `@${suggestion}`;
    this.inputBuffer.replaceRange(startIndex, cursor, replacement);
    this.clearAutocomplete();
    this.emit();
    return true;
  }

  clearAutocomplete(): void {
    this.autocomplete = {
      active: false,
      suggestions: [],
      selected: 0,
      startIndex: -1,
    };
    this.emit();
  }

  ensureInputCursorVisible(width: number, prompt: string, maxLines: number): void {
    const layout = computeInputLayout(
      this.inputBuffer.getRawBuffer(),
      this.inputBuffer.getCursor(),
      width,
      prompt,
    );
    const totalLines = layout.lines.length;
    let offset = this.inputScrollOffset;

    if (layout.cursorLine < offset) {
      offset = layout.cursorLine;
    } else if (layout.cursorLine >= offset + maxLines) {
      offset = layout.cursorLine - maxLines + 1;
    }

    const maxOffset = Math.max(0, totalLines - maxLines);
    offset = Math.max(0, Math.min(offset, maxOffset));

    if (offset !== this.inputScrollOffset) {
      this.inputScrollOffset = offset;
      this.emit();
    }
  }

  getHistoryLines(width: number, streamCursor: string): HistoryLine[] {
    if (
      this.historyCache &&
      this.historyCache.width === width &&
      this.historyCache.version === this.historyVersion
    ) {
      return this.historyCache.lines;
    }

    const lines = buildHistoryLines(
      this.history.slice(this.historyStart),
      this.streamingText ? `${this.streamingText}${streamCursor}` : "",
      this.reasoningText, // Pass reasoning text for distinct display
      width,
      this.streamingRequestId, // Pass streaming request ID for proper ordering
    );

    const normalizedLines = normalizeHistoryLines(lines, width);

    this.historyCache = {
      width,
      version: this.historyVersion,
      lines: normalizedLines,
    };

    return normalizedLines;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTION FLOW METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets the active question and enters question mode.
   * For single questions from the harness.
   */
  setActiveQuestion(question: AgentQuestion | null, requestId?: string): void {
    this.activeQuestion = question;
    this.questionSelection = [];
    this.questionCursor = 0;
    this.questionInput = question?.defaultValue || "";
    if (requestId) {
      this.questionRequestId = requestId;
    }
    if (question) {
      this.uiMode = "question";
    }
    this.emit();
  }

  /**
   * Sets a queue of questions to ask in sequence.
   */
  setQuestionQueue(questions: AgentQuestion[], requestId: string): void {
    this.questionQueue = questions.slice(1); // Queue all but the first
    this.questionAnswers.clear();
    this.questionRequestId = requestId;
    // Start with the first question
    if (questions.length > 0) {
      this.setActiveQuestion(questions[0], requestId);
    }
  }

  /**
   * Returns info about the question queue.
   */
  getQuestionQueueInfo(): { current: number; total: number } {
    const answered = this.questionAnswers.size;
    const remaining = this.questionQueue.length;
    const total = answered + remaining + (this.activeQuestion ? 1 : 0);
    return { current: answered + 1, total };
  }

  /**
   * Navigates up or down in the question options.
   */
  selectQuestionOption(delta: number): void {
    if (!this.activeQuestion?.options) return;
    const count = this.activeQuestion.options.length;
    if (count === 0) return;
    this.questionCursor = (this.questionCursor + delta + count) % count;
    this.emit();
  }

  /**
   * Toggles selection of the current option.
   * For single-select (multiple_choice, yes_no), replaces selection.
   * For multi-select, toggles the current option.
   */
  toggleQuestionSelection(): void {
    if (!this.activeQuestion) return;

    if (
      this.activeQuestion.type === "multiple_choice" ||
      this.activeQuestion.type === "yes_no" ||
      this.activeQuestion.type === "plan_mode_exit" ||
      this.activeQuestion.type === "spec_review"
    ) {
      // Single selection - replace
      this.questionSelection = [this.questionCursor];
    } else if (this.activeQuestion.type === "multi_select") {
      // Toggle selection
      const idx = this.questionSelection.indexOf(this.questionCursor);
      if (idx >= 0) {
        this.questionSelection.splice(idx, 1);
      } else {
        this.questionSelection.push(this.questionCursor);
      }
    }
    this.emit();
  }

  /**
   * Updates the text input for fill_in_blank/free_text questions.
   */
  setQuestionInput(text: string): void {
    // Enforce input limit
    this.questionInput = text.slice(0, MAX_INPUT_LENGTH);
    this.emit();
  }

  /**
   * Appends text to the question input.
   */
  appendQuestionInput(text: string): void {
    // Enforce input limit
    const available = MAX_INPUT_LENGTH - this.questionInput.length;
    if (available <= 0) return;
    this.questionInput += text.slice(0, available);
    this.emit();
  }

  /**
   * Backspaces one character from question input.
   */
  backspaceQuestionInput(): void {
    if (this.questionInput.length > 0) {
      this.questionInput = this.questionInput.slice(0, -1);
      this.emit();
    }
  }

  /**
   * Gets the answer in the appropriate format for the question type.
   */
  getQuestionAnswer(): unknown {
    if (!this.activeQuestion) return null;

    switch (this.activeQuestion.type) {
      case "multiple_choice":
      case "yes_no":
      case "plan_mode_exit":
      case "spec_review":
        if (this.questionSelection.length === 0) return null;
        return this.activeQuestion.options?.[this.questionSelection[0]]?.id;
      case "multi_select":
        return this.questionSelection.map(
          (i) => this.activeQuestion!.options![i]?.id
        );
      case "fill_in_blank":
      case "free_text":
        return this.questionInput;
      default:
        return null;
    }
  }

  /**
   * Saves the current answer and advances to next question or completes.
   * Returns true if there are more questions, false if done.
   */
  saveAnswerAndAdvance(): boolean {
    // Guard against re-entrance (rapid double-submit)
    if (this.questionProcessing || !this.activeQuestion) return false;
    this.questionProcessing = true;

    try {
      // Save the current answer
      const answer = this.getQuestionAnswer();
      this.questionAnswers.set(this.activeQuestion.requestId, answer);

      // Check if there are more questions in the queue
      if (this.questionQueue.length > 0) {
        const nextQuestion = this.questionQueue.shift()!;
        this.activeQuestion = nextQuestion;
        this.questionSelection = [];
        this.questionCursor = 0;
        this.questionInput = nextQuestion.defaultValue || "";
        this.emit();
        return true; // More questions remaining
      }

      return false; // No more questions
    } finally {
      this.questionProcessing = false;
    }
  }

  /**
   * Gets all collected answers (for multi-question flows).
   */
  getAllAnswers(): Map<string, unknown> {
    return new Map(this.questionAnswers);
  }

  /**
   * Gets the request ID for the current question flow.
   */
  getQuestionRequestId(): string | null {
    return this.questionRequestId;
  }

  /**
   * Clears the active question and returns to chat mode.
   */
  clearQuestion(): void {
    this.activeQuestion = null;
    this.questionSelection = [];
    this.questionCursor = 0;
    this.questionInput = "";
    this.questionQueue = [];
    this.questionAnswers.clear();
    this.questionRequestId = null;
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THEME METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enters theme selection mode with cursor at current theme.
   */
  enterThemeMode(currentIndex: number): void {
    this.themeCursor = currentIndex;
    this.uiMode = "theme";
    this.emit();
  }

  /**
   * Moves theme cursor up or down.
   */
  moveThemeCursor(delta: number, total: number): void {
    if (total <= 0) return;  // Guard against empty list
    this.themeCursor = (this.themeCursor + delta + total) % total;
    this.emit();
  }

  /**
   * Exits theme mode and returns to chat.
   */
  exitThemeMode(): void {
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAN MODE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets plan mode on or off.
   */
  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODELS METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets model selection for a specific agent type.
   */
  setModelSelection(agentType: string, selection: { model: string; provider: string; reasoning?: string } | null): void {
    if (selection) {
      this.modelSelections.set(agentType, selection);
    } else {
      this.modelSelections.delete(agentType);
    }
    this.emit();
  }

  /**
   * Gets model selection for a specific agent type.
   */
  getModelSelection(agentType: string): { model: string; provider: string; reasoning?: string } | null {
    return this.modelSelections.get(agentType) ?? null;
  }

  /**
   * Gets all model selections.
   */
  getAllModelSelections(): Map<string, { model: string; provider: string; reasoning?: string }> {
    return new Map(this.modelSelections);
  }

  /**
   * Sets the active tab for models view.
   */
  setModelsActiveTab(tab: string): void {
    this.modelsActiveTab = tab;
    // Update cursor to point to the selected model for this tab
    const selection = this.modelSelections.get(tab);
    if (selection && this.modelsList.length > 0) {
      const idx = this.modelsList.findIndex((m) => m.id === selection.model && m.provider === selection.provider);
      if (idx >= 0) {
        this.modelsCursor = idx;
      }
    }
    this.emit();
  }

  /**
   * Gets the active tab for models view.
   */
  getModelsActiveTab(): string {
    return this.modelsActiveTab;
  }

  /**
   * Updates the models list without changing UI mode.
   * Updates cursor to point to the selected model for the active tab.
   */
  updateModelsList(models: ModelEntry[]): void {
    this.modelsList = expandGatewayModels(models);
    // Update cursor position based on active tab's selection
    const selection = this.modelSelections.get(this.modelsActiveTab);
    const list = this.modelsList;
    if (selection && list.length > 0) {
      const idx = list.findIndex((m) => m.id === selection.model && m.provider === selection.provider);
      this.modelsCursor = Math.max(0, idx);
    } else {
      this.modelsCursor = 0;
    }
    this.emit();
  }

  /**
   * Sets the models list and enters models selection mode.
   * Copies current modelSelections to stagedModelSelections for editing.
   */
  setModelsList(models: ModelEntry[]): void {
    this.updateModelsList(models);
    // Initialize staged selections from current applied selections
    this.stagedModelSelections = new Map(this.modelSelections);
    this.uiMode = "models";
    this.emit();
  }

  /**
   * Moves models cursor up or down. Cancels any pending delete.
   */
  moveModelsCursor(delta: number): void {
    const count = this.modelsList.length;
    if (count === 0) return;
    this.modelDeletePending = false;
    this.modelsCursor = (this.modelsCursor + delta + count) % count;
    this.emit();
  }

  /**
   * Stages the model at the current cursor position for the active tab.
   * Does not apply to backend until applyAllStagedSelections is called.
   * Returns the staged model entry.
   */
  stageModelAtCursor(): ModelEntry | null {
    const model = this.modelsList[this.modelsCursor];
    if (model) {
      this.stagedModelSelections.set(this.modelsActiveTab, {
        model: model.id,
        provider: model.provider ?? '',
        reasoning: model.reasoning?.[0],
      });
      this.emit();
      return model;
    }
    return null;
  }

  /**
   * Gets the staged selection for a specific agent type.
   */
  getStagedSelection(agentType: string): { model: string; provider: string; reasoning?: string } | null {
    return this.stagedModelSelections.get(agentType) ?? null;
  }

  /**
   * Applies all staged selections - copies staged to modelSelections.
   * Returns the map of selections that changed (for sending to backend).
   */
  applyAllStagedSelections(): Map<string, { model: string; provider: string; reasoning?: string }> {
    // Find which selections actually changed
    const changed = new Map<string, { model: string; provider: string; reasoning?: string }>();
    for (const [agentType, staged] of this.stagedModelSelections) {
      const current = this.modelSelections.get(agentType);
      if (!current || current.model !== staged.model || current.provider !== staged.provider || current.reasoning !== staged.reasoning) {
        changed.set(agentType, staged);
      }
    }
    // Apply staged to actual selections
    this.modelSelections = new Map(this.stagedModelSelections);
    this.emit();
    return changed;
  }

  /**
   * Clears staged selections without applying.
   */
  clearStagedSelections(): void {
    this.stagedModelSelections.clear();
    this.emit();
  }

  /**
   * Legacy: Selects the model at the current cursor position for the active tab.
   * Returns the selected model entry.
   * @deprecated Use stageModelAtCursor and applyAllStagedSelections instead
   */
  selectModel(): ModelEntry | null {
    const model = this.modelsList[this.modelsCursor];
    if (model) {
      this.modelSelections.set(this.modelsActiveTab, {
        model: model.id,
        provider: model.provider ?? '',
        reasoning: model.reasoning?.[0],
      });
      this.emit();
      return model;
    }
    return null;
  }

  /**
   * Sets the selected model by ID for a specific agent type (used for external updates).
   */
  setSelectedModel(modelId: string | null, agentType?: string): void {
    const targetTab = agentType ?? this.modelsActiveTab;
    if (!modelId) {
      this.modelSelections.delete(targetTab);
      this.emit();
      return;
    }
    const model = this.modelsList.find((m) => m.id === modelId);
    if (model) {
      this.modelSelections.set(targetTab, {
        model: model.id,
        provider: model.provider ?? '',
        reasoning: model.reasoning?.[0],
      });
      if (targetTab === this.modelsActiveTab) {
        const idx = this.modelsList.findIndex((m) => m.id === modelId);
        if (idx >= 0) this.modelsCursor = idx;
      }
    }
    this.emit();
  }

  /**
   * Sets the selected model provider for the active tab (used for backend sync).
   */
  setSelectedProvider(provider: string | null): void {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (selection && provider) {
      this.modelSelections.set(this.modelsActiveTab, { ...selection, provider });
    }
    this.emit();
  }

  /**
   * Gets the currently selected model ID for the active tab.
   */
  getSelectedModel(): string | null {
    return this.modelSelections.get(this.modelsActiveTab)?.model ?? null;
  }

  /**
   * Gets the currently selected model provider for the active tab.
   */
  getSelectedProvider(): string | null {
    return this.modelSelections.get(this.modelsActiveTab)?.provider ?? null;
  }

  /**
   * Exits models mode and returns to chat. Clears pending delete and staged selections.
   */
  exitModelsMode(): void {
    this.modelDeletePending = false;
    this.stagedModelSelections.clear();
    this.uiMode = "chat";
    this.emit();
  }

  /**
   * Sets or clears the pending delete state.
   */
  setModelDeletePending(pending: boolean): void {
    this.modelDeletePending = pending;
    this.emit();
  }

  /**
   * Removes the model at the current cursor position from the local list.
   * Returns the removed model for sending a delete command to the harness.
   * Clears pending delete state.
   */
  removeModelAtCursor(): ModelEntry | null {
    this.modelDeletePending = false;
    if (this.modelsList.length === 0) return null;
    if (this.modelsCursor < 0 || this.modelsCursor >= this.modelsList.length) return null;

    const removed = this.modelsList[this.modelsCursor];
    this.modelsList = this.modelsList.filter((_, i) => i !== this.modelsCursor);

    // Adjust cursor if needed
    if (this.modelsCursor >= this.modelsList.length) {
      this.modelsCursor = Math.max(0, this.modelsList.length - 1);
    }

    // Clear any selections using this model
    for (const [agentType, selection] of this.modelSelections) {
      if (selection.model === removed.id) {
        this.modelSelections.delete(agentType);
      }
    }

    this.emit();
    return removed;
  }

  /**
   * Cycles to the next model in the models list for the active tab.
   * Returns the new model entry or null if no models available.
   */
  cycleToNextModel(): ModelEntry | null {
    if (this.modelsList.length === 0) return null;

    const selection = this.modelSelections.get(this.modelsActiveTab);
    let currentIdx = selection
      ? this.modelsList.findIndex((m) => m.id === selection.model)
      : -1;

    // Move to next model (wrap around)
    const nextIdx = (currentIdx + 1) % this.modelsList.length;
    const nextModel = this.modelsList[nextIdx];

    if (nextModel) {
      this.modelSelections.set(this.modelsActiveTab, {
        model: nextModel.id,
        provider: nextModel.provider ?? '',
        reasoning: nextModel.reasoning?.[0],
      });
      this.modelsCursor = nextIdx;
      this.emit();
      return nextModel;
    }
    return null;
  }

  /**
   * Gets the currently selected reasoning level for the active tab.
   */
  getSelectedReasoningLevel(): string | null {
    return this.modelSelections.get(this.modelsActiveTab)?.reasoning ?? null;
  }

  /**
   * Sets the reasoning level for the active tab.
   */
  setReasoningLevel(level: string | null): void {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (selection) {
      if (level) {
        this.modelSelections.set(this.modelsActiveTab, { ...selection, reasoning: level });
      } else {
        const { reasoning: _, ...rest } = selection;
        this.modelSelections.set(this.modelsActiveTab, rest as { model: string; provider: string });
      }
    }
    this.emit();
  }

  /**
   * Cycles to the next reasoning level for the current model on the active tab.
   * Returns the new reasoning level or null if model doesn't support reasoning.
   */
  cycleReasoningLevel(): string | null {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (!selection) return null;

    const currentModel = this.modelsList.find((m) => m.id === selection.model);
    if (!currentModel?.reasoning || currentModel.reasoning.length === 0) {
      return null;
    }

    const levels = currentModel.reasoning;
    let currentIdx = selection.reasoning
      ? levels.indexOf(selection.reasoning)
      : -1;

    // Move to next level (wrap around)
    const nextIdx = (currentIdx + 1) % levels.length;
    const nextLevel = levels[nextIdx];
    this.modelSelections.set(this.modelsActiveTab, { ...selection, reasoning: nextLevel });
    this.emit();
    return nextLevel;
  }

  /**
   * Gets reasoning options for the currently selected model on the active tab.
   */
  getCurrentModelReasoningOptions(): string[] | null {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (!selection) return null;
    const currentModel = this.modelsList.find((m) => m.id === selection.model);
    return currentModel?.reasoning ?? null;
  }

  /**
   * Gets the currently selected model entry for the active tab.
   */
  getCurrentModelEntry(): ModelEntry | null {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (!selection) return null;
    return this.modelsList.find((m) => m.id === selection.model && m.provider === selection.provider) ?? null;
  }

  /**
   * Gets models for the currently selected model's provider on the active tab.
   */
  getCurrentProviderModels(): ModelEntry[] {
    const selection = this.modelSelections.get(this.modelsActiveTab);
    if (!selection?.provider) return this.modelsList;
    return this.modelsList.filter((m) => m.provider === selection.provider);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSIONS METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets the sessions list and enters sessions selection mode.
   */
  setSessionsList(sessions: SessionEntry[]): void {
    this.sessionsList = sessions;
    this.sessionsCursor = 0;
    this.uiMode = "sessions";
    this.emit();
  }

  /**
   * Moves sessions cursor up or down.
   */
  moveSessionsCursor(delta: number): void {
    const count = this.sessionsList.length;
    if (count === 0) return;
    this.sessionsCursor = (this.sessionsCursor + delta + count) % count;
    this.emit();
  }

  /**
   * Gets the session at the current cursor position.
   */
  getSelectedSession(): SessionEntry | null {
    return this.sessionsList[this.sessionsCursor] ?? null;
  }

  /**
   * Exits sessions mode and returns to chat.
   */
  exitSessionsMode(): void {
    this.sessionsList = [];
    this.sessionsCursor = 0;
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USAGE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets usage loading state.
   */
  setUsageLoading(loading: boolean): void {
    this.usageLoading = loading;
    this.emit();
  }

  /**
   * Sets the usage sessions list and enters usage view mode.
   */
  setUsageSessions(sessions: UsageSessionSummary[]): void {
    this.usageSessions = sessions;
    this.usageCursor = 0;
    this.usageViewMode = "list";
    this.usageLoading = false;
    this.uiMode = "usage";
    this.emit();
  }

  /**
   * Sets the usage analytics data.
   */
  setUsageAnalytics(dayStats: UsageDayStats[], providerStats: UsageProviderStats[]): void {
    this.usageDayStats = dayStats;
    this.usageProviderStats = providerStats;
    this.emit();
  }

  /**
   * Moves usage cursor up or down.
   */
  moveUsageCursor(delta: number): void {
    const count = this.usageSessions.length;
    if (count === 0) return;
    this.usageCursor = (this.usageCursor + delta + count) % count;
    this.emit();
  }

  /**
   * Sets the usage view mode (list, detail, analytics).
   */
  setUsageViewMode(mode: "list" | "detail" | "analytics"): void {
    this.usageViewMode = mode;
    this.emit();
  }

  /**
   * Gets the session at the current usage cursor position.
   */
  getSelectedUsageSession(): UsageSessionSummary | null {
    return this.usageSessions[this.usageCursor] ?? null;
  }

  /**
   * Exits usage mode and returns to chat.
   */
  exitUsageMode(): void {
    this.usageSessions = [];
    this.usageCursor = 0;
    this.usageViewMode = "list";
    this.usageDayStats = [];
    this.usageProviderStats = [];
    this.usageLoading = false;
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RALPH LOOP METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets the Ralph Loop state.
   */
  setRalphState(
    active: boolean,
    iteration: number,
    maxIterations: number,
    completionPromise: string | null
  ): void {
    this.ralphActive = active;
    this.ralphIteration = iteration;
    this.ralphMaxIterations = maxIterations;
    this.ralphCompletionPromise = completionPromise;
    this.emit();
  }

  /**
   * Clears the Ralph Loop state.
   */
  clearRalphState(): void {
    this.ralphActive = false;
    this.ralphIteration = 0;
    this.ralphMaxIterations = 0;
    this.ralphCompletionPromise = null;
    this.emit();
  }

  /**
   * Checks if a Ralph Loop is active.
   */
  isRalphActive(): boolean {
    return this.ralphActive;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PERMISSION PROMPT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets the active permission request and enters permission mode.
   */
  setActivePermissionRequest(request: PermissionRequestData | null): void {
    this.activePermissionRequest = request;
    this.permissionCursor = 0; // Default to "Allow"
    if (request) {
      this.uiMode = "permission";
    }
    this.emit();
  }

  /**
   * Moves the permission cursor up or down through options.
   * Options: 0=Allow, 1=Always Allow, 2=Deny
   */
  movePermissionCursor(delta: number): void {
    const count = 3; // Allow, Always Allow, Deny
    this.permissionCursor = (this.permissionCursor + delta + count) % count;
    this.emit();
  }

  /**
   * Gets the current permission decision based on cursor position.
   */
  getPermissionDecision(): "allow" | "always_allow" | "deny" {
    switch (this.permissionCursor) {
      case 0: return "allow";
      case 1: return "always_allow";
      case 2: return "deny";
      default: return "allow";
    }
  }

  /**
   * Gets the active permission request.
   */
  getActivePermissionRequest(): PermissionRequestData | null {
    return this.activePermissionRequest;
  }

  /**
   * Clears the permission request and returns to chat mode.
   */
  clearPermissionRequest(): void {
    this.activePermissionRequest = null;
    this.permissionCursor = 0;
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT WINDOW METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets the context window size information.
   * @param inputTokens - Number of input tokens in the current request
   * @param maxWindowSize - Maximum context window size for the model
   */
  setContextWindowSize(inputTokens: number | null, maxWindowSize: number | null): void {
    this.contextInputTokens = inputTokens;
    this.contextMaxWindowSize = maxWindowSize;
    this.emit();
  }

  /**
   * Tracks the most recent LLM call (agent/model/provider).
   */
  setLastLlmCall(agentType: string | null, model: string | null, provider: string | null): void {
    this.lastLlmAgentType = agentType;
    this.lastLlmModel = model;
    this.lastLlmProvider = provider;
    this.emit();
  }

  /**
   * Clears last LLM call tracking.
   */
  clearLastLlmCall(): void {
    this.lastLlmAgentType = null;
    this.lastLlmModel = null;
    this.lastLlmProvider = null;
    this.emit();
  }

  /**
   * Sets the cached input value.
   * @param input - The cached input string, or null to clear
   */
  setCachedInput(input: string | null): void {
    this.cachedInput = input;
    this.emit();
  }

  /**
   * Clears all context window state.
   */
  clearContextWindowState(): void {
    this.contextInputTokens = null;
    this.contextMaxWindowSize = null;
    this.cachedInput = null;
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESPONSE PANE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sets response content and enters response mode.
   */
  setResponseContent(content: ResponseContent): void {
    this.responseContent = content;
    this.uiMode = "response";
    this.emit();
  }

  /**
   * Clears response content and returns to chat mode.
   */
  clearResponseContent(): void {
    this.responseContent = null;
    this.uiMode = "chat";
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASTE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Updates paste progress for large paste operations.
   */
  setPasteProgress(bytes: number): void {
    this.pasteInProgress = true;
    this.pasteBytesReceived = bytes;
    this.statusMessage = `Pasting... ${formatBytes(bytes)}`;
    this.emit();
  }

  /**
   * Inserts pasted text using the optimized bulk insert.
   */
  insertPastedText(text: string): void {
    this.inputBuffer.insertBulkText(text);
    this.pasteInProgress = false;
    this.pasteBytesReceived = 0;
    this.statusMessage = "Ready";
    this.emit();
  }

  /**
   * Checks if a paste operation is in progress.
   */
  isPasting(): boolean {
    return this.pasteInProgress;
  }

  /**
   * Clears paste progress state.
   */
  clearPasteProgress(): void {
    this.pasteInProgress = false;
    this.pasteBytesReceived = 0;
    this.statusMessage = "Ready";
    this.emit();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Formats bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function defaultStatusFor(state: TUIState): string {
  switch (state) {
    case "recording":
      return "Recording...";
    case "transcribing":
      return "Transcribing...";
    case "sending":
      return "Sending...";
    case "streaming":
      return "Receiving response...";
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

function findAutocompleteTrigger(text: string, cursor: number): { startIndex: number; query: string } | null {
  if (cursor <= 0) {
    return null;
  }

  let start = cursor - 1;
  while (start >= 0 && !isWhitespace(text[start])) {
    start -= 1;
  }
  const tokenStart = start + 1;
  if (text[tokenStart] !== "@") {
    return null;
  }

  const query = text.slice(tokenStart + 1, cursor);
  return { startIndex: tokenStart, query };
}

function findSlashCommandTrigger(text: string, cursor: number): { startIndex: number; query: string } | null {
  if (cursor <= 0) {
    return null;
  }

  // Only trigger slash commands at the start of input (after optional whitespace)
  const beforeCursor = text.slice(0, cursor);
  const trimmedBefore = beforeCursor.trimStart();

  // Must start with "/" and be at the beginning of input
  if (!trimmedBefore.startsWith("/")) {
    return null;
  }

  // Check that there's no whitespace in the command (still typing the command name)
  if (/\s/.test(trimmedBefore)) {
    return null;
  }

  const startIndex = beforeCursor.length - trimmedBefore.length;
  const query = trimmedBefore; // includes the "/"
  return { startIndex, query };
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function hasAnsiCodes(text: string): boolean {
  return /\x1b\[/.test(text);
}

function visibleAnsiLength(text: string): number {
  return text.replace(ANSI_REGEX, "").length;
}

function truncateAnsiToWidth(text: string, maxWidth: number): string {
  let visible = 0;
  let i = 0;
  let out = "";

  while (i < text.length && visible < maxWidth) {
    const char = text[i];
    if (char === "\x1b" && text[i + 1] === "[") {
      const match = /\x1b\[[0-9;]*m/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += char;
    i += 1;
    visible += 1;
  }

  if (hasAnsiCodes(out)) {
    out += "\x1b[0m";
  }

  return out;
}

function normalizeAnsiLine(text: string, width: number): string {
  const truncated = truncateAnsiToWidth(text, width);
  const visible = visibleAnsiLength(truncated);
  if (visible < width) {
    return truncated + " ".repeat(width - visible);
  }
  return truncated;
}

/**
 * Render a single HistoryLine to the specified width.
 * This handles width normalization (padding/truncation) but does NOT parse markdown.
 *
 * Order of operations:
 * 1. Sanitize: strip \r, expand \t to spaces
 * 2. Handle empty strings: "" becomes " "
 * 3. Width normalization: pad/truncate to exact width
 *
 * @param line - The HistoryLine to render
 * @param width - Target width in terminal columns
 * @returns A HistoryLine with normalized text
 */
function renderLineToWidth(line: HistoryLine, width: number): HistoryLine {
  const safeWidth = Math.max(10, width);
  let text = line.text;

  // Step 1: Sanitize - strip carriage returns
  text = text.replace(/\r/g, "");

  // Expand tabs to spaces (8-space intervals for consistency)
  text = text.replace(/\t/g, "        ");

  // Step 2: Handle empty strings - replace with single space
  // This ensures empty content renders as a visible blank row
  if (text === "") {
    text = " ";
  }

  // Check if text contains ANSI codes (from syntax highlighting)
  if (hasAnsiCodes(text)) {
    const normalized = normalizeAnsiLine(text, safeWidth);
    return { ...line, text: normalized };
  }

  // Step 3: Truncate to width if necessary
  if (text.length > safeWidth) {
    text = text.slice(0, safeWidth);
  }

  // Step 4: Pad to exact width with spaces
  if (text.length < safeWidth) {
    const paddingNeeded = safeWidth - text.length;
    text += " ".repeat(paddingNeeded);
  }

  return { ...line, text };
}

/**
 * Split markdown text into separate HistoryLines for block elements.
 * This handles headers, code blocks, lists, blockquotes that should be
 * separate rows in the terminal.
 *
 * Code blocks are syntax-highlighted using Tree-sitter for supported languages.
 *
 * This function preserves block-level markdown markers so the renderer can
 * handle styling (headers, lists, blockquotes, HRs) consistently at display time.
 *
 * @param text - The markdown text to split
 * @param role - The role to assign to each line
 * @param requestId - Optional request ID
 * @param baseId - Base ID for the lines
 * @returns Array of HistoryLine objects
 */
function splitMarkdownIntoLines(
  text: string,
  role?: Role,
  requestId?: string,
  baseId?: string,
): HistoryLine[] {
  const lines: HistoryLine[] = [];

  // First, normalize line endings and convert to array
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");

  let inCodeBlock = false;
  let implicitCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockLang: string | undefined = undefined;
  let lineIndex = 0;

  const isLanguageLine = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const thinkPrefix = trimmed.startsWith("</think>") ? trimmed.slice("</think>".length).trim() : trimmed;
    if (!thinkPrefix) return null;
    if (!/^[a-zA-Z0-9_.+-]+$/.test(thinkPrefix)) return null;
    return isLanguageSupported(thinkPrefix) ? thinkPrefix : null;
  };

  const isLikelyCodeLine = (line: string): boolean => {
    if (!line.trim()) return false;
    return /^\s*(\/\/|\/\*|\*|\}|import\b|export\b|const\b|let\b|var\b|function\b|class\b|interface\b|type\b|enum\b|return\b|if\b|for\b|while\b|switch\b|try\b|catch\b|public\b|private\b|protected\b|@|#include\b|package\b|from\b|def\b|using\b|\{|\[|\(|<)/.test(line);
  };

  for (let i = 0; i < rawLines.length; i++) {
    let rawLine = rawLines[i];
    // Check for code fence start/end
    if (/^```/.test(rawLine.trim())) {
      if (!inCodeBlock) {
        // Starting a code block
        inCodeBlock = true;
        implicitCodeBlock = false;
        codeBlockLines = [];
        // Extract language from ```lang
        const langMatch = rawLine.trim().match(/^```(\w*)/);
        codeBlockLang = langMatch ? langMatch[1] : undefined;
      } else {
        // Ending a code block
        inCodeBlock = false;
        const codeContent = codeBlockLines.join("\n");

        // Apply syntax highlighting
        const highlighted = highlightCode(codeContent, codeBlockLang);

        // If highlighting was applied (contains ANSI codes), split into lines
        // Otherwise fall back to original behavior
        if (highlighted && highlighted !== codeContent) {
          const highlightedLines = highlighted.split("\n");
          for (const hlLine of highlightedLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: hlLine,
              role,
              requestId,
            });
            lineIndex++;
          }
        } else {
          // No highlighting applied, just output code as regular lines
          for (let codeLine of codeBlockLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: codeLine,
              role,
              requestId,
            });
            lineIndex++;
          }
        }

        codeBlockLines = [];
        codeBlockLang = undefined;
      }
      continue; // Skip fence lines
    }

    if (!inCodeBlock) {
      const lang = isLanguageLine(rawLine);
      if (lang) {
        // Lookahead: only treat as implicit code block if next non-empty line looks like code
        let j = i + 1;
        while (j < rawLines.length && rawLines[j].trim() === "") {
          j++;
        }
        if (j < rawLines.length && isLikelyCodeLine(rawLines[j])) {
          inCodeBlock = true;
          implicitCodeBlock = true;
          codeBlockLang = lang;
          codeBlockLines = [];
          continue; // Skip language line
        }
      }
    }

    if (inCodeBlock) {
      if (implicitCodeBlock) {
        const lang = isLanguageLine(rawLine);
        if (lang) {
          // Close current implicit block before starting a new one
          const codeContent = codeBlockLines.join("\n");
          const highlighted = highlightCode(codeContent, codeBlockLang);
          const outputLines = (highlighted && highlighted !== codeContent)
            ? highlighted.split("\n")
            : codeBlockLines;
          for (const outputLine of outputLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: outputLine,
              role,
              requestId,
            });
            lineIndex++;
          }

          codeBlockLines = [];
          codeBlockLang = undefined;
          inCodeBlock = false;
          implicitCodeBlock = false;

          // Re-process this line as a potential new language line
          i -= 1;
          continue;
        }
      }

      if (implicitCodeBlock && rawLine.trim() === "") {
        // Peek ahead to decide whether to close implicit block
        let j = i + 1;
        while (j < rawLines.length && rawLines[j].trim() === "") {
          j++;
        }
        if (j >= rawLines.length || !isLikelyCodeLine(rawLines[j])) {
          // End implicit code block before this blank line
          inCodeBlock = false;
          implicitCodeBlock = false;

          const codeContent = codeBlockLines.join("\n");
          const highlighted = highlightCode(codeContent, codeBlockLang);
          const outputLines = (highlighted && highlighted !== codeContent)
            ? highlighted.split("\n")
            : codeBlockLines;
          for (const outputLine of outputLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: outputLine,
              role,
              requestId,
            });
            lineIndex++;
          }

          codeBlockLines = [];
          codeBlockLang = undefined;
          // Fall through to handle this blank line as normal content
        } else {
          // Blank line inside code block
          codeBlockLines.push(rawLine);
          continue;
        }
      } else {
        // Collect code block content
        codeBlockLines.push(rawLine);
        continue;
      }
    }

    const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;

    lines.push({
      id: lineId,
      text: rawLine,
      role,
      requestId,
    });

    lineIndex++;
  }

  // Handle unclosed code block (shouldn't happen but be defensive)
  if (inCodeBlock && codeBlockLines.length > 0) {
    const codeContent = codeBlockLines.join("\n");
    const highlighted = highlightCode(codeContent, codeBlockLang);
    const outputLines = (highlighted && highlighted !== codeContent)
      ? highlighted.split("\n")
      : codeBlockLines;
    for (let outputLine of outputLines) {
      const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
      lines.push({
        id: lineId,
        text: outputLine,
        role,
        requestId,
      });
      lineIndex++;
    }
  }

  return lines;
}

function buildHistoryLines(
  history: MessageEntry[],
  streamingText: string,
  reasoningText: string,
  width: number,
  streamingRequestId?: string | null,
): HistoryLine[] {
  const lines: HistoryLine[] = [];
  const safeWidth = Math.max(20, width);

  for (const entry of history) {
    const entryLinePrefix = entry.id;
    const blockStartIndex = lines.length;

    // If this entry is the currently streaming message, use streamingText instead
    // This ensures tool results appear AFTER the agent's response text
    const entryText = (streamingRequestId && entry.requestId === streamingRequestId)
      ? streamingText
      : (entry.text || "");

    // Split markdown into separate lines for block elements
    const markdownLines = splitMarkdownIntoLines(
      entryText,
      entry.role,
      entry.requestId,
      entryLinePrefix,
    );

    // Process each line:
    // 1. Wrap text to width
    // 2. Render to exact width (padding/truncation)
    let lineIndex = 0;
    for (const mdLine of markdownLines) {
      const wrapped = wrapText(mdLine.text, safeWidth);
      wrapped.forEach((wrappedLine, index) => {
        const line: HistoryLine = {
          id: `${entryLinePrefix}:${lineIndex}`,
          text: wrappedLine,
          role: entry.role,
          requestId: entry.requestId,
          isBlockStart: lineIndex === 0 && index === 0,
        };
        // Step 3: Final width normalization (padding to exact width)
        const finalLine = renderLineToWidth(line, safeWidth);
        lines.push(finalLine);
        lineIndex += 1;
      });
    }

    if (entry.meta) {
      const metaLines = splitMarkdownIntoLines(
        entry.meta,
        entry.role,
        entry.requestId,
        `${entryLinePrefix}:meta`,
      );

      for (const metaLine of metaLines) {
        const wrapped = wrapText(metaLine.text, safeWidth);
        wrapped.forEach((wrappedLine) => {
          const line: HistoryLine = {
            id: `${entryLinePrefix}:${lineIndex}`,
            text: wrappedLine,
            role: entry.role,
            requestId: entry.requestId,
          };
          const finalLine = renderLineToWidth(line, safeWidth);
          lines.push(finalLine);
          lineIndex += 1;
        });
      }
    }

    // Mark the last content line as block end
    if (lines.length > blockStartIndex) {
      lines[lines.length - 1].isBlockEnd = true;
    }

    // Add blank separator line after each message for visual breathing room
    // Use space characters so Ink renders them with actual height
    const separatorCount = 1;
    for (let i = 0; i < separatorCount; i++) {
      const separatorLine: HistoryLine = {
        id: `${entryLinePrefix}:sep:${i}`,
        text: " ",
        role: undefined,
        requestId: entry.requestId,
      };
      const rendered = renderLineToWidth(separatorLine, safeWidth);
      lines.push(rendered);
    }
  }

  // Display reasoning content before the main response (dimmed in TUI)
  if (reasoningText) {
    // Add a thinking indicator prefix
    const headerLine: HistoryLine = {
      id: "reasoning:header",
      text: "💭 Thinking...",
      role: "reasoning",
      isBlockStart: true,
    };
    lines.push(renderLineToWidth(headerLine, safeWidth));

    const reasonLines = splitMarkdownIntoLines(
      reasoningText,
      "reasoning",
      undefined,
      "reasoning",
    );

    let reasonIndex = 0;
    for (const reasonLine of reasonLines) {
      const wrapped = wrapText(reasonLine.text, safeWidth);
      wrapped.forEach((wrappedLine) => {
        const line: HistoryLine = {
          id: `reasoning:${reasonIndex}`,
          text: wrappedLine,
          role: "reasoning",
        };
        const finalLine = renderLineToWidth(line, safeWidth);
        lines.push(finalLine);
        reasonIndex += 1;
      });
    }

    if (lines.length > 0 && lines[lines.length - 1].role === "reasoning") {
      lines[lines.length - 1].isBlockEnd = true;
    }

    // Add separator after reasoning
    const sepLine: HistoryLine = {
      id: "reasoning:sep",
      text: " ",
      role: undefined,
    };
    lines.push(renderLineToWidth(sepLine, safeWidth));
  }

  // Only render streaming as a separate section if there's no matching history entry
  // (backwards compatibility fallback - normally streaming should be rendered via history)
  const hasStreamingInHistory = streamingRequestId && history.some(e => e.requestId === streamingRequestId);
  if (streamingText && !hasStreamingInHistory) {
    const streamLines = splitMarkdownIntoLines(
      streamingText,
      "agent",
      undefined,
      "stream",
    );

    let streamIndex = 0;
    for (const streamLine of streamLines) {
      const wrapped = wrapText(streamLine.text, safeWidth);
      wrapped.forEach((wrappedLine, index) => {
        const line: HistoryLine = {
          id: `stream:${streamIndex}`,
          text: wrappedLine,
          role: "agent",
          isBlockStart: streamIndex === 0 && index === 0,
        };
        const finalLine = renderLineToWidth(line, safeWidth);
        lines.push(finalLine);
        streamIndex += 1;
      });
    }

    if (lines.length > 0 && lines[lines.length - 1].role === "agent") {
      lines[lines.length - 1].isBlockEnd = true;
    }
  }

  return lines;
}

/**
 * Normalize HistoryLine array to enforce viewport invariants.
 *
 * This is now a final safety net since most normalization happens in renderLineToWidth.
 * It verifies that all lines are width-stable and handles any edge cases.
 *
 * @param lines - HistoryLine array from buildHistoryLines (already rendered)
 * @param width - Target width in terminal columns
 * @returns Normalized HistoryLine array
 */
function normalizeHistoryLines(lines: HistoryLine[], width: number): HistoryLine[] {
  const normalized: HistoryLine[] = [];
  const safeWidth = Math.max(10, width);

  for (const line of lines) {
    // If the line has embedded newlines, split it (should be rare after renderLineToWidth)
    let textParts = line.text.split("\n");

    for (let partIndex = 0; partIndex < textParts.length; partIndex++) {
      let text = textParts[partIndex];

      // Final safety: handle empty strings
      if (text === "") {
        text = " ";
      }

      if (hasAnsiCodes(text)) {
        text = normalizeAnsiLine(text, safeWidth);
      } else {
        // Final safety: truncate if somehow too long
        if (text.length > safeWidth) {
          text = text.slice(0, safeWidth);
        }

        // Final safety: pad to exact width
        while (text.length < safeWidth) {
          text += " ";
        }
      }

      // Create the normalized line
      const normalizedLine: HistoryLine = {
        id: partIndex === 0 ? line.id : `${line.id}:${partIndex}`,
        text,
        role: line.role,
        requestId: line.requestId,
        segments: line.segments, // Preserve segments if present
      };

      // Preserve block markers on the original line only
      if (partIndex === 0) {
        normalizedLine.isBlockStart = line.isBlockStart;
        normalizedLine.isBlockEnd = line.isBlockEnd;
      }

      normalized.push(normalizedLine);
    }
  }

  return normalized;
}

/**
 * Pre-process markdown text to add proper spacing around block elements.
 * This ensures headers, code blocks, blockquotes, lists, and HRs have
 * visual breathing room without requiring a full markdown AST parser.
 */
function normalizeMarkdownSpacing(text: string): string {
  let result = text;

  // Normalize line endings
  result = result.replace(/\r\n/g, "\n");

  // Fix common LLM escape sequence issues:
  // - Literal \n strings that should be newlines
  // - Malformed ''n or ``n patterns (corrupted \n with quote/backtick loss)
  result = result.replace(/\\n/g, "\n");
  result = result.replace(/'+'n/g, "\n");
  result = result.replace(/`+n/g, "\n");

  // Headers: ensure blank line before (unless at start) and after
  // Matches: # Header, ## Header, etc.
  result = result.replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2");  // blank before
  result = result.replace(/(#{1,6}\s+[^\n]+)\n(?!\n)/g, "$1\n\n"); // blank after

  // Code blocks (```): ensure blank line before and after
  result = result.replace(/([^\n])\n(```)/g, "$1\n\n$2");  // blank before opening
  result = result.replace(/(```[^\n]*)\n(?!\n)/g, "$1\n\n"); // blank after opening (for content)
  result = result.replace(/([^\n])\n(```\s*$)/gm, "$1\n\n$2"); // blank before closing
  result = result.replace(/(```)\n(?!\n)/g, "$1\n\n"); // blank after closing

  // Horizontal rules (---, ***, ___): ensure blank line before and after
  result = result.replace(/([^\n])\n([-*_]{3,}\s*)$/gm, "$1\n\n$2");  // blank before
  result = result.replace(/^([-*_]{3,}\s*)\n(?!\n)/gm, "$1\n\n"); // blank after

  // Blockquotes (> text): ensure blank line before first quote and after last
  // Before: non-quote line followed by quote line
  result = result.replace(/([^\n>].*)\n(>\s+)/g, "$1\n\n$2");
  // After: quote line followed by non-quote, non-blank line
  result = result.replace(/(^>\s+[^\n]*)\n(?!>)(?!\n)(.)/gm, "$1\n\n$2");

  // Lists: ensure blank line before first item (when preceded by non-list content)
  // Matches lines starting with -, *, +, or number.
  result = result.replace(/([^\n\-*+\d].*)\n([\s]*[-*+]\s+)/g, "$1\n\n$2");
  result = result.replace(/([^\n\-*+\d].*)\n([\s]*\d+\.\s+)/g, "$1\n\n$2");

  // Collapse excessive blank lines (more than 2 consecutive) to just 2
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing blank lines but preserve indentation
  result = result.replace(/^\n+/, "");
  result = result.replace(/\n+$/, "");

  return result;
}

/**
 * Find positions of markdown inline spans (bold, italic, code) in text.
 * Returns array of [start, end] positions that should not be broken.
 */
function findMarkdownSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const patterns = [
    /\*\*.+?\*\*/g,     // Bold **text**
    /__.+?__/g,         // Bold __text__
    /\*.+?\*/g,         // Italic *text* (after bold to avoid overlap)
    /_.+?_/g,           // Italic _text_
    /`.+?`/g,           // Inline code `text`
    /~~.+?~~/g,         // Strikethrough ~~text~~
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  // Sort by start position
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

/**
 * Check if a position is inside a markdown span.
 */
function isInsideSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [start, end] of spans) {
    if (pos > start && pos < end) return true;
    if (start > pos) break; // Spans are sorted, no need to check further
  }
  return false;
}

function wrapText(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  // Pre-process to add proper markdown block spacing
  const normalized = normalizeMarkdownSpacing(text);

  const lines: string[] = [];
  const safeWidth = Math.max(10, width);

  const rawLines = normalized.split("\n");
  for (const rawLine of rawLines) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    // Find markdown spans to avoid breaking inside them
    const spans = findMarkdownSpans(rawLine);

    // Word-wrap: try to break at word boundaries, avoiding markdown spans
    let remaining = rawLine;
    let offset = 0; // Track position in original rawLine for span checking
    while (remaining.length > 0) {
      if (remaining.length <= safeWidth) {
        lines.push(remaining);
        break;
      }

      // Find last space within width
      let breakPoint = remaining.lastIndexOf(" ", safeWidth);

      // If no space found, or space is too early (less than half width), hard break
      if (breakPoint === -1 || breakPoint < safeWidth / 2) {
        breakPoint = safeWidth;
      }

      // Check if break point is inside a markdown span
      const absolutePos = offset + breakPoint;
      if (isInsideSpan(absolutePos, spans)) {
        // Find an earlier break point outside the span
        let newBreak = breakPoint - 1;
        while (newBreak > 0 && isInsideSpan(offset + newBreak, spans)) {
          newBreak--;
        }
        // Find actual space near the new break point
        if (newBreak > safeWidth / 3) {
          const spacePos = remaining.lastIndexOf(" ", newBreak);
          if (spacePos > safeWidth / 3) {
            breakPoint = spacePos;
          }
          // If no good space found, keep original break (will split the span, but better than infinite loop)
        }
      }

      lines.push(remaining.slice(0, breakPoint));
      offset += breakPoint;
      // Skip the space if we broke at a space
      const trimmed = remaining.slice(breakPoint).trimStart();
      offset += remaining.length - breakPoint - trimmed.length;
      remaining = trimmed;
    }
  }

  return lines;
}
