#!/usr/bin/env bun
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { JSONLClient } from "./client.js";
import { FileCache } from "./file_cache.js";
import { Store } from "./store.js";
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
  type UserPromptData,
  type AgentQuestion,
  type QuestionType,
} from "./types.js";
import { UILogger } from "./logger.js";
import { computeInputLayout } from "./buffer.js";
import { useMouse } from "./useMouse.js";
import { useBracketedPaste } from "./hooks/useBracketedPaste.js";
import { QuestionPrompt } from "./components/QuestionPrompt.js";

const DEFAULT_MAX_INPUT_LINES = 6;
const STREAM_CURSOR_FRAMES = ["|", " "];
const STATUS_SPINNER_FRAMES = ["-", "\\", "|", "/"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = (() => {
  const override = process.env.TUI_PROJECT_ROOT;
  if (override) {
    return path.resolve(override);
  }
  if (path.basename(__dirname) === "dist") {
    return path.resolve(__dirname, "..", "..");
  }
  return path.resolve(__dirname, "..");
})();

interface AppOptions {
  configPath?: string;
  logDir?: string;
  uiLogPath: string;
  enableVoice: boolean;
  redactLogs: boolean;
  logTranscripts: boolean;
}

// Skills and hooks are read-only in the TUI.
// To create/edit skills, use the agent with Write/Edit to create SKILL.md files in config/skills/

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const handler = () => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };

    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);

  return size;
}

