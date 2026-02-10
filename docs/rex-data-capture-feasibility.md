# Rex Data Capture Feasibility Analysis

> Can we actually capture the data we need from Claude Code?

## TL;DR

**Yes, but through 3 separate mechanisms — not one unified API.** The capture surface is broader than expected, but fragmented. Each mechanism has tradeoffs. The architecture needs to compose all three, not bet on one.

---

## The Three Capture Surfaces

### 1. Hooks (Real-time, Structured, Per-Event)

Claude Code fires synchronous hooks at well-defined lifecycle points. A hook receives JSON on stdin and can respond with allow/block/modify.

**Available Hook Events:**

| Event | What It Captures | Real-time | Can Block? |
|-------|-----------------|-----------|------------|
| `PreToolUse` | Tool name, arguments, tool_use_id | Yes | Yes |
| `PostToolUse` | Tool name, arguments, result, tool_use_id | Yes | No |
| `PostToolUseFailure` | Tool name, arguments, error, is_interrupt | Yes | No |
| `UserPromptSubmit` | User's prompt text | Yes | Yes |
| `SessionStart` | Source (startup/resume/clear/compact), model | Yes | No |
| `SessionEnd` | Reason (clear/logout/exit/other) | Yes | No |
| `PermissionRequest` | Tool name, input, permission suggestions | Yes | Yes |
| `Notification` | Message, title, notification_type | Yes | No |
| `SubagentStart` | agent_id, agent_type | Yes | No |
| `SubagentStop` | agent_id, agent_type, agent_transcript_path | Yes | No |
| `PreCompact` | Source (manual/auto) | Yes | Yes |
| `Stop` | stop_hook_active flag | Yes | No |
| `TeammateIdle` | (team agent scenarios) | Yes | No |
| `TaskCompleted` | (task completion) | Yes | No |

**Common Fields on Every Hook (stdin JSON):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

**What This Gets Us:**
- Full tool call chain: every Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task invocation
- File mutation details: exact file paths, old/new content (from Edit/Write tool_input)
- Terminal commands: exact Bash commands and their results
- User prompts: what the human typed
- Session lifecycle: start, end, compaction events
- Subagent spawning: when Claude Code delegates to subagents

**What This Doesn't Get Us:**
- Token counts / cost per call (not in hook payloads)
- Model reasoning / thinking content
- API-level details (latency, cache hits, model selection per call)
- Conversation flow between tool calls (assistant text responses)

**Latency:** Synchronous — hook runs inline. Must return quickly or Claude Code blocks.

**Implementation:** Shell commands or scripts configured in `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "rex-hook-handler" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "rex-hook-handler" }]
    }]
  }
}
```

---

### 2. OpenTelemetry (Near-Real-Time, Metrics + Events)

Claude Code exports OpenTelemetry traces, metrics, and log events when configured.

**Setup:**
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

**Events Exported:**

| Event | What It Captures |
|-------|-----------------|
| `claude_code.api_request` | model, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens |
| `claude_code.api_error` | error message, status code, attempt number |
| `claude_code.user_prompt` | prompt text, length |
| `claude_code.tool_result` | tool name, success, duration, decision source |
| `claude_code.tool_decision` | tool name, accept/reject decision |

**Metrics Exported:**

| Metric | Description |
|--------|-------------|
| `claude_code.session.count` | Session counter |
| `claude_code.cost.usage` | Cost accumulation |
| `claude_code.token.usage` | Token usage (by type: input/output/cache) |
| `claude_code.lines_of_code.count` | Lines modified |
| `claude_code.commit.count` | Git commits made |
| `claude_code.pull_request.count` | PRs created |
| `claude_code.active_time.total` | Active session time |
| `claude_code.code_edit_tool.decision` | Edit permission decisions |

**What This Gets Us:**
- Per-API-call cost and token breakdowns (the only way to get this)
- Model selection per call
- Latency data
- Aggregate metrics (total cost, total tokens, session time)

**What This Doesn't Get Us:**
- Tool call arguments/results (just names and success/fail)
- File content changes
- Conversation content

**Latency:** ~5s for events, ~60s for metrics aggregation.

**Implementation:** Run an OTLP collector (e.g., `otel-collector`, or a lightweight gRPC server) that Rex manages.

---

### 3. JSONL Transcript (Post-Hoc, Complete Record)

Claude Code writes a full session transcript to disk as JSONL.

**Location:** `~/.claude/projects/<project-hash>/<session-id>.jsonl`
**Subagents:** `~/.claude/projects/<project-hash>/<session-id>/subagents/<uuid>.jsonl`

**Format (each line is a JSON object):**
```jsonl
{"type":"user_message","content":"Find the bug","timestamp":"..."}
{"type":"assistant_response","content":[{"type":"text","text":"I'll help..."}],"tokens":{"input":100,"output":50}}
{"type":"tool_use","tool_name":"Read","tool_input":{"file_path":"/path"},"tool_use_id":"toolu_..."}
{"type":"tool_result","tool_use_id":"toolu_...","content":"file contents","is_error":false}
```

