# Cockpit Implementation Spec (v0.1)

## 0. Summary

Cockpit is a browser-first **decision + orchestration console** for agent-driven software work. It is *not* a browser IDE. The UI optimizes for:

- high-signal review of agent output
- fast, keyboard-driven triage of escalations and completed work
- evidence-backed decisions (diffs, tests, traces, provenance)
- minimal coupling to the control plane (Session/Workflow/WorkItem are the source of truth)

This spec assumes you already have:
- Session (full context window)
- Workflow = DAG of WorkItems encoding strictness/steps
- WorkItem logs (every tool call and message)
- Traces (model → file/line edits over time, tied to WorkItem)
- TestReport (tests ran + semantic invariants guaranteed + success rate)
- Escalations (watcher asks for human input; free-form text)
- Control plane actions (fork/stop/start sessions)
- Live file/line cursor telemetry (what’s being edited now)

The only new “primitives” introduced here are **derived views** (rollups) and a **Markdown Packet** artifact (FocusPacket) that is *read-only* and always backed by evidence pointers.

---

## 1. Goals and Non-goals

### 1.1 Goals
1) Let one human supervise many concurrent workflows with minimal context switching.
2) Make escalations/ready items actionable with **one screen** and **keyboard-only** flows.
3) Keep every UI metric explainable and auditable using existing logs/traces/test reports.
4) Provide browser-native “filesystem surrogates” (hotspot viewer, patch pad, lens index, previewer).
5) Use Markdown as the primary **human-readable** format for Focus/Escalation packets without requiring the human to author it.

### 1.2 Non-goals
- Replacing a real editor/terminal (no full IDE parity).
- Inventing opaque “risk/confidence” scores presented as truth.
- Persisting a second source of truth for workflow state (Cockpit reads the control plane).

---

## 2. Core Concepts and Shape

### 2.1 Source-of-truth entities (existing)
- **Session**: stable identity + full context window; `sessionKey`.
- **Workflow**: DAG of WorkItems; encodes strictness/steps for feature/issue/refactor/system.
- **WorkItem**: a node in the workflow; has status + logs; tool calls/messages.
- **Trace**: timeline of code edits: `(model, file, line-range, op, timestamp, workItemId, sessionKey)`; may also include commit sha.
- **TestReport**: results of tests + invariants; tied to session/workItem/commit.
- **DecisionLog**: questions asked to watcher and answers (watcher + human); tied to session/workItem.
- **Escalation**: watcher→human request for input; free-form; tied to session/workItem.
- **Controls**: fork/stop/start session.

### 2.2 New but lightweight entities (derived, not source of truth)

#### A) Rollups (materialized views)
Computed views used to populate lists/panels quickly.

- `SessionRollup`
- `EscalationRollup`
- `CommitRollup`
- `PRRollup`
- `DailyMetricsRollup`

These are computed from your existing stores. They can be:
- computed on-demand (initial MVP), or
- incrementally maintained (recommended once volume grows)

#### B) Packet (FocusPacket) as Markdown Artifact
A **Packet** is a rendered, human-readable, evidence-linked document shown in the FOCUS pane.

A Packet may be:
- emitted by Watcher (ideal for escalations and “ready for review”), or
- generated server-side from logs/traces/test reports (fallback)

Packet content is Markdown (+ optional YAML frontmatter). It is **read-only** in Cockpit.

The Packet is not “truth”; it is an interface over truth. Every claim should link back to evidence.

---

## 3. UI Layout (3-column TUI-like)

### 3.1 Left Panel (Sessions)
Sections:
- **RUNNING**: sessions with active workflow execution
- **READY**: sessions whose workflow reached a “review gate” or terminal node and need human review
- **DONE**: sessions completed + reviewed (collapsible)
- **METRICS**: daily aggregates (tokens, LOC, commits, PRs, tests)

Each row is a dense “one-glance card” (provable fields only):
- kind badge (feature/issue/refactor/system)
- title (session goal)
- diffstat (+A/-D, files touched)
- elapsed time (since session start or active work item start; choose one)
- current activity (last tool call + current file:line)
- gate summary (tests/invariants pass/fail/running/unknown)
- blocked indicator (unresolved escalations count)

### 3.2 Center Panel
- **FOCUS header** (always visible): decision request + gate state + links
- **FOCUS body**: Markdown Packet renderer
- **MESSAGES**: event stream (conversation + tool call log + workflow events)
- **INPUT**: message box bound to focused `sessionKey`

