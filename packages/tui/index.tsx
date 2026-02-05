#!/usr/bin/env bun
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import path from "path";
import { profiler } from "shared";
import fs from "fs";
import { fileURLToPath } from "url";
import { BridgeClient, type ConnectionState } from "./bridge_client.js";
import { FileCache } from "./file_cache.js";
import { Store, type HistoryLine } from "./store.js";
import { HELP_LINES, parseSlashCommand } from "./commands.js";
import {
  type ErrorData,
  type LlmCallData,
  type ProgressData,
  type ReadyData,
  type ResponseData,
  type StatusData,
  type StreamData,
  type TranscriptionData,
  type BridgeEvent,
  type MessageEntry,
  type Role,
  type BridgeCommandType,
  type ProviderKeyRequiredData,
  type ModelChangedData,
  type UserPromptData,
  type UserPromptQuestion,
  type AgentQuestion,
  type QuestionOption,
  type QuestionType,
  type UsageSessionSummary,
  type UsageDayStats,
  type UsageProviderStats,
  type RalphProgressData,
  type RalphCompletionReason,
  type PermissionRequestData,
  type TextSegment as HistoryTextSegment,
} from "./types.js";
import { UILogger } from "./logger.js";
import { computeInputLayout } from "./buffer.js";
import { useMouse } from "./useMouse.js";
import { useBracketedPaste } from "./hooks/useBracketedPaste.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { ProvidersView } from "./components/ProvidersView.js";
import { ResponsePane, parseDiffToResponseContent } from "./components/ResponsePane.js";
import { SessionsView } from "./components/SessionsView.js";
import { UsageView } from "./components/UsageView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { getColors, setTheme, getThemeNames, getCurrentThemeName, themes } from "./theme.js";
import { applyVisualSpacing, hasAnsiCodes, parseTextSegments, visibleLength } from "./formatting.js";
import { spawnForkedSession } from "./utils/fork-spawn.js";
import { formatDiffAsText } from "./diff.js";
import { wrapText, truncateText } from "./utils/index.js";
import {
  DEFAULT_MAX_INPUT_LINES,
  STREAM_CURSOR_FRAMES,
  STATUS_SPINNER_FRAMES,
  HORIZONTAL_PADDING,
  TOP_PADDING,
  BOTTOM_PADDING,
  MIN_TERMINAL_WIDTH,
  MIN_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  SCROLL_AMOUNT,
  STATUS_TICK_INTERVAL,
  SESSION_STALE_THRESHOLD,
  NETWORK_TIMEOUT,
  FILE_CACHE_REFRESH_INTERVAL,
  CLEANUP_DELAY,
  GRACEFUL_SHUTDOWN_DELAY,
  ERROR_EXIT_DELAY,
  RALPH_MAX_ITERATIONS,
  RALPH_DEFAULT_PROMISE,
  DEFAULT_GRAPHD_HOST,
  DEFAULT_GRAPHD_PORT,
  DEFAULT_EVENT_BUS_HOST,
  DEFAULT_EVENT_BUS_PORT,
  RANDOM_HEX_RADIX,
  REQUEST_ID_SLICE_START,
  REQUEST_ID_SLICE_END,
  ISO_DATE_SLICE,
  MIN_PERMISSION_WIDTH,
  MIN_PERMISSION_HEIGHT,
  PROMPT_MAX_CONTENT_HEIGHT,
} from "./constants.js";

// ==================== Ralph Loop Argument Parsing ====================

interface RalphArgs {
  prompt: string;
  fromFile: boolean;
  maxIterations: number;
  completionPromise: string;
}

/**
 * Parse Ralph Loop command arguments.
 *
 * Syntax:
 *   /ralph-loop <prompt> [options]
 *   /ralph-loop @<file.md> [options]
 *   /ralph-loop cancel
 *
 * Options:
 *   --max-iterations=N or -n N: Max iterations (default: 20)
 *   --complete="PHRASE": Completion promise (default: "TASK COMPLETE")
 */
function parseRalphArgs(arg: string): RalphArgs | null {
  if (!arg || arg.trim() === "") {
    return null;
  }

  const trimmed = arg.trim();

  // Check for cancel command
  if (trimmed.toLowerCase() === "cancel") {
    return null; // Signal for cancel
  }

  let remaining = trimmed;
  let maxIterations = RALPH_MAX_ITERATIONS;
  let completionPromise = RALPH_DEFAULT_PROMISE;

  // Extract --max-iterations=N or -n N
  const maxIterMatch = remaining.match(/--max-iterations=(\d+)/i);
  if (maxIterMatch) {
    maxIterations = parseInt(maxIterMatch[1], 10);
    remaining = remaining.replace(maxIterMatch[0], "").trim();
  } else {
    const shortMaxMatch = remaining.match(/-n\s+(\d+)/);
    if (shortMaxMatch) {
      maxIterations = parseInt(shortMaxMatch[1], 10);
      remaining = remaining.replace(shortMaxMatch[0], "").trim();
    }
  }

  // Extract --complete="PHRASE" or --complete='PHRASE'
  const completeMatch = remaining.match(/--complete=["']([^"']+)["']/i);
  if (completeMatch) {
    completionPromise = completeMatch[1];
    remaining = remaining.replace(completeMatch[0], "").trim();
  }

  // Remaining is the prompt source
  const promptSource = remaining.trim();

  if (!promptSource) {
    return null;
  }

  // Check if it's a file reference
  let prompt = promptSource;
  let fromFile = false;

  if (promptSource.startsWith("@")) {
    const filePath = promptSource.slice(1);
    const resolvedPath = path.resolve(process.cwd(), filePath);

    try {
      prompt = fs.readFileSync(resolvedPath, "utf-8");
      fromFile = true;
    } catch (err) {
      // Return null to indicate error - caller should show message
      return null;
    }
  }

  return {
    prompt,
    fromFile,
    maxIterations,
    completionPromise,
  };
}

interface GraphDSession {
  session_key: string;
  status: string;
  working_dir: string | null;
  last_accessed_at: number;
  created_at: number;
  client_type: string;
  metadata_json?: string;
}

function resolveGraphdUrl(): string {
  if (process.env.GRAPHD_URL) {
    return process.env.GRAPHD_URL;
  }
  const host = process.env.GRAPHD_HOST ?? DEFAULT_GRAPHD_HOST;
  const port = process.env.GRAPHD_PORT ?? DEFAULT_GRAPHD_PORT;
  return `http://${host}:${port}`;
}

function resolveBusConfig(): { host: string; port: number } {
  const host = process.env.EVENT_BUS_HOST ?? DEFAULT_EVENT_BUS_HOST;
  const portValue = Number(process.env.EVENT_BUS_PORT ?? String(DEFAULT_EVENT_BUS_PORT));
  return {
    host,
    port: Number.isFinite(portValue) ? portValue : DEFAULT_EVENT_BUS_PORT,
  };
}

// Fetch with timeout to prevent indefinite hangs
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchGraphdSessions(): Promise<GraphDSession[]> {
  const baseUrl = resolveGraphdUrl();
  const response = await fetchWithTimeout(`${baseUrl}/export?table=sessions`);
  if (!response.ok) {
    throw new Error(`GraphD export failed (${response.status})`);
  }
  const payload = (await response.json()) as { data?: string };
  if (!payload.data) return [];
  return payload.data
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GraphDSession);
}

