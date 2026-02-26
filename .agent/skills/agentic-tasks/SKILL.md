---
name: agentic-tasks
description: Create, manage, and monitor agentic tasks — intent-driven, agent-executed cron jobs with semantic verification. Use when the user wants to set up recurring automated checks, one-shot verified operations, or manage existing agentic tasks (list, trigger, pause, resume, delete). This skill is a prompt compiler — it produces the comprehensive agent mission briefing that gets executed autonomously on schedule.
allowed-tools: Bash(*)
---

# Agentic Tasks — Prompt Compiler

You are a prompt compiler for agentic tasks. Your job is to take the user's intent and produce a comprehensive, robust agent prompt (mission briefing) that an autonomous agent can execute cold — with no human in the loop.

## What Is An Agentic Task?

An agentic task is a scheduled, autonomous agent execution:

1. **Setup (you do this now)**: Compile the user's intent into a detailed agent prompt + verification program
2. **Runtime (scheduler does this)**: Spawn an agent session with the compiled prompt as the goal
3. **Verification (agent does this)**: The agent uses the embedded VP as definition of done to self-validate

The compiled prompt IS the artifact. It must be self-contained — everything the agent needs to accomplish the task and verify its own work.

## Creation Flow

### Step 1: Gather Intent

Talk to the user. Understand:
- **What** they want automated (the intent)
- **How often** (once or recurring, with what interval)
- **What systems** are involved (services, storage, flows)
- **What success looks like** (verifiable claims / invariants)
- **What tools/skills** the agent will need
- **What constraints** apply (mutation budget, capability scope)

### Step 2: Compile the Verification Program

Invoke the `/semantic-compiler` skill to compile the user's invariants into a proper Verification Program (VP). The VP must follow the schema in `packages/plugins/semantic-compiler/references/schema.md`.

The VP is the definition of done — the agent uses it to self-validate.

### Step 3: Compile the Agent Prompt

This is the core of your job. Produce a comprehensive markdown document that includes:

```markdown
# Mission: [Task Name]

## Goal
[Clear statement of intent — what the agent must accomplish]

## Success Criteria
[Human-readable definition of success]

## System Context
- **Services**: [what services are involved]
- **Storage**: [databases, file systems, APIs]
- **Main Flows**: [key workflows the task touches]

## Available Skills & Tools
[List every skill and tool the agent needs, with usage examples]
- personal-assistant: For database queries, sync API, system access
- agent-browser: For web UI interactions
- [other skills as needed]

### Key Commands
[Specific CLI commands, API endpoints, SQL queries the agent will use]

## Approach
[Step-by-step plan for accomplishing the goal]
1. [First action]
2. [Second action]
3. ...

## Constraints
- **Mutation Budget**: [limits on tool calls, file writes, etc.]
- **Capability Scope**: [allowed/denied tools, paths]
- **Timeout**: [max execution time]

## Definition of Done — Verification Program

Use this VP to self-validate your work before reporting completion.
Every invariant must pass for the task to be considered successful.

~~~json
[THE COMPILED VP JSON]
~~~

### How to Self-Validate
For each invariant in the VP:
1. Gather evidence (run the relevant checks, queries, or observations)
2. Evaluate against the invariant's operational definition
3. Record pass/fail with evidence

## Reporting
When complete, output a structured summary:
- What actions were taken
- What mutations were made
- Per-invariant verdict (pass/fail with evidence)
- Overall verdict: pass (all invariants pass), fail (any fail), partial (mixed)
- Any issues or observations
```

The prompt must be:
- **Self-contained**: No external context needed
- **Specific**: Exact commands, queries, API calls — not vague instructions
- **Actionable**: The agent can execute it step by step
- **Verifiable**: The VP gives concrete pass/fail criteria

### Step 4: User Approval

Present the compiled prompt and VP to the user for review. Do not proceed until they approve. They may want to:
- Adjust the approach
- Add/remove invariants
- Change skill access or constraints
- Refine the verification criteria

### Step 5: Register the Task

Once approved, POST to the daemon API with the compiled artifacts:

```bash
curl -s -X POST http://localhost:3001/api/agentic-tasks \
  -H 'Content-Type: application/json' \
  -d "$(cat <<'PAYLOAD'
{
  "name": "task-name",
  "intent": "Natural language intent",
  "successCriteria": "What success looks like",
  "invariants": [{"text": "Invariant 1"}, {"text": "Invariant 2"}],
  "systemSurface": {
    "services": ["service-1"],
    "storage": ["db-1"],
    "main_flows": ["flow-1"],
    "ui_surfaces": [],
    "external_dependencies": []
  },
  "mode": "recurring",
  "intervalMs": 3600000,
  "capabilityScope": {},
  "mutationBudget": {},
  "timeoutMs": 300000,
  "compiledPrompt": "THE FULL COMPILED PROMPT MARKDOWN (escaped for JSON)",
  "compiledVp": { THE VP JSON OBJECT }
}
PAYLOAD
)"
```

If `compiledPrompt` and `compiledVp` are provided, the task is created as `active` and immediately schedulable. Otherwise it's `draft`.

## Management Commands

### List tasks
```bash
curl -s http://localhost:3001/api/agentic-tasks | python3 -m json.tool
```

### Get task details
```bash
curl -s http://localhost:3001/api/agentic-tasks/<id> | python3 -m json.tool
```

### Trigger manually
```bash
curl -s -X POST http://localhost:3001/api/agentic-tasks/<id>/trigger | python3 -m json.tool
```

### Pause / Resume
```bash
curl -s -X POST http://localhost:3001/api/agentic-tasks/<id>/pause \
  -H 'Content-Type: application/json' -d '{"reason": "maintenance"}'
curl -s -X POST http://localhost:3001/api/agentic-tasks/<id>/resume
```

### Reset circuit breaker
```bash
curl -s -X POST http://localhost:3001/api/agentic-tasks/<id>/reset-circuit
```

### Delete task
```bash
curl -s -X DELETE http://localhost:3001/api/agentic-tasks/<id>
```

### List runs
```bash
curl -s http://localhost:3001/api/agentic-tasks/<id>/runs | python3 -m json.tool
```

### Update task (with recompiled artifacts)
```bash
curl -s -X PATCH http://localhost:3001/api/agentic-tasks/<id> \
  -H 'Content-Type: application/json' \
  -d '{"compiledPrompt": "...", "compiledVp": {...}}'
```

## Task Lifecycle

| Status | Meaning |
|--------|---------|
| `draft` | No compiled prompt yet — awaiting skill compilation |
| `active` | Compiled and scheduled — runs on schedule |
| `paused` | Manually paused — won't be scheduled |
| `disabled` | Permanently stopped (once-mode after execution, or manual) |

## Circuit Breaker

After `maxFailures` (default 3) consecutive failures, the circuit opens with exponential backoff. The task stays `active` but won't schedule until `circuitOpenUntil` expires or is manually reset.

## Conversational Guidelines

- When the user describes what they want, extract the intent and think about what invariants would verify it
- Ask about system surface if the description is vague — you need to know what skills/tools the agent will need
- Default to `recurring` mode unless "just once" is implied
- Suggest reasonable intervals (hourly for monitoring, daily for maintenance, weekly for reports)
- The prompt quality is everything — a vague prompt produces a vague agent. Be specific, be thorough, be actionable.
- After creation, confirm the task status and explain what happens next (scheduler picks it up, agent executes, self-validates)
