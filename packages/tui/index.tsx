#!/usr/bin/env bun
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import path from "path";
import { fileURLToPath } from "url";
import { BridgeClient, type ConnectionState } from "./bridge_client.js";
import { FileCache } from "./file_cache.js";
import { Store, type HistoryLine } from "./store.js";
import { HELP_LINES, parseSlashCommand } from "./commands.js";
import {
  type ErrorData,
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
  type QuestionType,
  type UsageSessionSummary,
  type UsageDayStats,
  type UsageProviderStats,
} from "./types.js";
import { UILogger } from "./logger.js";
import { computeInputLayout } from "./buffer.js";
import { useMouse } from "./useMouse.js";
import { useBracketedPaste } from "./hooks/useBracketedPaste.js";
import { QuestionPrompt } from "./components/QuestionPrompt.js";
import { ProvidersView } from "./components/ProvidersView.js";
import { ResponsePane, parseDiffToResponseContent } from "./components/ResponsePane.js";
import { SessionsView } from "./components/SessionsView.js";
import { UsageView } from "./components/UsageView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { getColors, setTheme, getThemeNames, getCurrentThemeName, themes } from "./theme.js";
import { spawnForkedSession } from "./utils/fork-spawn.js";
import { formatDiffAsText } from "./diff.js";

const DEFAULT_MAX_INPUT_LINES = 6;
const STREAM_CURSOR_FRAMES = ["|", " "];
const STATUS_SPINNER_FRAMES = ["-", "\\", "|", "/"];

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
  const host = process.env.GRAPHD_HOST ?? "127.0.0.1";
  const port = process.env.GRAPHD_PORT ?? "9444";
  return `http://${host}:${port}`;
}

