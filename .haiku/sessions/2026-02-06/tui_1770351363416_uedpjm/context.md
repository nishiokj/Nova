---
session: tui_1770351363416_uedpjm
created: 2026-02-06T04:16:03.417Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770351387086
why are question prompts still showing in the TUI

### function_call
@callId call_61ce388d5ad04751bd7d3d96
@name explorer
@ts 1770351390417
@workItemId 4f83988a
{"objective":"Find where question prompts are being displayed in the TUI and understand why they are still showing","delta":"Investigating the source of question prompts in the TUI"}

### function_call_output
@callId call_61ce388d5ad04751bd7d3d96
@ts 1770351471558
@isError true
@durationMs 81141
@workItemId 4f83988a
Sub-agent 'explorer' failed (reason: invalid_action): Explorer read 3 files but extracted 0 artifacts. This is a hard failure. Every file read MUST produce artifacts. Files read: packages/tui/index.tsx, packages/tui/components/index.ts, packages/tui/store.ts
Tools called: 22 (22 succeeded, 0 failed)
Partial output:
<tool_call>Grep<arg_key>caseSensitive</arg_key><arg_value>false</arg_value><arg_key>path</arg_key><arg_value>packages/harness-daemon</arg_value><arg_key>pattern</arg_key><arg_value>user_prompt|prompt.*user|prompt_user</arg_value></tool_call><tool_call>Grep<arg_key>caseSensitive</arg_key><arg_value>false</arg_value><arg_key>path</arg_key><arg_value>packages/dashboard-control</arg_value><arg_key>pattern</arg_key><arg_value>user_prompt|question|prompt.*user</arg_value></tool_call><tool_call>Grep<ar... [truncated]

### function_call
@callId call_346bcd22368d432091be1122
@name Grep
@ts 1770351474260
@workItemId 4f83988a
{"caseSensitive":false,"path":"packages/tui","pattern":"user_prompt|questionPrompt|prompt.*question"}

### function_call
@callId call_1b978f6a618a47039c57cf2a
@name Grep
@ts 1770351474260
@workItemId 4f83988a
{"caseSensitive":false,"path":"packages/harness-daemon","pattern":"questionPrompt"}

### function_call
@callId call_7716462588f843b6be4834b4
@name Grep
@ts 1770351474260
@workItemId 4f83988a
{"caseSensitive":false,"path":"packages/protocol","pattern":"questionPrompt"}

### function_call
@callId call_35e80ecce5de4d4b91039118
@name Grep
@ts 1770351474260
@workItemId 4f83988a
{"caseSensitive":false,"path":"packages/harness-daemon/src/harness","pattern":"user_prompt"}

