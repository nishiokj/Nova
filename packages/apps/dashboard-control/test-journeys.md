# Cockpit Dashboard — User Journey Test Scripts

> Repeatable browser-based test scripts for the cockpit control dashboard.
> Target: `http://localhost:5175`
> Last tested: 2026-02-06

---

## Journey 1: Keyboard-Only Markdown Authoring

**Goal:** Create a new markdown file via keyboard, write content, preview it, chat about it with the harness, have the harness modify it, then upgrade it.

### Steps

1. **Navigate to dashboard**
   - `agent-browser open http://localhost:5175`
   - `agent-browser screenshot /tmp/j1-step1.png`
   - Verify: 3-panel layout visible (left file explorer, center editor with `# Start writing...`, right session list with RUNNING/READY/DONE headers)

2. **Create new file via Ctrl+N**
   - `agent-browser press Control+n`
   - `agent-browser screenshot /tmp/j1-step2.png`
   - Verify: NewFileDropdown modal appears with:
     - Filename input focused, default value `untitled.md`
     - Folder list below (notes/, scratch/, packets/ (new), plans/ (new), handoffs/ (new))
     - Instructions: "↑/↓ select folder · Enter confirm · Esc cancel"

3. **Select scratch folder via arrow keys**
   - `agent-browser press ArrowDown` (repeat until scratch/ is highlighted)
   - `agent-browser screenshot /tmp/j1-step3.png`
   - Verify: "scratch/" row has highlight background

4. **Name the file and confirm**
   - `agent-browser snapshot -i` (find filename textbox ref)
   - `agent-browser fill @e<N> "test-journey-1.md"`
   - `agent-browser press Enter`
   - `agent-browser screenshot /tmp/j1-step4.png`
   - Verify: Dropdown closes, `test-journey-1.md` appears under scratch/ in left panel with cyan highlight, center header shows `scratch/test-journey-1.md`, status bar says "loaded"

5. **Write markdown content**
   - `agent-browser snapshot -i` (find editor textarea ref)
   - `agent-browser click @e<N>` (focus editor)
   - `agent-browser press Control+a` (select all placeholder text)
   - `agent-browser type @e<N> "# Test Journey Document\n\nThis is a test.\n\n## Section One\n- Item A\n- Item B"`
   - `agent-browser screenshot /tmp/j1-step5.png`
   - Verify: Content appears in editor, status bar should show dirty/unsaved state

6. **Wait for autosave (~1.5s)**
   - `agent-browser wait 2000`
   - `agent-browser screenshot /tmp/j1-step6.png`
   - Verify: Status shows "Saved" with version number, status bar says "Autosaved scratch/test-journey-1.md"

7. **Test Ctrl+S manual save**
   - Add a small edit: `agent-browser type @e<N> "\n- Item C"`
   - `agent-browser press Control+s`
   - `agent-browser screenshot /tmp/j1-step7.png`
   - **KNOWN BUG (Critical):** Ctrl+S can crash the React app. Console errors: `Cannot access 'refreshMarkdownWorkspace' before initialization` (TDZ error) followed by `Rendered more hooks than during the previous render`. Screen goes completely black. Requires page reload to recover.

8. **Check for markdown preview**
   - `agent-browser snapshot -i`
   - Search for any "Preview", "Render", or split-view toggle button
   - **CONFIRMED BUG (Major):** No markdown preview exists. Editor is raw textarea only.

9. **Open chat with Ctrl+`**
   - `agent-browser press Control+\``
   - `agent-browser screenshot /tmp/j1-step9.png`
   - Verify: Event drawer expands with "▾ Chat (N)" header, Messages filter active, message input textarea appears with placeholder "Message tui_...", hint shows "Ctrl+Enter send · Esc close"

10. **Send message to harness**
    - `agent-browser snapshot -i` (find message textarea ref)
    - `agent-browser fill @e<N> "Review this markdown file"`
    - `agent-browser press Control+Enter`
    - `agent-browser wait 1000`
    - `agent-browser screenshot /tmp/j1-step10.png`
    - Verify: Message appears in chat as "You Nm ago" with content