**What This Gets Us:**
- Complete conversation: every user message, every assistant response
- Full tool call chain with arguments and results
- Token usage per turn
- Subagent transcripts (via SubagentStop hook's `agent_transcript_path`)

**What This Doesn't Get Us:**
- Real-time streaming (file is written progressively, but reading mid-session requires tailing)
- Cost data (tokens yes, but not USD cost)
- API-level details (model per call, latency, cache stats)

**Latency:** Available per-turn (each turn appends a line). Can be tailed for near-real-time.

**Implementation:**
- Hook provides `transcript_path` — we know where to read
- Tail the JSONL during session for live updates
- Parse complete file after session for full trace

---

## Composition: What Each Mechanism Covers

| Data Point | Hooks | OTel | Transcript |
|-----------|-------|------|------------|
| Tool calls (name + args) | **Yes** | Name only | **Yes** |
| Tool results | **Yes** | Success/fail | **Yes** |
| File mutations (content) | **Yes** (Edit/Write input) | No | **Yes** |
| Bash commands | **Yes** | No | **Yes** |
| User prompts | **Yes** | **Yes** | **Yes** |
| Assistant responses | No | No | **Yes** |
| Token usage (per-call) | No | **Yes** | Partial |
| Cost (USD) | No | **Yes** | No |
| Model selection | SessionStart only | **Yes** (per call) | No |
| API latency | No | **Yes** | No |
| Cache hit rates | No | **Yes** | No |
| Session lifecycle | **Yes** | **Yes** | Implicit |
| Subagent activity | **Yes** | ? | **Yes** (separate files) |
| Permission decisions | **Yes** | **Yes** | No |
| Errors | **Yes** | **Yes** | **Yes** |
| Real-time | **Yes** (sync) | ~5s delay | Tail-able |

**Key insight:** No single mechanism gives us everything. But hooks + transcript covers 90% of the trace story. OTel fills in the cost/performance gap.

---

## Recommended Capture Architecture

```
                     Claude Code Session
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
         Hooks API    JSONL Transcript   OTel Events
         (real-time)  (per-turn file)   (metrics/cost)
              │             │             │
              └─────────────┼─────────────┘
                            │
                    Rex Event Normalizer
                            │
                    Unified Event Stream
                            │
                    ┌───────┼───────┐
                    │       │       │
                    ▼       ▼       ▼
                 Trace    Live     Cost
                 Store   Dashboard Tracking
```

### Layer 1: Hook Handler (Primary, Real-time)

A lightweight process (`rex-hook-handler`) that:
- Receives hook JSON on stdin
- Writes to a local Unix socket or named pipe
- Returns immediately (must not block Claude Code)

Configured as the handler for all hook events. This gives us real-time tool call streaming.

### Layer 2: Transcript Tailer (Secondary, Near-Real-time)

A background process that:
- Watches the transcript JSONL file (path from SessionStart hook)
- Parses new lines as they appear
- Enriches the event stream with assistant responses (which hooks don't capture)

### Layer 3: OTel Collector (Tertiary, Metrics)

A lightweight gRPC server on localhost that:
- Receives OTLP events from Claude Code
- Extracts cost, token, latency data
- Correlates with session_id from hook data

### Unified Event Stream

All three sources normalize into a common `RexEvent` schema:

```
RexEvent {
  session_id: string
  timestamp: ISO8601
  sequence: u64
  source: "hook" | "transcript" | "otel"
  kind: "tool_call" | "tool_result" | "user_message" | "assistant_message" |
        "file_mutation" | "bash_command" | "api_call" | "session_lifecycle" |
        "permission" | "error" | "cost"
  data: EventData  // kind-specific payload
}
```

---

## Open Questions / Risks

### 1. Hook Handler Latency Budget

Hooks are synchronous — Claude Code waits for them to return. If `rex-hook-handler` is slow, it degrades the developer experience.

**Mitigation:** Fire-and-forget to a Unix socket. The handler's only job is `write(socket, json); exit(0)`. A separate daemon process reads the socket and does actual work.

### 2. OTel Availability and Stability

The OTel integration exists but:
- Is it stable across Claude Code versions?
- What's the exact schema? (Documented but could drift)
- Does it work in all environments (macOS, Linux, containers)?

**Mitigation:** OTel is Layer 3 (nice-to-have for cost tracking). Hooks + transcript work without it.

### 3. Transcript File Format Stability

The JSONL transcript format is not documented as a public API. It could change.

**Mitigation:** Version-detect based on schema, fail gracefully. The transcript is supplementary — hooks capture the critical path.

### 4. Hook Configuration Injection

How does Rex inject its hooks into the user's Claude Code config without clobbering their existing hooks?

**Mitigation:** Rex manages a `.claude/hooks/rex/` directory. Claude Code supports multiple hook handlers per event. Rex's hooks coexist with user hooks.

### 5. Can We Capture "Why" Not Just "What"?

Hooks give us tool calls (what). Transcript gives us assistant text (the reasoning). Together, we reconstruct the decision chain:
1. Assistant says "I'll check the test file" (transcript)
2. PreToolUse: Read(`src/test.ts`) (hook)
3. PostToolUse: file contents returned (hook)
4. Assistant says "The test is failing because..." (transcript)
5. PreToolUse: Edit(`src/test.ts`, ...) (hook)

**This is the full trace story.** We CAN capture it.

---

## Verdict

**The data capture is feasible.** Claude Code provides enough instrumentation surface to build comprehensive session traces. The main architectural challenge is composing three fragmented sources (hooks, transcript, OTel) into a unified stream — but that's an engineering problem, not a feasibility problem.

**Recommended starting point:** Hooks only. Get `rex-hook-handler` working, capture tool calls in real-time, store them locally. This alone gives you 70% of the trace value. Add transcript tailing for assistant messages (the "why"), then OTel for cost tracking.

### Minimal Viable Instrumentation

Just hooks, no OTel, no transcript tailing:

```
rex-hook-handler (shell script or binary)
  → receives hook JSON on stdin
  → appends to ~/.rex/sessions/<session_id>.jsonl
  → exits immediately

.claude/settings.json hooks config
  → all events → rex-hook-handler
```

This can be built and tested in a day. No containers. No daemons. Just a script that captures events to a file. Start here, prove the value, then layer on complexity.
