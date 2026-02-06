---
session: tui_1770351975390_rhf6df
created: 2026-02-06T04:26:15.390Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770352448199
The signal to noise ratio at this moment for the control dashboard is HORRIBLE. use the agent-browser skill and see for yourself. If you were orchestrating how would you feel if that's whay you had to work with? There's way too much 'log' like signal, literally nothing of use. Why wond't we show the added / subtraced line nums in the preview card on the right? We don't need to stream each Tool call into the messages stream like that. The tool calls can be used more as a status to show responsiveness. Instead we should be putting actual words and phrases the agent is saying during execution. We don't really need to see memory injected in the message stream either. These things are more a part of Audit. Think in terms of UX, how do GREATLY shift from the noise to signal ration? 

### function_call
@callId call_af721dc423034e71af4336d5
@name Skill
@ts 1770352454941
@workItemId 68ac7230
{"skill":"agent-browser","args":"Navigate to the control dashboard and observe the message stream. Focus on identifying:\n1. What kinds of messages are being streamed (tool calls, memory injections, agent responses)\n2. The noise vs signal ratio in the message feed\n3. The preview card content on the right side\n4. Overall UX from the perspective of an orchestrator\n\nTake screenshots and provide detailed observations."}

### function_call_output
@callId call_af721dc423034e71af4336d5
@ts 1770352454942
@durationMs 1
@workItemId 68ac7230
# Browser Automation with agent-browser

## Quick start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser close             # Close browser
```

## Core workflow

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
agent-browser open <url>      # Navigate to URL (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser close           # Close browser (aliases: quit, exit)
agent-browser connect 9222    # Connect to browser via CDP port
```

### Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
```

### Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser dblclick @e1        # Double-click
agent-browser focus @e1           # Focus element
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key (alias: key)
agent-browser press Control+a     # Key combination
agent-browser keydown Shift       # Hold key down
agent-browser keyup Shift         # Release key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select dropdown option
agent-browser select @e1 "a" "b"  # Select multiple options
agent-browser scroll down 500     # Scroll page (default: down 300px)
agent-browser scrollintoview @e1  # Scroll element into view (alias: scrollinto)
agent-browser drag @e1 @e2        # Drag and drop
agent-browser upload @e1 file.pdf # Upload files
```

### Get information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get count ".item"   # Count matching elements
agent-browser get box @e1         # Get bounding box
agent-browser get styles @e1      # Get computed styles (font, color, bg, etc.)
```

### Check state

```bash
agent-browser is visible @e1      # Check if visible
agent-browser is enabled @e1      # Check if enabled
agent-browser is checked @e1      # Check if checked
```

### Screenshots & PDF

```bash
agent-browser screenshot          # Save to a temporary directory
agent-browser screenshot path.png # Save to a specific path
agent-browser screenshot --full   # Full page
agent-browser pdf output.pdf      # Save as PDF
```

### Video recording

```bash
agent-browser record start ./demo.webm    # Start recording (uses current URL + state)
agent-browser click @e1                   # Perform actions
agent-browser record stop                 # Stop and save video
agent-browser record restart ./take2.webm # Stop current + start new recording
```

Recording creates a fresh context but preserves cookies/storage from your session. If no URL is provided, it
automatically returns to your current page. For smooth demos, explore first, then start recording.

### Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text (or -t)
agent-browser wait --url "**/dashboard"    # Wait for URL pattern (or -u)
agent-browser wait --load networkidle      # Wait for network idle (or -l)
agent-browser wait --fn "window.ready"     # Wait for JS condition (or -f)
```

### Mouse control

```bash
agent-browser mouse move 100 200      # Move mouse
agent-browser mouse down left         # Press button
agent-browser mouse up left           # Release button
agent-browser mouse wheel 100         # Scroll wheel
```

### Semantic locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find text "Sign In" click --exact      # Exact match only
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
agent-browser find alt "Logo" click
agent-browser find title "Close" click
agent-browser find testid "submit-btn" click
agent-browser find first ".item" click
agent-browser find last ".item" click
agent-browser find nth 2 "a" hover
```

### Browser settings

```bash
agent-browser set viewport 1920 1080          # Set viewport size
agent-browser set device "iPhone 14"          # Emulate device
agent-browser set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
agent-browser set offline on                  # Toggle offline mode
agent-browser set headers '{"X-Key":"v"}'     # Extra HTTP headers
agent-browser set credentials user pass       # HTTP basic auth (alias: auth)
agent-browser set media dark                  # Emulate color scheme
agent-browser set media light reduced-motion  # Light mode + reduced motion
```

### Cookies & Storage

```bash
agent-browser cookies                     # Get all cookies
agent-browser cookies set name value      # Set cookie
agent-browser cookies clear               # Clear cookies
agent-browser storage local               # Get all localStorage
agent-browser storage local key           # Get specific key
agent-browser storage local set k v       # Set value
agent-browser storage local clear         # Clear all
```

### Network

```bash
agent-browser network route <url>              # Intercept requests
agent-browser network route <url> --abort      # Block requests
agent-browser network route <url> --body '{}'  # Mock response
agent-browser network unroute [url]            # Remove routes
agent-browser network requests                 # View tracked requests
agent-browser network requests --filter api    # Filter requests
```

### Tabs & Windows

```bash
agent-browser tab                 # List tabs
agent-browser tab new [url]       # New tab
agent-browser tab 2               # Switch to tab by index
agent-browser tab close           # Close current tab
agent-browser tab close 2         # Close tab by index
agent-browser window new          # New window
```

### Frames

```bash
agent-browser frame "#iframe"     # Switch to iframe
agent-browser frame main          # Back to main frame
```

### Dialogs

```bash
agent-browser dialog accept [text]  # Accept dialog
agent-browser dialog dismiss        # Dismiss dialog
```

### JavaScript

```bash
agent-browser eval "document.title"   # Run JavaScript
```

## Global options

```bash
agent-browser --session <name> ...    # Isolated browser session
agent-browser --json ...              # JSON output for parsing
agent-browser --headed ...            # Show browser window (not headless)
agent-browser --full ...              # Full page screenshot (-f)
agent-browser --cdp <port> ...        # Connect via Chrome DevTools Protocol
agent-browser -p <provider> ...       # Cloud browser provider (--provider)
agent-browser --proxy <url> ...       # Use proxy server
agent-browser --headers <json> ...    # HTTP headers scoped to URL's origin
ag
... [truncated 4954 chars]

### function_call
@callId call_102b760d8f0d4c7abf05fc8c
@name Bash
@ts 1770352458219
@workItemId 68ac7230
{"command":"agent-browser open http://localhost:5173 2>&1 || agent-browser open http://localhost:3000 2>&1 || echo \"Need to find the dashboard URL\""}

### function_call_output
@callId call_102b760d8f0d4c7abf05fc8c
@ts 1770352458461
@durationMs 242
@workItemId 68ac7230
[32m✓[0m [1mControl Plane[0m
  [2mhttp://localhost:5173/[0m


### function_call
@callId call_446bed6f339a49cdbc972954
@name Bash
@ts 1770352462297
@workItemId 68ac7230
{"command":"agent-browser snapshot -i 2>&1 | head -100"}

### function_call_output
@callId call_446bed6f339a49cdbc972954
@ts 1770352462556
@durationMs 259
@workItemId 68ac7230
- button "..." [ref=e1]
- button "Running" [ref=e2]
- button "Ready" [ref=e3]
- button "Done" [ref=e4]
- button "Packet (M)" [ref=e5]
- button "Diff (D)" [ref=e6]
- button "Tests (T)" [ref=e7]
- button "Trace (L)" [ref=e8]
- button "Lens (Q)" [ref=e9]
- button "All" [ref=e10]
- button "Messages" [ref=e11]
- button "Tools" [ref=e12]
- button "Failures" [ref=e13]
- textbox "Select a session first" [ref=e14]
- button "Send" [ref=e15] [disabled]
- button "Escalations (0)" [ref=e16]
- button "Commits (0)" [ref=e17]
- button "Open PRs (0)" [ref=e18]


### function_call
@callId call_fdccc36563ed48f79e08d374
@name Bash
@ts 1770352467542
@workItemId 68ac7230
{"command":"agent-browser screenshot 2>&1"}

### function_call_output
@callId call_fdccc36563ed48f79e08d374
@ts 1770352467728
@durationMs 168
@workItemId 68ac7230
[32m✓[0m Screenshot saved to [32m/Users/jevinnishioka/.agent-browser/tmp/screenshots/screenshot-2026-02-06T04-34-27-583Z-rf07n5.png[0m


### function_call
@callId call_e139387d5a8f4b8f9446330f
@name Bash
@ts 1770352469549
@workItemId 68ac7230
{"command":"agent-browser screenshot --full 2>&1"}

### function_call_output
@callId call_e139387d5a8f4b8f9446330f
@ts 1770352469735
@durationMs 185
@workItemId 68ac7230
[32m✓[0m Screenshot saved to [32m/Users/jevinnishioka/.agent-browser/tmp/screenshots/screenshot-2026-02-06T04-34-29-572Z-5b9960.png[0m


### function_call
@callId call_e658cc4736614438a2b53b86
@name explorer
@ts 1770352473569
@workItemId 68ac7230
{"objective":"Understand the control dashboard message stream implementation. I need to find:\n1. How messages are being streamed to the dashboard (what types, how they're filtered)\n2. The preview card component and what it displays\n3. The overall data flow from harness to dashboard\n4. Where noise (tool calls, memory injections) vs signal (agent responses, decisions) is determined","targetPaths":["packages/dashboard-control","packages/harness-daemon/src/harness","packages/protocol"]}

### function_call_output
@callId call_e658cc4736614438a2b53b86
@ts 1770352553010
@isError true
@durationMs 79441
@workItemId 68ac7230
Sub-agent 'explorer' failed (reason: invalid_action): Explorer read 3 files but extracted 0 artifacts. This is a hard failure. Every file read MUST produce artifacts. Files read: /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts, /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts
Tools called: 18 (15 succeeded, 3 failed)
Partial output:
<tool_call>Read<arg_key>path</arg_key><arg_value>/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx</arg_value><arg_key>endLine</arg_key><arg_value>2452</arg_value><arg_key>startLine</arg_key><arg_value>2300</arg_value></tool_call>

### function_call
@callId call_d196815ad93b40078721721e
@name Read
@ts 1770352555108
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_d196815ad93b40078721721e
@ts 1770352555119
@durationMs 9
@workItemId 68ac7230
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyCockpitPatch,
  getCockpitBrowserState,
  getCockpitCommitRollups,
  getCockpitDiff,
  getCockpitDailyMetrics,
  getCockpitEscalationRollups,
  getCockpitFocus,
  getCockpitPreview,
  getCockpitPRRollups,
  getCockpitSessionEvents,
  getCockpitSessionRollups,
  getCockpitTestReport,
  getCockpitTestReports,
  getCockpitTraces,
  postCockpitBrowserAction,
  postCockpitBrowserRunbook,
  postCockpitSessionMessage,
  postCockpitSessionControl,
  postCockpitSessionReviewDecision,
  resolveCockpitEscalation,
  searchCockpitRepoLens,
  type CommitRollup,
  type CockpitBrowserActionInput,
  type CockpitBrowserState,
  type CockpitDiff,
  type CockpitTestReport,
  type DailyMetrics,
  type EscalationRollup,
  type FocusData,
  type NormalizedSessionEvent,
  type PRRollup,
  type RepoLensMatch,
  type SessionRollup,
  type TraceRecord,
} from './lib/api';

const POLL_INTERVAL_MS = 5000;

type FocusTarget =
  | { type: 'session'; id: string }
  | { type: 'escalation'; id: string };

type FocusTab = 'packet' | 'diff' | 'tests' | 'trace' | 'lens' | 'browser';
type PanelFocus = 'left' | 'center' | 'right' | 'input';
type LeftSection = 'running' | 'ready' | 'done' | 'metrics';
type RightSection = 'queue' | 'commits' | 'prs';
type TrustTier = 'proven' | 'computed' | 'heuristic';
type EventFilter = 'all' | 'messages' | 'tools' | 'failures';

const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'done', 'metrics'];
const RIGHT_SECTIONS: RightSection[] = ['queue', 'commits', 'prs'];
const CENTER_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;
const DEFAULT_BROWSER_RUNBOOK = [
  '# One command per line',
  '# open https://example.com',
  '# snapshot -i -c',
  '# click @e1',
  '# fill @e2 \"search query\"',
  '# press Enter',
  '# screenshot smoke-check',
].join('\n');

interface PacketFrontmatter {
  type?: string;
  sessionKey?: string;
  workItemId?: string;
  requestedDecision?: string;
  priority?: string;
  links: Array<{ label: string; target: string }>;
  refs: Array<{ type: string; target: string }>;
}

interface ParsedPacketMarkdown {
  frontmatter: PacketFrontmatter | null;
  bodyMarkdown: string;
}

function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePacketMarkdown(markdown: string): ParsedPacketMarkdown {
  if (!markdown.startsWith('---')) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  let endIndex = -1;
  for (let idx = 1; idx < lines.length; idx += 1) {
    if (lines[idx].trim() === '---') {
      endIndex = idx;
      break;
    }
  }
  if (endIndex < 0) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }

  const scalar: Record<string, string> = {};
  const links: Array<{ label: string; target: string }> = [];
  const refs: Array<{ type: string; target: string }> = [];
  let section: string | null = null;

  for (const rawLine of lines.slice(1, endIndex)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const isRoot = !rawLine.startsWith(' ') && !rawLine.startsWith('\t');
    if (isRoot) {
      const rootMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!rootMatch) {
        section = null;
        continue;
      }
      const key = rootMatch[1];
      const value = rootMatch[2];
      if (value) {
        scalar[key] = unquoteYamlValue(value);
        section = null;
      } else {
        section = key.toLowerCase();
      }
      continue;
    }

    const nested = trimmed;
    if (section === 'links') {
      const linkMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (linkMatch) {
        links.push({
          label: linkMatch[1],
          target: unquoteYamlValue(linkMatch[2]),
        });
      }
      continue;
    }

    if (section === 'refs') {
      const refMatch = nested.match(/^-+\s*([A-Za-z0-9_-]+):\s*(.+)$/);
      if (refMatch) {
        refs.push({
          type: refMatch[1],
          target: unquoteYamlValue(refMatch[2]),
        });
      }
    }
  }

  const frontmatter: PacketFrontmatter | null = (
    Object.keys(scalar).length > 0 || links.length > 0 || refs.length > 0
  )
    ? {
        type: scalar.type,
        sessionKey: scalar.sessionKey,
        workItemId: scalar.workItemId,
        requestedDecision: scalar.requestedDecision,
        priority: scalar.priority,
        links,
        refs,
      }
    : null;

  let bodyMarkdown = lines.slice(endIndex + 1).join('\n');
  while (bodyMarkdown.startsWith('\n')) {
    bodyMarkdown = bodyMarkdown.slice(1);
  }

  return {
    frontmatter,
    bodyMarkdown,
  };
}

function cycleList<T>(list: T[], current: T, delta = 1): T {
  const index = list.indexOf(current);
  const currentIndex = index >= 0 ? index : 0;
  const next = (currentIndex + delta + list.length) % list.length;
  return list[next];
}

function cycleIndex(length: number, current: number, delta: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return length - 1;
  if (next >= length) return 0;
  return next;
}

function shaShortMatches(candidate: string | undefined, target: string): boolean {
  if (!candidate) return false;
  const left = candidate.toLowerCase();
  const right = target.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function trustTone(tier: TrustTier): string {
  if (tier === 'proven') return 'text-[var(--success)] bg-[var(--success)]/10';
  if (tier === 'computed') return 'text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/10';
  return 'text-[var(--warning)] bg-[var(--warning)]/10';
}

function formatRelativeFromIso(iso: string): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function eventLabel(event: NormalizedSessionEvent): string {
  if (event.type === 'message') {
    const role = typeof event.payload.role === 'string' ? event.payload.role : 'message';
    return role;
  }
  if (event.type === 'tool') {
    const data = event.payload.data as Record<string, unknown> | undefined;
    const tool = typeof data?.tool_name === 'string' ? data.tool_name : event.payload.eventType;
    return String(tool ?? 'tool');
  }
  return String(event.payload.eventType ?? event.type);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function gateSummaryText(header: Record<string, unknown> | undefined): string | null {
  const gate = asRecord(header?.gateState);
  if (!gate) return null;
  const tests = typeof gate.testsStatus === 'string' ? gate.testsStatus : 'unknown';
  const invariants = typeof gate.invariantsStatus === 'string' ? gate.invariantsStatus : 'unknown';
  const blocking = typeof header?.blocking === 'number' ? header.blocking : null;
  return `tests:${tests} · invariants:${invariants}${blocking !== null ? ` · blocked:${blocking}` : ''}`;
}

function isFailureEvent(event: NormalizedSessionEvent): boolean {
  const payload = event.payload ?? {};
  const eventType = String(payload.eventType ?? '').toLowerCase();
  const data = asRecord(payload.data);

  if (event.type === 'test') {
    const verdict = String(data?.verdict ?? payload.verdict ?? '').toLowerCase();
    if (verdict === 'fail' || verdict === 'failed' || verdict === 'error') return true;
    return eventType.includes('fail') || eventType.includes('error');
  }

  if (event.type === 'tool') {
    const success = data?.success;
    if (success === false) return true;
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return true;
    return eventType.includes('error') || eventType.includes('fail');
  }

  if (event.type === 'workflow') {
    return eventType.includes('error') || eventType.includes('fail') || eventType.includes('blocked');
  }

  return false;
}

function renderInlineRefs(
  text: string,
  onRefClick: (refType: string, target: string) => void,
  isRefResolved: (refType: string, target: string) => boolean
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > index) {
      nodes.push(<span key={`txt-${index}`}>{text.slice(index, match.index)}</span>);
    }
    const refType = match[1];
    const target = match[2];
    const resolved = isRefResolved(refType, target);
    nodes.push(
      <button
        key={`ref-${match.index}-${target}`}
        onClick={() => resolved && onRefClick(refType, target)}
        disabled={!resolved}
        title={resolved ? `Open ${refType}(${target})` : `Unresolved reference ${refType}(${target})`}
        className={`underline ${
          resolved
            ? 'text-[var(--accent-cyan)] hover:text-[var(--running)]'
            : 'text-[var(--error)] decoration-wavy cursor-not-allowed opacity-80'
        }`}
      >
        @{refType}({target})
      </button>
    );
    index = match.index + match[0].length;
  }

  if (index < text.length) {
    nodes.push(<span key={`txt-end-${index}`}>{text.slice(index)}</span>);
  }

  return nodes;
}

function parseFileRefTarget(target: string): { path: string; line?: number } {
  const [pathPart, fragment] = target.split('#');
  if (!fragment) return { path: pathPart };
  const lineMatch = fragment.match(/L(\d+)/i);
  if (!lineMatch) return { path: pathPart };
  return {
    path: pathPart,
    line: Number(lineMatch[1]),
  };
}

function PacketBody({
  markdown,
  onRefClick,
  isRefResolved,
}: {
  markdown: string;
  onRefClick: (refType: string, target: string) => void;
  isRefResolved: (refType: string, target: string) => boolean;
}) {
  const lines = markdown.split('\n');
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trimEnd();
        if (!line.trim()) {
          return <div key={`empty-${idx}`} className="h-2" />;
        }
        if (line.startsWith('### ')) {
          return (
            <h3 key={idx} className="text-sm font-semibold text-[var(--text-primary)] mt-2">
              {renderInlineRefs(line.slice(4), onRefClick, isRefResolved)}
            </h3>
          );
        }
        if (line.startsWith('## ')) {
          return (
            <h2 key={idx} className="text-base font-semibold text-[var(--text-primary)] mt-2">
              {renderInlineRefs(line.slice(3), onRefClick, isRefResolved)}
            </h2>
          );
        }
        if (line.startsWith('# ')) {
          return (
            <h1 key={idx} className="text-lg font-semibold text-[var(--text-primary)] mb-1">
              {renderInlineRefs(line.slice(2), onRefClick, isRefResolved)}
            </h1>
          );
        }
        const numbered = line.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">{numbered[1]}.</span>
              <span>{renderInlineRefs(numbered[2], onRefClick, isRefResolved)}</span>
            </div>
          );
        }
        if (line.startsWith('- ')) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">-</span>
              <span>{renderInlineRefs(line.slice(2), onRefClick, isRefResolved)}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="text-[var(--text-secondary)]">
            {renderInlineRefs(line, onRefClick, isRefResolved)}
          </p>
        );
      })}
    </div>
  );
}

function TrustBadge({ tier, label }: { tier: TrustTier; label: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${trustTone(tier)}`}>
      {tier}: {label}
    </span>
  );
}

function statusColor(status: string): string {
  if (status === 'running') return 'var(--running)';
  if (status === 'blocked') return 'var(--warning)';
  if (status === 'ready') return 'var(--accent-cyan)';
  if (status === 'done') return 'var(--success)';
  return 'var(--text-muted)';
}

function gateIcon(status: string): string {
  if (status === 'pass') return '\u2713';
  if (status === 'fail') return '\u2717';
  if (status === 'running') return '\u25CB';
  return '\u2014';
}

function SessionRow({
  row,
  selected,
  onSelect,
}: {
  row: SessionRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = statusColor(row.status);
  const isBlocked = row.blocking.unresolvedEscalationsCount > 0;
  const hasActivity = row.currentActivity.tool !== 'idle';
  const hasFile = !!row.currentActivity.file;
  const hasDiffstat = row.diffstat.added > 0 || row.diffstat.deleted > 0 || row.diffstat.filesTouched > 0;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors ${
        selected ? 'bg-[var(--bg-hover)] border-l-2' : 'border-l-2 border-l-transparent'
      }`}
      style={selected ? { borderLeftColor: color } : undefined}
    >
      {/* Title / Goal - the headline */}
      <div className="text-[13px] text-[var(--text-primary)] leading-snug line-clamp-2">{row.title}</div>

      {/* Status row: badge + elapsed + session key */}
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium"
          style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
          {isBlocked ? `blocked (${row.blocking.unresolvedEscalationsCount})` : row.status}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">{formatElapsed(row.elapsedSec)}</span>
        <span className="text-[10px] text-[var(--text-muted)] font-mono opacity-60 ml-auto">
          {row.sessionKey.slice(-8)}
        </span>
      </div>

      {/* Current activity */}
      {(hasActivity || hasFile) && (
        <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--accent-cyan)]">
          <span className="truncate">{row.currentActivity.tool}</span>
          {hasFile && (
            <span className="text-[var(--text-muted)] truncate">
              {row.currentActivity.file}{typeof row.currentActivity.line === 'number' ? `:${row.currentActivity.line}` : ''}
            </span>
          )}
        </div>
      )}

      {/* Progress badges */}
      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--text-muted)]">
        {hasDiffstat && (
          <span className="text-[var(--success)]">
            +{row.diffstat.added}/-{row.diffstat.deleted}
          </span>
        )}
        {row.gates.testsStatus !== 'unknown' && (
          <span className={row.gates.testsStatus === 'pass' ? 'text-[var(--success)]' : row.gates.testsStatus === 'fail' ? 'text-[var(--error)]' : ''}>
            {gateIcon(row.gates.testsStatus)} tests
          </span>
        )}
        {row.gates.invariantsTotal > 0 && (
          <span className={row.gates.invariantsPassed >= row.gates.invariantsTotal ? 'text-[var(--success)]' : 'text-[var(--error)]'}>
            {gateIcon(row.gates.invariantsPassed >= row.gates.invariantsTotal ? 'pass' : 'fail')} inv {row.gates.invariantsPassed}/{row.gates.invariantsTotal}
          </span>
        )}
      </div>
    </button>
  );
}

