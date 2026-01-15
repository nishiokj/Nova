import { computeInputLayout, InputBuffer } from "./buffer.js";
import type { MessageEntry, Role, TUIState, UIMode, WizardType, AgentQuestion, QuestionType, EventLevel, EventKind } from "./types.js";
import { fuzzyMatch } from "./file_cache.js";
import { SLASH_COMMANDS } from "./commands.js";

export interface AutocompleteState {
  active: boolean;
  suggestions: string[];
  selected: number;
  startIndex: number;
}

export interface HistoryLine {
  text: string;
  role?: Role;
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
  scrollOffset: number;
  newMessages: boolean;
  compact: boolean;
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
}

const DEFAULT_MAX_HISTORY = 500;

export class Store {
  private inputBuffer = new InputBuffer();
  private inputScrollOffset = 0;
  private autocomplete: AutocompleteState = {
    active: false,
    suggestions: [],
    selected: 0,
    startIndex: -1,
  };

  private state: TUIState = "idle";
  private statusMessage = "Ready";
  private progressMessage = "";
  private progressLevel: EventLevel | null = null;
  private progressKind: EventKind | null = null;
  private history: MessageEntry[] = [];
  private streamingText = "";
  private streamingRequestId: string | null = null;
  private scrollOffset = 0;
  private newMessages = false;
  private compact = false;
  private voiceMode = false;
  private helpVisible = false;
  private sessionKey: string | null = null;
  private uiMode: UIMode = "chat";
  private wizardType: WizardType | null = null;
  private wizardStepIndex = 0;
  private wizardData: Record<string, unknown> = {};
  private wizardErrors: string[] = [];
  private skillsList: Record<string, unknown>[] = [];
  private hooksList: Record<string, unknown>[] = [];
  private skillsErrors: string[] = [];
  private hooksErrors: string[] = [];
  private capabilities = { voiceAvailable: false, streamingSupported: true };
  private requestCount = 0;
  private historyVersion = 0;
  private maxHistory: number;
  private listeners = new Set<() => void>();

  // Question flow state
  private activeQuestion: AgentQuestion | null = null;
  private questionSelection: number[] = [];
  private questionCursor = 0;
  private questionInput = "";
  private questionQueue: AgentQuestion[] = [];
  private questionAnswers = new Map<string, unknown>();
  private questionRequestId: string | null = null;

  // Paste state
  private pasteInProgress = false;
  private pasteBytesReceived = 0;

  // Theme selection
  private themeCursor = 0;

  // Plan mode
  private planMode = false;

  private historyCache: {
    width: number;
    compact: boolean;
    version: number;
    lines: HistoryLine[];
  } | null = null;

  constructor(maxHistory = DEFAULT_MAX_HISTORY) {
    this.maxHistory = maxHistory;
  }

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
      history: [...this.history],
      streamingText: this.streamingText,
      streamingRequestId: this.streamingRequestId,
      scrollOffset: this.scrollOffset,
      newMessages: this.newMessages,
      compact: this.compact,
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
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setSessionKey(key: string | null): void {
    this.sessionKey = key;
    this.emit();
  }

  setUIMode(mode: UIMode): void {
    this.uiMode = mode;
    this.emit();
  }

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

  setCapabilities(capabilities: { voiceAvailable?: boolean; streamingSupported?: boolean }): void {
    this.capabilities = {
      voiceAvailable: capabilities.voiceAvailable ?? this.capabilities.voiceAvailable,
      streamingSupported: capabilities.streamingSupported ?? this.capabilities.streamingSupported,
    };
    this.emit();
  }

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

