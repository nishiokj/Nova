# Rex: Instrumentation Surface & Sandbox Value Analysis

## The Strategic Question

We have a plan heavy on containers and overlay filesystems. But is that actually serving the core value prop? Or is it infrastructure theater?

The core value prop from the architecture doc:
1. **Session traces / audit trails** — what happened, who did it, why
2. **Knowledge capture** — patterns discovered, decisions made, failures encountered
3. **Context enrichment** — inject relevant knowledge into future sessions
4. **Observability** — real-time view of what agents are doing

**None of these require sandboxes.**

---

## Agent Instrumentation: The Landscape

### Tier 1: Closed-Source with Hook APIs

| Agent | Hook/Plugin Surface | What You Get | What You Don't Get |
|-------|--------------------|--------------|--------------------|
| Claude Code | Hooks (14 events), OTel, JSONL transcript | Tool calls, file mutations, commands, cost, full conversation | Internal reasoning, prompt construction, API payloads |
| Gemini CLI | Limited — `--log` flag, no structured hooks | Raw logs | Structured events, real-time capture |
| Codex (OpenAI) | Hooks (similar model to Claude Code) | Tool calls, session events | Varies by version |

**Tradeoff:** You're a consumer. Good when it works, fragile when they change things.

### Tier 2: Open-Source (Forkable)

| Agent | Language | Instrumentation Potential |
|-------|----------|--------------------------|
| OpenCode | Go | Full — embed at LLM call layer, tool execution, context assembly |
| Aider | Python | Full — same, plus you can instrument the git integration deeply |
| Continue | TypeScript | Full — IDE extension, can capture editor context too |
| goose | Rust/Python | Full — extensible tool system |

**Tradeoff:** You can instrument everything, but you own the fork. Every upstream release is a rebase. You become an agent maintainer, not a platform builder.

### Tier 3: Agent-Agnostic (Environment-Level)

This is the interesting one. Instead of hooking into the agent, you instrument the environment the agent runs in:

| Surface | What It Captures | Agent-Agnostic? |
|---------|-----------------|-----------------|
| Filesystem watcher | File creates, edits, deletes (with diffs) | Yes |
| Git hooks | Commits, branch operations, merges | Yes |
| PTY/terminal capture | All stdin/stdout (commands, output, conversation) | Yes |
| Network proxy | API calls (model, tokens, cost, latency) | Yes |
| Process monitoring | What processes the agent spawns, their exit codes | Yes |

**This is what the sandbox architecture was actually trying to do.** The container isn't the point — the container is just a convenient boundary for placing these watchers.

---

## The Key Insight: Separation of Concerns

The plan conflates three distinct things:

### A. Instrumentation (Capturing Data)
"What is the agent doing?"

