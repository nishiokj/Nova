## Contract Protocol

### First-time setup

Run `/contract-init` to initialize contracts for this repo. This walks through a 5-question domain interview, seeds contracts, and reports contract health.

### Before implementing a feature

1. `test-health contracts list <filepath>` — review existing contracts for affected files
2. `test-health contracts for <entity-id>` — check contracts on specific boundaries
3. Note which contracts your change will touch

### After implementation

4. `/capture` — extract contracts from the conversation (requirements, decisions, invariants discussed)
5. `test-health contracts stale` — check for newly stale contracts (staleness is marked automatically on entity changes)
6. `test-health contracts check` — full contract health report (coverage, staleness, violations)
