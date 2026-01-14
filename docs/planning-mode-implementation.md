# Planning Mode Implementation

## Summary
Add `/plan` command to TUI that switches to plan mode where write tools are disabled. Agent uses a planning-specific prompt and can request to exit plan mode via a standardized event.

---

## 1. `packages/tui/types.ts`

Add `plan_mode_exit` to QuestionType:

```typescript
// Line 168-173: Replace QuestionType
export type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "fill_in_blank"
  | "yes_no"
  | "free_text"
  | "plan_mode_exit";  // NEW
```

---

## 2. `packages/tui/commands.ts`

Add `/plan` command:

```typescript
// Line 6-20: Add to SLASH_COMMANDS array
export const SLASH_COMMANDS = [
  "/help",
  "/config",
  "/models",
  "/providers",
  "/skills",
  "/hooks",
  "/theme",
  "/fork",
  "/delete",
  "/compact",
  "/voice",
  "/clear",
  "/plan",  // NEW
  "/exit",
];

// Line 53: Add to HELP_LINES (after /compact line)
"  /plan           Toggle plan mode (read-only)",
```

---

## 3. `packages/tui/store.ts`

Add planMode state:

```typescript
// Add to StoreSnapshot interface (around line 64, after themeCursor):
planMode: boolean;

// Add to private state (around line 118, after themeCursor):
private planMode = false;

// Add to getSnapshot() return (around line 179, after themeCursor):
planMode: this.planMode,

// Add new method (after exitThemeMode method, around line 240):
setPlanMode(enabled: boolean): void {
  this.planMode = enabled;
  this.emit();
}
```

---

## 4. `packages/agent/src/prompts.ts`

Add planning prompt addendum (at end of file):

```typescript
/**
 * Planning mode prompt addendum.
 * Appended to system prompts when in plan mode.
 */
export const PLANNING_PROMPT_ADDENDUM = `

## PLAN MODE ACTIVE

You are in **plan mode** - a read-only exploration and planning phase.

**Constraints:**
- Read, Glob, Grep tools available
- Write, Edit tools disabled
- Bash available for read-only commands

**Your job:**
1. Explore the codebase to understand the task
2. Create a concrete implementation plan
3. When ready, use action "need_user_input" with:
   - userPrompt.questionType: "plan_mode_exit"
   - userPrompt.question: "Ready to exit plan mode and implement?"
   - userPrompt.options: [
       { label: "Yes, exit plan mode", description: "Exit plan mode and begin implementation" },
       { label: "No, continue planning", description: "Stay in plan mode for more exploration" }
     ]

Only request exit when you have a complete plan.
`;

/**
 * Get the planning mode prompt addendum.
 */
export function getPlanningPromptAddendum(): string {
  return PLANNING_PROMPT_ADDENDUM;
}
```

---

## 5. `packages/harness-daemon/src/harness/types.ts`

Add planMode to AgentRunParams (find the interface, around line 13-20):

```typescript
export interface AgentRunParams {
  requestId: string;
  inputText: string;
  tier?: 'simple' | 'standard' | 'complex';
  sessionKey: string;
  workingDir: string;
  context?: string;
  planMode?: boolean;  // NEW
}
```

---

## 6. `packages/harness-daemon/src/harness/bridge_gateway.ts`

### 6a. Add planMode to ConnectionState (line 54-58):

```typescript
interface ConnectionState {
  sessionKey: string | null;
  workingDir: string | null;
  activeRequestId: string | null;
  planMode: boolean;  // NEW
}
```

### 6b. Initialize planMode in getOrCreateConnectionState:

Find where ConnectionState is created and ensure `planMode: false` is set.

### 6c. Update handleSendText (around line 252-290):