function EscalationRow({
  row,
  selected,
  onSelect,
  onResolve,
  resolving,
}: {
  row: EscalationRollup;
  selected: boolean;
  onSelect: () => void;
  onResolve: () => void;
  resolving: boolean;
}) {
  return (
    <div
      className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${
        selected ? 'bg-[var(--warning)]/10 border-l-2 border-l-[var(--warning)]' : ''
      }`}
    >
      <button onClick={onSelect} className="w-full text-left hover:bg-[var(--bg-hover)] rounded px-1 py-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--warning)] uppercase">{row.requestedDecision}</span>
          <span className="text-xs text-[var(--text-primary)] truncate flex-1">{row.headline}</span>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
          {row.sessionKey.slice(0, 12)} · {Math.floor(row.ageSec / 60)}m
        </div>
      </button>
      <div className="mt-1">
        <button
          onClick={onResolve}
          disabled={resolving}
          className="px-1.5 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
        >
          {resolving ? 'Resolving...' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}

function CommitRow({
  row,
  selected,
  onSelect,
}: {
  row: CommitRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${
        selected ? 'bg-[var(--accent-cyan)]/10 border-l-2 border-l-[var(--accent-cyan)]' : ''
      }`}
    >
      <div className="font-mono text-[11px] text-[var(--text-secondary)]">{row.sha.slice(0, 8)}</div>
      <div className="text-xs text-[var(--text-primary)] truncate">{row.message}</div>
      <div className="text-[10px] text-[var(--text-muted)]">
        {row.author} · +{row.diffstat.added}/-{row.diffstat.deleted}
      </div>
    </button>
  );
}