This is the data plane. It needs sensors. Those sensors can be:
- Agent-specific hooks (Claude Code's hook API)
- Environment-level watchers (fs, git, terminal, network)
- Both (for maximum coverage)

**Does NOT require a sandbox.** A daemon on the host can watch the filesystem, install git hooks, and run a network proxy just as well as a container sidecar.

### B. Isolation (Preventing Damage)
"Can the agent accidentally `rm -rf /`?"

This is the safety story. It needs containment:
- Filesystem: overlay/chroot/namespace
- Network: firewall/proxy with allowlist
- Process: namespace/cgroup
- Permissions: OS-level enforcement

**DOES require a sandbox.** This is what containers actually provide.

### C. Scalability (Running Many Agents)
"Can I run 10 agents on one codebase without conflicts?"

This needs workspace isolation:
- Git worktrees or repo clones
- Separate working directories
- Merge coordination

**Requires sandbox OR worktree management.** Containers make this easier but aren't the only option.

---

## So: Is the Sandbox Tangential?

**For the co-driving case (developer + agent, synchronous): Yes, tangential.**

The developer IS the sandbox. They're watching the terminal. They can Ctrl+C. They review every change. Adding a container between them and their agent adds latency, complexity, and friction — for isolation they don't need.

What they DO need: instrumentation. "Show me what my agent did." That's hooks + filesystem watcher + transcript capture. No container required.

**For the autonomous/fleet case: No, essential.**

Agents running without human supervision NEED containment. A rogue `rm -rf` or `git push --force` has no human circuit breaker. The container provides the safety boundary.

But this is the Day 3 scenario. Not Day 1.

**For the "just make it observable" case: Completely tangential.**

If the product is "install Rex, type `claude` normally, get traces + knowledge + context enrichment" — containers are pure overhead. The value is in the data plane, not the execution boundary.

---

## What's the Ideal Instrumentation Surface?

If we could design from scratch, what would we want?

### The Dream: Middleware at the LLM Call Boundary

```
Developer prompt
       │
       ▼
┌──────────────────────────┐
│  Agent (any)             │
│                          │
│  Context Assembly ◄──────┼── Rex injects knowledge here
│       │                  │
│       ▼                  │
│  LLM API Call ◄──────────┼── Rex captures: prompt, model, tokens
│       │                  │
│       ▼                  │
│  Response Processing     │
│       │                  │
│       ▼                  │
│  Tool Execution ◄────────┼── Rex captures: tool, args, result
│       │                  │
│       ▼                  │
│  Next iteration          │
└──────────────────────────┘
```

The ideal is a **middleware layer** that sits between the agent and the LLM API:
- Captures every prompt sent (including system prompts, context, tools)
- Captures every response received (including token usage, cost, latency)
- Captures every tool call (before and after execution)
- Can INJECT context into the prompt (knowledge enrichment)
- Agent-agnostic (works with any agent that calls an LLM API)

**This is basically an API proxy.** Instead of agents calling `api.anthropic.com` directly, they call `localhost:rex-proxy`, which forwards to Anthropic, captures everything, and can inject context into the request.

### Why This Is Better Than Hooks

Hooks are event-driven callbacks. They fire after the agent has already made a decision. You can observe, but you can't enrich (except by blocking and modifying, which is fragile).

An API proxy sits in the critical path:
- **Capture**: See every API call, every token, every cost — because you ARE the API endpoint
- **Inject**: Add knowledge to the system prompt or conversation before it hits the LLM
- **Control**: Rate-limit, model-swap, cost-cap — because you control the API call
- **Agent-agnostic**: Any agent that calls the Anthropic/OpenAI API goes through you

### The Practical Version

```
ANTHROPIC_BASE_URL=http://localhost:9500/v1

rex proxy (localhost:9500)
  │
  ├── Intercept request
  │   ├── Log: model, message count, tool definitions
  │   ├── Inject: relevant knowledge from Rex knowledge store
  │   ├── Inject: team conventions, anti-patterns, context
  │   └── Forward to api.anthropic.com
  │
  ├── Intercept response
  │   ├── Log: tokens used, cost, latency, cache stats
  │   ├── Parse: tool calls made by the model
  │   └── Return to agent
  │
  └── Post-session
      ├── Build trace from captured request/response pairs
      ├── Extract knowledge from conversation
      └── Update knowledge store
```

**Environment variable override:** Most agents respect `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. Set it to Rex's proxy, and every API call flows through you. No hooks needed. No agent modification needed. Works with Claude Code, OpenCode, Aider, Codex, custom agents — anything.

---

## Revised Architecture Layers

```
Layer 0: Developer Experience
  "Just type claude" — nothing changes
  (Rex sets ANTHROPIC_BASE_URL in shell profile or wrapper)

Layer 1: API Proxy (the core capture mechanism)
  Sits between agent and LLM API
  Captures: every request, response, cost, tokens
  Injects: knowledge, context, conventions
  Agent-agnostic by construction

Layer 2: Environment Watchers (supplementary capture)
  Filesystem watcher → file mutations with diffs
  Git hooks → commits, branches
  Terminal capture → optional, for full session replay
  (These run as a local daemon, no container needed)

Layer 3: Data Plane (the product)
  Trace store → session replay
  Knowledge store → patterns, decisions, anti-patterns
  Cost tracking → per-session, per-model, per-team
  Audit log → compliance, debugging

Layer 4: Sandbox (Day 3, fleet-only)
  Containers for autonomous agent isolation
  Worktree management for parallel agents
  Network enforcement beyond proxy
```

**The proxy IS the instrumentation.** The sandbox is optional infrastructure for a specific use case (fleet autonomy). The data plane is the product regardless.

---

## Comparison: Hook-Based vs. Proxy-Based

| Dimension | Hooks | API Proxy |
|-----------|-------|-----------|
| Agent-agnostic | No (agent-specific hook APIs) | Yes (env var override) |
| Captures API calls | No (hooks fire at tool level) | Yes (sees every request/response) |
| Captures cost/tokens | Partial (needs OTel) | Yes (parses response headers/body) |
| Can inject context | Fragile (modify hook action) | Yes (modify request before forwarding) |
| Real-time | Yes (synchronous hooks) | Yes (inline proxy) |
| Latency impact | Low (fire-and-forget) | Low (~1-5ms per call for local proxy) |
| Setup complexity | Medium (configure per-agent hooks) | Low (one env var) |
| Maintenance burden | High (hook API changes break you) | Low (LLM API is stable/versioned) |
| Captures tool calls | Yes (PreToolUse/PostToolUse) | Indirectly (tool calls are in API response) |
| Captures file content | Yes (tool_input has file content) | No (only sees API-level data) |

**Best approach: Proxy as primary, hooks/watchers as supplementary.**

The proxy captures the LLM-level data (cost, tokens, model, reasoning). Hooks/watchers capture the execution-level data (actual file changes, commands run, git operations). Together, they give you the complete picture.

---

## What Should We Actually Build First?

### Option A: Hook Handler (1 day)
- Shell script that captures Claude Code hook events to JSONL
- Proves we can capture tool-level data
- Claude Code-specific, not agent-agnostic
- No injection capability

### Option B: API Proxy (3-5 days)
- Local HTTP proxy that forwards to Anthropic API
- Captures every LLM call: prompt, response, tokens, cost
- Agent-agnostic (any agent that calls Anthropic API)
- CAN inject context into requests
- Foundation for knowledge enrichment (the killer feature)

### Option C: Both (1 week)
- Proxy for LLM-level capture + context injection
- Hook handler for execution-level capture (file changes, commands)
- Filesystem watcher for diff capture (optional, supplements hooks)
- Unified event stream from all sources

**Recommendation: Option B (API Proxy) first.**

It's agent-agnostic, it captures the highest-value data (cost, tokens, full conversation), and it's the foundation for context injection (the knowledge propagation feature that makes the whole vision work). Hooks can be added later for execution-level detail.

The proxy also naturally handles the multi-agent/multi-provider story:
- `ANTHROPIC_BASE_URL=http://localhost:9500/anthropic/v1`
- `OPENAI_BASE_URL=http://localhost:9500/openai/v1`

One proxy, multiple providers, unified trace format.