async function deleteGraphdSession(sessionKey: string): Promise<boolean> {
  const baseUrl = resolveGraphdUrl();
  const response = await fetchWithTimeout(
    `${baseUrl}/session/${encodeURIComponent(sessionKey)}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    return false;
  }
  const payload = (await response.json()) as { deleted?: boolean };
  return payload.deleted === true;
}

interface GraphDMessage {
  session_key: string;
  request_id: string;
  role: string;
  content: string;
  timestamp: number;
  metadata_json?: string;
}

/**
 * Fetch usage data from GraphD and compute session summaries.
 */
async function fetchUsageData(): Promise<{
  sessions: UsageSessionSummary[];
  dayStats: UsageDayStats[];
  providerStats: UsageProviderStats[];
}> {
  const baseUrl = resolveGraphdUrl();

  // Fetch sessions and messages in parallel
  const [sessionsResponse, messagesResponse] = await Promise.all([
    fetchWithTimeout(`${baseUrl}/export?table=sessions`),
    fetchWithTimeout(`${baseUrl}/export?table=conversation_messages`),
  ]);

  if (!sessionsResponse.ok) {
    throw new Error(`GraphD sessions export failed (${sessionsResponse.status})`);
  }

  const sessionsPayload = (await sessionsResponse.json()) as { data?: string };
  const rawSessions: GraphDSession[] = sessionsPayload.data
    ? sessionsPayload.data.split("\n").filter(Boolean).map((line) => JSON.parse(line) as GraphDSession)
    : [];

  // Parse messages if available
  let rawMessages: GraphDMessage[] = [];
  if (messagesResponse.ok) {
    const messagesPayload = (await messagesResponse.json()) as { data?: string };
    if (messagesPayload.data) {
      rawMessages = messagesPayload.data
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GraphDMessage);
    }
  }

  // Group messages by session
  const messagesBySession = new Map<string, GraphDMessage[]>();
  for (const msg of rawMessages) {
    const list = messagesBySession.get(msg.session_key) ?? [];
    list.push(msg);
    messagesBySession.set(msg.session_key, list);
  }

  // Build session summaries
  const now = Date.now() / 1000;
  const staleThreshold = SESSION_STALE_THRESHOLD;

  const sessions: UsageSessionSummary[] = rawSessions.map((raw) => {
    const messages = messagesBySession.get(raw.session_key) ?? [];
    const meta = raw.metadata_json ? JSON.parse(raw.metadata_json) : {};

    // Compute token metrics from agent_events if available
    let inputTokens = 0;
    let outputTokens = 0;
    let llmCallCount = 0;
    let toolCallCount = 0;
    let requestCount = 0;
    const providerTokens = new Map<string, number>();

    const agentEvents = meta.agent_events as unknown[] | undefined;
    if (agentEvents && Array.isArray(agentEvents)) {
      const seenRequests = new Set<string>();
      for (const event of agentEvents) {
        const e = event as Record<string, unknown>;
        const eventType = e.type as string;
        const requestId = (e.request_id as string) ?? (e.requestId as string);
        if (requestId && !seenRequests.has(requestId)) {
          seenRequests.add(requestId);
          requestCount++;
        }

        if (eventType === "llm_call") {
          const data = (e.data ?? {}) as Record<string, unknown>;
          const promptTokens = (data.prompt_tokens as number) ?? (data.promptTokens as number) ?? 0;
          const completionTokens = (data.completion_tokens as number) ?? (data.completionTokens as number) ?? 0;
          inputTokens += promptTokens;
          outputTokens += completionTokens;
          llmCallCount++;

          const provider = (data.provider as string) ?? "unknown";
          providerTokens.set(provider, (providerTokens.get(provider) ?? 0) + promptTokens);
        } else if (eventType === "tool_call") {
          toolCallCount++;
        }
      }
    }

    // Determine status - must respect database status field
    let status: "active" | "idle" | "ended" = "idle";
    if (raw.status === "closed" || raw.status === "expired") {
      status = "ended";
    } else if (raw.status === "active" && now - raw.last_accessed_at <= staleThreshold) {
      // Only show as active if BOTH: database says active AND recently accessed
      status = "active";
    }

    const projectName = raw.working_dir?.split("/").pop() ?? "unknown";
    const durationMs = (raw.last_accessed_at - raw.created_at) * 1000;

    return {
      sessionKey: raw.session_key,
      status,
      projectName,
      workingDir: raw.working_dir,
      createdAt: raw.created_at,
      lastAccessedAt: raw.last_accessed_at,
      requestCount,
      inputTokens,
      outputTokens,
      llmCallCount,
      toolCallCount,
      durationMs,
      providerTokens,
    };
  });

  // Sort by last accessed (most recent first)
  sessions.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

  // Compute day stats
  const dayStatsMap = new Map<string, UsageDayStats>();
  for (const session of sessions) {
    const date = new Date(session.lastAccessedAt * 1000).toISOString().slice(0, ISO_DATE_SLICE);
    const existing = dayStatsMap.get(date) ?? {
      date,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      llmCallCount: 0,
    };
    existing.inputTokens += session.inputTokens;
    existing.outputTokens += session.outputTokens;
    existing.requestCount += session.requestCount;
    existing.llmCallCount += session.llmCallCount;
    dayStatsMap.set(date, existing);
  }
  const dayStats = Array.from(dayStatsMap.values()).sort((a, b) => b.date.localeCompare(a.date));

  // Compute provider stats from actual provider data
  const todayDate = new Date().toISOString().slice(0, ISO_DATE_SLICE);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, ISO_DATE_SLICE);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, ISO_DATE_SLICE);

  const providerStatsMap = new Map<string, { today: number; week: number; month: number }>();

  for (const session of sessions) {
    const sessionDate = new Date(session.lastAccessedAt * 1000).toISOString().slice(0, ISO_DATE_SLICE);

    // Aggregate tokens by provider from actual session data
    for (const [provider, tokens] of session.providerTokens) {
      const existing = providerStatsMap.get(provider) ?? { today: 0, week: 0, month: 0 };

      if (sessionDate === todayDate) {
        existing.today += tokens;
      }
      if (sessionDate >= weekAgo) {
        existing.week += tokens;
      }
      if (sessionDate >= monthAgo) {
        existing.month += tokens;
      }

      providerStatsMap.set(provider, existing);
    }
  }

  const providerStats: UsageProviderStats[] = Array.from(providerStatsMap.entries()).map(([provider, stats]) => ({
    provider,
    ...stats,
  }));

  return { sessions, dayStats, providerStats };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = (() => {
  const override = process.env.TUI_PROJECT_ROOT;
  if (override) {
    return path.resolve(override);
  }
  if (path.basename(__dirname) === "dist") {
    return path.resolve(__dirname, "..", "..", "..");
  }
  return path.resolve(__dirname, "..", "..");
})();

interface AppOptions {
  uiLogPath: string;
  enableVoice: boolean;
  redactLogs: boolean;
  logTranscripts: boolean;
  sessionKey: string | null;
}

// Skills and hooks are read-only in the TUI.
// To create/edit skills, use the agent with Write/Edit to create SKILL.md files in config/skills/

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  // Force re-render counter - incrementing this triggers a full component tree re-render
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const handler = () => {
      // Clear screen and reset cursor to force Ink to repaint everything
      // \x1b[2J = clear entire screen
      // \x1b[H = move cursor to home (1,1)
      // \x1b[3J = clear scrollback buffer (helps with some terminals)
      stdout.write("\x1b[2J\x1b[H\x1b[3J");

      // Update size
      setSize({ columns: stdout.columns ?? DEFAULT_TERMINAL_WIDTH, rows: stdout.rows ?? DEFAULT_TERMINAL_HEIGHT });

      // Force a full re-render by updating a counter
      // This helps Ink recalculate its entire virtual buffer
      forceUpdate((n) => n + 1);
    };

    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);

  return size;
}

export interface AppProps {
  options: AppOptions;
  initialPrompt?: string;
  onExit?: () => void;
}

export function App({ options, initialPrompt, onExit }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const store = useMemo(() => new Store(), []);
  const [snapshot, setSnapshot] = useState(store.getSnapshot());
  const [statusTick, setStatusTick] = useState(0);
  const clientRef = useRef<BridgeClient | null>(null);
  const loggerRef = useRef<UILogger | null>(null);
  const fileCacheRef = useRef<FileCache | null>(null);
  const deleteFlowRef = useRef<{
    stage: "select" | "confirm";
    sessions: GraphDSession[];
    selectedKey?: string;
  } | null>(null);
  const maxScrollRef = useRef(0);
  const historyHeightRef = useRef(0);
  const width = Math.max(MIN_TERMINAL_WIDTH, size.columns || DEFAULT_TERMINAL_WIDTH);
  const height = Math.max(MIN_TERMINAL_HEIGHT, size.rows || DEFAULT_TERMINAL_HEIGHT);
  const contentWidth = width - HORIZONTAL_PADDING * 2;
  const MESSAGE_GUTTER = 2;
  const messageWidth = Math.max(10, contentWidth - MESSAGE_GUTTER * 2);
  const prompt = "> ";
  const widthRef = useRef(width);
  const voiceStateRef = useRef({
    recording: false,
    repeatConfirmed: false,
    startAt: 0,
    lastSpaceAt: 0,
    manualStopMode: false,
    interval: null as NodeJS.Timeout | null,
  });
  // Track escape key for leader-key shortcuts (Esc then M for model, Esc then R for reasoning)
  const escapeLeaderRef = useRef<number>(0);
  // Track when user explicitly requested models mode (vs startup fetch)
  const pendingModelsModeRef = useRef(false);
  useEffect(() => {
    return store.subscribe(() => {
      setSnapshot(store.getSnapshot());
    });
  }, [store]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Invalidate history cache on resize to force re-wrapping text
  const prevSizeRef = useRef({ columns: size.columns, rows: size.rows });
  useEffect(() => {
    if (
      prevSizeRef.current.columns !== size.columns ||
      prevSizeRef.current.rows !== size.rows
    ) {
      store.invalidateHistoryCache();
      prevSizeRef.current = { columns: size.columns, rows: size.rows };
    }
  }, [size.columns, size.rows, store]);

  const isBusy = snapshot.state !== "idle" && snapshot.state !== "error";

  useEffect(() => {
    if (!isBusy) {
      return;
    }
    const interval = setInterval(() => {
      setStatusTick((tick) => tick + 1);
    }, STATUS_TICK_INTERVAL);
    return () => {
      clearInterval(interval);
    };
  }, [isBusy]);

  useEffect(() => {
    return () => {
      const voiceState = voiceStateRef.current;
      if (voiceState.interval) {
        clearInterval(voiceState.interval);
        voiceState.interval = null;
      }
    };
  }, []);

  useEffect(() => {
    const logger = new UILogger({
      logPath: options.uiLogPath,
      redact: options.redactLogs,
      logTranscripts: options.logTranscripts,
    });
    loggerRef.current = logger;
    logger.info("Ink UI started", { version: process.env.npm_package_version ?? "dev" });

    const fileCache = new FileCache(PROJECT_ROOT);
    fileCacheRef.current = fileCache;
    const refreshInterval = setInterval(() => {
      fileCache.refreshIfNeeded().catch(() => {
        // Ignore refresh failures.
      });
    }, FILE_CACHE_REFRESH_INTERVAL);

    fileCache.buildInitial();

    // Create bridge client (remote harness connection)
    const { host, port } = resolveBusConfig();
    const client = new BridgeClient({ host, port });
    clientRef.current = client;

    client.on("event", (event: BridgeEvent) => {
      handleBridgeEvent(event);
    });

    client.on("error", (payload) => {
      const message = typeof payload?.message === "string" ? payload.message : "Connection error";
      store.batch(() => {
        store.addMessage("system", message);
        store.setError(message);
      });
    });

    // Connection state changes - show status and handle reconnection
    client.on("connection_state", (state: ConnectionState) => {
      switch (state) {
        case "connecting":
          store.setStatus("Connecting to bridge...");
          break;
        case "connected":
          store.batch(() => {
            store.clearError();
            store.setStatus("Connected");
          });
          break;
        case "reconnecting":
          store.setStatus("Connection lost. Reconnecting...");
          break;
        case "disconnected":
          store.setError("Disconnected from bridge");
          break;
      }
    });

    void client
      .connect()
      .then(() => {
        const initData: Record<string, unknown> = {
          enable_voice: options.enableVoice,
          client_version: process.env.npm_package_version ?? "dev",
          log_transcripts: options.logTranscripts,
          working_dir: process.cwd(),
        };
        // Only use explicit session key from CLI (e.g., --session <key>)
        if (options.sessionKey) {
          initData.session_key = options.sessionKey;
        }
        client.send({
          type: "init",
          data: initData,
        });

        // Set dangerous mode for this session if requested
        // Each session has its own dangerous mode state - does not affect other TUIs
        if (options.dangerousMode) {
          void client.setDangerousMode(true).catch(() => {
            // Silently ignore - do NOT use console.error as it breaks Ink rendering
          });
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setError(message);
      });

    // Cleanup function for both useEffect and signal handlers
    // Gracefully closes session before disconnecting
    const cleanup = () => {
      const snapshot = store.getSnapshot();
      // Persist all model selections (standard, explorer, coding) on cleanup
      for (const [agentType, selection] of snapshot.modelSelections) {
        if (selection?.model && selection?.provider) {
          client.send({
            type: "set_model",
            data: {
              agent_type: agentType,
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
            },
          });
        }
      }
      // Signal session close to harness (don't await - best effort)
      // This marks the session as inactive so it shows correctly in /sessions
      client.sessionClose().catch(() => {
        // Ignore errors during cleanup - connection may already be closed
      });
      // Small delay to allow the close message to be sent
      setTimeout(() => {
        client.close();
      }, CLEANUP_DELAY);
      clearInterval(refreshInterval);
      logger.close();
    };

    // Register cleanup for signal handlers (Ctrl+C, kill)
    setGlobalCleanup(cleanup);

    return cleanup;
  }, [options, store]);

  useEffect(() => {
    store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
  }, [width, snapshot.inputText, snapshot.cursor, store]);

  // Mouse wheel scrolling

  useMouse({
    onScrollUp: () => {
      store.scrollBy(SCROLL_AMOUNT, maxScrollRef.current);
    },
    onScrollDown: () => {
      store.scrollBy(-SCROLL_AMOUNT, maxScrollRef.current);
    },
  });

  // Bracketed paste mode for better paste handling
  useBracketedPaste({
    onPaste: (text) => {
      store.insertPastedText(text);
      const cache = fileCacheRef.current;
      if (cache) {
        store.updateAutocomplete(cache);
      }
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
    },
    onPasteStart: () => {
      store.setPasteProgress(0);
    },
    onPasteProgress: (bytes) => {
      store.setPasteProgress(bytes);
    },
    onPasteEnd: () => {
      store.clearPasteProgress();
    },
    enabled: !snapshot.helpVisible && snapshot.uiMode !== "question" && snapshot.uiMode !== "providers",
  });

  const handleBridgeEvent = (event: BridgeEvent) => {
    profiler.begin(`tui.handleEvent:${event.type}`, 'tui');
    try {
      switch (event.type) {
        case "ready":
          handleReady(event.data as ReadyData | undefined);
          break;
        case "status":
          handleStatus(event.data as StatusData | undefined);
          break;
        case "progress":
          handleProgress(event.data as ProgressData | undefined);
          break;
        case "stream":
          handleStream(event.data as StreamData | undefined);
          break;
        case "response":
          handleResponse(event.data as ResponseData | undefined);
          break;
        case "llm_call":
          handleLlmCall(event.data as LlmCallData | undefined);
          break;
        case "transcription":
          handleTranscription(event.data as TranscriptionData | undefined);
          break;
        case "user_prompt":
          handleUserPrompt(event.data as UserPromptData | undefined);
          break;
        case "error":
          handleError(event.data as ErrorData | undefined);
          break;
        case "provider_key_required":
          handleProviderKeyRequired(event.data as ProviderKeyRequiredData | undefined);
          break;
        case "model_changed":
          handleModelChanged(event.data as ModelChangedData | undefined);
          break;
        case "permission_request":
          handlePermissionRequest(event.data as PermissionRequestData | undefined);
          break;
        default:
          break;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      store.batch(() => {
        store.addMessage("system", `Event processing error: ${errorMessage}`);
        store.setError(errorMessage);
      });
    }
    profiler.end(`tui.handleEvent:${event.type}`, 'tui');
  };

  const handleReady = async (data?: ReadyData) => {
    // Set session key and clear previous state
    const previousSessionKey = store.getSnapshot().sessionKey;
    const isNewSession = previousSessionKey !== (data?.session_key ?? null);

    if (data?.session_key) {
      store.setSessionKey(data.session_key);
    }
    // Clear all model selections on session start - will be repopulated by model_changed events
    store.batch(() => {
      store.setModelSelection('standard', null);
      store.setModelSelection('explorer', null);
      store.setModelSelection('coding', null);
    });
    store.clearLastLlmCall();

    // Hydrate message history if provided (session rehydration)
    if (data?.history && data.history.length > 0) {
      store.batch(() => {
        // Clear existing history only for session switches
        if (isNewSession) {
          store.clearHistory();
        }
        // Add each historical message
        for (const msg of data.history) {
          store.addMessage(msg.role, msg.content, undefined, msg.requestId);
        }
      });
    }

    if (data?.capabilities) {
      // Convert snake_case from bridge to camelCase for store
      store.setCapabilities({
        voiceAvailable: data.capabilities.voice_available,
        streamingSupported: data.capabilities.streaming_supported,
      });
      if (data.capabilities.voice_available === false) {
        store.setVoiceMode(false);
      }
    }
    if (data?.config_summary) {
      store.addMessage("system", data.config_summary);
    }

    // Check if any API keys are configured and prompt user if not
    try {
      const client = clientRef.current;
      if (!client) {
        return;
      }
      const result = await client.providersList();
      if (result.success && result.providers) {
        const configuredProviders = result.providers.filter((p) => p.configured);
        if (configuredProviders.length === 0) {
          store.addMessage(
            "system",
            "No API keys configured. Run /providers to set up your LLM provider keys."
          );
        }
      }
    } catch {
      // Ignore errors checking providers on startup
    }

    // Fetch models list for the input footer dropdown
    try {
      sendCommand("get_models");
    } catch {
      // Ignore errors fetching models on startup
    }
    try {
      sendCommand("get_model");
    } catch {
      // Ignore errors fetching active model on startup
    }

    // Send initial prompt if provided (from standalone launcher)
    if (initialPrompt && clientRef.current) {
      const requestId = `ink_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      store.batch(() => {
        store.addMessage("user", initialPrompt);
        store.incrementRequestCount();
        store.clearProgress();
        store.setState("sending");
      });
      loggerRef.current?.transcript("user", initialPrompt);
      sendCommand("send_text", {
        text: initialPrompt,
        client_request_id: requestId,
        plan_mode: store.getSnapshot().planMode,
      });
    }
  };

  const handleStatus = (data?: StatusData) => {
    if (!data) {
      return;
    }
    if (data.state) {
      store.setState(data.state, data.message);
      if (data.state === "idle") {
        store.clearProgress();
      }
    } else if (data.message) {
      store.setStatus(data.message);
    }
  };

  const handleProgress = (data?: ProgressData) => {
    if (!data?.message) {
      return;
    }

    // Handle Ralph Loop iteration progress
    const ralphData = data as unknown as { ralph_iteration?: RalphProgressData };
    if (ralphData.ralph_iteration) {
      const ralph = ralphData.ralph_iteration;
      store.setRalphState(
        true,
        ralph.iteration,
        ralph.maxIterations,
        ralph.completionPromise
      );
      // Don't return - continue to show progress message
    }

    const message = data.tool_name ? `${data.tool_name}: ${data.message}` : data.message;
    store.setProgress(message, data.level, data.kind);

    // For Edit tool completions with arguments, render diff in history
    if (data.tool_name === "Edit" && data.tool_args && data.tool_success !== undefined) {
      const args = data.tool_args;
      // Handle both camelCase (internal) and snake_case (Claude API) parameter names
      const oldStr = typeof args.oldString === "string" ? args.oldString
        : typeof args.old_string === "string" ? args.old_string : "";
      const newStr = typeof args.newString === "string" ? args.newString
        : typeof args.new_string === "string" ? args.new_string : "";
      const filePath = typeof args.path === "string" ? args.path
        : typeof args.file_path === "string" ? args.file_path : undefined;

      if (oldStr || newStr) {
        // Use current terminal width for full-width diff line padding
        const currentWidth = widthRef.current;
        // Don't pass filePath - we'll build header ourselves with tool status
        const diffLines = formatDiffAsText(oldStr, newStr, undefined, 3, currentWidth);
        const diffText = diffLines.join("\n");
        const status = data.tool_success ? "✓" : "✗";
        const duration = data.duration_ms ? ` (${data.duration_ms}ms)` : "";
        // Compute stats for header
        const addedCount = diffLines.filter(l => l.match(/^\s*\d+\s+\+ /)).length;
        const removedCount = diffLines.filter(l => l.match(/^\s*\d+\s+- /)).length;
        const stats = `+${addedCount} / -${removedCount}`;
        const header = filePath ? `${status} Edit ${filePath}  ${stats}${duration}` : `${status} Edit${duration}`;
        store.addMessage("system", `${header}\n${diffText}`);
      }
    }
  };

  const handleStream = (data?: StreamData) => {
    if (!data?.request_id || data.chunk === undefined) {
      return;
    }

    profiler.begin('tui.stream.process', 'tui');

    // Single getSnapshot for hot path - avoid repeated state copies
    const currentSnapshot = store.getSnapshot();

    // Route reasoning content separately from main response
    if (data.is_reasoning) {
      // Handle reasoning final marker (empty chunk with is_final=true)
      // Don't clear reasoning yet - it stays visible until main response completes
      if (data.is_final) {
        profiler.end('tui.stream.process', 'tui');
        return;
      }
      // Append reasoning chunks
      profiler.begin('tui.stream.reasoning', 'tui');
      if (currentSnapshot.reasoningRequestId !== data.request_id) {
        store.setReasoning(data.request_id, data.chunk);
      } else {
        store.appendReasoning(data.chunk);
      }
      store.setState("streaming");
      profiler.end('tui.stream.reasoning', 'tui');
      profiler.end('tui.stream.process', 'tui');
      return;
    }

    // Handle regular response streaming
    profiler.begin('tui.stream.text', 'tui');
    if (currentSnapshot.streamingRequestId !== data.request_id) {
      // New response stream - finalize any active reasoning first
      if (currentSnapshot.reasoningRequestId === data.request_id) {
        store.finalizeReasoning();
        // Update snapshot after finalizing reasoning
      }
      // Add message to history immediately so tool results appear AFTER it
      // The message text will be substituted with streamingText during rendering
      store.addMessage("agent", data.chunk, undefined, data.request_id);
      store.setStreaming(data.request_id, data.chunk);
      profiler.instant('tui.stream.firstChunk', 'tui', 'p', { requestId: data.request_id });
    } else {
      store.appendStreaming(data.chunk);
    }

    store.setState("streaming");
    profiler.end('tui.stream.text', 'tui');

    if (data.is_final) {
      profiler.begin('tui.stream.finalize', 'tui');
      const finalText = store.getSnapshot().streamingText;
      store.batch(() => {
        // Update the message text with the complete streamed content
        // The message was added to history when streaming started
        if (messageExists(store.getSnapshot().history, data.request_id)) {
          store.updateMessageText(data.request_id, finalText);
        } else {
          // Fallback: add message if it somehow doesn't exist
          store.addMessage("agent", finalText, undefined, data.request_id);
        }
        store.finalizeStreaming();
        store.finalizeReasoning(); // Clear any remaining reasoning
        store.clearProgress();
        store.setState("idle");
      });
      profiler.end('tui.stream.finalize', 'tui');
      profiler.instant('tui.stream.complete', 'tui', 'p', { requestId: data.request_id });
    }
    profiler.end('tui.stream.process', 'tui');
  };

  const handleSkillsPayload = (payload: Record<string, unknown> | undefined, content: string) => {
    const action = typeof payload?.action === "string" ? payload.action : "";
    const errors = Array.isArray(payload?.errors)
      ? (payload?.errors as Record<string, unknown>[]).map(
          (err) => `${String(err.path ?? "unknown")}: ${String(err.message ?? "invalid")}`,
        )
      : [];
    if (action === "list") {
      const items = Array.isArray(payload?.items) ? (payload?.items as Record<string, unknown>[]) : [];
      store.batch(() => {
        store.setSkillsList(items, errors);
        store.setUIMode("skills");
        store.scrollToBottom();
      });
      return;
    }
    // Skills are read-only in TUI. To create/edit, use the agent with Write/Edit.
    if (content) {
      store.addMessage("system", content);
    }
  };

  const handleHooksPayload = (payload: Record<string, unknown> | undefined, content: string) => {
    const action = typeof payload?.action === "string" ? payload.action : "";
    const errors = Array.isArray(payload?.errors)
      ? (payload?.errors as Record<string, unknown>[]).map(
          (err) => `${String(err.path ?? "unknown")}: ${String(err.message ?? "invalid")}`,
        )
      : [];
    if (action === "list") {
      const items = Array.isArray(payload?.items) ? (payload?.items as Record<string, unknown>[]) : [];
      store.batch(() => {
        store.setHooksList(items, errors);
        store.setUIMode("hooks");
        store.scrollToBottom();
      });
      return;
    }
    // Hooks are read-only in TUI. To create/edit, use the agent with Write/Edit.
    if (content) {
      store.addMessage("system", content);
    }
  };

  const handleLlmCall = (data?: LlmCallData) => {
    if (!data) {
      return;
    }

    // Track last model used (for per-agent clarity in async mode)
    store.setLastLlmCall(
      data.agentType ?? null,
      data.model ?? null,
      data.provider ?? null
    );

    // Extract token usage from llm_call event (fields are camelCase from agent)
    const promptTokens = data.promptTokens ?? 0;
    const completionTokens = data.completionTokens ?? 0;
    const totalTokens = data.totalTokens ?? 0;
    const cachedTokens = data.cachedTokens ?? 0;

    // Calculate input tokens (prompt + cached for context)
    const inputTokens = promptTokens + cachedTokens;
    const maxWindowSize = data.maxWindowSize ?? null;

    // Update store with context window info
    store.setContextWindowSize(inputTokens, maxWindowSize);
  };

  const handleResponse = (data?: ResponseData) => {
    if (!data) {
      return;
    }

    const metadata = data.metadata ?? {};
    const kind = typeof metadata.kind === "string" ? metadata.kind : null;
    const content = data.content ?? "";
    const error =
      typeof data.error === "string"
        ? data.error
        : typeof metadata.error === "string"
          ? metadata.error
          : "";
    if (kind === "config" || kind === "status") {
      if (content) {
        store.addMessage("system", content);
      }
      return;
    }
    if (kind === "models") {
      const payload = metadata.payload as Array<{ id: string; name: string; provider?: string; reasoning?: string[] }> | undefined;
      const availableRaw = (metadata as { available?: unknown }).available;
      const available = Array.isArray(availableRaw)
        ? (availableRaw as Array<{ id: string; name: string; provider?: string; reasoning?: string[] }>)
        : undefined;
      if (payload && Array.isArray(payload)) {
        if (pendingModelsModeRef.current) {
          pendingModelsModeRef.current = false;
          store.setModelsList(payload, available);
        } else {
          store.updateModelsList(payload, available);
        }
      } else if (content) {
        store.addMessage("system", content);
      }
      return;
    }
    if (kind === "set_model") {
      if (data.success === false) {
        if (error) {
          store.addMessage("system", error);
        }
        sendCommand("get_model");
        return;
      }
      const payload = metadata.payload as {
        agent_type?: string | null;
        selected_model?: { provider?: string; model?: string; reasoning?: string } | null;
        selectedModel?: string | null;
        selectedProvider?: string | null;
        provider?: string | null;
        model?: string | null;
        reasoning?: string | null;
      } | undefined;
      const agentType = typeof payload?.agent_type === "string" ? payload.agent_type : "standard";
      const selectedModelObj = payload?.selected_model ?? null;
      const selectedModel =
        selectedModelObj?.model ?? payload?.selectedModel ?? payload?.model ?? null;
      const selectedProvider =
        selectedModelObj?.provider ?? payload?.selectedProvider ?? payload?.provider ?? null;
      const reasoning =
        selectedModelObj?.reasoning ?? (typeof payload?.reasoning === "string" ? payload.reasoning : null);
      store.batch(() => {
        if (selectedModel && selectedProvider) {
          store.setModelSelection(agentType, {
            model: selectedModel,
            provider: selectedProvider,
            reasoning: reasoning ?? undefined,
          });
        } else {
          store.setModelSelection(agentType, null);
        }
      });
      return;
    }
    if (kind === "get_model") {
      if (data.success === false) {
        if (error) {
          store.addMessage("system", error);
        }
        return;
      }
      const payload = metadata.payload as {
        model_selections?: Record<string, { provider?: string; model?: string; reasoning?: string }>;
        selectedModel?: string | null;
        selectedProvider?: string | null;
        provider?: string | null;
        model?: string | null;
        reasoning?: string | null;
        agent_type?: string | null;
      } | undefined;
      const modelSelections = payload?.model_selections;
      if (modelSelections && typeof modelSelections === "object") {
        store.batch(() => {
          const agentTypes = ["standard", "explorer", "coding"];
          for (const agentType of agentTypes) {
            const selection = modelSelections[agentType];
            if (selection?.model && selection?.provider) {
              store.setModelSelection(agentType, {
                model: selection.model,
                provider: selection.provider,
                reasoning: selection.reasoning ?? undefined,
              });
            } else {
              store.setModelSelection(agentType, null);
            }
          }
        });
        return;
      }

      const selectedModel = payload?.selectedModel ?? payload?.model ?? null;
      const selectedProvider = payload?.selectedProvider ?? payload?.provider ?? null;
      const reasoning = typeof payload?.reasoning === "string" ? payload.reasoning : null;
      const agentType = typeof payload?.agent_type === "string" ? payload.agent_type : "standard";
      store.batch(() => {
        if (selectedModel && selectedProvider) {
          store.setModelSelection(agentType, {
            model: selectedModel,
            provider: selectedProvider,
            reasoning: reasoning ?? undefined,
          });
        } else {
          store.setModelSelection(agentType, null);
        }
      });
      return;
    }
    if (kind === "skills") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      store.batch(() => {
        handleSkillsPayload(payload, content);
        store.clearProgress();
        store.setState("idle");
      });
      return;
    }
    if (kind === "hooks") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      store.batch(() => {
        handleHooksPayload(payload, content);
        store.clearProgress();
        store.setState("idle");
      });
      return;
    }
    if (kind === "compact_context") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      store.batch(() => {
        if (payload?.success) {
          const itemsRemoved = payload.itemsRemoved ?? 0;
          const bytesRecovered = payload.bytesRecovered ?? 0;
          store.addMessage("system", `Context compacted: ${itemsRemoved} items removed, ${bytesRecovered} bytes recovered.`);
        } else {
          const errorMsg = payload?.error ?? "Unknown error";
          store.addMessage("system", `Context compaction failed: ${errorMsg}`);
        }
        store.clearProgress();
        store.setState("idle");
      });
      return;
    }
    if (typeof kind === "string" && kind.startsWith("watcher_")) {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      store.batch(() => {
        if (payload?.success === false) {
          store.addMessage("system", `Watcher error: ${payload?.error ?? "Unknown error"}`);
        } else {
          store.addMessage("system", formatWatcherPayload(kind, payload));
        }
        store.clearProgress();
        store.setState("idle");
      });
      return;
    }
    if (kind === "async_start") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      if (payload?.success) {
        store.addMessage("system", `Async session active. Watcher oversight enabled.\nRequest: ${payload?.requestId ?? "unknown"}`);
      } else {
        store.batch(() => {
          store.addMessage("system", `Failed to start async session: ${payload?.error ?? "unknown error"}`);
          store.setState("idle");
        });
      }
      return;
    }
    if (kind === "async_cancel") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      const cancelGoal = (payload?.goal as string) ?? "";
      store.addMessage("system", `Async session cancelled.${cancelGoal ? `\nGoal was: ${cancelGoal}` : ""}`);
      return;
    }
    if (kind === "async_status") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      if (payload?.running) {
        const elapsed = typeof payload.elapsedMs === "number" ? Math.round(payload.elapsedMs / 1000) : null;
        store.addMessage(
          "system",
          `Async session running\n` +
          `  Goal: ${payload.goal ?? "unknown"}\n` +
          `  Request: ${payload.requestId ?? "unknown"}` +
          (elapsed !== null ? `\n  Elapsed: ${elapsed}s` : "")
        );
      } else {
        store.addMessage("system", "No async session is currently running.");
      }
      return;
    }
    if (kind === "async_complete") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      const reason = (payload?.reason as string) ?? "unknown";
      const asyncGoal = (payload?.goal as string) ?? "";
      const reasonMessages: Record<string, string> = {
        manual_cancel: `Async session cancelled.${asyncGoal ? ` Goal was: ${asyncGoal}` : ""}`,
        goal_reached: `Async session completed - goal reached.`,
        error: `Async session failed.`,
        timeout: `Async session timed out.`,
      };
      store.addMessage("system", reasonMessages[reason] ?? `Async session ended: ${reason}`);
      return;
    }

    if (kind === "ralph_loop_complete") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      const reason = (payload?.reason as RalphCompletionReason) ?? "error";
      const iterations = (payload?.iterations as number) ?? 0;
      store.batch(() => {
        store.clearRalphState();
        const reasonMessages: Record<RalphCompletionReason, string> = {
          promise_detected: `✅ Ralph Loop completed successfully after ${iterations} iteration(s) - completion promise detected`,
          max_iterations: `⏹️ Ralph Loop stopped after ${iterations} iteration(s) - max iterations reached`,
          manual_cancel: `🛑 Ralph Loop cancelled after ${iterations} iteration(s)`,
          error: `❌ Ralph Loop failed after ${iterations} iteration(s)`,
        };
        store.addMessage("system", reasonMessages[reason]);
        store.clearProgress();
        store.setState("idle");
      });
      return;
    }

    const requestId = data.request_id ?? undefined;
    const metaLines: string[] = [];
    if (data.duration_ms != null) {
      metaLines.push(`Duration: ${Math.round(data.duration_ms)}ms`);
    }
    if (data.tools_used?.length) {
      metaLines.push(`Tools: ${data.tools_used.join(", ")}`);
    }
    if (error) {
      metaLines.push(`Error: ${error}`);
    }

    const meta = metaLines.length ? metaLines.join("\n") : undefined;

    // Batch all final state updates for a single render
    store.batch(() => {
      if (requestId && meta) {
        store.updateMessageMeta(requestId, meta);
      }

      if (!content && error) {
        if (requestId && messageExists(store.getSnapshot().history, requestId)) {
          store.updateMessageText(requestId, `Error: ${error}`, meta);
        } else {
          store.addMessage("system", `Error: ${error}`);
        }
      } else if (!content && data.success === false) {
        const fallback = "Error: Request failed with no details. Check logs for diagnostics.";
        if (requestId && messageExists(store.getSnapshot().history, requestId)) {
          store.updateMessageText(requestId, fallback, meta);
        } else {
          store.addMessage("system", fallback);
        }
      }

      // Use streamed content if available, otherwise use response content
      const streamedContent = store.getSnapshot().streamingText;
      const finalContent = streamedContent && streamedContent.trim().length > 0
        ? streamedContent
        : content;

      if (finalContent && requestId && messageExists(store.getSnapshot().history, requestId)) {
        store.updateMessageText(requestId, finalContent, meta);
      } else if (finalContent && (!requestId || !messageExists(store.getSnapshot().history, requestId))) {
        store.addMessage("agent", finalContent, meta, requestId);
      }

      store.finalizeStreaming();
      store.clearProgress();
      store.setState("idle");
    });
  };

  const handleTranscription = (data?: TranscriptionData) => {
    if (!data?.text) {
      return;
    }
    loggerRef.current?.transcript("voice", data.text);
    store.replaceInput(data.text);
    const cache = fileCacheRef.current;
    if (cache) {
      store.updateAutocomplete(cache);
    }
    store.ensureInputCursorVisible(widthRef.current - 2, prompt, DEFAULT_MAX_INPUT_LINES);
  };

  /**
   * Validates user prompt event data at the boundary.
   * Returns { valid: boolean, error?: string } with detailed error message if invalid.
   */
  const validateUserPromptData = (data: unknown): { valid: boolean; error?: string } => {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Data is missing or not an object' };
    }

    const payload = data as Record<string, unknown>;

    // Validate required request_id field
    if (!payload.request_id || typeof payload.request_id !== 'string') {
      return { valid: false, error: 'Missing or invalid request_id (must be a string)' };
    }

    // Validate that either question (single) or questions (array) is present
    const hasSingleQuestion = 'question' in payload && typeof payload.question === 'string';
    const hasMultipleQuestions = 'questions' in payload && Array.isArray(payload.questions);

    if (!hasSingleQuestion && !hasMultipleQuestions) {
      return { valid: false, error: 'Missing question or questions array' };
    }

    // Validate questions array is not empty
    if (hasMultipleQuestions && (payload.questions as unknown[]).length === 0) {
      return { valid: false, error: 'questions array must not be empty' };
    }

    // Validate questions array elements have required fields
    if (hasMultipleQuestions) {
      for (let i = 0; i < (payload.questions as unknown[]).length; i++) {
        const q = (payload.questions as unknown[])[i];
        if (!q || typeof q !== 'object') {
          return { valid: false, error: `questions[${i}] is not an object` };
        }
        const questionObj = q as Record<string, unknown>;
        if (!questionObj.question || typeof questionObj.question !== 'string') {
          return { valid: false, error: `questions[${i}] missing or invalid question field` };
        }
      }
    }

    return { valid: true };
  };

  const handleUserPrompt = (data?: UserPromptData) => {
    // Validate at the entry point
    const validation = validateUserPromptData(data);
    if (!validation.valid) {
      store.addMessage('system', `Invalid user prompt event: ${validation.error}`);
      return;
    }

    // After validation, we know data is an object with required fields
    const validatedData = data as { request_id: string; question?: string; questions?: unknown[] };

    // Helper to infer question type from options and flags
    const inferQuestionType = (
      opts?: Array<string | { label: string; description?: string }>,
      multiSelect?: boolean,
      questionType?: string
    ): QuestionType => {
      if (questionType === "plan_mode_exit") return "plan_mode_exit";
      if (questionType === "spec_review") return "spec_review";
      if (!opts || opts.length === 0) return "free_text";
      if (multiSelect) return "multi_select";
      const labels = opts.map((opt) =>
        (typeof opt === "string" ? opt : opt.label).toLowerCase()
      );
      if (labels.length === 2 && labels.every((l) => ["yes", "no", "y", "n"].includes(l))) {
        return "yes_no";
      }
      return "multiple_choice";
    };

    // Helper to convert raw question data to AgentQuestion with defensive field guards
    // Supports both snake_case (wire format) and camelCase (legacy) for robustness
    const toAgentQuestion = (
      q: UserPromptQuestion,
      requestId: string,
      index: number
    ): AgentQuestion => {
      // Guard against missing or empty question field (though validation should have caught this)
      const questionText = q.question || 'Question text missing';

      // Guard against missing options - default to empty array
      const rawOptions = q.options || [];

      // Safely map options, filtering out malformed ones
      const processedOptions = rawOptions
        .map((opt): QuestionOption | null => {
          // Guard against null/undefined options
          if (!opt) return null;

          let label: string;
          let description: string | undefined;

          if (typeof opt === 'string') {
            label = opt;
          } else if (typeof opt === 'object' && opt.label) {
            label = opt.label;
            description = opt.description;
          } else {
            // Option object missing label - skip it
            return null;
          }

          return {
            id: label,
            label,
            description,
          };
        })
        .filter((opt): opt is QuestionOption => opt !== null);

      // Support both snake_case (wire format) and camelCase (legacy/agent format)
      const qAny = q as unknown as Record<string, unknown>;
      const multiSelect = q.multi_select ?? (qAny.multiSelect as boolean | undefined);
      const questionType = q.question_type ?? (qAny.questionType as string | undefined);

      return {
        requestId: `${requestId}_q${index}`,
        type: inferQuestionType(rawOptions, multiSelect, questionType),
        question: questionText,
        context: q.context,
        options: processedOptions,
      };
    };

    // Handle multiple questions
    if (validatedData.questions && validatedData.questions.length > 0) {
      const questions = validatedData.questions.map((q, i) =>
        toAgentQuestion(q as UserPromptQuestion, validatedData.request_id, i)
      );
      store.setQuestionQueue(questions, validatedData.request_id);
      return;
    }

    // Handle single question (backwards compatible)
    if (!validatedData.question) return;

    // Guard against malformed options in single question branch
    const rawSingleOptions = (data as UserPromptData).options || [];
    const processedSingleOptions = rawSingleOptions
      .map((opt): QuestionOption | null => {
        // Guard against null/undefined options
        if (!opt) return null;

        let label: string;
        let description: string | undefined;

        if (typeof opt === 'string') {
          label = opt;
        } else if (typeof opt === 'object' && opt.label) {
          label = opt.label;
          description = opt.description;
        } else {
          // Option object missing label - skip it
          return null;
        }

        return {
          id: label,
          label,
          description,
        };
      })
      .filter((opt): opt is QuestionOption => opt !== null);

    const question: AgentQuestion = {
      requestId: validatedData.request_id,
      type: inferQuestionType(
        rawSingleOptions,
        (data as UserPromptData).multi_select,
        (data as UserPromptData).question_type
      ),
      question: validatedData.question,
      context: (data as UserPromptData).context,
      options: processedSingleOptions,
    };

    store.setActiveQuestion(question, validatedData.request_id);
  };

  const handleProviderKeyRequired = (data?: ProviderKeyRequiredData) => {
    const provider = data?.provider;
    const model = data?.model;
    const message = provider
      ? model
        ? `API key required for provider "${provider}" to use model "${model}". Use /providers to configure.`
        : `API key required for provider "${provider}". Use /providers to configure.`
      : "API key required to continue. Use /providers to configure.";
    // Don't auto-switch to providers mode - just show message and let user decide
    store.addMessage("system", message);
  };

  const handleModelChanged = (data?: ModelChangedData) => {
    const selectedModel = data?.selectedModel ?? data?.model ?? null;
    const selectedProvider = data?.selectedProvider ?? data?.provider ?? null;
    const reasoning = typeof data?.reasoning === "string" ? data.reasoning : null;
    const agentType = (data as { agentType?: string })?.agentType ?? 'standard';

    if (selectedModel && selectedProvider) {
      store.setModelSelection(agentType, {
        model: selectedModel,
        provider: selectedProvider,
        reasoning: reasoning ?? undefined,
      });
    } else {
      store.setModelSelection(agentType, null);
    }
  };

  const handlePermissionRequest = (data?: PermissionRequestData) => {
    if (!data || !data.request_id) {
      store.addMessage("system", "Invalid permission request received");
      return;
    }

    store.setActivePermissionRequest(data);
  };

  const handleError = (data?: ErrorData) => {
    const message = data?.message ?? "An error occurred";
    let detailText = "";
    if (data?.detail !== undefined) {
      if (typeof data.detail === "string") {
        detailText = data.detail;
      } else {
        try {
          detailText = JSON.stringify(data.detail, null, 2);
        } catch {
          detailText = "[Unable to serialize error details]";
        }
      }
    }
    const detail = detailText ? `\n${detailText}` : "";
    store.batch(() => {
      store.addMessage("system", `${message}${detail}`);
      store.setError(message);
    });
    if (data?.fatal) {
      store.addMessage("system", "Fatal error reported by harness. UI will remain open; restart if needed.");
    }
  };

  const refreshAutocomplete = () => {
    const cache = fileCacheRef.current;
    if (cache) {
      store.updateAutocomplete(cache);
    }
  };

  const sendCommand = (type: BridgeCommandType, data?: Record<string, unknown>) => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    // Always include working_dir with requests that trigger agent execution
    // This ensures tools run in the correct directory regardless of where daemon was started
    const needsWorkingDir =
      type === "send_text" ||
      type === "user_prompt_response" ||
      type === "ralph_loop_start" ||
      type === "async_start";
    const payload = needsWorkingDir
      ? { ...data, working_dir: process.cwd() }
      : data;
    client.send({ type, data: payload });
  };

  const handleQuit = () => {
    onExit?.();
    exit();
  };

  const handleFork = async () => {
    const client = clientRef.current;
    if (!client) {
      store.addMessage("system", "Fork failed: Bridge not connected");
      return;
    }

    store.addMessage("system", "Forking session...");

    const result = await client.sessionFork();

    if (!result.success) {
      store.addMessage("system", `Fork failed: ${result.error ?? "Unknown error"}`);
      return;
    }

    const workingDir = process.cwd();
    const launcherPath = path.join(PROJECT_ROOT, "apps", "launcher", "index.ts");
    const spawnResult = spawnForkedSession(result.newSessionKey!, workingDir, launcherPath);

    if (spawnResult.autoSpawned) {
      store.addMessage("system", `Fork successful: ${spawnResult.message}`);
    } else {
      store.addMessage("system", `Fork successful: ${spawnResult.message}`);
      if (spawnResult.error) {
        store.addMessage("system", `tmux error: ${spawnResult.error}`);
      }
      if (spawnResult.command) {
        store.addMessage("system", `Run in new terminal: ${spawnResult.command}`);
      }
      store.addMessage("system", "TIP: Run inside tmux for automatic fork spawning");
    }
  };

  // Skills and hooks commands - read-only listing
  const handleSkillsCommand = (arg?: string) => {
    const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    if (!sub || sub === "list") {
      store.setUIMode("skills");
      sendCommand("skills_list");
      return;
    }
    store.addMessage("system", "Skills are read-only in TUI. Use /skills to list. To create/edit, ask the agent.");
  };

  const handleHooksCommand = (arg?: string) => {
    const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    if (!sub || sub === "list") {
      store.setUIMode("hooks");
      sendCommand("hooks_list");
      return;
    }
    store.addMessage("system", "Hooks are read-only in TUI. Use /hooks to list. To create/edit, ask the agent.");
  };

  useInput((input, key) => {
    const keyExtras = key as typeof key & { f1?: boolean; home?: boolean; end?: boolean };
    if (key.ctrl && input === "c") {
      handleQuit();
      return;
    }

    if (snapshot.helpVisible) {
      if (key.escape || key.return || keyExtras.f1 || (key.ctrl && input === "k")) {
        store.setHelpVisible(false);
      }
      return;
    }

    if (keyExtras.f1 || (key.ctrl && input === "k")) {
      store.toggleHelp();
      return;
    }

    // Skills/hooks/usage list modes - escape to return to chat, block all other input
    // Note: providers mode has its own internal navigation and handles escape in ProvidersView
    if (snapshot.uiMode === "skills" || snapshot.uiMode === "hooks" || snapshot.uiMode === "usage") {
      if (key.escape) {
        if (snapshot.uiMode === "usage") {
          store.exitUsageMode();
        } else {
          store.setUIMode("chat");
        }
      }
      // Block all input in these modes - they have their own handlers
      return;
    }

    // Providers mode - let ProvidersView handle all input including escape
    if (snapshot.uiMode === "providers") {
      return;
    }

    // Response mode - escape to return to chat
    if (snapshot.uiMode === "response") {
      if (key.escape) {
        store.clearResponseContent();
      }
      // Block all input in response mode
      return;
    }

    // Theme selection mode
    if (snapshot.uiMode === "theme") {
      const themeNames = getThemeNames();

      if (key.escape) {
        store.exitThemeMode();
        return;
      }

      if (key.upArrow) {
        store.moveThemeCursor(-1, themeNames.length);
        return;
      }

      if (key.downArrow) {
        store.moveThemeCursor(1, themeNames.length);
        return;
      }

      if (key.return) {
        const selectedTheme = themeNames[snapshot.themeCursor];
        if (selectedTheme) {
          setTheme(selectedTheme);
          store.addMessage("system", `Theme set to "${themes[selectedTheme].name}".`);
        }
        store.exitThemeMode();
        return;
      }

      // Consume all other input in theme mode
      return;
    }

    // Models selection mode
    if (snapshot.uiMode === "models") {
      if (key.escape) {
        store.exitModelsMode();
        return;
      }

      // Tab switching with left/right arrows
      const AGENT_TABS = ['standard', 'explorer', 'coding'];
      if (key.leftArrow) {
        const currentTab = store.getModelsActiveTab();
        const currentIdx = AGENT_TABS.indexOf(currentTab);
        const newIdx = (currentIdx - 1 + AGENT_TABS.length) % AGENT_TABS.length;
        store.setModelsActiveTab(AGENT_TABS[newIdx]);
        return;
      }

      if (key.rightArrow) {
        const currentTab = store.getModelsActiveTab();
        const currentIdx = AGENT_TABS.indexOf(currentTab);
        const newIdx = (currentIdx + 1) % AGENT_TABS.length;
        store.setModelsActiveTab(AGENT_TABS[newIdx]);
        return;
      }

      if (key.upArrow) {
        store.moveModelsCursor(-1);
        return;
      }

      if (key.downArrow) {
        store.moveModelsCursor(1);
        return;
      }

      // Space to stage the current model for this agent type
      if (input === " ") {
        store.stageModelAtCursor();
        return;
      }

      if (key.return) {
        // Apply all staged selections and persist full state
        store.applyAllStagedSelections();
        const selections = store.getAllModelSelections();
        for (const [agentType, selection] of selections) {
          sendCommand("set_model", {
            agent_type: agentType,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
          });
        }
        store.exitModelsMode();
        return;
      }

      // Two-step delete: 'd' to mark, then 'd' or Enter to confirm
      if (input === "d" || input === "D") {
        if (snapshot.modelDeletePending) {
          // Confirm delete
          const removed = store.removeModelAtCursor();
          if (removed) {
            sendCommand("models_delete", {
              provider: removed.provider,
              model: removed.id,
            });
          }
        } else {
          // First press - mark for deletion
          store.setModelDeletePending(true);
        }
        return;
      }

      // Any other key cancels pending delete
      if (snapshot.modelDeletePending) {
        store.setModelDeletePending(false);
        return;
      }

      // Consume all other input in models mode
      return;
    }

    // Sessions selection mode
    if (snapshot.uiMode === "sessions") {
      if (key.escape) {
        store.exitSessionsMode();
        return;
      }

      if (key.upArrow) {
        store.moveSessionsCursor(-1);
        return;
      }

      if (key.downArrow) {
        store.moveSessionsCursor(1);
        return;
      }

      if (key.return) {
        const selected = store.getSelectedSession();
        if (selected) {
          store.exitSessionsMode();
          store.addMessage("system", `Switching to session ${selected.sessionKey}...`);

          const client = clientRef.current;
          if (client) {
            client.send({
              type: "init",
              data: {
                session_key: selected.sessionKey,
                working_dir: selected.workingDir ?? process.cwd(),
              },
            });
          }
        }
        return;
      }

      // Consume all other input in sessions mode
      return;
    }

    // Question mode input handling
    if (snapshot.uiMode === "question" && snapshot.activeQuestion) {
      const questionType = snapshot.activeQuestion.type;

      // Escape cancels the question
      if (key.escape) {
        store.clearQuestion();
        return;
      }

      // Navigation for option-based questions
      if (snapshot.activeQuestion.options && snapshot.activeQuestion.options.length > 0) {
        if (key.upArrow) {
          store.selectQuestionOption(-1);
          return;
        }
        if (key.downArrow) {
          store.selectQuestionOption(1);
          return;
        }

        // Space toggles selection for multi-select
        if (input === " " && questionType === "multi_select") {
          store.toggleQuestionSelection();
          return;
        }

        // Enter selects for single-select or submits for multi-select
        if (key.return) {
          if (questionType === "multiple_choice" || questionType === "yes_no" || questionType === "plan_mode_exit" || questionType === "spec_review") {
            store.toggleQuestionSelection();
          }

          // Handle plan_mode_exit: if user selected first option ("Yes, exit"), disable plan mode
          // Use questionCursor since toggleQuestionSelection sets selection = [cursor]
          if (questionType === "plan_mode_exit") {
            if (snapshot.questionCursor === 0) {
              store.batch(() => {
                store.setPlanMode(false);
                store.addMessage("system", "Plan mode disabled. Full tool access restored.");
              });
            }
          }

          // Handle spec_review: if user selected first option ("Yes, execute"), disable plan mode
          if (questionType === "spec_review") {
            if (snapshot.questionCursor === 0) {
              store.batch(() => {
                store.setPlanMode(false);
                store.addMessage("system", "Plan mode disabled. Executing implementation.");
              });
            }
          }

          // Format the answer for display before advancing
          const currentQuestion = snapshot.activeQuestion;
          let displayAnswer = '';
          if (currentQuestion?.options && snapshot.questionSelection.length > 0) {
            const selectedLabels = snapshot.questionSelection
              .map(i => currentQuestion.options?.[i]?.label)
              .filter(Boolean);
            displayAnswer = selectedLabels.join(', ');
          }

          // Check if there are more questions in the queue
          const hasMoreQuestions = store.saveAnswerAndAdvance();
          if (!hasMoreQuestions) {
            // All questions answered - send response
            const requestId = store.getQuestionRequestId();
            const allAnswers = store.getAllAnswers();
            // For single question, send the single answer; for multiple, send array
            const answer = allAnswers.size === 1
              ? allAnswers.values().next().value
              : Object.fromEntries(allAnswers);

            // Add user's answer to chat history for visibility
            if (displayAnswer) {
              store.addMessage("user", displayAnswer);
            }

            sendCommand("user_prompt_response", {
              request_id: requestId,
              answer,
            });
            store.clearQuestion();
          }
          return;
        }
      }

      // Text input for fill_in_blank/free_text
      if (questionType === "fill_in_blank" || questionType === "free_text") {
        // Handle backspace
        const firstCharCode = input.length > 0 ? input.charCodeAt(0) : -1;
        const isBackspace =
          key.backspace || key.delete || input === "\x7f" || input === "\b" ||
          firstCharCode === 127 || firstCharCode === 8;
        if (isBackspace) {
          store.backspaceQuestionInput();
          return;
        }

        // Enter submits
        if (key.return && !key.shift) {
          // Capture the answer text before advancing
          const answerText = snapshot.questionInput;

          // Check if there are more questions in the queue
          const hasMoreQuestions = store.saveAnswerAndAdvance();
          if (!hasMoreQuestions) {
            // All questions answered - send response
            const requestId = store.getQuestionRequestId();
            const allAnswers = store.getAllAnswers();
            const answer = allAnswers.size === 1
              ? allAnswers.values().next().value
              : Object.fromEntries(allAnswers);

            // Add user's answer to chat history for visibility
            if (answerText) {
              store.addMessage("user", answerText);
            }

            sendCommand("user_prompt_response", {
              request_id: requestId,
              answer,
            });
            store.clearQuestion();
          }
          return;
        }

        // Shift+Enter adds newline for free_text
        if (key.return && key.shift && questionType === "free_text") {
          store.appendQuestionInput("\n");
          return;
        }

        // Regular text input
        if (input && !key.ctrl && !key.meta) {
          // Filter control chars and escape sequence fragments that leak through
          // Preserve whitespace: tab (\x09), newline (\x0a), carriage return (\x0d)
          // Remove other control characters: NUL through \x08, \x0b-\x0c, \x0e-\x1f, DEL (\x7f)
          const printable = input
            .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "")  // Control chars except tab/newline/cr
            .replace(/\[200~/g, "")                        // Bracketed paste start
            .replace(/\[201~/g, "")                        // Bracketed paste end
            .replace(/\[[ABCD]/g, "")                      // Arrow key fragments [A, [B, [C, [D
            .replace(/O[ABCD]/g, "")                       // Alt arrow key fragments OA, OB, OC, OD
            .replace(/\[\d+~/g, "")                        // Function/special keys [5~, [6~, etc.
            .replace(/\[\d+;\d+[~ABCDHF]/g, "")            // Modified keys with parameters
            .replace(/\[<\d+;\d+;\d+[Mm]/g, "")// Mouse sequences
            .replace(/\[?\[/g, "");            // Leftover brackets from sequences
          if (printable) {
            store.appendQuestionInput(printable);
          }
          return;
        }
      }

      // Consume all input in question mode to prevent interference
      return;
    }

    // Permission mode input handling
    if (snapshot.uiMode === "permission" && snapshot.activePermissionRequest) {
      // Navigation with j/k and arrow keys
      if (key.upArrow || input === "k") {
        store.movePermissionCursor(-1);
        return;
      }
      if (key.downArrow || input === "j") {
        store.movePermissionCursor(1);
        return;
      }

      // Enter selects the current option
      if (key.return) {
        const request = store.getActivePermissionRequest();
        if (request) {
          const decision = store.getPermissionDecision();
          sendCommand("permission_response", {
            request_id: request.request_id,
            decision,
            pattern: decision === "always_allow" ? request.suggested_pattern : undefined,
          });
          store.clearPermissionRequest();
        }
        return;
      }

      // Quick keys: 1=Allow, 2=Always Allow, 3=Deny
      if (input === "1") {
        const request = store.getActivePermissionRequest();
        if (request) {
          sendCommand("permission_response", {
            request_id: request.request_id,
            decision: "allow",
          });
          store.clearPermissionRequest();
        }
        return;
      }
      if (input === "2") {
        const request = store.getActivePermissionRequest();
        if (request) {
          sendCommand("permission_response", {
            request_id: request.request_id,
            decision: "always_allow",
            pattern: request.suggested_pattern,
          });
          store.clearPermissionRequest();
        }
        return;
      }
      if (input === "3") {
        const request = store.getActivePermissionRequest();
        if (request) {
          sendCommand("permission_response", {
            request_id: request.request_id,
            decision: "deny",
          });
          store.clearPermissionRequest();
        }
        return;
      }

      // Consume all other input in permission mode
      return;
    }

    // Debug: log key events early to catch everything
    const loggerEarly = loggerRef.current;
    if (loggerEarly) {
      const charCodes = input ? Array.from(input).map((c) => c.charCodeAt(0)) : [];
      loggerEarly.info("Key event (early)", {
        input: input || "(empty)",
        inputLength: input.length,
        charCodes,
        keyBackspace: key.backspace,
        state: snapshot.state,
      });
    }

    if (snapshot.state === "error") {
      store.clearError();
    }

    if (snapshot.uiMode === "chat" && handleVoiceKeys(input, key)) {
      return;
    }

    // Debug: log ALL key events to understand what's being received
    const logger = loggerRef.current;
    if (logger) {
      const charCodes = input ? Array.from(input).map((c) => c.charCodeAt(0)) : [];
      logger.info("Key pressed", {
        input: input || "(empty)",
        inputLength: input.length,
        charCodes,
        keyBackspace: key.backspace,
        keyDelete: key.delete,
        keyCtrl: key.ctrl,
        keyMeta: key.meta,
        keyReturn: key.return,
        keyEscape: key.escape,
        keyTab: key.tab,
        keyUpArrow: key.upArrow,
        keyDownArrow: key.downArrow,
        keyLeftArrow: key.leftArrow,
        keyRightArrow: key.rightArrow,
      });
    }

    // Handle backspace - on macOS, ink reports backspace as key.delete!
    const firstCharCode = input.length > 0 ? input.charCodeAt(0) : -1;
    const isBackspace =
      key.backspace ||             // ink's backspace detection
      key.delete ||                // macOS reports backspace as delete!
      input === "\x7f" ||          // DEL character (ASCII 127)
      input === "\b" ||            // BS character (ASCII 8)
      firstCharCode === 127 ||     // DEL
      firstCharCode === 8;         // BS
    if (isBackspace) {
      store.backspace();
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (snapshot.autocomplete.active) {
      if (key.return && !key.shift) {
        store.acceptAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (key.tab) {
        store.acceptAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (key.escape) {
        store.clearAutocomplete();
        return;
      }
      if (key.upArrow) {
        store.selectAutocomplete(-1);
        return;
      }
      if (key.downArrow) {
        store.selectAutocomplete(1);
        return;
      }
    }

    if (key.return && key.shift) {
      store.insertInput("\n");
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.return) {
      const text = snapshot.inputText;
      if (!text.trim()) {
        return;
      }

      if (deleteFlowRef.current) {
        void handleDeleteFlowInput(text);
        store.clearInput();
        return;
      }

      const command = parseSlashCommand(text);
      if (command) {
        handleSlashCommand(command.command, command.arg);
        store.clearInput();
        return;
      }

      const requestId = `ink_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      if (snapshot.uiMode !== "chat") {
        store.setUIMode("chat");
      }

      // Auto-trigger planning mode: "planning mode <prompt>" or "/plan <prompt>"
      let effectiveText = text;
      let effectivePlanMode = snapshot.planMode;
      const lowerText = text.toLowerCase();
      if (lowerText.startsWith("planning mode ") || lowerText.startsWith("/plan ")) {
        const prefixLen = lowerText.startsWith("planning mode ") ? 14 : 6;
        effectiveText = text.slice(prefixLen).trim();
        if (effectiveText && !effectivePlanMode) {
          effectivePlanMode = true;
        }
      }

      store.batch(() => {
        // Commit any active streaming content to history before adding the user message
        // This ensures proper chronological ordering when user sends follow-up during streaming
        if (snapshot.streamingText) {
          store.addMessage("agent", snapshot.streamingText, undefined, snapshot.streamingRequestId ?? undefined);
          store.finalizeStreaming();
          store.finalizeReasoning();
        }
        if (effectivePlanMode && !snapshot.planMode) {
          store.setPlanMode(true);
          store.addMessage("system", "Plan mode auto-enabled. Exploring and planning before implementation.");
        }
        store.addMessage("user", effectiveText);
        store.clearInput();
        store.incrementRequestCount();
        store.clearProgress();
        store.setState("sending");
      });
      loggerRef.current?.transcript("user", effectiveText);

      sendCommand("send_text", {
        text: effectiveText,
        client_request_id: requestId,
        plan_mode: effectivePlanMode,
      });
      return;
    }

    if (key.tab) {
      if (snapshot.autocomplete.active) {
        store.batch(() => {
          store.acceptAutocomplete();
          store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        });
      }
      return;
    }

    if (key.delete) {
      store.deleteForward();
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.leftArrow) {
      store.moveCursor(-1);
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.rightArrow) {
      store.moveCursor(1);
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    // Shift+Up/Down for scrolling history (more intuitive than PageUp/Down)
    if (key.upArrow && key.shift) {
      store.scrollBy(1, maxScrollRef.current);
      return;
    }

    if (key.downArrow && key.shift) {
      store.scrollBy(-1, maxScrollRef.current);
      return;
    }

    if (key.upArrow) {
      store.moveCursorUp(contentWidth, prompt);
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.downArrow) {
      store.moveCursorDown(contentWidth, prompt);
      refreshAutocomplete();
      store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.pageUp) {
      const page = Math.max(1, historyHeightRef.current - 2);
      store.scrollBy(page, maxScrollRef.current);
      return;
    }

    if (key.pageDown) {
      const page = Math.max(1, historyHeightRef.current - 2);
      store.scrollBy(-page, maxScrollRef.current);
      return;
    }

    if (keyExtras.home) {
      store.scrollToTop(maxScrollRef.current);
      return;
    }

    if (keyExtras.end) {
      store.scrollToBottom();
      return;
    }

    // Escape shortcuts: Esc+M for model, Esc+T for reasoning
    // Supports both: holding Esc (sends as meta/escape modifier) or Esc-then-key (leader pattern)
    const LEADER_TIMEOUT = 300;
    const now = Date.now();
    const isAfterEscapeLeader = now - escapeLeaderRef.current < LEADER_TIMEOUT;

    const cycleModel = () => {
      const models = snapshot.modelsAvailableList;
      if (models.length === 0) {
        const message = snapshot.modelsList.length > 0
          ? "No accessible models. Configure a provider with /providers."
          : "No models available. Run /models to fetch model list.";
        store.addMessage("system", message);
        return;
      }
      // Cycle the 'standard' agent type model (main/default)
      const selection = snapshot.modelSelections.get('standard');
      const currentId = selection?.model;
      const currentProvider = selection?.provider;
      let currentIdx = currentId
        ? models.findIndex((m) => m.id === currentId && (!currentProvider || m.provider === currentProvider))
        : -1;
      if (currentIdx < 0) currentIdx = -1;
      const nextIdx = (currentIdx + 1) % models.length;
      const nextModel = models[nextIdx];
      if (!nextModel) return;
      sendCommand("set_model", {
        agent_type: 'standard',
        provider: nextModel.provider,
        model: nextModel.id,
        ...(nextModel.reasoning?.[0] ? { reasoning: nextModel.reasoning[0] } : {}),
      });
    };

    const cycleReasoning = () => {
      // Cycle reasoning for 'standard' agent type (main/default)
      const selection = snapshot.modelSelections.get('standard');
      const currentModel = selection
        ? snapshot.modelsList.find((m) => m.id === selection.model && m.provider === selection.provider)
        : null;
      const levels = currentModel?.reasoning ?? [];
      if (!currentModel || levels.length === 0) {
        store.addMessage("system", "Current model does not support reasoning levels.");
        return;
      }
      const currentLevel = selection?.reasoning;
      let currentIdx = currentLevel ? levels.indexOf(currentLevel) : -1;
      if (currentIdx < 0) currentIdx = 0;
      const nextIdx = (currentIdx + 1) % levels.length;
      const nextLevel = levels[nextIdx];
      if (!currentModel.provider) {
        store.addMessage("system", "Current model is missing a provider.");
        return;
      }
      sendCommand("set_model", {
        agent_type: 'standard',
        provider: currentModel.provider,
        model: currentModel.id,
        reasoning: nextLevel,
      });
    };

    // Check for held Esc+key (appears as meta or escape modifier in terminals)
    // Also handle raw escape sequences: \x1b + letter (sent by some terminals when holding Esc)
    if ((key.meta || key.escape) && !key.ctrl) {
      const lowerInput = input.toLowerCase();
      if (lowerInput === "m") {
        cycleModel();
        return;
      }
      if (lowerInput === "t") {
        cycleReasoning();
        return;
      }
    }

    // Handle raw escape sequences: \x1bm or \x1bt (Esc held + letter in some terminals)
    if (input.length === 2 && input.charCodeAt(0) === 0x1b) {
      const letter = input[1].toLowerCase();
      if (letter === "m") {
        cycleModel();
        return;
      }
      if (letter === "t") {
        cycleReasoning();
        return;
      }
    }

    // Pure escape press - record for leader key sequence
    if (key.escape && !input && !isResponseMode && !isProvidersMode && !isModelsMode && !isSessionsMode && !isThemeMode && !isUsageMode) {
      escapeLeaderRef.current = now;
      return;
    }

    // Leader-key follow-up: Esc then M/T (for terminals that don't support held Esc)
    if (isAfterEscapeLeader && !key.ctrl && !key.meta) {
      if (input === "m" || input === "M") {
        escapeLeaderRef.current = 0;
        cycleModel();
        return;
      }
      if (input === "t" || input === "T") {
        escapeLeaderRef.current = 0;
        cycleReasoning();
        return;
      }
      escapeLeaderRef.current = 0;
    }

    if (key.ctrl) {
      if (input === "a") {
        store.moveCursorTo(0);
        refreshAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (input === "e") {
        store.moveCursorTo(snapshot.inputText.length);
        refreshAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (input === "u") {
        store.clearInput();
        return;
      }
      if (input === "w") {
        store.deleteWordBack();
        refreshAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
    }

    // Skip all input while pasting - useBracketedPaste handles paste content
    if (store.isPasting()) {
      return;
    }

    // Only insert printable characters (filter out control chars that weren't handled above)
    if (input && !key.ctrl && !key.meta) {
      // Filter control chars and escape sequence fragments that leak through
      // Preserve whitespace: tab (\x09), newline (\x0a), carriage return (\x0d), form feed (\x0c)
      // Remove other control characters: NUL through \x08 (includes \x07 BEL), \x0b-\x0c, \x0e-\x1f, DEL (\x7f)
      const printable = input
        .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "")  // Control chars except tab/newline/cr
        .replace(/\[200~/g, "")                        // Bracketed paste start
        .replace(/\[201~/g, "")                        // Bracketed paste end
        .replace(/\[[ABCD]/g, "")                      // Arrow key fragments [A, [B, [C, [D
        .replace(/O[ABCD]/g, "")                       // Alt arrow key fragments OA, OB, OC, OD
        .replace(/\[\d+~/g, "")                        // Function/special keys [5~, [6~, etc.
        .replace(/\[\d+;\d+[~ABCDHF]/g, "")            // Modified keys with parameters
        .replace(/\[<\d+;\d+;\d+[Mm]/g, "")            // Mouse sequences
        .replace(/\[?\[/g, "");                        // Leftover brackets from sequences
      if (printable) {
        store.insertInput(printable);
        refreshAutocomplete();
        store.ensureInputCursorVisible(contentWidth, prompt, DEFAULT_MAX_INPUT_LINES);
      }
    }
  });

  const startDeleteFlow = async (arg?: string) => {
    if (arg) {
      deleteFlowRef.current = { stage: "confirm", sessions: [], selectedKey: arg };
      store.addMessage("system", `Delete session ${arg}? (y/n)`);
      return;
    }

    store.addMessage("system", "Fetching active sessions...");
    try {
      const sessions = await fetchGraphdSessions();
      const active = sessions.filter((s) => s.status === "active");
      if (active.length === 0) {
        store.addMessage("system", "No active sessions found.");
        deleteFlowRef.current = null;
        return;
      }

      store.addMessage("system", "Select a session to delete:");
      active.forEach((session, idx) => {
        const suffix = session.working_dir
          ? ` (${session.working_dir.split("/").pop()})`
          : "";
        store.addMessage("system", `${idx + 1}. ${session.session_key}${suffix}`);
      });
      store.addMessage("system", "Enter a number or session key, or type 'cancel'.");
      deleteFlowRef.current = { stage: "select", sessions: active };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      store.addMessage("system", `Failed to fetch sessions: ${message}`);
      deleteFlowRef.current = null;
    }
  };

  const handleDeleteFlowInput = async (text: string) => {
    const flow = deleteFlowRef.current;
    if (!flow) return;

    const input = text.trim();
    if (!input) {
      return;
    }

    const normalized = input.toLowerCase();
    const isCancel = ["cancel", "/cancel", "n", "no"].includes(normalized);

    if (flow.stage === "select") {
      if (isCancel) {
        store.addMessage("system", "Delete cancelled.");
        deleteFlowRef.current = null;
        return;
      }

      let selected: GraphDSession | undefined;
      if (/^\\d+$/.test(input)) {
        const idx = Number.parseInt(input, 10) - 1;
        selected = flow.sessions[idx];
      } else {
        selected = flow.sessions.find((s) => s.session_key === input);
      }

      if (!selected) {
        store.addMessage("system", "Invalid selection. Enter a number, session key, or 'cancel'.");
        return;
      }

      deleteFlowRef.current = { stage: "confirm", sessions: flow.sessions, selectedKey: selected.session_key };
      store.addMessage("system", `Delete session ${selected.session_key}? (y/n)`);
      return;
    }

    if (flow.stage === "confirm") {
      if (isCancel) {
        store.addMessage("system", "Delete cancelled.");
        deleteFlowRef.current = null;
        return;
      }

      if (["y", "yes"].includes(normalized)) {
        const target = flow.selectedKey;
        if (!target) {
          deleteFlowRef.current = null;
          return;
        }

        store.addMessage("system", `Deleting session ${target}...`);
        const deleted = await deleteGraphdSession(target);
        store.addMessage(
          "system",
          deleted ? `Deleted session ${target}.` : `Failed to delete session ${target}.`,
        );
        deleteFlowRef.current = null;
        return;
      }

      store.addMessage("system", "Please answer 'y' to confirm or 'n' to cancel.");
    }
  };

  const startSessionsFlow = async () => {
    const client = clientRef.current;
    if (!client) {
      store.addMessage("system", "Client not connected.");
      return;
    }

    store.addMessage("system", "Fetching recoverable sessions...");
    try {
      const result = await client.listSessions({
        status: ["active", "inactive"],
        limit: 20,
      });

      if (!result.success) {
        store.addMessage("system", `Failed to fetch sessions: ${result.error ?? "Unknown error"}`);
        return;
      }

      if (result.sessions.length === 0) {
        store.addMessage("system", "No recoverable sessions found.");
        return;
      }

      // Convert to SessionEntry format and enter sessions selection mode
      store.setSessionsList(result.sessions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      store.addMessage("system", `Failed to fetch sessions: ${message}`);
    }
  };

  const startUsageFlow = async () => {
    store.setUsageLoading(true);
    store.setUIMode("usage");

    try {
      const { sessions, dayStats, providerStats } = await fetchUsageData();
      store.batch(() => {
        store.setUsageSessions(sessions);
        store.setUsageAnalytics(dayStats, providerStats);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      store.batch(() => {
        store.addMessage("system", `Failed to fetch usage data: ${message}`);
        store.exitUsageMode();
      });
    }
  };

  const handleSlashCommand = (command: string, arg?: string) => {
    switch (command) {
      case "/help":
        store.setHelpVisible(true);
        return;
      case "/config":
        sendCommand("get_config");
        return;
      case "/models":
        pendingModelsModeRef.current = true;
        sendCommand("get_models");
        return;
      case "/providers":
        store.setUIMode("providers");
        return;
      case "/skills":
        handleSkillsCommand(arg);
        return;
      case "/hooks":
        handleHooksCommand(arg);
        return;
      case "/sessions":
        void startSessionsFlow();
        return;
      case "/usage":
        void startUsageFlow();
        return;
      case "/delete":
        void startDeleteFlow(arg);
        return;
      case "/compact":
        store.addMessage("system", "Compacting conversation context...");
        sendCommand("compact_context");
        return;
      case "/watcher": {
        // Parse subcommand from arg
        const subParts = (arg ?? "").trim().split(/\s+/);
        const subCommand = subParts[0]?.toLowerCase() || "status";
        const subArg = subParts.slice(1).join(" ");

        switch (subCommand) {
          case "status":
            sendCommand("watcher_status");
            break;
          case "context":
            sendCommand("watcher_context");
            break;
          case "search":
            if (!subArg) {
              store.addMessage("system", "Usage: /watcher search <query>");
              return;
            }
            sendCommand("watcher_search", { query: subArg });
            break;
          case "decisions":
            sendCommand("watcher_decisions");
            break;
          case "inspect":
            if (!subArg) {
              store.addMessage("system", "Usage: /watcher inspect <id>");
              return;
            }
            sendCommand("watcher_inspect", { id: subArg });
            break;
          case "memory":
            sendCommand("watcher_memory");
            break;
          case "focus":
            if (!subArg) {
              store.addMessage("system", "Usage: /watcher focus <topic>");
              return;
            }
            sendCommand("watcher_focus", { topic: subArg });
            break;
          case "defocus":
            sendCommand("watcher_defocus");
            break;
          case "reanchor":
            if (!subArg) {
              store.addMessage("system", "Usage: /watcher reanchor <goal>");
              return;
            }
            sendCommand("watcher_reanchor", { goal: subArg });
            break;
          case "summarize":
            store.addMessage("system", "Triggering watcher summarization...");
            sendCommand("watcher_summarize");
            break;
          default:
            store.addMessage("system",
              "Usage: /watcher [subcommand]\n" +
              "  status         Watcher status + config\n" +
              "  context        Context window telemetry\n" +
              "  search <query> Search decisions\n" +
              "  decisions      List all decisions\n" +
              "  inspect <id>   Inspect decision detail\n" +
              "  memory         Session decision memory\n" +
              "  focus <topic>  Set scoring bias\n" +
              "  defocus        Clear scoring bias\n" +
              "  reanchor <goal> Update salience goal\n" +
              "  summarize      Compact + epistemic ledger"
            );
        }
        return;
      }
      case "/plan": {
        const currentPlanMode = snapshot.planMode;
        store.batch(() => {
          store.setPlanMode(!currentPlanMode);
          store.addMessage(
            "system",
            !currentPlanMode
              ? "Plan mode enabled. Write/Edit tools disabled. Agent will explore and plan before implementing."
              : "Plan mode disabled. Full tool access restored."
          );
        });
        return;
      }
      case "/ralph-loop": {
        // Handle cancel command
        if (arg?.trim().toLowerCase() === "cancel") {
          if (!store.isRalphActive()) {
            store.addMessage("system", "No Ralph Loop is currently active.");
            return;
          }
          sendCommand("ralph_loop_cancel");
          store.batch(() => {
            store.addMessage("system", "Cancelling Ralph Loop...");
            store.clearRalphState();
          });
          return;
        }

        // Check if loop is already active
        if (store.isRalphActive()) {
          store.addMessage("system", "A Ralph Loop is already active. Use /ralph-loop cancel to stop it first.");
          return;
        }

        // Parse arguments
        const ralphArgs = parseRalphArgs(arg ?? "");
        if (!ralphArgs) {
          store.addMessage(
            "system",
            "Usage: /ralph-loop <prompt> [--max-iterations=N] [--complete=\"PHRASE\"]\n" +
            "       /ralph-loop @<file.md> [options]\n" +
            "       /ralph-loop cancel\n\n" +
            "Examples:\n" +
            "  /ralph-loop \"Build a REST API\"\n" +
            "  /ralph-loop @prompts/task.md --max-iterations=10\n" +
            "  /ralph-loop \"Build tests\" --complete=\"ALL DONE\""
          );
          return;
        }

        // Start the Ralph Loop
        store.batch(() => {
          store.setRalphState(true, 0, ralphArgs.maxIterations, ralphArgs.completionPromise);
          store.addMessage(
            "system",
            `🔄 Starting Ralph Loop (max ${ralphArgs.maxIterations} iterations)\n` +
            `Completion phrase: "${ralphArgs.completionPromise}"\n` +
            (ralphArgs.fromFile ? `Prompt loaded from file` : `Prompt: ${ralphArgs.prompt.slice(0, 100)}${ralphArgs.prompt.length > 100 ? "..." : ""}`)
          );
        });

        sendCommand("ralph_loop_start", {
          prompt: ralphArgs.prompt,
          maxIterations: ralphArgs.maxIterations,
          completionPromise: ralphArgs.completionPromise,
        });
        return;
      }
      case "/async": {
        const asyncArg = arg?.trim() ?? "";

        if (asyncArg === "cancel") {
          store.addMessage("system", "Cancelling async session...");
          sendCommand("async_cancel", {});
          return;
        }

        if (asyncArg === "status") {
          sendCommand("async_status", {});
          return;
        }

        if (!asyncArg) {
          store.addMessage(
            "system",
            "Usage: /async <goal>\n\n" +
            "Starts an async session with watcher oversight.\n" +
            "The watcher agent autonomously answers questions,\n" +
            "quality-gates completed work, and realigns drifting agents.\n\n" +
            "Subcommands:\n" +
            "  /async cancel   Cancel running async session\n" +
            "  /async status   Check async session status\n\n" +
            "Examples:\n" +
            "  /async implement user authentication\n" +
            "  /async refactor the payment module to use Stripe"
          );
          return;
        }

        const goal = asyncArg;
        store.batch(() => {
          store.addMessage("system", `Starting async session...\nGoal: ${goal}`);
          store.setState("sending");
        });

        sendCommand("async_start", { goal });
        return;
      }
      case "/theme": {
        // Enter interactive theme selection mode
        const themeNames = getThemeNames();
        const currentIndex = themeNames.indexOf(getCurrentThemeName());
        store.enterThemeMode(Math.max(0, currentIndex));
        return;
      }
      case "/fork":
        void handleFork();
        return;
      case "/voice": {
        const enabled = !snapshot.voiceMode;
        if (enabled && !snapshot.capabilities.voiceAvailable) {
          store.addMessage("system", "Voice mode not available.");
          return;
        }
        store.batch(() => {
          store.setVoiceMode(enabled);
          store.addMessage(
            "system",
            enabled
              ? "Voice mode enabled. Hold SPACE to record, press SPACE or Esc to stop."
              : "Voice mode disabled.",
          );
        });
        return;
      }
      case "/clear":
        store.clearHistory();
        return;
      case "/exit":
        handleQuit();
        return;
      default:
        store.addMessage("system", `Unknown command: ${command}`);
    }
  };

  const handleVoiceKeys = (input: string, key: { escape?: boolean }) => {
    const voiceState = voiceStateRef.current;
    if (voiceState.recording) {
      if (key.escape) {
        stopVoiceRecording();
        return true;
      }
      if (input === " ") {
        const now = Date.now();
        if (voiceState.manualStopMode) {
          stopVoiceRecording();
          return true;
        }
        if (!voiceState.repeatConfirmed && now - voiceState.startAt >= 200) {
          voiceState.repeatConfirmed = true;
        }
        voiceState.lastSpaceAt = now;
        return true;
      }
      return true;
    }

    if (
      input === " " &&
      snapshot.voiceMode &&
      snapshot.capabilities.voiceAvailable &&
      snapshot.inputText.length === 0
    ) {
      startVoiceRecording();
      return true;
    }

    return false;
  };

  const startVoiceRecording = () => {
    const voiceState = voiceStateRef.current;
    voiceState.recording = true;
    voiceState.repeatConfirmed = false;
    voiceState.manualStopMode = false;
    voiceState.startAt = Date.now();
    voiceState.lastSpaceAt = voiceState.startAt;

    store.setState("recording", "Recording...");
    sendCommand("voice_start");

    if (voiceState.interval) {
      clearInterval(voiceState.interval);
    }

    voiceState.interval = setInterval(() => {
      const now = Date.now();
      if (!voiceState.recording) {
        return;
      }

      if (voiceState.repeatConfirmed) {
        if (now - voiceState.lastSpaceAt > 150) {
          stopVoiceRecording();
        }
        return;
      }

      if (!voiceState.manualStopMode && now - voiceState.startAt > 700) {
        voiceState.manualStopMode = true;
        store.setStatus("Release detection unavailable. Press space or Esc to stop.");
      }

      if (now - voiceState.startAt > 60000) {
        stopVoiceRecording();
      }
    }, 50);
  };

  const stopVoiceRecording = () => {
    const voiceState = voiceStateRef.current;
    if (!voiceState.recording) {
      return;
    }
    voiceState.recording = false;
    voiceState.repeatConfirmed = false;
    voiceState.manualStopMode = false;

    if (voiceState.interval) {
      clearInterval(voiceState.interval);
      voiceState.interval = null;
    }

    store.setState("transcribing", "Transcribing...");
    sendCommand("voice_stop");
  };

  const colors = getColors();
  const activeQuestion = snapshot.activeQuestion ?? null;
  const isQuestionMode = snapshot.uiMode === "question" && !!activeQuestion;
  const statusLine = snapshot.progressMessage || snapshot.statusMessage;
  const statusSpinner = isBusy
    ? STATUS_SPINNER_FRAMES[statusTick % STATUS_SPINNER_FRAMES.length]
    : "";
  const statusBase = statusLine || "Ready";
  const statusText = statusSpinner ? `${statusSpinner} ${statusBase}` : statusBase;
  // Use progress level for coloring when available
  const statusColor = snapshot.progressMessage
    ? levelColor(snapshot.progressLevel)
    : colors.muted;
  const scrollInfo = snapshot.scrollOffset > 0 ? `Scroll ${snapshot.scrollOffset}` : "";
  const newMessageInfo = snapshot.newMessages ? "New messages" : "";
  const rightStatus = [scrollInfo, newMessageInfo].filter(Boolean).join(" | ");

  const headerRows: Array<{
    left: string;
    right?: string;
    leftColor?: string;
    rightColor?: string;
    boldLeft?: boolean;
    boldRight?: boolean;
  }> = [
    {
      left: "Bloom",
      right: `Session ${snapshot.sessionKey ?? "-"}`,
      leftColor: colors.accent,
      rightColor: colors.muted,
      boldLeft: true,
    },
    {
      left: `State: ${snapshot.state}${snapshot.planMode ? " | PLAN" : ""}`,
      right: `Voice ${snapshot.voiceMode ? "on" : "off"} | Mode ${snapshot.uiMode}`,
      leftColor: colors.muted,
      rightColor: colors.muted,
    },
    {
      left: `Status: ${statusText}`,
      right: rightStatus,
      leftColor: statusColor,
      rightColor: colors.muted,
    },
    {
      left: "─".repeat(contentWidth),
      leftColor: colors.border,
    },
  ];
  const headerHeight = headerRows.length;

  const buildQuestionRender = () => {
    if (!activeQuestion) return null;
    const textWidth = Math.max(20, contentWidth - MESSAGE_GUTTER * 2);
    const questionLines = wrapText(activeQuestion.question, textWidth);
    const contextLines = activeQuestion.context ? wrapText(activeQuestion.context, textWidth) : [];
    const hasOptions = !!activeQuestion.options && activeQuestion.options.length > 0;
    const isTextInput = activeQuestion.type === "fill_in_blank" || activeQuestion.type === "free_text";
    const isMulti = activeQuestion.type === "multi_select";
    const optionsLines: Array<{ text: string; muted?: boolean; strong?: boolean }> = [];

    if (hasOptions) {
      activeQuestion.options!.forEach((opt, idx) => {
        const isCursor = idx === snapshot.questionCursor;
        const isSelected = snapshot.questionSelection.includes(idx);
        const cursorMarker = isCursor ? ">" : " ";
        const selectMark = isMulti ? (isSelected ? "[x]" : "[ ]") : (isSelected ? "(x)" : "( )");
        const indexLabel = `${idx + 1}.`.padStart(3, " ");
        const prefix = `${cursorMarker} ${indexLabel} ${selectMark} `;
        const labelWidth = Math.max(8, textWidth - prefix.length);
        const labelLines = wrapText(opt.label, labelWidth);
        labelLines.forEach((line, lineIdx) => {
          const linePrefix = lineIdx === 0 ? prefix : " ".repeat(prefix.length);
          optionsLines.push({
            text: `${linePrefix}${line}`,
            strong: isCursor || isSelected,
          });
        });
        if (opt.description) {
          const descPrefix = " ".repeat(prefix.length);
          const descLines = wrapText(opt.description, Math.max(8, textWidth - descPrefix.length));
          descLines.forEach((line) => {
            optionsLines.push({
              text: `${descPrefix}${line}`,
              muted: true,
            });
          });
        }
      });
    }

    const queueInfo = store.getQuestionQueueInfo();
    const showProgress = queueInfo && queueInfo.total > 1;
    const progressText = showProgress ? `[${queueInfo.current}/${queueInfo.total}]` : "";

    const needsGap = (hasOptions || isTextInput) && (questionLines.length > 0 || contextLines.length > 0);
    const inputPrefix = "Answer: ";
    const inputAvailable = Math.max(4, textWidth - inputPrefix.length - 1);
    const inputPlaceholder = activeQuestion.placeholder || "Type your answer...";
    const inputValue = snapshot.questionInput;
    const inputDisplay = truncateText(inputValue.length > 0 ? inputValue : inputPlaceholder, inputAvailable);

    const actionParts = ["Enter submit", "Esc cancel"];
    if (isMulti) actionParts.splice(1, 0, "Space toggle");
    if (activeQuestion.type === "free_text") actionParts.push("Shift+Enter newline");
    const actionsText = actionParts.join(" | ");

    const totalLines =
      1 + // header
      questionLines.length +
      contextLines.length +
      (needsGap ? 1 : 0) +
      optionsLines.length +
      (isTextInput ? 1 : 0) +
      1; // actions

    return {
      questionLines,
      contextLines,
      optionsLines,
      progressText,
      needsGap,
      isTextInput,
      inputPrefix,
      inputDisplay,
      inputIsPlaceholder: inputValue.length === 0,
      actionsText,
      totalLines,
    };
  };

  const questionRender = isQuestionMode ? buildQuestionRender() : null;
  const questionBlockHeight = questionRender ? questionRender.totalLines : 0;

  const inputLayout = computeInputLayout(snapshot.inputText.split(""), snapshot.cursor, contentWidth, prompt);
  const inputVisibleLines = Math.min(DEFAULT_MAX_INPUT_LINES, inputLayout.lines.length);
  // inputBoxHeight = top line (1) + input lines + bottom line (1) + model indicator row (1) + context info row (0 or 1)
  const hasContextInfo = !isQuestionMode && (snapshot.contextInputTokens !== null || snapshot.contextMaxWindowSize !== null || snapshot.cachedInput !== null);
  const inputBoxHeight = isQuestionMode
    ? questionBlockHeight + 1
    : 1 + inputVisibleLines + 1 + 1 + (hasContextInfo ? 1 : 0);
  const autocompleteHeight = snapshot.autocomplete.active
    ? snapshot.autocomplete.suggestions.length + 1
    : 0;
  const historyHeight = Math.max(
    3,
    height - headerHeight - inputBoxHeight - autocompleteHeight - TOP_PADDING - BOTTOM_PADDING,
  );

  historyHeightRef.current = historyHeight;

  const buildListLines = (
    title: string,
    items: Record<string, unknown>[],
    errors: string[],
    isSkills: boolean = false,
  ): HistoryLine[] => {
    const lines: HistoryLine[] = [];
    let index = 0;
    const pushLine = (text: string, role: Role) => {
      lines.push({ id: `list-${index++}`, text, role });
    };
    pushLine(`${title} (${items.length}) - Read Only`, "system");
    if (items.length === 0) {
      pushLine("No items found.", "system");
    } else {
      for (const item of items) {
        const enabled = item.enabled === true ? "enabled" : "disabled";
        const name = typeof item.name === "string" ? item.name : "";
        const id = typeof item.id === "string" ? item.id : "";
        pushLine(`- ${id} [${enabled}] ${name}`, "system");
      }
    }
    if (errors.length > 0) {
      pushLine("", "system");
      pushLine("Errors:", "system");
      for (const err of errors) {
        pushLine(`- ${err}`, "system");
      }
    }
    pushLine("", "system");
    pushLine("-".repeat(40), "system");
    const itemType = isSkills ? "skills" : "hooks";
    pushLine(`To create/edit ${itemType}, ask the agent to write ${itemType.toUpperCase().slice(0, -1)}.md files.`, "system");
    pushLine("Press Esc to return to chat.", "system");
    return lines;
  };

  const streamCursor = snapshot.state === "streaming"
    ? STREAM_CURSOR_FRAMES[statusTick % STREAM_CURSOR_FRAMES.length]
    : "";
  let historyLines = store.getHistoryLines(messageWidth, streamCursor);
  if (snapshot.uiMode === "skills") {
    historyLines = buildListLines("Skills", snapshot.skillsList, snapshot.skillsErrors, true);
  } else if (snapshot.uiMode === "hooks") {
    historyLines = buildListLines("Hooks", snapshot.hooksList, snapshot.hooksErrors, false);
  }
  // Apply markdown-aware spacing in chat mode
  if (snapshot.uiMode === "chat") {
    historyLines = applyVisualSpacing(historyLines);
  }
  const totalHistoryLines = historyLines.length;
  const maxScroll = Math.max(0, totalHistoryLines - historyHeight);
  maxScrollRef.current = maxScroll;

  useEffect(() => {
    // If scrollOffset exceeds maxScroll (content shrunk or window grew),
    // snap to bottom rather than clamping to maxScroll
    if (snapshot.scrollOffset > maxScroll) {
      store.setScrollOffset(0);
    }
  }, [snapshot.scrollOffset, maxScroll, store]);

  const scrollOffset = Math.min(snapshot.scrollOffset, maxScroll);

  // Slice historyLines to only render the visible portion
  // scrollOffset = 0 means at bottom (newest), scrollOffset = N means N lines up from bottom
  const totalLines = historyLines.length;
  const visibleEndIndex = totalLines - scrollOffset;
  const visibleStartIndex = Math.max(0, visibleEndIndex - historyHeight);
  const sliced = historyLines.slice(visibleStartIndex, visibleEndIndex);

  // Bottom-alignment padding: when content is less than viewport height,
  // pad the array with empty lines at the beginning so content renders at the bottom
  // Use space character (not empty string) so Ink renders with actual height
  const padding = Math.max(0, historyHeight - sliced.length);
  const visibleHistoryLines: HistoryLine[] = [
    // Padding lines at TOP of viewport (pushes content to bottom)
    ...Array(padding).fill(null).map((_, i) => ({
      id: `pad:${i}`,
      text: " ",
      role: undefined as Role | undefined,
    })),
    // Actual content at BOTTOM of viewport
    ...sliced,
  ];

  const renderInputLines = () => {
    const lines = [...inputLayout.lines];
    const cursorLine = inputLayout.cursorLine;
    const cursorCol = inputLayout.cursorCol;

    if (lines[cursorLine] !== undefined) {
      const line = lines[cursorLine];
      lines[cursorLine] = line.slice(0, cursorCol) + "|" + line.slice(cursorCol);
    }

    const start = snapshot.inputScrollOffset;
    const end = start + inputVisibleLines;
    return lines.slice(start, end).map((line, idx) => {
      const globalIndex = start + idx;
      const prefix = globalIndex === 0 ? prompt : " ".repeat(prompt.length);
      return `${prefix}${line}`.padEnd(contentWidth, " ").slice(0, contentWidth);
    });
  };

  const inputLines = renderInputLines();
  // Simple horizontal line for input separator
  const horizontalLine = "─".repeat(contentWidth);

  // Get current model/reasoning for footer display (default: 'standard' agent type)
  const standardSelection = snapshot.modelSelections.get('standard');
  const currentModelEntry = standardSelection
    ? snapshot.modelsList.find((m) => m.id === standardSelection.model && m.provider === standardSelection.provider)
    : null;
  const reasoningOptions = currentModelEntry?.reasoning ?? [];
  const hasReasoning = reasoningOptions.length > 0;

  // Track last LLM call (for per-agent visibility in async mode)
  const lastAgentType = snapshot.lastLlmAgentType;
  const lastModelId = snapshot.lastLlmModel;
  const lastProvider = snapshot.lastLlmProvider;
  const lastModelEntry = lastModelId
    ? snapshot.modelsList.find((m) => m.id === lastModelId && (!lastProvider || m.provider === lastProvider))
    : null;
  const lastModelName = lastModelId ? (lastModelEntry?.name ?? lastModelId) : null;
  const showLastModel = !!lastModelName;

  if (snapshot.helpVisible) {
    return (
      <Box flexDirection="column" paddingLeft={2} paddingTop={1} width={contentWidth}>
        {HELP_LINES.map((line, index) => {
          // Section headers (lines ending with :)
          const isHeader = line.endsWith(":");
          // Command lines (starting with spaces and /)
          const isCommand = line.trimStart().startsWith("/");
          const color = isHeader ? colors.accent : isCommand ? colors.func : colors.muted;
          return <Text key={`help-${index}`} color={color} bold={isHeader}>{line}</Text>;
        })}
        <Text color={colors.muted}>Press Esc, Enter, or Ctrl+K to close.</Text>
      </Box>
    );
  }

  // Question mode: render inline question text instead of a modal
  const isPermissionMode = snapshot.uiMode === "permission" && snapshot.activePermissionRequest;
  const isThemeMode = snapshot.uiMode === "theme";
  const isModelsMode = snapshot.uiMode === "models";
  const isSessionsMode = snapshot.uiMode === "sessions";
  const isProvidersMode = snapshot.uiMode === "providers";
  const isUsageMode = snapshot.uiMode === "usage";
  const isResponseMode = snapshot.uiMode === "response" && snapshot.responseContent;

  // Theme selector rendering
  const renderThemeSelector = () => {
    const themeNames = getThemeNames();
    const colors = getColors();
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={colors.accent}>Select Theme</Text>
        <Text color={colors.muted}>Use ↑↓ to navigate, Enter to select, Esc to cancel</Text>
        <Text> </Text>
        {themeNames.map((name, index) => {
          const t = themes[name];
          const isSelected = index === snapshot.themeCursor;
          const isCurrent = name === getCurrentThemeName();
          const pointer = isSelected ? "▸ " : "  ";
          const marker = isCurrent ? " (current)" : "";
          return (
            <Text key={name}>
              <Text color={isSelected ? colors.accent : colors.muted}>{pointer}</Text>
              <Text color={isSelected ? colors.text : colors.muted} bold={isSelected}>
                {t.name}
              </Text>
              <Text color={colors.muted}> - {t.description}{marker}</Text>
            </Text>
          );
        })}
      </Box>
    );
  };

  // Models selector rendering with tabbed UI for per-agent-type configuration
  const renderModelsSelector = () => {
    const colors = getColors();
    const AGENT_TABS = ['standard', 'explorer', 'coding'];
    const TAB_LABELS: Record<string, string> = {
      standard: 'Standard',
      explorer: 'Explorer',
      coding: 'Coding',
    };
    const activeTab = snapshot.modelsActiveTab;
    // Staged selection for active tab (what will be applied on Enter)
    const stagedSelection = snapshot.stagedModelSelections.get(activeTab);
    const stagedModel = stagedSelection?.model ?? null;
    const stagedProvider = stagedSelection?.provider ?? null;
    // Applied selection for active tab (what's currently active in backend)
    const appliedSelection = snapshot.modelSelections.get(activeTab);
    const appliedModel = appliedSelection?.model ?? null;
    const appliedProvider = appliedSelection?.provider ?? null;
    const deletePending = snapshot.modelDeletePending;
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {/* Tabbed header for agent types */}
        <Box marginBottom={1}>
          <Text color={colors.muted}>←/→ tab  Space select  Enter apply  </Text>
          {AGENT_TABS.map((tab, index) => {
            const isActive = tab === activeTab;
            const label = TAB_LABELS[tab];
            const tabStaged = snapshot.stagedModelSelections.get(tab);
            const tabApplied = snapshot.modelSelections.get(tab);
            // Check if staged differs from applied (pending change)
            const hasChange = tabStaged && (!tabApplied || tabStaged.model !== tabApplied.model || tabStaged.provider !== tabApplied.provider);
            const hasApplied = !!tabApplied;
            return (
              <Text key={tab}>
                {index > 0 && <Text color={colors.muted}> | </Text>}
                <Text color={isActive ? colors.accent : colors.muted} bold={isActive}>
                  {label}
                </Text>
                {hasChange ? (
                  <Text color={colors.success}>✓</Text>
                ) : hasApplied ? (
                  <Text color={colors.func}>*</Text>
                ) : null}
              </Text>
            );
          })}
        </Box>
        <Box>
          <Text bold color={colors.accent}>Select Model for {TAB_LABELS[activeTab]}</Text>
          {deletePending ? (
            <Text color={colors.error}>  d to confirm delete</Text>
          ) : (
            <Text color={colors.muted}>  d to delete</Text>
          )}
        </Box>
        <Text> </Text>
        {snapshot.modelsList.map((model, index) => {
          const isSelected = index === snapshot.modelsCursor;
          // Check if this model is staged for current tab
          const isStaged = stagedProvider
            ? model.id === stagedModel && model.provider === stagedProvider
            : model.id === stagedModel;
          // Check if this model is currently applied in backend
          const isApplied = appliedProvider
            ? model.id === appliedModel && model.provider === appliedProvider
            : model.id === appliedModel;
          const isPendingDelete = isSelected && deletePending;
          const pointer = isSelected ? "▸ " : "  ";
          // Show markers: ✓ for staged, * for applied (if different)
          let marker = "";
          if (isStaged && isApplied) {
            marker = " (current)";
          } else if (isStaged) {
            marker = " (selected)";
          } else if (isApplied) {
            marker = " (current)";
          }
          const provider = model.provider;
          const hasReasoning = model.reasoning && model.reasoning.length > 0;
          return (
            <Text key={`${provider ?? 'unknown'}:${model.id}`}>
              <Text color={isPendingDelete ? colors.error : (isSelected ? colors.accent : colors.muted)}>{pointer}</Text>
              {isStaged && <Text color={colors.success}>✓ </Text>}
              <Text
                color={isPendingDelete ? colors.error : (isStaged ? colors.success : (isSelected ? colors.text : colors.muted))}
                bold={isSelected || isStaged}
                strikethrough={isPendingDelete}
              >
                {model.name}
              </Text>
              {provider && <Text color={isPendingDelete ? colors.error : colors.muted} strikethrough={isPendingDelete}> [{provider}]</Text>}
              {hasReasoning && <Text color={isPendingDelete ? colors.error : colors.func} strikethrough={isPendingDelete}> [R]</Text>}
              <Text color={isPendingDelete ? colors.error : (isStaged ? colors.success : colors.muted)} strikethrough={isPendingDelete}>{marker}</Text>
            </Text>
          );
        })}
      </Box>
    );
  };

  // Sessions selector uses the SessionsView component
  const sessionsHeight = historyHeight + inputBoxHeight;

  // Full-screen modes that replace both history and input
  const isFullScreenMode = isResponseMode || isProvidersMode || isThemeMode || isModelsMode || isSessionsMode || isUsageMode || isPermissionMode;

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={HORIZONTAL_PADDING} paddingTop={TOP_PADDING} paddingBottom={BOTTOM_PADDING}>
      {headerRows.map((row, index) => {
        const left = row.left ?? "";
        const right = row.right ?? "";
        if (!right) {
          return (
            <Text key={`header-${index}`} color={row.leftColor} bold={row.boldLeft}>
              {left.slice(0, contentWidth)}
            </Text>
          );
        }
        const maxLeft = Math.max(0, contentWidth - right.length - 1);
        const leftText = left.length > maxLeft ? left.slice(0, maxLeft) : left;
        const gap = Math.max(1, contentWidth - leftText.length - right.length);
        return (
          <Text key={`header-${index}`}>
            <Text color={row.leftColor} bold={row.boldLeft}>{leftText}</Text>
            <Text>{" ".repeat(gap)}</Text>
            <Text color={row.rightColor} bold={row.boldRight}>{right}</Text>
          </Text>
        );
      })}
      {!isFullScreenMode && (
        <Box flexDirection="column" height={historyHeight}>
          {visibleHistoryLines.map((line, index) => {
            const isUserLine = line.role === "user";
            const isReasoning = line.role === "reasoning";
            const bgColor = isUserLine ? colors.userBg : undefined;
            const leftPad = MESSAGE_GUTTER;
            const rightPad = MESSAGE_GUTTER;
            const baseText = line.text ?? "";
            const visible = visibleLength(baseText);
            const remainingWidth = contentWidth - (leftPad + visible + rightPad);
            const rightFill = remainingWidth > 0 ? remainingWidth : 0;
            return (
              <Box key={line.id ?? `hist-${index}`}>
                <Text width={contentWidth} backgroundColor={bgColor}>
                  <StyledLine
                    text={baseText}
                    baseColor={roleColor(line.role)}
                    italic={isReasoning}
                    segments={line.segments}
                    padLeft={leftPad}
                    padRight={rightPad + rightFill}
                  />
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      {isResponseMode ? (
        <ResponsePane
          content={snapshot.responseContent!}
          width={contentWidth}
          height={historyHeight + inputBoxHeight}
        />
      ) : isProvidersMode && clientRef.current ? (
        <ProvidersView
          width={contentWidth}
          bridgeClient={clientRef.current}
          onClose={() => store.setUIMode("chat")}
        />
      ) : isProvidersMode ? (
        <Box height={historyHeight + inputBoxHeight} width={contentWidth} justifyContent="center" alignItems="center">
          <Text color={colors.error}>Bridge not connected.</Text>
        </Box>
      ) : isThemeMode ? (
        renderThemeSelector()
      ) : isModelsMode ? (
        renderModelsSelector()
      ) : isSessionsMode ? (
        <SessionsView
          sessions={snapshot.sessionsList}
          cursor={snapshot.sessionsCursor}
          currentSessionKey={snapshot.sessionKey}
          width={contentWidth}
          height={sessionsHeight}
        />
      ) : isUsageMode ? (
        <UsageView
          sessions={snapshot.usageSessions}
          cursor={snapshot.usageCursor}
          viewMode={snapshot.usageViewMode}
          dayStats={snapshot.usageDayStats}
          providerStats={snapshot.usageProviderStats}
          loading={snapshot.usageLoading}
          width={contentWidth}
          height={sessionsHeight}
          onMoveCursor={(delta) => store.moveUsageCursor(delta)}
          onSetViewMode={(mode) => store.setUsageViewMode(mode)}
          onRefresh={() => void startUsageFlow()}
          onClose={() => store.exitUsageMode()}
        />
      ) : isPermissionMode ? (
        <Box flexDirection="column" justifyContent="center" alignItems="center" flexGrow={1}>
          <PermissionPrompt
            request={snapshot.activePermissionRequest!}
            cursor={snapshot.permissionCursor}
            width={contentWidth}
            height={PROMPT_MAX_CONTENT_HEIGHT}
          />
        </Box>
      ) : (
        <>
          {isQuestionMode && questionRender && (
            <Box flexDirection="column" paddingX={MESSAGE_GUTTER}>
              <Text>
                <Text color={colors.warning} bold>? </Text>
                <Text color={colors.text} bold>Question</Text>
                {questionRender.progressText && (
                  <Text color={colors.muted}> {questionRender.progressText}</Text>
                )}
              </Text>
              {questionRender.questionLines.map((line, i) => (
                <Text key={`q-inline-${i}`} color={colors.text}>{line}</Text>
              ))}
              {questionRender.contextLines.map((line, i) => (
                <Text key={`q-context-${i}`} color={colors.muted}>{line}</Text>
              ))}
              {questionRender.needsGap && <Text> </Text>}
              {questionRender.optionsLines.map((line, i) => (
                <Text
                  key={`q-opt-${i}`}
                  color={line.muted ? colors.muted : colors.text}
                  bold={line.strong}
                >
                  {line.text}
                </Text>
              ))}
              {questionRender.isTextInput && (
                <Text>
                  <Text color={questionRender.inputIsPlaceholder ? colors.muted : colors.text}>
                    {questionRender.inputPrefix}{questionRender.inputDisplay}
                  </Text>
                  <Text color={colors.accent}>|</Text>
                </Text>
              )}
              <Text color={colors.muted}>{questionRender.actionsText}</Text>
            </Box>
          )}

          {/* Top separator line - runs edge to edge */}
          {!isQuestionMode && <Text color={colors.border}>{horizontalLine}</Text>}

          {/* Input lines - no side borders */}
          {!isQuestionMode && inputLines.map((line, index) => (
            <Text key={`input-${index}`} color={colors.text}>{line}</Text>
          ))}

          {/* Bottom separator line - runs edge to edge */}
          {!isQuestionMode && <Text color={colors.border}>{horizontalLine}</Text>}

          {/* Model indicator row: model (Esc+M) | reasoning (Esc+T) */}
          <Text>
            {(() => {
              const standardBaseName = standardSelection?.model
                ? (currentModelEntry?.name ?? standardSelection.model)
                : "no model selected";
              const standardProviderLabel = standardSelection?.provider;
              const standardModelName = standardProviderLabel && standardBaseName !== "no model selected"
                ? `${standardBaseName} [${standardProviderLabel}]`
                : standardBaseName;

              const displayModelName = showLastModel && lastModelName
                ? `${lastModelName}${lastProvider ? ` [${lastProvider}]` : ""}`
                : standardModelName;
              const agentSuffix = showLastModel && lastAgentType ? ` (${lastAgentType})` : "";
              const modelHint = lastAgentType && lastAgentType !== 'standard'
                ? "Esc+M (standard)"
                : "Esc+M";
              const reasoningLevel = hasReasoning ? (standardSelection?.reasoning ?? "off") : "n/a";
              // Layout: modelName (Esc+M) | reasoning (Esc+T) or n/a
              const rightContent = hasReasoning
                ? `${displayModelName}${agentSuffix} (${modelHint}) | ${reasoningLevel} (Esc+T)`
                : `${displayModelName}${agentSuffix} (${modelHint}) | n/a`;
              const padding = 2;
              const gap = contentWidth - rightContent.length - (padding * 2);
              return (
                <>
                  <Text>{" ".repeat(padding)}</Text>
                  <Text>{" ".repeat(Math.max(0, gap))}</Text>
                  <Text color={colors.muted}>{displayModelName}</Text>
                  {agentSuffix && <Text color={colors.muted} dimColor>{agentSuffix}</Text>}
                  <Text color={colors.muted} dimColor>{` (${modelHint})`}</Text>
                  <Text color={colors.border}> | </Text>
                  <Text color={hasReasoning ? colors.func : colors.muted} dimColor={!hasReasoning}>{reasoningLevel}</Text>
                  {hasReasoning && <Text color={colors.muted} dimColor> (Esc+T)</Text>}
                  <Text>{" ".repeat(padding)}</Text>
                </>
              );
            })()}
          </Text>

          {/* Context window info row: tokens / total size, and cached input */}
          {!isQuestionMode && (snapshot.contextInputTokens !== null || snapshot.contextMaxWindowSize !== null || snapshot.cachedInput !== null) && (
            <Text>
              {(() => {
                const padding = 2;
                let parts: string[] = [];

                // Context window size: input / maxWindowSize
                if (snapshot.contextInputTokens !== null && snapshot.contextMaxWindowSize !== null) {
                  const percentage = Math.round((snapshot.contextInputTokens / snapshot.contextMaxWindowSize) * 100);
                  parts.push(`Ctx: ${snapshot.contextInputTokens}/${snapshot.contextMaxWindowSize} (${percentage}%)`);
                } else if (snapshot.contextInputTokens !== null) {
                  parts.push(`Ctx: ${snapshot.contextInputTokens} tokens`);
                } else if (snapshot.contextMaxWindowSize !== null) {
                  parts.push(`Ctx: /${snapshot.contextMaxWindowSize}`);
                }

                // Cached input (truncated to fit)
                if (snapshot.cachedInput !== null && snapshot.cachedInput.length > 0) {
                  const maxCachedLength = Math.floor((contentWidth - padding * 2 - (parts.length > 0 ? parts.join(" | ").length + 3 : 0)) / 2);
                  const truncated = snapshot.cachedInput.length > maxCachedLength
                    ? snapshot.cachedInput.slice(0, maxCachedLength - 3) + "..."
                    : snapshot.cachedInput;
                  parts.push(`Cache: ${truncated}`);
                }

                if (parts.length === 0) return null;

                const content = parts.join(" | ");
                const gap = contentWidth - content.length - (padding * 2);
                return (
                  <>
                    <Text>{" ".repeat(padding)}</Text>
                    <Text>{" ".repeat(Math.max(0, gap))}</Text>
                    <Text color={colors.muted} dimColor>{content}</Text>
                    <Text>{" ".repeat(padding)}</Text>
                  </>
                );
              })()}
            </Text>
          )}

          {/* Autocomplete dropdown */}
          {snapshot.autocomplete.active ? (
            <Box flexDirection="column" width={contentWidth}>
              <Text color={colors.border}>{horizontalLine}</Text>
              {snapshot.autocomplete.suggestions.map((suggestion, index) => {
                const isSelected = index === snapshot.autocomplete.selected;
                return (
                  <Text key={`ac-${index}`} color={isSelected ? colors.path : colors.muted}>
                    {isSelected ? "▸ " : "  "}
                    {suggestion}
                  </Text>
                );
              })}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

function formatWatcherPayload(kind: string, payload: Record<string, unknown> | undefined): string {
  if (!payload) return "No data returned.";

  switch (kind) {
    case "watcher_status": {
      const lines = ["[Watcher Status]"];
      lines.push(`  Enabled: ${payload.enabled ?? "unknown"}`);
      lines.push(`  Session: ${payload.sessionKey ?? "none"}`);
      lines.push(`  Focus: ${payload.focusTopic ?? "none"}`);
      lines.push(`  Salience Goal: ${payload.salienceGoal ?? "default"}`);
      lines.push(`  Context Items: ${payload.contextItems ?? 0}`);
      return lines.join("\n");
    }
    case "watcher_context": {
      const metrics = payload.metrics as Record<string, unknown> | undefined;
      if (!metrics) return "[Watcher Context]\n  No metrics available.";
      const lines = ["[Watcher Context]"];
      for (const [key, value] of Object.entries(metrics)) {
        lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
      return lines.join("\n");
    }
    case "watcher_search": {
      const results = payload.results as Array<Record<string, unknown>> | undefined;
      if (!results || results.length === 0) return `[Watcher Search] No results for "${payload.query}"`;
      const lines = [`[Watcher Search] ${results.length} result(s) for "${payload.query}"`];
      for (const r of results) {
        lines.push(`  [${r.id}] (${r.category}, ${r.priority}) ${r.summary}`);
      }
      return lines.join("\n");
    }
    case "watcher_decisions": {
      const decisions = payload.decisions as Array<Record<string, unknown>> | undefined;
      if (!decisions || decisions.length === 0) return "[Watcher Decisions] No decisions in database.";
      const lines = [`[Watcher Decisions] ${decisions.length} total`];
      for (const d of decisions) {
        lines.push(`  [${d.id}] ${d.type} (${d.category}, ${d.priority}) ${d.summary}`);
      }
      return lines.join("\n");
    }
    case "watcher_inspect": {
      const decision = payload.decision as Record<string, unknown> | undefined;
      if (!decision) return `[Watcher Inspect] ${payload.error ?? "Not found"}`;
      return `[Watcher Inspect]\n${JSON.stringify(decision, null, 2)}`;
    }
    case "watcher_memory": {
      const lines = ["[Watcher Memory]"];
      lines.push(`  Decisions Made: ${payload.decisionsMade ?? 0}`);
      lines.push(`  Consistency Score: ${payload.consistencyScore ?? 1.0}`);
      const patterns = payload.patterns as string[] | undefined;
      if (patterns && patterns.length > 0) {
        lines.push(`  Patterns: ${patterns.join(", ")}`);
      }
      const decisions = payload.decisions as Array<Record<string, unknown>> | undefined;
      if (decisions && decisions.length > 0) {
        lines.push("  Recent:");
        for (const d of decisions.slice(-5)) {
          lines.push(`    Q: ${d.question} -> A: ${String(d.answer).slice(0, 80)}`);
        }
      }
      return lines.join("\n");
    }
    case "watcher_focus":
      return `[Watcher Focus] Set to: ${payload.topic}`;
    case "watcher_defocus":
      return "[Watcher Focus] Cleared.";
    case "watcher_reanchor":
      return `[Watcher Reanchor] Goal set to: ${payload.goal}`;
    case "watcher_summarize": {
      const compaction = payload.compaction as Record<string, unknown> | undefined;
      const ledger = payload.ledger as Record<string, unknown> | undefined;
      const lines = ["[Watcher Summarize]"];
      if (compaction) {
        lines.push(`  Compaction: ${compaction.itemsRemoved} items removed, ${compaction.bytesRecovered} bytes recovered`);
      }
      if (ledger) {
        lines.push(`  Focus: ${ledger.focusTopic ?? "none"}`);
        lines.push(`  Goal: ${ledger.salienceGoal ?? "default"}`);
        lines.push(`  Decisions Made: ${ledger.decisionsMade ?? 0}`);
        lines.push(`  Consistency: ${ledger.consistencyScore ?? 1.0}`);
      }
      return lines.join("\n");
    }
    default:
      return JSON.stringify(payload, null, 2);
  }
}

function roleColor(role?: Role): string | undefined {
  const colors = getColors();
  // All message roles use neutral text color - theme colors reserved for syntax
  switch (role) {
    case "user":
    case "agent":
    case "system":
    case "status":
      return colors.text;
    case "reasoning":
      // Reasoning/thinking content displayed in muted color to distinguish from main response
      return colors.muted;
    default:
      return undefined;
  }
}

/** Maps event level to display color */
function levelColor(level?: string | null): string | undefined {
  const colors = getColors();
  switch (level) {
    case "success":
      return colors.success;
    case "error":
      return colors.error;
    case "warning":
      return colors.warning;
    case "info":
      return colors.info;
    default:
      return undefined;
  }
}

function resolveSegmentColor(color: HistoryTextSegment["color"], baseColor: string | undefined): string | undefined {
  const colors = getColors();
  switch (color) {
    // Legacy color names
    case "red":
      return colors.error;
    case "green":
      return colors.success;
    case "yellow":
      return colors.warning;
    case "blue":
      return colors.url;
    case "magenta":
      return colors.header;
    case "cyan":
      return colors.info;
    case "white":
      return colors.text;
    case "gray":
      return colors.muted;
    case "text":
      return colors.text;
    case "muted":
      return colors.muted;
    // Theme color keys for syntax highlighting
    case "code":
      return colors.code;
    case "path":
      return colors.path;
    case "func":
      return colors.func;
    case "url":
      return colors.url;
    case "number":
      return colors.number;
    case "header":
      return colors.header;
    case "bold":
      return colors.bold;
    case "italic":
      return colors.italic;
    case "strikethrough":
      return colors.strikethrough;
    case "blockquote":
      return colors.blockquote;
    case "listBullet":
      return colors.listBullet;
    case "link":
      return colors.link;
    case "linkText":
      return colors.linkText;
    case "hr":
      return colors.hr;
    case "border":
      return colors.border;
    case "diffAdd":
      return colors.diffAdd;
    case "diffRemove":
      return colors.diffRemove;
    case "diffHeader":
      return colors.diffHeader;
    case "success":
      return colors.success;
    case "error":
      return colors.error;
    case "warning":
      return colors.warning;
    case "info":
      return colors.info;
    default:
      return baseColor;
  }
}

function resolveSegmentBg(bgColor: HistoryTextSegment["bgColor"]): string | undefined {
  const colors = getColors();
  switch (bgColor) {
    case "red":
      return colors.error;
    case "green":
      return colors.success;
    case "yellow":
      return colors.warning;
    case "blue":
      return colors.info;
    case "magenta":
      return colors.header;
    case "cyan":
      return colors.info;
    case "white":
      return colors.text;
    case "gray":
      return colors.muted;
    case "userBg":
      return colors.userBg;
    case "diffContextBg":
      return colors.diffContextBg;
    default:
      return undefined;
  }
}

function renderHistorySegments(segments: HistoryTextSegment[], baseColor: string | undefined, lineItalic: boolean | undefined): JSX.Element {
  return (
    <>
      {segments.map((seg, i) => (
        <Text
          key={i}
          color={resolveSegmentColor(seg.color, baseColor)}
          backgroundColor={resolveSegmentBg(seg.bgColor)}
          bold={seg.bold}
          italic={lineItalic || seg.italic}
          underline={seg.underline}
          dimColor={seg.dim}
        >
          {seg.text}
        </Text>
      ))}
    </>
  );
}

/** Render text with syntax highlighting */
function StyledLine({
  text,
  baseColor,
  italic: lineItalic,
  segments,
  padLeft,
  padRight,
}: {
  text: string;
  baseColor?: string;
  italic?: boolean;
  segments?: HistoryTextSegment[];
  padLeft: number;
  padRight: number;
}): JSX.Element {
  const prefix = padLeft > 0 ? " ".repeat(padLeft) : "";
  const suffix = padRight > 0 ? " ".repeat(padRight) : "";

  if (hasAnsiCodes(text)) {
    return <Text>{prefix + text + suffix}</Text>;
  }

  return (
    <>
      {prefix ? <Text color={baseColor}>{prefix}</Text> : null}
      {segments
        ? renderHistorySegments(segments, baseColor, lineItalic)
        : parseTextSegments(text, baseColor).map((seg, i) => (
          <Text
            key={i}
            color={seg.color}
            backgroundColor={seg.backgroundColor}
            bold={seg.bold}
            italic={lineItalic || seg.italic}
            underline={seg.underline}
          >
            {seg.text}
          </Text>
        ))}
      {suffix ? <Text color={baseColor}>{suffix}</Text> : null}
    </>
  );
}

function messageExists(history: MessageEntry[], requestId: string): boolean {
  return history.some((entry) => entry.requestId === requestId);
}

export function parseArgs(argv: string[]): AppOptions {
  let uiLogPath = path.join(PROJECT_ROOT, "tui", "logs", "ink-ui.log");
  let enableVoice = true;
  let redactLogs = false;
  let logTranscripts = true;
  let sessionKey: string | null = null;
  let dangerousMode = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ui-log" && argv[i + 1]) {
      uiLogPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session" && argv[i + 1]) {
      sessionKey = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--dangerous") {
      dangerousMode = true;
      continue;
    }
    if (arg === "--no-voice") {
      enableVoice = false;
      continue;
    }
    if (arg === "--voice") {
      enableVoice = true;
      continue;
    }
    if (arg === "--redact") {
      redactLogs = true;
      continue;
    }
    if (arg === "--no-log-transcripts") {
      logTranscripts = false;
      continue;
    }
  }

  if (process.env.TUI_NO_TRANSCRIPTS === "1") {
    logTranscripts = false;
  }

  return { uiLogPath, enableVoice, redactLogs, logTranscripts, sessionKey, dangerousMode };
}

const options = parseArgs(process.argv.slice(2));

// Global cleanup reference for signal handlers
let globalCleanup: (() => void) | null = null;

// Double-cleanup guard to prevent race condition on rapid signals
let cleanupCalled = false;

// Handle graceful shutdown on signals
const handleSignal = (_signal: string) => {
  if (cleanupCalled) return;
  cleanupCalled = true;

  // Do NOT use console.log here - it breaks Ink's rendering
  if (globalCleanup) {
    globalCleanup();
  }
  // Give cleanup time to complete before exit (session close + connection close)
  setTimeout(() => process.exit(0), GRACEFUL_SHUTDOWN_DELAY);
};

// Process-level last resort handlers - catch anything that slips through
// IMPORTANT: Do NOT use console.log/error in these handlers as they break
// Ink's rendering and cause flickering. Errors are silently caught here;
// for debugging, check the UI log file.
process.on('uncaughtException', (_error: Error) => {
  // Attempt cleanup
  if (globalCleanup && !cleanupCalled) {
    cleanupCalled = true;
    try {
      globalCleanup();
    } catch {
      // Cleanup failed, nothing more we can do
    }
  }

  // Exit with error code after brief delay for cleanup
  setTimeout(() => process.exit(1), ERROR_EXIT_DELAY);
});

process.on('unhandledRejection', (_reason: unknown) => {
  // Don't exit for unhandled rejections - silently continue
  // The specific operation failed but the app can continue
});

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGHUP', () => handleSignal('SIGHUP'));

// Export cleanup setter for App component
export const setGlobalCleanup = (cleanup: () => void) => {
  globalCleanup = cleanup;
};

// Initialize profiler for TUI (enabled via PROFILE=1 env var)
profiler.init('tui', './profile-tui.json');

render(
  <ErrorBoundary>
    <App options={options} />
  </ErrorBoundary>
);
