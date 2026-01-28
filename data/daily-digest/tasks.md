# Task List
> Last updated: 2026-01-26

## Active
- [ ] Fix @multi-site-auth-stealth.sh - User reports error, wants script tested before delivery (from session tui_1769, 2026-01-27T01:27:47Z)
- [ ] Fix UNDEFINED_VALUE error in sync-job.ts updateCursor - Undefined cursor being passed to postgres (from session tui_1769, 2026-01-26T16:12:59Z - line 212: JSON.stringify(cursor) where cursor can be undefined, causes all incremental sync jobs without existing cursor state to fail)
- [ ] Fix double-encoding bug in raw-envelope.ts - Line 217 uses JSON.stringify() which causes postgres to double-encode JSON as escaped string (from session tui_1769, 2026-01-26T16:51:15Z - change `raw_data: rawJson` to `raw_data: input.raw_data`)

## Waiting / Blocked
*No blocked tasks yet*

## Completed Recently
- [x] Browser-use needlepoint drawing failure analysis - Agent claimed success but canvas remained empty (session tui_1769, 2026-01-26T18:19:40Z - user frustrated: "i don't understand how if we are sending images then the issue was not caught and reported? instead it just claimed success despite the image being visible?" - root cause: synthetic MouseEvent vs expected PointerEvent, lack of visual validation despite screenshots being taken)
- [x] Direnv configured for per-project environment variables (session tui_1769, 2026-01-26T18:05:10Z - installed direnv, added .envrc with BROWSER_USE_API_KEY, .gitignore updated)
- [x] Needlepoint chart dog drawing with screenshot - Used agent-browser to draw dog face, ears, muzzle, eyes, nose on needlepoint chart website (session tui_1769, 2026-01-26T20:28:57Z - 40x80 stitch rectangle, Cocoa color for face, Black for eyes/nose, user requested screenshot which was taken)
- [x] Agent-browser skill configuration issues identified - Binary not in PATH, screenshots saved to /tmp directory user can't access (session tui_1769, 2026-01-26T20:38:37Z - assistant should have flagged failure upfront instead of claiming success, user frustration with lack of transparency)
- [x] Needlepoint chart interaction via agent-browser - Used agent-browser skill to draw picture of dog on needlepoint website (session tui_1769, 2026-01-26T21:02:37Z - determined dog's nose is Black/dark charcoal/onyx shades, after initial misunderstanding where assistant discussed unrelated census.gov site)
- [x] TUI paste handling fixed - Character input filter was removing newlines, tabs, carriage returns (session tui_1769, 2026-01-26T21:14:59Z - modified regex in packages/tui/index.tsx and ProvidersView.tsx to preserve Tab (0x09), Newline (0x0a), Carriage return (0x0d))
- [x] TUI FPS increased from 60 to 90 (session tui_1769, 2026-01-26T21:47:41Z - changed streamingThrottleMs from 16ms to 11ms in packages/tui/store.ts)
- [x] Context engineering research via agent-browser (session tui_1769, 2026-01-26T22:19:39Z - user requested "latest and greatest feats of context engineering in 2026", assistant provided agent-browser skill overview with refs-based navigation, BrowserManager architecture, cloud provider integrations, media capabilities)
- [x] AST-Node Merkle Tree + DAG architecture documentation created (session tui_1769, 2026-01-26T22:55:27Z - "double dipping" architecture for filesystem context management, using single parse to build both change detection and dependency tracking, docs/ast-merkle-dag-architecture.md)
- [x] Semiconductor supply chain news research via agent-browser (session tui_1769, 2026-01-26T23:32:41Z - from SemiEngineering.com: Taiwan-US trade agreement, TSMC strategic shifts, memory market developments, global fab investments)
- [x] Derived tasks refactored from separate DerivedEngine to single shared queue with SyncEngine (session tui_1769, 2026-01-27T00:06:38Z - user called it "unnecessary and wasteful")
- [x] Async mode with prompt user hook implementation (initial concept from session tui_1769, 2026-01-27T00:32:16Z - decision watcher intercepts PromptUser events to auto-answer using preference database)
- [x] Async mode with prompt user hook review completed (session tui_1769, 2026-01-27T00:56:16Z)
- [x] Preference extraction work requested but explicitly undone by user (migration and script created, then deleted per user request)
- [x] Stealth browser scripts created and tested (10/10 tests passed), but user reports error with multi-site-auth-stealth.sh (session tui_1769)

## Waiting / Blocked
*No blocked tasks yet*

## Completed Recently
*No completed tasks yet*
