# Prompt-User Pattern Analysis & Improvements

**Date**: 2026-01-29
**Issue**: 37% of watcher_prompt_user actions have negative outcomes (6 out of 16)
**Goal**: Identify root causes and propose concrete improvements

---

## Executive Summary

Analysis of 16 prompt_user actions reveals a clear pattern: negative outcomes occur when the watcher fails to provide a proper `answer` action, instead returning `escalate` or other invalid actions. The root cause is **ambiguous agent questions** combined with **watcher misalignment on how to respond**.

**Key Finding**: All 6 negative outcomes had `parameters.answer: null` and `context.watcher_action: "escalate"` instead of the required `"answer"`.

---

## Data Analysis

### Negative Outcomes (6/16 = 37%)

**Pattern across all negatives:**

| Attribute | Value |
|-----------|-------|
| `parameters.answer` | `null` (no answer provided) |
| `context.watcher_action` | `"escalate"` (invalid for prompt_user) |
| Agent Tool Calls | 9-18 (low exploration) |
| Context Used | 7-14% (shallow) |
| Duration | 23-35 seconds |

**Example Negative Question:**
```
"The goal 'use the personal-agent skill. provide value to me' is intentionally broad.
To focus my efforts effectively, I need to understand what type of value you're looking for.
Which of these best describes what you need right now?"
```

**What happened:**
- Watcher returned `action: "escalate"` instead of `action: "answer"`
- No answer text was provided
- System fell back to default: "Continue with your best judgment"
- Outcome recorded as "negative"

### Positive Outcomes (10/16 = 63%)

**Pattern across positives:**

| Attribute | Value |
|-----------|-------|
| `parameters.answer` | Full text with rationale |
| `context.watcher_action` | `"answer"` (correct) |
| Agent Tool Calls | 21-23 (deeper exploration) |
| Context Used | 23-26% (deeper) |
| Duration | 58-111 seconds |

**Example Positive Question:**
```
"What would provide the most value right now? (select one or specify other)

Option A: Fix the TypeScript compilation errors in agent_goals and agent_actions repositories
Option B: Analyze the existing data (48K+ messages, coding preferences) and generate insights
Option C: Continue with next steps in PLAN.md
Option D: Set up a specific autonomous task
Option E: Other (please describe)"
```

**What happened:**
- Watcher returned `action: "answer"` with full text
- Answer included rationale with numbered points and principle references
- System used the watcher's answer directly
- Outcome recorded as "positive"

---

## Root Causes

### 1. Ambiguous Agent Questions

Agents are asking open-ended questions like:
- "What does 'provide value' mean in this context?"
- "What type of value are you looking for?"
- "What kind of value should I prioritize?"

These questions **lack specificity** and **don't provide options**. The watcher cannot answer definitively because:
- The question is about the **session goal itself**
- No decision exists in the database about "what constitutes value"
- The watcher is being asked to **make up a goal** rather than answer a technical question

### 2. Watcher Misalignment

The watcher's objective for `prompt_user` says:
```
**You MUST answer.** There is no user available in async mode.
...
Return `watcherAction: "answer"` with your answer text.
```

But when faced with an unanswerable question (e.g., "what does value mean?"), the watcher:
- Returns `watcherAction: "escalate"` (which is invalid for `prompt_user`)
- Fails to provide any answer text
- Triggers fallback behavior

The watcher should either:
- Ask the agent to **clarify the question**
- Pick a **sensible default** based on session goal
- Provide **structured options** for the agent to choose from

### 3. Missing Options in Prompts

Positive outcomes consistently included **specific options** (A, B, C, D, E). Negative outcomes often had **no options** or **vague options**.

The fallback mechanism tries to use the first option:
```typescript
const defaultAnswer = prompt?.options?.[0]
  ? (typeof prompt.options[0] === 'string' ? prompt.options[0] : ...)
  : 'Continue with your best judgment.';
```

When options are missing or undefined, the fallback is generic ("Continue with your best judgment"), which is not useful guidance.

### 4. Question-Goal Mismatch

Negative questions often ask about **what the goal should be**, not **how to achieve it**. Examples:
- "What type of value would be most valuable to you right now?"
- "Which direction should I prioritize?"

This is a **planning question**, not a **technical question**. The watcher (which consults coding decisions/preferences) cannot answer "what is valuable" - that's a **business/product question**, not a **engineering decision**.

---

## Proposed Improvements

### 1. Improve Agent Prompt-User Patterns

**Current Problematic Pattern:**
```typescript
await PromptUser({
  question: "What type of value should I prioritize?",
  context: "I can do A, B, or C..."
});
```

