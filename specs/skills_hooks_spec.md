# Skills and Hooks Implementation Spec (ts-tui + Backend)

**Status:** Draft (v1)  
**Owner:** Platform  
**Target:** `rex` harness + ts-tui  
**Last updated:** 2025-01-01

---

## 1) Goals

- Add first-class **Skills** and **Hooks** as programmatic primitives in the harness.
- Provide a full **ts-tui** workflow to create, edit, enable/disable, run, and delete Skills and Hooks.
- Integrate with the **invocation lifecycle** (pre/post invocation, pre/post tool).
- Keep strict **separation of concerns** between storage, routing, execution, and UI.
- Ensure robustness: validation, atomic writes, safe defaults, logging, and tests.

## 2) Non-Goals

- Skills as LLM-callable tools (explicitly NOT exposed to LLM tool definitions).
- Interactive/GUI dashboard for skills/hooks (ts-tui only for v1).
- Remote syncing or cloud storage.
- Arbitrary code execution from hooks.

---

## 3) Definitions

**Skill:** A deterministic, programmatic workflow that can call tools. Skills are triggered semantically (not by LLM tool choice) and executed by the harness.

**Hook:** A deterministic, event-driven rule that runs at specific lifecycle points and can mutate invocation context or tool execution environment.

**Invocation:** A single request lifecycle from user input to final response (includes tool calls).

---

## 4) Key Decisions (v1)

- Skills can call tools; default allowlist is all enabled tools.
- Hooks can mutate environment and invocation context deterministically.
- Skills and hooks are NOT exposed as tools to the LLM.
- Skills are triggered semantically; hooks are deterministic and event-driven.
- Default Skill: **Create Skill** (workflow to validate and register new skills).

---

## 5) High-Level Architecture

```
ServiceRep -> AgentHarness -> (SkillRouter? SkillRunner?) -> Agent -> ToolRegistry
                               |                        |
                               |-> HookManager (before/after invocation)
                               |-> HookManager (before/after tool)
```

### Recommended placement
- **Skill routing and execution happen in AgentHarness**, before calling the Agent.
- **HookManager** is called in both AgentHarness (invocation hooks) and ToolRegistry (tool hooks).

---

## 6) Config Additions

Add to `src/util/config.py`:

```python
@dataclass
class SkillsConfig:
    enabled: bool = True
    skills_dir: str = "config/skills"
    semantic_enabled: bool = True
    semantic_min_confidence: float = 0.82
    semantic_llm_config: Optional[LLMConfig] = None  # defaults to service_rep llm
    max_candidates: int = 8
    match_policy: str = "best_score"  # "best_score" | "first_match"


@dataclass
class HooksConfig:
    enabled: bool = True
    hooks_dir: str = "config/hooks"
    default_fail_open: bool = True
    max_exec_ms: int = 200
```

Add to `HarnessConfig`:
```python
skills: SkillsConfig = field(default_factory=SkillsConfig)
hooks: HooksConfig = field(default_factory=HooksConfig)
```

Resolution rules:
- `skills.semantic_llm_config` falls back to `service_rep.llm_config` if unset.
- `skills_dir` and `hooks_dir` default to repo `config/` folder.

---

## 7) Data Model

Use Pydantic v2 models for strict validation. All JSON is ASCII-safe.

### SkillDefinition (Pydantic)

Fields:
- `id`: str, unique slug, `^[a-z0-9][a-z0-9_-]{2,63}$`
- `name`: str (display name)
- `description`: str
- `version`: str (e.g., "v1")
- `type`: "workflow" | "tool_chain"
- `triggers`: list of TriggerDefinition
- `input_schema`: JSON schema (object only)
- `output_schema`: optional JSON schema
- `steps`: list of SkillStep (if type=workflow)
- `tool_chain`: list of ToolStep (if type=tool_chain)
- `allowed_tools`: list of tool names or ["*"]
- `timeout_ms`: int (default 30000)
- `enabled`: bool
- `tags`: list[str]
- `created_at`, `updated_at`: RFC3339 strings

TriggerDefinition:
- `type`: "regex" | "keyword" | "semantic"
- `pattern`: str (regex for regex type)
- `keywords`: list[str] (for keyword type)
- `threshold`: float (semantic, default from config)
- `description`: str (semantic hint for LLM)

SkillStep:
- `name`: str
- `tool`: str
- `args`: dict (template values allowed: `{{input.field}}`)

### HookDefinition (Pydantic)

Fields:
- `id`, `name`, `description`, `enabled`
- `trigger`: "invocation.before" | "invocation.after" | "tool.before" | "tool.after"
- `priority`: int (higher runs first)
- `timeout_ms`: int (default 100)
- `fail_open`: bool
- `filter`: HookFilter
- `action`: HookAction
- `created_at`, `updated_at`

HookFilter:
- `tool_name`: optional str
- `tier`: optional str
- `user_input_regex`: optional str
- `session_key`: optional str
- `request_id`: optional str

