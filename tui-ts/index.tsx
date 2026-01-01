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
} from "./types.js";
import { UILogger } from "./logger.js";
import { computeInputLayout } from "./buffer.js";
import { useMouse } from "./useMouse.js";

const DEFAULT_MAX_INPUT_LINES = 6;
const STREAM_CURSOR = "|";

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

type WizardMode = "new" | "edit";

type WizardData = {
  mode: WizardMode;
  definition: Record<string, unknown>;
};

const SKILL_WIZARD_STEPS = [
  { title: "Basics", prompt: "Enter JSON with id, name, description, version." },
  { title: "Type", prompt: "Enter \"workflow\" or \"tool_chain\" (string or JSON)." },
  { title: "Triggers", prompt: "Enter JSON array of triggers." },
  { title: "Input Schema", prompt: "Enter JSON object for input_schema." },
  { title: "Steps", prompt: "Enter JSON array of steps/tool_chain." },
  { title: "Settings", prompt: "Enter JSON with allowed_tools, timeout_ms, enabled, tags." },
  { title: "Review", prompt: "Review the definition. Ctrl+S saves." },
];

const HOOK_WIZARD_STEPS = [
  { title: "Basics", prompt: "Enter JSON with id, name, description, priority, timeout_ms, fail_open." },
  { title: "Trigger", prompt: "Enter trigger string (e.g., \"invocation.before\")." },
  { title: "Filters", prompt: "Enter JSON object for filter." },
  { title: "Action", prompt: "Enter JSON with action type/message." },
  { title: "Mutation Ops", prompt: "Enter JSON array of ops (only for mutate)." },
  { title: "Review", prompt: "Review the definition. Ctrl+S saves." },
];

function createDefaultSkillDefinition(): Record<string, unknown> {
  return {
    id: "",
    name: "",
    description: "",
    version: "v1",
    type: "workflow",
    triggers: [],
    input_schema: { type: "object", properties: {}, required: [] },
    steps: [],
    tool_chain: [],
    allowed_tools: ["*"],
    timeout_ms: 30000,
    enabled: true,
    tags: [],
  };
}

function createDefaultHookDefinition(): Record<string, unknown> {
  return {
    id: "",
    name: "",
    description: "",
    enabled: true,
    trigger: "invocation.before",
    priority: 0,
    timeout_ms: 100,
    fail_open: true,
    filter: {},
    action: { type: "observe" },
  };
}

function parseJsonInput(input: string): { value?: unknown; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return { value: JSON.parse(trimmed) };
  } catch (err) {
    return { error: (err as Error).message || "Invalid JSON" };
  }
}

function parseFlexibleInput(input: string): { value?: unknown; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return { value: trimmed };
  }
}

function applySkillWizardStep(
  stepIndex: number,
  input: string,
  data: WizardData,
): { data: WizardData; errors: string[] } {
  const definition = { ...data.definition } as Record<string, unknown>;
  const errors: string[] = [];

  if (stepIndex === 0) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Basics must be a JSON object.");
        return { data, errors };
      }
      const basics = parsed.value as Record<string, unknown>;
      definition.id = basics.id ?? definition.id;
      definition.name = basics.name ?? definition.name;
      definition.description = basics.description ?? definition.description;
      definition.version = basics.version ?? definition.version;
    }
    if (!definition.id) errors.push("id is required.");
    if (!definition.name) errors.push("name is required.");
    if (!definition.description) errors.push("description is required.");
    if (!definition.version) errors.push("version is required.");
  } else if (stepIndex === 1) {
    const parsed = parseFlexibleInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (typeof parsed.value === "string") {
        definition.type = parsed.value;
      } else if (parsed.value && typeof parsed.value === "object") {
        const obj = parsed.value as Record<string, unknown>;
        if (typeof obj.type === "string") {
          definition.type = obj.type;
        }
      }
    }
    if (!definition.type) errors.push("type is required.");
  } else if (stepIndex === 2) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!Array.isArray(parsed.value)) {
        errors.push("Triggers must be a JSON array.");
        return { data, errors };
      }
      definition.triggers = parsed.value;
    }
  } else if (stepIndex === 3) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Input schema must be a JSON object.");
        return { data, errors };
      }
      definition.input_schema = parsed.value;
    }
  } else if (stepIndex === 4) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (!definition.type) {
      errors.push("type must be set before steps.");
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!Array.isArray(parsed.value)) {
        errors.push("Steps must be a JSON array.");
        return { data, errors };
      }
      if (definition.type === "workflow") {
        definition.steps = parsed.value;
        delete definition.tool_chain;
      } else {
        definition.tool_chain = parsed.value;
        delete definition.steps;
      }
    }
  } else if (stepIndex === 5) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Settings must be a JSON object.");
        return { data, errors };
      }
      const settings = parsed.value as Record<string, unknown>;
      if (settings.allowed_tools !== undefined) {
        definition.allowed_tools = settings.allowed_tools as unknown;
      }
      if (settings.timeout_ms !== undefined) {
        definition.timeout_ms = settings.timeout_ms as unknown;
      }
      if (settings.enabled !== undefined) {
        definition.enabled = settings.enabled as unknown;
      }
      if (settings.tags !== undefined) {
        definition.tags = settings.tags as unknown;
      }
    }
  }

  return { data: { ...data, definition }, errors };
}

