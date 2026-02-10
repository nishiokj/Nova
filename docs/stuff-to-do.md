## Stuff To-Do

## Primary Control Plane User Journeys (Browser)

Simple, pragmatic, practical, surgical: these are the flows we should make *excellent* first.

### 1) Create Session → Drive Work in Chat → Review → Close
**Why this is primary:** This is the core value loop.

**Entry points:**
- Left panel `FileExplorer` (create session from project path + goal)
- Right panel `SessionCard` (resume existing)

**Golden path:**
1. User creates a new session from a project path + concise goal.
2. UI immediately focuses that session and opens the message/event drawer.
3. User sends instruction in `MessageInput` (with optional `@path` mentions).
4. User monitors progress in `Live` + `EventDrawer`.
5. User inspects code changes in `Diff`.
6. User makes decision: **Accept** or **Request changes**.
7. Session moves to expected status bucket (Running/Ready/Done) with clear feedback.

**Make excellent (UX quality bar):**
- Fast time-to-first-token after session creation.
- Zero ambiguity about active session + active tab.
- Review decision buttons always visible and stateful (loading/success/error).
- One-click loop back: request changes → chat draft prefilled with actionable prompt.

### 2) Triage Many Sessions Quickly (Operations Flow)
**Why this is primary:** Power users will manage many concurrent sessions.

**Entry points:**
- Right panel buckets: Running / Ready / Done / Escalations
- Command palette session search

**Golden path:**
1. User scans session buckets and identifies items needing action.
2. Uses keyboard navigation/filter/command palette to jump between sessions.
3. For each session, checks `Live` for status, `Diff` for scope, `Tests/Trace` for confidence.
4. Takes decision or sends clarifying instruction.
5. Moves to next session with minimal context-switch cost.

**Make excellent (UX quality bar):**
- Bucket counts are always accurate and stable.
- Keyboard-first flow is frictionless (palette → search → enter → review → next).
- Preserve per-session tab memory so users land where they left off.
- Visual hierarchy makes “needs attention now” unmistakable.

### 3) Review Code Changes and Apply/Fix Patch In-Place
**Why this is primary:** Shipping depends on confident diff review.

**Entry points:**
- `SessionDetail` → `Diff` tab

**Golden path:**
1. User opens Diff and selects changed file/hotspot.
2. User inspects +/- context and generated patch.
3. Optionally edits patch draft and applies patch.
4. Validates outcome via tests/trace/live updates.
5. Accepts or requests further changes.

**Make excellent (UX quality bar):**
- File list + selected file context always obvious.
- Patch apply feedback immediate and explicit.
- Clear error affordance when patch fails (why + next action).
- Never lose patch draft accidentally.

### 4) Debug / Follow Execution in Real Time
**Why this is primary:** Users need trust through observability.

**Entry points:**
- `Live` tab
- `EventDrawer` (Messages / All / Failures / Audit)
- `Trace` tab

**Golden path:**
1. User watches active work items in Live.
2. Dives into event stream when something looks off.
3. Filters to Failures/Audit to isolate issue.
4. Uses trace/testing signals to determine corrective prompt.
5. Sends targeted follow-up in chat.

**Make excellent (UX quality bar):**
- Event feed remains readable under high volume.
- Filters are discoverable, sticky, and fast.
- Failure events are visually distinct and actionable.
- Smooth autoscroll behavior that respects manual scroll intent.

### 5) Workspace-Centric Authoring (Docs/Specs) + Dispatch to Session
**Why this is primary:** Many workflows start from markdown specs/context.

**Entry points:**
- `DocumentEditor` in center panel
- New file dropdown / markdown workspace

**Golden path:**
1. User opens/creates markdown doc in workspace.
2. Edits content with preview and frontmatter/template context.
3. Links relevant session/file context.
4. Dispatches workflow/message to a target session.
5. Tracks execution from session detail view.

**Make excellent (UX quality bar):**
- Editing feels native and safe (no accidental content loss).
- Dispatch target/session is explicit before send.
- Tight transition from doc authoring → session execution.
- Doc-to-session provenance visible in events.

### 6) Local App Preview Loop (Assistant URL → Browser Tool)
**Why this is primary:** Rapid validate/fix loop for UI/runtime tasks.

**Entry points:**
- Auto-detected localhost URL in assistant output
- Global tool switch to Browser tab

**Golden path:**
1. Assistant emits localhost URL.
2. UI auto-opens Browser tool with URL draft populated.
3. User previews app behavior.
4. User sends corrective instructions based on observed behavior.
5. Repeats until acceptance.

**Make excellent (UX quality bar):**
- Auto-launch feels helpful, never surprising.
- Easy return to prior context (session/tab) after preview.
- Browser tool state persists meaningfully per session/task.

## Prioritization (Do First)
1. **Session create → chat → review decision loop**
2. **Multi-session triage + command palette speed**
3. **Diff/patch confidence loop**
4. **Live/event observability loop**
5. **Doc authoring/dispatch loop**
6. **Browser preview loop**

## Surgical Execution Checklist

### P0 (this week)
- [ ] Remove friction from new session creation + immediate first message send.
- [ ] Guarantee clear status transitions after Accept/Request Changes.
- [ ] Tighten keyboard flow for triage (palette + next actionable session).
- [ ] Improve Diff tab feedback states (apply success/failure clarity).

### P1
- [ ] Make EventDrawer filters and failure surfacing sharper.
- [ ] Preserve context better across session switches (tab + scroll + draft).
- [ ] Improve doc-to-session dispatch clarity and auditability.

### P2
- [ ] Polish browser preview transitions and persistence.
- [ ] Visual/aesthetic consistency pass across all primary journey touchpoints.

## Implementation Anchors (Current Code)
- **Journey 1 (Create → Chat → Review):**
  - Create: `FileExplorer.tsx` `postCockpitSessionCreate` flow
  - Session detail + review actions: `SessionDetail.tsx`
  - Send message: `MessageInput.tsx`
  - Backend dispatch/review: `routes/sessions.ts` (message dispatch + decision handlers)
- **Journey 2 (Multi-session triage):**
  - Buckets + keyboard nav: `RightPanel.tsx`
  - Fuzzy jump/search: `CommandPalette.tsx`
- **Journey 3 (Diff/Patch confidence):**
  - Diff + patch apply: `tabs/DiffTab.tsx`
- **Journey 4 (Live observability):**
  - Active work stream: `tabs/LiveTab.tsx`
  - Event filtering/scrolling: `EventDrawer.tsx`
- **Journey 5 (Doc authoring + dispatch):**
  - Markdown authoring surface: `DocumentEditor.tsx`
  - Markdown/workflow-aware dispatch path: `routes/sessions.ts`
- **Journey 6 (Browser preview loop):**
  - Auto localhost detect + browser tool switch: `CenterPanel.tsx`

## Primary UX KPI Suggestions (for these journeys)
- Time-to-first-token after session creation
- Session-switch time (triage)
- Diff decision latency (open diff → accept/request changes)
- Failure-to-fix loop time (failure event → follow-up message)
- Doc-to-dispatch completion rate
- Browser preview return-to-context success rate