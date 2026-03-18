---
name: capture
description: >
  Extract behavioral contracts from conversation context. Gathers requirements,
  decisions, and constraints discussed in conversation, deduplicates against
  existing contracts, and persists approved candidates via metarepo batch-create.
  Invoke with /capture.
user-invocable: true
---

# Contract Capture

You are extracting behavioral contracts from the current conversation. The goal is to identify requirements, invariants, guarantees, and assumptions that were discussed — and persist them as formal contracts.

## Prerequisites

Confirm the repo is registered with metarepo:

```bash
./metarepo repo show
```

If not registered:

```bash
./metarepo add
```

## Step 1: Gather Context

Collect the key behavioral statements from the conversation. Look for:
- **Requirements** stated by the user ("X must always Y", "never allow Z")
- **Design decisions** ("we decided to use X because Y")
- **Constraints** ("the API must respond within 200ms")
- **Invariants** ("balance can never go negative")
- **Assumptions** ("we assume the database is always available")
- **Guarantees** ("this function will always return a valid result")

Summarize each as a clear, testable behavioral statement.

## Step 2: Load Existing Contracts

Load the domain model and existing contracts to avoid duplicates:

```bash
test-health contracts list
```

Also read the domain model if it exists:

```bash
cat contracts/domain.yaml 2>/dev/null || echo "No domain.yaml found"
```

## Step 3: Extract Candidates via Isolated Subagent

Spawn an **isolated subagent** (using the Agent tool) with ONLY:
- The behavioral statements you gathered from the conversation (no code, no file contents, no tool outputs)
- The domain model content (if it exists)
- Existing contract statements (for deduplication)

The subagent prompt should instruct it to:
1. Analyze the behavioral statements
2. For each, produce a `ContractCandidate` with:
   - `statement`: A clear, testable behavioral assertion
   - `type`: One of `guarantee`, `assumption`, `invariant`, `precondition`, `postcondition`, `metamorphic`
   - `confidence`: 0.0-1.0 (how certain this is a real contract vs. a casual remark)
   - `rationale`: Why this qualifies as a contract
3. Deduplicate against existing contracts — skip any that are semantically equivalent
4. Return the candidates as a JSON array

**Isolation enforcement**: The subagent must NOT receive any code, file contents, or tool outputs. Only conversation-derived behavioral statements and domain context.

The subagent should return JSON in this format:
```json
[
  {
    "statement": "The API must return 400 for malformed requests",
    "type": "guarantee",
    "confidence": 0.9,
    "rationale": "Explicitly discussed as a requirement"
  }
]
```

## Step 4: Present Candidates

Show the candidates to the user in a clear table format:

```
# Contract Candidates

| # | Type       | Confidence | Statement                                    |
|---|------------|------------|----------------------------------------------|
| 1 | guarantee  | 0.9        | The API must return 400 for malformed requests |
| 2 | invariant  | 0.85       | Balance can never go negative                 |

Rationale:
1. Explicitly discussed as a requirement
2. Stated as a hard rule during design review
```

Ask the user which candidates to accept (e.g., "all", "1,3,5", or "none").

## Step 5: Resolve Entity Links

For each accepted contract, link it to entities in the graph:

1. Extract keywords from the contract statement — function names, class names, domain nouns
2. For each keyword, search for matching entities:

```bash
test-health entities search <keyword> --json
```

3. Present matched entities to the user and ask which to link to this contract
4. Collect the selected `entityIds` for each contract

If no entities match or the user declines linking, the contract is still created — just without entity links. But linked contracts are far more valuable because they trigger staleness detection when the linked code changes.

## Step 6: Persist Accepted Contracts

Write the accepted candidates (with entity links) to a temporary JSON file and call metarepo:

```bash
cat > /tmp/capture-$(date +%s).json << 'CAPTURE_EOF'
[
  {
    "statement": "...",
    "type": "guarantee",
    "source": "event",
    "confidence": 0.9,
    "entityIds": ["function:src/orders/process.ts:processOrder"]
  }
]
CAPTURE_EOF

./metarepo contract create --file /tmp/capture-<timestamp>.json
```

The `entityIds` field is passed through to `contractBatchCreate` and linked in the database. This enables staleness tracking when linked entities change.

## Step 7: Report

Show the updated contract summary:

```bash
test-health contracts check
```

Tell the user:
- How many contracts were captured
- How many have entity links (and will trigger staleness on code changes)
- Run `/test-blue-team` to write tests that defend contracts at their boundaries
- `test-health contracts list` to browse all contracts

## Tone

Be efficient. The capture should feel like a quick review, not a ceremony. Show candidates, get approval, persist, done.