### 3.3 Right Panel
- **QUEUE**: unresolved escalations (newest or highest-age first)
- **COMMITS**: recent commits (across sessions)
- **OPEN PRs**: PRs awaiting review/action

---

## 4. Keyboard-first Interaction

### 4.1 Navigation
- `1` focus left panel
- `2` focus center
- `3` focus right
- `↑/↓` move selection within focused panel section
- `Enter` focus selected item → loads FocusPacket + Messages stream
- `Esc` return cursor to INPUT
- `A–Z` quick-jump to lettered rows within current section (UI assigns letters per visible list)
- `Tab` cycle sections within a panel (e.g., Running → Ready → Done → Metrics)

### 4.2 Primary actions (no deep refactor)
From Focus header / hotkeys:
- `R` resolve escalation (marks resolved; optional note)
- `S` stop session
- `F` fork session (creates new sessionKey)
- `P` open PR view (if applicable)
- `D` open diff hotspots view (tab)
- `T` open tests/invariants view (tab)
- `L` open trace timeline view (tab)
- `V` toggle preview pane (if preview link exists)
- `Ctrl+Enter` send message to focused session (normal send)

**Design rule:** every action results in a new event appended to logs (auditability).

---

## 5. Derived Views (Rollups): Fields + How They’re Computed

### 5.1 SessionRollup
Purpose: list rendering for Running/Ready/Done.

**Fields (recommended minimum):**
- `sessionKey`
- `kind`: feature/issue/refactor/system
- `title`
- `status`: running/ready/done/stopped
- `activeWorkItemId` (optional)
- `elapsedSec`
- `lastEventAt`
- `diffstat`: {added, deleted, filesTouched}
- `currentActivity`: {tool, file, line}
- `gates`: {testsStatus, invariantsStatus, invariantsPassed, invariantsTotal}
- `blocking`: {unresolvedEscalationsCount}

**Computation (provable):**
- `elapsedSec`: derived from timestamps (session start or activeWorkItem start)
- `lastEventAt`: max timestamp across workflow events/logs
- `diffstat`: prefer git diffstat from base..head SHAs; fallback to Trace aggregation
- `currentActivity.tool`: last tool call in WorkItemLog within N seconds else idle
- `currentActivity.file/line`: live telemetry; fallback to last edited location in Trace
- `gates`: latest TestReport for session/workItem/commit
- `blocking`: count unresolved escalations for sessionKey

**Verification:**
- if both git diffstat and trace diffstat exist and diverge, display a `⚠ drift` badge and prefer git for UI.

### 5.2 EscalationRollup
Purpose: Queue list.

**Fields:**
- `escalationId`
- `sessionKey`
- `workItemId`
- `createdAt`, `ageSec`
- `headline` (first line)
- `requestedDecision`: choose/approve/clarify/permission/stop/unknown
- `refs`: list of evidence pointers

**Computation:**
- `requestedDecision`: rule-based classification OR watcher-provided tag in escalation metadata
- `refs`: parse from escalation content (recommended) else infer from last edit location/commit

### 5.3 CommitRollup / PRRollup
Implementation depends on your VCS integration. Minimum fields:
- commit sha, message, author (agent/model), time, diffstat, linked sessionKey/workItemId
- PR id, title, status, CI/gates status, linked session/work items

---

## 6. The Packet System (Markdown FocusPacket)

### 6.1 Why Markdown
Markdown is browser-native, compact, and ideal for **high-signal human reading**. It also works as a durable artifact that can be:
- versioned (committed if desired)
- generated automatically
- rendered consistently
- annotated with structured “machine hints” via frontmatter or fenced blocks

You *do not* type these; Watcher and workflows emit them.

### 6.2 Packet Types
- **Escalation Packet**: generated on escalation emission; asks a question with context and options.
- **Ready/Review Packet**: generated when workflow hits review gate or terminal completion.
- **PR Review Packet**: generated when PR opens/updates; summarises diff and gates.

### 6.3 Packet Storage
A Packet is stored as:
- `packetId`
- `sessionKey`
- `workItemId` (optional)
- `type`
- `createdAt`
- `contentMarkdown` (string)
- `evidenceIndex` (optional extracted refs for faster linking)

Packets are immutable. Updates create a new packet version.