function resolveBusConfig(): { host: string; port: number } {
  const host = process.env.EVENT_BUS_HOST ?? "127.0.0.1";
  const portValue = Number(process.env.EVENT_BUS_PORT ?? "9555");
  return {
    host,
    port: Number.isFinite(portValue) ? portValue : 9555,
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
  const staleThreshold = 5 * 60; // 5 minutes

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

    // Determine status
    let status: "active" | "idle" | "ended" = "idle";
    if (raw.status === "closed" || raw.status === "expired") {
      status = "ended";
    } else if (now - raw.last_accessed_at <= staleThreshold) {
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
    const date = new Date(session.lastAccessedAt * 1000).toISOString().slice(0, 10);
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
  const todayDate = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const providerStatsMap = new Map<string, { today: number; week: number; month: number }>();

  for (const session of sessions) {
    const sessionDate = new Date(session.lastAccessedAt * 1000).toISOString().slice(0, 10);

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
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

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
  const width = Math.max(40, size.columns || 80);
  const height = Math.max(10, size.rows || 24);
  const HORIZONTAL_PADDING = 2;
  const TOP_PADDING = 1;
  const BOTTOM_PADDING = 3;
  const contentWidth = width - HORIZONTAL_PADDING * 2;
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
    }, 150);
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
    }, 5000);

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
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setError(message);
      });

    // Cleanup function for both useEffect and signal handlers
    // Gracefully closes session before disconnecting
    const cleanup = () => {
      const snapshot = store.getSnapshot();
      const currentEntry = store.getCurrentModelEntry();
      const selectedModel = snapshot.selectedModel;
      const selectedProvider = snapshot.selectedProvider ?? currentEntry?.provider ?? null;
      if (selectedModel && selectedProvider) {
        client.send({
          type: "set_model",
          data: {
            provider: selectedProvider,
            model: selectedModel,
            ...(snapshot.selectedReasoningLevel ? { reasoning: snapshot.selectedReasoningLevel } : {}),
          },
        });
      }
      // Signal session close to harness (don't await - best effort)
      // This marks the session as inactive so it shows correctly in /sessions
      client.sessionClose().catch(() => {
        // Ignore errors during cleanup - connection may already be closed
      });
      // Small delay to allow the close message to be sent
      setTimeout(() => {
        client.close();
      }, 50);
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
  const scrollAmount = 3; // lines to scroll per wheel tick
  useMouse({
    onScrollUp: () => {
      store.scrollBy(scrollAmount, maxScrollRef.current);
    },
    onScrollDown: () => {
      store.scrollBy(-scrollAmount, maxScrollRef.current);
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
  };

  const handleReady = async (data?: ReadyData) => {
    if (data?.session_key) {
      store.setSessionKey(data.session_key);
    }
    store.batch(() => {
      store.setSelectedModel(null);
      store.setSelectedProvider(null);
      store.setReasoningLevel(null);
    });
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
    const currentSnapshot = store.getSnapshot();
    if (currentSnapshot.streamingRequestId !== data.request_id) {
      store.setStreaming(data.request_id, data.chunk);
    } else {
      store.appendStreaming(data.chunk);
    }

    store.setState("streaming");

    if (data.is_final) {
      const finalText = store.getSnapshot().streamingText;
      store.batch(() => {
        if (!messageExists(store.getSnapshot().history, data.request_id)) {
          store.addMessage("agent", finalText, undefined, data.request_id);
        }
        store.finalizeStreaming();
        store.clearProgress();
        store.setState("idle");
      });
    }
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
      if (payload && Array.isArray(payload)) {
        if (pendingModelsModeRef.current) {
          pendingModelsModeRef.current = false;
          store.setModelsList(payload);
        } else {
          store.updateModelsList(payload);
        }
      } else if (content) {
        store.addMessage("system", content);
      }
      return;
    }
    if (kind === "get_model") {
      const payload = metadata.payload as {
        selectedModel?: string | null;
        selectedProvider?: string | null;
        provider?: string | null;
        model?: string | null;
        reasoning?: string | null;
      } | undefined;
      const selectedModel = payload?.selectedModel ?? payload?.model ?? null;
      const selectedProvider = payload?.selectedProvider ?? payload?.provider ?? null;
      const reasoning = typeof payload?.reasoning === "string" ? payload.reasoning : null;
      store.batch(() => {
        store.setSelectedProvider(selectedProvider);
        store.setSelectedModel(selectedModel);
        store.setReasoningLevel(reasoning);
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

  const handleUserPrompt = (data?: UserPromptData) => {
    if (!data) return;

    // Helper to infer question type from options and flags
    const inferQuestionType = (
      opts?: Array<string | { label: string; description?: string }>,
      multiSelect?: boolean,
      questionType?: string
    ): QuestionType => {
      if (questionType === "plan_mode_exit") return "plan_mode_exit";
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

    // Helper to convert raw question data to AgentQuestion
    const toAgentQuestion = (
      q: UserPromptQuestion,
      requestId: string,
      index: number
    ): AgentQuestion => ({
      requestId: `${requestId}_q${index}`,
      type: inferQuestionType(q.options, q.multi_select, q.question_type),
      question: q.question,
      context: q.context,
      options: q.options?.map((opt) => {
        const label = typeof opt === "string" ? opt : opt.label;
        return {
          id: label, // Use label as ID so agent sees meaningful answer text
          label,
          description: typeof opt === "object" ? opt.description : undefined,
        };
      }),
    });

    // Handle multiple questions
    if (data.questions && data.questions.length > 0) {
      const questions = data.questions.map((q, i) => toAgentQuestion(q, data.request_id, i));
      store.setQuestionQueue(questions, data.request_id);
      return;
    }

    // Handle single question (backwards compatible)
    if (!data.question) return;

    const question: AgentQuestion = {
      requestId: data.request_id,
      type: inferQuestionType(data.options, data.multi_select, data.question_type),
      question: data.question,
      context: data.context,
      options: data.options?.map((opt) => {
        const label = typeof opt === "string" ? opt : opt.label;
        return {
          id: label, // Use label as ID so agent sees meaningful answer text
          label,
          description: typeof opt === "object" ? opt.description : undefined,
        };
      }),
    };

    store.setActiveQuestion(question, data.request_id);
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
    store.batch(() => {
      store.setSelectedProvider(selectedProvider);
      store.setSelectedModel(selectedModel);
      store.setReasoningLevel(reasoning);
    });
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
    const needsWorkingDir = type === "send_text" || type === "user_prompt_response";
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

      if (key.upArrow) {
        store.moveModelsCursor(-1);
        return;
      }

      if (key.downArrow) {
        store.moveModelsCursor(1);
        return;
      }

      if (key.return) {
        const selectedModel = snapshot.modelsList[snapshot.modelsCursor];
        if (selectedModel) {
          sendCommand("set_model", {
            provider: selectedModel.provider,
            model: selectedModel.id,
            ...(selectedModel.reasoning?.[0] ? { reasoning: selectedModel.reasoning[0] } : {}),
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
          if (questionType === "multiple_choice" || questionType === "yes_no" || questionType === "plan_mode_exit") {
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
          // Check if there are more questions in the queue
          const hasMoreQuestions = store.saveAnswerAndAdvance();
          if (!hasMoreQuestions) {
            // All questions answered - send response
            const requestId = store.getQuestionRequestId();
            const allAnswers = store.getAllAnswers();
            const answer = allAnswers.size === 1
              ? allAnswers.values().next().value
              : Object.fromEntries(allAnswers);
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
          const printable = input
            .replace(/[\x00-\x1f\x7f]/g, "")  // Control characters
            .replace(/\[200~/g, "")            // Bracketed paste start
            .replace(/\[201~/g, "")            // Bracketed paste end
            .replace(/\[[ABCD]/g, "")          // Arrow key fragments [A, [B, [C, [D
            .replace(/O[ABCD]/g, "")           // Alt arrow key fragments OA, OB, OC, OD
            .replace(/\[\d+~/g, "")            // Function/special keys [5~, [6~, etc.
            .replace(/\[\d+;\d+[~ABCDHF]/g, "")// Modified keys with parameters
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
      const models = snapshot.modelsList;
      if (models.length === 0) {
        store.addMessage("system", "No models available. Run /models to fetch model list.");
        return;
      }
      const currentId = snapshot.selectedModel;
      const currentProvider = snapshot.selectedProvider;
      let currentIdx = currentId
        ? models.findIndex((m) => m.id === currentId && (!currentProvider || m.provider === currentProvider))
        : -1;
      if (currentIdx < 0) currentIdx = Math.max(0, snapshot.modelsCursor);
      const nextIdx = (currentIdx + 1) % models.length;
      const nextModel = models[nextIdx];
      if (!nextModel) return;
      sendCommand("set_model", {
        provider: nextModel.provider,
        model: nextModel.id,
        ...(nextModel.reasoning?.[0] ? { reasoning: nextModel.reasoning[0] } : {}),
      });
    };

    const cycleReasoning = () => {
      const currentModel = snapshot.modelsList.find((m) => m.id === snapshot.selectedModel && (!snapshot.selectedProvider || m.provider === snapshot.selectedProvider));
      const levels = currentModel?.reasoning ?? [];
      if (!currentModel || levels.length === 0) {
        store.addMessage("system", "Current model does not support reasoning levels.");
        return;
      }
      const currentLevel = snapshot.selectedReasoningLevel;
      let currentIdx = currentLevel ? levels.indexOf(currentLevel) : -1;
      if (currentIdx < 0) currentIdx = 0;
      const nextIdx = (currentIdx + 1) % levels.length;
      const nextLevel = levels[nextIdx];
      if (!currentModel.provider) {
        store.addMessage("system", "Current model is missing a provider.");
        return;
      }
      sendCommand("set_model", {
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
      const printable = input
        .replace(/[\x00-\x1f\x7f]/g, "")       // Control characters
        .replace(/\[200~/g, "")                 // Bracketed paste start
        .replace(/\[201~/g, "")                 // Bracketed paste end
        .replace(/\[[ABCD]/g, "")               // Arrow key fragments [A, [B, [C, [D
        .replace(/O[ABCD]/g, "")                // Alt arrow key fragments OA, OB, OC, OD
        .replace(/\[\d+~/g, "")                 // Function/special keys [5~, [6~, etc.
        .replace(/\[\d+;\d+[~ABCDHF]/g, "")     // Modified keys with parameters
        .replace(/\[<\d+;\d+;\d+[Mm]/g, "")     // Mouse sequences
        .replace(/\[?\[/g, "");                 // Leftover brackets from sequences
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
  const statusLine = snapshot.progressMessage || snapshot.statusMessage;
  const statusSpinner = isBusy
    ? STATUS_SPINNER_FRAMES[statusTick % STATUS_SPINNER_FRAMES.length]
    : "";
  const statusText = statusSpinner ? `${statusSpinner} ${statusLine}` : statusLine;
  // Use progress level for coloring when available
  const statusColor = snapshot.progressMessage
    ? levelColor(snapshot.progressLevel)
    : colors.muted;
  const scrollInfo = snapshot.scrollOffset > 0
    ? `Scroll: ${snapshot.scrollOffset} lines up`
    : "At bottom";
  const newMessageInfo = snapshot.newMessages ? "New messages" : "";

  // Header lines with theme colors
  const headerConfig: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: `Bloom ${snapshot.compact ? " [compact]" : ""}`, color: colors.accent, bold: true },
    { text: `Session: ${snapshot.sessionKey ?? "-"} | State: ${snapshot.state} | Voice: ${snapshot.voiceMode ? "on" : "off"} | Mode: ${snapshot.uiMode}${snapshot.planMode ? " | [PLAN]" : ""}`, color: colors.muted },
    { text: `Status: ${statusText}`, color: statusColor },
    { text: `${scrollInfo}${newMessageInfo ? " | " + newMessageInfo : ""}`, color: colors.muted },
    { text: "─".repeat(contentWidth), color: colors.border },
  ];
  const headerLines = headerConfig.map((h) => h.text);

  const inputLayout = computeInputLayout(snapshot.inputText.split(""), snapshot.cursor, contentWidth, prompt);
  const inputVisibleLines = Math.min(DEFAULT_MAX_INPUT_LINES, inputLayout.lines.length);
  // inputBoxHeight = top line (1) + input lines + bottom line (1) + model indicator row (1)
  const inputBoxHeight = 1 + inputVisibleLines + 1 + 1;
  const autocompleteHeight = snapshot.autocomplete.active
    ? snapshot.autocomplete.suggestions.length + 1
    : 0;
  const historyHeight = Math.max(
    3,
    height - headerLines.length - inputBoxHeight - autocompleteHeight - TOP_PADDING - BOTTOM_PADDING,
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
  let historyLines = store.getHistoryLines(contentWidth, snapshot.compact, streamCursor);
  if (snapshot.uiMode === "skills") {
    historyLines = buildListLines("Skills", snapshot.skillsList, snapshot.skillsErrors, true);
  } else if (snapshot.uiMode === "hooks") {
    historyLines = buildListLines("Hooks", snapshot.hooksList, snapshot.hooksErrors, false);
  }
  const totalHistoryLines = historyLines.length;
  const maxScroll = Math.max(0, totalHistoryLines - historyHeight);
  maxScrollRef.current = maxScroll;

  useEffect(() => {
    if (snapshot.scrollOffset > maxScroll) {
      store.setScrollOffset(maxScroll);
    }
  }, [snapshot.scrollOffset, maxScroll, store]);

  const scrollOffset = Math.min(snapshot.scrollOffset, maxScroll);

  const endIndex = Math.max(0, totalHistoryLines - scrollOffset);
  const startIndex = Math.max(0, endIndex - historyHeight);
  const visibleHistoryLines = historyLines.slice(startIndex, endIndex);

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

  // Get current model/reasoning for footer display
  const currentModelEntry = store.getCurrentModelEntry();
  const reasoningOptions = store.getCurrentModelReasoningOptions() ?? [];
  const hasReasoning = reasoningOptions.length > 0;

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

  // Question mode: show QuestionPrompt instead of input box
  const isQuestionMode = snapshot.uiMode === "question" && snapshot.activeQuestion;
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

  // Models selector rendering
  const renderModelsSelector = () => {
    const colors = getColors();
    const currentModel = store.getSelectedModel();
    const currentProvider = store.getSelectedProvider();
    const currentReasoning = store.getSelectedReasoningLevel();
    const reasoningOptions = store.getCurrentModelReasoningOptions();
    const reasoningInfo = reasoningOptions && reasoningOptions.length > 0
      ? ` | Reasoning: ${currentReasoning ?? 'off'}`
      : '';
    const deletePending = snapshot.modelDeletePending;
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text bold color={colors.accent}>Select Model</Text>
          {deletePending ? (
            <Text color={colors.error}>  d to confirm delete</Text>
          ) : (
            <Text color={colors.muted}>  d to delete</Text>
          )}
        </Box>
        <Text> </Text>
        {snapshot.modelsList.map((model, index) => {
          const isSelected = index === snapshot.modelsCursor;
          const isCurrent = currentProvider
            ? model.id === currentModel && model.provider === currentProvider
            : model.id === currentModel;
          const isPendingDelete = isSelected && deletePending;
          const pointer = isSelected ? "▸ " : "  ";
          const marker = isCurrent ? ` (current${reasoningInfo})` : "";
          const provider = model.provider;
          const hasReasoning = model.reasoning && model.reasoning.length > 0;
          return (
            <Text key={`${provider ?? 'unknown'}:${model.id}`}>
              <Text color={isPendingDelete ? colors.error : (isSelected ? colors.accent : colors.muted)}>{pointer}</Text>
              <Text
                color={isPendingDelete ? colors.error : (isSelected ? colors.text : colors.muted)}
                bold={isSelected}
                strikethrough={isPendingDelete}
              >
                {model.name}
              </Text>
              {provider && <Text color={isPendingDelete ? colors.error : colors.muted} strikethrough={isPendingDelete}> [{provider}]</Text>}
              {hasReasoning && <Text color={isPendingDelete ? colors.error : colors.func} strikethrough={isPendingDelete}> [R]</Text>}
              <Text color={isPendingDelete ? colors.error : colors.muted} strikethrough={isPendingDelete}>{marker}</Text>
            </Text>
          );
        })}
      </Box>
    );
  };

  // Sessions selector uses the SessionsView component
  const sessionsHeight = historyHeight + inputBoxHeight;

  // Full-screen modes that replace both history and input
  const isFullScreenMode = isResponseMode || isProvidersMode || isThemeMode || isModelsMode || isSessionsMode || isUsageMode;

  return (
    <Box flexDirection="column" width={width} paddingX={HORIZONTAL_PADDING} paddingTop={TOP_PADDING} paddingBottom={BOTTOM_PADDING}>
      {headerConfig.map((item, index) => (
        <Text key={`header-${index}`} color={item.color} bold={item.bold}>{item.text.slice(0, contentWidth)}</Text>
      ))}
      {!isFullScreenMode && (
        <Box flexDirection="column" height={historyHeight}>
          {visibleHistoryLines.map((line, index) => {
            const isUserLine = line.role === "user";
            const bgColor = isUserLine ? colors.userBg : undefined;
            // Pad user lines to full width for consistent background
            const paddedText = isUserLine ? line.text.padEnd(contentWidth, " ") : line.text;
            return (
              <Text key={line.id ?? `hist-${index}`} backgroundColor={bgColor}>
                <StyledLine text={paddedText} baseColor={roleColor(line.role)} />
              </Text>
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
      ) : isQuestionMode ? (
        <QuestionPrompt
          question={snapshot.activeQuestion!}
          cursor={snapshot.questionCursor}
          selection={snapshot.questionSelection}
          inputText={snapshot.questionInput}
          width={contentWidth}
          queueInfo={store.getQuestionQueueInfo()}
        />
      ) : (
        <>
          {/* Top separator line - runs edge to edge */}
          <Text color={colors.border}>{horizontalLine}</Text>

          {/* Input lines - no side borders */}
          {inputLines.map((line, index) => (
            <Text key={`input-${index}`} color={colors.text}>{line}</Text>
          ))}

          {/* Bottom separator line - runs edge to edge */}
          <Text color={colors.border}>{horizontalLine}</Text>

          {/* Model indicator row: model (Esc+M) | reasoning (Esc+T) */}
          <Text>
            {(() => {
              const modelName = snapshot.selectedModel
                ? (currentModelEntry?.name ?? snapshot.selectedModel)
                : "no model selected";
              const reasoningLevel = hasReasoning ? (snapshot.selectedReasoningLevel ?? "off") : "n/a";
              // Layout: modelName (Esc+M) | reasoning (Esc+T) or n/a
              const rightContent = hasReasoning
                ? `${modelName} (Esc+M) | ${reasoningLevel} (Esc+T)`
                : `${modelName} (Esc+M) | n/a`;
              const padding = 2;
              const gap = contentWidth - rightContent.length - (padding * 2);
              return (
                <>
                  <Text>{" ".repeat(padding)}</Text>
                  <Text>{" ".repeat(Math.max(0, gap))}</Text>
                  <Text color={colors.muted}>{modelName}</Text>
                  <Text color={colors.muted} dimColor> (Esc+M)</Text>
                  <Text color={colors.border}> | </Text>
                  <Text color={hasReasoning ? colors.func : colors.muted} dimColor={!hasReasoning}>{reasoningLevel}</Text>
                  {hasReasoning && <Text color={colors.muted} dimColor> (Esc+T)</Text>}
                  <Text>{" ".repeat(padding)}</Text>
                </>
              );
            })()}
          </Text>

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

function roleColor(role?: Role): string | undefined {
  const colors = getColors();
  // All message roles use neutral text color - theme colors reserved for syntax
  switch (role) {
    case "user":
    case "agent":
    case "system":
    case "status":
      return colors.text;
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

/** Syntax highlight patterns - use color keys, resolved at runtime */
type ColorKey = "code" | "url" | "path" | "number" | "func" | "header" | "bold" | "italic" | "strikethrough" | "blockquote" | "listBullet" | "link" | "linkText" | "hr" | "border" | "text" | "diffAdd" | "diffRemove" | "diffHeader" | "diffHeaderBg";

// Hardcoded diff colors - bright and consistent regardless of theme
const DIFF_ADD_FG = "#ffffff";    // White text for visibility
const DIFF_ADD_BG = "#166534";    // Solid green background
const DIFF_REMOVE_FG = "#ffffff"; // White text for visibility
const DIFF_REMOVE_BG = "#991b1b"; // Solid red background
const DIFF_CONTEXT_FG = "#d4d4d8"; // Light grey text for context lines
const DIFF_CONTEXT_BG = "#27272a"; // Darker grey background for context

const syntaxPatterns: Array<{ pattern: RegExp; colorKey?: ColorKey; bgKey?: ColorKey; hardcodedColor?: string; hardcodedBg?: string; bold?: boolean; italic?: boolean; transform?: (s: string) => string }> = [
  // Diff/Edit tool header - format: "✓ Edit /path/to/file.ts  +3 / -2 (123ms)"
  { pattern: /^[✓✗] Edit .+$/gm, colorKey: "diffHeader", bgKey: "diffHeaderBg", bold: true },
  // Diff lines with line numbers - format: "  42 + content" or "  42 - content" or "  42   content"
  { pattern: /^\s*\d+\s+\+ .*$/gm, hardcodedColor: DIFF_ADD_FG, hardcodedBg: DIFF_ADD_BG },
  { pattern: /^\s*\d+\s+- .*$/gm, hardcodedColor: DIFF_REMOVE_FG, hardcodedBg: DIFF_REMOVE_BG },
  { pattern: /^\s*\d+\s{3}.*$/gm, hardcodedColor: DIFF_CONTEXT_FG, hardcodedBg: DIFF_CONTEXT_BG },

  // Horizontal rules (---, ***, ___)
  { pattern: /^[-*_]{3,}\s*$/gm, colorKey: "hr", transform: (s) => "─".repeat(Math.max(3, s.trim().length)) },

  // Markdown table separator row (|---|---|) - convert to box drawing
  { pattern: /^\|?[\s:]*-{3,}[\s:]*\|[\s|:\-]+\|?\s*$/gm, colorKey: "border", transform: (s) => {
    return s.replace(/\|/g, "┼").replace(/-+/g, (m) => "─".repeat(m.length)).replace(/^┼/, "├").replace(/┼$/, "┤").replace(/┼\s*$/, "┤");
  }},

  // Markdown table rows (| cell | cell |) - style the pipes
  { pattern: /^\|.+\|\s*$/gm, colorKey: "text", transform: (s) => s.replace(/\|/g, "│") },

  // Markdown headers (### Header text) - strip the hashes and bold
  { pattern: /^#{1,6}\s+.+$/gm, colorKey: "header", bold: true, transform: (s) => s.replace(/^#{1,6}\s+/, "") },

  // Blockquotes (> text) - preserve the > marker styled
  { pattern: /^>\s+.+$/gm, colorKey: "blockquote", italic: true, transform: (s) => "│ " + s.slice(2) },

  // Unordered list items (- item, * item, + item)
  { pattern: /^[\s]*[-*+]\s+/gm, colorKey: "listBullet", transform: (s) => s.replace(/[-*+]/, "•") },

  // Numbered list items (1. item, 2. item)
  { pattern: /^[\s]*\d+\.\s+/gm, colorKey: "listBullet" },

  // Task list items (- [ ] or - [x])
  { pattern: /^[\s]*[-*+]\s+\[[ xX]\]\s+/gm, colorKey: "listBullet", transform: (s) => s.replace(/\[[ ]\]/, "☐").replace(/\[[xX]\]/, "☑").replace(/[-*+]/, "") },

  // Strikethrough (~~text~~)
  { pattern: /~~[^~]+~~/g, colorKey: "strikethrough", transform: (s) => s.slice(2, -2) },

  // Markdown links [text](url) - render as "text" with link color
  { pattern: /\[([^\]]+)\]\([^)]+\)/g, colorKey: "linkText", transform: (s) => {
    const match = s.match(/\[([^\]]+)\]/);
    return match ? match[1] : s;
  }},

  // Bold text (**text** or __text__)
  { pattern: /\*\*[^*]+\*\*/g, colorKey: "bold", bold: true, transform: (s) => s.slice(2, -2) },
  { pattern: /__[^_]+__/g, colorKey: "bold", bold: true, transform: (s) => s.slice(2, -2) },

  // Italic text (*text* or _text_) - single asterisk/underscore, not followed by another
  { pattern: /(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, colorKey: "italic", italic: true, transform: (s) => s.slice(1, -1) },
  { pattern: /(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, colorKey: "italic", italic: true, transform: (s) => s.slice(1, -1) },

  // Inline code
  { pattern: /`[^`]+`/g, colorKey: "code", bold: true, transform: (s) => s.slice(1, -1) },

  // Code block delimiters (``` or ```language on their own line)
  { pattern: /^```\w*\s*$/gm, colorKey: "border", transform: (s) => {
    const langMatch = s.match(/```(\w+)/);
    const lang = langMatch ? ` ${langMatch[1]} ` : "";
    return "─".repeat(3) + lang + "─".repeat(Math.max(0, 10 - lang.length));
  }},

  // Code blocks (multiline ```...```) - fallback, just color
  { pattern: /```[\s\S]*?```/g, colorKey: "code" },

  // URLs (standalone, not inside markdown links)
  { pattern: /(?<!\]\()https?:\/\/[^\s<>\[\]()]+/g, colorKey: "url" },

  // File paths
  { pattern: /(?<!\w)\/[\w.-]+(?:\/[\w.-]+)+/g, colorKey: "path" },

  // Durations
  { pattern: /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|min|m|h|hr)s?\b/gi, colorKey: "number" },

  // [tool_name] - but not markdown image/link syntax
  { pattern: /(?<!!)\[[a-z_][a-z0-9_]*\](?!\()/gi, colorKey: "func", bold: true },

  // ClassName.method()
  { pattern: /\b[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*\(\)/g, colorKey: "func" },

  // function_name()
  { pattern: /\b[a-z_][a-zA-Z0-9_]*\(\)/g, colorKey: "func" },
];

interface TextSegment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
}

const MAX_PARSE_TEXT_LENGTH = 20000;
const PARSE_CACHE_LIMIT = 200;
const parseCache = new Map<string, TextSegment[]>();

/** Parse text into styled segments for syntax highlighting */
function parseTextSegments(text: string, baseColor?: string): TextSegment[] {
  if (text.length > MAX_PARSE_TEXT_LENGTH) {
    return [{ text, color: baseColor }];
  }

  const cacheKey = `${baseColor ?? ""}::${text}`;
  const cached = parseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const colors = getColors();
  const segments: TextSegment[] = [];

  // Find all matches with positions
  const matches: Array<{ start: number; end: number; text: string; displayText: string; color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean }> = [];

  for (const { pattern, colorKey, bgKey, hardcodedColor, hardcodedBg, bold, italic, transform } of syntaxPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = regex.exec(text)) !== null) {
      const matchedText = m[0];
      const displayText = transform ? transform(matchedText) : matchedText;
      matches.push({
        start: m.index,
        end: m.index + matchedText.length,
        text: matchedText,
        displayText,
        color: hardcodedColor ?? (colorKey ? colors[colorKey] : undefined),
        backgroundColor: hardcodedBg ?? (bgKey ? colors[bgKey] : undefined),
        bold,
        italic,
      });
    }
  }

  // Sort by position and filter overlaps
  matches.sort((a, b) => a.start - b.start);
  const filtered: typeof matches = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  // Build segments
  let pos = 0;
  for (const m of filtered) {
    if (m.start > pos) {
      segments.push({ text: text.slice(pos, m.start), color: baseColor });
    }
    segments.push({ text: m.displayText, color: m.color, backgroundColor: m.backgroundColor, bold: m.bold, italic: m.italic });
    pos = m.end;
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), color: baseColor });
  }

  const result = segments.length > 0 ? segments : [{ text, color: baseColor }];
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey) {
      parseCache.delete(oldestKey);
    }
  }
  parseCache.set(cacheKey, result);
  return result;
}

/** Render text with syntax highlighting */
function StyledLine({ text, baseColor }: { text: string; baseColor?: string }): JSX.Element {
  const segments = parseTextSegments(text, baseColor);

  return (
    <>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color} backgroundColor={seg.backgroundColor} bold={seg.bold} italic={seg.italic}>
          {seg.text}
        </Text>
      ))}
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

  return { uiLogPath, enableVoice, redactLogs, logTranscripts, sessionKey };
}

const options = parseArgs(process.argv.slice(2));

// Global cleanup reference for signal handlers
let globalCleanup: (() => void) | null = null;

// Double-cleanup guard to prevent race condition on rapid signals
let cleanupCalled = false;

// Handle graceful shutdown on signals
const handleSignal = (signal: string) => {
  if (cleanupCalled) return;
  cleanupCalled = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  if (globalCleanup) {
    globalCleanup();
  }
  // Give cleanup time to complete before exit (session close + connection close)
  setTimeout(() => process.exit(0), 500);
};

// Process-level last resort handlers - catch anything that slips through
process.on('uncaughtException', (error: Error) => {
  console.error('\n[FATAL] Uncaught exception:', error.message);
  console.error(error.stack);

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
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('\n[ERROR] Unhandled promise rejection:', message);
  // Don't exit for unhandled rejections - log and continue
  // The specific operation failed but the app can continue
});

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGHUP', () => handleSignal('SIGHUP'));

// Export cleanup setter for App component
export const setGlobalCleanup = (cleanup: () => void) => {
  globalCleanup = cleanup;
};

render(
  <ErrorBoundary>
    <App options={options} />
  </ErrorBoundary>
);
