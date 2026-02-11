# Cockpit UI Design

## Layout

Three-panel layout with center chat interface. Dense, no padding, single-line separators.

```
┌────────────────┬───────────────────────────────────┬──────────────────┐
│RUNNING         │FOCUS                              │QUEUE             │
│[A]🔧Feature    │┌─────────────────────────────────┐│[A]🔶 arch q...   │
│  auth-refactor ││ 🔶 ARCHITECTURAL                ││[B]🔴 perm req... │
│  +142/-38 12m  ││ JWT vs opaque tokens?           ││                  │
│  🔨bash        ││ Leaning opaque, we have Redis   ││COMMITS           │
│[B]🐛Issue #42  │├─────────────────────────────────┤│[C]abc123 fix...  │
│  fix-login     ││MESSAGES                         ││[D]def456 add...  │
│  +12/-4 3m     ││🤖 WorkItem: refactor auth       ││                  │
│────────────────││🤖 Starting with token service   ││OPEN PRs          │
│READY           ││👤 Use existing session util     ││[E]#123 feature X │
│[C]✅ Issue #38 ││🤖 Switching approach...         ││[F]#124 bugfix    │
│────────────────││🤖 Question: JWT or opaque?      ││                  │
│DONE            ││                                 ││                  │
│[D]✅ Feature   ││                                 ││                  │
│────────────────│├─────────────────────────────────┤│                  │
│METRICS         ││[Type message...]                ││                  │
│In:12k Out:8k   │└─────────────────────────────────┘│                  │
│+500/-120 LOC   │                                   │                  │
│4 commits 1 PR  │                                   │                  │
└────────────────┴───────────────────────────────────┴──────────────────┘
```

---

## Panels

### Left Panel

#### RUNNING
Active sessions currently executing work.

Each session card displays (without expansion):
- **Type indicator**: Feature, Issue, Prototype, Refactor
- **Session name/goal**
- **LOC delta**: `+142/-38`
- **Time elapsed**: `12m`
- **Current activity**: tool indicator like TUI (e.g., `🔨bash`, `📝edit`, `🔍grep`)

#### READY
Sessions that finished their workflow and await final review/intervention.

#### DONE
Completed sessions (collapsible/tab).

#### METRICS
Daily aggregates:
- Token usage: input/output
- LOC: added/deleted
- Commits count
- PRs count

### Center Panel

#### FOCUS
The currently selected item from any panel. Displays contextual content:
- **Escalation**: question, options, references, watcher's opinion
- **Session**: goal, current objective, relevant context
- **Commit**: diff summary, message
- **PR**: title, description, status

#### MESSAGES
Event stream for the focused session:
- User/assistant conversation messages
- WorkItem lifecycle events (created, split, completed)
- Agent summary messages after work blocks
- Escalation questions inline

#### INPUT
Text input bound to focused session. Send message → backend routes via `sessionKey`.

### Right Panel

#### QUEUE
Pending escalations. Newest first.

Each card shows:
- Type badge (architectural, permission, uncertainty, etc.)
- Brief title/question

#### COMMITS
Recent git commits across all sessions.

#### OPEN PRs
Pull requests awaiting review or action.

---

## Interaction Model

### Focus Flow
1. Click item in any panel (or use keyboard shortcut)
2. Item loads into FOCUS area
3. MESSAGES stream populates with that session's conversation
4. INPUT binds to that session's context
5. Type response → sent with `sessionKey` → backend hydrates context

### Session Key is Everything
Backend handles statefulness via session keys. Frontend just sends `{sessionKey, message}`. Conversations feel stateful as long as context hasn't compacted.

### Escalations are Conversational
Watcher asks questions like a coworker would:
> "Hey, working on the auth refactor. Should I use JWT or opaque tokens? JWT is stateless but revocation is painful. Opaque needs DB lookups but revocation is trivial. Leaning toward opaque given we already have Redis. Thoughts?"

User responds naturally. No form-fill UI.

### TUI-like Subscription
Subscribe to sessions like TUI does:
- Receive WorkItem events (created, split, realign, completed)
- Receive tool activity updates
- Receive agent summary messages

---

## Keyboard Navigation

| Shortcut | Action |
|----------|--------|
| `1` | Focus left panel |
| `2` | Focus center panel |
| `3` | Focus right panel |
| `A-Z` | Jump to row in current panel |
| `1A` | Direct: left panel, row A |
| `3C` | Direct: right panel, row C |
| `↑/↓` | Navigate rows in panel |
| `Enter` | Select/focus item |
| `Esc` | Return to input |

---

## Design Principles

1. **Dense** - No wasted space, tight layout, single-line borders
2. **Always visible** - All panels remain visible, no hidden state
3. **Queue workflow** - Focus on one item, resolve, move to next
4. **Keyboard-first** - Full navigation without mouse
5. **Conversational** - Escalations and sessions use natural chat, not forms

---

## Deferred

### Localhost Viewer
Embed preview of running web apps via iframe proxy:
- Route: `/preview?port=3000` proxies to `localhost:3000`
- Same origin, no CORS issues
- Toggle-able panel or modal

### PR Diff Viewer
When PR is focused, optionally expand to show:
- File tree with diff stats
- Split diff view
- Inline comments

These are separate modes/views, not embedded in the standard chat layout.