11. **Close chat with Escape**
    - `agent-browser press Escape`
    - Verify: Message input collapses, event drawer may remain

12. **Check for Upgrade to Spec/Issue**
    - `agent-browser snapshot -i`
    - Search all interactive elements for "Upgrade", "Spec", "Issue", "Convert"
    - **CONFIRMED BUG (Major):** No upgrade-to-spec/issue UI exists.

---

## Journey 2: Panel Navigation with Alt+H,J,K,L

**Goal:** Toggle between panels using vim-style Alt+movement keys.

### Prerequisites
- Focus must already be inside the cockpit (click any element first)
- **KNOWN BUG:** Alt+HJKL does nothing on fresh page load because the `insideCockpit` guard in `use-keyboard.ts:86-87` fails when `document.activeElement === BODY`

### Steps

1. **Establish focus inside cockpit**
   - `agent-browser open http://localhost:5175`
   - `agent-browser snapshot -i` (find editor textarea ref)
   - `agent-browser click @e<N>` (click editor to place focus inside cockpit)

2. **Test Alt+H — focus left panel**
   - `agent-browser press Alt+h`
   - `agent-browser eval "document.activeElement?.getAttribute('data-cockpit-pane')"`
   - Verify: Returns `"left"`
   - **CONFIRMED BUG (Medium):** No visual focus indicator. Panes have `focus:outline-none` CSS. Focus moves correctly (verified via JS) but user sees no change.

3. **Test Alt+L — focus right panel**
   - `agent-browser press Alt+l`
   - `agent-browser eval "document.activeElement?.getAttribute('data-cockpit-pane')"`
   - Verify: Returns `"right"`

4. **Test Alt+J — focus center panel**
   - `agent-browser press Alt+j`
   - `agent-browser eval "document.activeElement?.tagName"`
   - Verify: Returns `"TEXTAREA"` (editor gets focus when no session selected)
   - When session is selected, returns `"SECTION"` (center pane)

5. **Test Alt+K — focus center panel**
   - `agent-browser press Alt+k`
   - Same behavior as Alt+J (both J and K map to center — no up/down distinction, only left/center/right)

6. **Verify no-op on fresh page (bug repro)**
   - `agent-browser reload`
   - `agent-browser wait 2000`
   - `agent-browser press Alt+h`
   - `agent-browser eval "document.activeElement?.getAttribute('data-cockpit-pane')"`
   - Verify: Returns `null` — Alt+H is silently ignored because focus is on BODY

---

## Journey 3: File Explorer Navigation

**Goal:** Navigate folders and files in the left panel using keyboard and mouse.

### Steps

1. **Navigate to dashboard**
   - `agent-browser open http://localhost:5175`
   - `agent-browser wait 2000`
   - `agent-browser screenshot /tmp/j3-step1.png`
   - Verify: Left panel shows `.cockpit/markdown` root with folder tree

2. **Expand/collapse folders by clicking**
   - `agent-browser snapshot -i` (find folder button refs, e.g. "▾notes")
   - `agent-browser click @e<notes>` (toggle notes folder)
   - `agent-browser screenshot /tmp/j3-step2a.png`
   - Verify: Arrow changes ▾→▸, child files hidden
   - Click again: Arrow changes ▸→▾, child files reappear

3. **Select a markdown file**
   - `agent-browser snapshot -i`
   - `agent-browser click @e<file>` (click a .md file)
   - `agent-browser screenshot /tmp/j3-step3.png`
   - Verify: File row gets cyan highlight, center editor loads file content, header shows file path + version, status bar shows "loaded"

4. **Right-click context menu**
   - Dispatch contextmenu event on folder element:
     ```js
     agent-browser eval "const el = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('scratch')); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2})); 'done'"
     ```
   - `agent-browser screenshot /tmp/j3-step4.png`
   - Verify: Custom context menu appears with "New File" and "New Folder" options

5. **Test keyboard navigation in file tree**
   - `agent-browser press Alt+h` (focus left pane)
   - `agent-browser press ArrowDown`
   - `agent-browser press ArrowUp`
   - **CONFIRMED BUG (Medium):** No arrow-key navigation for file tree. Arrow keys do nothing when file explorer has focus. No way to select files or expand/collapse folders via keyboard.

