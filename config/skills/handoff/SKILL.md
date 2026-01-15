---
name: handoff
description: Create a comprehensive implementation spec from planning session and hand off to fresh execution context. Use when planning is complete and ready to implement.
enabled: true
tags: [planning, handoff, spec, execution]
---

# Handoff Skill

You are transitioning from **planning mode to execution**. Your job is to distill everything from the planning session into a comprehensive spec that a fresh agent can execute without needing the full conversation history.

## When to Use

Use this skill when:
- You've explored the codebase sufficiently
- You've asked questions and resolved ambiguities
- You have a concrete implementation plan
- The user requests handoff or you determine planning is complete

## The Spec Format

Create a comprehensive handoff document. This is not a minimal spec - it's a **complete transfer of context**. Include everything a fresh agent needs.

```markdown
# Implementation Spec: [One-line summary]

## Goal
What are we building and why? Be specific about the end state.

## Approach
The architectural decisions made during planning. Include:
- Which existing patterns/abstractions to use
- Key files that will be modified
- Dependencies on other systems

## Q&A Decisions
Every question asked and answered during planning. These are **explicit user preferences** - the execution agent must honor them.

- **Q**: [Question you asked]
  **A**: [User's answer]
  **Implication**: [How this affects implementation]

- **Q**: [Next question]
  **A**: [Answer]
  **Implication**: [Impact]

## Implementation Steps
Ordered steps with file paths. Be specific enough that each step is unambiguous.

1. **[File: path/to/file.ts]** - What to change and why
2. **[File: another/file.ts]** - Next change
3. ...

## Key Files Reference
Files discovered during exploration that the execution agent should read first.

- `path/to/file.ts`: Brief description of what it does, why it matters
- `path/to/other.ts`: ...

## Constraints & Gotchas
Things NOT to do. Invariants to maintain. Edge cases to handle.

- Don't [specific antipattern discovered]
- Must maintain [invariant]
- Watch out for [gotcha]

## Artifacts
Any code patterns, interfaces, or structures discovered during exploration that the execution agent needs.

```typescript
// Example interface discovered
interface SomeInterface {
  // ...
}
```
```

## Handoff Process

1. **Generate the spec** using the format above
2. **Output it in a code block** so user can copy it
3. **Ask user to confirm**: "Spec ready. Start a new session with `/clear` and paste this spec to begin implementation."

## Example Output

After generating the spec:

```
Here's the complete handoff spec:

[YOUR SPEC IN A CODE BLOCK]

**To execute:**
1. Run `/clear` to start fresh (or open new terminal)
2. Paste the spec above
3. The execution agent will have full context to implement

Ready to proceed?
```

## Key Principles

- **Q&A is first-class**: Every question-answer pair is explicit user intent. Don't bury it.
- **Files are specific**: Use exact paths, not vague descriptions
- **Steps are atomic**: Each step should be completable independently
- **Constraints are learned**: Include gotchas discovered during exploration
- **Fresh context wins**: The execution agent starts clean but informed