**Improved Pattern - Always Provide Options:**
```typescript
await PromptUser({
  question: "Which option best aligns with the session goal?",
  options: [
    { label: "Option A: Fix TypeScript errors", description: "Clears blocker for Phase 1" },
    { label: "Option B: Generate insights report", description: "Immediate value from existing data" },
    { label: "Option C: Continue PLAN.md", description: "Execute roadmap in order" },
  ],
  context: "Current state: ..."
});
```

**Best Practice Rules:**
1. **Always provide options** - never ask open-ended questions
2. **Include descriptions** - explain why each option matters
3. **Reference session goal** - frame questions in terms of the goal, not "what do you want"
4. **Avoid meta-questions** - don't ask "what should I do" unless you provide specific alternatives

### 2. Enhance Watcher Objective for Prompt-User

**Current Objective (partial):**
```
**You MUST answer.** There is no user available in async mode.
...
Return `watcherAction: "answer"` with your answer text.
```

**Enhanced Objective:**
```
**You MUST answer with `watcherAction: "answer"`.** There is no user available in async mode.

## Answering Guidelines

1. **Specific options questions**: Pick the option that best aligns with the session goal.
   - If you're uncertain, pick the first option and explain your reasoning.
   - Include rationale: why this option fits the goal and principles.

2. **Open-ended questions**: These are usually about goal/scope interpretation.
   - Reinterpret the question based on the session goal.
   - If the question asks "what should I do", assume the agent should continue with their best judgment unless you have a clear reason to redirect.
   - Never return `watcherAction: "escalate"` for prompt_user triggers.

3. **Ambiguous requirements**: If the question is genuinely unclear:
   - Return `watcherAction: "answer"` with a clarification question.
   - Example: "Are you asking about X or Y? Please clarify."
   - This keeps the loop going while requesting precision.

4. **Default behavior**: If you truly cannot determine a better path:
   - Return `watcherAction: "answer"` with "Continue with your best judgment based on the session goal."
   - Never return null or empty answers.

## Format Requirements

Your response MUST include:
- `watcherAction: "answer"` (always)
- `answer.text: <your answer text>` (always)
- `rationale: <why you chose this>` (optional but recommended)

Invalid actions for prompt_user: `escalate`, `quality_gate`, `continue` (use "answer" for all)
```

### 3. Strengthen Fallback Logic

**Current Fallback (packages/decision-watcher/src/watcher-agent.ts:362-371):**
```typescript
const defaultAnswer = prompt?.options?.[0]
  ? (typeof prompt.options[0] === 'string' ? prompt.options[0] : (prompt.options[0] as { label?: string }).label ?? 'Continue')
  : 'Continue with your best judgment.';

console.error(`[WATCHER] prompt_user: Watcher failed to answer. Action: "${action.watcherAction}", Reason: "${watcherReason.slice(0, 100)}". Using default: "${defaultAnswer}"`);
```

**Improved Fallback:**
```typescript
// Watcher truly failed - use default answer with guidance
const defaultAnswer = prompt?.options?.[0]
  ? (typeof prompt.options[0] === 'string' ? prompt.options[0] : (prompt.options[0] as { label?: string }).label ?? 'Continue')
  : 'Continue with your best judgment based on the session goal and principles.';

// Add specific guidance about WHY the fallback was used
const fallbackReason = action.watcherAction === 'escalate'
  ? `Watcher tried to escalate (invalid for async mode - use 'answer'). `
  : action.watcherAction === 'continue'
  ? `Watcher returned 'continue' instead of answering (invalid for prompt_user). `
  : `Watcher failed to provide an answer. `;

const detailedSystemMessage = `[Watcher auto-answer (FALLBACK)]:
${fallbackReason}
Reason: ${watcherReason.slice(0, 200)}
---
Using default: "${defaultAnswer}"

Guidance: The watcher could not determine a specific direction. Proceed with the default option above. If this feels wrong, re-read the session goal and principles, then choose the path that best aligns with them.`;

console.error(`[WATCHER] prompt_user: ${fallbackReason}Using default: "${defaultAnswer}"`);

return {
  decision: 'block',
  reason: defaultAnswer,
  systemMessage: detailedSystemMessage,
};
```

### 4. Add Prompt-User Validation in Planning Agents

**Add a prompt-user pattern checklist to session-init.ts and planning agent prompts:**