function applyHookWizardStep(
  stepIndex: number,
  input: string,
  data: WizardData,
): { data: WizardData; errors: string[] } {
  const definition = { ...data.definition } as Record<string, unknown>;
  const errors: string[] = [];

  if (stepIndex === 0) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Basics must be a JSON object.");
        return { data, errors };
      }
      const basics = parsed.value as Record<string, unknown>;
      definition.id = basics.id ?? definition.id;
      definition.name = basics.name ?? definition.name;
      definition.description = basics.description ?? definition.description;
      definition.priority = basics.priority ?? definition.priority;
      definition.timeout_ms = basics.timeout_ms ?? definition.timeout_ms;
      definition.fail_open = basics.fail_open ?? definition.fail_open;
    }
    if (!definition.id) errors.push("id is required.");
    if (!definition.name) errors.push("name is required.");
    if (!definition.description) errors.push("description is required.");
  } else if (stepIndex === 1) {
    const parsed = parseFlexibleInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (typeof parsed.value === "string") {
        definition.trigger = parsed.value;
      } else if (parsed.value && typeof parsed.value === "object") {
        const obj = parsed.value as Record<string, unknown>;
        if (typeof obj.trigger === "string") {
          definition.trigger = obj.trigger;
        }
      }
    }
    if (!definition.trigger) errors.push("trigger is required.");
  } else if (stepIndex === 2) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Filters must be a JSON object.");
        return { data, errors };
      }
      definition.filter = parsed.value;
    }
  } else if (stepIndex === 3) {
    const parsed = parseJsonInput(input);
    if (parsed.error) {
      errors.push(parsed.error);
      return { data, errors };
    }
    if (parsed.value !== undefined) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        errors.push("Action must be a JSON object.");
        return { data, errors };
      }
      definition.action = parsed.value;
    }
  } else if (stepIndex === 4) {
    const action = definition.action as Record<string, unknown> | undefined;
    if (action && action.type === "mutate") {
      const parsed = parseJsonInput(input);
      if (parsed.error) {
        errors.push(parsed.error);
        return { data, errors };
      }
      if (parsed.value !== undefined) {
        if (!Array.isArray(parsed.value)) {
          errors.push("Mutation ops must be a JSON array.");
          return { data, errors };
        }
        action.ops = parsed.value;
        definition.action = action;
      }
    }
  }

  return { data: { ...data, definition }, errors };
}