HookAction:
- `type`: "observe" | "annotate" | "block" | "mutate"
- `message`: optional str (for block)
- `ops`: list of MutationOp (if mutate)

MutationOp:
- `op`: "set_env" | "set_workdir" | "set_tier" | "set_tool_policy" |
        "transform_input" | "transform_tool_args" | "transform_tool_result" |
        "annotate_context"
- `key`, `value`, `scope`, `path`, `template` as needed by op

---

## 8) Storage Layout

- `config/skills/*.json` one file per skill.
- `config/hooks/*.json` one file per hook.
- Atomic writes: write to temp file then rename.
- Reject invalid JSON or schema mismatch with detailed error list.

---

## 9) Runtime Components

### `src/skills/store.py`
- CRUD operations with strict validation.
- `list()`, `get(id)`, `create(defn)`, `update(id, defn)`, `delete(id)`.
- Atomic write and directory creation.

### `src/skills/registry.py`
- Cache of SkillDefinition by id.
- `reload_if_needed()` (mtime-based).
- `list_enabled()`, `get(id)`.

### `src/skills/router.py`
- `route(text, tier, session_key) -> SkillMatch | None`.
- Match order:
  1) regex triggers
  2) keyword triggers
  3) semantic triggers (if enabled)
- Semantic matching via LLM (temperature 0, returns skill id or "none").
- Applies `match_policy`: `best_score` or `first_match`.

### `src/skills/runner.py`
- Executes tool steps using `ToolRegistry.execute`.
- Validates allowed tools (supports ["*"]).
- Renders args using template substitution.
- Returns `SkillRunResult` with:
  - `success`, `output`, `tool_calls`, `duration_ms`, `error`.

### `src/hooks/store.py`
- CRUD operations with strict validation.

### `src/hooks/engine.py`
- Evaluates hooks for given `HookTrigger` and `InvocationContext`.
- Produces ordered list of HookDecision with applied mutations.

### `src/hooks/manager.py`
- Orchestrates hook execution.
- Applies `fail_open` and timeouts.
- Exposes `run(trigger, context) -> HookResult`.

---

## 10) Invocation Integration

### AgentHarness

Add fields:
- `self.skill_registry`, `self.skill_router`, `self.skill_runner`
- `self.hook_manager`

Flow in `AgentHarness.process()`:
1) `HookManager.run("invocation.before", ctx)`
2) If hooks block: return blocked response.
3) `SkillRouter.route(speech_text, tier, session_key)`
4) If skill matched:
   - Execute skill with SkillRunner.
   - `HookManager.run("invocation.after", ctx)`
   - Return result without calling agent.
5) Else: proceed to `agent.run` as today.
6) After agent response, run `invocation.after`.

### ToolRegistry

Add execution context:
```python
class ToolExecutionContext:
    env_overrides: Dict[str, str] = {}
    workdir_override: Optional[str] = None
    tool_policy: Optional[ToolPolicy] = None
```

Integrate hooks:
1) `HookManager.run("tool.before", ctx)` to mutate args/env.
2) Execute tool with env/workdir overrides.
3) `HookManager.run("tool.after", ctx)` to mutate result.

Apply `env_overrides` only for this tool call:
- Use context manager to temporarily update `os.environ`.
- Pass env to `_bash_execute` subprocess call.

---

## 11) Hook Mutation Semantics

### Allowed ops (v1)
- `set_env`: set env var (scope: invocation | process)
- `set_workdir`: override working dir for tool execution
- `set_tier`: override tier for this invocation
- `set_tool_policy`: enable/disable tools for this invocation only
- `transform_input`: replace user input before skill routing/agent run
- `transform_tool_args`: mutate tool args before execution
- `transform_tool_result`: mutate tool result after execution
- `annotate_context`: attach metadata to invocation context

### Enforcement
- Block or mutate strictly within HookManager.
- No tool calls from hooks.

---

## 12) ts-tui UI (Ink)

### Commands
Add to `tui-ts/commands.ts`:
- `/skills`
- `/skills new`
- `/skills edit <id>`
- `/skills delete <id>`
- `/skills enable <id>`
- `/skills disable <id>`
- `/skills run <id>`
- `/hooks`
- `/hooks new`
- `/hooks edit <id>`
- `/hooks delete <id>`
- `/hooks enable <id>`
- `/hooks disable <id>`

### UI State
Add to `tui-ts/store.ts`:
- `uiMode: "chat" | "skills" | "hooks" | "wizard"`
- `wizardType: "skill" | "hook"`
- `wizardStepIndex`, `wizardData`, `wizardErrors`

### Wizard Flow
Skill wizard steps:
1) Basics (id, name, description, version)
2) Type (workflow or tool_chain)
3) Triggers (regex/keyword/semantic)
4) Input schema
5) Steps/tool_chain
6) Allowed tools, timeout, enabled
7) Review + Save

