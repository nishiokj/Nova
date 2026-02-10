# Agent Factory Architecture

## What Is the Factory?

The Factory is a closed loop that makes every agent session smarter than the last.

```
Capture → Learn → Inject → Capture better → Learn more → Inject smarter
```

It sits between developers/agents and LLM APIs. It captures everything. It builds structured knowledge from what it captures. It injects relevant knowledge into future sessions. The knowledge improves. The agents get better. The loop compounds.

The Factory is not a container orchestrator. It's not a sandbox. It's not a dashboard. It's the system that runs this loop.

---

## Three Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent Factory                         │
│                                                             │
│  ┌───────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │     Proxy     │  │  Knowledge Store │  │   Context    │  │
│  │  (data in)    │──│  (intelligence)  │──│  Generator   │  │
│  │               │  │                  │  │  (data out)  │  │
│  └───────┬───────┘  └────────┬─────────┘  └──────┬──────┘  │
│          │                   │                    │         │
│          │         ┌─────────▼─────────┐          │         │
│          │         │   Lineage Store   │          │         │
│          │         │  (provenance)     │          │         │
│          │         └───────────────────┘          │         │
│          │                                        │         │
└──────────┼────────────────────────────────────────┼─────────┘
           │                                        │
     Every API call                          context.md
     + tool calls                            injected into
     + file diffs                            next session
     + session traces
