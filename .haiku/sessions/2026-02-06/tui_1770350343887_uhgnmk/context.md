---
session: tui_1770350343887_uhgnmk
created: 2026-02-06T03:59:03.888Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770351281711
currently we are not setting workflow types anywhere (feature,issues) etc. this seems like a gap

### message:user
@ts 1770351859671
A lot of them are basically just chats requests. Impossible to know what they were intended to be. I am not sure how we'd actually mark these going forward. I'd also want a prototype as part  of that enum. 

### message:user
@ts 1770352201801
Yeah I think that is good. Eventually I am going to compose entire workflows from the control dashboard and I will specify exactly which workflow type it is. Let's use that interface for now, then check with our @packages/harness-daemon/src/harness/control_plane_routes.ts . What POST routes do we have?

### message:user
@ts 1770352518682
What do you mean you can't list the routes? You have tools wtf are you talking about

### message:user
@ts 1770352800565
WHY WOULDN'T YOU JUST RE-READ IT? 

### message:user
@ts 1770352922447
**User Interruption**: "DO YOU NOT HAVE A READ TOOL OR ANY TOOLS"

Consider if the user is:
- Asking you to stop current work
- Requesting a pivot to a different task
- Providing information that invalidates your current action
- Adding context as an addendum

Acknowledge the interruption and adjust your approach accordingly.

### message:user
@ts 1770353116369
**User Interruption**: "is there something in your prompt that is making you not use tools. Wtf are you even saying"

Consider if the user is:
- Asking you to stop current work
- Requesting a pivot to a different task
- Providing information that invalidates your current action
- Adding context as an addendum

Acknowledge the interruption and adjust your approach accordingly.