  toggleCompact(): boolean {
    this.compact = !this.compact;
    this.historyCache = null;
    this.emit();
    return this.compact;
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
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    if (this.scrollOffset > 0) {
      this.newMessages = true;
    }

    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  updateMessageMeta(requestId: string, meta: string): void {
    for (const entry of this.history) {
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
    for (const entry of this.history) {
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
    this.historyVersion += 1;
    this.historyCache = null;
    this.scrollOffset = 0;
    this.newMessages = false;
    this.emit();
  }

  setStreaming(requestId: string, text: string): void {
    this.streamingRequestId = requestId;
    this.streamingText = text;
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  appendStreaming(chunk: string): void {
    this.streamingText += chunk;
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

  finalizeStreaming(): void {
    this.streamingRequestId = null;
    this.streamingText = "";
    this.historyVersion += 1;
    this.historyCache = null;
    this.emit();
  }

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

  getHistoryLines(width: number, compact: boolean, streamCursor: string): HistoryLine[] {
    if (
      this.historyCache &&
      this.historyCache.width === width &&
      this.historyCache.compact === compact &&
      this.historyCache.version === this.historyVersion
    ) {
      return this.historyCache.lines;
    }

    const lines = buildHistoryLines(
      this.history,
      this.streamingText ? `${this.streamingText}${streamCursor}` : "",
      width,
      compact,
    );

    this.historyCache = {
      width,
      compact,
      version: this.historyVersion,
      lines,
    };

    return lines;
  }

  // ==================== Question Flow Methods ====================

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
      this.activeQuestion.type === "plan_mode_exit"
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
    this.questionInput = text;
    this.emit();
  }

  /**
   * Appends text to the question input.
   */
  appendQuestionInput(text: string): void {
    this.questionInput += text;
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
    if (!this.activeQuestion) return false;

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

  // ==================== Theme Selection Methods ====================

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

  // ==================== Plan Mode Methods ====================

  /**
   * Sets plan mode on or off.
   */
  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    this.emit();
  }

  // ==================== Paste Methods ====================

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

function buildHistoryLines(
  history: MessageEntry[],
  streamingText: string,
  width: number,
  compact: boolean,
): HistoryLine[] {
  const lines: HistoryLine[] = [];
  const safeWidth = Math.max(20, width);

  for (const entry of history) {
    const label = roleLabel(entry.role);
    const prefix = `${label}: `;
    const wrapped = wrapText(entry.text || "", safeWidth - prefix.length);
    const blockStartIndex = lines.length;

    wrapped.forEach((line, index) => {
      const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
      lines.push({ text, role: entry.role, isBlockStart: index === 0 });
    });

    if (entry.meta) {
      const metaLines = wrapText(entry.meta, safeWidth - prefix.length);
      metaLines.forEach((line) => {
        const text = `${" ".repeat(prefix.length)}${line}`;
        lines.push({ text, role: entry.role });
      });
    }

    // Mark the last content line as block end
    if (lines.length > blockStartIndex) {
      lines[lines.length - 1].isBlockEnd = true;
    }

    if (!compact) {
      lines.push({ text: "" });  // Separator line (no role)
    }
  }

  if (streamingText) {
    const label = roleLabel("agent");
    const prefix = `${label}: `;
    const wrapped = wrapText(streamingText, safeWidth - prefix.length);
    wrapped.forEach((line, index) => {
      const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
      lines.push({ text, role: "agent", isBlockStart: index === 0 });
    });
    if (lines.length > 0 && lines[lines.length - 1].role === "agent") {
      lines[lines.length - 1].isBlockEnd = true;
    }
  }

  return lines;
}

function roleLabel(role: Role): string {
  switch (role) {
    case "user":
      return "You";
    case "agent":
      return "Agent";
    case "system":
      return "System";
    case "status":
      return "Status";
    default:
      return "Message";
  }
}

function wrapText(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  const lines: string[] = [];
  const safeWidth = Math.max(10, width);

  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    // Word-wrap: try to break at word boundaries
    let remaining = rawLine;
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

      lines.push(remaining.slice(0, breakPoint));
      // Skip the space if we broke at a space
      remaining = remaining.slice(breakPoint).trimStart();
    }
  }

  return lines;
}
