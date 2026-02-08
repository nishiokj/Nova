---
type: workflow
title: TO-DO
description: ### Shrink the font on the right side panel
acceptance_criteria: []
template: feature
templateIdq: 01JN0000000000000000000001
specs: [plan, implement, unit-tests, integration-tests, run-tests, invariants]
sessionKey: cockpit_1770518488668_fh2trk
---
# TO-DO

### Shrink the font on the right side panel 
### When you do "ctrl+`" and close the chat panel your cursor should return to where it was before, specifically if you were editing markdown
### Delete the autocomplete that's currently in the frontend
### Add Glow around the markdown editor while it's active
### Remove the "AC" from the frontend control

## Acceptance Criteria

- [ ] *Define acceptance criteria...*
## Workflow Steps

1. **plan** — Plan the feature implementation [planner]
2. **implement** — Implement the feature [coder] (after: plan)
3. **unit-tests** — Write unit tests for new code [coder] (after: implement)
4. **integration-tests** — Write integration tests [coder] (after: implement)
5. **run-tests** — Run all tests [test-runner] (after: unit-tests, integration-tests)
6. **invariants** — Verify semantic invariants hold [coder] (after: run-tests)