function formatJsonLines(value: unknown, maxLines = 18): string[] {
  const raw = JSON.stringify(value, null, 2) ?? "";
  const lines = raw.split("\n");
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), "..."];
  }
  return lines;
}

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
  const pendingSkillActionRef = useRef<{
    type: "edit" | "enable" | "disable";
    id: string;
  } | null>(null);
  const pendingHookActionRef = useRef<{
    type: "edit" | "enable" | "disable";
    id: string;
  } | null>(null);
  useEffect(() => {
    return store.subscribe(() => {
      setSnapshot(store.getSnapshot());
    });
  }, [store]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

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

    if (action === "get") {
      const item = payload?.item as Record<string, unknown> | undefined;
      const pending = pendingSkillActionRef.current;
      if (pending && item && pending.id === item.id) {
        if (pending.type === "edit") {
          store.startWizard("skill", { mode: "edit", definition: item });
        } else {
          const next = { ...item, enabled: pending.type === "enable" };
          sendCommand("skills_update", { id: pending.id, definition: next });
        }
        pendingSkillActionRef.current = null;
        store.clearInput();
        return;
      }
      if (item) {
        store.addMessage("system", `Skill ${item.id ?? ""} loaded.`);
      }
      return;
    }

    if (action === "create" || action === "update") {
      store.exitWizard();
      if (content) {
        store.addMessage("system", content);
      }
      sendCommand("skills_list");
      return;
    }

    if (action === "delete") {
      if (content) {
        store.addMessage("system", content);
      }
      sendCommand("skills_list");
      return;
    }

    if (action === "run") {
      if (content) {
        store.addMessage("agent", content);
      }
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

    if (action === "get") {
      const item = payload?.item as Record<string, unknown> | undefined;
      const pending = pendingHookActionRef.current;
      if (pending && item && pending.id === item.id) {
        if (pending.type === "edit") {
          store.startWizard("hook", { mode: "edit", definition: item });
        } else {
          const next = { ...item, enabled: pending.type === "enable" };
          sendCommand("hooks_update", { id: pending.id, definition: next });
        }
        pendingHookActionRef.current = null;
        store.clearInput();
        return;
      }
      if (item) {
        store.addMessage("system", `Hook ${item.id ?? ""} loaded.`);
      }
      return;
    }

    if (action === "create" || action === "update") {
      store.exitWizard();
      if (content) {
        store.addMessage("system", content);
      }
      sendCommand("hooks_list");
      return;
    }

    if (action === "delete") {
      if (content) {
        store.addMessage("system", content);
      }
      sendCommand("hooks_list");
      return;
    }
  };

  const handleResponse = (data?: ResponseData) => {
    if (!data) {
      return;
    }

    const metadata = data.metadata ?? {};
    const kind = typeof metadata.kind === "string" ? metadata.kind : null;
    const content = data.content ?? "";
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
    if (data.error) {
      metaLines.push(`Error: ${data.error}`);
    }

    const meta = metaLines.length ? metaLines.join("\n") : undefined;

    if (requestId && meta) {
      store.updateMessageMeta(requestId, meta);
    }

    if (!content && data.error) {
      store.addMessage("system", `Error: ${data.error}`);
    }

    if (content && (!requestId || !messageExists(store.getSnapshot().history, requestId))) {
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
    store.insertInput(data.text);
    const cache = fileCacheRef.current;
    if (cache) {
      store.updateAutocomplete(cache);
    }
    store.ensureInputCursorVisible(widthRef.current - 2, prompt, DEFAULT_MAX_INPUT_LINES);
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

  const startSkillWizard = (mode: WizardMode, definition?: Record<string, unknown>) => {
    store.startWizard("skill", {
      mode,
      definition: definition ?? createDefaultSkillDefinition(),
    });
    store.clearInput();
  };

  const startHookWizard = (mode: WizardMode, definition?: Record<string, unknown>) => {
    store.startWizard("hook", {
      mode,
      definition: definition ?? createDefaultHookDefinition(),
    });
    store.clearInput();
  };

  const handleWizardSubmit = () => {
    if (snapshot.uiMode !== "wizard" || !snapshot.wizardType) {
      return;
    }
    const wizardData = snapshot.wizardData as WizardData;
    const stepIndex = snapshot.wizardStepIndex;
    const inputText = snapshot.inputText;
    const maxSteps = snapshot.wizardType === "skill" ? SKILL_WIZARD_STEPS.length : HOOK_WIZARD_STEPS.length;
    if (stepIndex >= maxSteps - 1) {
      return;
    }
    const result =
      snapshot.wizardType === "skill"
        ? applySkillWizardStep(stepIndex, inputText, wizardData)
        : applyHookWizardStep(stepIndex, inputText, wizardData);
    if (result.errors.length > 0) {
      store.setWizardErrors(result.errors);
      return;
    }
    const nextStep = Math.min(stepIndex + 1, maxSteps - 1);
    store.updateWizard(result.data, nextStep);
    store.clearInput();
  };

  const handleWizardSave = () => {
    if (snapshot.uiMode !== "wizard" || !snapshot.wizardType) {
      return;
    }
    const wizardData = snapshot.wizardData as WizardData;
    const definition = wizardData.definition as Record<string, unknown>;
    const id = definition.id;
    if (!id || typeof id !== "string") {
      store.setWizardErrors(["id is required before saving."]);
      return;
    }
    if (snapshot.wizardType === "skill") {
      if (wizardData.mode === "new") {
        sendCommand("skills_create", { definition });
      } else {
        sendCommand("skills_update", { id, definition });
      }
    } else {
      if (wizardData.mode === "new") {
        sendCommand("hooks_create", { definition });
      } else {
        sendCommand("hooks_update", { id, definition });
      }
    }
  };

  const handleSkillsCommand = (arg?: string) => {
    const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const id = parts[1];
    if (!sub) {
      store.setUIMode("skills");
      sendCommand("skills_list");
      return;
    }
    if (sub === "list") {
      store.setUIMode("skills");
      sendCommand("skills_list");
      return;
    }
    if (sub === "new") {
      startSkillWizard("new");
      return;
    }
    if (sub === "edit") {
      if (!id) {
        store.addMessage("system", "Usage: /skills edit <id>");
        return;
      }
      pendingSkillActionRef.current = { type: "edit", id };
      sendCommand("skills_get", { id });
      return;
    }
    if (sub === "enable" || sub === "disable") {
      if (!id) {
        store.addMessage("system", `Usage: /skills ${sub} <id>`);
        return;
      }
      pendingSkillActionRef.current = { type: sub, id } as { type: "enable" | "disable"; id: string };
      sendCommand("skills_get", { id });
      return;
    }
    if (sub === "delete") {
      if (!id) {
        store.addMessage("system", "Usage: /skills delete <id>");
        return;
      }
      sendCommand("skills_delete", { id });
      return;
    }
    if (sub === "run") {
      if (!id) {
        store.addMessage("system", "Usage: /skills run <id> [input]");
        return;
      }
      const rawInput = parts.slice(2).join(" ");
      let payload: unknown = undefined;
      if (rawInput) {
        try {
          payload = JSON.parse(rawInput);
        } catch {
          payload = rawInput;
        }
      }
      store.setUIMode("chat");
      sendCommand("skills_run", { id, input: payload });
      return;
    }
    store.addMessage("system", `Unknown skills command: ${sub}`);
  };

  const handleHooksCommand = (arg?: string) => {
    const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const id = parts[1];
    if (!sub) {
      store.setUIMode("hooks");
      sendCommand("hooks_list");
      return;
    }
    if (sub === "list") {
      store.setUIMode("hooks");
      sendCommand("hooks_list");
      return;
    }
    if (sub === "new") {
      startHookWizard("new");
      return;
    }
    if (sub === "edit") {
      if (!id) {
        store.addMessage("system", "Usage: /hooks edit <id>");
        return;
      }
      pendingHookActionRef.current = { type: "edit", id };
      sendCommand("hooks_get", { id });
      return;
    }
    if (sub === "enable" || sub === "disable") {
      if (!id) {
        store.addMessage("system", `Usage: /hooks ${sub} <id>`);
        return;
      }
      pendingHookActionRef.current = { type: sub, id } as { type: "enable" | "disable"; id: string };
      sendCommand("hooks_get", { id });
      return;
    }
    if (sub === "delete") {
      if (!id) {
        store.addMessage("system", "Usage: /hooks delete <id>");
        return;
      }
      sendCommand("hooks_delete", { id });
      return;
    }
    store.addMessage("system", `Unknown hooks command: ${sub}`);
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

    if (snapshot.uiMode === "wizard") {
      if (key.escape) {
        store.exitWizard();
        store.clearInput();
        return;
      }
      if (key.ctrl && input === "s") {
        handleWizardSave();
        return;
      }
      if (key.return && !key.shift) {
        handleWizardSubmit();
        return;
      }
    }

    if ((snapshot.uiMode === "skills" || snapshot.uiMode === "hooks") && key.escape) {
      store.setUIMode("chat");
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
  const scrollInfo = snapshot.scrollOffset > 0
    ? `Scroll: ${snapshot.scrollOffset} lines up`
    : "At bottom";
  const newMessageInfo = snapshot.newMessages ? "New messages" : "";

  const headerLines = [
    `Voice Agent - Ink TUI${snapshot.compact ? " [compact]" : ""}`,
    `Session: ${snapshot.sessionKey ?? "-"} | State: ${snapshot.state} | Voice: ${snapshot.voiceMode ? "on" : "off"} | Mode: ${snapshot.uiMode}`,
    `Status: ${statusLine}`,
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
  ): { text: string; role?: Role }[] => {
    const lines: { text: string; role?: Role }[] = [];
    lines.push({ text: `${title} (${items.length})`, role: "system" });
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
    lines.push({ text: "Press Esc to return to chat.", role: "system" });
    return lines;
  };

  const buildWizardLines = (): { text: string; role?: Role }[] => {
    const lines: { text: string; role?: Role }[] = [];
    const wizardType = snapshot.wizardType ?? "skill";
    const steps = wizardType === "skill" ? SKILL_WIZARD_STEPS : HOOK_WIZARD_STEPS;
    const step = steps[snapshot.wizardStepIndex] ?? steps[0];
    const wizardData = snapshot.wizardData as WizardData;
    const definition = (wizardData?.definition ?? {}) as Record<string, any>;
    lines.push({
      text: `Wizard: ${wizardType} (${snapshot.wizardStepIndex + 1}/${steps.length}) - ${step.title}`,
      role: "system",
    });
    lines.push({ text: step.prompt, role: "system" });

    if (snapshot.wizardErrors.length > 0) {
      lines.push({ text: "", role: "system" });
      lines.push({ text: "Errors:", role: "system" });
      for (const err of snapshot.wizardErrors) {
        lines.push({ text: `- ${err}`, role: "system" });
      }
    }

    lines.push({ text: "", role: "system" });
    lines.push({ text: "Current values:", role: "system" });

    if (wizardType === "skill") {
      if (snapshot.wizardStepIndex === 0) {
        lines.push({ text: `id: ${definition.id ?? ""}`, role: "system" });
        lines.push({ text: `name: ${definition.name ?? ""}`, role: "system" });
        lines.push({ text: `description: ${definition.description ?? ""}`, role: "system" });
        lines.push({ text: `version: ${definition.version ?? ""}`, role: "system" });
      } else if (snapshot.wizardStepIndex === 1) {
        lines.push({ text: `type: ${definition.type ?? ""}`, role: "system" });
      } else if (snapshot.wizardStepIndex === 2) {
        for (const line of formatJsonLines(definition.triggers)) {
          lines.push({ text: line, role: "system" });
        }
      } else if (snapshot.wizardStepIndex === 3) {
        for (const line of formatJsonLines(definition.input_schema)) {
          lines.push({ text: line, role: "system" });
        }
      } else if (snapshot.wizardStepIndex === 4) {
        const stepsValue = definition.type === "tool_chain" ? definition.tool_chain : definition.steps;
        for (const line of formatJsonLines(stepsValue)) {
          lines.push({ text: line, role: "system" });
        }
      } else if (snapshot.wizardStepIndex === 5) {
        lines.push({ text: `allowed_tools: ${JSON.stringify(definition.allowed_tools)}`, role: "system" });
        lines.push({ text: `timeout_ms: ${definition.timeout_ms ?? ""}`, role: "system" });
        lines.push({ text: `enabled: ${definition.enabled ?? ""}`, role: "system" });
        lines.push({ text: `tags: ${JSON.stringify(definition.tags)}`, role: "system" });
      } else {
        for (const line of formatJsonLines(definition)) {
          lines.push({ text: line, role: "system" });
        }
      }
    } else {
      if (snapshot.wizardStepIndex === 0) {
        lines.push({ text: `id: ${definition.id ?? ""}`, role: "system" });
        lines.push({ text: `name: ${definition.name ?? ""}`, role: "system" });
        lines.push({ text: `description: ${definition.description ?? ""}`, role: "system" });
        lines.push({ text: `priority: ${definition.priority ?? ""}`, role: "system" });
        lines.push({ text: `timeout_ms: ${definition.timeout_ms ?? ""}`, role: "system" });
      } else if (snapshot.wizardStepIndex === 1) {
        lines.push({ text: `trigger: ${definition.trigger ?? ""}`, role: "system" });
      } else if (snapshot.wizardStepIndex === 2) {
        for (const line of formatJsonLines(definition.filter)) {
          lines.push({ text: line, role: "system" });
        }
      } else if (snapshot.wizardStepIndex === 3) {
        for (const line of formatJsonLines(definition.action)) {
          lines.push({ text: line, role: "system" });
        }
      } else if (snapshot.wizardStepIndex === 4) {
        const action = definition.action as Record<string, unknown> | undefined;
        for (const line of formatJsonLines(action?.ops)) {
          lines.push({ text: line, role: "system" });
        }
      } else {
        for (const line of formatJsonLines(definition)) {
          lines.push({ text: line, role: "system" });
        }
      }
    }

    lines.push({ text: "", role: "system" });
    lines.push({ text: "Enter advances. Ctrl+S saves. Esc cancels.", role: "system" });
    return lines;
  };

  let historyLines = store.getHistoryLines(width, snapshot.compact, STREAM_CURSOR);
  if (snapshot.uiMode === "skills") {
    historyLines = buildListLines("Skills", snapshot.skillsList, snapshot.skillsErrors);
  } else if (snapshot.uiMode === "hooks") {
    historyLines = buildListLines("Hooks", snapshot.hooksList, snapshot.hooksErrors);
  } else if (snapshot.uiMode === "wizard") {
    historyLines = buildWizardLines();
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