### 6.4 Packet Frontmatter (optional but recommended)
Use YAML frontmatter for machine-readable metadata:

```yaml
---
packetId: P999
type: escalation
sessionKey: S123
workItemId: W77
requestedDecision: choose
priority: high
links:
  diff: /diff?base=...&head=...
  trace: /trace?sessionKey=S123&workItemId=W77
  tests: /tests?id=TR9
refs:
  - file: auth/token.ts#L130-L210
  - commit: abc123
  - testReport: TR9
---
```

UI uses this to render header chips and quick links.

### 6.5 Evidence Reference Syntax (in-body)
To keep packets auditable and clickable, standardize inline refs:

- `@commit(abc123)`
- `@testReport(TR9)`
- `@trace(T55)`
- `@file(auth/token.ts#L130-L210)`
- `@workItem(W77)`
- `@session(S123)`
- `@pr(123)`

The Markdown renderer converts these into links/tooltips that open the right tab.

**Validation rule (important):**
- On packet render, resolve each reference. If it can’t be resolved, show it as broken and exclude it from “evidence-backed” counts.

### 6.6 Action Blocks (optional)
For escalations, Watcher can embed a structured action list. UI renders them as clickable buttons and binds hotkeys.

```md
```cockpit-actions
- id: choose.jwt
  label: "Use JWT (stateless)"
  send:
    sessionKey: S123
    message: "Choose JWT. Prioritize stateless auth; accept revocation complexity."
- id: choose.opaque
  label: "Use opaque tokens (revocable)"
  send:
    sessionKey: S123
    message: "Choose opaque tokens backed by Redis. Revocation is a requirement."
```
```

If you want to keep it simpler, use numbered options in Markdown and bind `1..9` to send prefilled responses.

### 6.7 Packet Template Examples

#### Escalation Packet Template
- Context
- The question (single sentence)
- Options (2–4)
- Watcher recommendation + rationale (explicit)
- Evidence
- What I will do next depending on your answer

#### Ready/Review Packet Template
- Objective + constraints
- What changed (diffstat + top files)
- Gates (tests + invariants)
- Notable design decisions made
- Known risks / TODOs
- Suggested next step (merge, request changes, run extra test)

---

## 7. Evidence Tabs and Browser-native “Filesystem Surrogates”

### 7.1 Hotspot File Viewer (read-only)
A focused list of “top files” for the packet:
- computed from diffstat (preferred) or trace edits
- shows added/deleted lines per file
- click opens a diff preview of that file
- includes “jump to last edited line” using trace

**MVP:** just the list + per-file unified diff.

### 7.2 Patch Pad (surgical edits only)
Purpose: allow you to make small fixes without leaving Cockpit.

**Constraints (hard limits):**
- max files: e.g., 3
- max changed lines: e.g., 30
- disallow binary files
- disallow lockfiles unless explicitly enabled

**Flow:**
1) From a file diff, select a range or open Patch Pad.
2) You edit a small snippet or paste a unified diff patch.
3) Submit → backend applies patch on the session’s working branch.
4) Backend creates a new WorkItem (or a sub-work item) “human patch” and optionally triggers tests.
5) Patch results appear as a new commit and new Packet.

**Implementation options:**
- Accept unified diff and run `git apply` server-side.
- Or accept structured edits `{path, startLine, endLine, replacement}` and generate patch.

Auditability:
- patch submission is logged (DecisionLog or WorkItemLog event)
- patch produces a commit tied to the session/workItem

### 7.3 Repo Lens Index (search and jump)
Purpose: replace deep filesystem navigation.

**MVP capabilities:**
- text search: `rg`-style results with file:line
- symbol-ish search: definitions via simple heuristics (e.g., `class`, `function`, `def`, `export` patterns) depending on language

**Better (optional):**
- tree-sitter-based symbol index with callers/callees later

**UI:**
- search box + results list grouped by:
  - Definitions
  - References
  - Text matches
- selecting result opens file preview at line with context

### 7.4 Embedded Previewer (keeps you on the main page)
Purpose: view running app or deployed preview without leaving Cockpit.

Implementation:
- a right-side collapsible “Preview” pane or modal overlay
- sources:
  - PR preview URL (preferred)
  - internal environment URL
  - localhost proxy (if your infra supports it)

**Nice-but-not-required:** “Snapshot” button that captures screenshot + URL + timestamp and attaches it to the current Packet as evidence.