function PRRow({
  row,
  selected,
  onSelect,
}: {
  row: PRRollup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${
        selected ? 'bg-[var(--running)]/10 border-l-2 border-l-[var(--running)]' : ''
      }`}
    >
      <div className="text-[11px] text-[var(--text-muted)]">#{row.number} · {row.status}</div>
      <div className="text-xs text-[var(--text-primary)] truncate">{row.title}</div>
      <div className="text-[10px] text-[var(--text-muted)]">{row.author}</div>
    </button>
  );
}

function selectDefaultTarget(
  escalations: EscalationRollup[],
  running: SessionRollup[],
  ready: SessionRollup[],
  done: SessionRollup[]
): FocusTarget | null {
  if (escalations.length > 0) return { type: 'escalation', id: escalations[0].escalationId };
  if (running.length > 0) return { type: 'session', id: running[0].sessionKey };
  if (ready.length > 0) return { type: 'session', id: ready[0].sessionKey };
  if (done.length > 0) return { type: 'session', id: done[0].sessionKey };
  return null;
}

export default function App() {
  const [runningSessions, setRunningSessions] = useState<SessionRollup[]>([]);
  const [readySessions, setReadySessions] = useState<SessionRollup[]>([]);
  const [doneSessions, setDoneSessions] = useState<SessionRollup[]>([]);
  const [escalations, setEscalations] = useState<EscalationRollup[]>([]);
  const [commitRollups, setCommitRollups] = useState<CommitRollup[]>([]);
  const [prRollups, setPrRollups] = useState<PRRollup[]>([]);
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [focus, setFocus] = useState<FocusData | null>(null);
  const [events, setEvents] = useState<NormalizedSessionEvent[]>([]);
  const [focusTab, setFocusTab] = useState<FocusTab>('packet');
  const [diffData, setDiffData] = useState<CockpitDiff | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [testReports, setTestReports] = useState<CockpitTestReport[]>([]);
  const [selectedTestReportId, setSelectedTestReportId] = useState<string | null>(null);
  const [selectedTestReport, setSelectedTestReport] = useState<CockpitTestReport | null>(null);
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [sessionControlAction, setSessionControlAction] = useState<'start' | 'stop' | 'fork' | null>(null);
  const [patchDraft, setPatchDraft] = useState('');
  const [patchApplyStatus, setPatchApplyStatus] = useState<string | null>(null);
  const [applyingPatch, setApplyingPatch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [resolvingEscalationId, setResolvingEscalationId] = useState<string | null>(null);
  const [reviewDecisionAction, setReviewDecisionAction] = useState<'accept' | 'request_changes' | null>(null);
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [lensQuery, setLensQuery] = useState('');
  const [lensResults, setLensResults] = useState<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }>({
    defs: [],
    refs: [],
    text: [],
  });
  const [lensLoading, setLensLoading] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [browserState, setBrowserState] = useState<CockpitBrowserState | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserActionStatus, setBrowserActionStatus] = useState<string | null>(null);
  const [browserUrlDraft, setBrowserUrlDraft] = useState('');
  const [browserActionType, setBrowserActionType] = useState<'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll'>('click');
  const [browserTargetDraft, setBrowserTargetDraft] = useState('');
  const [browserValueDraft, setBrowserValueDraft] = useState('');
  const [browserDirectionDraft, setBrowserDirectionDraft] = useState<'up' | 'down' | 'left' | 'right'>('down');
  const [browserSnapshotInteractive, setBrowserSnapshotInteractive] = useState(true);
  const [browserSnapshotCompact, setBrowserSnapshotCompact] = useState(true);
  const [browserRunbook, setBrowserRunbook] = useState(DEFAULT_BROWSER_RUNBOOK);
  const [browserRunningRunbook, setBrowserRunningRunbook] = useState(false);
  const [panelFocus, setPanelFocus] = useState<PanelFocus>('left');
  const [leftSection, setLeftSection] = useState<LeftSection>('running');
  const [rightSection, setRightSection] = useState<RightSection>('queue');
  const [leftSelection, setLeftSelection] = useState<{ running: number; ready: number; done: number }>({
    running: 0,
    ready: 0,
    done: 0,
  });
  const [rightSelection, setRightSelection] = useState<{ queue: number; commits: number; prs: number }>({
    queue: 0,
    commits: 0,
    prs: 0,
  });
  const [pendingCommitRange, setPendingCommitRange] = useState<{
    sessionKey: string;
    base?: string;
    head?: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshRollups = useCallback(async () => {
    const [running, blocked, ready, done, escalationRows, commits, prs, dailyMetrics] = await Promise.all([
      getCockpitSessionRollups('running', 120),
      getCockpitSessionRollups('blocked', 120),
      getCockpitSessionRollups('ready', 120),
      getCockpitSessionRollups('done', 120),
      getCockpitEscalationRollups(120),
      getCockpitCommitRollups(50),
      getCockpitPRRollups('open', 50),
      getCockpitDailyMetrics(),
    ]);

    // Blocked sessions appear in the RUNNING section (spec §3.1) but are distinguishable
    // by their status field and blocking.unresolvedEscalationsCount > 0
    setRunningSessions([...blocked, ...running]);
    setReadySessions(ready);
    setDoneSessions(done);
    setEscalations(escalationRows);
    setCommitRollups(commits);
    setPrRollups(prs);
    setMetrics(dailyMetrics);

    setFocusTarget((current) => {
      const fallback = selectDefaultTarget(escalationRows, running, ready, done);
      if (!current) return fallback;
      if (current.type === 'escalation') {
        const exists = escalationRows.some((row) => row.escalationId === current.id);
        return exists ? current : fallback;
      }
      const sessionExists = [...running, ...ready, ...done].some((row) => row.sessionKey === current.id);
      return sessionExists ? current : fallback;
    });
  }, []);

  const refreshFocus = useCallback(async (target: FocusTarget | null) => {
    if (!target) {
      setFocus(null);
      setEvents([]);
      setDiffData(null);
      setSelectedDiffFile(null);
      setTestReports([]);
      setSelectedTestReport(null);
      setSelectedTestReportId(null);
      setTraces([]);
      setPatchDraft('');
      setPatchApplyStatus(null);
      setLensResults({ defs: [], refs: [], text: [] });
      setPreviewVisible(false);
      setPreviewUrl(null);
      setBrowserState(null);
      setBrowserActionStatus(null);
      return;
    }

    const focusData = await getCockpitFocus(target.type, target.id);
    if (!focusData) {
      setFocus(null);
      setEvents([]);
      setDiffData(null);
      setSelectedDiffFile(null);
      setTestReports([]);
      setSelectedTestReport(null);
      setSelectedTestReportId(null);
      setTraces([]);
      setPatchDraft('');
      setPatchApplyStatus(null);
      setLensResults({ defs: [], refs: [], text: [] });
      setPreviewVisible(false);
      setPreviewUrl(null);
      setBrowserState(null);
      setBrowserActionStatus(null);
      return;
    }

    setFocus(focusData);
    const [eventResponse, traceRows, reportRows, diffResponse] = await Promise.all([
      getCockpitSessionEvents(focusData.sessionKey, { limit: 200 }),
      getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => []),
      getCockpitTestReports({ sessionKey: focusData.sessionKey, limit: 20 }).catch(() => []),
      getCockpitDiff({ sessionKey: focusData.sessionKey }).catch(() => null),
    ]);
    setEvents(eventResponse.events);
    setTraces(traceRows);
    setTestReports(reportRows);
    setSelectedTestReportId((current) =>
      current && reportRows.some((item) => item.id === current)
        ? current
        : reportRows[0]?.id ?? null
    );
    setSelectedTestReport((current) => {
      if (current && reportRows.some((item) => item.id === current.id)) {
        return current;
      }
      return reportRows[0] ?? null;
    });
    setDiffData(diffResponse);
    setSelectedDiffFile(diffResponse?.hotspots?.[0]?.path ?? null);
    setPatchApplyStatus(null);
    setLensResults({ defs: [], refs: [], text: [] });
    setBrowserActionStatus(null);
    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
      ? focusData.header.previewUrl
      : '';
    setBrowserUrlDraft((current) => current || focusPreviewUrl);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await refreshRollups();
      setError(null);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshRollups]);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => {
      void refreshAll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    void refreshFocus(focusTarget);
  }, [focusTarget, lastUpdate, refreshFocus]);

  const refreshBrowserState = useCallback(async (sessionKey: string | null | undefined) => {
    if (!sessionKey) {
      setBrowserState(null);
      return;
    }
    setBrowserLoading(true);
    try {
      const state = await getCockpitBrowserState(sessionKey);
      setBrowserState(state);
      if (state?.currentUrl) {
        setBrowserUrlDraft((current) => current || state.currentUrl || '');
      }
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  useEffect(() => {
    if (focusTab !== 'browser') return;
    void refreshBrowserState(focus?.sessionKey);
  }, [focus?.sessionKey, focusTab, lastUpdate, refreshBrowserState]);

  const focusEscalationId = useMemo(() => {
    if (focus?.type === 'escalation') return focus.id;
    return null;
  }, [focus]);

  const focusStatus = typeof focus?.header?.status === 'string'
    ? focus.header.status
    : null;

  const filteredEvents = useMemo(() => {
    if (eventFilter === 'messages') return events.filter((event) => event.type === 'message');
    if (eventFilter === 'tools') return events.filter((event) => event.type === 'tool');
    if (eventFilter === 'failures') return events.filter((event) => isFailureEvent(event));
    return events;
  }, [events, eventFilter]);

  const allSessionKeys = useMemo(
    () => new Set([...runningSessions, ...readySessions, ...doneSessions].map((row) => row.sessionKey)),
    [runningSessions, readySessions, doneSessions]
  );

  const diffHotspotPaths = useMemo(
    () => new Set((diffData?.hotspots ?? []).map((hotspot) => hotspot.path)),
    [diffData]
  );

  const traceFilePaths = useMemo(() => {
    const set = new Set<string>();
    for (const trace of traces) {
      for (const file of trace.files ?? []) {
        if (file.path) set.add(file.path);
      }
    }
    return set;
  }, [traces]);

  const traceRevisions = useMemo(() => {
    const set = new Set<string>();
    for (const trace of traces) {
      const revision = trace.vcs?.revision;
      if (revision) set.add(revision);
    }
    return set;
  }, [traces]);

  const resolvePacketRef = useCallback((refTypeRaw: string, targetRaw: string): boolean => {
    const refType = refTypeRaw.trim().toLowerCase();
    const target = targetRaw.trim();
    if (!refType || !target) return false;

    if (refType === 'commit') {
      if (shaShortMatches(diffData?.headSha, target) || shaShortMatches(diffData?.baseSha, target)) return true;
      return commitRollups.some((row) => shaShortMatches(row.sha, target))
        || Array.from(traceRevisions).some((revision) => shaShortMatches(revision, target));
    }

    if (refType === 'file') {
      const parsed = parseFileRefTarget(target);
      return diffHotspotPaths.has(parsed.path) || traceFilePaths.has(parsed.path);
    }

    if (refType === 'testreport') {
      return testReports.some((report) => report.id === target);
    }

    if (refType === 'trace') {
      return traces.some((trace) => trace.id === target || shaShortMatches(trace.vcs?.revision, target));
    }

    if (refType === 'workitem') {
      if (typeof focus?.header?.activeWorkItemId === 'string' && focus.header.activeWorkItemId === target) return true;
      return events.some((event) => String(event.payload.workItemId ?? '') === target);
    }

    if (refType === 'session') {
      return (focus?.sessionKey === target) || allSessionKeys.has(target);
    }

    if (refType === 'pr') {
      const parsedNumber = Number(target.replace(/^#/, '').trim());
      return prRollups.some((row) =>
        row.prId === target
        || row.url.includes(target)
        || (Number.isFinite(parsedNumber) && row.number === parsedNumber)
      );
    }

    return false;
  }, [
    allSessionKeys,
    commitRollups,
    diffData?.baseSha,
    diffData?.headSha,
    diffHotspotPaths,
    events,
    focus?.header?.activeWorkItemId,
    focus?.sessionKey,
    prRollups,
    testReports,
    traceFilePaths,
    traces,
    traceRevisions,
  ]);

  const parsedPacket = useMemo(
    () => parsePacketMarkdown(focus?.packet?.contentMarkdown ?? ''),
    [focus?.packet?.contentMarkdown]
  );

  const packetEvidence = useMemo(() => {
    if (!parsedPacket.bodyMarkdown && !parsedPacket.frontmatter) {
      return {
        summaryBullets: 0,
        evidenceBackedBullets: 0,
        totalRefs: 0,
        resolvedRefs: 0,
        brokenRefs: [] as string[],
      };
    }

    const lines = parsedPacket.bodyMarkdown.split('\n');
    let summaryBullets = 0;
    let evidenceBackedBullets = 0;
    let totalRefs = 0;
    let resolvedRefs = 0;
    const brokenRefs = new Set<string>();

    for (const ref of parsedPacket.frontmatter?.refs ?? []) {
      totalRefs += 1;
      const resolved = resolvePacketRef(ref.type, ref.target);
      if (resolved) {
        resolvedRefs += 1;
      } else {
        brokenRefs.add(`@${ref.type}(${ref.target})`);
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const refs: Array<{ type: string; target: string; resolved: boolean }> = [];
      const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const type = match[1];
        const target = match[2];
        const resolved = resolvePacketRef(type, target);
        refs.push({ type, target, resolved });
      }
      totalRefs += refs.length;
      for (const ref of refs) {
        if (ref.resolved) {
          resolvedRefs += 1;
        } else {
          brokenRefs.add(`@${ref.type}(${ref.target})`);
        }
      }

      const isSummaryBullet = line.startsWith('- ') || /^\d+\.\s+/.test(line);
      if (!isSummaryBullet) continue;
      summaryBullets += 1;
      if (refs.some((ref) => ref.resolved)) {
        evidenceBackedBullets += 1;
      }
    }

    return {
      summaryBullets,
      evidenceBackedBullets,
      totalRefs,
      resolvedRefs,
      brokenRefs: Array.from(brokenRefs),
    };
  }, [parsedPacket.bodyMarkdown, parsedPacket.frontmatter, resolvePacketRef]);

  useEffect(() => {
    if (!selectedTestReportId) return;
    const existing = testReports.find((item) => item.id === selectedTestReportId);
    if (existing) {
      setSelectedTestReport(existing);
      return;
    }
    void getCockpitTestReport(selectedTestReportId).then((report) => {
      if (report) setSelectedTestReport(report);
    });
  }, [selectedTestReportId, testReports]);

  useEffect(() => {
    setLeftSelection((current) => ({
      running: runningSessions.length > 0 ? Math.min(current.running, runningSessions.length - 1) : 0,
      ready: readySessions.length > 0 ? Math.min(current.ready, readySessions.length - 1) : 0,
      done: doneSessions.length > 0 ? Math.min(current.done, doneSessions.length - 1) : 0,
    }));
  }, [runningSessions, readySessions, doneSessions]);

  useEffect(() => {
    setRightSelection((current) => ({
      queue: escalations.length > 0 ? Math.min(current.queue, escalations.length - 1) : 0,
      commits: commitRollups.length > 0 ? Math.min(current.commits, commitRollups.length - 1) : 0,
      prs: prRollups.length > 0 ? Math.min(current.prs, prRollups.length - 1) : 0,
    }));
  }, [escalations, commitRollups, prRollups]);

  useEffect(() => {
    if (!pendingCommitRange || !focus?.sessionKey) return;
    if (pendingCommitRange.sessionKey !== focus.sessionKey) return;
    void getCockpitDiff({
      sessionKey: focus.sessionKey,
      ...(pendingCommitRange.base ? { base: pendingCommitRange.base } : {}),
      ...(pendingCommitRange.head ? { head: pendingCommitRange.head } : {}),
    }).then((response) => {
      setDiffData(response);
      setSelectedDiffFile(response.hotspots[0]?.path ?? null);
      setFocusTab('diff');
    }).catch(() => {}).finally(() => setPendingCommitRange(null));
  }, [focus?.sessionKey, pendingCommitRange]);

  const handlePacketRefClick = useCallback(async (refType: string, target: string) => {
    setSelectedRef(`@${refType}(${target})`);
    if (!focus?.sessionKey) return;
    const type = refType.toLowerCase();

    if (type === 'commit') {
      setFocusTab('diff');
      const response = await getCockpitDiff({ sessionKey: focus.sessionKey, head: target }).catch(() => null);
      if (response) {
        setDiffData(response);
        setSelectedDiffFile(response.hotspots[0]?.path ?? null);
      }
      return;
    }

    if (type === 'file') {
      const parsed = parseFileRefTarget(target);
      setFocusTab('diff');
      setSelectedDiffFile(parsed.path);
      const response = await getCockpitDiff({
        sessionKey: focus.sessionKey,
        file: parsed.path,
      }).catch(() => null);
      if (response) {
        setDiffData(response);
      }
      return;
    }

    if (type === 'testreport') {
      setFocusTab('tests');
      setSelectedTestReportId(target);
      return;
    }

    if (type === 'trace') {
      setFocusTab('trace');
    }
  }, [focus?.sessionKey]);

  const handlePacketLinkClick = useCallback(async (target: string) => {
    if (!target) return;
    let parsed: URL;
    try {
      parsed = new URL(target, window.location.origin);
    } catch {
      return;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes('/diff')) {
      setFocusTab('diff');
      if (focus?.sessionKey) {
        const response = await getCockpitDiff({
          sessionKey: focus.sessionKey,
          ...(parsed.searchParams.get('base') ? { base: String(parsed.searchParams.get('base')) } : {}),
          ...(parsed.searchParams.get('head') ? { head: String(parsed.searchParams.get('head')) } : {}),
        }).catch(() => null);
        if (response) {
          setDiffData(response);
          setSelectedDiffFile(response.hotspots[0]?.path ?? null);
        }
      }
      return;
    }
    if (pathname.includes('/tests')) {
      setFocusTab('tests');
      const reportId = parsed.searchParams.get('id');
      if (reportId) {
        setSelectedTestReportId(reportId);
      }
      return;
    }
    if (pathname.includes('/trace')) {
      setFocusTab('trace');
      return;
    }
    if (pathname.includes('/preview')) {
      setPreviewVisible(true);
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    }
  }, [focus?.sessionKey]);

  const handleSessionControl = useCallback(async (action: 'start' | 'stop' | 'fork') => {
    if (!focus?.sessionKey) return;
    setSessionControlAction(action);
    try {
      const result = await postCockpitSessionControl(focus.sessionKey, { action });
      if (action === 'fork' && result.targetSessionKey) {
        setFocusTarget({ type: 'session', id: result.targetSessionKey });
      }
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionControlAction(null);
    }
  }, [focus?.sessionKey, refreshAll]);

  const handleApplyPatch = useCallback(async () => {
    if (!focus?.sessionKey || !patchDraft.trim()) return;
    setApplyingPatch(true);
    setPatchApplyStatus(null);
    try {
      const response = await applyCockpitPatch({
        sessionKey: focus.sessionKey,
        patch: patchDraft,
        ...(diffData?.baseSha ? { baseSha: diffData.baseSha } : {}),
      });
      if (response.success) {
        setPatchApplyStatus(
          `Applied ${response.mode ?? 'patch'}: ${response.files?.length ?? 0} files, ${response.changedLines ?? 0} lines`
        );
        setPatchDraft('');
        await refreshFocus(focusTarget);
        await refreshAll();
      } else {
        setPatchApplyStatus('Patch apply failed');
      }
    } catch (err) {
      setPatchApplyStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingPatch(false);
    }
  }, [focus?.sessionKey, patchDraft, diffData?.baseSha, refreshAll, refreshFocus, focusTarget]);

  const handleResolveEscalation = useCallback(async (escalationId: string) => {
    const freeformResponse = window.prompt('Resolution note (optional):');
    if (freeformResponse === null) return;

    setResolvingEscalationId(escalationId);
    try {
      await resolveCockpitEscalation(escalationId, {
        freeformResponse: freeformResponse.trim() || undefined,
      });
      setFocusTarget(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingEscalationId(null);
    }
  }, [refreshAll]);

  const handleReviewDecision = useCallback(async (decision: 'accept' | 'request_changes') => {
    if (!focus?.sessionKey) return;
    const note = window.prompt(
      decision === 'accept'
        ? 'Optional acceptance note:'
        : 'Optional request-changes note:'
    );
    if (note === null) return;

    setReviewDecisionAction(decision);
    try {
      await postCockpitSessionReviewDecision(focus.sessionKey, {
        decision,
        note: note.trim() || undefined,
      });
      await refreshAll();
      await refreshFocus(focusTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewDecisionAction(null);
    }
  }, [focus?.sessionKey, refreshAll, refreshFocus, focusTarget]);

  const handleSendMessage = useCallback(async () => {
    if (!focus?.sessionKey || !messageDraft.trim()) return;
    setSendingMessage(true);
    try {
      await postCockpitSessionMessage(focus.sessionKey, messageDraft.trim());
      setMessageDraft('');
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingMessage(false);
    }
  }, [focus?.sessionKey, messageDraft, refreshAll, refreshFocus, focusTarget]);

  const handleRunLensSearch = useCallback(async () => {
    if (!focus?.sessionKey || !lensQuery.trim()) return;
    setLensLoading(true);
    try {
      const results = await searchCockpitRepoLens({
        sessionKey: focus.sessionKey,
        q: lensQuery.trim(),
        kind: 'all',
        limit: 120,
      });
      setLensResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLensLoading(false);
    }
  }, [focus?.sessionKey, lensQuery]);

  const handleTogglePreview = useCallback(async () => {
    if (previewVisible) {
      setPreviewVisible(false);
      return;
    }
    if (!focus?.sessionKey) return;
    setPreviewLoading(true);
    try {
      const preview = await getCockpitPreview({ sessionKey: focus.sessionKey });
      if (!preview?.url) {
        setError('No preview URL available for this session.');
        return;
      }
      setPreviewUrl(preview.url);
      setPreviewVisible(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [focus?.sessionKey, previewVisible]);

  const handleBrowserAction = useCallback(async (input: Omit<CockpitBrowserActionInput, 'sessionKey'>) => {
    if (!focus?.sessionKey) return;
    setBrowserLoading(true);
    setBrowserActionStatus(null);
    try {
      const response = await postCockpitBrowserAction({
        sessionKey: focus.sessionKey,
        ...input,
      });
      if (!response.success) {
        setBrowserActionStatus(response.error ?? 'Browser action failed');
        return;
      }
      const actionLabel = response.action ?? input.action;
      const outputSummary = response.artifactPath
        ? `${actionLabel} ok · ${response.artifactPath}`
        : `${actionLabel} ok`;
      setBrowserActionStatus(outputSummary);
      if (response.currentUrl) {
        setBrowserUrlDraft(response.currentUrl);
        setPreviewUrl(response.currentUrl);
      }
      await refreshBrowserState(focus.sessionKey);
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserLoading(false);
    }
  }, [focus?.sessionKey, refreshAll, refreshBrowserState, refreshFocus, focusTarget]);

  const handleRunBrowserAction = useCallback(async () => {
    if (!focus?.sessionKey) return;
    if (browserActionType === 'click') {
      if (!browserTargetDraft.trim()) {
        setBrowserActionStatus('click requires a target (for example @e1)');
        return;
      }
      await handleBrowserAction({ action: 'click', target: browserTargetDraft.trim() });
      return;
    }
    if (browserActionType === 'fill') {
      if (!browserTargetDraft.trim() || !browserValueDraft.trim()) {
        setBrowserActionStatus('fill requires target + text');
        return;
      }
      await handleBrowserAction({
        action: 'fill',
        target: browserTargetDraft.trim(),
        text: browserValueDraft,
      });
      return;
    }
    if (browserActionType === 'type') {
      if (!browserTargetDraft.trim() || !browserValueDraft.trim()) {
        setBrowserActionStatus('type requires target + text');
        return;
      }
      await handleBrowserAction({
        action: 'type',
        target: browserTargetDraft.trim(),
        text: browserValueDraft,
      });
      return;
    }
    if (browserActionType === 'press') {
      if (!browserValueDraft.trim()) {
        setBrowserActionStatus('press requires a key (for example Enter)');
        return;
      }
      await handleBrowserAction({ action: 'press', text: browserValueDraft.trim() });
      return;
    }
    if (browserActionType === 'wait') {
      const ms = Number(browserValueDraft.trim());
      if (Number.isFinite(ms) && ms > 0) {
        await handleBrowserAction({ action: 'wait', waitMs: Math.floor(ms) });
      } else if (browserTargetDraft.trim()) {
        await handleBrowserAction({ action: 'wait', target: browserTargetDraft.trim() });
      } else {
        setBrowserActionStatus('wait requires milliseconds or a selector');
      }
      return;
    }
    if (browserActionType === 'scroll') {
      const px = Number(browserValueDraft.trim());
      await handleBrowserAction({
        action: 'scroll',
        direction: browserDirectionDraft,
        ...(Number.isFinite(px) ? { pixels: Math.floor(px) } : {}),
      });
    }
  }, [
    focus?.sessionKey,
    browserActionType,
    browserDirectionDraft,
    browserTargetDraft,
    browserValueDraft,
    handleBrowserAction,
  ]);

  const handleRunBrowserRunbook = useCallback(async () => {
    if (!focus?.sessionKey || !browserRunbook.trim()) return;
    setBrowserRunningRunbook(true);
    setBrowserActionStatus(null);
    try {
      const result = await postCockpitBrowserRunbook({
        sessionKey: focus.sessionKey,
        script: browserRunbook,
        stopOnError: true,
      });
      const steps = result.steps ?? [];
      const failed = steps.filter((step) => step.success === false).length;
      setBrowserActionStatus(
        failed > 0
          ? `Runbook finished with ${failed} failed step(s)`
          : `Runbook completed (${steps.length} step${steps.length === 1 ? '' : 's'})`
      );
      if (result.currentUrl) {
        setBrowserUrlDraft(result.currentUrl);
        setPreviewUrl(result.currentUrl);
      }
      await refreshBrowserState(focus.sessionKey);
      await refreshFocus(focusTarget);
      await refreshAll();
    } catch (err) {
      setBrowserActionStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserRunningRunbook(false);
    }
  }, [focus?.sessionKey, browserRunbook, refreshAll, refreshBrowserState, refreshFocus, focusTarget]);

  const handleSelectCommit = useCallback((row: CommitRollup, index: number) => {
    setRightSelection((current) => ({ ...current, commits: index }));
    if (!row.sessionKey) return;
    setFocusTarget({ type: 'session', id: row.sessionKey });
    setPendingCommitRange({
      sessionKey: row.sessionKey,
      ...(row.baseSha ? { base: row.baseSha } : {}),
      ...(row.headSha ? { head: row.headSha } : {}),
    });
  }, []);

  const handleSelectPR = useCallback((row: PRRollup, index: number) => {
    setRightSelection((current) => ({ ...current, prs: index }));
    if (row.sessionKey) {
      setFocusTarget({ type: 'session', id: row.sessionKey });
    }
    window.open(row.url, '_blank', 'noopener,noreferrer');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target.isContentEditable
      );

      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        void handleSendMessage();
        return;
      }

      if (event.key === 'Escape') {
        setPanelFocus('input');
        inputRef.c
... [truncated 50023 chars]

### function_call
@callId call_74a1860d10544a9088d06c2d
@name Grep
@ts 1770352563047
@workItemId 68ac7230
{"pattern":"EventStream|event.*stream|messages.*stream|renderEvent","path":"packages/dashboard-control/src/App.tsx","caseSensitive":false}

### function_call_output
@callId call_74a1860d10544a9088d06c2d
@ts 1770352563073
@durationMs 25
@workItemId 68ac7230
No matches found for pattern: EventStream|event.*stream|messages.*stream|renderEvent

### function_call
@callId call_e134542fb94e47858dd9f98b
@name Grep
@ts 1770352566170
@workItemId 68ac7230
{"path":"packages/dashboard-control/src/App.tsx","pattern":"eventFilter|filteredEvents|EventsList|renderEvent"}

### function_call_output
@callId call_e134542fb94e47858dd9f98b
@ts 1770352566178
@durationMs 7
@workItemId 68ac7230
packages/dashboard-control/src/App.tsx:50:6:type EventFilter = 'all' | 'messages' | 'tools' | 'failures';
packages/dashboard-control/src/App.tsx:628:10:  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
packages/dashboard-control/src/App.tsx:836:9:  const filteredEvents = useMemo(() => {
packages/dashboard-control/src/App.tsx:837:9:    if (eventFilter === 'messages') return events.filter((event) => event.type === 'message');
packages/dashboard-control/src/App.tsx:838:9:    if (eventFilter === 'tools') return events.filter((event) => event.type === 'tool');
packages/dashboard-control/src/App.tsx:839:9:    if (eventFilter === 'failures') return events.filter((event) => isFailureEvent(event));
packages/dashboard-control/src/App.tsx:841:15:  }, [events, eventFilter]);
packages/dashboard-control/src/App.tsx:2619:37:                  onClick={() => setEventFilter('all')}
packages/dashboard-control/src/App.tsx:2621:21:                    eventFilter === 'all'
packages/dashboard-control/src/App.tsx:2629:37:                  onClick={() => setEventFilter('messages')}
packages/dashboard-control/src/App.tsx:2631:21:                    eventFilter === 'messages'
packages/dashboard-control/src/App.tsx:2639:37:                  onClick={() => setEventFilter('tools')}
packages/dashboard-control/src/App.tsx:2641:21:                    eventFilter === 'tools'
packages/dashboard-control/src/App.tsx:2649:37:                  onClick={() => setEventFilter('failures')}
packages/dashboard-control/src/App.tsx:2651:21:                    eventFilter === 'failures'
packages/dashboard-control/src/App.tsx:2660:14:            {filteredEvents.length === 0 ? (
packages/dashboard-control/src/App.tsx:2663:15:              filteredEvents.map((event, idx) => {

### function_call
@callId call_0375b55e20f544919c82254e
@name Read
@ts 1770352568456
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2650,"endLine":2750}

### function_call_output
@callId call_0375b55e20f544919c82254e
@ts 1770352568936
@durationMs 472
@workItemId 68ac7230
// Lines 2650-2453 of 2453 total


### function_call
@callId call_5415f47369e943be9f2d7087
@name Grep
@ts 1770352572001
@workItemId 68ac7230
{"path":"packages/dashboard-control/src/App.tsx","pattern":"filteredEvents\\.map.*event.*idx","caseSensitive":false}

### function_call_output
@callId call_5415f47369e943be9f2d7087
@ts 1770352573147
@durationMs 1141
@workItemId 68ac7230
packages/dashboard-control/src/App.tsx:2663:15:              filteredEvents.map((event, idx) => {

### function_call
@callId call_69140ff23d724922bdf2e49f
@name Bash
@ts 1770352576152
@workItemId 68ac7230
{"command":"grep -n \"filteredEvents.map\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_69140ff23d724922bdf2e49f
@ts 1770352576165
@durationMs 8
@workItemId 68ac7230
2663:              filteredEvents.map((event, idx) => {


### function_call
@callId call_a655fd7c9bd9483783032162
@name Read
@ts 1770352639151
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2650,"endLine":2700}

### function_call_output
@callId call_a655fd7c9bd9483783032162
@ts 1770352639162
@durationMs 9
@workItemId 68ac7230
// Lines 2650-2453 of 2453 total


### function_call
@callId call_8a936f346bdd45a9ac0674bb
@name Bash
@ts 1770352643144
@workItemId 68ac7230
{"command":"tail -100 packages/dashboard-control/src/App.tsx | head -60"}

### function_call_output
@callId call_8a936f346bdd45a9ac0674bb
@ts 1770352643448
@durationMs 303
@workItemId 68ac7230
              onClick={() => setRightSection('queue')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'queue'
                  ? 'bg-[var(--warning)]/20 text-[var(--warning)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Escalations ({escalations.length})
            </button>
            <button
              onClick={() => setRightSection('commits')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'commits'
                  ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Commits ({commitRollups.length})
            </button>
            <button
              onClick={() => setRightSection('prs')}
              className={`px-1.5 py-0.5 rounded ${
                rightSection === 'prs'
                  ? 'bg-[var(--running)]/20 text-[var(--running)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              Open PRs ({prRollups.length})
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightSection === 'queue' && (
              escalations.length === 0 ? (
                <div className="p-3 text-xs text-[var(--text-muted)]">No open escalations.</div>
              ) : (
                escalations.map((row, index) => (
                  <EscalationRow
                    key={row.escalationId}
                    row={row}
                    selected={
                      (focusTarget?.type === 'escalation' && focusTarget.id === row.escalationId)
                      || (panelFocus === 'right' && rightSection === 'queue' && rightSelection.queue === index)
                    }
                    onSelect={() => {
                      setRightSection('queue');
                      setRightSelection((current) => ({ ...current, queue: index }));
                      setFocusTarget({ type: 'escalation', id: row.escalationId });
                    }}
                    onResolve={() => void handleResolveEscalation(row.escalationId)}
                    resolving={resolvingEscalationId === row.escalationId}
                  />
                ))
              )
            )}
            {rightSection === 'commits' && (
              commitRollups.length === 0 ? (
                <div className="p-3 text-xs text-[var(--text-muted)]">No recent commits.</div>
              ) : (
                commitRollups.map((row, index) => (
                  <CommitRow


### function_call
@callId call_3b9839c2980d47e88e3dbaba
@name Bash
@ts 1770352647830
@workItemId 68ac7230
{"command":"grep -n \"eventLabel\\|renderEvent\" packages/dashboard-control/src/App.tsx | head -20"}

### function_call_output
@callId call_3b9839c2980d47e88e3dbaba
@ts 1770352648070
@durationMs 238
@workItemId 68ac7230
230:function eventLabel(event: NormalizedSessionEvent): string {
2692:                        <span className="text-[var(--text-muted)]">{eventLabel(event)}</span>


### function_call
@callId call_cf7041a34a9d4b97a84fd0ca
@name Read
@ts 1770352649831
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2280,"endLine":2350}

### function_call_output
@callId call_cf7041a34a9d4b97a84fd0ca
@ts 1770352649845
@durationMs 6
@workItemId 68ac7230
// Lines 2280-2350 of 2453 total
                    <div key={label} className="border border-[var(--border-subtle)] rounded overflow-hidden">
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                        {label} ({rows.length})
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                        {rows.length === 0 ? (
                          <div className="px-2 py-2 text-[var(--text-muted)]">No matches</div>
                        ) : (
                          rows.slice(0, 60).map((match, idx) => (
                            <button
                              key={`${label}-${match.kind}-${match.path}-${match.line}-${idx}`}
                              onClick={() => {
                                setSelectedRef(`@file(${match.path}#L${match.line})`);
                                setFocusTab('diff');
                                setSelectedDiffFile(match.path);
                                if (focus?.sessionKey) {
                                  void getCockpitDiff({
                                    sessionKey: focus.sessionKey,
                                    file: match.path,
                                  }).then((response) => setDiffData(response)).catch(() => {});
                                }
                              }}
                              className="w-full text-left px-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]"
                            >
                              <div className="font-mono text-[10px] text-[var(--text-secondary)] truncate">
                                {match.path}:{match.line}
                              </div>
                              <div className="text-[10px] text-[var(--text-muted)] truncate">{match.preview}</div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {focusTab === 'browser' && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="browser action logs" />
                  <TrustBadge tier="proven" label="captured evidence" />
                  <TrustBadge tier="computed" label="runbook execution" />
                </div>
                <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[var(--text-muted)]">Session</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {browserState?.browserSession ?? 'not attached'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      browserState?.available
                        ? 'text-[var(--success)] bg-[var(--success)]/10'
                        : 'text-[var(--warning)] bg-[var(--warning)]/10'
                    }`}>
                      {browserState?.available ? 'agent-browser available' : 'agent-browser unavailable'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      browserState?.connected
                        ? 'text-[var(--running)] bg-[var(--running)]/10'
                        : 'text-[var(--text-muted)] bg-[var(--text-muted)]/10'
                    }`}>
                      {browserState?.connected ? 'connected' : 'not connected'}
                    </span>
                  </div>
                  {browserState?.currentUrl && (
                    <div className="text-[var(--text-muted)] truncate">
                      URL: <span className="text-[var(--text-secondary)]">{browserState.currentUrl}</span>
                    </div>
                  )}

### function_call
@callId call_d0f33eb7c6354978815a8d5f
@name Bash
@ts 1770352653076
@workItemId 68ac7230
{"command":"awk '/filteredEvents\\.map/,/}/' packages/dashboard-control/src/App.tsx | head -80"}

### function_call_output
@callId call_d0f33eb7c6354978815a8d5f
@ts 1770352653092
@durationMs 13
@workItemId 68ac7230
              filteredEvents.map((event, idx) => {
                const data = asRecord(event.payload.data);
                const isTool = event.type === 'tool';
                const isMessage = event.type === 'message';
                const isFailure = isFailureEvent(event);
                const toolName = isTool ? (typeof data?.tool_name === 'string' ? data.tool_name : null) : null;
                const toolPhase = isTool ? (typeof data?.phase === 'string' ? data.phase : null) : null;
                const toolDuration = isTool && typeof data?.duration_ms === 'number' ? data.duration_ms : null;
                const toolArgs = isTool && data?.arguments ? data.arguments as Record<string, unknown> : null;
                const toolFile = typeof toolArgs?.file_path === 'string' ? toolArgs.file_path
                  : typeof toolArgs?.path === 'string' ? toolArgs.path
                  : typeof toolArgs?.command === 'string' ? toolArgs.command.slice(0, 80)
                  : null;

                return (
                  <div key={`${event.at}-${idx}`} className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${isFailure ? 'bg-[var(--error)]/5' : ''}`}>


### function_call
@callId call_66d801b66a594ae8b6896905
@name Bash
@ts 1770352670230
@workItemId 68ac7230
{"command":"awk '/filteredEvents\\.map/,/}\\s*<\\/div>/ {print NR\": \"$0}' packages/dashboard-control/src/App.tsx | head -120"}

### function_call_output
@callId call_66d801b66a594ae8b6896905
@ts 1770352670486
@durationMs 252
@workItemId 68ac7230
2663:               filteredEvents.map((event, idx) => {
2664:                 const data = asRecord(event.payload.data);
2665:                 const isTool = event.type === 'tool';
2666:                 const isMessage = event.type === 'message';
2667:                 const isFailure = isFailureEvent(event);
2668:                 const toolName = isTool ? (typeof data?.tool_name === 'string' ? data.tool_name : null) : null;
2669:                 const toolPhase = isTool ? (typeof data?.phase === 'string' ? data.phase : null) : null;
2670:                 const toolDuration = isTool && typeof data?.duration_ms === 'number' ? data.duration_ms : null;
2671:                 const toolArgs = isTool && data?.arguments ? data.arguments as Record<string, unknown> : null;
2672:                 const toolFile = typeof toolArgs?.file_path === 'string' ? toolArgs.file_path
2673:                   : typeof toolArgs?.path === 'string' ? toolArgs.path
2674:                   : typeof toolArgs?.command === 'string' ? toolArgs.command.slice(0, 80)
2675:                   : null;
2676: 
2677:                 return (
2678:                   <div key={`${event.at}-${idx}`} className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${isFailure ? 'bg-[var(--error)]/5' : ''}`}>
2679:                     <div className="flex items-center gap-2 text-[11px]">
2680:                       <span className={`uppercase font-medium ${
2681:                         isMessage ? 'text-[var(--running)]'
2682:                         : isTool ? 'text-[var(--accent-cyan)]'
2683:                         : isFailure ? 'text-[var(--error)]'
2684:                         : 'text-[var(--text-muted)]'
2685:                       }`}>
2686:                         {isMessage ? (typeof event.payload.role === 'string' ? event.payload.role : 'message') : event.type}
2687:                       </span>
2688:                       {toolName && (
2689:                         <span className="text-[var(--text-primary)] font-mono text-[11px]">{toolName}</span>
2690:                       )}
2691:                       {!toolName && !isMessage && (
2692:                         <span className="text-[var(--text-muted)]">{eventLabel(event)}</span>
2693:                       )}
2694:                       {toolPhase === 'completed' && toolDuration !== null && (
2695:                         <span className="text-[10px] text-[var(--text-muted)]">{toolDuration}ms</span>
2696:                       )}
2697:                       <span className="text-[var(--text-muted)] ml-auto shrink-0">{formatRelativeFromIso(event.at)}</span>
2698:                     </div>
2699:                     {toolFile && (
2700:                       <div className="text-[11px] text-[var(--text-muted)] mt-0.5 font-mono truncate pl-4">
2701:                         {toolFile}
2702:                       </div>
2703:                     )}
2704:                     {isMessage && typeof event.payload.content === 'string' && (
2705:                       <div className="text-xs text-[var(--text-secondary)] mt-0.5 whitespace-pre-wrap break-words line-clamp-6">
2706:                         {event.payload.content.slice(0, 500)}
2707:                       </div>
2708:                     )}
2709:                     {isFailure && !isMessage && (
2710:                       <div className="text-[11px] text-[var(--error)] mt-0.5 truncate">
2711:                         {typeof data?.error === 'string' ? data.error.slice(0, 200)
2712:                           : typeof event.payload.eventType === 'string' ? event.payload.eventType : ''}
2713:                       </div>
2714:                     )}
2715:                   </div>
2716:                 );
2717:               })
2718:             )}
2719:           </div>
2720:           <div
2721:             className={`shrink-0 border-t border-[var(--border-subtle)] p-2 space-y-2 ${
2722:               panelFocus === 'input' ? 'bg-[var(--accent-cyan)]/10' : ''
2723:             }`}
2724:           >
2725:             <div className="text-[11px] text-[var(--text-muted)]">Input (Esc, Ctrl+Enter to send)</div>
2726:             <textarea
2727:               ref={inputRef}
2728:               value={messageDraft}
2729:               onFocus={() => setPanelFocus('input')}
2730:               onChange={(event) => setMessageDraft(event.target.value)}
2731:               placeholder={focus?.sessionKey ? `Message ${focus.sessionKey}` : 'Select a session first'}
2732:               className="w-full min-h-16 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[12px] text-[var(--text-secondary)]"
2733:             />
2734:             <div className="flex items-center justify-between">
2735:               <span className="text-[10px] text-[var(--text-muted)]">1/2/3 switch panels, Tab cycles sections</span>
2736:               <button
2737:                 onClick={() => void handleSendMessage()}
2738:                 disabled={sendingMessage || !focus?.sessionKey || !messageDraft.trim()}
2739:                 className="px-2 py-0.5 text-[11px] rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-60"
2740:               >
2741:                 {sendingMessage ? 'Sending...' : 'Send'}
2742:               </button>
2743:             </div>
2744:           </div>
2745:         </section>
2746: 
2747:         <section
2748:           onClick={() => setPanelFocus('right')}
2749:           className={`min-h-0 border border-[var(--border-subtle)] rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col ${
2750:             panelFocus === 'right' ? 'ring-1 ring-[var(--accent-cyan)]' : ''
2751:           }`}
2752:         >
2753:           <div className="px-2 py-1 text-xs text-[var(--text-muted)] border-b border-[var(--border-subtle)] flex items-center justify-between">
2754:             <span>Queue (3)</span>
2755:             <span className="text-[10px] text-[var(--text-muted)]">Tab cycles</span>
2756:           </div>
2757:           <div className="px-1 py-1 border-b border-[var(--border-subtle)] flex items-center gap-1 text-[11px]">
2758:             <button
2759:               onClick={() => setRightSection('queue')}
2760:               className={`px-1.5 py-0.5 rounded ${
2761:                 rightSection === 'queue'
2762:                   ? 'bg-[var(--warning)]/20 text-[var(--warning)]'
2763:                   : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
2764:               }`}
2765:             >
2766:               Escalations ({escalations.length})
2767:             </button>
2768:             <button
2769:               onClick={() => setRightSection('commits')}
2770:               className={`px-1.5 py-0.5 rounded ${
2771:                 rightSection === 'commits'
2772:                   ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
2773:                   : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
2774:               }`}
2775:             >
2776:               Commits ({commitRollups.length})
2777:             </button>
2778:             <button
2779:               onClick={() => setRightSection('prs')}
2780:               className={`px-1.5 py-0.5 rounded ${
2781:                 rightSection === 'prs'
2782:                   ? 'bg-[var(--running)]/20 text-[var(--running)]'


### function_call
@callId call_831e8c450be94d7f9a85de80
@name Grep
@ts 1770352682663
@workItemId 68ac7230
{"path":"packages/dashboard-control/src/App.tsx","pattern":"preview.*card|DiffPreview|PreviewCard"}

### function_call_output
@callId call_831e8c450be94d7f9a85de80
@ts 1770352683132
@durationMs 465
@workItemId 68ac7230
No matches found for pattern: preview.*card|DiffPreview|PreviewCard

### function_call
@callId call_8705515ee4364e508817956c
@name Bash
@ts 1770352686083
@workItemId 68ac7230
{"command":"grep -n \"hotspots\\|diffData\\|selectedDiffFile\" packages/dashboard-control/src/App.tsx | head -30"}

### function_call_output
@callId call_8705515ee4364e508817956c
@ts 1770352686097
@durationMs 10
@workItemId 68ac7230
612:  const [diffData, setDiffData] = useState<CockpitDiff | null>(null);
613:  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
769:    setSelectedDiffFile(diffResponse?.hotspots?.[0]?.path ?? null);
849:    () => new Set((diffData?.hotspots ?? []).map((hotspot) => hotspot.path)),
850:    [diffData]
878:      if (shaShortMatches(diffData?.headSha, target) || shaShortMatches(diffData?.baseSha, target)) return true;
918:    diffData?.baseSha,
919:    diffData?.headSha,
1038:      setSelectedDiffFile(response.hotspots[0]?.path ?? null);
1053:        setSelectedDiffFile(response.hotspots[0]?.path ?? null);
1102:          setSelectedDiffFile(response.hotspots[0]?.path ?? null);
1152:        ...(diffData?.baseSha ? { baseSha: diffData.baseSha } : {}),
1169:  }, [focus?.sessionKey, patchDraft, diffData?.baseSha, refreshAll, refreshFocus, focusTarget]);
1694:    if (!diffData) return null;
1696:    const fileDrift = diffData.summary.filesTouched !== traceDerivedDiffstat.filesTouched;
1699:      gitFiles: diffData.summary.filesTouched,
1702:  }, [diffData, traceDerivedDiffstat]);
2076:              diffData ? (
2089:                    <span className="text-[var(--text-primary)]">{diffData.baseSha.slice(0, 8)}</span>
2091:                    <span className="text-[var(--text-primary)]">{diffData.headSha.slice(0, 8)}</span>
2093:                    {diffData.summary.filesTouched} files · +{diffData.summary.added} / -{diffData.summary.deleted}
2097:                    {diffData.hotspots.length === 0 ? (
2100:                      diffData.hotspots.slice(0, 20).map((hotspot) => (
2108:                                base: diffData.baseSha,
2109:                                head: diffData.headSha,
2115:                            selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
2129:                  {diffData.patch && (
2131:                      {diffData.patch}


### function_call
@callId call_b88540e7247941768563cd2c
@name Read
@ts 1770352695749
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2070,"endLine":2200}

### function_call_output
@callId call_b88540e7247941768563cd2c
@ts 1770352695761
@durationMs 4
@workItemId 68ac7230
// Lines 2070-2200 of 2453 total
              ) : (
                <div className="text-xs text-[var(--text-muted)]">No packet loaded</div>
              )
            )}

            {focusTab === 'diff' && (
              diffData ? (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-1">
                    <TrustBadge tier="proven" label="git diffstat" />
                    <TrustBadge tier="computed" label="hotspot ranking" />
                    <TrustBadge tier="computed" label="trace attribution" />
                    {diffDrift && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-[var(--warning)] bg-[var(--warning)]/10">
                        drift git:{diffDrift.gitFiles} trace:{diffDrift.traceFiles}
                      </span>
                    )}
                  </div>
                  <div className="text-[var(--text-muted)]">
                    <span className="text-[var(--text-primary)]">{diffData.baseSha.slice(0, 8)}</span>
                    {' -> '}
                    <span className="text-[var(--text-primary)]">{diffData.headSha.slice(0, 8)}</span>
                    {' · '}
                    {diffData.summary.filesTouched} files · +{diffData.summary.added} / -{diffData.summary.deleted}
                  </div>
                  <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                    <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">Hotspots</div>
                    {diffData.hotspots.length === 0 ? (
                      <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
                    ) : (
                      diffData.hotspots.slice(0, 20).map((hotspot) => (
                        <button
                          key={hotspot.path}
                          onClick={() => {
                            setSelectedDiffFile(hotspot.path);
                            if (focus?.sessionKey) {
                              void getCockpitDiff({
                                sessionKey: focus.sessionKey,
                                base: diffData.baseSha,
                                head: diffData.headSha,
                                file: hotspot.path,
                              }).then((response) => setDiffData(response)).catch(() => {});
                            }
                          }}
                          className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                            selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
                          }`}
                        >
                          <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
                          <div className="text-[10px] text-[var(--text-muted)]">
                            +{hotspot.added} / -{hotspot.deleted}
                            {typeof lastEditedLineByPath.get(hotspot.path) === 'number'
                              ? ` · last L${lastEditedLineByPath.get(hotspot.path)}`
                              : ''}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  {diffData.patch && (
                    <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] overflow-x-auto whitespace-pre-wrap">
                      {diffData.patch}
                    </pre>
                  )}
                  <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                    <div className="text-[var(--text-muted)]">Patch Pad (max 3 files / 30 lines)</div>
                    <textarea
                      value={patchDraft}
                      onChange={(event) => setPatchDraft(event.target.value)}
                      placeholder="Paste unified diff here..."
                      className="w-full min-h-28 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleApplyPatch()}
                        disabled={applyingPatch || !patchDraft.trim()}
                        className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                      >
                        {applyingPatch ? 'Applying...' : 'Apply Patch'}
                      </button>
                      {patchApplyStatus && (
                        <span className="text-[10px] text-[var(--text-muted)]">{patchApplyStatus}</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-[var(--text-muted)]">No diff range available for this session.</div>
              )
            )}

            {focusTab === 'tests' && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <TrustBadge tier="proven" label="testreport records" />
                  <TrustBadge tier="computed" label="category rollups" />
                </div>
                {testReports.length === 0 ? (
                  <div className="text-[var(--text-muted)]">No test reports available.</div>
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-[16rem_minmax(0,1fr)] gap-3">
                    <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
                      {testReports.map((report) => (
                        <button
                          key={report.id}
                          onClick={() => setSelectedTestReportId(report.id)}
                          className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                            selectedTestReportId === report.id ? 'bg-[var(--success)]/10' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{report.id.slice(0, 8)}</span>
                            <span className="uppercase text-[10px] text-[var(--text-muted)]">{report.verdict}</span>
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)]">{formatRelativeFromIso(report.createdAt)}</div>
                        </button>
                      ))}
                    </div>
                    <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                      {selectedTestReport ? (
                        <>
                          <div className="text-[var(--text-primary)] font-medium">
                            {selectedTestReport.command || 'Test Report'}
                          </div>
                          <div className="text-[var(--text-muted)]">
                            Verdict {selectedTestReport.verdict} · Duration {selectedTestReport.durationMs}ms
                          </div>
                          <div className="space-y-1">
                            {selectedTestReport.categories.map((category, idx) => (
                              <div key={`cat-${idx}`} className="text-[var(--text-secondary)]">
                                {String(category.category ?? category.name ?? 'category')}:{' '}

### function_call
@callId call_98170914f5024c119ddd69e6
@name Read
@ts 1770352701949
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts"}

### function_call_output
@callId call_98170914f5024c119ddd69e6
@ts 1770352701964
@durationMs 6
@workItemId 68ac7230
/**
 * Control Plane API Client
 *
 * Connects to harness-daemon's control-plane routes for session/project data.
 */

const API_BASE = '/control-plane';

export interface Project {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  activeGoals: number;
  activeSessions?: number;
  gitRemote?: { owner: string; repo: string } | null;
}

export interface Feature {
  id: string;
  name: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  sessionCount: number;
}

export interface Session {
  id: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: string;
  lastAccessedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

export interface GoalNode {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  deadline: string | null;
  children: GoalNode[];
}

export interface TokenUsage {
  provider: string;
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface TraceRecord {
  id: string;
  version: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash?: string }>;
    }>;
  }>;
}

export interface GitInfo {
  currentBranch: string;
  remote?: { owner: string; repo: string };
  uncommittedChanges: number;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
}

async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postAPI<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ============ Projects ============

export async function getProjects(): Promise<Project[]> {
  const data = await fetchAPI<{ projects: Project[] }>('/projects');
  return data.projects ?? [];
}

export async function getFeatures(projectPath: string): Promise<{ features: Feature[]; currentBranch: string }> {
  const encoded = encodeURIComponent(projectPath);
  return fetchAPI(`/projects/${encoded}/features`);
}

export async function getProjectSessions(projectPath: string): Promise<Session[]> {
  const encoded = encodeURIComponent(projectPath);
  const data = await fetchAPI<{ sessions: Session[] }>(`/projects/${encoded}/sessions`);
  return data.sessions ?? [];
}

// ============ Sessions ============

export async function getSessions(limit = 50): Promise<Session[]> {
  const data = await fetchAPI<{ sessions: Session[] }>(`/sessions?limit=${limit}`);
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await fetchAPI<{ session: Session | null }>(`/sessions/${encodeURIComponent(sessionId)}`);
  return data.session;
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const data = await fetchAPI<{ messages: Message[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  return data.messages ?? [];
}

// ============ Git Integration ============

export async function getPRs(owner: string, repo: string, branch?: string): Promise<PRInfo[]> {
  const encoded = encodeURIComponent(branch || '');
  const data = await fetchAPI<{ prs: PRInfo[] }>(`/features/${encoded}/prs?owner=${owner}&repo=${repo}`);
  return data.prs ?? [];
}

// ============ Goals ============

export async function getGoalHierarchy(): Promise<GoalNode[]> {
  const data = await fetchAPI<{ goals: GoalNode[]; note?: string }>('/goals/hierarchy');
  return data.goals ?? [];
}

// ============ Token Usage ============

export async function getTokenUsage(): Promise<TokenUsage[]> {
  const data = await fetchAPI<{ usage: TokenUsage[] }>('/token-usage');
  return data.usage ?? [];
}

// ============ Traces ============

export async function getTraces(limit = 50): Promise<TraceRecord[]> {
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/traces?limit=${limit}`);
  return data.traces ?? [];
}

export async function getTraceByRevision(revision: string): Promise<TraceRecord | null> {
  try {
    const data = await fetchAPI<{ trace: TraceRecord }>(`/traces/revision/${revision}`);
    return data.trace;
  } catch {
    return null;
  }
}

// ============ Git Info ============

export async function getGitInfo(projectPath: string): Promise<GitInfo | null> {
  try {
    const encoded = encodeURIComponent(projectPath);
    return fetchAPI<GitInfo>(`/projects/${encoded}/git`);
  } catch {
    return null;
  }
}

// ============ Session Actions ============

export async function sendSessionMessage(sessionId: string, message: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/message`, { message });
}

export async function stopSession(sessionId: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}

// ============ Cockpit v0.1 ============ 

export type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
export type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

export interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

export interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

export interface DailyMetrics {
  tokens: number;
  locTouched: number;
  commits: number;
  prs: number;
  tests: number;
  sessions: {
    running: number;
    ready: number;
    done: number;
  };
  escalationsOpen: number;
}

export interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

export interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

export interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

export interface FocusData {
  type: 'session' | 'escalation';
  id: string;
  sessionKey: string;
  header: Record<string, unknown>;
  packet: FocusPacket | null;
  pointers: Record<string, string>;
}

export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
}

export interface CockpitDiff {
  baseSha: string;
  headSha: string;
  source: 'query' | 'session' | 'git-parent' | 'unknown';
  summary: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  hotspots: DiffHotspot[];
  patch: string | null;
}

export interface CockpitTestReport {
  id: string;
  sessionKey: string;
  workItemId: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
  cliOutput: string;
  command: string;
  coverage: Record<string, unknown> | null;
  mutationScore: number | null;
  agentNote: string;
  durationMs: number;
  createdAt: string;
}

export interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface PostCockpitPacketInput {
  sessionKey: string;
  packetId?: string;
  workItemId?: string;
  escalationId?: string;
  type?: 'escalation' | 'review' | 'session' | 'ready' | 'ready_review' | 'pr_review';
  markdown?: string;
  contentMarkdown?: string;
  markdownPath?: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  createdAt?: string | number;
  source?: string;
  requestId?: string;
}

export interface CockpitSessionControlInput {
  action: 'start' | 'stop' | 'fork';
  message?: string;
  note?: string;
  targetSessionKey?: string;
}

export interface CockpitSessionReviewDecisionInput {
  decision: 'accept' | 'request_changes';
  note?: string;
  requestId?: string;
}

export interface CockpitPatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface CockpitPatchApplyInput {
  sessionKey: string;
  baseSha?: string;
  patch?: string;
  edits?: CockpitPatchEditInput[];
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserActionInput {
  sessionKey: string;
  action: 'open' | 'back' | 'forward' | 'reload' | 'snapshot' | 'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll' | 'get_url' | 'get_title' | 'screenshot' | 'close';
  url?: string;
  target?: string;
  text?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserEvidence {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

export interface CockpitBrowserState {
  sessionKey: string;
  browserSession: string;
  available: boolean;
  connected: boolean;
  currentUrl?: string;
  title?: string;
  lastActionAt?: string;
  actions: Array<Record<string, unknown>>;
  evidence: CockpitBrowserEvidence[];
  lastSnapshotPath?: string;
  lastSnapshotPreview?: string;
}

export async function getCockpitSessionRollups(
  status: SessionPanelStatus,
  limit = 100
): Promise<SessionRollup[]> {
  const data = await fetchAPI<{ rollups: SessionRollup[] }>(
    `/cockpit/rollups/sessions?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitEscalationRollups(limit = 100): Promise<EscalationRollup[]> {
  const data = await fetchAPI<{ rollups: EscalationRollup[] }>(
    `/cockpit/rollups/escalations?status=open&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitCommitRollups(limit = 50): Promise<CommitRollup[]> {
  const data = await fetchAPI<{ rollups: CommitRollup[] }>(`/cockpit/rollups/commits?limit=${limit}`);
  return data.rollups ?? [];
}

export async function getCockpitPRRollups(
  status: 'open' | 'closed' | 'merged' = 'open',
  limit = 50
): Promise<PRRollup[]> {
  const data = await fetchAPI<{ rollups: PRRollup[] }>(
    `/cockpit/rollups/prs?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitDailyMetrics(date?: string): Promise<DailyMetrics | null> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const data = await fetchAPI<{ metrics: DailyMetrics | null }>(`/cockpit/metrics/daily${query}`);
  return data.metrics ?? null;
}

export async function getCockpitFocus(
  type: 'session' | 'escalation',
  id: string,
  packetId?: string
): Promise<FocusData | null> {
  const packetQuery = packetId ? `&packetId=${encodeURIComponent(packetId)}` : '';
  const data = await fetchAPI<{ focus: FocusData | null }>(
    `/cockpit/focus?type=${type}&id=${encodeURIComponent(id)}${packetQuery}`
  );
  return data.focus ?? null;
}

export async function getCockpitSessionEvents(
  sessionKey: string,
  options: { cursor?: number; limit?: number } = {}
): Promise<{ events: NormalizedSessionEvent[]; nextCursor: number | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 200));
  if (typeof options.cursor === 'number') {
    params.set('cursor', String(options.cursor));
  }
  const data = await fetchAPI<{ events: NormalizedSessionEvent[]; nextCursor: number | null }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/events?${params.toString()}`
  );
  return {
    events: data.events ?? [],
    nextCursor: data.nextCursor ?? null,
  };
}

export async function getCockpitSessionPackets(
  sessionKey: string,
  limit = 20
): Promise<FocusPacket[]> {
  const data = await fetchAPI<{ packets: FocusPacket[] }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/packets?limit=${limit}`
  );
  return data.packets ?? [];
}

export async function getCockpitTraces(
  sessionKey: string,
  options: { workItemId?: string; limit?: number } = {}
): Promise<TraceRecord[]> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  params.set('limit', String(options.limit ?? 200));
  if (options.workItemId) params.set('workItemId', options.workItemId);
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/cockpit/traces?${params.toString()}`);
  return data.traces ?? [];
}

export async function getCockpitDiff(options: {
  sessionKey?: string;
  base?: string;
  head?: string;
  file?: string;
}): Promise<CockpitDiff> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.base) params.set('base', options.base);
  if (options.head) params.set('head', options.head);
  if (options.file) params.set('file', options.file);
  return fetchAPI<CockpitDiff>(`/cockpit/diff?${params.toString()}`);
}

export async function getCockpitTestReports(
  options: { sessionKey?: string; workItemId?: string; limit?: number } = {}
): Promise<CockpitTestReport[]> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.workItemId) params.set('workItemId', options.workItemId);
  params.set('limit', String(options.limit ?? 20));
  const data = await fetchAPI<{ reports: CockpitTestReport[] }>(`/cockpit/tests?${params.toString()}`);
  return data.reports ?? [];
}

export async function getCockpitTestReport(testReportId: string): Promise<CockpitTestReport | null> {
  try {
    const data = await fetchAPI<{ report: CockpitTestReport | null }>(
      `/cockpit/tests/${encodeURIComponent(testReportId)}`
    );
    return data.report ?? null;
  } catch {
    return null;
  }
}

export async function searchCockpitRepoLens(options: {
  sessionKey?: string;
  q: string;
  kind?: 'all' | 'defs' | 'refs' | 'text';
  limit?: number;
}): Promise<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }> {
  const params = new URLSearchParams();
  params.set('q', options.q);
  params.set('kind', options.kind ?? 'all');
  params.set('limit', String(options.limit ?? 120));
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  const data = await fetchAPI<{
    results: { defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] };
  }>(`/cockpit/repo/lens?${params.toString()}`);
  return data.results ?? { defs: [], refs: [], text: [] };
}

export async function getCockpitPreview(options: {
  sessionKey?: string;
  url?: string;
}): Promise<{ url: string; source: 'query' | 'session' } | null> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.url) params.set('url', options.url);
  try {
    return await fetchAPI<{ url: string; source: 'query' | 'session' }>(`/cockpit/preview?${params.toString()}`);
  } catch {
    return null;
  }
}

export async function getCockpitBrowserState(sessionKey: string): Promise<CockpitBrowserState | null> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  try {
    const data = await fetchAPI<{ state: CockpitBrowserState }>(`/cockpit/browser/state?${params.toString()}`);
    return data.state ?? null;
  } catch {
    return null;
  }
}

export async function postCockpitBrowserAction(
  input: CockpitBrowserActionInput
): Promise<{
  success: boolean;
  action?: string;
  browserSession?: string;
  data?: unknown;
  output?: string;
  artifactPath?: string;
  currentUrl?: string;
  title?: string;
  evidence?: CockpitBrowserEvidence;
  error?: string;
}> {
  return postAPI('/cockpit/browser/action', input);
}

export async function postCockpitBrowserRunbook(input: {
  sessionKey: string;
  script: string;
  stopOnError?: boolean;
  workItemId?: string;
  requestId?: string;
}): Promise<{
  success: boolean;
  browserSession?: string;
  stopOnError?: boolean;
  steps?: Array<Record<string, unknown>>;
  evidence?: CockpitBrowserEvidence[];
  currentUrl?: string;
  title?: string;
}> {
  return postAPI('/cockpit/browser/runbook', input);
}

export async function resolveCockpitEscalation(
  escalationId: string,
  input: {
    optionId?: string;
    freeformResponse?: string;
    note?: string;
  } = {}
): Promise<{ success: boolean; escalation?: Record<string, unknown>; result?: Record<string, unknown> }> {
  return postAPI(`/cockpit/escalations/${encodeURIComponent(escalationId)}/resolve`, input);
}

export async function postCockpitPacket(
  input: PostCockpitPacketInput
): Promise<{ success: boolean; packet?: Record<string, unknown> }> {
  return postAPI('/cockpit/packets', input);
}

export async function postCockpitSessionMessage(
  sessionKey: string,
  message: string
): Promise<{ success: boolean; requestId?: string; queued?: boolean }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/message`, { message });
}

export async function postCockpitSessionControl(
  sessionKey: string,
  input: CockpitSessionControlInput
): Promise<{ success: boolean; requestId?: string; targetSessionKey?: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/control`, input);
}

export async function postCockpitSessionReviewDecision(
  sessionKey: string,
  input: CockpitSessionReviewDecisionInput
): Promise<{ success: boolean; sessionKey: string; decision: string; fromStatus: string; toStatus: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/review`, input);
}

export async function applyCockpitPatch(
  input: CockpitPatchApplyInput
): Promise<{
  success: boolean;
  mode?: 'patch' | 'edits';
  files?: string[];
  changedLines?: number;
  warning?: string;
}> {
  return postAPI('/cockpit/patch/apply', input);
}


### function_call
@callId call_2c4f7ce4feec4ccd8cfae296
@name Read
@ts 1770352715341
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_2c4f7ce4feec4ccd8cfae296
@ts 1770352715358
@durationMs 6
@workItemId 68ac7230
/**
 * Control Plane API Routes for harness-daemon
 *
 * Provides REST endpoints for the Control Plane dashboard:
 * - Project/Session listing (from GraphD)
 * - Goal hierarchy (placeholder)
 * - Git integration via gh CLI
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GraphDManager } from 'graphd';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  parseSessionEscalations,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ControlPlaneContext {
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
  dispatchSessionInput?: (
    sessionKey: string,
    message: string
  ) => {
    success: boolean;
    requestId?: string;
    queued?: boolean;
    error?: string;
  };
  stopSession?: (
    sessionKey: string,
    note?: string
  ) => {
    success: boolean;
    requestId?: string;
    error?: string;
  };
  forkSession?: (
    sourceSessionKey: string,
    targetSessionKey?: string
  ) => {
    success: boolean;
    targetSessionKey?: string;
    error?: string;
  };
  resolveSessionEscalation?: (
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ) => {
    success: boolean;
    escalationId: string;
    pendingCount?: number;
    sessionStatus?: string;
    resumed?: boolean;
    resumeRequestId?: string;
    alreadyResolved?: boolean;
    error?: string;
  };
}

interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

interface GitRemote {
  owner: string;
  repo: string;
}

interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface SessionRow {
  sessionKey: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: number;
  lastAccessedAt: number;
  goal?: string | null;
  currentWorkItemId?: string | null;
  currentObjective?: string | null;
  lastUserMessagePreview?: string | null;
  metadata?: Record<string, unknown>;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
}

interface TraceSummary {
  filesTouched: number;
  lastFile?: string;
  lastLine?: number;
  latestTimestampMs?: number;
}

interface TestReportSummary {
  sessionKey: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  createdAtMs: number;
  invariantsPassed?: number;
  invariantsTotal?: number;
}

interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
}

interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

interface TestReportRecord {
  id: string;
  session_key: string;
  work_item_id: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: unknown[];
  cases: unknown[];
  cli_output: string | null;
  command: string | null;
  coverage: Record<string, unknown> | null;
  mutation_score: number | null;
  agent_note: string | null;
  duration_ms: number | null;
  created_at: Date | string | number;
}

const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

interface SessionCommitEvent {
  sha: string;
  headSha: string;
  baseSha?: string;
  timestampMs: number;
  sessionKey: string;
  workItemId?: string;
}

interface PatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

type BrowserActionName =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'get_url'
  | 'get_title'
  | 'screenshot'
  | 'close';

interface BrowserActionInput {
  action: BrowserActionName;
  target?: string;
  text?: string;
  url?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
}

interface BrowserActionResult {
  success: boolean;
  action: BrowserActionName;
  args: string[];
  stdout?: string;
  data?: unknown;
  error?: string;
  artifactPath?: string;
}

interface BrowserRunbookStep {
  line: number;
  input: BrowserActionInput;
}

interface BrowserEvidenceItem {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const gitRemoteCache = new Map<string, { data: GitRemote | null; fetchedAt: number }>();
const GIT_CACHE_TTL_MS = 60 * 1000; // 1 minute
const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number
): number {
  const events = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let total = 0;
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'llm_call') continue;
    const ts = parseTimestampMs(entry.timestamp);
    if (!ts || ts < startMs || ts >= endMs) continue;
    const data = isRecord(entry.data) ? entry.data : {};
    const prompt = asNumber(data.prompt_tokens ?? data.promptTokens) ?? 0;
    const completion = asNumber(data.completion_tokens ?? data.completionTokens) ?? 0;
    total += prompt + completion;
  }
  return total;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Execute gh CLI command
 */
async function ghCommand(args: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      timeout: 30000,
      cwd,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (error) {
    console.error('[control-plane] gh command failed:', args, error);
    throw error;
  }
}

/**
 * Get PRs for a repository
 */
async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const result = await ghCommand(
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft,headRefName,baseRefName,body`
    );
    const prs: PRInfo[] = JSON.parse(result).map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.state as string).toLowerCase() as PRInfo['state'],
      author: (pr.author as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.url as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changedFiles as number) ?? 0,
      createdAt: pr.createdAt as string,
      updatedAt: pr.updatedAt as string,
      isDraft: (pr.isDraft as boolean) ?? false,
      headRefName: pr.headRefName as string,
      baseRefName: pr.baseRefName as string,
      body: pr.body as string,
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
  } catch {
    return [];
  }
}