```
## Prompt-User Checklist

Before calling PromptUser, verify:

1. [ ] Is the question specific and answerable?
   - Avoid: "What should I do?" / "What is valuable?"
   - Prefer: "Which option best fits the goal: A, B, or C?"

2. [ ] Have I provided concrete options?
   - Use the `options` parameter with specific choices
   - Include descriptions for non-obvious options

3. [ ] Is the question about HOW to achieve the goal (not WHAT the goal should be)?
   - Goal definition questions belong in handoffSpec/planning phase
   - Prompt-user is for execution decisions, not goal refinement

4. [ ] Have I included sufficient context?
   - What has the agent already discovered?
   - What files have been read?
   - What are the constraints?

If any checkbox is NO → Refine the question before calling PromptUser.
```

### 5. Detect and Flag Ambiguous Prompts

**Add automatic detection in watcher-agent.ts handlePromptUser:**

```typescript
async function handlePromptUser(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const prompt = ctx.userPrompt;
  const questionText = prompt?.question ?? 'Unknown question';

  // Detect potentially ambiguous questions
  const ambiguousPatterns = [
    /what (should|would|could) .+ (do|prioritize|focus|work)/i,
    /what (does|means).+ (value|goal|objective)/i,
    /which (direction|path|way).+ (should|to)/i,
    /how (can|do i) .+ provide/i,
  ];

  const isAmbiguous = ambiguousPatterns.some(pattern => pattern.test(questionText));

  if (isAmbiguous && !prompt?.options?.length) {
    console.warn(`[WATCHER] prompt_user: Potentially ambiguous question without options: "${questionText.slice(0, 100)}..."`);
    // Add observation to salience
    await appendSalienceObservation(config.salienceFilePath, {
      trigger: 'prompt_user',
      action: 'ambiguous_question_detected',
      workId: ctx.workId,
      summary: `Ambiguous prompt_user question detected: "${questionText.slice(0, 80)}". Consider providing specific options.`,
    }).catch(err => {
      console.warn('[WATCHER] Salience update failed:', err instanceof Error ? err.message : String(err));
    });
  }

  // ... rest of handlePromptUser
```

---

## Implementation Plan

### Work Item 1: Enhance Watcher Objective (1 commit)
**File**: `packages/decision-watcher/src/watcher-agent.ts`
**Change**: Update `handlePromptUser` objective to include the enhanced answering guidelines
**Impact**: Watcher will have clearer instructions on how to handle various question types

### Work Item 2: Improve Fallback Logic (1 commit)
**File**: `packages/decision-watcher/src/watcher-agent.ts`
**Change**: Enhance the fallback logic with detailed system messages and better default handling
**Impact**: Fallback answers will be more informative and actionable

### Work Item 3: Add Ambiguity Detection (1 commit)
**File**: `packages/decision-watcher/src/watcher-agent.ts`
**Change**: Add automatic detection of ambiguous questions and log to salience
**Impact**: Ambiguous questions will be flagged for future observation/improvement

### Work Item 4: Document Prompt-User Best Practices (1 commit)
**File**: `packages/agent/src/prompts.ts` or new `packages/agent/src/prompt-user-patterns.md`
**Change**: Add prompt-user checklist and best practices documentation
**Impact**: Agents will have clear guidance on how to construct good prompt-user calls

### Work Item 5: Update Agent Prompts (1 commit)
**File**: `packages/agent/src/prompts.ts`, `packages/decision-watcher/src/session-init.ts`
**Change**: Incorporate the prompt-user checklist into relevant agent prompts
**Impact**: Agents will self-correct before making ambiguous prompt-user calls

---

## Success Metrics

After implementing these improvements, expect:

1. **Reduced Negative Outcomes**: Target <15% negative outcomes (currently 37%)
2. **Higher Answer Quality**: More watcher responses include rationale and specific guidance
3. **Fewer Fallbacks**: Watcher correctly answers instead of escalating
4. **Better Agent Questions**: Agents provide options and context more consistently

---

## Summary

The 37% negative prompt_user outcomes are caused by:
1. **Ambiguous agent questions** without specific options
2. **Watcher misalignment** on how to handle unanswerable questions
3. **Weak fallback logic** that provides generic guidance

The proposed improvements address all three root causes by:
1. Giving agents clear patterns for constructing prompt-user questions
2. Enhancing watcher instructions to handle various question types
3. Strengthening fallback logic with actionable guidance
4. Automatically detecting and flagging ambiguous questions

This is a focused, high-impact improvement that will make the watcher system more effective and reduce friction in agent execution.

---

**Generated by**: Jimmy (personal-assistant skill)
**Data Sources**: agent_actions table (16 prompt_user actions), watcher-agent.ts source code
**Analysis Date**: 2026-01-29