Hook wizard steps:
1) Basics (id, name, description, priority, timeout)
2) Trigger type
3) Filters
4) Action type
5) Mutation ops (if mutate)
6) Review + Save

### UX details
- `Esc` cancels wizard, `Ctrl+S` saves, `Enter` advances.
- Inline validation on each step, with summary on review step.

---

## 13) Bridge Protocol (JSONL)

Add to `tui-ts/types.ts`:

Commands:
- `skills_list`, `skills_get`, `skills_create`, `skills_update`,
  `skills_delete`, `skills_run`
- `hooks_list`, `hooks_get`, `hooks_create`, `hooks_update`, `hooks_delete`

Responses:
- `response` with `metadata.kind` in {"skills","hooks"} and `payload`.
- `error` with `detail` containing validation errors.

Example:
```json
{ "type": "skills_create", "data": { "definition": { ... } } }
```

Response:
```json
{
  "type": "response",
  "data": {
    "request_id": "skills_123",
    "content": "Skill created",
    "metadata": {
      "kind": "skills",
      "payload": { "id": "create_skill", "enabled": true }
    }
  }
}
```

---

## 14) Logging and Observability

- Log category: `skills` and `hooks`.
- Log every skill execution with id, duration, tools used, success.
- Log every hook decision with trigger, action, and mutations applied.

---

## 15) Error Handling

- All SkillStore/HookStore operations return structured errors on invalid JSON.
- Hook timeouts default to fail-open unless explicitly fail-closed.
- SkillRunner returns structured error payload on tool failure.

---

## 16) Testing Plan

### Unit
- SkillStore/HookStore validation and atomic write.
- SkillRouter matching (regex/keyword/semantic).
- SkillRunner tool chain execution + allowlist.
- HookEngine filter + mutation behavior.

### Integration
- Skill routing in AgentHarness (skill consumes request, agent not called).
- Tool hooks mutate args/result correctly.

### TUI
- Command parsing and wizard state transitions.
- Bridge command success/error handling.

---

## 17) Implementation Steps (Scaffolded)

### Step 1: Config + Models
- Add `SkillsConfig` and `HooksConfig` to `src/util/config.py`.
- Add Pydantic models for Skill/Hook in `src/skills/models.py` and `src/hooks/models.py`.
**Acceptance:** config loads, models validate sample JSON.

### Step 2: Stores
- Implement `SkillStore` and `HookStore` with atomic writes.
**Acceptance:** CRUD + validation; no partial writes on crash.

### Step 3: Router + Runner
- Implement `SkillRouter` (regex/keyword first; semantic optional).
- Implement `SkillRunner` and `SkillRunResult`.
**Acceptance:** skill execution works on a tool_chain with allowlist.

### Step 4: Hook Engine + Manager
- Implement `HookEngine` + `HookManager`.
- Add mutation application logic and timeout handling.
**Acceptance:** hooks can mutate env and tool args deterministically.

### Step 5: Harness Integration
- Wire SkillRouter/Runner into `AgentHarness.process`.
- Add HookManager calls in invocation lifecycle.
**Acceptance:** skill bypasses agent; hooks run before/after.

### Step 6: ToolRegistry Integration
- Add `ToolExecutionContext` and hook support.
- Apply env/workdir overrides safely.
**Acceptance:** tool hook mutation observed in `bash_execute`.

### Step 7: Bridge + TUI
- Add commands/events to bridge + ts-tui.
- Implement skill/hook wizards.
**Acceptance:** full CRUD and run from TUI.

### Step 8: Tests
- Add unit/integration tests for above.
**Acceptance:** tests cover matching, mutation, execution paths.

---

## 18) Appendix: Example Skill and Hook JSON

### Skill: Create Skill
```json
{
  "id": "create_skill",
  "name": "Create Skill",
  "version": "v1",
  "type": "workflow",
  "description": "Create and register a new skill from spec",
  "triggers": [
    { "type": "regex", "pattern": "^(create|add|new) skill" }
  ],
  "input_schema": {
    "type": "object",
    "properties": { "spec": { "type": "string" } },
    "required": ["spec"]
  },
  "steps": [
    { "name": "validate_spec", "tool": "python_execute", "args": { "code": "..." } },
    { "name": "save_file", "tool": "file_write", "args": { "path": "config/skills/{{input.id}}.json", "content": "{{input.spec}}" } }
  ],
  "allowed_tools": ["*"],
  "timeout_ms": 30000,
  "enabled": true,
  "tags": ["core"]
}
```

### Hook: Set NODE_ENV for Builds
```json
{
  "id": "set_node_env",
  "name": "Set NODE_ENV",
  "trigger": "invocation.before",
  "filter": { "user_input_regex": "build|compile" },
  "action": {
    "type": "mutate",
    "ops": [
      { "op": "set_env", "key": "NODE_ENV", "value": "production", "scope": "invocation" }
    ]
  },
  "priority": 50,
  "timeout_ms": 100,
  "fail_open": true,
  "enabled": true
}
```