6. **Verify file persistence after reload**
   - Select a file, note its content
   - `agent-browser reload`
   - `agent-browser wait 2000`
   - **CONFIRMED BUG (Medium):** Selected file is lost on reload. Editor reverts to `untitled.md` with placeholder. No URL state or localStorage persistence for selected file path.

---

## Journey 4: Session Interaction Workflow

**Goal:** Select a running session, inspect its details across tabs, interact via chat.

### Steps

1. **Navigate to dashboard**
   - `agent-browser open http://localhost:5175`
   - `agent-browser wait 2000`

2. **Click a session card**
   - `agent-browser snapshot -i`
   - `agent-browser find text "<session_key>" click` (use session key from right panel)
   - `agent-browser wait 1500` (allow focus data to load)
   - `agent-browser screenshot /tmp/j4-step2.png`
   - Verify: Center panel switches to session detail with title, session key, tool status badge, tab bar (Packet/Diff/Tests/Trace/Lens/Browser), event drawer at bottom
   - **NOTE:** First click may not work — the session card button's click handler may need a precise hit target. If center panel doesn't change, click the session key text specifically.

3. **Test letter shortcuts (requires center pane focus)**
   - `agent-browser press Alt+j` (focus center pane)
   - `agent-browser press d` — verify Diff tab activates
   - `agent-browser press t` — verify Tests tab activates
   - `agent-browser press l` — verify Trace tab activates
   - `agent-browser press x` — verify Packet tab activates
   - `agent-browser press q` — verify Lens tab activates
   - `agent-browser press b` — verify Browser tab activates

4. **Test Tab cycling**
   - `agent-browser press Tab` — next tab
   - `agent-browser press Shift+Tab` — previous tab
   - Verify: Tab cycling only works when center pane has focus (`activePane === 'center'`)

5. **Open chat on session**
   - `agent-browser press Control+\``
   - `agent-browser screenshot /tmp/j4-step5.png`
   - Verify: Event drawer opens, chat messages visible, input with session key placeholder

6. **Return to document editor**
   - Press Escape to close chat
   - **CONFIRMED BUG (Medium):** No keyboard shortcut to clear focusTarget and return to document editor. Must reload page or click a file in the left panel.

---

## Journey 5: Escalation Workflow

**Goal:** View, acknowledge, and resolve an escalation from the cockpit.

### Steps

1. **Navigate to dashboard**
   - `agent-browser open http://localhost:5175`
   - Check right panel for yellow Escalations section

2. **Click an escalation card** (only if escalations exist)
   - `agent-browser snapshot -i`
   - Click escalation card button
   - Verify: Center panel shows escalation packet with Resolve button

3. **Resolve escalation**
   - Press `r` key (or click Resolve button)
   - Verify: Resolution prompt appears
   - Type note and confirm

---

## Journey 6: Header & Status Bar

**Goal:** Verify header metrics and status bar behavior.

### Steps

1. **Check header**
   - `agent-browser open http://localhost:5175`
   - `agent-browser screenshot /tmp/j6-step1.png`
   - Verify: Header shows "Cockpit" title, session counts (Running N · Ready N · Done N), timestamp

2. **Verify status bar messages**
   - Status bar at bottom shows transient messages (file loaded, autosaved, errors)
   - `agent-browser eval "document.querySelector('[class*=status]')?.textContent"`

---

## Bug Report — Browser Test Results (2026-02-06)

### Critical

| # | Bug | Reproduction | Root Cause |
|---|-----|-------------|------------|
| B1 | **Ctrl+S crashes React app** — Screen goes completely black. All UI elements disappear. | Type content in editor → Press Ctrl+S → Screen goes blank, no interactive elements remain | Console shows: `Cannot access 'refreshMarkdownWorkspace' before initialization` (TDZ error, 22x), followed by `Rendered more hooks than during the previous render` (4x). The save triggers a state update that causes a hook ordering violation. Also `describeActiveTool is not defined` reference error. |
| B2 | **`pendingCount` ignores acknowledged escalations** | Acknowledge an escalation → pendingCount drops to 0 → session transitions from blocked to active while escalation is unresolved | `escalation_state.ts:179` only filters for `status === 'pending'`, should include `'acknowledged'` |