### 7.5 Built-in Browser Workflow (interactive + automated)
Purpose: handle UI-driven validation in Cockpit without dropping to an external browser toolchain.

Implementation:
- session-scoped browser state endpoint (`sessionKey -> browserSession`)
- single action endpoint for interactive operations (`open`, `click`, `fill`, `press`, `wait`, `scroll`, `snapshot`, `screenshot`, navigation)
- runbook endpoint for multi-step automation scripts (line-based commands)
- captured evidence persisted to `.cockpit/browser/<session>/screenshots|snapshots/...` and logged into `agent_events`

Operational notes:
- browser actions are auditable as `browser_action` events
- evidence capture is auditable as `browser_evidence_captured` events
- latest resolved URL can refresh Cockpit preview URL for that session
- availability depends on `agent-browser` runtime availability on the daemon host

---

## 8. Event Stream (Messages panel)

The MESSAGES stream should unify:
- conversation messages
- tool calls (summarized, expandable)
- workflow state changes (work item start/end)
- packet emissions (“Escalation Packet created” / “Ready Packet created”)
- test report arrivals

Implementation: one normalized event format in the UI:

```json
{ "at": "...", "type": "message|tool|workflow|packet|test|trace", "payload": {...} }
```

The UI should be able to filter:
- show only messages
- show only tool calls
- show failures only (tests/commands)

---

## 9. Backend API Surface (minimal, stable)

Assuming your backend already has control-plane endpoints, Cockpit adds a thin read API + a few write actions.

### 9.1 Read APIs
- `GET /cockpit/rollups/sessions?status=running|ready|done`
- `GET /cockpit/rollups/escalations?status=open`
- `GET /cockpit/rollups/commits?limit=50`
- `GET /cockpit/rollups/prs?status=open`
- `GET /cockpit/metrics/daily?date=YYYY-MM-DD`

Focus / detail:
- `GET /cockpit/focus?type=session|escalation|commit|pr&id=...`
  - returns: Focus header metadata + latest Packet (if any) + pointers
- `GET /cockpit/session/{sessionKey}/events?cursor=...`
- `GET /cockpit/session/{sessionKey}/packets?limit=...`
- `GET /cockpit/diff?base=...&head=...` (or session/workItem-scoped)
- `GET /cockpit/tests/{testReportId}`
- `GET /cockpit/traces?sessionKey=...&workItemId=...`

Repo lens:
- `GET /cockpit/repo/lens?q=...&kind=all|defs|refs|text`

Preview:
- `GET /cockpit/preview?url=...` (proxy) OR `GET /cockpit/preview?sessionKey=...`

Built-in browser:
- `GET /cockpit/browser/state?sessionKey=...`

### 9.2 Write APIs (actions)
- `POST /cockpit/session/{sessionKey}/message` body: `{message}`
- `POST /cockpit/session/{sessionKey}/control` body: `{action: start|stop|fork}`
- `POST /cockpit/escalations/{id}/resolve` body: `{note?}`
- `POST /cockpit/patch/apply` body: `{sessionKey, baseSha?, patch|edits}`
- `POST /cockpit/browser/action` body: `{sessionKey, action, ...args}`
- `POST /cockpit/browser/runbook` body: `{sessionKey, script, stopOnError?}`

Packet creation (by watcher/workflow):
- `POST /cockpit/packets` body: `{sessionKey, workItemId?, type, markdown, metadata?}`

---

## 10. How “Ready” Is Determined (strictness via Workflow DAG)

Because your strictness is encoded in the Workflow DAG, Cockpit uses workflow state directly.

A session is **READY** when:
- workflow has reached a terminal “review” node OR all required nodes completed, and
- any required gates (tests/invariants) have TestReports present with pass status, and
- there are no unresolved escalations that block completion (configurable)

A session is **DONE** when:
- it is READY and a human marks it reviewed/accepted (or merges PR), producing a “review decision” event.

No heuristics required; it’s all DAG + TestReport + Escalations.

---

## 11. Trust and Verification Rules (avoid unprovable claims)

### 11.1 UI must label computed vs proven
- **Proven**: directly from logs/test reports/traces/git
- **Computed**: derived deterministically from proven data (e.g., diffstat aggregation)
- **Heuristic**: anything that uses inference (avoid in v0.1, or label clearly)