/**
 * Parse git remote URL to extract owner/repo
 */
function parseGitRemote(remoteUrl: string): GitRemote | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Get git remote info for a project
 */
async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
  const cached = gitRemoteCache.get(projectPath);
  if (cached && Date.now() - cached.fetchedAt < GIT_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
      timeout: 5000,
    });
    const remote = parseGitRemote(stdout.trim());
    gitRemoteCache.set(projectPath, { data: remote, fetchedAt: Date.now() });
    return remote;
  } catch {
    gitRemoteCache.set(projectPath, { data: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Get recent commits for a project
 */
async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
  try {
    const { stdout } = await execAsync(
      `git log -${limit} --pretty=format:'{"sha":"%h","message":"%s","author":"%an","date":"%ci"}'`,
      { cwd: projectPath, timeout: 10000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Parse URL and extract path/query
 */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Route matcher for path patterns like /control-plane/projects/:id/features
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Format session row for API response
 */
function formatSession(row: SessionRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  const lastAccessedAt = row.lastAccessedAt ? new Date(row.lastAccessedAt * 1000).toISOString() : null;
  return {
    id: row.sessionKey,
    clientType: row.clientType,
    workingDir: row.workingDir,
    status: row.status,
    createdAt,
    lastAccessedAt,
    metadata: row.metadata,
  };
}

/**
 * Format message row for API response
 */
function formatMessage(row: MessageRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    requestId: row.requestId,
    createdAt,
    metadata: row.metadata,
  };
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

async function execFileText(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 15_000,
    maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
    encoding: 'utf8',
  } as any);
  return toStringOutput((result as any).stdout);
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function shaMatches(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const commits: SessionCommitEvent[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'git_commit') continue;
    const ts = parseTimestampMs(entry.timestamp);
    const data = isRecord(entry.data) ? entry.data : null;
    const sha = asString(data?.sha);
    if (!sha || !ts) continue;
    const headSha = asString(data?.head_sha) ?? asString(data?.headSha) ?? sha;
    const baseSha = asString(data?.base_sha) ?? asString(data?.baseSha);
    commits.push({
      sha: headSha,
      headSha,
      ...(baseSha ? { baseSha } : {}),
      timestampMs: ts,
      sessionKey: session.sessionKey,
      ...(asString(entry.work_item_id) ? { workItemId: asString(entry.work_item_id) } : {}),
    });
  }
  return commits.sort((a, b) => a.timestampMs - b.timestampMs);
}

function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
  for (const event of events) {
    if (shaMatches(event.sha, sha)) return event;
  }
  return undefined;
}

function getLatestRevisionRange(
  session: SessionRow,
  requestedHeadSha?: string
): { baseSha?: string; headSha?: string } {
  const commits = getSessionCommitEvents(session);
  if (commits.length === 0) {
    const metadata = session.metadata ?? {};
    const baseSha = asString(metadata.baseSha) ?? asString(metadata.base_sha);
    const headSha = requestedHeadSha
      ?? asString(metadata.headSha)
      ?? asString(metadata.head_sha)
      ?? asString(metadata.commitSha)
      ?? asString(metadata.commit_sha)
      ?? asString(metadata.revision);
    return { baseSha, headSha };
  }

  if (requestedHeadSha) {
    const index = commits.findIndex((entry) => shaMatches(entry.headSha, requestedHeadSha) || shaMatches(entry.sha, requestedHeadSha));
    if (index >= 0) {
      const matched = commits[index];
      return {
        ...(matched.baseSha
          ? { baseSha: matched.baseSha }
          : index > 0
            ? { baseSha: commits[index - 1].headSha }
            : {}),
        headSha: matched.headSha,
      };
    }
    return { headSha: requestedHeadSha };
  }

  const head = commits[commits.length - 1];
  return {
    ...(head.baseSha
      ? { baseSha: head.baseSha }
      : commits.length > 1
        ? { baseSha: commits[commits.length - 2].headSha }
        : {}),
    headSha: head.headSha,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    if (Number.isFinite(added)) totalAdded += added;
    if (Number.isFinite(deleted)) totalDeleted += deleted;
    filesTouched += 1;
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  return {
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched,
    },
    hotspots,
  };
}

function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
  const commits: CommitRollup[] = [];
  const lines = stdout.split('\n');
  let current: CommitRollup | null = null;

  for (const raw of lines) {
    if (raw.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const payload = raw.slice('__COMMIT__'.length);
      const [shaRaw, authorRaw, timeRaw, messageRaw] = payload.split('\u001f');
      const sha = (shaRaw ?? '').trim();
      const author = (authorRaw ?? '').trim();
      const time = (timeRaw ?? '').trim();
      const message = (messageRaw ?? '').trim();
      if (!sha || !time) {
        current = null;
        continue;
      }
      current = {
        sha,
        message,
        author: author || 'unknown',
        time,
        diffstat: { added: 0, deleted: 0, filesTouched: 0 },
        projectPath,
      };
      continue;
    }

    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    if (Number.isFinite(added)) current.diffstat.added += added;
    if (Number.isFinite(deleted)) current.diffstat.deleted += deleted;
    current.diffstat.filesTouched += 1;
  }
  if (current) commits.push(current);

  return commits;
}

async function loadSessionDiffstats(
  sessions: SessionRow[]
): Promise<Map<string, { added: number; deleted: number; filesTouched: number }>> {
  const bySession = new Map<string, { added: number; deleted: number; filesTouched: number }>();
  const cachedByRange = new Map<string, { added: number; deleted: number; filesTouched: number }>();

  for (const session of sessions) {
    const workingDir = session.workingDir;
    if (!workingDir) continue;
    const range = getLatestRevisionRange(session);
    if (!range.baseSha || !range.headSha) continue;
    const cacheKey = `${workingDir}\u001f${range.baseSha}\u001f${range.headSha}`;
    const cached = cachedByRange.get(cacheKey);
    if (cached) {
      bySession.set(session.sessionKey, cached);
      continue;
    }
    try {
      const numstat = await execFileText(
        'git',
        ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
        { cwd: workingDir, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const parsed = parseNumstatOutput(numstat).summary;
      cachedByRange.set(cacheKey, parsed);
      bySession.set(session.sessionKey, parsed);
    } catch {
      // Keep trace fallback when git diffstat is unavailable.
    }
  }

  return bySession;
}

function mapTestReportRow(row: TestReportRecord): Record<string, unknown> {
  const createdAtMs = row.created_at instanceof Date
    ? row.created_at.getTime()
    : parseTimestampMs(row.created_at) ?? Date.now();
  return {
    id: row.id,
    sessionKey: row.session_key,
    workItemId: row.work_item_id,
    verdict: row.verdict,
    categories: Array.isArray(row.categories) ? row.categories : [],
    cases: Array.isArray(row.cases) ? row.cases : [],
    cliOutput: row.cli_output ?? '',
    command: row.command ?? '',
    coverage: row.coverage ?? null,
    mutationScore: row.mutation_score ?? null,
    agentNote: row.agent_note ?? '',
    durationMs: row.duration_ms ?? 0,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function isLockfilePath(filePath: string): boolean {
  const name = filePath.trim().toLowerCase();
  return (
    name.endsWith('/package-lock.json') || name === 'package-lock.json'
    || name.endsWith('/yarn.lock') || name === 'yarn.lock'
    || name.endsWith('/pnpm-lock.yaml') || name === 'pnpm-lock.yaml'
    || name.endsWith('/bun.lock') || name === 'bun.lock'
    || name.endsWith('/bun.lockb') || name === 'bun.lockb'
    || name.endsWith('/cargo.lock') || name === 'cargo.lock'
  );
}

function normalizeDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/')
    ? trimmed.slice(2)
    : trimmed;
  return withoutPrefix.replace(/^"+|"+$/g, '');
}

function parsePatchStats(patch: string): {
  files: string[];
  changedLines: number;
  hasBinary: boolean;
} {
  const files = new Set<string>();
  let changedLines = 0;
  let hasBinary = false;
  const lines = patch.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      hasBinary = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim();
      if (candidate !== '/dev/null') {
        files.add(normalizeDiffPath(candidate));
      }
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      changedLines += 1;
    }
  }
  return { files: Array.from(files), changedLines, hasBinary };
}

function parsePatchEdits(value: unknown): PatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: PatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const filePath = asString(entry.path);
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!filePath || !startLine || !endLine || replacement === undefined) continue;
    edits.push({
      path: filePath,
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

async function resolveSessionFilePath(workingDir: string, relativePath: string): Promise<{
  resolvedPath?: string;
  relativePath?: string;
  error?: string;
}> {
  const path = await import('path');
  const baseDir = path.resolve(workingDir);
  const resolvedPath = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(baseDir, relativePath);
  const inWorkingDir = resolvedPath === baseDir || resolvedPath.startsWith(`${baseDir}${path.sep}`);
  if (!inWorkingDir) {
    return { error: 'Patch paths must resolve inside the session working directory' };
  }
  return {
    resolvedPath,
    relativePath: path.relative(baseDir, resolvedPath),
  };
}

async function enforcePatchConstraints(
  mode: 'patch' | 'edits',
  files: string[],
  changedLines: number
): Promise<{ ok: boolean; error?: string }> {
  if (files.length === 0) {
    return { ok: false, error: `No files detected in ${mode}` };
  }
  if (files.length > 3) {
    return { ok: false, error: `Patch exceeds file limit: ${files.length} > 3` };
  }
  if (changedLines > 30) {
    return { ok: false, error: `Patch exceeds changed-line limit: ${changedLines} > 30` };
  }
  for (const filePath of files) {
    if (isLockfilePath(filePath)) {
      return { ok: false, error: `Lockfile edits are blocked by default: ${filePath}` };
    }
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return { ok: false, error: `Unsafe path in patch: ${filePath}` };
    }
  }
  return { ok: true };
}

let agentBrowserAvailabilityCache: { available: boolean; checkedAtMs: number } | null = null;

function normalizeBrowserSessionName(sessionKey: string): string {
  const safe = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normalized = safe || 'session';
  return `cockpit-${normalized}`.slice(0, 72);
}

function sanitizeArtifactToken(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'artifact';
}

function browserTimestampToken(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function toActionError(action: BrowserActionName, message: string): { error: string } {
  return { error: `${action}: ${message}` };
}

function normalizeBrowserActionName(value: string | undefined): BrowserActionName | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'open') return 'open';
  if (normalized === 'back') return 'back';
  if (normalized === 'forward') return 'forward';
  if (normalized === 'reload') return 'reload';
  if (normalized === 'snapshot') return 'snapshot';
  if (normalized === 'click') return 'click';
  if (normalized === 'fill') return 'fill';
  if (normalized === 'type') return 'type';
  if (normalized === 'press') return 'press';
  if (normalized === 'wait') return 'wait';
  if (normalized === 'scroll') return 'scroll';
  if (normalized === 'get_url' || normalized === 'geturl') return 'get_url';
  if (normalized === 'get_title' || normalized === 'gettitle') return 'get_title';
  if (normalized === 'screenshot') return 'screenshot';
  if (normalized === 'close') return 'close';
  return null;
}

function parseBrowserActionInput(value: Record<string, unknown>): { input?: BrowserActionInput; error?: string } {
  const action = normalizeBrowserActionName(asString(value.action));
  if (!action) {
    return { error: 'Invalid browser action. Allowed: open, back, forward, reload, snapshot, click, fill, type, press, wait, scroll, get_url, get_title, screenshot, close.' };
  }

  const target = asString(value.target);
  const text = asString(value.text) ?? asString(value.value);
  const url = asString(value.url);
  const interactive = asBoolean(value.interactive);
  const compact = asBoolean(value.compact);
  const depth = asNumber(value.depth);
  const selector = asString(value.selector);
  const directionRaw = asString(value.direction)?.toLowerCase();
  const direction = directionRaw === 'up' || directionRaw === 'down' || directionRaw === 'left' || directionRaw === 'right'
    ? directionRaw
    : undefined;
  const pixels = asNumber(value.pixels);
  const waitMs = asNumber(value.waitMs ?? value.wait_ms);
  const label = asString(value.label);

  if (action === 'open' && !url) return toActionError(action, 'Missing required field: url');
  if (action === 'click' && !target) return toActionError(action, 'Missing required field: target');
  if ((action === 'fill' || action === 'type') && (!target || text === undefined)) {
    return toActionError(action, 'Missing required fields: target and text');
  }
  if (action === 'press' && !text && !target) {
    return toActionError(action, 'Missing required field: text (or target)');
  }
  if (action === 'wait' && waitMs === undefined && !target) {
    return toActionError(action, 'Missing required field: waitMs or target');
  }
  if (action === 'snapshot' && depth !== undefined && (depth < 1 || depth > 25)) {
    return toActionError(action, 'depth must be between 1 and 25');
  }
  if (action === 'scroll' && directionRaw && !direction) {
    return toActionError(action, 'direction must be one of up|down|left|right');
  }

  return {
    input: {
      action,
      ...(target ? { target } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(url ? { url } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
      ...(compact !== undefined ? { compact } : {}),
      ...(typeof depth === 'number' ? { depth: Math.floor(depth) } : {}),
      ...(selector ? { selector } : {}),
      ...(direction ? { direction } : {}),
      ...(typeof pixels === 'number' ? { pixels: Math.floor(pixels) } : {}),
      ...(typeof waitMs === 'number' ? { waitMs: Math.max(1, Math.floor(waitMs)) } : {}),
      ...(label ? { label } : {}),
    },
  };
}

function buildBrowserActionArgs(input: BrowserActionInput, artifactPath?: string): string[] {
  switch (input.action) {
    case 'open':
      return ['open', input.url ?? ''];
    case 'back':
      return ['back'];
    case 'forward':
      return ['forward'];
    case 'reload':
      return ['reload'];
    case 'snapshot': {
      const args = ['snapshot'];
      if (input.interactive) args.push('--interactive');
      if (input.compact) args.push('--compact');
      if (typeof input.depth === 'number') args.push('--depth', String(input.depth));
      if (input.selector) args.push('--selector', input.selector);
      return args;
    }
    case 'click':
      return ['click', input.target ?? ''];
    case 'fill':
      return ['fill', input.target ?? '', input.text ?? ''];
    case 'type':
      return ['type', input.target ?? '', input.text ?? ''];
    case 'press':
      return ['press', input.text ?? input.target ?? ''];
    case 'wait':
      return ['wait', String(input.waitMs ?? input.target ?? '1000')];
    case 'scroll': {
      const args = ['scroll', input.direction ?? 'down'];
      if (typeof input.pixels === 'number') args.push(String(input.pixels));
      return args;
    }
    case 'get_url':
      return ['get', 'url'];
    case 'get_title':
      return ['get', 'title'];
    case 'screenshot':
      return artifactPath ? ['screenshot', artifactPath] : ['screenshot'];
    case 'close':
      return ['close'];
  }
}

function summarizeBrowserData(data: unknown, maxChars = 1600): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') {
    return data.length > maxChars ? `${data.slice(0, maxChars)}...` : data;
  }
  try {
    const json = JSON.stringify(data);
    if (!json) return undefined;
    return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
  } catch {
    return undefined;
  }
}

function parseBrowserCliJson(raw: string): { success: boolean; data?: unknown; error?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const success = typeof parsed.success === 'boolean' ? parsed.success : true;
    const error = asString(parsed.error);
    return {
      success,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return null;
  }
}

async function checkAgentBrowserAvailable(workingDir: string): Promise<boolean> {
  const nowMs = Date.now();
  if (agentBrowserAvailabilityCache && nowMs - agentBrowserAvailabilityCache.checkedAtMs < 60_000) {
    return agentBrowserAvailabilityCache.available;
  }
  try {
    await execFileText('agent-browser', ['session', 'list', '--json'], {
      cwd: workingDir,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    agentBrowserAvailabilityCache = { available: true, checkedAtMs: nowMs };
    return true;
  } catch {
    agentBrowserAvailabilityCache = { available: false, checkedAtMs: nowMs };
    return false;
  }
}

async function allocateBrowserArtifactPath(
  workingDir: string,
  sessionKey: string,
  type: 'screenshots' | 'snapshots',
  ext: 'png' | 'json' = 'png',
  label?: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const baseDir = path.join(
    workingDir,
    '.cockpit',
    'browser',
    sanitizeArtifactToken(sessionKey),
    type
  );
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = browserTimestampToken();
  const suffix = label ? `_${sanitizeArtifactToken(label)}` : '';
  const fileName = `${stamp}${suffix}.${ext}`;
  const absolutePath = path.join(baseDir, fileName);
  const relativePath = path.relative(workingDir, absolutePath);
  return { absolutePath, relativePath };
}

function tokenizedRunbookLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseBrowserRunbook(script: string): { steps: BrowserRunbookStep[]; error?: string } {
  const lines = script.split('\n');
  const steps: BrowserRunbookStep[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = tokenizedRunbookLine(trimmed);
    if (tokens.length === 0) continue;
    const lineNo = idx + 1;
    const command = tokens[0].toLowerCase();

    const withInput = (input: BrowserActionInput) => {
      steps.push({ line: lineNo, input });
    };

    if (command === 'open') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: open requires a URL` };
      withInput({ action: 'open', url: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'click') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: click requires a target` };
      withInput({ action: 'click', target: tokens[1] });
      continue;
    }
    if (command === 'fill' || command === 'type') {
      if (!tokens[1] || tokens.length < 3) {
        return { steps: [], error: `Runbook line ${lineNo}: ${command} requires target + text` };
      }
      withInput({
        action: command,
        target: tokens[1],
        text: tokens.slice(2).join(' '),
      });
      continue;
    }
    if (command === 'press') {
      if (tokens.length < 2) return { steps: [], error: `Runbook line ${lineNo}: press requires a key` };
      withInput({ action: 'press', text: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'wait') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: wait requires milliseconds or a selector` };
      const waitMs = Number(tokens[1]);
      if (Number.isFinite(waitMs)) {
        withInput({ action: 'wait', waitMs: Math.max(1, Math.floor(waitMs)) });
      } else {
        withInput({ action: 'wait', target: tokens.slice(1).join(' ') });
      }
      continue;
    }
    if (command === 'scroll') {
      const direction = (tokens[1] ?? 'down').toLowerCase();
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return { steps: [], error: `Runbook line ${lineNo}: invalid scroll direction "${direction}"` };
      }
      const pixels = tokens[2] ? Number(tokens[2]) : undefined;
      withInput({
        action: 'scroll',
        direction,
        ...(Number.isFinite(pixels) ? { pixels: Math.floor(Number(pixels)) } : {}),
      });
      continue;
    }
    if (command === 'snapshot') {
      let interactive = false;
      let compact = false;
      let depth: number | undefined;
      let selector: string | undefined;
      for (let t = 1; t < tokens.length; t += 1) {
        const token = tokens[t];
        if (token === '-i' || token === '--interactive') {
          interactive = true;
          continue;
        }
        if (token === '-c' || token === '--compact') {
          compact = true;
          continue;
        }
        if ((token === '-d' || token === '--depth') && tokens[t + 1]) {
          const parsed = Number(tokens[t + 1]);
          if (Number.isFinite(parsed)) depth = Math.floor(parsed);
          t += 1;
          continue;
        }
        if ((token === '-s' || token === '--selector') && tokens[t + 1]) {
          selector = tokens[t + 1];
          t += 1;
        }
      }
      withInput({
        action: 'snapshot',
        interactive,
        compact,
        ...(typeof depth === 'number' ? { depth } : {}),
        ...(selector ? { selector } : {}),
      });
      continue;
    }
    if (command === 'screenshot') {
      withInput({
        action: 'screenshot',
        ...(tokens[1] ? { label: tokens.slice(1).join(' ') } : {}),
      });
      continue;
    }
    if (command === 'get') {
      const what = (tokens[1] ?? '').toLowerCase();
      if (what === 'url') {
        withInput({ action: 'get_url' });
        continue;
      }
      if (what === 'title') {
        withInput({ action: 'get_title' });
        continue;
      }
      return { steps: [], error: `Runbook line ${lineNo}: get supports only "url" or "title"` };
    }
    if (command === 'back' || command === 'forward' || command === 'reload' || command === 'close') {
      withInput({ action: command });
      continue;
    }

    return { steps: [], error: `Runbook line ${lineNo}: unsupported command "${tokens[0]}"` };
  }

  if (steps.length === 0) {
    return { steps: [], error: 'Runbook is empty. Add at least one command.' };
  }
  if (steps.length > 40) {
    return { steps: [], error: `Runbook exceeds step limit: ${steps.length} > 40` };
  }
  return { steps };
}

function buildBrowserEvidenceId(sessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bev_${sanitizeArtifactToken(sessionKey)}_${Date.now().toString(36)}_${suffix}`;
}

function parseBrowserEvidence(value: unknown): BrowserEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const evidence: BrowserEvidenceItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const typeRaw = asString(entry.type);
    const type = typeRaw === 'snapshot' ? 'snapshot' : typeRaw === 'screenshot' ? 'screenshot' : null;
    const artifactPath = asString(entry.path);
    const createdAt = asString(entry.createdAt);
    if (!id || !type || !artifactPath || !createdAt) continue;
    evidence.push({
      id,
      type,
      path: artifactPath,
      createdAt,
      ...(asString(entry.label) ? { label: asString(entry.label) } : {}),
      ...(asString(entry.url) ? { url: asString(entry.url) } : {}),
      ...(asString(entry.title) ? { title: asString(entry.title) } : {}),
    });
  }
  return evidence.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function runBrowserAction(
  workingDir: string,
  browserSession: string,
  sessionKey: string,
  input: BrowserActionInput
): Promise<BrowserActionResult> {
  let artifactPath: string | undefined;
  let snapshotArtifactAbsPath: string | undefined;
  if (input.action === 'screenshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'screenshots',
      'png',
      input.label
    );
    artifactPath = artifact.relativePath;
    const args = buildBrowserActionArgs(input, artifact.absolutePath);
    const result = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
      cwd: workingDir,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    } as any).then((output) => ({
      stdout: toStringOutput((output as any).stdout),
      stderr: toStringOutput((output as any).stderr),
      error: null as Error | null,
    })).catch((error) => ({
      stdout: toStringOutput((error as any).stdout),
      stderr: toStringOutput((error as any).stderr),
      error: error as Error,
    }));
    const parsed = parseBrowserCliJson(result.stdout) ?? parseBrowserCliJson(result.stderr);
    if (parsed) {
      if (parsed.success) {
        return {
          success: true,
          action: input.action,
          args,
          stdout: result.stdout,
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          ...(artifactPath ? { artifactPath } : {}),
        };
      }
      return {
        success: false,
        action: input.action,
        args,
        stdout: result.stdout,
        error: parsed.error ?? result.error?.message ?? 'Browser command failed',
      };
    }
    return {
      success: !result.error,
      action: input.action,
      args,
      stdout: result.stdout || result.stderr,
      ...(result.error ? { error: result.error.message || result.stderr || 'Browser command failed' } : {}),
      ...(artifactPath && !result.error ? { artifactPath } : {}),
    };
  }

  if (input.action === 'snapshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'snapshots',
      'json'
    );
    snapshotArtifactAbsPath = artifact.absolutePath;
    artifactPath = artifact.relativePath;
  }

  const args = buildBrowserActionArgs(input);
  const rawResult = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
    cwd: workingDir,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  } as any).then((output) => ({
    stdout: toStringOutput((output as any).stdout),
    stderr: toStringOutput((output as any).stderr),
    error: null as Error | null,
  })).catch((error) => ({
    stdout: toStringOutput((error as any).stdout),
    stderr: toStringOutput((error as any).stderr),
    error: error as Error,
  }));

  const parsed = parseBrowserCliJson(rawResult.stdout) ?? parseBrowserCliJson(rawResult.stderr);
  if (parsed && parsed.success && input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    await fs.writeFile(snapshotArtifactAbsPath, JSON.stringify(parsed.data ?? {}, null, 2), 'utf8').catch(() => {});
  }
  if (parsed) {
    return {
      success: parsed.success,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.success && artifactPath ? { artifactPath } : {}),
    };
  }

  if (rawResult.error) {
    return {
      success: false,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      error: rawResult.error.message || rawResult.stderr || 'Browser command failed',
    };
  }
  if (input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    const fallback = rawResult.stdout || rawResult.stderr || '{}';
    await fs.writeFile(snapshotArtifactAbsPath, fallback, 'utf8').catch(() => {});
  }
  return {
    success: true,
    action: input.action,
    args,
    stdout: rawResult.stdout,
    ...(artifactPath ? { artifactPath } : {}),
  };
}