### Major

| # | Bug | Reproduction | Impact |
|---|-----|-------------|--------|
| B3 | **No markdown preview/render mode** | Open any .md file in editor → Look for preview toggle | Editor is raw textarea only. No way to see rendered markdown. Users must mentally parse markdown syntax. |
| B4 | **No "Upgrade to Spec/Issue" UI** | Search all interactive elements in any view | Backend endpoints exist (`POST /cockpit/packets`, `POST /cockpit/markdown/import`) but no frontend UI to invoke them. |
| B5 | **`mapSessionStatus('blocked')` returns 'running'** | Have a blocked session → Check right panel | Blocked sessions show as "RUNNING" — indistinguishable from active sessions. No blocked indicator in cockpit. |
| B6 | **`diffstat.added/deleted` hardcoded to 0** | Check any session card in right panel | All sessions show +0/-0 diff stats regardless of actual changes. |
| B7 | **Alt+HJKL silently fails on fresh page load** | Reload page → Press Alt+H without clicking anything first | `use-keyboard.ts:86-87` has `insideCockpit` guard that checks `inCockpit(target) || inCockpit(activeElement)`. When `activeElement === BODY`, both return false and the handler exits. The cockpit root `data-cockpit-root="true"` is a child of BODY, not BODY itself. |

### Medium

| # | Bug | Reproduction | Impact |
|---|-----|-------------|--------|
| B8 | **No visual focus indicator for panel navigation** | Press Alt+H/J/K/L (after clicking inside cockpit) | Focus moves correctly (verified via `document.activeElement`) but user sees zero visual change. All panes have `focus:outline-none` in CSS. Keyboard users have no idea which panel is active. |
| B9 | **No keyboard navigation for file explorer** | Focus left panel (Alt+H) → Press arrow keys | Arrow keys do nothing. No way to navigate files/folders, expand/collapse, or open files via keyboard. Must use mouse. |
| B10 | **Selected file lost on page reload** | Select a file → Reload page | Editor reverts to `untitled.md` placeholder. No URL hash, query param, or localStorage persistence for the selected file path. |
| B11 | **No keyboard shortcut to return to document editor from session view** | Click a session card → Try to get back to editor | No Escape-to-deselect, no shortcut to clear `focusTarget`. Must reload page or click a file in the left panel. |
| B12 | **Session card click sometimes doesn't register** | Click a session card in right panel | First click may not switch center panel. May need to click specifically on the session key text rather than the card body. |

### Low

| # | Bug | Reproduction | Impact |
|---|-----|-------------|--------|
| B13 | **500 errors from control plane on initial load** | Check browser console on page load | Multiple `API error: 500 Internal Server Error` and `Failed to fetch` errors. Likely from backend endpoints not being ready or returning errors for missing data. |
| B14 | **Alt+J and Alt+K are identical** | Press Alt+J, then Alt+K | Both map to center pane. No up/down distinction in a 3-column layout. Consider making J/K cycle through panels sequentially instead. |

### Working Correctly

| Feature | Status |
|---------|--------|
| Ctrl+N new file picker | Working — modal opens, folder picker responds to arrow keys, file creation succeeds |
| Folder expand/collapse (click) | Working — ▸/▾ toggles correctly |
| File selection (click) | Working — cyan highlight, content loads, path + version shown |
| Right-click context menu | Working — shows New File / New Folder options |
| Editor autosave (1400ms debounce) | Working — triggers after typing stops, version increments, status bar confirms |
| Ctrl+` chat toggle | Working — event drawer opens/closes, message input appears |
| Session detail view | Working — title, key, tool status, tab bar, event drawer all render |
| Letter shortcuts (d/t/l/x/q/b) | Working — tabs switch correctly when center pane focused |
| Tab/Shift+Tab cycling | Working — cycles through 6 session tabs |
| Tab key in editor mode | Working — inserts tab character (not browser tab navigation) |