```typescript
private handleSendText(
  connectionId: string,
  data: Record<string, unknown> | undefined,
  state: ConnectionState
): void {
  const sessionKey = state.sessionKey;
  if (!sessionKey) {
    this.sendError(connectionId, 'Session not initialized. Call init first.');
    return;
  }

  const workingDir = state.workingDir ?? this.workingDir;

  const text = String(data?.text ?? '');
  if (!text.trim()) {
    this.sendError(connectionId, 'Empty message');
    return;
  }

  const candidateRequestId =
    typeof data?.client_request_id === 'string' ? data.client_request_id : '';
  const clientRequestId = candidateRequestId.length > 0
    ? candidateRequestId
    : generateRequestId();
  const rawTier = typeof data?.tier === 'string' ? data.tier.trim() : '';
  const tier = rawTier && rawTier !== 'auto' ? rawTier : undefined;

  // NEW: Extract planMode from command data
  const planMode = typeof data?.plan_mode === 'boolean' ? data.plan_mode : state.planMode;
  state.planMode = planMode;

  state.activeRequestId = clientRequestId;

  const handle = this.harness.run({
    requestId: clientRequestId,
    inputText: text,
    ...(tier ? { tier: tier as 'simple' | 'standard' | 'complex' } : {}),
    sessionKey,
    workingDir,
    planMode,  // NEW
  });

  this.streamRunEvents(clientRequestId, handle);
}
```

---

## 7. `packages/harness-daemon/src/harness/harness.ts`

### 7a. Add import for planning prompt (top of file):

```typescript
import {
  Agent,
  AgentRegistry,
  type AgentConfig,
  type AgentHooks,
  type ToolHookResult,
  getAgentPrompt,
  buildAgentConfig,
  getPlanningPromptAddendum,  // NEW
} from 'agent';
```

### 7b. Add tool filtering helper (add as private method in AgentHarness class):

```typescript
/**
 * Filter tools for plan mode - removes write/edit capabilities.
 */
private filterPlanModeTools(tools: string[]): string[] {
  const writeTools = new Set(['Write', 'Edit', 'BatchEdit']);
  return tools.filter(tool => !writeTools.has(tool));
}
```

### 7c. Update run() method to accept planMode (around line 441):

```typescript
run(params: AgentRunParams): AgentRunHandle {
  const { requestId, inputText, tier: requestedTier, sessionKey, workingDir, planMode } = params;  // Add planMode
  // ... rest of method
```

### 7d. Update runOrchestrator to handle plan mode (around line 837):

Modify the method signature to accept planMode:

```typescript
private async runOrchestrator(
  context: ContextWindow,
  goal: string,
  requestId: string,
  emit: ReturnType<typeof createEventEmitCallback>,
  llm: ReturnType<typeof createAdapter>,
  agentType: AgentType = 'standard',
  workingDir?: string,
  planMode?: boolean  // NEW
): Promise<AgentRunResult> {
```

Inside the method, modify how tools and prompts are handled:

```typescript
// Get agent config
const agentConfig = getAgentConfig(this.config, agentType);

// Filter tools if in plan mode
const effectiveTools = planMode
  ? this.filterPlanModeTools(agentConfig.tools)
  : agentConfig.tools;

// Build system prompt with plan mode addendum if needed
const basePrompt = getAgentPrompt(agentType);
const skipBehavioralRules = agentType === 'simple' || agentType === 'routing';
let systemPrompt = (this.config.behavioralRules && !skipBehavioralRules)
  ? `${basePrompt}\n\n${this.config.behavioralRules}`
  : basePrompt;

// Append planning prompt if in plan mode
if (planMode) {
  systemPrompt += getPlanningPromptAddendum();
}
```

### 7e. Pass planMode when calling runOrchestrator (around line 541):

```typescript
const result = await this.runOrchestrator(
  contextWindow,
  inputText,
  requestId,
  emit,
  llmAdapter,
  tier,
  workingDir,
  planMode  // NEW
);
```

---

## 8. `packages/harness-daemon/src/harness/event_translator.ts`

Update createUserPromptEvent to include questionType:

```typescript
export function createUserPromptEvent(
  requestId: string,
  question: string,
  options?: Array<string | { label: string; description?: string }>,
  context?: string,
  multiSelect?: boolean,
  questionType?: string  // NEW
): BridgeEvent {
  return {
    type: 'user_prompt',
    data: {
      request_id: requestId,
      question,
      options,
      context,
      multi_select: multiSelect,
      question_type: questionType,  // NEW
    },
  };
}
```

Also update any callers of this function to pass questionType when available.

---

## 9. `packages/tui/index.tsx`

### 9a. Handle /plan command in handleSlashCommand (around line 1208-1269):

```typescript
case "/plan": {
  const newPlanMode = !snapshot.planMode;
  store.setPlanMode(newPlanMode);
  store.addMessage("system", newPlanMode
    ? "Plan mode enabled. Write tools disabled."
    : "Plan mode disabled. Full tool access restored.");
  return;
}
```

### 9b. Pass planMode when sending text (find sendCommand("send_text", ...) calls):

```typescript
sendCommand("send_text", {
  text,
  client_request_id: requestId,
  tier: selectedTier,
  plan_mode: snapshot.planMode,  // NEW
});
```

### 9c. Add plan mode indicator to header (around line 1380 in renderHeader or equivalent):

```typescript
const planModeIndicator = snapshot.planMode ? " [PLAN]" : "";
// Use in header text like:
// `Voice Agent - Ink TUI${snapshot.compact ? " [compact]" : ""}${planModeIndicator}`
```

### 9d. Handle plan_mode_exit question type in handleUserPrompt:

When parsing the user_prompt event data, check for question_type:

```typescript
const handleUserPrompt = (data?: UserPromptData) => {
  if (!data?.question) return;

  const questionType = (data as any).question_type as QuestionType | undefined;

  // ... existing question parsing logic ...

  const question: AgentQuestion = {
    requestId: data.request_id,
    type: questionType || inferredType,  // Use explicit type if provided
    question: data.question,
    context: data.context,
    options: normalizedOptions,
  };

  store.setActiveQuestion(question);
};
```

### 9e. Handle plan mode exit on question answer:

When the user answers a plan_mode_exit question with "Yes", toggle plan mode off:

```typescript
// In the question answer handler (Enter key in question mode):
const submitQuestionAnswer = () => {
  const question = snapshot.activeQuestion;
  if (!question) return;

  const answer = store.getQuestionAnswer();

  // If this was a plan_mode_exit question and user selected first option (Yes)
  if (question.type === "plan_mode_exit" && snapshot.questionCursor === 0) {
    store.setPlanMode(false);
  }

  sendCommand("user_prompt_response", {
    request_id: question.requestId,
    answer,
  });

  store.clearQuestion();
};
```

---

## Event Flow

### Enter Plan Mode
```
User: /plan
  → TUI: store.setPlanMode(true)
  → TUI: display "[PLAN]" indicator
  → TUI: system message "Plan mode enabled"
```

### Agent Execution in Plan Mode
```
User: sends message
  → TUI: sendCommand("send_text", {..., plan_mode: true})
  → BridgeGateway: harness.run({planMode: true})
  → Harness: filterPlanModeTools(), append PLANNING_PROMPT_ADDENDUM
  → Agent: executes with Read/Glob/Grep/Bash (no Write/Edit)
```

### Agent Requests Exit
```
Agent: returns action="need_user_input", userPrompt.questionType="plan_mode_exit"
  → Harness: emits user_prompt event with question_type
  → TUI: shows QuestionPrompt with options
```

### User Confirms Exit
```
User: selects "Yes, exit plan mode"
  → TUI: store.setPlanMode(false)
  → TUI: sendCommand("user_prompt_response", {answer: 0})
  → Harness: resume() with full tool access
```

---

## Testing

1. Start TUI, type `/plan` - should show "[PLAN]" indicator and system message
2. Send a message - agent should not have Write/Edit tools
3. Agent response should reflect planning prompt guidance
4. When agent emits plan_mode_exit user_prompt, TUI should show question
5. Selecting "Yes" should disable plan mode and continue execution with write tools