function parseBrowserStateFromMetadata(
  metadata: Record<string, unknown> | undefined
): {
  actions: Array<Record<string, unknown>>;
  evidence: BrowserEvidenceItem[];
  lastActionAt?: string;
  lastKnownUrl?: string;
  lastKnownTitle?: string;
} {
  const actions: Array<Record<string, unknown>> = [];
  const evidence = parseBrowserEvidence(metadata?.browser_evidence);
  const agentEvents = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let lastActionAt: string | undefined;
  let lastKnownUrl: string | undefined;
  let lastKnownTitle: string | undefined;
  for (const event of agentEvents) {
    if (!isRecord(event)) continue;
    const type = asString(event.type);
    if (type !== 'browser_action' && type !== 'browser_evidence_captured') continue;
    const at = asString(event.timestamp);
    const data = isRecord(event.data) ? event.data : {};
    if (type === 'browser_action') {
      actions.push({
        at,
        action: asString(data.action),
        success: data.success === false ? false : true,
        error: asString(data.error),
        outputPreview: asString(data.outputPreview),
        artifactPath: asString(data.artifactPath),
        line: asNumber(data.line),
      });
      if (!lastActionAt && at) lastActionAt = at;
      if (!lastKnownUrl) lastKnownUrl = asString(data.currentUrl);
      if (!lastKnownTitle) lastKnownTitle = asString(data.title);
      continue;
    }
    const id = asString(data.id);
    const typeRaw = asString(data.type);
    const path = asString(data.path);
    const createdAt = asString(data.createdAt) ?? at;
    if (!id || !typeRaw || !path || !createdAt) continue;
    if (typeRaw !== 'snapshot' && typeRaw !== 'screenshot') continue;
    evidence.push({
      id,
      type: typeRaw,
      path,
      createdAt,
      ...(asString(data.label) ? { label: asString(data.label) } : {}),
      ...(asString(data.url) ? { url: asString(data.url) } : {}),
      ...(asString(data.title) ? { title: asString(data.title) } : {}),
    });
  }
  actions.sort((a, b) => Date.parse(String(b.at ?? '')) - Date.parse(String(a.at ?? '')));
  const evidenceByKey = new Map<string, BrowserEvidenceItem>();
  for (const item of evidence) {
    const key = `${item.id}\u001f${item.path}\u001f${item.createdAt}`;
    if (!evidenceByKey.has(key)) {
      evidenceByKey.set(key, item);
    }
  }
  const dedupedEvidence = Array.from(evidenceByKey.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    actions: actions.slice(0, 80),
    evidence: dedupedEvidence.slice(0, 80),
    ...(lastActionAt ? { lastActionAt } : {}),
    ...(lastKnownUrl ? { lastKnownUrl } : {}),
    ...(lastKnownTitle ? { lastKnownTitle } : {}),
  };
}

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
    if (!packetId || !sessionKey || !typeRaw || !markdown || !createdMs) contin