### 11.2 Packet credibility rules
- Packet summary bullets should be “evidence-backed”:
  - each bullet must reference at least one `@file/@commit/@testReport/@trace`
- UI shows an “Evidence coverage” indicator:
  - e.g., “3/3 bullets linked”

### 11.3 Drift detection
If trace-derived change counts disagree with git diffstat for the same base/head:
- show drift badge
- use git as display truth
- keep trace for attribution (which model changed what)

---

## 12. Minimal Additions (high impact, low refactor)

These are the few additions that unlock most of the UX without changing your backend model.

1) **Packet creation endpoint + storage** (Markdown FocusPacket)
   - lets Watcher emit rich, formatted escalations/review briefs
   - reduces reliance on digging through raw logs

2) **Stable Revision Range per “commit fired”** (base/head SHAs)
   - makes diffstat and hotspots deterministic and verifiable

3) **Escalation resolve state**
   - keeps queue clean and makes “blocked” accurate

4) **Repo lens search endpoint**
   - turns the browser into a usable code comprehension surface without a full filesystem UI

5) **Patch apply endpoint** (small diffs only)
   - allows surgical fixes and fast approvals without leaving Cockpit

Preview proxy is valuable but can be deferred if you already have deployed preview links from CI/PRs.

---

## 13. Phased Rollout Plan

### Phase 1 (MVP, 1–2 weeks worth of engineering if infra exists)
- Rollup endpoints: sessions + escalations + daily metrics
- Focus flow: selecting loads Packet (or fallback) + messages stream
- Markdown renderer with `@ref()` linking
- Resolve escalation action
- Ready/Done transitions

### Phase 2 (evidence-first review)
- Diffstat/hotspot viewer backed by base/head SHAs
- Tests/invariants tab from TestReport
- Trace timeline tab (edits over time)

### Phase 3 (browser-native productivity)
- Repo lens endpoint + UI
- Patch pad with strict limits + audit logging
- Preview pane + optional snapshot attachment
- Built-in browser actions + runbook automation + evidence capture

---

## 14. Packet Example (Escalation)

```markdown
---
type: escalation
sessionKey: S123
workItemId: W77
requestedDecision: choose
links:
  diff: /diff?base=aaa&head=bbb
  tests: /tests?id=TR9
refs:
  - file: auth/token.ts#L130-L210
  - commit: abc123
  - testReport: TR9
---

# Decision: JWT vs Opaque Tokens

## Context
We are refactoring auth tokens to support **revocation** without breaking login.

- Current implementation: JWT in cookies (no revocation)
- New requirement: revoke tokens on password reset and suspicious activity

Relevant code: @file(auth/token.ts#L130-L210)

## The Question
Should we use **JWT** or **opaque tokens** for access tokens?

## Options
1. **JWT** (stateless)  
   Pros: fewer lookups, simpler infra  
   Cons: revocation is hard; requires short TTL + denylist  
2. **Opaque tokens** (stateful)  
   Pros: revocation is trivial; aligns with Redis we already run  
   Cons: adds lookup per request; need cache strategy

## Recommendation (Watcher)
Leaning **opaque tokens** because revocation is a hard requirement and we already have Redis.

Evidence:
- Proposed token store: @commit(abc123)
- Gate status: @testReport(TR9)

## If you choose JWT
I will:
- implement denylist + short TTL
- add invariants covering revocation semantics
- run integration suite

## If you choose Opaque
I will:
- implement token lookup with Redis
- add invariants: “revoked token never authenticates”
- run integration + mutation tests
```

---

## 15. Packet Policy Decisions (baked in)

Decisions as of 2026-02-06:

1) **Persistence scope**
   - Packets are first-class artifacts for escalation/review/session focus flows.
   - `commit` is not a packet type in the API surface.

2) **Markdown richness**
   - Packets may include full Markdown, including tables/diagram blocks.
   - Cockpit renders what it supports and preserves packet content as-is.

3) **Evidence refs policy**
   - Escalation/review packets are expected to include evidence refs (`@file/@commit/@testReport/@trace/...`).
   - Missing evidence refs currently produce **validation warnings** (non-blocking), visible in Cockpit.

---

## 16. Implementation Gap Log (as of 2026-02-06)

The following gaps were identified during implementation review and should be tracked until closed:

1) Focus API currently supports `session|escalation` only. `commit|pr` focus targets are not implemented.
2) Session rollup diffstat placeholder issue is resolved: session lists now use git-backed diffstats from stable base/head revision ranges when available, with trace fallback.
3) Daily metrics currently hardcode PR count (`prs: 0`) instead of real PR aggregation.
4) Packet frontmatter extraction/chips issue is resolved; `cockpit-actions` block rendering is still pending.
5) Packet evidence validation issue is resolved: unresolved refs are surfaced as broken and evidence coverage is displayed.
6) Messages panel filtering issue is resolved: `all`, `messages`, `tools`, and `failures` filters are implemented.
7) DONE lifecycle issue is resolved for cockpit flow: explicit review decision action now transitions `ready -> completed` (accept) or `ready -> active` (request changes) with persisted audit event.
8) Patch flow is audited but does not yet create a dedicated human-patch work item + auto-test + packet emission chain.
9) Built-in browser workflow issue is resolved: Cockpit now has a first-class browser tab with interactive actions, runbook automation, persisted screenshot/snapshot evidence, and audited browser events.

### 16.1 Step 11 Status Update

Step 11 (`Trust and Verification Rules`) is implemented in UI with the following behavior:

- Proven/computed/heuristic trust badges are rendered in focus surfaces.
- Packet evidence coverage is shown (`evidence-backed bullets / total bullets` + resolved refs count).
- Unresolved packet refs render as broken and are excluded from evidence-backed counts.
- Diff view performs drift detection between trace-derived file-touch counts and git diffstat, shows a drift badge, and continues to use git as display truth.

### 16.2 Step 12 Status Update

Step 12 (`Minimal Additions`) is now implemented as follows:

- Packet creation endpoint + storage is implemented (`POST /cockpit/packets`) with persisted packet artifacts.
- Stable revision ranges are now persisted per `git_commit` event (`baseSha/headSha`) and consumed for deterministic diff/range resolution.
- Escalation resolve state is implemented and drives blocked/queue behavior.
- Repo lens search endpoint is implemented.
- Patch apply endpoint with strict constraints and audit logging is implemented.

### 16.3 Step 13 Status Update

Step 13 (`Phased Rollout Plan`) is implemented for core phased capabilities:

- Phase 1: rollups, focus flow, markdown + refs, escalation resolve, and explicit review-decision transitions are implemented.
- Phase 2: diff/hotspots from revision ranges, tests tab, and trace timeline are implemented.
- Phase 3: repo lens UI, patch pad + audit, preview pane, and built-in browser actions/runbook/evidence capture are implemented.

### 16.4 Step 14 Status Update

Step 14 (`Packet Example`) is implemented as runtime behavior:

- Watcher-raised escalations now auto-generate escalation packet markdown artifacts with frontmatter (`type/sessionKey/workItemId/requestedDecision/links/refs`) and evidence refs.
- Generated packet markdown is persisted to session metadata as a packet record and emitted as a `packet_emitted` audit event.
- Harness writes packet markdown files under session watcher storage (`.cockpit/packets/...`) and stores relative `sourcePath`.
- Dashboard packet view now parses frontmatter, hides raw YAML in the body, renders frontmatter chips/links/refs, and keeps evidence/broken-ref accounting.

### 16.5 Step 15 Status Update

Step 15 (`Policy decisions`) is implemented in API + UI behavior:

- Packet type validation is explicit; unsupported types (for example `commit`) return `400` instead of silently coercing to `session`.
- Packet evidence refs are inferred from markdown when `evidenceIndex` is omitted.
- Escalation/review packets without evidence refs receive validation warnings that are persisted and surfaced in the packet view.

### 16.6 Browser Workflow Status Update

Built-in browser workflow is implemented as Cockpit runtime behavior:

- New browser APIs are available:
  - `GET /cockpit/browser/state?sessionKey=...`
  - `POST /cockpit/browser/action`
  - `POST /cockpit/browser/runbook`
- Dashboard includes a first-class **Browser** tab with:
  - URL open/navigation controls
  - interactive action runner (`click/fill/type/press/wait/scroll`)
  - runbook automation editor and execution path
  - action history and evidence list rendering
- Browser evidence capture is persisted under `.cockpit/browser/...` (snapshots + screenshots) and audited in session metadata (`browser_action`, `browser_evidence_captured`).
- Preview URL can be updated from successful browser navigation so the preview pane stays aligned with the active browser target.
