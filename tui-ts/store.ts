import { computeInputLayout, InputBuffer } from "./buffer.js";
import type { MessageEntry, Role, TUIState } from "./types.js";
import { fuzzyMatch } from "./file_cache.js";

export interface AutocompleteState {
  active: boolean;
  suggestions: string[];
  selected: number;
  startIndex: number;
}

export interface HistoryLine {
  text: string;
  role?: Role;
}

export interface StoreSnapshot {
  state: TUIState;
  statusMessage: string;
  progressMessage: string;
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
  capabilities: {
    voiceAvailable: boolean;
    streamingSupported: boolean;
  };
  requestCount: number;
  historyVersion: number;
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
  private history: MessageEntry[] = [];
  private streamingText = "";
  private streamingRequestId: string | null = null;
  private scrollOffset = 0;
  private newMessages = false;
  private compact = false;
  private voiceMode = false;
  private helpVisible = false;
  private sessionKey: string | null = null;
  private capabilities = { voiceAvailable: false, streamingSupported: true };
  private requestCount = 0;
  private historyVersion = 0;
  private maxHistory: number;
  private listeners = new Set<() => void>();

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
      capabilities: { ...this.capabilities },
      requestCount: this.requestCount,
      historyVersion: this.historyVersion,
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

  setProgress(message: string): void {
    this.progressMessage = message;
    this.emit();
  }

  clearProgress(): void {
    this.progressMessage = "";
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
  }

  replaceInput(text: string): void {
    this.inputBuffer.setText(text);
  }

  clearInput(): void {
    this.inputBuffer.clear();
    this.clearAutocomplete();
    this.inputScrollOffset = 0;
  }

  backspace(): void {
    this.inputBuffer.backspace();
  }

  deleteForward(): void {
    this.inputBuffer.deleteForward();
  }

  moveCursor(delta: number): void {
    this.inputBuffer.moveCursor(delta);
  }

  moveCursorTo(position: number): void {
    this.inputBuffer.moveCursorTo(position);
  }

  moveCursorUp(width: number, prompt: string): void {
    this.inputBuffer.moveCursorUp(width, prompt);
  }

  moveCursorDown(width: number, prompt: string): void {
    this.inputBuffer.moveCursorDown(width, prompt);
  }

  deleteWordBack(): void {
    this.inputBuffer.deleteWordBack();
  }

  updateAutocomplete(fileCache: { getFiles: () => string[] }): void {
    const text = this.inputBuffer.getText();
    const cursor = this.inputBuffer.getCursor();
    const trigger = findAutocompleteTrigger(text, cursor);

    if (!trigger) {
      this.clearAutocomplete();
      return;
    }

    const { startIndex, query } = trigger;
    if (!query || query.includes(" ") || query.includes("\n")) {
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
    const replacement = `@${suggestion}`;
    this.inputBuffer.replaceRange(startIndex, cursor, replacement);
    this.clearAutocomplete();
    return true;
  }

  clearAutocomplete(): void {
    this.autocomplete = {
      active: false,
      suggestions: [],
      selected: 0,
      startIndex: -1,
    };
  }

  ensureInputCursorVisible(width: number, prompt: string, maxLines: number): void {
    const layout = computeInputLayout(this.inputBuffer["buffer" as "buffer"], this.inputBuffer.getCursor(), width, prompt);
    const totalLines = layout.lines.length;
    let offset = this.inputScrollOffset;

    if (layout.cursorLine < offset) {
      offset = layout.cursorLine;
    } else if (layout.cursorLine >= offset + maxLines) {
      offset = layout.cursorLine - maxLines + 1;
    }

    const maxOffset = Math.max(0, totalLines - maxLines);
    offset = Math.max(0, Math.min(offset, maxOffset));

    this.inputScrollOffset = offset;
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

    wrapped.forEach((line, index) => {
      const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
      lines.push({ text, role: entry.role });
    });

    if (entry.meta) {
      const metaLines = wrapText(entry.meta, safeWidth - prefix.length);
      metaLines.forEach((line, index) => {
        const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
        lines.push({ text, role: entry.role });
      });
    }

    if (!compact) {
      lines.push({ text: "" });
    }
  }

  if (streamingText) {
    const label = roleLabel("agent");
    const prefix = `${label}: `;
    const wrapped = wrapText(streamingText, safeWidth - prefix.length);
    wrapped.forEach((line, index) => {
      const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
      lines.push({ text, role: "agent" });
    });
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
  const safeWidth = Math.max(1, width);

  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let start = 0;
    while (start < rawLine.length) {
      const chunk = rawLine.slice(start, start + safeWidth);
      lines.push(chunk);
      start += safeWidth;
    }
  }

  return lines;
}