```

### 1. Proxy (Data In)

Sits between the agent and the LLM API. Captures every request and response. Correlates API calls with tool executions and file mutations.

**Mechanism:** Environment variable overrides per provider. One-time setup via `rex init`:

```bash
# rex init writes these to shell profile — covers all agents automatically
export ANTHROPIC_BASE_URL=http://localhost:9500    # Claude Code, Antigravity
export OPENAI_BASE_URL=http://localhost:9500        # Codex, Aider, OpenCode
export GOOGLE_GEMINI_BASE_URL=http://localhost:9500 # Gemini CLI
```

For teams: replace `localhost:9500` with `proxy.company.com:9500`.

Every agent that respects its provider's base URL env var routes through the Factory automatically. No per-agent hooks, no per-agent config files. One proxy, one set of env vars.

**Multi-provider routing:** The proxy detects the API format from the request path and content:

```
localhost:9500
  ├── /v1/messages              → Anthropic Messages API
  ├── /v1/responses             → OpenAI Responses API
  ├── /v1/chat/completions      → OpenAI Chat Completions API
  ├── /v1beta/models/*          → Google Gemini API
  └── All routes:
      ├── Parse request for capture (model, messages, tools, system prompt)
      ├── [Optional] Inject knowledge into system prompt
      ├── Forward to real API (swap base URL, pass through everything else)
      ├── Parse response for capture (tokens, cost, tool calls, content)
      └── Return response unchanged to caller
```

**Agent compatibility:**

| Agent | Env Var | Works with localhost? |
|-------|---------|----------------------|
| Claude Code | `ANTHROPIC_BASE_URL` | Yes |
| Codex (OpenAI) | `OPENAI_BASE_URL` or `config.toml` | Yes |
| Gemini CLI | `GOOGLE_GEMINI_BASE_URL` | Yes |
| Antigravity | `ANTHROPIC_BASE_URL` | Yes |
| Aider | `OPENAI_API_BASE` | Yes |
| OpenCode | Provider config | Yes |
| Cursor | Settings → Override Base URL | No (requires HTTPS + public URL) |

**What it captures per API call:**
- Full prompt (system + conversation + tools)
- Model selected
- Response (text + tool_use blocks)
- Token counts (input, output, cache read, cache creation)
- Cost (USD)
- Latency
- Session ID, timestamp, sequence number

**Supplementary capture** (via hooks + filesystem watcher):
- Tool executions: which files were actually read/written/edited, which commands were run
- File diffs: before/after content for every mutation
- Git operations: commits, branches, merges
- User prompts: what the human typed

The proxy captures the LLM-level data. Hooks capture the execution-level data. Together: complete picture.

**Latency overhead:** ~1-5ms per API call. LLM calls take 500-30,000ms. Imperceptible.

**Existing assets:** `packages/llm/src/providers/` already contains full provider adapters for all major API formats:

| Provider Adapter | API Format | What It Parses |
|-----------------|------------|----------------|
| `anthropic.ts` | Anthropic Messages | messages, tools, token usage, tool calls, streaming SSE |
| `openai.ts` | OpenAI Responses | input, tools, token usage, tool calls, reasoning, streaming SSE |
| `openai-compat.ts` | OpenAI Chat Completions | messages, tools, token usage, tool calls, reasoning, streaming SSE |
| `codex.ts` | Codex (OpenAI variant) | Same as OpenAI with Codex-specific handling |
| `vercel-gateway.ts` | Vercel AI Gateway | Gateway-specific routing |

These adapters already handle request formatting, response parsing, streaming SSE consumption, token extraction, tool call parsing, and error handling. The proxy reuses this parsing logic to extract structured fields from passthrough traffic — **the format-specific work is already done.**

The proxy itself is a thin HTTP forwarding layer. It receives requests in provider-native format, parses them for capture using the existing adapter logic, forwards unchanged to the real API, parses the response, and returns it unchanged to the caller.

### 2. Knowledge Store (Intelligence)

Structured facts with scope and provenance. Not a vector database. Not a document dump. Discrete knowledge items, each with:

```
KnowledgeItem {
  id:         uuid
  scope:      org | team | repo | module | file
  scopePath:  "src/auth/*" | "payments-team" | "acme-corp"
  kind:       pattern | anti_pattern | decision | convention | warning | fact
  content:    "Don't use time.Sleep in auth tests — use clock.Advance"
  confidence: f64  (0.0 - 1.0, increases with confirmation)
  source: {
    sessionId:  "abc123"
    prompt:     "Fix the flaky test in session_test.go"
    timestamp:  "2026-02-09T14:30:00Z"
    learnedBy:  "auto" | "human" | "review_feedback"
  }
  confirmations: u32  (number of sessions that validated this)
  lastUsed:   timestamp
  lastValidated: timestamp
}
```

**Knowledge hierarchy:**

```
Org-level (admin-curated):
  ├── "All services must use structured logging with correlation IDs"
  ├── "Never store PII in logs"
  ├── "Use Zod for runtime validation at API boundaries"
  └── "Security: all auth tokens must have max 15min expiry"

Team-level (team lead-curated + auto-learned):
  ├── "Payments team uses Stripe SDK v12, not raw API calls"
  ├── "Auth team: all tokens are RS256 JWTs"
  └── "Platform team: infrastructure changes require CODEOWNERS approval"

Repo-level (auto-learned from sessions):
  ├── "This repo uses Bun, not npm"
  ├── "Tests use vitest, not jest"
  ├── "Database migrations are in packages/agent-memory/migrations/"
  └── "Build order: packages first, then apps (see package.json scripts)"

Module-level (auto-learned):
  ├── "src/auth/session.ts has a race condition under concurrent access"
  ├── "Don't use time.Sleep in auth tests — use clock.Advance"
  └── "packages/context/ uses YAML frontmatter + ### type headers, not --- delimiters"

File-level (auto-learned):
  ├── "harness.ts:1020 — pendingCount bug: acknowledged escalations make count=0"
  └── "control_plane_server.ts — GraphD field names are camelCase"
```

**How knowledge enters the store:**

1. **Auto-extraction from sessions.** After a session completes, analyze the trace. If the agent went down a dead end and then corrected itself, that's an anti-pattern. If it applied a pattern consistently across files, that's a convention. If it made an explicit decision ("I'll use X because Y"), that's a decision record.

2. **Admin curation.** Enterprise admins or team leads write org/team-level knowledge directly. These are the "best practices" entries. They never expire, they override auto-learned knowledge if there's a conflict.

3. **Review feedback.** When a PR gets review comments, those comments are signal. "Don't do X here, use Y instead" → anti-pattern at the relevant scope. This closes the loop from code review back into agent knowledge.

4. **Confirmation.** When multiple sessions independently apply the same pattern or avoid the same anti-pattern, confidence increases. Knowledge that's confirmed by 5+ sessions is high-confidence. Knowledge from a single session is provisional.

**How knowledge exits the store:** See Context Generator below.

### 3. Context Generator (Data Out)

Queries the knowledge store for items relevant to the current task. Produces a transparent, inspectable `context.md` file that gets loaded as project context.

**Relevance scoring:**

When a session starts (or when the agent touches new files), the Context Generator queries:

```
Input signals:
  - Working directory / repository
  - Files being read or modified (from hooks)
  - Task description (from user prompt, if available)
  - Team membership (if org-level Factory)

Query:
  SELECT * FROM knowledge
  WHERE scope matches (org, team, repo, module, file)
  AND scopePath overlaps with touched files/modules
  ORDER BY relevance_score DESC
  LIMIT context_budget

Relevance score = f(scope_match, confidence, recency, confirmation_count)
```

**Output: `context.md`**

A plain text file the developer can read, edit, and delete. Lives at `~/.rex/projects/<project>/context.md` or `.rex/context.md` in the repo.

```markdown
# Rex Knowledge Context
# Auto-generated from Factory knowledge store.
# Inspect, edit, or delete entries freely.
# Last updated: 2026-02-09T14:30:00Z
# Items injected: 5 (2 repo-level, 2 module-level, 1 team-level)

## Repository Conventions
- This repo uses Bun for package management, not npm (confirmed, 12 sessions)
- Tests use vitest. Test files are colocated with source as *.test.ts (confirmed, 8 sessions)

## src/auth/
- session_test.go is flaky because it depends on wall-clock time
  (learned: session abc123, 2 days ago, confirmed by 4 sessions)
- Use clock.TestClock for mock time in tests, never time.Sleep
  (confirmed, 6 sessions)

## Team: Platform
- Infrastructure changes require CODEOWNERS approval before merge
  (team convention, added by @lead)
```

**How it gets into the agent's context:**

Option A: Loaded via CLAUDE.md `@include` or similar mechanism
Option B: Injected as a system message prefix by the proxy (adds to the API request before forwarding)
Option C: Both — file for transparency, proxy injection for reliability

The developer always has visibility via the file. The proxy injection ensures it actually reaches the agent even if the agent doesn't read CLAUDE.md.

**Transparency guarantees:**
- `rex context show` — print current injected context
- `rex context log` — show history of what was injected and when
- `rex context disable` — turn off injection entirely
- `rex context edit` — open context.md in editor
- Session start message: "Rex: injected 5 knowledge items (2 repo, 2 module, 1 team)"

No hidden manipulation. The developer knows exactly what the agent knows.

---

## Lineage: Full Provenance for Every Code Change

Every PR, diff, and commit produced through the Factory has a complete trace:

```
PR #427: "Fix race condition in charge_customer()"
  │
  ├── Initiated by
  │   └── Prompt: "Fix the race condition in the payments charge flow"
  │       Author: @jevinnishioka
  │       Timestamp: 2026-02-09T14:22:00Z
  │
  ├── Knowledge injected
  │   ├── "charge_customer() has race condition under concurrency"
  │   │    Source: auto-learned, session abc123, 3 days ago
  │   │    Confidence: 0.92 (confirmed by 4 sessions)
  │   │
  │   └── "Payments team uses database advisory locks for mutex"
  │        Source: team convention, added by @tech-lead
  │
  ├── Agent session trace
  │   ├── Read: src/api/payments/charge.ts (lines 1-200)
  │   ├── Read: src/api/payments/charge.test.ts
  │   ├── Grep: "advisory_lock" across src/api/payments/
  │   ├── Read: src/api/payments/lock.ts (found existing lock utility)
  │   ├── Edit: src/api/payments/charge.ts (+12 -3)
  │   │   └── Wrapped charge logic in advisory lock
  │   ├── Bash: bun test src/api/payments/
  │   │   └── 47 passed, 0 failed
  │   └── Assistant reasoning: "Used existing advisory lock utility
  │       rather than adding a new mutex, consistent with team convention"
  │
  ├── Files changed
  │   └── src/api/payments/charge.ts
  │       └── Diff: +12 -3 (advisory lock wrapping)
  │
  ├── Metrics
  │   ├── Model: claude-opus-4-6
  │   ├── API calls: 4
  │   ├── Tokens: 18,400 input / 2,100 output
  │   ├── Cost: $0.67
  │   ├── Duration: 3m 22s
  │   └── Tool calls: 14
  │
  └── Post-merge knowledge produced
      └── "charge_customer() race condition resolved via advisory lock"
          Scope: file (src/api/payments/charge.ts)
          Kind: fact
          Replaces: previous warning about race condition
```

**What this enables:**

**Audit.** "Why was this change made?" → trace the full chain from prompt to diff. Every line of code has documented authorization (who prompted it) and reasoning (why the agent chose this approach).

**Improvement.** PR had bugs? Trace back: was the injected knowledge wrong? Was it missing? Was the agent's reasoning flawed despite good knowledge? Fix the root cause — update the knowledge store, not just the code.

**Measurement.** "Sessions with module-level knowledge injected completed 30% faster and had 40% fewer review comments." Quantifiable value of the knowledge store.

**Compliance.** SOC2, SOX, HIPAA audit trails. Every code change has: who authorized it, what context the agent had, what tools it used, what it changed, and why. This is stronger auditability than human-written code, which has none of this by default.

---

## Network Topology: Local → Team → Enterprise

The same architecture scales from a single developer to an enterprise. The components are the same; only the deployment topology changes.

### Local (Single Developer)

```
Developer machine
  ├── rex daemon (localhost:9500)
  │   ├── Proxy: multi-provider routing
  │   │   ├── /v1/messages → api.anthropic.com
  │   │   ├── /v1/responses, /v1/chat/completions → api.openai.com
  │   │   └── /v1beta/models/* → generativelanguage.googleapis.com
  │   ├── Knowledge store: SQLite at ~/.rex/knowledge.db
  │   ├── Trace store: SQLite at ~/.rex/traces.db
  │   └── Context generator: writes ~/.rex/projects/*/context.md
  │
  ├── claude   (ANTHROPIC_BASE_URL=http://localhost:9500)
  ├── codex    (OPENAI_BASE_URL=http://localhost:9500)
  └── gemini   (GOOGLE_GEMINI_BASE_URL=http://localhost:9500)
```

One process. Local SQLite. No infrastructure. All agents on the machine route through the same proxy. All knowledge is personal — what YOUR sessions have learned.

### Team (Shared Knowledge)

```
Team server (or cloud service)
  ├── Factory API (proxy.team.com:9500)
  │   ├── Proxy: multi-provider routing (Anthropic, OpenAI, Gemini)
  │   ├── Knowledge store: Postgres (shared across team)
  │   ├── Trace store: Postgres or object storage
  │   └── Context generator: per-session, queries shared store
  │
Developer A: rex init --team https://proxy.team.com:9500
  → ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL all set
Developer B: rex init --team https://proxy.team.com:9500
Developer C: rex init --team https://proxy.team.com:9500
```

Same architecture. Shared Postgres instead of local SQLite. Knowledge from Developer A's Claude Code sessions is available to Developer B's Codex agent. Cross-agent, cross-provider learning. Team leads can curate team-level knowledge.

### Enterprise (Policy + Compliance)

```
Enterprise Factory (factory.acme.com)
  ├── Proxy layer
  │   ├── Authentication: SSO/SAML, API key per developer
  │   ├── Authorization: which models, which repos, cost limits
  │   ├── Forwarding: to Anthropic, OpenAI, Bedrock, Vertex, etc.
  │   └── Audit logging: every API call, every tool execution
  │
  ├── Knowledge store
  │   ├── Org-level: admin-curated enterprise best practices
  │   ├── Team-level: team lead-curated conventions
  │   ├── Repo-level: auto-learned from sessions
  │   ├── Module-level: auto-learned, file-scoped
  │   └── Access control: team knowledge only visible to team members
  │
  ├── Lineage store
  │   ├── Full provenance for every PR
  │   ├── Compliance reporting: SOC2, SOX audit trails
  │   └── Analytics: cost by team, quality by knowledge injection, etc.
  │
  └── Context generator
      ├── Org policies always injected
      ├── Team + repo + module knowledge by relevance
      ├── Cost caps and model restrictions enforced at proxy
      └── All injection logged and inspectable
```

Same three components. More access control, more policy enforcement, more analytics. But the core loop is identical: Capture → Learn → Inject.

---

## The Data Flywheel

The Factory gets better over time. This is the compounding advantage.

```
Week 1:  Knowledge store is empty.
         Agents work normally.
         Factory captures traces.

Week 2:  Knowledge store has 50 items (auto-learned).
         Agents get relevant context injected.
         Tasks that previously took 30 min take 20 min.
         Factory captures better traces (agents make fewer mistakes).

Week 4:  Knowledge store has 200 items.
         Team leads have curated 30 high-value conventions.
         New team members' agents immediately know team patterns.
         Code review comments drop 25% (agents already follow conventions).

Month 3: Knowledge store has 1000+ items.
         High-confidence items are essentially "institutional memory."
         Agent #500 knows everything agents #1-499 learned.
         Onboarding an engineer takes hours, not weeks.
         The knowledge store IS the team's engineering culture, codified.
```

**The flywheel accelerants:**

1. **More sessions → more knowledge.** Every session that touches code produces potential knowledge items. The store grows organically.

2. **Better knowledge → better sessions.** Agents with relevant context make fewer mistakes, go down fewer dead ends, follow team conventions automatically.

3. **Review feedback → knowledge corrections.** PR review comments feed back into the knowledge store. "Don't do X" in a review becomes an anti-pattern entry. The same mistake never happens again.

4. **Confirmation strengthens knowledge.** When multiple sessions independently validate a pattern, its confidence increases. High-confidence knowledge is injected more aggressively. Low-confidence knowledge is offered tentatively.

5. **Staleness detection.** Knowledge that hasn't been confirmed in N sessions, or that contradicts recent session behavior, decays. The store self-prunes.

---

## What the Sandbox Becomes

The sandbox (container/isolation) is NOT part of the core Factory. It's an optional execution layer for a specific use case: **autonomous agents without human supervision.**

```
Core Factory (always):
  Proxy + Knowledge Store + Context Generator + Lineage
  Works for: developer + agent (co-driving), CI/CD agents, any supervised use

Sandbox layer (optional, Day N):
  Container isolation + filesystem overlay + network enforcement
  Works for: fleet of autonomous agents, untrusted execution, multi-agent parallelism
  Depends on: Core Factory (sandbox agents still go through the proxy)
```

The sandbox is a customer of the Factory, not a component of it. Sandboxed agents use the same proxy, same knowledge store, same context injection. The sandbox just adds execution isolation on top.

**When to build the sandbox:**
- When customers need to run agents without human supervision
- When fleet orchestration (10 agents on one codebase) is a real use case
- When the trust model shifts from "developer is watching" to "agent is autonomous"

Not Day 1.

---

## What We Build

### Phase 1: Multi-Provider Proxy + Trace Capture

**Goal:** `rex start` runs a local proxy. Developer uses any agent (Claude Code, Codex, Gemini CLI, Aider, etc.) normally. Every API call is captured with full request/response data.

```
rex init → writes env vars to shell profile (one-time)
rex start → proxy on localhost:9500
claude / codex / gemini → all route through proxy, all calls captured
rex trace list → show sessions
rex trace show <id> → full session replay
rex cost → cost breakdown by provider, model, session
```

Deliverables:
- `rex` CLI with `init`, `start`, `trace`, `cost` subcommands
- Multi-provider HTTP proxy with route detection (Anthropic, OpenAI Responses, OpenAI Chat Completions, Gemini)
- Request/response parsing using existing `packages/llm/src/providers/` adapter logic
- Request/response logging to local SQLite
- Supplementary capture via Claude Code hooks (tool calls, file diffs) — optional, for execution-level detail
- `rex trace` and `rex cost` commands

**Done when:** Developer runs `rex start`, uses Claude Code AND Codex in the same day, and `rex trace list` shows both sessions with full API call history, token usage, and cost breakdown across providers.

### Phase 2: Knowledge Extraction

**Goal:** After sessions, automatically extract knowledge items. `rex context show` displays what would be injected.

Deliverables:
- Post-session analysis: scan trace for patterns, anti-patterns, decisions
- Knowledge store schema (SQLite, scoped by repo/module/file)
- `rex knowledge list` — browse the store
- `rex knowledge add` — manually add items
- `rex context show` — preview what would be injected for current directory
- Context.md generation (transparent, inspectable)

**Done when:** After 10 sessions on a repo, `rex knowledge list` shows auto-learned patterns that are actually useful. `rex context show` generates relevant context for the current working directory.

### Phase 3: Context Injection

**Goal:** Knowledge is automatically injected into sessions via the proxy. Agents are measurably better.

Deliverables:
- Proxy-level injection: add relevant knowledge to system prompt before forwarding
- context.md file generation for transparency
- Session start notification: "Rex: injected N knowledge items"
- `rex context disable` / `rex context edit` for developer control
- Relevance scoring (scope match, confidence, recency)

**Done when:** A new developer clones a repo, runs `rex start && claude`, and their agent immediately knows the repo's conventions, anti-patterns, and patterns — without the developer doing anything.

### Phase 4: Lineage + Team

**Goal:** Full provenance for every code change. Shared knowledge across a team.

Deliverables:
- Lineage records: prompt → knowledge injected → trace → diffs → PR
- `rex lineage <pr-number>` — show full provenance for a PR
- Team deployment: shared Postgres, team-level knowledge
- Admin curation: org/team-level knowledge management
- Review feedback loop: PR comments → knowledge corrections

**Done when:** A team of 5 developers using the Factory sees measurable improvement in agent output quality and reduction in code review churn.

### Deferred

- Sandbox / container isolation (fleet-only, Day N)
- Cursor support (requires HTTPS + public URL — needs tunnel or deployed proxy)
- Additional provider formats (Bedrock, Vertex — different auth models)
- Dashboard UI
- CI/CD integration (auto-merge, risk classification)
- Enterprise SSO, RBAC, compliance reporting
- Agent-reviews-agent (automated PR review)