... [truncated 50040 chars]

### function_call
@callId call_8121e993677b4f75a1f33421
@name Grep
@ts 1770352719685
@workItemId 68ac7230
{"path":"packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"normalizeSessionEvents|getSessionEvents"}

### function_call_output
@callId call_8121e993677b4f75a1f33421
@ts 1770352719707
@durationMs 19
@workItemId 68ac7230
No matches found for pattern: normalizeSessionEvents|getSessionEvents

### function_call
@callId call_a719981a7b7e47b1bb5d464f
@name Grep
@ts 1770352722690
@workItemId 68ac7230
{"path":"packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"/cockpit/session.*events|session/events"}

### function_call_output
@callId call_a719981a7b7e47b1bb5d464f
@ts 1770352723119
@durationMs 425
@workItemId 68ac7230
packages/harness-daemon/src/harness/control_plane_routes.ts:2690:24:  // GET /control-plane/cockpit/session/:sessionKey/events?cursor=...&limit=...
packages/harness-daemon/src/harness/control_plane_routes.ts:2691:38:  params = matchRoute('/control-plane/cockpit/session/:sessionKey/events', pathname);
packages/harness-daemon/src/harness/control_plane_routes.ts:3081:34:          events: `/control-plane/cockpit/session/${encodeURIComponent(session.sessionKey)}/events`,
packages/harness-daemon/src/harness/control_plane_routes.ts:3124:34:          events: `/control-plane/cockpit/session/${encodeURIComponent(escalation.sessionKey)}/events`,

### function_call
@callId call_328a98f2e9454be7bbb2970e
@name Read
@ts 1770352738589
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":2680,"endLine":2800}

### function_call_output
@callId call_328a98f2e9454be7bbb2970e
@ts 1770352738597
@durationMs 5
@workItemId 68ac7230
// Lines 2680-2800 of 3071 total
  // GET /control-plane/cockpit/browser/state?sessionKey=...
  if (pathname === '/control-plane/cockpit/browser/state' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    void handleGetCockpitBrowserState(res, ctx, sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/browser/action
  if (pathname === '/control-plane/cockpit/browser/action' && req.method === 'POST') {
    void handlePostCockpitBrowserAction(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/browser/runbook
  if (pathname === '/control-plane/cockpit/browser/runbook' && req.method === 'POST') {
    void handlePostCockpitBrowserRunbook(req, res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/session/:sessionKey/events?cursor=...&limit=...
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/events', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '200', 10);
    const cursor = query.get('cursor');
    handleGetCockpitSessionEvents(res, ctx, params.sessionKey, limit, cursor);
    return true;
  }

  // GET /control-plane/cockpit/session/:sessionKey/packets?limit=...
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/packets', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '20', 10);
    handleGetCockpitSessionPackets(res, ctx, params.sessionKey, limit);
    return true;
  }

  // POST /control-plane/cockpit/packets
  if (pathname === '/control-plane/cockpit/packets' && req.method === 'POST') {
    void handlePostCockpitPacket(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/message
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/message', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionMessage(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/control
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/control', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionControl(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/review
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/review', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionReviewDecision(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/escalations/:id/resolve
  params = matchRoute('/control-plane/cockpit/escalations/:id/resolve', pathname);
  if (params && req.method === 'POST') {
    void handleResolveCockpitEscalation(req, res, ctx, params.id);
    return true;
  }

  // POST /control-plane/cockpit/patch/apply
  if (pathname === '/control-plane/cockpit/patch/apply' && req.method === 'POST') {
    void handlePostCockpitPatchApply(req, res, ctx);
    return true;
  }

  // 404 for unmatched control-plane routes
  sendJson(res, { error: 'Not found' }, 404);
  return true;
}

function getAllSessions(
  ctx: ControlPlaneContext,
  limit = 1000
): { sessions: SessionRow[]; error?: string } {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    return { sessions: [], error: 'GraphD not available' };
  }
  const result = ctx.graphd.sessionsList({
    status: [...ALL_SESSION_STATUSES],
    limit,
    includePreview: true,
  }) as { sessions?: SessionRow[]; error?: string };
  return {
    sessions: result.sessions ?? [],
    ...(result.error ? { error: result.error } : {}),
  };
}

function getSession(ctx: ControlPlaneContext, sessionKey: string): SessionRow | null {
  if (!ctx.isGraphDReady() || !ctx.graphd) return null;
  const result = ctx.graphd.sessionGet(sessionKey) as { session?: SessionRow };
  return result.session ?? null;
}

async function handleGetCockpitSessionRollups(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  status: string | null,
  limit: number
): Promise<void> {
  const { sessions, error } = getAllSessions(ctx, Math.max(100, limit));
  if (error) {
    sendJson(res, { rollups: [], error });
    return;
  }

  const traces = await loadTraceRecords(ctx.workingDir, Math.max(200, limit * 3));
  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildTraceSummary(session.sessionKey, traces));

### function_call
@callId call_8e011bdf6c84411ba88b0612
@name Bash
@ts 1770352740908
@workItemId 68ac7230
{"command":"grep -n \"handleGetCockpitSessionEvents\" packages/harness-daemon/src/harness/control_plane_routes.ts | head -5"}

### function_call_output
@callId call_8e011bdf6c84411ba88b0612
@ts 1770352740919
@durationMs 8
@workItemId 68ac7230
2704:    handleGetCockpitSessionEvents(res, ctx, params.sessionKey, limit, cursor);
3903:function handleGetCockpitSessionEvents(


### function_call
@callId call_65c4816e19944f7383de5faa
@name Read
@ts 1770352743867
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":3900,"endLine":4050}

### function_call_output
@callId call_65c4816e19944f7383de5faa
@ts 1770352743880
@durationMs 9
@workItemId 68ac7230
// Lines 3900-3071 of 3071 total


### function_call
@callId call_b3af92ef1baf4dc3ba4f6b71
@name Bash
@ts 1770352755995
@workItemId 68ac7230
{"command":"awk '/function handleGetCockpitSessionEvents/,/^}/' packages/harness-daemon/src/harness/control_plane_routes.ts | head -100"}

### function_call_output
@callId call_b3af92ef1baf4dc3ba4f6b71
@ts 1770352756461
@durationMs 453
@workItemId 68ac7230
function handleGetCockpitSessionEvents(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  limit: number,
  cursorRaw: string | null
): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { events: [], nextCursor: null, error: 'GraphD not available' });
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { events: [], nextCursor: null, error: 'Session not found' }, 404);
    return;
  }
  const messagesResult = ctx.graphd.messagesGet(sessionKey, Math.max(limit * 2, 200), 0) as {
    messages?: MessageRow[];
  };
  const cursor = cursorRaw ? Number(cursorRaw) : undefined;
  const { events, nextCursor } = buildSessionEvents(
    session,
    messagesResult.messages ?? [],
    limit,
    Number.isFinite(cursor) ? cursor : undefined
  );
  sendJson(res, { events, nextCursor });
}


### function_call
@callId call_28269ef46b4748728cfac54f
@name Bash
@ts 1770352765570
@workItemId 68ac7230
{"command":"grep -n \"function buildSessionEvents\" packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_28269ef46b4748728cfac54f
@ts 1770352765589
@durationMs 9
@workItemId 68ac7230
2387:function buildSessionEvents(


### function_call
@callId call_750e4b7b18f042a3a341622d
@name Read
@ts 1770352776198
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":2380,"endLine":2650}

### function_call_output
@callId call_750e4b7b18f042a3a341622d
@ts 1770352776216
@durationMs 8
@workItemId 68ac7230
// Lines 2380-2650 of 3071 total
  if (type === 'git_commit') return 'trace';
  if (type.startsWith('browser_')) return 'tool';
  if (type.includes('test')) return 'test';
  if (type.includes('packet')) return 'packet';
  return 'workflow';
}

function buildSessionEvents(
  session: SessionRow,
  messages: MessageRow[],
  limit: number,
  cursor?: number
): { events: NormalizedSessionEvent[]; nextCursor: number | null } {
  const normalized: Array<{ ts: number; event: NormalizedSessionEvent }> = [];

  for (const message of messages) {
    const ts = message.createdAt * 1000;
    normalized.push({
      ts,
      event: {
        at: new Date(ts).toISOString(),
        type: 'message',
        payload: {
          id: message.id,
          role: message.role,
          content: message.content,
          requestId: message.requestId,
          metadata: message.metadata ?? {},
        },
      },
    });
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    normalized.push({
      ts,
      event: {
        at: new Date(ts).toISOString(),
        type: normalizeAgentEventType(type),
        payload: {
          eventType: type,
          requestId: asString(entry.request_id),
          workItemId: asString(entry.work_item_id),
          data: isRecord(entry.data) ? entry.data : {},
        },
      },
    });
  }

  normalized.sort((a, b) => a.ts - b.ts);
  const filtered = cursor
    ? normalized.filter((entry) => entry.ts > cursor)
    : normalized;
  const sliced = filtered.slice(-limit);
  const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].ts : null;

  return {
    events: sliced.map((entry) => entry.event),
    nextCursor,
  };
}

/**
 * Handle control-plane API requests
 * Returns true if the request was handled, false otherwise
 */
export function handleControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): boolean {
  const { pathname, query } = parseUrl(req);

  // Only handle /control-plane/* routes
  if (!pathname.startsWith('/control-plane/')) {
    return false;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Route handling
  let params: Record<string, string> | null;

  // GET /control-plane/projects
  if (pathname === '/control-plane/projects' && req.method === 'GET') {
    handleGetProjects(res, ctx);
    return true;
  }

  // GET /control-plane/projects/:id/features
  params = matchRoute('/control-plane/projects/:id/features', pathname);
  if (params && req.method === 'GET') {
    void handleGetFeatures(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/projects/:id/sessions
  params = matchRoute('/control-plane/projects/:id/sessions', pathname);
  if (params && req.method === 'GET') {
    handleGetProjectSessions(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/features/:id/prs
  params = matchRoute('/control-plane/features/:id/prs', pathname);
  if (params && req.method === 'GET') {
    const owner = query.get('owner');
    const repo = query.get('repo');
    void handleGetPRs(res, params.id, owner, repo);
    return true;
  }

  // GET /control-plane/sessions
  if (pathname === '/control-plane/sessions' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    handleGetSessions(res, ctx, limit);
    return true;
  }

  // GET /control-plane/sessions/:id
  params = matchRoute('/control-plane/sessions/:id', pathname);
  if (params && req.method === 'GET') {
    handleGetSession(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/sessions/:id/messages
  params = matchRoute('/control-plane/sessions/:id/messages', pathname);
  if (params && req.method === 'GET') {
    handleGetSessionMessages(res, ctx, params.id);
    return true;
  }

  // POST /control-plane/sessions/:id/message
  params = matchRoute('/control-plane/sessions/:id/message', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionMessage(req, res, ctx, params.id);
    return true;
  }

  // POST /control-plane/sessions/:id/stop
  params = matchRoute('/control-plane/sessions/:id/stop', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionControl(req, res, ctx, params.id, 'stop');
    return true;
  }

  // GET /control-plane/goals/hierarchy
  if (pathname === '/control-plane/goals/hierarchy' && req.method === 'GET') {
    handleGetGoalHierarchy(res);
    return true;
  }

  // GET /control-plane/token-usage
  if (pathname === '/control-plane/token-usage' && req.method === 'GET') {
    handleGetTokenUsage(res, ctx);
    return true;
  }

  // GET /control-plane/projects/:id/git
  params = matchRoute('/control-plane/projects/:id/git', pathname);
  if (params && req.method === 'GET') {
    void handleGetGitInfo(res, params.id);
    return true;
  }

  // GET /control-plane/traces
  if (pathname === '/control-plane/traces' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetTraces(res, ctx, limit);
    return true;
  }

  // GET /control-plane/traces/revision/:revision
  params = matchRoute('/control-plane/traces/revision/:revision', pathname);
  if (params && req.method === 'GET') {
    void handleGetTraceByRevision(res, ctx, params.revision);
    return true;
  }

  // GET /control-plane/live-sessions
  if (pathname === '/control-plane/live-sessions' && req.method === 'GET') {
    handleGetLiveSessions(res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/rollups/sessions?status=running|ready|done
  if (pathname === '/control-plane/cockpit/rollups/sessions' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    void handleGetCockpitSessionRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/escalations?status=open
  if (pathname === '/control-plane/cockpit/rollups/escalations' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    handleGetCockpitEscalationRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/commits?limit=50
  if (pathname === '/control-plane/cockpit/rollups/commits' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitCommitRollups(res, ctx, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/prs?status=open&limit=50
  if (pathname === '/control-plane/cockpit/rollups/prs' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitPRRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/metrics/daily?date=YYYY-MM-DD
  if (pathname === '/control-plane/cockpit/metrics/daily' && req.method === 'GET') {
    const date = query.get('date');
    void handleGetCockpitDailyMetrics(res, ctx, date);
    return true;
  }

  // GET /control-plane/cockpit/focus?type=session|escalation&id=...
  if (pathname === '/control-plane/cockpit/focus' && req.method === 'GET') {
    const type = query.get('type');
    const id = query.get('id');
    const packetId = query.get('packetId');
    void handleGetCockpitFocus(res, ctx, type, id, packetId);
    return true;
  }

  // GET /control-plane/cockpit/traces?sessionKey=...&workItemId=...&limit=...
  if (pathname === '/control-plane/cockpit/traces' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const workItemId = query.get('workItemId');
    const limit = parseInt(query.get('limit') ?? '200', 10);
    void handleGetCockpitTraces(res, ctx, sessionKey, workItemId, limit);
    return true;
  }

  // GET /control-plane/cockpit/diff?sessionKey=...&base=...&head=...&file=...
  if (pathname === '/control-plane/cockpit/diff' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const base = query.get('base');
    const head = query.get('head');
    const file = query.get('file');
    void handleGetCockpitDiff(res, ctx, sessionKey, base, head, file);
    return true;
  }

  // GET /control-plane/cockpit/tests?sessionKey=...&workItemId=...&limit=...
  if (pathname === '/control-plane/cockpit/tests' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const workItemId = query.get('workItemId');
    const limit = parseInt(query.get('limit') ?? '20', 10);

### function_call
@callId call_871994e442e24bc7b098983b
@name coding
@ts 1770352811056
@workItemId 68ac7230
{"objective":"Redesign the control dashboard to dramatically improve signal-to-noise ratio in the message stream and diff preview card.\n\nCurrent problems:\n1. Message stream shows ALL events (tool calls, memory injections, agent messages) making it impossible to follow actual agent reasoning\n2. Tool calls should be status indicators, not message stream items\n3. Memory injections should be in Audit, not main message stream\n4. Diff preview card shows only +N/-M, not specific line numbers\n\nChanges needed:\n\n**1. packages/dashboard-control/src/App.tsx - Message Stream Redesign:**\n- Introduce new filter type: 'signal' (high-value content only)\n- Signal events should include: message events with substantial content, packet events, decision events, meaningful errors\n- Move tool calls to a compact \"Active Tool\" status indicator (not in message stream)\n- Add \"Tools\" filter that shows a summary, not every tool call\n- Improve event rendering to highlight meaningful agent utterances vs noise\n\n**2. packages/harness-daemon/src/harness/control_plane_routes.ts - Event Categorization:**\n- Modify `buildSessionEvents()` to add a `signalPriority` field to events\n- High priority: messages with role='assistant' and >50 chars, packet events, decision events, test failures\n- Low priority: tool calls, memory injections, internal diagnostics\n- Add field `isStatusOnly` for events that shouldn't appear in message stream\n\n**3. packages/dashboard-control/src/App.tsx - Diff Preview Enhancement:**\n- In the hotspots list, show the specific line ranges changed (e.g., \"L42-L58 (+12/-3)\")\n- Parse diffData.patch to extract line numbers for each file\n- Display both the aggregate +N/-M and the specific line ranges\n\nImplementation details:\n\n**Signal Detection Logic:**\n```typescript\nfunction getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {\n  if (event.type === 'packet') return 'high';\n  if (event.type === 'test' && isFailureEvent(event)) return 'high';\n  if (event.type === 'message') {\n    const content = typeof event.payload.content === 'string' ? event.payload.content : '';\n    const role = event.payload.role;\n    if (role === 'assistant' && content.length > 50) return 'high';\n    if (role === 'user') return 'medium';\n  }\n  if (event.type === 'tool') return 'low';\n  return 'status';\n}\n```\n\n**Line Number Extraction from Diff:**\n```typescript\nfunction parseLineRanges(patch: string): Map<string, Array<{start: number; end: number; added: number; deleted: number}>> {\n  // Parse unified diff format to extract line ranges for each file\n}\n```\n\n**New Filter UX:**\n- Default to 'signal' (show only high-value content)\n- Filters: Signal, All, Failures, Tools (summary view), Audit (for tool calls/memory injections)\n\n**Active Tool Status Indicator:**\n- Show current tool being executed as a compact status bar\n- Update in real-time based on latest tool event\n- Don't show in main message stream unless it fails","goal":"Improve control dashboard signal-to-noise ratio by separating signal events from noise and adding diff line number details"}

### function_call_output
@callId call_871994e442e24bc7b098983b
@ts 1770353163404
@durationMs 352343
@workItemId 68ac7230
{"agent":"coding","workId":"e7c84b29","success":true,"response":"<tool_call>Bash<arg_key>command</arg_key><arg_value>wc -l packages/dashboard-control/src/App.tsx</arg_value></tool_call>","responseStreamedToUser":true,"filesRead":["packages/dashboard-control/src/App.tsx"],"artifacts":[],"postProcessingError":null,"metrics":{"llmCallsMade":50,"toolCallsMade":51,"toolCallsSucceeded":50,"toolCallsFailed":1,"durationMs":352334}}

### function_call
@callId call_0eedf1529e37459c8d30ce5a
@name Read
@ts 1770353172338
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":50,"endLine":60}

### function_call_output
@callId call_0eedf1529e37459c8d30ce5a
@ts 1770353172745
@durationMs 395
@workItemId 68ac7230
// Lines 50-60 of 2466 total
type EventFilter = 'signal' | 'all' | 'messages' | 'tools' | 'failures' | 'audit';

const LEFT_SECTIONS: LeftSection[] = ['running', 'ready', 'done', 'metrics'];
const RIGHT_SECTIONS: RightSection[] = ['queue', 'commits', 'prs'];
const CENTER_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'lens', 'browser'];
const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;
const DEFAULT_BROWSER_RUNBOOK = [
  '# One command per line',
  '# open https://example.com',
  '# snapshot -i -c',
  '# click @e1',

### function_call
@callId call_f150c1997ba142aab9497352
@name Bash
@ts 1770353174765
@workItemId 68ac7230
{"command":"grep -n \"EventFilter\\|getSignalPriority\\|activeToolStatus\" packages/dashboard-control/src/App.tsx | head -20"}

### function_call_output
@callId call_f150c1997ba142aab9497352
@ts 1770353174783
@durationMs 10
@workItemId 68ac7230
50:type EventFilter = 'signal' | 'all' | 'messages' | 'tools' | 'failures' | 'audit';
628:  const [eventFilter, setEventFilter] = useState<EventFilter>('signal');
2682:                  onClick={() => setEventFilter('signal')}
2693:                  onClick={() => setEventFilter('all')}
2704:                  onClick={() => setEventFilter('failures')}
2715:                  onClick={() => setEventFilter('audit')}


### function_call
@callId call_959c5c2b74d44946b8a2f79e
@name Bash
@ts 1770353177345
@workItemId 68ac7230
{"command":"grep -n \"getSignalPriority\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_959c5c2b74d44946b8a2f79e
@ts 1770353177369
@isError true
@durationMs 11
@workItemId 68ac7230
Command exited with code 1

### function_call
@callId call_c8dcae2a9a5a4a5eadc1a538
@name Read
@ts 1770353179453
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":620,"endLine":650}

### function_call_output
@callId call_c8dcae2a9a5a4a5eadc1a538
@ts 1770353179470
@durationMs 8
@workItemId 68ac7230
// Lines 620-650 of 2466 total
  const [patchApplyStatus, setPatchApplyStatus] = useState<string | null>(null);
  const [applyingPatch, setApplyingPatch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [resolvingEscalationId, setResolvingEscalationId] = useState<string | null>(null);
  const [reviewDecisionAction, setReviewDecisionAction] = useState<'accept' | 'request_changes' | null>(null);
  const [eventFilter, setEventFilter] = useState<EventFilter>('signal');
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [lensQuery, setLensQuery] = useState('');
  const [lensResults, setLensResults] = useState<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }>({
    defs: [],
    refs: [],
    text: [],
  });
  const [lensLoading, setLensLoading] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [browserState, setBrowserState] = useState<CockpitBrowserState | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserActionStatus, setBrowserActionStatus] = useState<string | null>(null);
  const [browserUrlDraft, setBrowserUrlDraft] = useState('');
  const [browserActionType, setBrowserActionType] = useState<'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll'>('click');
  const [browserTargetDraft, setBrowserTargetDraft] = useState('');
  const [browserValueDraft, setBrowserValueDraft] = useState('');
  const [browserDirectionDraft, setBrowserDirectionDraft] = useState<'up' | 'down' | 'left' | 'right'>('down');
  const [browserSnapshotInteractive, setBrowserSnapshotInteractive] = useState(true);
  const [browserSnapshotCompact, setBrowserSnapshotCompact] = useState(true);

### function_call
@callId call_5785fba9714d4911a09d031d
@name Bash
@ts 1770353182993
@workItemId 68ac7230
{"command":"grep -n \"filteredEvents\\s*=\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_5785fba9714d4911a09d031d
@ts 1770353183201
@durationMs 196
@workItemId 68ac7230
865:  const filteredEvents = useMemo(() => {


### function_call
@callId call_04a5fc31d6584a769a18ba80
@name Read
@ts 1770353185808
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":860,"endLine":890}

### function_call_output
@callId call_04a5fc31d6584a769a18ba80
@ts 1770353185834
@durationMs 13
@workItemId 68ac7230
// Lines 860-890 of 2466 total

  const focusStatus = typeof focus?.header?.status === 'string'
    ? focus.header.status
    : null;

  const filteredEvents = useMemo(() => {
    // Signal filter: show only high/medium priority events (substantial content, packets, failures)
    if (eventFilter === 'signal') {
      return events.filter((event) => {
        // Use server-provided priority if available
        const priority = event.signalPriority;
        if (priority) return priority === 'high' || priority === 'medium';
        // Fallback to client-side detection for events without priority
        if (event.type === 'packet') return true;
        if (event.type === 'message') {
          const role = String(event.payload.role ?? '');
          const content = typeof event.payload.content === 'string' ? event.payload.content : '';
          if (role === 'assistant' && content.length > 50) return true;
          if (role === 'user') return true;
        }
        return isFailureEvent(event);
      });
    }
    
    // Audit filter: show all tool calls, memory injections, and status-only events
    if (eventFilter === 'audit') {
      return events.filter((event) => {
        // Use server-provided isStatusOnly if available
        if (event.isStatusOnly) return true;
        // Fallback to client-side detection
        if (event.type === 'tool') {

### function_call
@callId call_8921aad776cc4c8490fff14c
@name Bash
@ts 1770353188407
@workItemId 68ac7230
{"command":"grep -n \"parseLineRanges\\|lineRange\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_8921aad776cc4c8490fff14c
@ts 1770353188431
@isError true
@durationMs 11
@workItemId 68ac7230
Command exited with code 1

### function_call
@callId call_b4783d55facc4a2d8af139a4
@name Bash
@ts 1770353191360
@workItemId 68ac7230
{"command":"grep -n \"hotspot.*line\\|added.*deleted.*line\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_b4783d55facc4a2d8af139a4
@ts 1770353192390
@isError true
@durationMs 1021
@workItemId 68ac7230
Command exited with code 1

### function_call
@callId call_080f49e71c7440f8b9638b06
@name Bash
@ts 1770353195210
@workItemId 68ac7230
{"command":"grep -n \"hotspot.added\\|hotspot.deleted\\|DiffHotspot\" packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_080f49e71c7440f8b9638b06
@ts 1770353195234
@durationMs 16
@workItemId 68ac7230
2183:                            +{hotspot.added} / -{hotspot.deleted}


### function_call
@callId call_367260dcc01f4f0290c59835
@name Read
@ts 1770353197390
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx","startLine":2160,"endLine":2210}

### function_call_output
@callId call_367260dcc01f4f0290c59835
@ts 1770353197815
@durationMs 417
@workItemId 68ac7230
// Lines 2160-2210 of 2466 total
                    {diffData.hotspots.length === 0 ? (
                      <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
                    ) : (
                      diffData.hotspots.slice(0, 20).map((hotspot) => (
                        <button
                          key={hotspot.path}
                          onClick={() => {
                            setSelectedDiffFile(hotspot.path);
                            if (focus?.sessionKey) {
                              void getCockpitDiff({
                                sessionKey: focus.sessionKey,
                                base: diffData.baseSha,
                                head: diffData.headSha,
                                file: hotspot.path,
                              }).then((response) => setDiffData(response)).catch(() => {});
                            }
                          }}
                          className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                            selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
                          }`}
                        >
                          <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
                          <div className="text-[10px] text-[var(--text-muted)]">
                            +{hotspot.added} / -{hotspot.deleted}
                            {typeof lastEditedLineByPath.get(hotspot.path) === 'number'
                              ? ` · last L${lastEditedLineByPath.get(hotspot.path)}`
                              : ''}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  {diffData.patch && (
                    <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] overflow-x-auto whitespace-pre-wrap">
                      {diffData.patch}
                    </pre>
                  )}
                  <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
                    <div className="text-[var(--text-muted)]">Patch Pad (max 3 files / 30 lines)</div>
                    <textarea
                      value={patchDraft}
                      onChange={(event) => setPatchDraft(event.target.value)}
                      placeholder="Paste unified diff here..."
                      className="w-full min-h-28 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleApplyPatch()}
                        disabled={applyingPatch || !patchDraft.trim()}
                        className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                      >

### function_call
@callId call_9d9046d1fd4c46609d499a69
@name Bash
@ts 1770353200714
@workItemId 68ac7230
{"command":"grep -n \"interface NormalizedSessionEvent\\|interface DiffHotspot\" packages/dashboard-control/src/lib/api.ts"}

### function_call_output
@callId call_9d9046d1fd4c46609d499a69
@ts 1770353200768
@durationMs 20
@workItemId 68ac7230
351:export interface NormalizedSessionEvent {
359:export interface DiffHotspot {


### function_call
@callId call_c8e8c996bd4441ed81dea9c7
@name Read
@ts 1770353203320
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts","startLine":351,"endLine":380}

### function_call_output
@callId call_c8e8c996bd4441ed81dea9c7
@ts 1770353203346
@durationMs 14
@workItemId 68ac7230
// Lines 351-380 of 740 total
export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
}

export interface CockpitDiff {
  baseSha: string;
  headSha: string;
  source: 'query' | 'session' | 'git-parent' | 'unknown';
  summary: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  hotspots: DiffHotspot[];
  patch: string | null;
}

export interface CockpitTestReport {
  id: string;
  sessionKey: string;

### function_call
@callId call_12d8c767031d49e183d769b8
@name Edit
@ts 1770353207363
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts","oldString":"export interface DiffHotspot {\n  path: string;\n  added: number;\n  deleted: number;\n}","newString":"export interface DiffHotspot {\n  path: string;\n  added: number;\n  deleted: number;\n  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;\n}"}

### function_call_output
@callId call_12d8c767031d49e183d769b8
@ts 1770353210325
@durationMs 209
@workItemId 68ac7230
Edited /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts
Replaced 1 occurrence(s)
Context after edit:
358: 
359: export interface DiffHotspot {
360:   path: string;
361:   added: number;
362:   deleted: number;
363:   lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
364: }
365: 
366: export interface CockpitDiff {

[entity-graph] 1 file(s) depend on "packages/dashboard-control/src/lib/api.ts": packages/dashboard-control/src/App.tsx

### function_call
@callId call_01f3341fe4754697a520c335
@name Bash
@ts 1770353235310
@workItemId 68ac7230
{"command":"grep -n \"parseNumstatOutput\\|buildCockpitDiff\\|handleGetCockpitDiff\" packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_01f3341fe4754697a520c335
@ts 1770353235712
@durationMs 394
@workItemId 68ac7230
708:function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
811:      const parsed = parseNumstatOutput(numstat).summary;
2717:    void handleGetCockpitDiff(res, ctx, sessionKey, base, head, file);
3324:async function handleGetCockpitDiff(
3355:    const { summary, hotspots } = parseNumstatOutput(numstat);


### function_call
@callId call_ecf08ea352fa4931a034c83d
@name Read
@ts 1770353268045
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":705,"endLine":760}

### function_call_output
@callId call_ecf08ea352fa4931a034c83d
@ts 1770353268091
@durationMs 37
@workItemId 68ac7230
// Lines 705-760 of 3057 total
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    if (Number.isFinite(added)) totalAdded += added;
    if (Number.isFinite(deleted)) totalDeleted += deleted;
    filesTouched += 1;
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  return {
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched,
    },
    hotspots,
  };
}

function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
  const commits: CommitRollup[] = [];
  const lines = stdout.split('\n');
  let current: CommitRollup | null = null;

  for (const raw of lines) {
    if (raw.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const payload = raw.slice('__COMMIT__'.length);
      const [shaRaw, authorRaw, timeRaw, messageRaw] = payload.split('\u001f');
      const sha = (shaRaw ?? '').trim();
      const author = (authorRaw ?? '').trim();
      const time = (timeRaw ?? '').trim();
      const message = (messageRaw ?? '').trim();
      if (!sha || !time) {
        current = null;
        continue;
      }

### function_call
@callId call_3655e1ea4ecf44ff98ace90b
@name Edit
@ts 1770353284267
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","oldString":"function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {\n  const hotspots: DiffHotspot[] = [];\n  let totalAdded = 0;\n  let totalDeleted = 0;\n  let filesTouched = 0;\n  const lines = stdout.split('\\n');\n  for (const raw of lines) {\n    const line = raw.trim();\n    if (!line) continue;\n    const parts = line.split('\\t');\n    if (parts.length < 3) continue;\n    const added = parts[0] === '-' ? 0 : Number(parts[0]);\n    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);\n    const path = parts.slice(2).join('\\t');\n    if (!path) continue;\n    if (Number.isFinite(added)) totalAdded += added;\n    if (Number.isFinite(deleted)) totalDeleted += deleted;\n    filesTouched += 1;\n    hotspots.push({\n      path,\n      added: Number.isFinite(added) ? added : 0,\n      deleted: Number.isFinite(deleted) ? deleted : 0,\n    });\n  }\n  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));\n  return {\n    summary: {\n      added: totalAdded,\n      deleted: totalDeleted,\n      filesTouched,\n    },\n    hotspots,\n  };\n}","newString":"function parseLineRangesFromPatch(patch: string): Map<string, Array<{ start: number; end: number; added: number; deleted: number }>> {\n  const ranges = new Map<string, Array<{ start: number; end: number; added: number; deleted: number }>>();\n  const lines = patch.split('\\n');\n  let currentFile: string | null = null;\n  let currentStart: number | null = null;\n  let rangeAdded = 0;\n  let rangeDeleted = 0;\n  let lineNum = 0;\n\n  for (const line of lines) {\n    // Match file header: +++ b/path/to/file\n    const fileMatch = line.match(/^\\+\\+\\+\\s+b\\/(.+)/);\n    if (fileMatch) {\n      // Save previous range if exists\n      if (currentFile && currentStart !== null) {\n        const fileRanges = ranges.get(currentFile) || [];\n        fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });\n        ranges.set(currentFile, fileRanges);\n      }\n      currentFile = fileMatch[1].trim();\n      currentStart = null;\n      rangeAdded = 0;\n      rangeDeleted = 0;\n      continue;\n    }\n\n    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@\n    const hunkMatch = line.match(/^@@\\s+-\\d+(?:,\\d+)?\\s+\\+(\\d+)(?:,\\d+)?\\s+@@/);\n    if (hunkMatch && currentFile) {\n      // Save previous range if exists\n      if (currentStart !== null) {\n        const fileRanges = ranges.get(currentFile) || [];\n        fileRanges.push({ start: currentStart, end: lineNum - 1, added: rangeAdded, deleted: rangeDeleted });\n        ranges.set(currentFile, fileRanges);\n      }\n      currentStart = parseInt(hunkMatch[1], 10);\n      lineNum = currentStart;\n      rangeAdded = 0;\n      rangeDeleted = 0;\n      continue;\n    }\n\n    // Count additions and deletions\n    if (currentStart !== null) {\n      if (line.startsWith('+') && !line.startsWith('++')) {\n        rangeAdded++;\n        lineNum++;\n      } else if (line.startsWith('-') && !line.startsWith('--')) {\n        rangeDeleted++;\n        // Don't increment lineNum for deletions\n      } else if (line.startsWith(' ')) {\n        lineNum++;\n      }\n    }\n  }\n\n  // Save final range\n  if (currentFile && currentStart !== null) {\n    const fileRanges = ranges.get(currentFile) || [];\n    fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });\n    ranges.set(currentFile, fileRanges);\n  }\n\n  return ranges;\n}\n\nfunction parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {\n  const hotspots: DiffHotspot[] = [];\n  let totalAdded = 0;\n  let totalDeleted = 0;\n  let filesTouched = 0;\n  const lines = stdout.split('\\n');\n\n  // Parse line ranges from patch if provided\n  const lineRanges = patch ? parseLineRangesFromPatch(patch) : new Map();\n\n  for (const raw of lines) {\n    const line = raw.trim();\n    if (!line) continue;\n    const parts = line.split('\\t');\n    if (parts.length < 3) continue;\n    const added = parts[0] === '-' ? 0 : Number(parts[0]);\n    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);\n    const path = parts.slice(2).join('\\t');\n    if (!path) continue;\n    if (Number.isFinite(added)) totalAdded += added;\n    if (Number.isFinite(deleted)) totalDeleted += deleted;\n    filesTouched += 1;\n\n    const hotspot: DiffHotspot = {\n      path,\n      added: Number.isFinite(added) ? added : 0,\n      deleted: Number.isFinite(deleted) ? deleted : 0,\n    };\n\n    // Add line ranges if available\n    const fileRanges = lineRanges.get(path);\n    if (fileRanges && fileRanges.length > 0) {\n      // Add up to 3 most significant line ranges (most changes)\n      const topRanges = fileRanges\n        .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))\n        .slice(0, 3);\n      if (topRanges.length > 0) {\n        hotspot.lineRanges = topRanges;\n      }\n    }\n\n    hotspots.push(hotspot);\n  }\n  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));\n  return {\n    summary: {\n      added: totalAdded,\n      deleted: totalDeleted,\n      filesTouched,\n    },\n    hotspots,\n  };\n}"}

### function_call_output
@callId call_3655e1ea4ecf44ff98ace90b
@ts 1770353286763
@durationMs 20
@workItemId 68ac7230
Edited /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts
Replaced 1 occurrence(s)
Context after edit:
707: 
708: function parseLineRangesFromPatch(patch: string): Map<string, Array<{ start: number; end: number; added: number; deleted: number }>> {
709:   const ranges = new Map<string, Array<{ start: number; end: number; added: number; deleted: number }>>();
710:   const lines = patch.split('\n');
711:   let currentFile: string | null = null;
712:   let currentStart: number | null = null;
713:   let rangeAdded = 0;
714:   let rangeDeleted = 0;
715:   let lineNum = 0;
716: 
717:   for (const line of lines) {
718:     // Match file header: +++ b/path/to/file
719:     const fileMatch = line.match(/^\+\+\+\s+b\/(.+)/);
720:     if (fileMatch) {
721:       // Save previous range if exists
722:       if (currentFile && currentStart !== null) {
723:         const fileRanges = ranges.get(currentFile) || [];
724:         fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
725:         ranges.set(currentFile, fileRanges);
726:       }
727:       currentFile = fileMatch[1].trim();
728:       currentStart = null;
729:       rangeAdded = 0;
730:       rangeDeleted = 0;
731:       continue;
732:     }
733: 
734:     // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
735:     const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
736:     if (hunkMatch && currentFile) {
737:       // Save previous range if exists
738:       if (currentStart !== null) {
739:         const fileRanges = ranges.get(currentFile) || [];
740:         fileRanges.push({ start: currentStart, end: lineNum - 1, added: rangeAdded, deleted: rangeDeleted });
741:         ranges.set(currentFile, fileRanges);
742:       }
743:       currentStart = parseInt(hunkMatch[1], 10);
744:       lineNum = currentStart;
745:       rangeAdded = 0;
746:       rangeDeleted = 0;
747:       continue;
748:     }
749: 
750:     // Count additions and deletions
751:     if (currentStart !== null) {
752:       if (line.startsWith('+') && !line.startsWith('++')) {
753:         rangeAdded++;
754:         lineNum++;
755:       } else if (line.startsWith('-') && !line.startsWith('--')) {
756:         rangeDeleted++;
757:         // Don't increment lineNum for deletions
758:       } else if (line.startsWith(' ')) {
759:         lineNum++;
760:       }
761:     }
762:   }
763: 
764:   // Save final range
765:   if (currentFile && currentStart !== null) {
766:     const fileRanges = ranges.get(currentFile) || [];
767:     fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
768:     ranges.set(currentFile, fileRanges);
769:   }
770: 
771:   return ranges;
772: }
773: 
774: function parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
775:   const hotspots: DiffHotspot[] = [];
776:   let totalAdded = 0;
777:   let totalDeleted = 0;
778:   let filesTouched = 0;
779:   const lines = stdout.split('\n');
780: 
781:   // Parse line ranges from patch if provided
782:   const lineRanges = patch ? parseLineRangesFromPatch(patch) : new Map();
783: 
784:   for (const raw of lines) {
785:     const line = raw.trim();
786:     if (!line) continue;
787:     const parts = line.split('\t');
788:     if (parts.length < 3) continue;
789:     const added = parts[0] === '-' ? 0 : Number(parts[0]);
790:     const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
791:     const path = parts.slice(2).join('\t');
792:     if (!path) continue;
793:     if (Number.isFinite(added)) totalAdded += added;
794:     if (Number.isFinite(deleted)) totalDeleted += deleted;
795:     filesTouched += 1;
796: 
797:     const hotspot: DiffHotspot = {
798:       path,
799:       added: Number.isFinite(added) ? added : 0,
800:       deleted: Number.isFinite(deleted) ? deleted : 0,
801:     };
802: 
803:     // Add line ranges if available
804:     const fileRanges = lineRanges.get(path);
805:     if (fileRanges && fileRanges.length > 0) {
806:       // Add up to 3 most significant line ranges (most changes)
807:       const topRanges = fileRanges
808:         .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
809:         .slice(0, 3);
810:       if (topRanges.length > 0) {
811:         hotspot.lineRanges = topRanges;
812:       }
813:     }
814: 
815:     hotspots.push(hotspot);
816:   }
817:   hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
818:   return {
819:     summary: {
820:       added: totalAdded,
821:       deleted: totalDeleted,
822:       filesTouched,
823:     },
824:     hotspots,
825:   };
826: }
827: 
828: function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {

### function_call
@callId call_c2ae1a57e9f843c9b7a3d725
@name Read
@ts 1770353293967
@workItemId 68ac7230
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":3320,"endLine":3400}

### function_call_output
@callId call_c2ae1a57e9f843c9b7a3d725
@ts 1770353294915
@durationMs 935
@workItemId 68ac7230
// Lines 3320-3053 of 3053 total


### message:assistant
@ts 1770353302496
<tool_call>Bash<arg_key>command</arg_key><arg_value>grep -n "async function handleGetCockpitDiff" packages/harness-daemon/src/harness/control_plane_routes.ts</arg_value></tool_call>