### function_call_output
@callId call_346bcd22368d432091be1122
@ts 1770351475353
@durationMs 1092
@workItemId 4f83988a
packages/tui/store.ts:18:33: *   Question     - interactive prompts, multi-question sequences
packages/tui/index.tsx:28:12:  type UserPromptQuestion,
packages/tui/index.tsx:774:15:        case "user_prompt":
packages/tui/index.tsx:1492:14:      q: UserPromptQuestion,
packages/tui/index.tsx:1546:34:        toAgentQuestion(q as UserPromptQuestion, validatedData.request_id, i)
packages/tui/index.tsx:1588:22:        (data as UserPromptData).question_type
packages/tui/index.tsx:1676:17:      type === "user_prompt_response" ||
packages/tui/index.tsx:2033:26:            sendCommand("user_prompt_response", {
packages/tui/index.tsx:2075:26:            sendCommand("user_prompt_response", {
packages/tui/parsing.test.ts:16:7:  UserPromptQuestion,
packages/tui/parsing.test.ts:111:34:      const result = validateUserPromptData({ question: "test?" });
packages/tui/parsing.test.ts:117:26:      expect(validateUserPromptData({ request_id: 123, question: "test?" }).valid).toBe(false);
packages/tui/parsing.test.ts:118:26:      expect(validateUserPromptData({ request_id: null, question: "test?" }).valid).toBe(false);
packages/tui/parsing.test.ts:119:26:      expect(validateUserPromptData({ request_id: {}, question: "test?" }).valid).toBe(false);
packages/tui/parsing.test.ts:123:34:      const result = validateUserPromptData({ request_id: "req-1", question: "test?" });
packages/tui/parsing.test.ts:499:10:  q: UserPromptQuestion,
packages/tui/parsing.test.ts:764:32:      toAgentQuestion(q as UserPromptQuestion, data.request_id, i)
packages/tui/parsing.test.ts:776:24:    expect(validateUserPromptData({ question: null }).valid).toBe(false);
packages/tui/types.ts:25:6:  | "user_prompt_response"
packages/tui/types.ts:65:6:  | "user_prompt"
...[truncated at 20 results]

### function_call_output
@callId call_1b978f6a618a47039c57cf2a
@ts 1770351475353
@durationMs 1091
@workItemId 4f83988a
No matches found for pattern: questionPrompt

### function_call_output
@callId call_7716462588f843b6be4834b4
@ts 1770351475354
@durationMs 1090
@workItemId 4f83988a
No matches found for pattern: questionPrompt

### function_call_output
@callId call_35e80ecce5de4d4b91039118
@ts 1770351475355
@durationMs 1089
@workItemId 4f83988a
packages/harness-daemon/src/harness/control_plane_routes.ts:1545:31:    ?? asString(metadata.last_user_prompt)
packages/harness-daemon/src/harness/bridge_gateway.ts:481:15:    register('user_prompt_response', (data, ctx) => this.handleUserPromptResponse(ctx.connectionId, data, ctx.state));
packages/harness-daemon/src/harness/harness.ts:1592:72:    // is only used for harness-level events (status, response, error, user_prompt).
packages/harness-daemon/src/harness/event_translator.ts:459:12:    type: 'user_prompt',
packages/harness-daemon/src/harness/types.ts:73:6:  | 'user_prompt'
packages/harness-daemon/src/harness/types.ts:186:25: * User prompt data for user_prompt events.

### function_call
@callId call_ccdd3384737b4a9587ca13f1
@name Read
@ts 1770351477252
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":774,"endLine":800}

### function_call
@callId call_8ee1ecb669a54244b81cea6c
@name Read
@ts 1770351477252
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":1490,"endLine":1600}

### function_call_output
@callId call_ccdd3384737b4a9587ca13f1
@ts 1770351477256
@durationMs 3
@workItemId 4f83988a
// Lines 774-800 of 2933 total
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

### function_call_output
@callId call_8ee1ecb669a54244b81cea6c
@ts 1770351477256
@durationMs 2
@workItemId 4f83988a
// Lines 1490-1600 of 2933 total
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

### function_call
@callId call_3aa8987f553b4e999164577a
@name Read
@ts 1770351481158
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":1670,"endLine":1690}

### function_call
@callId call_97f95d7106804d66af777375
@name Grep
@ts 1770351481158
@workItemId 4f83988a
{"pattern":"renderQuestion|QuestionView|ActiveQuestion","path":"packages/tui","caseSensitive":false}

### function_call_output
@callId call_3aa8987f553b4e999164577a
@ts 1770351481166
@durationMs 6
@workItemId 4f83988a
// Lines 1670-1690 of 2933 total
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

### function_call_output
@callId call_97f95d7106804d66af777375
@ts 1770351481166
@durationMs 6
@workItemId 4f83988a
packages/tui/FAILURE_MODES.md:37:40:  if (this.questionProcessing || !this.activeQuestion) return false;
packages/tui/store.ts:151:3:  activeQuestion: AgentQuestion | null;
packages/tui/store.ts:253:11:  private activeQuestion: AgentQuestion | null = null;
packages/tui/store.ts:383:7:      activeQuestion: this.activeQuestion,
packages/tui/store.ts:1055:6:  setActiveQuestion(question: AgentQuestion | null, requestId?: string): void {
packages/tui/store.ts:1056:10:    this.activeQuestion = question;
packages/tui/store.ts:1078:15:      this.setActiveQuestion(questions[0], requestId);
packages/tui/store.ts:1088:48:    const total = answered + remaining + (this.activeQuestion ? 1 : 0);
packages/tui/store.ts:1096:15:    if (!this.activeQuestion?.options) return;
packages/tui/store.ts:1097:24:    const count = this.activeQuestion.options.length;
packages/tui/store.ts:1109:15:    if (!this.activeQuestion) return;
packages/tui/store.ts:1112:12:      this.activeQuestion.type === "multiple_choice" ||
packages/tui/store.ts:1113:12:      this.activeQuestion.type === "yes_no" ||
packages/tui/store.ts:1114:12:      this.activeQuestion.type === "plan_mode_exit" ||
packages/tui/store.ts:1115:12:      this.activeQuestion.type === "spec_review"
packages/tui/store.ts:1119:21:    } else if (this.activeQuestion.type === "multi_select") {
packages/tui/store.ts:1165:15:    if (!this.activeQuestion) return null;
packages/tui/store.ts:1167:18:    switch (this.activeQuestion.type) {
packages/tui/store.ts:1173:21:        return this.activeQuestion.options?.[this.questionSelection[0]]?.id;
packages/tui/store.ts:1176:23:          (i) => this.activeQuestion!.options![i]?.id
...[truncated at 20 results]

### function_call
@callId call_10837d6646e64173951fc04b
@name Grep
@ts 1770351485341
@workItemId 4f83988a
{"path":"packages/tui","pattern":"useQuestion|activeQuestion|renderActiveQuestion"}

### function_call
@callId call_435d9a1c5b5446cd9cb5b840
@name Read
@ts 1770351485341
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":250,"endLine":350}

### function_call_output
@callId call_10837d6646e64173951fc04b
@ts 1770351485742
@durationMs 392
@workItemId 4f83988a
packages/tui/store.ts:151:3:  activeQuestion: AgentQuestion | null;
packages/tui/store.ts:253:11:  private activeQuestion: AgentQuestion | null = null;
packages/tui/store.ts:383:7:      activeQuestion: this.activeQuestion,
packages/tui/store.ts:1055:6:  setActiveQuestion(question: AgentQuestion | null, requestId?: string): void {
packages/tui/store.ts:1056:10:    this.activeQuestion = question;
packages/tui/store.ts:1078:15:      this.setActiveQuestion(questions[0], requestId);
packages/tui/store.ts:1088:48:    const total = answered + remaining + (this.activeQuestion ? 1 : 0);
packages/tui/store.ts:1096:15:    if (!this.activeQuestion?.options) return;
packages/tui/store.ts:1097:24:    const count = this.activeQuestion.options.length;
packages/tui/store.ts:1109:15:    if (!this.activeQuestion) return;
packages/tui/store.ts:1112:12:      this.activeQuestion.type === "multiple_choice" ||
packages/tui/store.ts:1113:12:      this.activeQuestion.type === "yes_no" ||
packages/tui/store.ts:1114:12:      this.activeQuestion.type === "plan_mode_exit" ||
packages/tui/store.ts:1115:12:      this.activeQuestion.type === "spec_review"
packages/tui/store.ts:1119:21:    } else if (this.activeQuestion.type === "multi_select") {
packages/tui/store.ts:1165:15:    if (!this.activeQuestion) return null;
packages/tui/store.ts:1167:18:    switch (this.activeQuestion.type) {
packages/tui/store.ts:1173:21:        return this.activeQuestion.options?.[this.questionSelection[0]]?.id;
packages/tui/store.ts:1176:23:          (i) => this.activeQuestion!.options![i]?.id
packages/tui/store.ts:1192:42:    if (this.questionProcessing || !this.activeQuestion) return false;
...[truncated at 20 results]

### function_call_output
@callId call_435d9a1c5b5446cd9cb5b840
@ts 1770351485742
@durationMs 389
@workItemId 4f83988a
// Lines 250-350 of 2933 total
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


### function_call
@callId call_81d3a79ac85842238f2528b2
@name Grep
@ts 1770351487299
@workItemId 4f83988a
{"path":"packages/tui","pattern":"QuestionPanel|QuestionCard|renderActiveQuestion"}

### function_call
@callId call_3922dbbf117f49f38e198e81
@name Read
@ts 1770351487299
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":1,"endLine":100}

### function_call_output
@callId call_81d3a79ac85842238f2528b2
@ts 1770351487309
@durationMs 9
@workItemId 4f83988a
No matches found for pattern: QuestionPanel|QuestionCard|renderActiveQuestion

### function_call_output
@callId call_3922dbbf117f49f38e198e81
@ts 1770351487309
@durationMs 1
@workItemId 4f83988a
// Lines 1-100 of 2933 total
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

### function_call
@callId call_31e333281a6b49adb270c9b6
@name Glob
@ts 1770351488800
@workItemId 4f83988a
{"pattern":"packages/tui/components/*.tsx"}

### function_call
@callId call_e1217bc3bf43436bae6c9bdd
@name Grep
@ts 1770351488800
@workItemId 4f83988a
{"path":"packages/tui","pattern":"activeQuestion.*render|Question.*Component|PromptComponent"}

### function_call_output
@callId call_31e333281a6b49adb270c9b6
@ts 1770351488818
@durationMs 12
@workItemId 4f83988a
packages/tui/components/AuthGate.tsx
packages/tui/components/Divider.tsx
packages/tui/components/ErrorBoundary.tsx
packages/tui/components/MultiSelect.tsx
packages/tui/components/PermissionPrompt.test.tsx
packages/tui/components/PermissionPrompt.tsx
packages/tui/components/ProvidersView.tsx
packages/tui/components/ResponsePane.tsx
packages/tui/components/SessionsView.tsx
packages/tui/components/SingleSelect.tsx
packages/tui/components/TextInputField.tsx
packages/tui/components/UsageView.tsx

### function_call_output
@callId call_e1217bc3bf43436bae6c9bdd
@ts 1770351488818
@durationMs 12
@workItemId 4f83988a
packages/tui/parsing.test.ts:149:42:      // Semantic validation (meaningful question text) is left to the component.

### function_call
@callId call_49c74a9d60ff4d8395a55f5d
@name Grep
@ts 1770351490933
@workItemId 4f83988a
{"path":"packages/tui/index.tsx","pattern":"PermissionPrompt|activeQuestion|Question"}

### function_call
@callId call_06673b21bc674efba531746a
@name Read
@ts 1770351490933
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":2700,"endLine":2933}

### function_call_output
@callId call_49c74a9d60ff4d8395a55f5d
@ts 1770351491323
@durationMs 388
@workItemId 4f83988a
packages/tui/index.tsx:28:18:  type UserPromptQuestion,
packages/tui/index.tsx:29:13:  type AgentQuestion,
packages/tui/index.tsx:30:8:  type QuestionOption,
packages/tui/index.tsx:31:8:  type QuestionType,
packages/tui/index.tsx:44:10:import { PermissionPrompt } from "./components/PermissionPrompt.js";
packages/tui/index.tsx:746:60:    enabled: !snapshot.helpVisible && snapshot.uiMode !== "question" && snapshot.uiMode !== "providers",
packages/tui/index.tsx:1429:29:    // Validate that either question (single) or questions (array) is present
packages/tui/index.tsx:1430:20:    const hasSingleQuestion = 'question' in payload && typeof payload.question === 'string';
packages/tui/index.tsx:1431:22:    const hasMultipleQuestions = 'questions' in payload && Array.isArray(payload.questions);
packages/tui/index.tsx:1433:19:    if (!hasSingleQuestion && !hasMultipleQuestions) {
packages/tui/index.tsx:1434:46:      return { valid: false, error: 'Missing question or questions array' };
packages/tui/index.tsx:1437:17:    // Validate questions array is not empty
packages/tui/index.tsx:1438:20:    if (hasMultipleQuestions && (payload.questions as unknown[]).length === 0) {
packages/tui/index.tsx:1439:38:      return { valid: false, error: 'questions array must not be empty' };
packages/tui/index.tsx:1442:17:    // Validate questions array elements have required fields
packages/tui/index.tsx:1443:20:    if (hasMultipleQuestions) {
packages/tui/index.tsx:1444:36:      for (let i = 0; i < (payload.questions as unknown[]).length; i++) {
packages/tui/index.tsx:1445:28:        const q = (payload.questions as unknown[])[i];
packages/tui/index.tsx:1447:42:          return { valid: false, error: `questions[${i}] is not an object` };
packages/tui/index.tsx:1449:15:        const questionObj = q as Record<string, unknown>;
...[truncated at 20 results]

### function_call_output
@callId call_06673b21bc674efba531746a
@ts 1770351491323
@durationMs 388
@workItemId 4f83988a
// Lines 2700-2933 of 2933 total

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

        const goal =
...[truncated, file size: 146222 bytes]

### function_call
@callId call_4ec48a15b0d9485b8ac830e9
@name Grep
@ts 1770351504380
@workItemId 4f83988a
{"path":"packages/tui/index.tsx","pattern":"snapshot\\.activeQuestion|uiMode.*question|PermissionPrompt.*active"}

### function_call
@callId call_b0fd025acc1945c09d6dc3f5
@name Read
@ts 1770351504380
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":600,"endLine":800}

### function_call_output
@callId call_4ec48a15b0d9485b8ac830e9
@ts 1770351505442
@durationMs 1053
@workItemId 4f83988a
packages/tui/index.tsx:746:48:    enabled: !snapshot.helpVisible && snapshot.uiMode !== "question" && snapshot.uiMode !== "providers",
packages/tui/index.tsx:1954:18:    if (snapshot.uiMode === "question" && snapshot.activeQuestion) {
packages/tui/index.tsx:1955:28:      const questionType = snapshot.activeQuestion.type;
packages/tui/index.tsx:1964:11:      if (snapshot.activeQuestion.options && snapshot.activeQuestion.options.length > 0) {
packages/tui/index.tsx:2008:35:          const currentQuestion = snapshot.activeQuestion;
packages/tui/index.tsx:3072:26:  const activeQuestion = snapshot.activeQuestion ?? null;
packages/tui/index.tsx:3073:35:  const isQuestionMode = snapshot.uiMode === "question" && !!activeQuestion;

### function_call_output
@callId call_b0fd025acc1945c09d6dc3f5
@ts 1770351505442
@durationMs 1048
@workItemId 4f83988a
// Lines 600-800 of 2933 total
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

### function_call
@callId call_a7bb103da95e4d838169f2af
@name Read
@ts 1770351525582
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":1950,"endLine":2050}

### function_call
@callId call_63083de8842941738b5e6e15
@name Read
@ts 1770351525582
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":3060,"endLine":3100}

### function_call_output
@callId call_a7bb103da95e4d838169f2af
@ts 1770351525595
@durationMs 11
@workItemId 4f83988a
// Lines 1950-2050 of 2933 total
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

### function_call_output
@callId call_63083de8842941738b5e6e15
@ts 1770351525595
@durationMs 10
@workItemId 4f83988a
// Lines 3060-2933 of 2933 total


### function_call
@callId call_3ff2d9bb45a94d16946c7f6c
@name Read
@ts 1770351527556
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/index.tsx","startLine":2900,"endLine":2933}

### function_call
@callId call_9903f55d24f541acac0b88be
@name Grep
@ts 1770351527556
@workItemId 4f83988a
{"path":"packages/tui/index.tsx","pattern":"return.*PermissionPrompt|return.*isQuestionMode|activeQuestion.*render"}

### function_call_output
@callId call_3ff2d9bb45a94d16946c7f6c
@ts 1770351527567
@durationMs 3
@workItemId 4f83988a
// Lines 2900-2933 of 2933 total
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

        const goal =
...[truncated, file size: 146222 bytes]

### function_call_output
@callId call_9903f55d24f541acac0b88be
@ts 1770351527567
@durationMs 8
@workItemId 4f83988a
No matches found for pattern: return.*PermissionPrompt|return.*isQuestionMode|activeQuestion.*render

### function_call
@callId call_a45c41804ea247b880084b67
@name Grep
@ts 1770351530417
@workItemId 4f83988a
{"path":"packages/tui/index.tsx","pattern":"useEffect.*isQuestionMode|snapshot\\.uiMode.*question"}

### function_call
@callId call_92eff1ebec6d4f95853d337f
@name Grep
@ts 1770351530417
@workItemId 4f83988a
{"path":"packages/tui/index.tsx","pattern":"store\\.setUIMode\\(&quot;question&quot;|setUIMode.*question"}

### function_call_output
@callId call_a45c41804ea247b880084b67
@ts 1770351530818
@durationMs 396
@workItemId 4f83988a
packages/tui/index.tsx:746:39:    enabled: !snapshot.helpVisible && snapshot.uiMode !== "question" && snapshot.uiMode !== "providers",
packages/tui/index.tsx:1954:9:    if (snapshot.uiMode === "question" && snapshot.activeQuestion) {
packages/tui/index.tsx:3073:26:  const isQuestionMode = snapshot.uiMode === "question" && !!activeQuestion;

### function_call_output
@callId call_92eff1ebec6d4f95853d337f
@ts 1770351530818
@durationMs 391
@workItemId 4f83988a
No matches found for pattern: store\.setUIMode\(&quot;question&quot;|setUIMode.*question

### function_call
@callId call_27a679ea62f344999f9d6ca5
@name Grep
@ts 1770351535483
@workItemId 4f83988a
{"path":"packages/tui/store.ts","pattern":"setUIMode|uiMode.*question"}

### function_call
@callId call_f9906351c79a4a788681ccc8
@name Read
@ts 1770351535483
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/tui/store.ts","startLine":1050,"endLine":1090}

### function_call_output
@callId call_27a679ea62f344999f9d6ca5
@ts 1770351535885
@durationMs 400
@workItemId 4f83988a
packages/tui/store.ts:2:45:import type { MessageEntry, Role, TUIState, UIMode, WizardType, AgentQuestion, QuestionType, EventLevel, EventKind, ResponseContent, ModelEntry, SessionEntry, UsageSessionSummary, UsageDayStats, Us
packages/tui/store.ts:497:3:  setUIMode(mode: UIMode): void {
packages/tui/store.ts:1064:12:      this.uiMode = "question";

### function_call_output
@callId call_f9906351c79a4a788681ccc8
@ts 1770351535885
@durationMs 11
@workItemId 4f83988a
// Lines 1050-1090 of 2778 total

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

### function_call
@callId call_c99e385f645e4479a8414f7e
@name Grep
@ts 1770351541289
@workItemId 4f83988a
{"path":"packages/harness-daemon/src/harness","pattern":"user_prompt.*event|emit.*user_prompt"}

### function_call
@callId call_6bb4f4ade7a6412c8b3ae620
@name Grep
@ts 1770351541289
@workItemId 4f83988a
{"path":"packages/harness-daemon/src/harness","pattern":"async.*question|watcher.*question|question.*watcher"}

### function_call_output
@callId call_c99e385f645e4479a8414f7e
@ts 1770351541304
@durationMs 11
@workItemId 4f83988a
packages/harness-daemon/src/harness/types.ts:186:25: * User prompt data for user_prompt events.

### function_call_output
@callId call_6bb4f4ade7a6412c8b3ae620
@ts 1770351541304
@durationMs 11
@workItemId 4f83988a
No matches found for pattern: async.*question|watcher.*question|question.*watcher

### function_call
@callId call_8e5e46f92fc641078f4fd08d
@name Grep
@ts 1770351545428
@workItemId 4f83988a
{"path":"packages/harness-daemon","pattern":"question_type|question:|questionPrompt"}

### function_call
@callId call_34b399c65f014310bafc3fc0
@name Read
@ts 1770351545428
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":1580,"endLine":1620}

### function_call_output
@callId call_8e5e46f92fc641078f4fd08d
@ts 1770351545813
@durationMs 382
@workItemId 4f83988a
packages/harness-daemon/src/harness/types.ts:42:3:  question: string;
packages/harness-daemon/src/harness/types.ts:178:3:  question: string;
packages/harness-daemon/src/harness/types.ts:182:3:  question_type?: string;
packages/harness-daemon/src/harness/types.ts:195:3:  question_type?: string;
packages/harness-daemon/src/harness/bridge_gateway.ts:254:7:      question: event.prompt.question,
packages/harness-daemon/src/harness/event_translator.ts:408:3:  question: string;
packages/harness-daemon/src/harness/event_translator.ts:420:5:    question: q.question,
packages/harness-daemon/src/harness/event_translator.ts:424:5:    question_type: q.questionType,
packages/harness-daemon/src/harness/event_translator.ts:455:10:    data.question_type = questionType;
packages/harness-daemon/src/harness/harness.ts:2288:9:        question: String(result.userPrompt.question ?? 'Please provide input:'),
packages/harness-daemon/src/harness/harness.ts:2974:11:          question: entry.question,

### function_call_output
@callId call_34b399c65f014310bafc3fc0
@ts 1770351545813
@durationMs 380
@workItemId 4f83988a
// Lines 1580-1620 of 2731 total
          this.logger.debug('GraphDSubscriber created');
        }
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    const userMessagePersisted = clearContextForHandoff ? false : this.persistUserMessage(sessionKey, requestId, inputText);
    const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);

    // NOTE: Agent events (agent_message, tool_call, etc.) are now forwarded directly
    // from EventBus to BusServer via BusServer's direct subscription. The eventQueue
    // is only used for harness-level events (status, response, error, user_prompt).

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Run UserPromptSubmit hooks before processing
        if (this.hookExecutor) {
          const hookContext: SkillHookContext = {
            event: 'UserPromptSubmit',
            sessionKey,
            requestId,
            workingDir: effectiveWorkingDir,
          };
          const hookResult = await this.hookExecutor.execute('UserPromptSubmit', hookContext);
          if (hookResult.action === 'block') {
            eventQueue.push(createErrorEvent(hookResult.message || 'Request blocked by hook', false));
            eventQueue.push(createStatusEvent('idle'));
            return {
              requestId,
              sessionKey,
              success: false,
              finalText: hookResult.message || 'Request blocked by hook',
              errorMessage: hookResult.message,
              paused: false,
              toolsUsed: [],
              durationMs: 0,
            };
          }
        }


### function_call
@callId call_e1bdd5edb18c494097e2138d
@name Grep
@ts 1770351556369
@workItemId 4f83988a
{"path":"packages/harness-daemon/src/harness","pattern":"createUserPromptEvent|user_prompt.*eventQueue|eventQueue\\.push.*user_prompt"}

### function_call
@callId call_2654d7e17b6d4edbb8b6be2d
@name Read
@ts 1770351556369
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":2280,"endLine":2320}

### function_call_output
@callId call_e1bdd5edb18c494097e2138d
@ts 1770351556604
@durationMs 232
@workItemId 4f83988a
packages/harness-daemon/src/harness/event_translator.ts:433:17:export function createUserPromptEvent(
packages/harness-daemon/src/harness/harness.ts:50:3:  createUserPromptEvent,
packages/harness-daemon/src/harness/harness.ts:1683:27:          eventQueue.push(createUserPromptEvent(
packages/harness-daemon/src/harness/index.ts:15:3:  createUserPromptEvent,

### function_call_output
@callId call_2654d7e17b6d4edbb8b6be2d
@ts 1770351556604
@durationMs 231
@workItemId 4f83988a
// Lines 2280-2320 of 2731 total
      requestId,
      sessionKey: context.sessionKey,
      success: result.success,
      finalText: result.response,
      errorMessage: result.error,
      paused: result.paused,
      userPrompt: result.paused && result.userPrompt ? {
        requestId,
        question: String(result.userPrompt.question ?? 'Please provide input:'),
        options: result.userPrompt.options,
        context: result.userPrompt.context,
        multiSelect: result.userPrompt.multiSelect,
        questionType: result.userPrompt.questionType,
        questions: result.userPrompt.questions,
      } : undefined,
      toolsUsed: [],
      durationMs: result.metrics.durationMs,
      metadata: { agentType, metrics: result.metrics },
    };
  }

  /**
   * Get message history for a session.
   * Returns conversation history that should be displayed in TUI.
   */
  getSessionHistory(sessionKey: string): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    const store = this.ensureSessionHydrated(sessionKey, { includeUserPreferences: false });
    return store.getMessageHistory();
  }

  /**
   * Create a ready event for initialization.
   */
  createReadyEvent(sessionKey: string): BridgeEvent {
    return createReadyEvent(sessionKey, this.getSessionHistory(sessionKey));
  }

  /**
   * Get the loaded configuration.
   */
  getConfig(): FullHarnessConfig {

### function_call
@callId call_497f66a6a4594a8eb0a3b02e
@name Read
@ts 1770351560440
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":1670,"endLine":1720}

### function_call
@callId call_f3ac5caaeae943d3b04c53a6
@name Grep
@ts 1770351560440
@workItemId 4f83988a
{"path":"packages/harness-daemon/src/harness","pattern":"result\\.userPrompt|userPrompt.*="}

### function_call_output
@callId call_497f66a6a4594a8eb0a3b02e
@ts 1770351561029
@durationMs 585
@workItemId 4f83988a
// Lines 1670-1720 of 2731 total
          if (result.finalText) {
            eventQueue.push(
              createResponseEvent(
                requestId,
                true, // Partial success - got response before pause
                result.finalText,
                result.toolsUsed,
                result.durationMs,
                undefined,
                result.metadata
              )
            );
          }
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect,
            result.userPrompt.questionType,
            result.userPrompt.questions
          ));
        } else {
          // Execution completed (success or failure) - emit response event
          eventQueue.push(
            createResponseEvent(
              requestId,
              result.success,
              result.finalText,
              result.toolsUsed,
              result.durationMs,
              result.errorMessage,
              result.metadata
            )
          );
        }

        eventQueue.push(createStatusEvent('idle'));

        this.persistToGraphD(sessionKey, requestId, inputText, result.finalText, result.durationMs, userMessagePersisted);

        return result;
      } catch (error) {
        // Handle recoverable errors (rate limit, circuit open, retries exhausted)
        const recoverable = classifyRecoverableError(error, requestId);
        if (recoverable) {
          this.logger[recoverable.logLevel]('Recoverable error during agent run', recoverable.logMeta);

          // Emit rate_limit event for monitoring/dashboards (if applicable)
          if (recoverable.rateLimitData) {
            emit(createEvent('rate_limit', recoverable.rateLimitData));

### function_call_output
@callId call_f3ac5caaeae943d3b04c53a6
@ts 1770351561029
@durationMs 584
@workItemId 4f83988a
packages/harness-daemon/src/harness/bridge_gateway.ts:253:5:    userPrompt: event.type === 'user_input_required' ? {
packages/harness-daemon/src/harness/harness.ts:1493:35:      const isSpecReview = paused.userPromptType === 'spec_review';
packages/harness-daemon/src/harness/harness.ts:1494:40:      const isHandoffApproval = paused.userPromptType === 'handoff_approval';
packages/harness-daemon/src/harness/harness.ts:1495:37:      const isPlanModeExit = paused.userPromptType === 'plan_mode_exit';
packages/harness-daemon/src/harness/harness.ts:1668:30:        if (result.paused && result.userPrompt) {
packages/harness-daemon/src/harness/harness.ts:1684:13:            result.userPrompt.requestId,
packages/harness-daemon/src/harness/harness.ts:1685:13:            result.userPrompt.question,
packages/harness-daemon/src/harness/harness.ts:1686:13:            result.userPrompt.options,
packages/harness-daemon/src/harness/harness.ts:1687:13:            result.userPrompt.context,
packages/harness-daemon/src/harness/harness.ts:1688:13:            result.userPrompt.multiSelect,
packages/harness-daemon/src/harness/harness.ts:1689:13:            result.userPrompt.questionType,
packages/harness-daemon/src/harness/harness.ts:1690:13:            result.userPrompt.questions
packages/harness-daemon/src/harness/harness.ts:2272:25:        userPromptType: result.userPrompt?.questionType,
packages/harness-daemon/src/harness/harness.ts:2286:36:      userPrompt: result.paused && result.userPrompt ? {
packages/harness-daemon/src/harness/harness.ts:2288:26:        question: String(result.userPrompt.question ?? 'Please provide input:'),
packages/harness-daemon/src/harness/harness.ts:2289:18:        options: result.userPrompt.options,
packages/harness-daemon/src/harness/harness.ts:2290:18:        context: result.userPrompt.context,
packages/harness-daemon/src/harness/harness.ts:2291:22:        multiSelect: result.userPrompt.multiSelect,
packages/harness-daemon/src/harness/harness.ts:2292:23:        questionType: result.userPrompt.questionType,
packages/harness-daemon/src/harness/harness.ts:2293:20:        questions: result.userPrompt.questions,
...[truncated at 20 results]

### function_call
@callId call_b6e904cd2f18407287337a1a
@name Grep
@ts 1770351562971
@workItemId 4f83988a
{"path":"packages/orchestrator","pattern":"userPrompt|user_prompt"}

### function_call
@callId call_7442752be79e4aa2b604b0d2
@name Grep
@ts 1770351562971
@workItemId 4f83988a
{"path":"packages/agent","pattern":"userPrompt|user_prompt"}

### function_call_output
@callId call_b6e904cd2f18407287337a1a
@ts 1770351562985
@durationMs 12
@workItemId 4f83988a
packages/orchestrator/src/orchestrator.test.ts:698:21:      expect(result.userPrompt).toBeDefined();
packages/orchestrator/src/orchestrator.ts:15:3:  UserPromptInfo,
packages/orchestrator/src/orchestrator.ts:203:3:  userPrompt?: UserPromptInfo;
packages/orchestrator/src/orchestrator.ts:1609:7:      userPrompt: partial.userPrompt,
packages/orchestrator/src/orchestrator.ts:1816:5:    userPrompt?: UserPromptInfo;
packages/orchestrator/src/orchestrator.ts:1821:68:    const { terminationReason, context, workId, response, metrics, userPrompt, agentResult, cadence, controlEventType } = params;
packages/orchestrator/src/orchestrator.ts:1879:14:        if (!userPrompt) return null;
packages/orchestrator/src/orchestrator.ts:1880:25:        const options = userPrompt.options?.map(option => {
packages/orchestrator/src/orchestrator.ts:1889:11:          userPrompt.question,
packages/orchestrator/src/orchestrator.ts:1891:11:          userPrompt.context,
packages/orchestrator/src/orchestrator.ts:1892:11:          userPrompt.multiSelect ?? false
packages/orchestrator/src/orchestrator.ts:1980:5:    userPrompt?: UserPromptInfo,
packages/orchestrator/src/orchestrator.ts:2016:7:      userPrompt,
packages/orchestrator/src/orchestrator.ts:2331:41:    if (result.needsUserInput && result.userPrompt) {
packages/orchestrator/src/orchestrator.ts:2338:77:      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
packages/orchestrator/src/orchestrator.ts:2347:16:        result.userPrompt,
packages/orchestrator/src/orchestrator.ts:2362:11:          userPrompt: result.userPrompt,
packages/orchestrator/src/orchestrator.statemachine.test.ts:362:19:    expect(result.userPrompt).toBeDefined();

### function_call_output
@callId call_7442752be79e4aa2b604b0d2
@ts 1770351562985
@durationMs 6
@workItemId 4f83988a
packages/agent/src/types.ts:14:11:  StopHookUserPrompt,
packages/agent/src/types.ts:161:7:      userPrompt: UserPromptInfo;
packages/agent/src/types.ts:170:7:      userPrompt?: undefined;
packages/agent/src/types.ts:179:7:      userPrompt?: undefined;
packages/agent/src/types.ts:188:7:      userPrompt?: undefined;
packages/agent/src/types.ts:197:7:      userPrompt?: undefined;
packages/agent/src/types.ts:210:3:  userPrompt?: UserPromptInfo;
packages/agent/src/types.ts:224:18:export interface UserPromptQuestion {
packages/agent/src/types.ts:236:18:export interface UserPromptInfo {
packages/agent/src/types.ts:244:15:  questions?: UserPromptQuestion[];
packages/agent/src/agent.ts.bak:29:3:  UserPromptInfo,
packages/agent/src/agent.ts.bak:30:3:  UserPromptQuestion,
packages/agent/src/agent.ts.bak:148:12:    result.userPrompt = {
packages/agent/src/agent.ts.bak:1046:16:        result.userPrompt = undefined;
packages/agent/src/agent.ts.bak:1124:18:        // Build UserPromptInfo from validated args
packages/agent/src/agent.ts.bak:1126:16:        result.userPrompt = {
packages/agent/src/agent.ts.bak:1128:66:          options: Array.isArray(args.options) ? args.options as UserPromptInfo['options'] : undefined,
packages/agent/src/agent.ts.bak:1132:72:          questions: Array.isArray(args.questions) ? args.questions as UserPromptQuestion[] : undefined,
packages/agent/src/index.ts:21:3:  UserPromptInfo,
packages/agent/src/agent.ts:33:3:  UserPromptInfo,
...[truncated at 20 results]

### function_call
@callId call_91fa26878fd64f4db2b5c13e
@name Grep
@ts 1770351565448
@workItemId 4f83988a
{"path":"packages/agent/src/agent.ts","pattern":"userPrompt.*=|result\\.userPrompt"}

### function_call
@callId call_97ae1e7eb61843a1a4c412bd
@name Read
@ts 1770351565448
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":1,"endLine":100}

### function_call_output
@callId call_91fa26878fd64f4db2b5c13e
@ts 1770351565856
@durationMs 406
@workItemId 4f83988a
packages/agent/src/agent.ts:635:7:      result.userPrompt = {
packages/agent/src/agent.ts:647:22:    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
packages/agent/src/agent.ts:653:9:        result.userPrompt = inferredPrompt;
packages/agent/src/agent.ts:1454:14:        if (!result.userPrompt) {
packages/agent/src/agent.ts:1461:23:          userPrompt: result.userPrompt,
packages/agent/src/agent.ts:1981:9:        result.userPrompt = undefined;
packages/agent/src/agent.ts:2047:9:        result.userPrompt = {

### function_call_output
@callId call_97ae1e7eb61843a1a4c412bd
@ts 1770351565856
@durationMs 405
@workItemId 4f83988a
// Lines 1-100 of 2634 total
/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 */

import path from 'node:path';
import type { LLMAdapter, Message, LLMRequestConfig, LLMResponse } from 'llm';
import {
  resilientCall,
  RateLimitError,
  CircuitOpenError,
  RetriesExhaustedError,
  TimeoutError,
  DEFAULT_RESILIENCE_CONFIG,
} from 'llm';
import type { ToolRegistry } from 'tools';
import type { ToolDefinition, ToolResult, FileContentItem, ArtifactKind, StructuredOutputSchema, MessageItem, ContextItem, ArtifactItem, LLMItem, ContentBlock } from 'types';
import { isLLMMessageItem, isLLMFunctionCallItem, isLLMFunctionCallOutputItem } from 'types';
import type { HandoffSpec } from 'protocol';
import { createEvent, errorResult, successResult } from 'types';
import { buildLLMRequestConfig, coerceStructuredOutput, extractPreJsonText, createMicroQueue, profiler, StreamingJsonExtractor, getOutputSchema, OUTPUT_SCHEMAS, unwrapStructuredOutput } from 'shared';
import { ContextWindow, buildSystemMessage } from 'context';
import type { WorkItem } from 'work';
import { createWorkItem } from 'work';
import type {
  AgentConfig,
  AgentRunParams,
  AgentResult,
  AgentMetrics,
  EventEmitCallback,
  UserPromptInfo,
  UserPromptQuestion,
  AgentHooks,
  InternalHookQueue,
  InternalHookContext,
  MutableAgentResult,
} from './types.js';
import { noopEmit, noopHookQueue } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import {
  getProviderCircuitState,
  resetProviderCircuit,
  getCircuitStatus,
} from './circuit-breaker-registry.js';
import { TOOL_LIMITS, truncateToolOutput, isRefusal } from './constants.js';

import { DEFAULT_AGENT_BUDGET } from './types.js';

/**
 * Cadence check interval: every N LLM iterations, invoke the watcher hook.
 * For a 50-iteration budget this gives 5 check-ins; for 20 iterations, 2.
 */
const CADENCE_CHECK_INTERVAL = 10;

// Re-export circuit breaker functions for backwards compatibility
export { resetProviderCircuit, getCircuitStatus };

type AgentAction = 'done' | 'continue' | 'handoff';

const QUESTION_CLEANUP_REGEX = /```[\s\S]*?```|`[^`]*`/g;

function inferUserPromptFromResponse(responseText?: string): UserPromptInfo | null {
  if (!responseText) return null;

  const cleaned = responseText.replace(QUESTION_CLEANUP_REGEX, '').trim();
  if (!cleaned.includes('?')) return null;

  const lastQuestionIndex = cleaned.lastIndexOf('?');
  if (lastQuestionIndex === -1) return null;

  const beforeQuestion = cleaned.slice(0, lastQuestionIndex);
  const boundaryIndex = Math.max(
    beforeQuestion.lastIndexOf('.'),
    beforeQuestion.lastIndexOf('!'),
    beforeQuestion.lastIndexOf('?'),
    beforeQuestion.lastIndexOf('\n')
  );

  const question = cleaned.slice(boundaryIndex + 1, lastQuestionIndex + 1).trim();
  if (question.length < 2 || !/[a-zA-Z]/.test(question)) return null;

  const context = cleaned.slice(0, boundaryIndex + 1).trim();
  return {
    question,
    context: context.length > 0 ? context : undefined,
  };
}

/**
 * Model selection override for per-agent-type model configuration.
 */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
}

/**

### function_call
@callId call_756aeb1a56624834aa14bb07
@name Read
@ts 1770351571814
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":630,"endLine":670}

### function_call
@callId call_bda69f2b3dd5476eabcb0dee
@name Read
@ts 1770351571814
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":640,"endLine":660}

### function_call_output
@callId call_756aeb1a56624834aa14bb07
@ts 1770351571822
@durationMs 5
@workItemId 4f83988a
// Lines 630-670 of 2634 total
      : content;

    // Check awaitingUserInput first (fallback for conversational questions)
    if (!result.needsUserInput && structuredOutput?.awaitingUserInput === true) {
      result.needsUserInput = true;
      result.userPrompt = {
        question: responseText || contentFallback || 'Waiting for your response...',
      };
      result.terminationReason = 'user_input_required';
      return 'user_input';
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = responseText ?? contentFallback;
      const inferredPrompt = inferUserPromptFromResponse(responseCandidate);
      if (inferredPrompt) {
        result.needsUserInput = true;
        result.userPrompt = inferredPrompt;
        result.terminationReason = 'user_input_required';
        if (responseCandidate.trim()) {
          result.response = responseCandidate;
        }
        return 'user_input';
      }
    }

    // Handle done action
    if (action === 'done') {
      const goalReached = structuredOutput?.goalStateReached === true;
      if (!goalReached) {
        result.terminationReason = 'invalid_action';
        result.error = 'Action "done" requires goalStateReached: true.';
        return 'done';
      }


### function_call_output
@callId call_bda69f2b3dd5476eabcb0dee
@ts 1770351571822
@durationMs 3
@workItemId 4f83988a
// Lines 640-660 of 2634 total
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = responseText ?? contentFallback;
      const inferredPrompt = inferUserPromptFromResponse(responseCandidate);
      if (inferredPrompt) {
        result.needsUserInput = true;
        result.userPrompt = inferredPrompt;
        result.terminationReason = 'user_input_required';
        if (responseCandidate.trim()) {
          result.response = responseCandidate;
        }
        return 'user_input';
      }
    }

### function_call
@callId call_69ffa7d58b3a4a5c860b4fc6
@name Read
@ts 1770351591313
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":600,"endLine":670}

### function_call
@callId call_bbb4e26715cd446a92932a6a
@name Read
@ts 1770351591313
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":550,"endLine":630}

### function_call_output
@callId call_69ffa7d58b3a4a5c860b4fc6
@ts 1770351591321
@durationMs 4
@workItemId 4f83988a
// Lines 600-670 of 2634 total
    structuredOutput: Record<string, unknown> | null,
    result: MutableAgentResult
  ): 'return' | 'continue' | null {
    const handoffSpec = structuredOutput?.handoffSpec;
    if (handoffSpec && this.isHandoffSpecCandidate(handoffSpec)) {
      result.needsHandoff = true;
      result.handoffSpec = handoffSpec;
      result.terminationReason = 'handoff_requested';
      return 'return';
    }

    // No valid handoffSpec provided, continue execution
    return 'continue';
  }

  /**
   * Resolve the action from structured output into a loop control directive.
   * Sets result fields as side effects (terminationReason, success, response, etc.)
   * @returns loop control: 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
   */
  private resolveAction(
    action: AgentAction | null,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string,
    result: MutableAgentResult
  ): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action' {
    const avoidRawStructured = !!this.config.outputSchema;
    const contentFallback = avoidRawStructured && (structuredOutput || coerceStructuredOutput(content))
      ? ''
      : content;

    // Check awaitingUserInput first (fallback for conversational questions)
    if (!result.needsUserInput && structuredOutput?.awaitingUserInput === true) {
      result.needsUserInput = true;
      result.userPrompt = {
        question: responseText || contentFallback || 'Waiting for your response...',
      };
      result.terminationReason = 'user_input_required';
      return 'user_input';
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = responseText ?? contentFallback;
      const inferredPrompt = inferUserPromptFromResponse(responseCandidate);
      if (inferredPrompt) {
        result.needsUserInput = true;
        result.userPrompt = inferredPrompt;
        result.terminationReason = 'user_input_required';
        if (responseCandidate.trim()) {
          result.response = responseCandidate;
        }
        return 'user_input';
      }
    }

    // Handle done action
    if (action === 'done') {
      const goalReached = structuredOutput?.goalStateReached === true;
      if (!goalReached) {
        result.terminationReason = 'invalid_action';
        result.error = 'Action "done" requires goalStateReached: true.';
        return 'done';
      }


### function_call_output
@callId call_bbb4e26715cd446a92932a6a
@ts 1770351591321
@durationMs 3
@workItemId 4f83988a
// Lines 550-630 of 2634 total
        // Fire memory_injected hook even on failure for observability
        this.internalHookQueue.enqueue({
          type: 'memory_injected',
          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
            || this.buildMemoryQuery(workItem, globalContext),
          resultPreview: undefined,
          itemCount: 0,
          success: false,
          iteration,
          version: 'v1',
        }, this.buildHookContext(workItem));
        this.emit(createEvent('memory_injected', {
          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
            || this.buildMemoryQuery(workItem, globalContext),
          resultPreview: undefined,
          itemCount: 0,
          success: false,
          iteration,
          version: 'v1',
        }, workItem.workId));
      }
    }

    // Combine task context with memory injection
    const combinedMemoryContent = [recentConversationContent, memoryContent]
      .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
      .join('\n\n');
    const contextWithMemory = combinedMemoryContent
      ? `${taskContext}\n\n${combinedMemoryContent}`
      : taskContext;

    const messages = this.buildMessages(
      system,
      contextWithMemory + lastIterationInstruction,
      workItem,
      globalContext,
      localContext
    );

    const tools = allowedTools.length > 0 ? allowedTools : undefined;
    const toolChoice = isLastIteration && tools ? 'none' as const : undefined;

    return { messages, tools, toolChoice };
  }

  /**
   * Handle handoff action from structured output.
   * @returns 'return' if should exit loop, 'continue' if should continue to next iteration, null if not a handoff
   */
  private handleHandoff(
    structuredOutput: Record<string, unknown> | null,
    result: MutableAgentResult
  ): 'return' | 'continue' | null {
    const handoffSpec = structuredOutput?.handoffSpec;
    if (handoffSpec && this.isHandoffSpecCandidate(handoffSpec)) {
      result.needsHandoff = true;
      result.handoffSpec = handoffSpec;
      result.terminationReason = 'handoff_requested';
      return 'return';
    }

    // No valid handoffSpec provided, continue execution
    return 'continue';
  }

  /**
   * Resolve the action from structured output into a loop control directive.
   * Sets result fields as side effects (terminationReason, success, response, etc.)
   * @returns loop control: 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
   */
  private resolveAction(
    action: AgentAction | null,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string,
    result: MutableAgentResult
  ): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action' {
    const avoidRawStructured = !!this.config.outputSchema;
    const contentFallback = avoidRawStructured && (structuredOutput || coerceStructuredOutput(content))
      ? ''
      : content;

### function_call
@callId call_cd8a390c3af2494f8cf11ed1
@name Read
@ts 1770351632626
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":1980,"endLine":2060}

### function_call_output
@callId call_cd8a390c3af2494f8cf11ed1
@ts 1770351632873
@durationMs 245
@workItemId 4f83988a
// Lines 1980-2060 of 2634 total
        result.needsUserInput = false;
        result.userPrompt = undefined;
      }

      return false;
    };

    const flushParallel = async (): Promise<boolean> => {
      if (pendingParallel.length === 0) return false;
      const batch = pendingParallel.splice(0, pendingParallel.length);
      const results = await Promise.all(batch.map((item) => item.promise));
      for (let i = 0; i < batch.length; i++) {
        const { call } = batch[i];
        const { toolResult, toolDurationMs } = results[i];
        const shouldStop = handleToolResult(call, toolResult, toolDurationMs, false);
        if (shouldStop) {
          return true;
        }
        await mq.yieldIfNeeded();
      }
      return false;
    };

    for (const call of toolCalls) {
      metrics.toolCallsMade++;
      const nameLower = call.name.toLowerCase();

      if (this.config.tools.length === 0 || !allowedTools.has(nameLower)) {
        const shouldStop = await flushParallel();
        if (shouldStop) return;

        const errorMsg = `Tool "${call.name}" is not allowed for this agent`;
        result.toolErrors.push(errorMsg);
        metrics.toolCallsFailed++;
        localContext.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: errorMsg,
          isError: true,
          timestamp: Date.now(),
          workItemId: itemWorkId,
        });
        continue;
      }

      // Normalize tool name to canonical form for case-insensitive lookup
      const canonicalName = canonicalNames.get(nameLower) ?? call.name;

      // Intercept PromptUser tool - signal pause for user input
      if (nameLower === 'promptuser') {
        await flushParallel();
        const args = call.arguments;
        const question = typeof args.question === 'string' ? args.question : '';
        if (!question) {
          localContext.appendItem({
            type: 'function_call_output',
            callId: call.id,
            output: 'PromptUser requires a question',
            isError: true,
            timestamp: Date.now(),
            workItemId: itemWorkId,
          });
          continue;
        }

        // Build UserPromptInfo from validated args
        result.needsUserInput = true;
        result.userPrompt = {
          question,
          options: Array.isArray(args.options) ? args.options as UserPromptInfo['options'] : undefined,
          context: typeof args.context === 'string' ? args.context : undefined,
          multiSelect: typeof args.multiSelect === 'boolean' ? args.multiSelect : undefined,
          questionType: typeof args.questionType === 'string' ? args.questionType : undefined,
          questions: Array.isArray(args.questions) ? args.questions as UserPromptQuestion[] : undefined,
        };
        result.terminationReason = 'user_input_required';

        localContext.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: 'Waiting for user input...',

### function_call
@callId call_de51b877f34c40c1847bfa20
@name Grep
@ts 1770351635998
@workItemId 4f83988a
{"path":"packages","pattern":"awaitingUserInput.*=|awaitingUserInput:|set awaitingUserInput"}

### function_call
@callId call_1f59f4a138c9460ba9d24677
@name Grep
@ts 1770351635998
@workItemId 4f83988a
{"path":"packages/shared/src","pattern":"awaitingUserInput"}

### function_call_output
@callId call_de51b877f34c40c1847bfa20
@ts 1770351636849
@durationMs 842
@workItemId 4f83988a
packages/orchestrator/src/orchestrator.test.ts:195:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:205:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:215:9:        awaitingUserInput: true,
packages/orchestrator/src/orchestrator.test.ts:240:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:249:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:261:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:273:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:285:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:297:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:309:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:320:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.test.ts:1475:13:            awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:140:11:          awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:153:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:227:13:            awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:368:9:        awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:389:13:            awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:524:13:            awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:624:13:            awaitingUserInput: false,
packages/orchestrator/src/orchestrator.invariants.test.ts:779:13:            awaitingUserInput: false,
...[truncated at 20 results]

### function_call_output
@callId call_1f59f4a138c9460ba9d24677
@ts 1770351636849
@durationMs 839
@workItemId 4f83988a
packages/shared/src/structured_output.ts:119:9:  const awaitingUserInputValue = candidate.awaitingUserInput ?? candidate.awaiting_user_input;
packages/shared/src/structured_output.ts:122:9:  const awaitingUserInput = parseBoolean(awaitingUserInputValue, false);
packages/shared/src/structured_output.ts:132:5:    awaitingUserInput,
packages/shared/src/output_schemas.ts:52:3:  awaitingUserInput: z.literal(false),
packages/shared/src/output_schemas.ts:55:7:const AwaitingUserInputOutputSchema = z.object({
packages/shared/src/output_schemas.ts:60:3:  awaitingUserInput: z.literal(true),
packages/shared/src/output_schemas.ts:68:3:  awaitingUserInput: z.literal(false),
packages/shared/src/output_schemas.ts:76:3:  awaitingUserInput: z.literal(false),
packages/shared/src/output_schemas.ts:85:3:  AwaitingUserInputOutputSchema,
packages/shared/src/output_schemas.ts:94:3:  AwaitingUserInputOutputSchema.extend({ work_done: z.string() }).strict(),
packages/shared/src/output_schemas.ts:144:3:  AwaitingUserInputOutputSchema.extend({
packages/shared/src/output_schemas.ts:189:3:  AwaitingUserInputOutputSchema.extend({
packages/shared/src/output_schemas.ts:319:3:  awaitingUserInput: z.literal(false),
packages/shared/src/output_schemas.ts:502:3:  AwaitingUserInputOutputSchema,

### function_call
@callId call_13edd7b9549049fcba9dcd2f
@name Read
@ts 1770351640501
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/shared/src/output_schemas.ts","startLine":1,"endLine":120}

### function_call_output
@callId call_13edd7b9549049fcba9dcd2f
@ts 1770351640513
@durationMs 5
@workItemId 4f83988a
// Lines 1-120 of 668 total
/**
 * Zod schemas for agent structured output validation.
 *
 * These schemas are the source of truth. JSON schema for LLM
 * structured output is derived from these at runtime.
 */

import { z, toJSONSchema } from 'zod';

// ============================================
// OUTPUT SCHEMAS
// ============================================

/**
 * Action enum - what execution agents can do next.
 * Planners can use "handoff" via the planner-specific schema.
 */
export const AgentActionSchema = z.enum(['done', 'continue']);

/**
 * Routing output - used by the router agent.
 */
export const RoutingOutputSchema = z.object({
  tier: z.enum(['simple', 'standard', 'complex']),
}).strict();

// --------------------------------------------
// Base action outputs (explicit state handling)
// --------------------------------------------

const HandoffWorkItemSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  delta: z.string().min(1),
  agent: z.string().min(1),
  domain: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  targetPaths: z.array(z.string()).optional(),
}).strict();

const HandoffSpecSchema = z.object({
  goal: z.string().min(1),
  context: z.string().min(1),
  workItems: z.array(HandoffWorkItemSchema).min(1),
}).strict();

const DoneOutputSchema = z.object({
  action: z.literal('done'),
  response: z.string(),
  goalStateReached: z.literal(true),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(false),
}).strict();

const AwaitingUserInputOutputSchema = z.object({
  action: z.literal('done'),
  response: z.string(),
  goalStateReached: z.literal(false),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(true),
}).strict();

const ContinueOutputSchema = z.object({
  action: z.literal('continue'),
  response: z.string(),
  goalStateReached: z.literal(false),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(false),
}).strict();

const HandoffOutputSchema = z.object({
  action: z.literal('handoff'),
  response: z.string(),
  goalStateReached: z.literal(true),
  handoffSpec: HandoffSpecSchema,
  awaitingUserInput: z.literal(false),
}).strict();

/**
 * Base agent action output - common fields for all action-based agents.
 * Explicitly enumerates all valid state combinations.
 */
export const AgentActionOutputSchema = z.union([
  DoneOutputSchema,
  AwaitingUserInputOutputSchema,
  ContinueOutputSchema,
]);

/**
 * Goal-driven agent output - extends agent action with work tracking.
 */
export const GoalDrivenOutputSchema = z.union([
  DoneOutputSchema.extend({ work_done: z.string() }).strict(),
  AwaitingUserInputOutputSchema.extend({ work_done: z.string() }).strict(),
  ContinueOutputSchema.extend({ work_done: z.string() }).strict(),
]);

/**
 * Code artifact from explorer agent.
 * Rich semantic extraction that enables downstream agents to act without re-reading files.
 */
export const ArtifactSchema = z.object({
  sourcePath: z.string().describe('File path where this artifact was found'),
  line: z.number().int().nullable().describe('Line number for navigation'),
  kind: z.enum([
    'function',
    'class',
    'interface',
    'import',
    'export',
    'constant',
    'pattern',
    'summary',
  ]).describe('What type of code construct this represents'),
  name: z.string().describe('Name of the artifact (function name, class name, etc.)'),
  signature: z.string().nullable().describe(
    "Full type signature (e.g., 'async run(params: RunParams): Promise<Result>')"
  ),
  modifies: z.array(z.string()).nullable().describe(
    'Side effects: state, files, globals this touches (e.g., ["this._items", "fs:config.json", "db:users"])'

### function_call
@callId call_7860cd176b9c4e2c94a2ac0c
@name Read
@ts 1770351649402
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/shared/src/structured_output.ts","startLine":110,"endLine":150}

### function_call
@callId call_be5a2ab6303c4187b7273b9e
@name Read
@ts 1770351649402
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":610,"endLine":680}

### function_call_output
@callId call_7860cd176b9c4e2c94a2ac0c
@ts 1770351650567
@durationMs 8
@workItemId 4f83988a
// Lines 110-150 of 413 total
    'quality_gate',
    'allow',
    'continue',
  ]);
  if (!validWatcherActions.has(watcherActionRaw)) return null;

  const response = typeof candidate.response === 'string' ? candidate.response : '';
  const reason = typeof candidate.reason === 'string' ? candidate.reason : response || 'Watcher decision';

  const awaitingUserInputValue = candidate.awaitingUserInput ?? candidate.awaiting_user_input;
  const goalStateReachedValue = candidate.goalStateReached ?? candidate.goal_state_reached;

  const awaitingUserInput = parseBoolean(awaitingUserInputValue, false);
  const goalStateReachedDefault = action === 'done';
  const goalStateReached = action === 'continue'
    ? false
    : parseBoolean(goalStateReachedValue, goalStateReachedDefault);

  const base: Record<string, unknown> = {
    action,
    response,
    goalStateReached,
    awaitingUserInput,
    watcherAction: watcherActionRaw,
    reason,
  };

  if (candidate.semantic && typeof candidate.semantic === 'object' && !Array.isArray(candidate.semantic)) {
    base.semantic = candidate.semantic;
  }

  switch (watcherActionRaw) {
    case 'answer': {
      const answer = candidate.answer;
      if (typeof answer === 'string') {
        base.answer = { text: answer };
        return base;
      }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
      const answerText = (answer as Record<string, unknown>).text;
      if (typeof answerText !== 'string' || answerText.length === 0) return null;

### function_call_output
@callId call_be5a2ab6303c4187b7273b9e
@ts 1770351650567
@durationMs 1148
@workItemId 4f83988a
// Lines 610-680 of 2634 total

    // No valid handoffSpec provided, continue execution
    return 'continue';
  }

  /**
   * Resolve the action from structured output into a loop control directive.
   * Sets result fields as side effects (terminationReason, success, response, etc.)
   * @returns loop control: 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
   */
  private resolveAction(
    action: AgentAction | null,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string,
    result: MutableAgentResult
  ): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action' {
    const avoidRawStructured = !!this.config.outputSchema;
    const contentFallback = avoidRawStructured && (structuredOutput || coerceStructuredOutput(content))
      ? ''
      : content;

    // Check awaitingUserInput first (fallback for conversational questions)
    if (!result.needsUserInput && structuredOutput?.awaitingUserInput === true) {
      result.needsUserInput = true;
      result.userPrompt = {
        question: responseText || contentFallback || 'Waiting for your response...',
      };
      result.terminationReason = 'user_input_required';
      return 'user_input';
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = responseText ?? contentFallback;
      const inferredPrompt = inferUserPromptFromResponse(responseCandidate);
      if (inferredPrompt) {
        result.needsUserInput = true;
        result.userPrompt = inferredPrompt;
        result.terminationReason = 'user_input_required';
        if (responseCandidate.trim()) {
          result.response = responseCandidate;
        }
        return 'user_input';
      }
    }

    // Handle done action
    if (action === 'done') {
      const goalReached = structuredOutput?.goalStateReached === true;
      if (!goalReached) {
        result.terminationReason = 'invalid_action';
        result.error = 'Action "done" requires goalStateReached: true.';
        return 'done';
      }

      const finalText = responseText ?? contentFallback;
      if (isRefusal(finalText)) {
        result.isRefusal = true;
        result.error = 'LLM refused to complete the task';
        result.terminationReason = 'refusal';
      } else {
        result.success = true;
        result.response = finalText;
        result.terminationReason = 'goal_state_reached';
      }

### function_call
@callId call_2ac43e7fbb3845a79dfcda80
@name Grep
@ts 1770351660563
@workItemId 4f83988a
{"path":"packages/shared/src","pattern":"WatcherOutputSchema|watcher.*output|AsyncOutputSchema"}

### function_call
@callId call_6c84990f13d84173b62c6258
@name Read
@ts 1770351660563
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/shared/src/output_schemas.ts","startLine":130,"endLine":220}

### function_call_output
@callId call_2ac43e7fbb3845a79dfcda80
@ts 1770351661034
@durationMs 467
@workItemId 4f83988a
packages/shared/src/structured_output.ts:42:3:  WatcherActionOutput,
packages/shared/src/output_schemas.ts:204:4:// Watcher output schema (explicit action states)
packages/shared/src/output_schemas.ts:290:14:export const WatcherSemanticOutputSchema = z.object({
packages/shared/src/output_schemas.ts:304:13:  semantic: WatcherSemanticOutputSchema,
packages/shared/src/output_schemas.ts:309:13:export type WatcherSemanticOutput = z.infer<typeof WatcherSemanticOutputSchema>;
packages/shared/src/output_schemas.ts:332:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:344:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:366:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:388:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:400:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:409:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:417:13:  semantic: WatcherSemanticOutputSchema.optional(),
packages/shared/src/output_schemas.ts:421:14:export const WatcherActionOutputSchema = z.union([
packages/shared/src/output_schemas.ts:473:12:    return WatcherActionOutputSchema;
packages/shared/src/output_schemas.ts:482:24: * Get JSON schema for watcher output constrained to specific actions.
packages/shared/src/output_schemas.ts:520:3:  watcher_action: WatcherActionOutputSchema,
packages/shared/src/output_schemas.ts:538:13:export type WatcherActionOutput = z.infer<typeof WatcherActionOutputSchema>;
packages/shared/src/index.ts:30:8:  type WatcherActionOutput,

### function_call_output
@callId call_6c84990f13d84173b62c6258
@ts 1770351661034
@durationMs 5
@workItemId 4f83988a
// Lines 130-220 of 668 total
  ),
}).strict();

/**
 * Explorer agent output - discovers codebase structure and artifacts.
 */
export const ExplorerOutputSchema = z.union([
  DoneOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
  AwaitingUserInputOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
  ContinueOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
  HandoffOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
]);

/**
 * Work item from runtime script agent.
 */
export const WorkItemOutputSchema = z.object({
  id: z.string(),
  objective: z.string(),
  delta: z.string(),
  agent: z.string(),
  dependencies: z.array(z.string()),
  toolHint: z.string().nullable(),
  targetPaths: z.array(z.string()).nullable(),
  params: z.record(z.string(), z.unknown()).nullable(),
}).strict();

/**
 * Runtime script agent output - creates execution plans.
 */
export const RuntimeScriptOutputSchema = z.union([
  DoneOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  AwaitingUserInputOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  ContinueOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  HandoffOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
]);

// --------------------------------------------
// Watcher output schema (explicit action states)
// --------------------------------------------

const WatcherActionTypeSchema = z.enum([
  'answer',
  'realign',
  'split',
  'create_work_item',
  'stop_work_item',
  'quality_gate',
  'allow',
  'continue',
]);

const WatcherNoInterventionSchema = z.union([
  z.literal('allow'),
  z.literal('continue'),

### function_call
@callId call_b408ad3379d845bea0686b58
@name Read
@ts 1770351665825
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/shared/src/output_schemas.ts","startLine":200,"endLine":300}

### function_call
@callId call_a74c34eed9c94c258bb9a271
@name Grep
@ts 1770351665825
@workItemId 4f83988a
{"path":"packages/decision-watcher","pattern":"question|prompt.*user|awaitingUserInput"}

### function_call_output
@callId call_b408ad3379d845bea0686b58
@ts 1770351665839
@durationMs 7
@workItemId 4f83988a
// Lines 200-300 of 668 total
  }).strict(),
]);

// --------------------------------------------
// Watcher output schema (explicit action states)
// --------------------------------------------

const WatcherActionTypeSchema = z.enum([
  'answer',
  'realign',
  'split',
  'create_work_item',
  'stop_work_item',
  'quality_gate',
  'allow',
  'continue',
]);

const WatcherNoInterventionSchema = z.union([
  z.literal('allow'),
  z.literal('continue'),
]);

// --------------------------------------------
// Semantic output schema (produced during cadence audits)
// --------------------------------------------

const SemanticComponentStatusSchema = z.object({
  component: z.string(),
  status: z.enum(['complete', 'partial', 'not_started', 'blocked']),
  location: z.string().optional(),
});

const SemanticChangeEntrySchema = z.object({
  file: z.string(),
  summary: z.string(),
  rationale: z.string(),
});

const SemanticGapEntrySchema = z.object({
  required: z.string(),
  current: z.string(),
  blocker: z.string().optional(),
});

const SemanticTradeoffOptionSchema = z.object({
  id: z.string(),
  description: z.string(),
});

const SemanticTradeoffAnalysisSchema = z.object({
  title: z.string(),
  options: z.array(SemanticTradeoffOptionSchema).min(2),
  considerations: z.array(z.string()),
  relevantPreferences: z.array(z.string()),
  precedent: z.string().optional(),
  assessment: z.string().optional(),
});

const SemanticStateAndProgressSchema = z.object({
  objective: z.string(),
  currentState: z.array(SemanticComponentStatusSchema),
  changesMade: z.array(SemanticChangeEntrySchema),
  gapAnalysis: z.array(SemanticGapEntrySchema),
  reasoningTrace: z.array(z.string()),
  blockers: z.array(z.string()),
});

const SemanticDecisionContextSchema = z.object({
  pendingQuestions: z.array(z.string()),
  tradeoffs: z.array(SemanticTradeoffAnalysisSchema),
});

const SemanticCrossReferencesSchema = z.object({
  sessionSalience: z.string().optional(),
  preferences: z.array(z.string()),
  siblingWorkItems: z.array(z.string()),
  decisions: z.array(z.string()),
});

const SemanticSalienceUpdatesSchema = z.object({
  workItemStatus: z.string(),
  patterns: z.array(z.string()).optional(),
  abstractionsInPlay: z.array(z.string()).optional(),
});

/**
 * Semantic output schema - produced during cadence audits.
 * Contains semantic understanding of workItem state for context injection.
 */
export const WatcherSemanticOutputSchema = z.object({
  meta: z.object({
    auditSequence: z.number().int().min(0),
    logPosition: z.number().int().min(0),
    totalEvents: z.number().int().min(0),
  }),
  stateAndProgress: SemanticStateAndProgressSchema,
  decisionContext: SemanticDecisionContextSchema,
  crossReferences: SemanticCrossReferencesSchema,
  salienceUpdates: SemanticSalienceUpdatesSchema.optional(),
});

### function_call_output
@callId call_a74c34eed9c94c258bb9a271
@ts 1770351665839
@durationMs 9
@workItemId 4f83988a
packages/decision-watcher/package.json:5:81:  "description": "Decision watcher for async agent orchestration - auto-answers PromptUser questions using a curated decision and preference database",
packages/decision-watcher/src/plan-context.ts:31:27:  /** Q&A decisions made (questions asked and answers received) */
packages/decision-watcher/src/plan-context.ts:49:7:  /** Question that was asked */
packages/decision-watcher/src/plan-context.ts:50:3:  question: string;
packages/decision-watcher/src/plan-context.ts:125:31:      lines.push(`**Q**: ${qa.question}`);
packages/decision-watcher/src/engine/index.ts:4:28: * Core logic for matching questions to decisions and synthesizing answers.
packages/decision-watcher/src/engine/index.ts:8:30: * - LLM inference for novel questions
packages/decision-watcher/src/engine/index.ts:32:39: * Main decision engine for answering PromptUser questions.
packages/decision-watcher/src/engine/index.ts:93:15:   * Answer a PromptUser question.
packages/decision-watcher/src/engine/index.ts:95:15:  async answerQuestion(context: WatcherContext): Promise<WatcherResponse> {
packages/decision-watcher/src/engine/index.ts:126:55:      console.error('[DecisionEngine] Error answering question:', error);
packages/decision-watcher/src/engine/index.ts:144:49:   * Search database for decisions matching the question.
packages/decision-watcher/src/engine/index.ts:164:12:    // Add question text
packages/decision-watcher/src/engine/index.ts:165:31:    parts.push(context.prompt.question);
packages/decision-watcher/src/engine/index.ts:193:14:    // Check question pattern (Decision only)
packages/decision-watcher/src/engine/index.ts:194:24:    if (isDec && entry.questionPattern) {
packages/decision-watcher/src/engine/index.ts:195:34:      const patternLower = entry.questionPattern.toLowerCase();
packages/decision-watcher/src/engine/index.ts:584:102:    return `You are a decision synthesis assistant. Your task is to synthesize an answer to a user's question based on multiple relevant decisions and preferences from a curated database.
packages/decision-watcher/src/engine/index.ts:593:71:The output should be a clear, direct answer that addresses the user's question.`;
packages/decision-watcher/src/engine/index.ts:602:11:    const questionSection = `**Question:**\n${context.prompt.question}`;
...[truncated at 20 results]

### function_call
@callId call_5ebf69d652ed41acb5473350
@name Read
@ts 1770351670361
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/decision-watcher/src/engine/index.ts","startLine":90,"endLine":140}

### function_call
@callId call_080a2ac5d88d4f38a3fab560
@name Grep
@ts 1770351670361
@workItemId 4f83988a
{"path":"packages/decision-watcher","pattern":"watcher.*answer|answer.*question|sendAnswer"}

### function_call_output
@callId call_5ebf69d652ed41acb5473350
@ts 1770351670583
@durationMs 15
@workItemId 4f83988a
// Lines 90-140 of 719 total
  }

  /**
   * Answer a PromptUser question.
   */
  async answerQuestion(context: WatcherContext): Promise<WatcherResponse> {
    const startTime = Date.now();

    try {
      // Step 1: Search database for matching decisions
      const matches = await this.searchDatabase(context);

      if (matches.length === 0) {
        // No direct matches - can we synthesize or infer?
        return await this.handleNoMatches(context, startTime);
      }

      // Step 2: Analyze matches and select best answer
      const bestMatch = this.selectBestMatch(matches, context);

      if (bestMatch.score < this.config.minConfidenceThreshold) {
        // Low confidence - may need LLM synthesis
        if (this.config.useLLMSynthesis && this.llm) {
          return await this.synthesizeAnswer(matches, context, startTime);
        }

        // Can't synthesize - return uncertain response
        return this.createUncertainResponse(matches, 'low-confidence', startTime);
      }

      // Step 3: Check for consistency issues
      const warnings = await this.checkConsistency(bestMatch.entry, context);

      // Step 4: Build final answer
      return this.createAnswerResponse(bestMatch, matches, warnings, startTime);
    } catch (error) {
      console.error('[DecisionEngine] Error answering question:', error);
      return {
        source: 'uncertain',
        confidence: 'none',
        answer: 'Unable to determine answer due to error.',
        relevantDecisions: [],
        warnings: [`Engine error: ${error instanceof Error ? error.message : String(error)}`],
        requiresConsistencyCheck: false,
        metadata: {
          processingTimeMs: Date.now() - startTime,
          decisionsConsulted: 0,
          llmCalls: 0,
        },
      };
    }

### function_call_output
@callId call_080a2ac5d88d4f38a3fab560
@ts 1770351670583
@durationMs 217
@workItemId 4f83988a
packages/decision-watcher/package.json:5:28:  "description": "Decision watcher for async agent orchestration - auto-answers PromptUser questions using a curated decision and preference database",
packages/decision-watcher/src/engine/index.ts:17:3:  WatcherAnswerSource,
packages/decision-watcher/src/engine/index.ts:32:29: * Main decision engine for answering PromptUser questions.
packages/decision-watcher/src/engine/index.ts:93:6:   * Answer a PromptUser question.
packages/decision-watcher/src/engine/index.ts:95:9:  async answerQuestion(context: WatcherContext): Promise<WatcherResponse> {
packages/decision-watcher/src/engine/index.ts:126:45:      console.error('[DecisionEngine] Error answering question:', error);
packages/decision-watcher/src/engine/index.ts:584:83:    return `You are a decision synthesis assistant. Your task is to synthesize an answer to a user's question based on multiple relevant decisions and preferences from a curated database.
packages/decision-watcher/src/engine/index.ts:593:38:The output should be a clear, direct answer that addresses the user's question.`;
packages/decision-watcher/src/engine/index.ts:620:42:    return `**Goal:** Synthesize a clear answer to the user's question based on the provided decisions.
packages/decision-watcher/src/engine/index.ts:630:31:1. Synthesize a clear, direct answer that addresses the question
packages/decision-watcher/src/engine/index.ts:639:96:    return `You are a decision inference assistant. Your task is to infer the most appropriate answer to a question based on:
packages/decision-watcher/src/engine/index.ts:684:38:    return `**Goal:** Infer the best answer to the user's question based on project context and general patterns.
packages/decision-watcher/src/watcher-agent.ts:68:56:  prompt_user: 120_000,        // Most critical - must answer user questions
packages/decision-watcher/src/watcher-agent.ts:970:26:**You MUST answer with \`watcherAction: "answer"\`.** There is no user available in async mode.
packages/decision-watcher/src/watcher-agent.ts:977:35:4. **Default behavior**: Return \`watcherAction: "answer"\` with "Continue with your best judgment."
packages/decision-watcher/src/watcher-agent.ts:982:5:- \`watcherAction: "answer"\` (always)
packages/decision-watcher/src/watcher-agent.ts:1002:29:  if (workItemLog && action.watcherAction === 'answer') {
packages/decision-watcher/src/watcher-agent.ts:1014:14:  if (action.watcherAction === 'answer') {
packages/decision-watcher/src/watcher-agent.ts:1025:6:  // Watcher failed to provide a proper 'answer' action.
packages/decision-watcher/src/watcher-agent.ts:1026:19:  // Check if the watcher's reason contains useful guidance we can use as an answer.
...[truncated at 20 results]

### function_call
@callId call_9ebc9641b5ed498dad1ac209
@name Read
@ts 1770351675558
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/decision-watcher/src/watcher-agent.ts","startLine":1000,"endLine":1050}

### function_call
@callId call_9d0bbe16cb854a34ac347bbf
@name Grep
@ts 1770351675558
@workItemId 4f83988a
{"path":"packages/orchestrator","pattern":"watcherAction.*answer|handleWatcherResponse|answer.*question"}

### function_call_output
@callId call_9ebc9641b5ed498dad1ac209
@ts 1770351675799
@durationMs 8
@workItemId 4f83988a
// Lines 1000-1050 of 2144 total

  // Log decision to workitem (scoped) in addition to global decision log
  if (workItemLog && action.watcherAction === 'answer') {
    await workItemLog.appendDecision(
      'prompt_user',
      action.watcherAction,
      action.reason,
      questionText,
      action.answer.text
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'answer') {
    return {
      decision: {
        action: 'answer',
        text: action.answer.text,
        confidence: 0.7,
        contextAddendum: action.answer.contextAddendum,
      },
    };
  }

  // Watcher failed to provide a proper 'answer' action.
  // Check if the watcher's reason contains useful guidance we can use as an answer.
  const watcherReason = action.reason;
  const hasUsefulReason = watcherReason.length > 20 &&
    !watcherReason.includes('timeout') &&
    !watcherReason.includes('error') &&
    !watcherReason.includes('fallback');

  // If watcher produced reasoning that looks like an actual answer, use it
  if (hasUsefulReason) {
    console.warn(`[WATCHER] prompt_user: Watcher returned "${action.watcherAction}" instead of "answer", but has useful reason. Using reason as answer.`);
    return {
      decision: {
        action: 'answer',
        text: watcherReason,
        confidence: 0.5,
        contextAddendum: `Watcher returned action "${action.watcherAction}" but provided usable guidance.`,
      },
    };
  }

  // Watcher failed to provide a usable answer in async mode.
  // Escalate instead of silently fabricating an answer.
  const escalationContext = buildEscalationContext({
    trigger: 'prompt_user',
    reason: watcherReason,

### function_call_output
@callId call_9d0bbe16cb854a34ac347bbf
@ts 1770351675799
@durationMs 227
@workItemId 4f83988a
packages/orchestrator/src/ralph-loop.ts:330:64:const ASYNC_MODE_MESSAGE = 'You are in async mode. User cannot answer questions. Do not ask again. Continue working autonomously.';
packages/orchestrator/src/orchestrator.test.ts:250:9:        watcherAction: 'answer',
packages/orchestrator/src/orchestrator.test.ts:702:38:    it.skip('should allow watcher to answer questions in async mode', async () => {
packages/orchestrator/src/orchestrator.ts:107:51:   * When enabled, the watcher will automatically answer PromptUser questions
packages/orchestrator/src/orchestrator.ts:2118:45:    // For user_input_required: the watcher answered the question.

### function_call
@callId call_4ee308eaf2d2428b89678ba7
@name Read
@ts 1770351744625
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2110,"endLine":2160}

### function_call
@callId call_9e7e56da5f6549208c17213b
@name Grep
@ts 1770351744625
@workItemId 4f83988a
{"path":"packages/orchestrator","pattern":"awaitingUserInput.*true|set.*awaitingUserInput|userPrompt.*watcher"}

### function_call_output
@callId call_4ee308eaf2d2428b89678ba7
@ts 1770351745395
@durationMs 20
@workItemId 4f83988a
// Lines 2110-2160 of 2822 total
    }

    this.log('info', 'Control hook blocked termination, re-injecting prompt', {
      iteration,
      terminationReason,
      promptPreview: stopResult.reason.slice(0, 100),
    });

    // For user_input_required: the watcher answered the question.
    // Inject the answer as a USER message (simulating user response),
    // not as a new goal. This preserves the conversational flow.
    if (terminationReason === 'user_input_required') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The watcher's answer goes as a user message (like a human would respond)
      context.addMessage('user', stopResult.reason);
      // Continue with a generic goal - the answer is now in context
      const newItem = this.createWorkItem('Continue with the provided answer', agentType);
      this.enqueue(newItem);
      this.completedWork.delete(this.initialWorkId);
      this.initialWorkId = newItem.workId;
      return true;
    }

    // For handoff_requested: the watcher rejected the plan.
    // Inject the rejection message into context so the planner can revise.
    // Re-enqueue the work item so it can execute again with fresh agent state.
    if (terminationReason === 'handoff_requested') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The rejection goes as a user message
      context.addMessage('user', stopResult.reason);
      // Re-enqueue the work item (do NOT create a new one or reset initialWorkId)
      // The planner will revise the plan on the same work item
      return true;
    }

    // For bounds_exceeded: track realign count and enforce limit to prevent infinite loops
    // Check both orchestrator-level and agent-level termination reasons
    const boundsReasons = ['max_iterations_exceeded', 'max_tool_calls_exceeded', 'max_duration_exceeded'];
    const isBoundsExceeded = boundsReasons.includes(terminationReason ?? '');

    if (isBoundsExceeded) {
      this.realignCount++;
      this.log('info', 'Realign count incremented for bounds exceeded', {
        realignCount: this.realignCount,
        maxRealigns: this.config.maxRealigns,
        terminationReason,
      });

### function_call_output
@callId call_9e7e56da5f6549208c17213b
@ts 1770351745395
@durationMs 765
@workItemId 4f83988a
packages/orchestrator/src/orchestrator.statemachine.test.ts:203:13:            awaitingUserInput: true,
packages/orchestrator/src/orchestrator.statemachine.test.ts:651:15:              awaitingUserInput: true,
packages/orchestrator/src/orchestrator.test.ts:215:9:        awaitingUserInput: true,

### function_call
@callId call_82b64badb92c4fc7a08f73a8
@name Read
@ts 1770351752320
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2310,"endLine":2400}

### function_call_output
@callId call_82b64badb92c4fc7a08f73a8
@ts 1770351752336
@durationMs 6
@workItemId 4f83988a
// Lines 2310-2400 of 2822 total
    iteration: number;
    totalLlmCalls: number;
    totalToolCalls: number;
    now: number;
    startTime: number;
    context: ContextWindow;
    agentType: string;
    inProgress: Map<string, { item: WorkItem; agent: Agent | null }>;
    goal: string;
    cwd: string;
    runtime?: OrchestratorRuntime;
  }): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, cwd, runtime } = params;

    // Extract structured output early for use in multiple checks
    const structured = result.structuredOutput as { action?: string; goalStateReached?: boolean } | undefined;
    const actionIsContinue = structured?.action === 'continue';

    // ============================================================
    // TERMINAL: User input needed (via PromptUser tool)
    // ============================================================
    if (result.needsUserInput && result.userPrompt) {
      // Check for interruption - user message takes precedence over agent's question
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_input_required',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        result.userPrompt,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_input_required')) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response ?? '',
          paused: true,
          userPrompt: result.userPrompt,
          handoffSpec: result.handoffSpec,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Handoff requested
    // ============================================================
    if (result.needsHandoff && result.handoffSpec) {
      // Check for interruption - user message takes precedence over handoff
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts handoff request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      const specLength = JSON.stringify(result.handoffSpec).length;
      this.log('info', 'Handoff requested - checking approval', { workId, specLength });
      this.mergeAgentResultContext(context, workId, result);

      // Call stop hook for approval (watcher in async mode, or no-op in sync mode)
      const stopResult = await this.callStopHook(
        context,
        'handoff_requested',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );


### function_call
@callId call_429111dfe14446e99f4efbe5
@name Read
@ts 1770351778325
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/event_translator.ts","startLine":395,"endLine":475}

### function_call
@callId call_44cd0307b7ed410b8212f087
@name Read
@ts 1770351778325
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/bridge_gateway.ts","startLine":245,"endLine":275}

### function_call_output
@callId call_429111dfe14446e99f4efbe5
@ts 1770351778345
@durationMs 10
@workItemId 4f83988a
// Lines 395-463 of 463 total
        voice_available: false,
        streaming_supported: true,
      },
      config_summary: configSummary,
      history,
    },
  };
}

/**
 * Agent's question format (camelCase).
 */
interface AgentQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

/**
 * Convert agent question (camelCase) to wire format (snake_case).
 */
function toWireQuestion(q: AgentQuestion): UserPromptEventQuestion {
  return {
    question: q.question,
    options: q.options,
    context: q.context,
    multi_select: q.multiSelect,
    question_type: q.questionType,
  };
}

/**
 * Create a user prompt event for the TUI.
 * Supports single question (backwards compatible) or multiple questions.
 * Converts from agent format (camelCase) to wire format (snake_case).
 */
export function createUserPromptEvent(
  requestId: string,
  question?: string,
  options?: Array<string | { label: string; description?: string }>,
  context?: string,
  multiSelect?: boolean,
  questionType?: string,
  questions?: AgentQuestion[]
): BridgeEvent {
  const data: UserPromptEventData = {
    request_id: requestId,
  };

  // If multiple questions provided, convert each to wire format
  if (questions && questions.length > 0) {
    data.questions = questions.map(toWireQuestion);
  } else if (question) {
    // Single question format (backwards compatible)
    data.question = question;
    data.options = options;
    data.context = context;
    data.multi_select = multiSelect;
    data.question_type = questionType;
  }

  return {
    type: 'user_prompt',
    data: data as unknown as Record<string, unknown>,
  };
}


### function_call_output
@callId call_44cd0307b7ed410b8212f087
@ts 1770351778345
@durationMs 3
@workItemId 4f83988a
// Lines 245-275 of 2444 total

  const buildStopContext = (event: ControlEvent, ctx: HookContext): StopHookContext => ({
    workId: event.workId,
    response: 'response' in event ? event.response : '',
    terminationReason: toTerminationReason(event),
    iteration: ctx.iteration,
    agentType: ctx.agentType,
    sessionKey: ctx.sessionKey,
    userPrompt: event.type === 'user_input_required' ? {
      question: event.prompt.question,
      options: event.prompt.options?.map(option => ({ label: option.label, description: option.description })),
      context: event.prompt.context,
      multiSelect: event.prompt.multiSelect,
    } : undefined,
    handoffSpec: event.type === 'handoff_requested' ? event.handoffSpec : undefined,
  });

  const injectGuidancePatch = (message?: string): StatePatch[] | undefined => {
    if (!message) return undefined;
    return [{ op: 'inject_guidance', content: message }];
  };

  const runStopHook = async <D>(
    event: ControlEvent,
    ctx: HookContext,
    mapResult: (result: StopHookResult) => { decision: D; patches?: StatePatch[] }
  ): Promise<HookOutcome<D>> => {
    if (event.sessionKey !== sessionKey) {
      return { kind: 'skip', reason: 'session_mismatch' };
    }
    try {

### function_call
@callId call_1acf1bc7c671496394478b72
@name Read
@ts 1770351787690
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":1655,"endLine":1710}

### function_call
@callId call_bd71c7cabc0d49538565d6e0
@name Grep
@ts 1770351787690
@workItemId 4f83988a
{"path":"packages/harness-daemon/src/harness","pattern":"async.*mode|watcher.*async|runtime.*watcher"}

### function_call_output
@callId call_1acf1bc7c671496394478b72
@ts 1770351787716
@durationMs 17
@workItemId 4f83988a
// Lines 1655-1710 of 2731 total
        const result = await this.runOrchestrator(
          contextWindow,
          goal,
          requestId,
          emit,
          llmAdapter,
          effectiveAgentType,
          effectiveWorkingDir,
          effectivePlanMode,
          store,
          isResume ? undefined : hookRegistry
        );

        if (result.paused && result.userPrompt) {
          // Pausing for user input - emit response first (if any), then user prompt
          if (result.finalText) {
            eventQueue.push(
              createResponseEvent(
                requestId,
                true, // Partial success - got response before pause
                result.finalText,
                result.toolsUsed,
                result.durationMs,
                undefined,
                result.metadata
              )
            );
          }
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect,
            result.userPrompt.questionType,
            result.userPrompt.questions
          ));
        } else {
          // Execution completed (success or failure) - emit response event
          eventQueue.push(
            createResponseEvent(
              requestId,
              result.success,
              result.finalText,
              result.toolsUsed,
              result.durationMs,
              result.errorMessage,
              result.metadata
            )
          );
        }

        eventQueue.push(createStatusEvent('idle'));

        this.persistToGraphD(sessionKey, requestId, inputText, result.finalText, result.durationMs, userMessagePersisted);


### function_call_output
@callId call_bd71c7cabc0d49538565d6e0
@ts 1770351787716
@durationMs 19
@workItemId 4f83988a
packages/harness-daemon/src/harness/harness.watcher.test.ts:147:32:  it('passes memoryInjector to watcher Agent runtime', async () => {
packages/harness-daemon/src/harness/session_store.ts:163:11:  private asyncModeEnabled = false;
packages/harness-daemon/src/harness/session_store.ts:190:6:  setAsyncModeEnabled(enabled: boolean): void {
packages/harness-daemon/src/harness/session_store.ts:191:10:    this.asyncModeEnabled = enabled;
packages/harness-daemon/src/harness/session_store.ts:194:5:  isAsyncModeEnabled(): boolean {
packages/harness-daemon/src/harness/session_store.ts:195:17:    return this.asyncModeEnabled;
packages/harness-daemon/src/harness/bridge_gateway.ts:89:6:  getAsyncModeStatus?(): { ok: boolean; issues: string[] };
packages/harness-daemon/src/harness/bridge_gateway.ts:96:13:  setSessionAsyncModeEnabled?(sessionKey: string, enabled: boolean): void;
packages/harness-daemon/src/harness/bridge_gateway.ts:2042:11:    const asyncStatus = this.harness.getAsyncModeStatus?.();
packages/harness-daemon/src/harness/bridge_gateway.ts:2044:37:      this.sendError(connectionId, `Async mode is unavailable: ${asyncStatus.issues.join('; ')}`);
packages/harness-daemon/src/harness/bridge_gateway.ts:2049:120:      this.sendError(connectionId, 'Session is paused awaiting user input. Resume or close the session before starting async mode.');
packages/harness-daemon/src/harness/bridge_gateway.ts:2102:30:      this.harness.setSessionAsyncModeEnabled?.(sessionKey, true);
packages/harness-daemon/src/harness/bridge_gateway.ts:2113:32:        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
packages/harness-daemon/src/harness/bridge_gateway.ts:2132:78:        // NOT when it pauses for user input. Paused runs should resume with async mode still on.
packages/harness-daemon/src/harness/bridge_gateway.ts:2134:47:          // Run paused for user input - keep async mode enabled for resume
packages/harness-daemon/src/harness/bridge_gateway.ts:2149:32:        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
packages/harness-daemon/src/harness/bridge_gateway.ts:2163:30:      this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
packages/harness-daemon/src/harness/bridge_gateway.ts:2195:28:    this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
packages/harness-daemon/src/harness/harness.ts:584:11:  private asyncModeIssues: string[] = [];
packages/harness-daemon/src/harness/harness.ts:1073:13:  setSessionAsyncModeEnabled(sessionKey: string, enabled: boolean): void {
...[truncated at 20 results]

### function_call
@callId call_c2483fb64cc9490e81d3c084
@name Read
@ts 1770351790366
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":1070,"endLine":1100}

### function_call
@callId call_f328fea0100e444c89d44eed
@name Read
@ts 1770351790366
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":580,"endLine":620}

### function_call_output
@callId call_c2483fb64cc9490e81d3c084
@ts 1770351790807
@durationMs 434
@workItemId 4f83988a
// Lines 1070-1100 of 2731 total
    return !!state?.store.getPausedState();
  }

  setSessionAsyncModeEnabled(sessionKey: string, enabled: boolean): void {
    const store = this.getOrCreateSessionStore(sessionKey);
    store.setAsyncModeEnabled(enabled);
  }

  isSessionAsyncModeEnabled(sessionKey: string): boolean {
    const state = this.sessions.get(sessionKey);
    return state?.store.isAsyncModeEnabled() ?? false;
  }

  getAsyncModeStatus(): { ok: boolean; issues: string[] } {
    return { ok: this.asyncModeIssues.length === 0, issues: [...this.asyncModeIssues] };
  }

  resolveSessionEscalation(
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ): ResolveSessionEscalationResult {
    if (!this.isGraphDReady() || !this.graphd) {
      return {
        success: false,
        escalationId,
        error: 'GraphD not available',
      };
    }

    const result = this.graphd.sessionGet(sessionKey) as SessionGetResponse;

### function_call_output
@callId call_f328fea0100e444c89d44eed
@ts 1770351790807
@durationMs 430
@workItemId 4f83988a
// Lines 580-620 of 2731 total
  private entityGraph: EntityGraph | null = null;
  private memoryInjector: MemoryInjector | null = null;
  private traceSubscriber: TraceSubscriber | null = null;
  private memoryClient: SyncClient | null = null;
  private asyncModeIssues: string[] = [];

  constructor(config: FullHarnessConfig, logger?: HarnessLogger, orchestratorRunner?: OrchestratorRunner) {
    this.config = config;
    this.logger = logger ?? consoleLogger;
    this.sessionTtlMs = config.context.sessionTtlMs;
    this.pauseTimeoutMs = config.context.pauseTimeoutMs;

    // Gather environment context once at startup
    const envContext = gatherEnvironmentContext(config.tools.workingDir);
    this.agentRegistry = buildAgentRegistry(config, envContext);
    this.validateAsyncAgentSchemas();

    // Create provider key service for runtime API key resolution
    // This allows keys to be added/changed at runtime without restart
    const graphdDbPath = config.graphd.enabled ? config.graphd.dbPath : null;
    this.providerKeyService = new HarnessProviderKeyService(graphdDbPath, this.logger);

    // NOTE: We don't populate shared apiKeys/baseUrls here because:
    // 1. Multiple providers (cerebras, z.ai-coder, groq) map to the same canonical 'openai-compat'
    // 2. Keying by canonical provider causes last-writer-wins collision
    // 3. The providerKeyService will resolve API keys at request time
    // The adapter queries providerKeyService for keys when making requests
    const llmClientConfig: LLMClientConfig = {};

    // Adapt HarnessLogger to AdapterLogger (warning → warn)
    const adapterLogger = {
      debug: this.logger.debug.bind(this.logger),
      info: this.logger.info.bind(this.logger),
      warn: this.logger.warning.bind(this.logger),
      error: this.logger.error.bind(this.logger),
    };
    this.llmAdapter = createAdapter(llmClientConfig, adapterLogger, this.providerKeyService);

    // Create EventBus - central pub/sub for all events
    this.eventBus = new EventBus();


### function_call
@callId call_a98797a00cfd46b0810ff7ab
@name Read
@ts 1770351820375
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","startLine":1640,"endLine":1710}

### function_call_output
@callId call_a98797a00cfd46b0810ff7ab
@ts 1770351820595
@durationMs 215
@workItemId 4f83988a
// Lines 1640-1710 of 2731 total
            this.graphd!.sessionUpdateMetadata(sessionKey, {
              user_id: 'local-user',
              tier: effectiveAgentType,
              ...(selection ? { model: selection.model, provider: selection.provider } : {}),
            });
          } catch (error) {
            this.logger.warning('GraphD session metadata update failed', { error: String(error) });
          }
        }

        const llmAdapter = this.llmAdapter;

        // All requests go through orchestrator (loop-until-goal architecture)
        // Orchestrator handles interruptions internally via checkInterruption() callback
        // Note: hookRegistry only applies to fresh runs, not resumes
        const result = await this.runOrchestrator(
          contextWindow,
          goal,
          requestId,
          emit,
          llmAdapter,
          effectiveAgentType,
          effectiveWorkingDir,
          effectivePlanMode,
          store,
          isResume ? undefined : hookRegistry
        );

        if (result.paused && result.userPrompt) {
          // Pausing for user input - emit response first (if any), then user prompt
          if (result.finalText) {
            eventQueue.push(
              createResponseEvent(
                requestId,
                true, // Partial success - got response before pause
                result.finalText,
                result.toolsUsed,
                result.durationMs,
                undefined,
                result.metadata
              )
            );
          }
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect,
            result.userPrompt.questionType,
            result.userPrompt.questions
          ));
        } else {
          // Execution completed (success or failure) - emit response event
          eventQueue.push(
            createResponseEvent(
              requestId,
              result.success,
              result.finalText,
              result.toolsUsed,
              result.durationMs,
              result.errorMessage,
              result.metadata
            )
          );
        }

        eventQueue.push(createStatusEvent('idle'));

        this.persistToGraphD(sessionKey, requestId, inputText, result.finalText, result.durationMs, userMessagePersisted);


### function_call
@callId call_59e07af1471c40a79ca27f2d
@name Read
@ts 1770351838195
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":170,"endLine":230}

### function_call
@callId call_a73cc1ccfab74d3794b8203d
@name Grep
@ts 1770351838195
@workItemId 4f83988a
{"path":"packages/orchestrator/src/orchestrator.ts","pattern":"result\\.paused.*=|paused:.*true|result\\.userPrompt"}

### function_call_output
@callId call_59e07af1471c40a79ca27f2d
@ts 1770351838212
@durationMs 7
@workItemId 4f83988a
// Lines 170-230 of 2822 total
  maxDurationMs: 300_000, // 5 minutes
  hookTimeoutMs: 5000,
  compactTriggerPercent: 0.70,
  compactResetPercent: 0.7,
  compactMaxFileCount: 20,
  compactTruncateTo: 5000,
  minWatcherIterationGap: 5,
  maxRealigns: 3,
};

/**
 * Why orchestration terminated.
 * Re-exported from shared for backwards compatibility.
 */

/**
 * Orchestrator execution metrics.
 */
export interface OrchestratorMetrics {
  iterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
}

/**
 * Result from Orchestrator.execute().
 */
export interface OrchestratorResult {
  success: boolean;
  response: string;
  error?: string;
  paused: boolean;
  userPrompt?: UserPromptInfo;
  /** Handoff spec for planning → execution transition */
  handoffSpec?: HandoffSpec;
  terminationReason: TerminationReason;
  metrics: OrchestratorMetrics;
}

/**
 * Logger protocol.
 */
export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Plan mode options for read-only exploration.
 */
export interface PlanModeOptions {
  enabled: boolean;
  promptAddendum: string;
  toolFilter: (tools: string[]) => string[];
}

/**
 * Result of a termination condition check.

### function_call_output
@callId call_a73cc1ccfab74d3794b8203d
@ts 1770351838212
@durationMs 10
@workItemId 4f83988a
packages/orchestrator/src/orchestrator.ts:2331:34:    if (result.needsUserInput && result.userPrompt) {
packages/orchestrator/src/orchestrator.ts:2338:70:      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
packages/orchestrator/src/orchestrator.ts:2347:9:        result.userPrompt,
packages/orchestrator/src/orchestrator.ts:2361:11:          paused: true,
packages/orchestrator/src/orchestrator.ts:2362:23:          userPrompt: result.userPrompt,
packages/orchestrator/src/orchestrator.ts:2438:11:          paused: true,

### function_call
@callId call_e67b3a0f7fee4e9a9f7827dc
@name Read
@ts 1770351841012
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2330,"endLine":2380}

### function_call_output
@callId call_e67b3a0f7fee4e9a9f7827dc
@ts 1770351841481
@durationMs 465
@workItemId 4f83988a
// Lines 2330-2380 of 2822 total
    // ============================================================
    if (result.needsUserInput && result.userPrompt) {
      // Check for interruption - user message takes precedence over agent's question
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_input_required',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        result.userPrompt,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_input_required')) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response ?? '',
          paused: true,
          userPrompt: result.userPrompt,
          handoffSpec: result.handoffSpec,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Handoff requested
    // ============================================================
    if (result.needsHandoff && result.handoffSpec) {
      // Check for interruption - user message takes precedence over handoff
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts handoff request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }

### function_call
@callId call_14540805e93a42af9c6121ff
@name Read
@ts 1770351848489
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2060,"endLine":2180}

### function_call_output
@callId call_14540805e93a42af9c6121ff
@ts 1770351848509
@durationMs 6
@workItemId 4f83988a
// Lines 2060-2180 of 2822 total
      }
    } catch (err) {
      this.log('warning', 'Control hook error', { error: String(err), eventType: event.type });
      return null;
    }
  }

  /**
   * Handle hook "block" decision by re-injecting prompt and continuing.
   * Also enqueues any deferred work items from the hook result.
   * Returns true if loop should continue, false if termination should proceed.
   *
   * @param stopResult - The hook result (stop-style)
   * @param context - The context window
   * @param agentType - The agent type
   * @param iteration - Current iteration number
   * @param terminationReason - The reason for termination (used to differentiate handling)
   */
  private handleStopHookBlock(
    stopResult: StopHookResult | null,
    context: ContextWindow,
    agentType: string,
    iteration: number,
    terminationReason?: TerminationReason
  ): boolean {
    if (!stopResult) return false;

    // Enqueue deferred work regardless of decision (block or allow)
    const queueSizeBefore = this.workQueue.length;
    this.enqueueDeferredWork(stopResult);
    const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

    // CRITICAL: If deferred work was enqueued, we must continue even if decision is 'allow'
    // This ensures work items from watcher are actually executed
    // Also reset realign counter since splitting work is progress
    if (deferredWorkAdded) {
      this.realignCount = 0; // Reset - splitting work is progress
      this.log('info', 'Deferred work added, resetting realign counter', {
        iteration,
        terminationReason,
        newItems: this.workQueue.length - queueSizeBefore,
        decision: stopResult.decision,
      });
      if (stopResult.decision !== 'block') {
        return true; // Signal to continue, even though it's not a 'block'
      }
    }

    if (stopResult.decision !== 'block' || !stopResult.reason) {
      return false;
    }

    this.log('info', 'Control hook blocked termination, re-injecting prompt', {
      iteration,
      terminationReason,
      promptPreview: stopResult.reason.slice(0, 100),
    });

    // For user_input_required: the watcher answered the question.
    // Inject the answer as a USER message (simulating user response),
    // not as a new goal. This preserves the conversational flow.
    if (terminationReason === 'user_input_required') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The watcher's answer goes as a user message (like a human would respond)
      context.addMessage('user', stopResult.reason);
      // Continue with a generic goal - the answer is now in context
      const newItem = this.createWorkItem('Continue with the provided answer', agentType);
      this.enqueue(newItem);
      this.completedWork.delete(this.initialWorkId);
      this.initialWorkId = newItem.workId;
      return true;
    }

    // For handoff_requested: the watcher rejected the plan.
    // Inject the rejection message into context so the planner can revise.
    // Re-enqueue the work item so it can execute again with fresh agent state.
    if (terminationReason === 'handoff_requested') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The rejection goes as a user message
      context.addMessage('user', stopResult.reason);
      // Re-enqueue the work item (do NOT create a new one or reset initialWorkId)
      // The planner will revise the plan on the same work item
      return true;
    }

    // For bounds_exceeded: track realign count and enforce limit to prevent infinite loops
    // Check both orchestrator-level and agent-level termination reasons
    const boundsReasons = ['max_iterations_exceeded', 'max_tool_calls_exceeded', 'max_duration_exceeded'];
    const isBoundsExceeded = boundsReasons.includes(terminationReason ?? '');

    if (isBoundsExceeded) {
      this.realignCount++;
      this.log('info', 'Realign count incremented for bounds exceeded', {
        realignCount: this.realignCount,
        maxRealigns: this.config.maxRealigns,
        terminationReason,
      });

      if (this.realignCount > this.config.maxRealigns) {
        this.log('warning', 'Max realigns exceeded, forcing termination', {
          realignCount: this.realignCount,
          terminationReason,
        });
        // Don't continue - force termination
        return false;
      }
    }

    // Default handling for other termination reasons (Ralph Loop, bounds exceeded, etc.)
    // The reason becomes the new work item's goal
    if (stopResult.systemMessage) {
      context.addMessage('system', stopResult.systemMessage);
    }

    const newItem = this.createWorkItem(stopResult.reason, agentType);
    this.enqueue(newItem);
    this.completedWork.delete(this.initialWorkId);

### function_call
@callId call_5cdf79a631c54d28a0b400d9
@name Read
@ts 1770351852750
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2460,"endLine":2520}

### function_call_output
@callId call_5cdf79a631c54d28a0b400d9
@ts 1770351852766
@durationMs 10
@workItemId 4f83988a
// Lines 2460-2520 of 2822 total
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'refusal')) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, 'refusal', 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.response,
          terminationReason: 'refusal',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: User stopped (explicit "stop" from user)
    // ============================================================
    if (result.terminationReason === 'user_stopped') {
      this.log('info', 'User stopped execution', { workId });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_stopped',
        result.response || '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_stopped')) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response || 'Execution stopped by user.',
          terminationReason: 'user_stopped',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Watcher stopped (mid-agent cadence check intervention)
    // ============================================================
    if (result.terminationReason === 'watcher_stopped') {

### function_call
@callId call_e1cc628c3a784218837ab1bf
@name Read
@ts 1770351863958
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":1810,"endLine":1920}

### function_call_output
@callId call_e1cc628c3a784218837ab1bf
@ts 1770351863983
@durationMs 15
@workItemId 4f83988a
// Lines 1810-1920 of 2822 total
  private createControlEvent(params: {
    terminationReason: TerminationReason;
    context: ContextWindow;
    workId: string;
    response: string;
    metrics: ExecutionMetrics;
    userPrompt?: UserPromptInfo;
    agentResult?: AgentResult;
    cadence?: { elapsedMs: number; toolCallsSinceLastAudit: number; recentActivity: string; workIds?: string[] };
    controlEventType?: 'goal_state_reached' | 'work_item_completed';
  }): ControlEvent | null {
    const { terminationReason, context, workId, response, metrics, userPrompt, agentResult, cadence, controlEventType } = params;

    switch (terminationReason) {
      case 'goal_state_reached': {
        if (controlEventType === 'work_item_completed') {
          return createWorkItemCompletedEvent(
            context.sessionKey,
            workId,
            agentResult?.success ?? true,
            response,
            metrics.filesModified,
            metrics,
            terminationReason
          );
        }
        const artifacts = agentResult?.artifacts?.map(a => ({
          type: 'data' as const,
          path: a.sourcePath,
          description: a.insight ?? a.name,
        }));
        return createGoalReachedEvent(
          context.sessionKey,
          workId,
          response,
          metrics.filesModified,
          metrics,
          artifacts
        );
      }
      case 'max_iterations_exceeded':
      case 'max_tool_calls_exceeded':
      case 'max_duration_exceeded': {
        const boundType = terminationReason === 'max_iterations_exceeded'
          ? 'iterations'
          : terminationReason === 'max_tool_calls_exceeded'
            ? 'tool_calls'
            : 'duration';
        const limit = terminationReason === 'max_iterations_exceeded'
          ? this.config.maxIterations
          : terminationReason === 'max_tool_calls_exceeded'
            ? this.config.maxToolCalls
            : this.config.maxDurationMs;
        const current = terminationReason === 'max_iterations_exceeded'
          ? metrics.iterationCount
          : terminationReason === 'max_tool_calls_exceeded'
            ? metrics.toolCallsMade
            : metrics.durationMs;
        return createBoundsExceededEvent(
          context.sessionKey,
          workId,
          boundType,
          limit,
          current,
          response,
          metrics
        );
      }
      case 'user_input_required': {
        if (!userPrompt) return null;
        const options = userPrompt.options?.map(option => {
          if (typeof option === 'string') {
            return { label: option };
          }
          return { label: option.label, description: option.description };
        });
        return createUserInputRequiredEvent(
          context.sessionKey,
          workId,
          userPrompt.question,
          options,
          userPrompt.context,
          userPrompt.multiSelect ?? false
        );
      }
      case 'cadence_audit': {
        if (!cadence) return null;
        return createCadenceAuditEvent(
          context.sessionKey,
          workId,
          cadence.elapsedMs,
          cadence.toolCallsSinceLastAudit,
          metrics,
          cadence.recentActivity,
          cadence.workIds
        );
      }
      case 'agent_error':
      case 'invalid_action':
      case 'no_action':
      case 'stagnation': {
        const errorType = terminationReason === 'agent_error'
          ? 'exception'
          : terminationReason;
        return createAgentErrorEvent(
          context.sessionKey,
          workId,
          errorType,
          agentResult?.error ?? response ?? terminationReason,
          metrics,
          undefined

### function_call
@callId call_588ecb539edb4518a51ec19a
@name Read
@ts 1770351873086
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/bridge_gateway.ts","startLine":580,"endLine":680}

### function_call_output
@callId call_588ecb539edb4518a51ec19a
@ts 1770351873093
@durationMs 3
@workItemId 4f83988a
// Lines 580-680 of 2444 total
        this.sessionOwners.delete(state.sessionKey);
      }
      if (graphd) {
        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
      }
      this.harness.closeSession?.(state.sessionKey);
    }

    // Take ownership of the new session
    this.sessionOwners.set(sessionKey, connectionId);

    state.sessionKey = sessionKey;
    state.lastSessionKey = sessionKey;  // Track for disconnect cleanup

    // Store working directory from client (where TUI was launched)
    const requestedWorkingDir = data?.working_dir;
    state.workingDir =
      typeof requestedWorkingDir === 'string' && requestedWorkingDir.length > 0
        ? requestedWorkingDir
        : this.workingDir; // fallback to daemon's working dir

    // Touch session to update last_accessed_at (reactivates inactive sessions)
    // Also sets status to 'active' for the new session
    if (graphd) {
      graphd.sessionTouch(sessionKey, state.workingDir);
      graphd.sessionUpdateStatus(sessionKey, 'active');
    }

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir: state.workingDir ?? this.workingDir,
      includeUserPreferences: true,
    });

    const readyEvent = this.harness.createReadyEvent(sessionKey);
    this.sendEvent(connectionId, readyEvent, sessionChannel(sessionKey));

    // Load and emit per-agent-type model selections if available
    if (graphd) {
      // Send persisted selections directly to this connection to avoid session-channel races
      const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      const selectionsObject: Record<string, { provider?: string; model?: string; reasoning?: string }> = {};
      for (const [type, selection] of selections) {
        selectionsObject[type] = selection;
      }
      this.sendAuthResponse(connectionId, 'get_model', {
        success: true,
        model_selections: selectionsObject,
      });

      // Emit model_changed for all agent types with persisted selections
      const allSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      const agentTypes = ['standard', 'explorer', 'coding'];
      for (const agentType of agentTypes) {
        const selection = allSelections.get(agentType) ?? null;
        this.sendEvent(connectionId, {
          type: 'model_changed',
          data: {
            agentType,
            selectedModel: selection?.model ?? null,
            selectedProvider: selection?.provider ?? null,
            provider: selection?.provider ?? null,
            model: selection?.model ?? null,
            reasoning: selection?.reasoning ?? null,
          },
        }, sessionChannel(sessionKey));
      }
    } else {
      // No GraphD - emit null selections for all agent types
      const agentTypes = ['standard', 'explorer', 'coding'];
      for (const agentType of agentTypes) {
        this.sendEvent(connectionId, {
          type: 'model_changed',
          data: {
            agentType,
            selectedModel: null,
            selectedProvider: null,
            provider: null,
            model: null,
            reasoning: null,
          },
        }, sessionChannel(sessionKey));
      }
    }
  }

  private handleSendText(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    profiler.begin('handleSendText', 'handler');
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      profiler.end('handleSendText', 'handler');
      return;
    }

    // Per-request working_dir takes precedence over init-time state, which takes precedence over daemon default
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir

### function_call
@callId call_127765de6e5f4130bb28de9a
@name Read
@ts 1770351875609
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/bridge_gateway.ts","startLine":680,"endLine":800}

### function_call_output
@callId call_127765de6e5f4130bb28de9a
@ts 1770351875620
@durationMs 7
@workItemId 4f83988a
// Lines 680-800 of 2444 total
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir,
      includeUserPreferences: true,
    });

    // Check 'standard' agent type selection - this is the main/default that must be set
    let activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
      if (!activeSelection?.model || !activeSelection?.provider) {
        this.sendError(connectionId, 'No model selected. Use /models to choose one before sending a message.');
        return;
      }
    }
    if (!this.harness.hasApiKey(activeSelection.provider)) {
      this.sendEvent(connectionId, {
        type: 'provider_key_required',
        data: {
          provider: activeSelection.provider,
          model: activeSelection.model,
          reasoning: activeSelection.reasoning,
        },
      });
      this.sendError(connectionId, `No API key configured for provider: ${activeSelection.provider}`);
      return;
    }

    const text = String(data?.text ?? '');
    if (!text.trim()) {
      this.sendError(connectionId, 'Empty message');
      return;
    }

    // Set goal from first user message (no-op if goal already set)
    const graphd = this.harness.getGraphD?.();
    if (graphd) {
      const goalPreview = text.trim().slice(0, 500);
      graphd.sessionSetGoalIfEmpty(sessionKey, goalPreview);
    }

    const candidateRequestId =
      typeof data?.client_request_id === 'string' ? data.client_request_id : '';
    const clientRequestId = candidateRequestId.length > 0
      ? candidateRequestId
      : generateRequestId();
    const rawTier = typeof data?.tier === 'string' ? data.tier.trim() : '';
    const tier = rawTier && rawTier !== 'auto' ? (rawTier as AgentType) : undefined;

    // Extract planMode from command data
    const planMode = typeof data?.plan_mode === 'boolean' ? data.plan_mode : state.planMode;
    state.planMode = planMode;

    state.activeRequestId = clientRequestId;

    profiler.instant('harness.run:start', 'harness', 'p', { requestId: clientRequestId, tier });
    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      ...(tier ? { tier } : {}),
      sessionKey,
      workingDir,
      planMode,
    });

    this.streamRunEvents(clientRequestId, handle, undefined, sessionKey);
    profiler.end('handleSendText', 'handler');
  }

  private handleUserPromptResponse(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized.');
      return;
    }

    // Per-request working_dir takes precedence (same pattern as handleSendText)
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

    const requestId = String(data?.request_id ?? state.activeRequestId ?? '');
    const answer = data?.answer ?? data?.response;
    if (!requestId) {
      this.sendError(connectionId, 'Missing request_id');
      return;
    }
    if (answer === undefined || answer === null || answer === '') {
      this.sendError(connectionId, 'Empty answer');
      return;
    }

    // Convert answer to string - run() will detect paused state and treat it as a resume
    const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
    const handle = this.harness.run({
      requestId,
      inputText: answerText,
      sessionKey,
      workingDir,
    });
    this.streamRunEvents(requestId, handle, undefined, sessionKey);
  }

  private handleGetConfig(connectionId: string, state: ConnectionState): void {
    const config = this.harness.getConfig();
    const defaultAgent = config.agents[config.defaultAgent];

    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {

### function_call
@callId call_19523a92630a4c639c713deb
@name Read
@ts 1770351884077
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":1800,"endLine":1900}

### function_call_output
@callId call_19523a92630a4c639c713deb
@ts 1770351884098
@durationMs 7
@workItemId 4f83988a
// Lines 1800-1900 of 2634 total
        messages.push(item);
        functionOutputCount++;
      }
    }

    return messages;
  }

  /**
   * Add assistant message to context.
   */
  private addAssistantMessage(
    context: ContextWindow,
    content: string,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    workItemId?: string
  ): void {
    if (toolCalls.length > 0) {
      if (content) {
        context.addMessage('assistant', content, workItemId);
      }
      for (const tc of toolCalls) {
        context.appendItem({
          type: 'function_call',
          callId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          timestamp: Date.now(),
          workItemId,
        });
      }
    } else {
      context.addMessage('assistant', content, workItemId);
    }
  }

  /**
   * Process tool calls.
   */
  private async processToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    globalContext: ContextWindow,
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    workItem: WorkItem,
    cwd: string,
    workItemId?: string,
    toolRepeatState?: { lastKey: string; lastOutput: string; repeats: number }
  ): Promise<void> {
    const mq = createMicroQueue();
    const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
    const itemWorkId = workItemId ?? workItem.workId;

    // Build a map from lowercase names to canonical names for case-insensitive lookup
    const canonicalNames = new Map<string, string>();
    for (const toolName of this.config.tools) {
      canonicalNames.set(toolName.toLowerCase(), toolName);
    }
    const pendingParallel: Array<{
      call: { id: string; name: string; arguments: Record<string, unknown> };
      promise: Promise<{ toolResult: ToolResult; toolDurationMs: number }>;
    }> = [];

    const invalidatePath = (pathValue: unknown): void => {
      if (typeof pathValue !== 'string' || pathValue.length === 0) {
        return;
      }
      result.invalidatedPaths.push(pathValue);
      localReadFiles.delete(pathValue);
      localContext.invalidateFileContent(pathValue);
    };

    const handleToolResult = (
      call: { id: string; name: string; arguments: Record<string, unknown> },
      toolResult: ToolResult,
      toolDurationMs: number,
      isAgentTool: boolean
    ): boolean => {
      if (toolResult.isSuccess) {
        metrics.toolCallsSucceeded++;

        const nameLower = call.name.toLowerCase();
        if (nameLower === 'read') {
          const readPath = call.arguments.path ?? call.arguments.file_path;
          if (typeof readPath === 'string') {
            localReadFiles.add(readPath);
            if (!localContext.hasReadFile(readPath)) {
              const rawOutput = toolResult.output ?? '';
              localContext.addFileContent(readPath, truncateToolOutput(rawOutput, call.name), undefined, workItem.workId);
            }
          }
        }

        if (nameLower === 'write' || nameLower === 'edit') {
          invalidatePath(call.arguments.path ?? call.arguments.file_path);
        } else if (nameLower === 'batchedit') {
          const edits = call.arguments.edits;
          if (Array.isArray(edits)) {
            for (const edit of edits) {

### function_call
@callId call_bf2043e12e2347189a9670cc
@name Read
@ts 1770351886725
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","startLine":1450,"endLine":1500}

### function_call_output
@callId call_bf2043e12e2347189a9670cc
@ts 1770351886743
@durationMs 8
@workItemId 4f83988a
// Lines 1450-1500 of 2634 total
    }

    switch (terminationReason) {
      case 'user_input_required': {
        if (!result.userPrompt) {
          throw new Error('AgentResult invariant violation: user_input_required without userPrompt');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: true,
          userPrompt: result.userPrompt,
          needsHandoff: false,
          isRefusal: false,
        };
      }
      case 'handoff_requested': {
        if (!result.handoffSpec) {
          throw new Error('AgentResult invariant violation: handoff_requested without handoffSpec');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: true,
          handoffSpec: result.handoffSpec,
          isRefusal: false,
        };
      }
      case 'refusal': {
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: false,
          isRefusal: true,
        };
      }
      case 'rate_limit': {
        if (!result.rateLimitInfo) {
          throw new Error('AgentResult invariant violation: rate_limit without rateLimitInfo');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: false,
          isRefusal: false,
          rateLimitInfo: result.rateLimitInfo,
        };
      }

### function_call
@callId call_86ff9ec5dc4b47229f063ff1
@name Read
@ts 1770351901580
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2330,"endLine":2410}

### function_call
@callId call_9d62d212141f4a609fd7d452
@name Grep
@ts 1770351901580
@workItemId 4f83988a
{"path":"packages/orchestrator/src","pattern":"createInterruptionResult"}

### function_call_output
@callId call_86ff9ec5dc4b47229f063ff1
@ts 1770351901605
@durationMs 15
@workItemId 4f83988a
// Lines 2330-2410 of 2822 total
    // ============================================================
    if (result.needsUserInput && result.userPrompt) {
      // Check for interruption - user message takes precedence over agent's question
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_input_required',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        result.userPrompt,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_input_required')) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response ?? '',
          paused: true,
          userPrompt: result.userPrompt,
          handoffSpec: result.handoffSpec,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Handoff requested
    // ============================================================
    if (result.needsHandoff && result.handoffSpec) {
      // Check for interruption - user message takes precedence over handoff
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts handoff request', { iteration, workId });
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      const specLength = JSON.stringify(result.handoffSpec).length;
      this.log('info', 'Handoff requested - checking approval', { workId, specLength });
      this.mergeAgentResultContext(context, workId, result);

      // Call stop hook for approval (watcher in async mode, or no-op in sync mode)
      const stopResult = await this.callStopHook(
        context,
        'handoff_requested',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );

      // If stop hook blocks, the watcher rejected the plan - planner should revise
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'handoff_requested')) {
        // Re-enqueue the same work item so the planner can revise
        return { terminal: null, shouldContinue: true, itemToRequeue: item };
      }

      // Stop hook allowed - check if watcher approved (has stop hook registered)
      // If a stop hook is registered and returned 'allow', the watcher approved the plan
      // Parse the spec and enqueue work items
      if (stopResult && stopResult.decision === 'allow') {

### function_call_output
@callId call_9d62d212141f4a609fd7d452
@ts 1770351901605
@durationMs 10
@workItemId 4f83988a
packages/orchestrator/src/orchestrator.ts:1695:11:  private createInterruptionResult(agentType: string): TerminationCheckResult {
packages/orchestrator/src/orchestrator.ts:2336:21:        return this.createInterruptionResult(agentType);
packages/orchestrator/src/orchestrator.ts:2379:21:        return this.createInterruptionResult(agentType);

### function_call
@callId call_4e70e0a27fbe4f978307ee55
@name Read
@ts 1770351924530
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/decision-watcher/src/watcher-agent.ts","startLine":990,"endLine":1040}

### function_call_output
@callId call_4e70e0a27fbe4f978307ee55
@ts 1770351924541
@durationMs 7
@workItemId 4f83988a
// Lines 990-1040 of 2144 total
  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
    ...(await getInlineSessionContext(config, getEventWorkId(ctx.event))),
  });

  const action = await runAndLog(config, 'prompt_user', objective, ctx);

  // Log decision to workitem (scoped) in addition to global decision log
  if (workItemLog && action.watcherAction === 'answer') {
    await workItemLog.appendDecision(
      'prompt_user',
      action.watcherAction,
      action.reason,
      questionText,
      action.answer.text
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'answer') {
    return {
      decision: {
        action: 'answer',
        text: action.answer.text,
        confidence: 0.7,
        contextAddendum: action.answer.contextAddendum,
      },
    };
  }

  // Watcher failed to provide a proper 'answer' action.
  // Check if the watcher's reason contains useful guidance we can use as an answer.
  const watcherReason = action.reason;
  const hasUsefulReason = watcherReason.length > 20 &&
    !watcherReason.includes('timeout') &&
    !watcherReason.includes('error') &&
    !watcherReason.includes('fallback');

  // If watcher produced reasoning that looks like an actual answer, use it
  if (hasUsefulReason) {
    console.warn(`[WATCHER] prompt_user: Watcher returned "${action.watcherAction}" instead of "answer", but has useful reason. Using reason as answer.`);
    return {
      decision: {
        action: 'answer',
        text: watcherReason,
        confidence: 0.5,

### function_call
@callId call_73f6edcd77ea44489efb28b3
@name Read
@ts 1770351932103
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","startLine":2630,"endLine":2740}

### function_call_output
@callId call_73f6edcd77ea44489efb28b3
@ts 1770351932112
@durationMs 5
@workItemId 4f83988a
// Lines 2630-2740 of 2822 total
              shouldContinue: true,
              newItem: this.createWorkItem(stopResult.reason, agentType),
            };
          }
        }
      }

      // No stop hook or hook allowed termination - map to appropriate orchestrator reason
      this.emitGoalNotAchieved(goal, result.error || reason, 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error || reason,
          terminationReason: reason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // AGENT BOUNDS EXCEEDED: Map agent-level bounds to orchestrator-level
    // ============================================================
    if (result.terminationReason === 'max_iterations_exceeded' ||
        result.terminationReason === 'max_tool_calls_exceeded' ||
        result.terminationReason === 'max_duration_exceeded') {
      const orchReason = result.terminationReason;
      this.log('warning', `Agent bounds exceeded: ${orchReason}`, { workId });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        orchReason,
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, orchReason)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: !!result.response,
          response: result.response || `Agent terminated: ${result.terminationReason}`,
          terminationReason: orchReason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: rate_limit, circuit_open - transient errors that must stop
    // ============================================================
    if (result.terminationReason === 'rate_limit' || result.terminationReason === 'circuit_open') {
      this.log('warning', `Agent ${result.terminationReason}`, { workId });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        result.terminationReason,
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, result.terminationReason as TerminationReason)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response || `Execution stopped: ${result.terminationReason}`,
          error: result.terminationReason,
          terminationReason: result.terminationReason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: timeout - transient errors that must stop
    // ============================================================
    if (result.terminationReason === 'timeout') {
      this.log('warning', 'Agent timeout', { workId, error: result.error });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'timeout',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,

### function_call
@callId call_6496ed7bf7c14cbf9457e374
@name Read
@ts 1770351940387
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/protocol/src/control/decisions.ts","startLine":1,"endLine":150}

### function_call
@callId call_cbfd4fa830d54f7b98db9617
@name Grep
@ts 1770351940387
@workItemId 4f83988a
{"path":"packages/protocol/src/control","pattern":"StopHookDecision|StopHookResult|block|allow"}

### function_call_output
@callId call_6496ed7bf7c14cbf9457e374
@ts 1770351940624
@durationMs 16
@workItemId 4f83988a
// Lines 1-150 of 250 total
/**
 * Decision Types - Discriminated Unions
 *
 * Each hook trigger has its own decision type.
 * These are the domain-specific outcomes that hooks produce.
 */

import type { WorkItemSpec } from '../domain/state.js';
import { assertNever } from '../assertNever.js';

// ============================================
// QUALITY GATE (goal_state_reached, work_item_completed)
// ============================================

/**
 * Decision for quality gate evaluation.
 * Determines whether the agent's work meets quality standards.
 */
export type QualityGateDecision =
  | { verdict: 'passed' }
  | { verdict: 'failed'; issues: string[] }
  | { verdict: 'needs_human'; concerns: string[] };

/**
 * Type guard for passed quality gate.
 */
export function isQualityPassed(d: QualityGateDecision): d is { verdict: 'passed' } {
  return d.verdict === 'passed';
}

/**
 * Type guard for failed quality gate.
 */
export function isQualityFailed(d: QualityGateDecision): d is { verdict: 'failed'; issues: string[] } {
  return d.verdict === 'failed';
}

// ============================================
// BOUNDS EXCEEDED (max_iterations, max_tool_calls, max_duration)
// ============================================

/**
 * Decision for bounds exceeded scenarios.
 * Determines how to handle resource limits being hit.
 */
export type BoundsDecision =
  | { action: 'realign'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'wrap_up'; summary: string }
  | { action: 'abort'; reason: string };

/**
 * Type guard for realign action.
 */
export function isBoundsRealign(d: BoundsDecision): d is { action: 'realign'; guidance: string } {
  return d.action === 'realign';
}

/**
 * Type guard for split action.
 */
export function isBoundsSplit(d: BoundsDecision): d is { action: 'split'; workItems: WorkItemSpec[] } {
  return d.action === 'split';
}

// ============================================
// PROMPT ANSWER (user_input_required)
// ============================================

/**
 * Decision for user input prompts.
 * Determines how to answer when the agent asks for user input.
 */
export type PromptAnswerDecision =
  | { action: 'answer'; text: string; confidence: number; contextAddendum?: string }
  | { action: 'escalate'; reason: string }
  | { action: 'defer'; to: 'user' | 'ops' };

/**
 * Type guard for answer action.
 */
export function isPromptAnswer(d: PromptAnswerDecision): d is { action: 'answer'; text: string; confidence: number; contextAddendum?: string } {
  return d.action === 'answer';
}

// ============================================
// CADENCE AUDIT (periodic check)
// ============================================

/**
 * Decision for cadence audit.
 * Periodic oversight of agent progress.
 */
export type CadenceDecision =
  | { action: 'continue' }
  | { action: 'inject_guidance'; message: string }
  | { action: 'realign'; guidance: string; newWork?: WorkItemSpec }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'stop'; reason: string }
  | { action: 'stop_work_item'; reason: string; escalationId?: string };

/**
 * Type guard for continue action.
 */
export function isCadenceContinue(d: CadenceDecision): d is { action: 'continue' } {
  return d.action === 'continue';
}

/**
 * Type guard for stop action.
 */
export function isCadenceStop(d: CadenceDecision): d is { action: 'stop'; reason: string } {
  return d.action === 'stop';
}

/**
 * Type guard for stop_work_item action.
 */
export function isCadenceStopWorkItem(
  d: CadenceDecision
): d is { action: 'stop_work_item'; reason: string; escalationId?: string } {
  return d.action === 'stop_work_item';
}

// ============================================
// AGENT ERROR (agent_error, invalid_action, no_action, stagnation)
// ============================================

/**
 * Decision for agent errors.
 * Determines how to handle agent misbehavior.
 */
export type AgentErrorDecision =
  | { action: 'retry'; guidance: string }
  | { action: 'abort'; reason: string }
  | { action: 'escalate'; to: 'user' | 'ops' };

/**
 * Type guard for retry action.
 */
export function isErrorRetry(d: AgentErrorDecision): d is { action: 'retry'; guidance: string } {
  return d.action === 'retry';
}

// ============================================
// HANDOFF APPROVAL (planner handoff)
// ============================================

/**
 * Decision for handoff approval.

### function_call_output
@callId call_cbfd4fa830d54f7b98db9617
@ts 1770351940624
@durationMs 229
@workItemId 4f83988a
packages/protocol/src/control/gates.ts:47:50:  'user_stopped': never;  // No decision, always allow
packages/protocol/src/control/gates.ts:48:53:  'transient_error': never;  // No decision, always allow

### function_call
@callId call_065afe8ef6124a4d9f972327
@name Read
@ts 1770351946675
@workItemId 4f83988a
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/protocol/src/control/gates.ts","startLine":1,"endLine":150}

### function_call_output
@callId call_065afe8ef6124a4d9f972327
@ts 1770351946896
@durationMs 214
@workItemId 4f83988a
// Lines 1-150 of 182 total
/**
 * Event → Decision Mapping
 *
 * Maps event types to their decision types.
 * Used for type-safe hook registration.
 */

import type { ControlEvent, ControlEventType } from '../domain/events.js';
import type {
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  CadenceDecision,
  AgentErrorDecision,
  HandoffDecision,
  WorkItemCompletedDecision,
} from './decisions.js';
import type {
  QualityGateDecisionSchemaType,
  BoundsDecisionSchemaType,
  PromptAnswerDecisionSchemaType,
  CadenceDecisionSchemaType,
  AgentErrorDecisionSchemaType,
  HandoffDecisionSchemaType,
  WorkItemCompletedDecisionSchemaType,
} from '../protocol/schemas.js';
import type { Hook } from '../hooks/types.js';
import { assertNever } from '../assertNever.js';
import { controlField, type ControlField } from 'prompt-protocol';

// ============================================
// EVENT → DECISION TYPE MAP
// ============================================

/**
 * Maps event types to their decision types.
 * Used for type-safe hook registration.
 */
export interface EventDecisionMap {
  'goal_state_reached': QualityGateDecision;
  'bounds_exceeded': BoundsDecision;
  'user_input_required': PromptAnswerDecision;
  'cadence_audit': CadenceDecision;
  'agent_error': AgentErrorDecision;
  'handoff_requested': HandoffDecision;
  'work_item_completed': WorkItemCompletedDecision;
  'user_stopped': never;  // No decision, always allow
  'transient_error': never;  // No decision, always allow
  'escalation_resolved': never;  // No decision - this IS the resolution from human
}

/**
 * Extract the decision type for a given event type.
 */
export type DecisionFor<E extends ControlEventType> = EventDecisionMap[E];

/**
 * Extract the event for a given event type.
 */
export type EventFor<E extends ControlEventType> = {
  [K in ControlEventType]: Extract<ControlEvent, { type: K }>;
}[E];

// ============================================
// TYPE-SAFE HOOK CREATION
// ============================================

/**
 * Type-safe hook creation that ensures decision type matches event type.
 */
export function createHook<E extends keyof EventDecisionMap>(
  event: E,
  config: Omit<Hook<EventFor<E>, EventDecisionMap[E]>, 'event'>
): Hook<EventFor<E>, EventDecisionMap[E]> {
  return { ...config, event } as Hook<EventFor<E>, EventDecisionMap[E]>;
}

// ============================================
// DECISION REQUIREMENTS
// ============================================

/**
 * Events that don't require a decision (pass through).
 */
export type PassThroughEvent = Extract<ControlEventType, 'user_stopped' | 'transient_error' | 'escalation_resolved'>;

/**
 * Events that require a decision (have hooks).
 */
export type DecisionRequiredEvent = Exclude<ControlEventType, PassThroughEvent>;

/**
 * Check if an event type requires a decision.
 */
export function requiresDecision(eventType: ControlEventType): eventType is DecisionRequiredEvent {
  switch (eventType) {
    case 'goal_state_reached':
    case 'bounds_exceeded':
    case 'user_input_required':
    case 'cadence_audit':
    case 'agent_error':
    case 'handoff_requested':
    case 'work_item_completed':
      return true;
    case 'user_stopped':
    case 'transient_error':
    case 'escalation_resolved':
      return false;
    default:
      return assertNever(eventType);
  }
}

// ============================================
// VALID ACTIONS BY EVENT
// ============================================

/**
 * Valid decision actions for each event type.
 * Prevents invalid decisions from being created.
 */
export type DecisionActionByEvent = {
  goal_state_reached: QualityGateDecisionSchemaType['verdict'];
  bounds_exceeded: BoundsDecisionSchemaType['action'];
  user_input_required: PromptAnswerDecisionSchemaType['action'];
  cadence_audit: CadenceDecisionSchemaType['action'];
  agent_error: AgentErrorDecisionSchemaType['action'];
  handoff_requested: HandoffDecisionSchemaType['action'];
  work_item_completed: WorkItemCompletedDecisionSchemaType['action'];
};

export const VALID_DECISIONS_BY_EVENT = {
  'goal_state_reached': ['passed', 'failed', 'needs_human'],
  'bounds_exceeded': ['realign', 'split', 'wrap_up', 'abort'],
  'user_input_required': ['answer', 'escalate', 'defer'],
  'cadence_audit': ['continue', 'inject_guidance', 'realign', 'split', 'stop', 'stop_work_item'],
  'agent_error': ['retry', 'abort', 'escalate'],
  'handoff_requested': ['approve', 'reject', 'modify'],
  'work_item_completed': ['accept', 'retry', 'split', 'escalate'],
} as const satisfies {
  [E in keyof DecisionActionByEvent]: readonly DecisionActionByEvent[E][];
};

// ============================================
// PROMPT-PROTOCOL CONTROLS
// ============================================

/**
 * Control fields used by decision prompts.
 */

### message:assistant
@ts 1770351987989
<tool_call>Read<arg_key>path</arg_key><arg_value>/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts</arg_value><arg_key>startLine</arg_key><arg_value>1490</arg_value><arg_key>endLine</arg_key><arg_value>1530</arg_value></tool_call>