function App({ options }: { options: AppOptions }) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const store = useMemo(() => new Store(), []);
  const [snapshot, setSnapshot] = useState(store.getSnapshot());
  const [statusTick, setStatusTick] = useState(0);
  const clientRef = useRef<JSONLClient | null>(null);
  const loggerRef = useRef<UILogger | null>(null);
  const fileCacheRef = useRef<FileCache | null>(null);
  const maxScrollRef = useRef(0);
  const historyHeightRef = useRef(0);
  const width = Math.max(40, size.columns || 80);
  const height = Math.max(10, size.rows || 24);
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
  useEffect(() => {
    return store.subscribe(() => {
      setSnapshot(store.getSnapshot());
    });
  }, [store]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

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

    store.addMessage("system", "Indexing files for autocomplete...");
    fileCache
      .buildInitial()
      .then(() => {
        store.addMessage("system", "Autocomplete ready.");
      })
      .catch(() => {
        store.addMessage("system", "Autocomplete indexing failed.");
      });

    const python = process.env.TUI_PYTHON ?? "python3";
    const bridgePath = path.join(PROJECT_ROOT, "tui-ts", "bridge.py");
    const child = spawn(python, [bridgePath], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new JSONLClient(child);
    clientRef.current = client;

    child.stderr.on("data", (chunk) => {
      logger.warn("Bridge stderr", { chunk: chunk.toString("utf8").slice(0, 2000) });
    });

    client.on("event", (event: BridgeEvent) => {
      handleBridgeEvent(event);
    });

    client.on("exit", ({ code, signal }) => {
      logger.error("Bridge exited", { code, signal });
      store.setError("Bridge exited");
    });

    client.on("error", (payload) => {
      const message = typeof payload?.message === "string" ? payload.message : "Bridge error";
      store.setError(message);
    });

    client.send({
      type: "init",
      data: {
        config_path: options.configPath,
        log_dir: options.logDir,
        enable_voice: options.enableVoice,
        client_version: process.env.npm_package_version ?? "dev",
        log_transcripts: options.logTranscripts,
      },
    });

    return () => {
      client.send({ type: "shutdown" });
      client.close();
      child.kill();
      clearInterval(refreshInterval);
      logger.close();
    };
  }, [options, store]);

  useEffect(() => {
    store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
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
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
    },
    onPasteProgress: (bytes) => {
      store.setPasteProgress(bytes);
    },
    onPasteEnd: () => {
      store.clearPasteProgress();
    },
    enabled: !snapshot.helpVisible && snapshot.uiMode !== "question",
  });

  const handleBridgeEvent = (event: BridgeEvent) => {
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
      default:
        break;
    }
  };

  const handleReady = (data?: ReadyData) => {
    store.addMessage("system", "Bridge ready.");
    if (data?.session_key) {
      store.setSessionKey(data.session_key);
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
    store.setProgress(message);
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
      if (!messageExists(store.getSnapshot().history, data.request_id)) {
        store.addMessage("agent", finalText, undefined, data.request_id);
      }
      store.finalizeStreaming();
      store.clearProgress();
      store.setState("idle");
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
      store.setSkillsList(items, errors);
      store.setUIMode("skills");
      store.scrollToBottom();
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
      store.setHooksList(items, errors);
      store.setUIMode("hooks");
      store.scrollToBottom();
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
    if (kind === "config" || kind === "models" || kind === "status") {
      if (content) {
        store.addMessage("system", content);
      }
      return;
    }
    if (kind === "skills") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      handleSkillsPayload(payload, content);
      store.clearProgress();
      store.setState("idle");
      return;
    }
    if (kind === "hooks") {
      const payload = metadata.payload as Record<string, unknown> | undefined;
      handleHooksPayload(payload, content);
      store.clearProgress();
      store.setState("idle");
      return;
    }

    const requestId = data.request_id ?? undefined;
    const metaLines: string[] = [];
    if (data.duration_ms) {
      metaLines.push(`Duration: ${Math.round(data.duration_ms)}ms`);
    }
    if (data.tools_used && data.tools_used.length > 0) {
      metaLines.push(`Tools: ${data.tools_used.join(", ")}`);
    }
    if (error) {
      metaLines.push(`Error: ${error}`);
    }

    const meta = metaLines.length ? metaLines.join("\n") : undefined;

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

    if (content && requestId && messageExists(store.getSnapshot().history, requestId)) {
      store.updateMessageText(requestId, content, meta);
    } else if (content && (!requestId || !messageExists(store.getSnapshot().history, requestId))) {
      store.addMessage("agent", content, meta, requestId);
    }

    store.finalizeStreaming();
    store.clearProgress();
    store.setState("idle");
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
    if (!data?.question) return;

    // Infer question type from the data
    const inferQuestionType = (): QuestionType => {
      if (!data.options || data.options.length === 0) {
        return "free_text";
      }
      if (data.multi_select) {
        return "multi_select";
      }
      // Check if it's a yes/no question
      const labels = data.options.map((opt) =>
        (typeof opt === "string" ? opt : opt.label).toLowerCase()
      );
      if (
        labels.length === 2 &&
        labels.every((l) => ["yes", "no", "y", "n"].includes(l))
      ) {
        return "yes_no";
      }
      return "multiple_choice";
    };

    const question: AgentQuestion = {
      requestId: data.request_id,
      type: inferQuestionType(),
      question: data.question,
      context: data.context,
      options: data.options?.map((opt, i) => ({
        id: String(i),
        label: typeof opt === "string" ? opt : opt.label,
        description: typeof opt === "object" ? opt.description : undefined,
      })),
    };

    store.setActiveQuestion(question);
  };

  const handleError = (data?: ErrorData) => {
    if (!data?.message) {
      return;
    }
    const detailText =
      data.detail === undefined
        ? ""
        : typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail, null, 2);
    const detail = detailText ? `\n${detailText}` : "";
    store.addMessage("system", `${data.message}${detail}`);
    store.setError(data.message);
    if (data.fatal) {
      setTimeout(() => {
        exit();
      }, 50);
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
    client.send({ type, data });
  };

  const handleQuit = () => {
    sendCommand("shutdown");
    exit();
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
    if (key.ctrl && input === "c") {
      handleQuit();
      return;
    }

    if (snapshot.helpVisible) {
      if (key.escape || key.return || key.f1 || (key.ctrl && input === "k")) {
        store.setHelpVisible(false);
      }
      return;
    }

    if (key.f1 || (key.ctrl && input === "k")) {
      store.toggleHelp();
      return;
    }

    // Skills/hooks list modes - escape to return to chat
    if (snapshot.uiMode === "skills" || snapshot.uiMode === "hooks") {
      if (key.escape) {
        store.setUIMode("chat");
        return;
      }
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
          if (questionType === "multiple_choice" || questionType === "yes_no") {
            store.toggleQuestionSelection();
          }
          const answer = store.getQuestionAnswer();
          const requestId = snapshot.activeQuestion.requestId;
          sendCommand("user_prompt_response", {
            request_id: requestId,
            answer,
          });
          store.clearQuestion();
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
          const answer = store.getQuestionAnswer();
          const requestId = snapshot.activeQuestion.requestId;
          sendCommand("user_prompt_response", {
            request_id: requestId,
            answer,
          });
          store.clearQuestion();
          return;
        }

        // Shift+Enter adds newline for free_text
        if (key.return && key.shift && questionType === "free_text") {
          store.appendQuestionInput("\n");
          return;
        }

        // Regular text input
        if (input && !key.ctrl && !key.meta) {
          const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
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
      return;
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
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (snapshot.autocomplete.active) {
      if (key.return && !key.shift) {
        store.acceptAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (key.tab) {
        store.acceptAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
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
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.return) {
      const text = snapshot.inputText;
      if (!text.trim()) {
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
      store.addMessage("user", text);
      store.clearInput();
      store.incrementRequestCount();
      store.clearProgress();
      store.setState("sending");
      loggerRef.current?.transcript("user", text);

      sendCommand("send_text", {
        text,
        client_request_id: requestId,
      });
      return;
    }

    if (key.tab) {
      if (snapshot.autocomplete.active) {
        store.acceptAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      }
      return;
    }

    if (key.delete) {
      store.deleteForward();
      refreshAutocomplete();
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.leftArrow) {
      store.moveCursor(-1);
      refreshAutocomplete();
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.rightArrow) {
      store.moveCursor(1);
      refreshAutocomplete();
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.upArrow) {
      store.moveCursorUp(width - 2, prompt);
      refreshAutocomplete();
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      return;
    }

    if (key.downArrow) {
      store.moveCursorDown(width - 2, prompt);
      refreshAutocomplete();
      store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
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

    if (key.home) {
      store.scrollToTop(maxScrollRef.current);
      return;
    }

    if (key.end) {
      store.scrollToBottom();
      return;
    }

    if (key.ctrl) {
      if (input === "a") {
        store.moveCursorTo(0);
        refreshAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (input === "e") {
        store.moveCursorTo(snapshot.inputText.length);
        refreshAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
      if (input === "u") {
        store.clearInput();
        return;
      }
      if (input === "w") {
        store.deleteWordBack();
        refreshAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
        return;
      }
    }

    // Only insert printable characters (filter out control chars that weren't handled above)
    if (input && !key.ctrl && !key.meta) {
      // Filter out control characters (ASCII 0-31 and 127)
      // Also filter out mouse escape sequence fragments like "[<0;29;36M" or "[<64;10;5m"
      const printable = input
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/\[?<\d+;\d+;\d+[Mm]/g, "");
      if (printable) {
        store.insertInput(printable);
        refreshAutocomplete();
        store.ensureInputCursorVisible(width - 2, prompt, DEFAULT_MAX_INPUT_LINES);
      }
    }
  });

  const handleSlashCommand = (command: string, arg?: string) => {
    switch (command) {
      case "/help":
        store.setHelpVisible(true);
        return;
      case "/config":
        sendCommand("get_config");
        return;
      case "/models":
        sendCommand("get_models");
        return;
      case "/status":
        sendCommand("get_status");
        return;
      case "/skills":
        handleSkillsCommand(arg);
        return;
      case "/hooks":
        handleHooksCommand(arg);
        return;
      case "/compact": {
        const enabled = store.toggleCompact();
        store.addMessage("system", `Compact mode ${enabled ? "enabled" : "disabled"}.`);
        return;
      }
      case "/voice": {
        const enabled = !snapshot.voiceMode;
        if (enabled && !snapshot.capabilities.voiceAvailable) {
          store.addMessage("system", "Voice mode not available.");
          return;
        }
        store.setVoiceMode(enabled);
        store.addMessage(
          "system",
          enabled
            ? "Voice mode enabled. Hold SPACE to record, press SPACE or Esc to stop."
            : "Voice mode disabled.",
        );
        return;
      }
      case "/top":
        store.scrollToTop(maxScrollRef.current);
        return;
      case "/bottom":
        store.scrollToBottom();
        return;
      case "/clear":
        store.clearHistory();
        return;
      case "/quit":
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

  const statusLine = snapshot.progressMessage || snapshot.statusMessage;
  const statusSpinner = isBusy
    ? STATUS_SPINNER_FRAMES[statusTick % STATUS_SPINNER_FRAMES.length]
    : "";
  const statusText = statusSpinner ? `${statusSpinner} ${statusLine}` : statusLine;
  const scrollInfo = snapshot.scrollOffset > 0
    ? `Scroll: ${snapshot.scrollOffset} lines up`
    : "At bottom";
  const newMessageInfo = snapshot.newMessages ? "New messages" : "";

  const headerLines = [
    `Voice Agent - Ink TUI${snapshot.compact ? " [compact]" : ""}`,
    `Session: ${snapshot.sessionKey ?? "-"} | State: ${snapshot.state} | Voice: ${snapshot.voiceMode ? "on" : "off"} | Mode: ${snapshot.uiMode}`,
    `Status: ${statusText}`,
    `${scrollInfo}${newMessageInfo ? " | " + newMessageInfo : ""}`,
    "-".repeat(width),
  ];

  const inputLayout = computeInputLayout(snapshot.inputText.split(""), snapshot.cursor, width - 2, prompt);
  const inputVisibleLines = Math.min(DEFAULT_MAX_INPUT_LINES, inputLayout.lines.length);
  const inputBoxHeight = inputVisibleLines + 2;
  const autocompleteHeight = snapshot.autocomplete.active
    ? snapshot.autocomplete.suggestions.length + 1
    : 0;
  const historyHeight = Math.max(
    3,
    height - headerLines.length - inputBoxHeight - autocompleteHeight,
  );

  historyHeightRef.current = historyHeight;

  const buildListLines = (
    title: string,
    items: Record<string, unknown>[],
    errors: string[],
    isSkills: boolean = false,
  ): { text: string; role?: Role }[] => {
    const lines: { text: string; role?: Role }[] = [];
    lines.push({ text: `${title} (${items.length}) - Read Only`, role: "system" });
    if (items.length === 0) {
      lines.push({ text: "No items found.", role: "system" });
    } else {
      for (const item of items) {
        const enabled = item.enabled === true ? "enabled" : "disabled";
        const name = typeof item.name === "string" ? item.name : "";
        const id = typeof item.id === "string" ? item.id : "";
        lines.push({ text: `- ${id} [${enabled}] ${name}`, role: "system" });
      }
    }
    if (errors.length > 0) {
      lines.push({ text: "", role: "system" });
      lines.push({ text: "Errors:", role: "system" });
      for (const err of errors) {
        lines.push({ text: `- ${err}`, role: "system" });
      }
    }
    lines.push({ text: "", role: "system" });
    lines.push({ text: "-".repeat(40), role: "system" });
    const itemType = isSkills ? "skills" : "hooks";
    lines.push({ text: `To create/edit ${itemType}, ask the agent to write ${itemType.toUpperCase().slice(0, -1)}.md files.`, role: "system" });
    lines.push({ text: "Press Esc to return to chat.", role: "system" });
    return lines;
  };

  const streamCursor = snapshot.state === "streaming"
    ? STREAM_CURSOR_FRAMES[statusTick % STREAM_CURSOR_FRAMES.length]
    : "";
  let historyLines = store.getHistoryLines(width, snapshot.compact, streamCursor);
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
      return `${prefix}${line}`.padEnd(width - 2, " ").slice(0, width - 2);
    });
  };

  const inputLines = renderInputLines();
  const borderTop = `+${"-".repeat(width - 2)}+`;
  const borderBottom = borderTop;

  if (snapshot.helpVisible) {
    return (
      <Box flexDirection="column" paddingLeft={2} paddingTop={1} width={width}>
        {HELP_LINES.map((line, index) => (
          <Text key={`help-${index}`}>{line}</Text>
        ))}
        <Text>Press Esc, Enter, or Ctrl+K to close.</Text>
      </Box>
    );
  }

  // Question mode: show QuestionPrompt instead of input box
  const isQuestionMode = snapshot.uiMode === "question" && snapshot.activeQuestion;

  return (
    <Box flexDirection="column" width={width}>
      {headerLines.map((line, index) => (
        <Text key={`header-${index}`}>{line.slice(0, width)}</Text>
      ))}
      <Box flexDirection="column" height={historyHeight}>
        {visibleHistoryLines.map((line, index) => (
          <Text key={`hist-${index}`} color={roleColor(line.role)}>
            {line.text}
          </Text>
        ))}
      </Box>
      {isQuestionMode ? (
        <QuestionPrompt
          question={snapshot.activeQuestion!}
          cursor={snapshot.questionCursor}
          selection={snapshot.questionSelection}
          inputText={snapshot.questionInput}
          width={width}
        />
      ) : (
        <>
          <Text>{borderTop}</Text>
          {inputLines.map((line, index) => (
            <Text key={`input-${index}`}>{`|${line}|`}</Text>
          ))}
          <Text>{borderBottom}</Text>
          {snapshot.autocomplete.active ? (
            <Box flexDirection="column" width={width}>
              <Text>{"-".repeat(width)}</Text>
              {snapshot.autocomplete.suggestions.map((suggestion, index) => (
                <Text key={`ac-${index}`}>
                  {index === snapshot.autocomplete.selected ? "> " : "  "}
                  {suggestion}
                </Text>
              ))}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

function roleColor(role?: Role): string | undefined {
  switch (role) {
    case "user":
      return "green";
    case "agent":
      return "cyan";
    case "system":
      return "yellow";
    case "status":
      return "magenta";
    default:
      return undefined;
  }
}

function messageExists(history: MessageEntry[], requestId: string): boolean {
  return history.some((entry) => entry.requestId === requestId);
}

function parseArgs(argv: string[]): AppOptions {
  let configPath: string | undefined;
  let logDir: string | undefined;
  let uiLogPath = path.join(PROJECT_ROOT, "tui", "logs", "ink-ui.log");
  let enableVoice = true;
  let redactLogs = false;
  let logTranscripts = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--log-dir" && argv[i + 1]) {
      logDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--ui-log" && argv[i + 1]) {
      uiLogPath = argv[i + 1];
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

  return { configPath, logDir, uiLogPath, enableVoice, redactLogs, logTranscripts };
}

const options = parseArgs(process.argv.slice(2));
render(<App options={options} />);
