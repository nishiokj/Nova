# Planning Mode Feature

Implementation of planning mode with handoff capability.

## Overview

Planning mode is a read-only exploration phase that prevents writes while the agent explores the codebase, asks clarifying questions, and builds a comprehensive implementation spec. When ready, the agent uses the handoff skill to create a spec that can be executed in a fresh context.

## Triggering Planning Mode

Two ways to trigger:

1. **Prefix trigger**: Start message with "planning mode " or "/plan "
   - Example: `planning mode add user authentication`
   - Auto-enables plan mode, strips prefix, sends the rest as the prompt

2. **Toggle command**: `/plan` toggles plan mode on/off

## Changes Made

### 1. TUI Auto-trigger (`packages/tui/index.tsx`)

```typescript
// Auto-trigger planning mode: "planning mode <prompt>" or "/plan <prompt>"
let effectiveText = text;
let effectivePlanMode = snapshot.planMode;
const lowerText = text.toLowerCase();
if (lowerText.startsWith("planning mode ") || lowerText.startsWith("/plan ")) {
  const prefixLen = lowerText.startsWith("planning mode ") ? 14 : 6;
  effectiveText = text.slice(prefixLen).trim();
  if (effectiveText && !effectivePlanMode) {
    effectivePlanMode = true;
    store.setPlanMode(true);
    store.addMessage("system", "Plan mode auto-enabled. Exploring and planning before implementation.");
  }
}
```

Located in the Enter key handler, before sending `send_text` command.

### 2. Planning Prompt (`packages/agent/src/prompts.ts`)

Updated `PLANNING_PROMPT_ADDENDUM` with three phases:

```markdown
## PLAN MODE ACTIVE

You are in **planning mode**: a fast, high-signal discovery phase. Your job is to get just enough system understanding to ask sharp questions, lock invariants, and produce a crisp plan.

**Constraints:**
- Read, Glob, Grep tools available
- Write, Edit tools disabled
- Bash available for read-only commands only

**Operating principles (from epistemic compaction):**
- Prefer actionability over descriptiveness. Read only what you need to act.
- Preserve constraints and invariants over raw exploration logs.
- Stop exploration as soon as you can ask high-signal questions.

**Your mission has three phases:**

### Phase 1: Rapid Orientation (timeboxed)
Goal: identify the minimal set of files, entry points, and constraints to understand the change.
Rules:
- Prefer targeted Read/Grep over broad exploration.
- Keep tool calls lean (roughly 3-6 reads) before asking questions.
- Stop once you can describe the shape of the change and likely touch points.

### Phase 2: High-Signal Questions
Ask only high-leverage questions that encode invariants, architecture, taste, and integration boundaries.
Avoid generic questions you can infer from code. Prefer options and tradeoffs.

Examples of high-signal categories:
- Invariants: "Must remain backward compatible with v1? If yes, which behaviors are locked?"
- Architecture: "Should this live in existing X module or introduce a new Y layer?"
- UX/behavior: "What is the desired user-visible behavior for edge case Z?"
- Performance/security: "Any latency or auth constraints that override defaults?"
- Scope: "Include tests/migrations/telemetry, or defer?"

Use action "need_user_input" with clear options. The Q&A thread becomes part of your spec.

### Phase 3: Handoff
When the goal is clear and invariants are captured, ask the user for handoff approval, then act immediately on the answer.

Use action "need_user_input" with:
- userPrompt.questionType: "plan_mode_exit"
- userPrompt.question: "Ready to handoff the plan?"
- userPrompt.options: [
    { label: "Yes, handoff now", description: "Create the handoff spec immediately" },
    { label: "No, keep planning", description: "Stay in plan mode to refine the plan" }
  ]

If the user says yes, immediately call the **handoff skill** in the next response.
If the user says no, continue planning.

The handoff skill will guide you to:
1. Create a spec with goal, approach, Q&A decisions, implementation steps, key files, and constraints
2. Output it in a copyable format
3. Instruct the user to start a fresh session with the spec

**Do NOT handoff until:**
1. You can name the minimal touch points and data flow
2. You have captured non-negotiable constraints and preferences
3. You have a concrete, ordered plan
```

### 3. Skill Tool (`packages/harness-daemon/src/harness/harness.ts`)

Registered a new `Skill` tool that loads and executes skills by name:

```typescript
Skill({ skill: "handoff" })  // Execute the handoff skill
Skill({ skill: "list" })      // List available skills
Skill({ skill: "handoff", args: "include test plan" })  // With arguments
```

The tool:
- Loads skill instructions from `config/skills/<name>/SKILL.md`
- Returns instructions as tool output for agent to follow
- Supports listing available skills
- Validates skill exists and is enabled

### 4. Handoff Skill (`config/skills/handoff/SKILL.md`)

Skill file with instructions for creating comprehensive handoff specs:

- **Goal**: What we're building and why
- **Approach**: Architectural decisions from planning
- **Q&A Decisions**: Every question asked and user's answer (explicit preferences)
- **Implementation Steps**: Ordered steps with file paths
- **Key Files**: Files discovered during exploration
- **Constraints & Gotchas**: Things NOT to do, invariants, edge cases
- **Artifacts**: Code patterns, interfaces discovered

The skill instructs the agent to output the spec in a copyable code block and tell the user to start a fresh session with it.

### 5. QuestionType Support (`packages/agent/src/types.ts`, `packages/agent/src/agent.ts`)

Added `questionType` field to `UserPromptInfo`:

```typescript
export interface UserPromptInfo {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;  // NEW
}
```

Agent extracts `questionType` from structured output in `parseUserPromptValue()`.

## Flow

```
1. User: "planning mode add authentication"
   └─> TUI auto-enables plan mode, sends "add authentication"

2. Agent explores codebase (Read, Glob, Grep, Bash read-only)
   └─> Reads files, traces dependencies, understands architecture

3. Agent asks clarifying questions via need_user_input
   └─> "Should we use JWT or session-based auth?"
   └─> User answers, Q&A becomes part of spec

4. Agent calls Skill({ skill: "handoff" })
   └─> Skill tool loads handoff instructions from SKILL.md
   └─> Agent follows instructions to generate spec
   └─> Outputs as copyable code block

5. User starts fresh session with spec
   └─> /clear or new terminal
   └─> Pastes spec
   └─> Execution agent implements with full context
```

## Design Principles

1. **Minimal code changes** - Skill tool registered in harness, skills loaded from files
2. **Skill-based handoff** - Skills are just instruction files loaded via tool
3. **Q&A is first-class** - Explicit user preferences, not implicit encoding
4. **Fresh context** - User manually starts new session (clean, simple)
5. **Extensible** - Add new skills by dropping SKILL.md files in config/skills/

## Files Changed

| File | Change |
|------|--------|
| `packages/tui/index.tsx` | Auto-trigger for "planning mode" prefix |
| `packages/agent/src/prompts.ts` | Three-phase planning prompt with Skill tool usage |
| `packages/agent/src/types.ts` | Added `questionType` to UserPromptInfo |
| `packages/agent/src/agent.ts` | Extract questionType from structured output |
| `packages/harness-daemon/src/harness/harness.ts` | Register Skill tool |
| `packages/harness-daemon/src/harness/config_types.ts` | Add Skill to DEFAULT_ENABLED_TOOLS |
| `packages/tools/src/tool_schemas.ts` | Add SkillArgsSchema |
| `config/skills/handoff/SKILL.md` | Handoff skill instructions |
