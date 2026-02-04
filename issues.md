# Agent Issue Log

When you encounter errors, failures, friction, or broken tools — log them here. This is a shared backlog for the swarm.

## Format

```markdown
### YYYY-MM-DD — [TAG] Short description
- **Context**: What were you trying to do?
- **Tool/CLI**: What failed?
- **Error**: The error message or unexpected behavior
- **Assessment**: Bug, bad DX, missing feature, stale docs, config issue, slop?
- **Suggestion**: How to fix it

Tags: [BUG] [DX] [MISSING] [DOCS] [CONFIG] [SLOP] [BLOCKER]
```

---

## Open Issues

<!-- Agents: append new issues below this line -->

### 2026-02-03 — [MISSING] plan-context.md not found
- **Context**: Starting execution work item requires reading plan-context.md per instructions.
- **Tool/CLI**: Read
- **Error**: File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md
- **Assessment**: Missing planning artifact or path mismatch.
- **Suggestion**: Ensure plan-context.md is created in session root or provide correct path in instructions.


