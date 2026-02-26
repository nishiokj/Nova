# Output Contract

Use this as a hard contract for compiled VP output.

## Required Top-Level Keys

The output object must include:
- `vp_version`
- `uow_id`
- `generated_at`
- `system_surface`
- `invariants`
- `compile_findings`

Optional keys:
- `approval_gate`
- `unresolved_questions`
- `status`
- `execution_ready`
- `definition_of_done`

## Required Invariant Keys

Each invariant must include:
- `inv_id`
- `original_text`
- `refined`
- `assumptions`
- `verification_plan`
- `verdict_rule`
- `compile_status`

## Required Verification Plan Keys

Each `verification_plan` must include:
- `strategy_id`
- `steps`
- `evidence`

## Required Step Rules

Each step must include:
- `kind`
- `spec`

Step-specific requirements:
- `kind === "assert"` requires typed `assertion` object.
- `kind === "trace_check"` requires `predicate` and `trace_source`.

## Forbidden Alias Fields

Treat any of these as schema failures:
- Invariants: `id`, `raw`
- Steps: `type`, `action`, `assert`
- Findings: `level` without canonical fields

## Canonical Valid Example (Minimal)

```json
{
  "vp_version": "0.1",
  "uow_id": "UOW-2026-02-10-0001",
  "generated_at": "2026-02-10T00:00:00.000Z",
  "system_surface": {
    "services": ["tui"],
    "storage": ["prefs"],
    "ui_surfaces": ["chat footer"],
    "external_dependencies": ["provider credentials"],
    "main_flows": ["model cycling"]
  },
  "invariants": [
    {
      "inv_id": "INV-001",
      "original_text": "Esc+M should only cycle accessible models.",
      "refined": {
        "intent": "Esc+M cycles only through accessible models.",
        "scope": ["tui", "get_models"],
        "operational_definition": [
          "Esc+M selects from modelsAvailableList only."
        ]
      },
      "assumptions": [
        "modelsAvailableList mirrors accessible model payload."
      ],
      "verification_plan": {
        "strategy_id": "ui_scenario",
        "steps": [
          {
            "kind": "assert",
            "spec": "assert selected provider is accessible",
            "assertion": {
              "kind": "contains",
              "left": "selected.provider",
              "right": "accessibleProviders"
            }
          }
        ],
        "evidence": ["trace.jsonl"]
      },
      "verdict_rule": "all asserts pass",
      "compile_status": "compiled"
    }
  ],
  "compile_findings": []
}
```

## Invalid Example (Reject)

```json
{
  "uow_id": "UOW-FAIL",
  "invariants": [
    {
      "id": "INV-1",
      "raw": "Esc+M only configured providers",
      "verification_plan": {
        "steps": [
          {
            "type": "assert",
            "action": "inspect output",
            "assert": "only configured providers"
          }
        ]
      }
    }
  ],
  "compile_findings": [
    { "level": "info", "message": "looks good" }
  ]
}
```
