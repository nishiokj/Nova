---
name: capture
description: >
  Extract behavioral contracts from conversation context. Gathers requirements,
  decisions, and constraints discussed in conversation, deduplicates against
  existing contracts, decomposes each into validation conditions, and persists
  approved candidates via metarepo batch-create. Invoke with /capture.
user-invocable: true
---

# Contract Capture

You are extracting behavioral contracts from the current conversation. The goal is to identify requirements, invariants, guarantees, and assumptions that were discussed — persist them as formal contracts with validation conditions ready for the blue team to prove.

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
./metarepo contract check
```

Also read the domain model if it exists:

```bash
cat contracts/domain.yaml 2>/dev/null || echo "No domain.yaml found"
```

## Step 3: Extract Candidates with Conditions via Isolated Subagent

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
   - `conditions`: An array of behavioral conditions that decompose the contract statement into precise, testable claims. Each condition has:
     - `id`: Sequential ID like `cond-001`, `cond-002`, etc.
     - `statement`: A precise behavioral claim — what must be true, not how to test it
     - `rationale`: Why this condition is necessary for the contract to hold
3. Deduplicate against existing contracts — skip any that are semantically equivalent
4. Return the candidates as a JSON array

**Condition guidelines for the subagent:**
- Conditions are behavioral claims, not test instructions. "Calling X with invalid input throws Y" not "Write a test that calls X"
- Each condition should be independently verifiable by a single test
- Cover the core assertion, edge cases, and side-effect safety where relevant
- 2-5 conditions per contract is typical. Don't over-decompose simple contracts.

**Isolation enforcement**: The subagent must NOT receive any code, file contents, or tool outputs. Only conversation-derived behavioral statements and domain context.

The subagent should return JSON in this format:
```json
[
  {
    "statement": "processOrder must throw InvalidSkuError when SKU doesn't exist",
    "type": "guarantee",
    "confidence": 0.9,
    "rationale": "Explicitly discussed as a requirement",
    "conditions": [
      {
        "id": "cond-001",
        "statement": "Calling processOrder with a SKU that does not exist in the product catalog causes an InvalidSkuError to be thrown",
        "rationale": "Core contract — the function must reject unknown SKUs with the specific error type"
      },
      {
        "id": "cond-002",
        "statement": "The InvalidSkuError contains the offending SKU value in its message or properties",
        "rationale": "Error must be actionable — caller needs to know which SKU failed"
      },
      {
        "id": "cond-003",
        "statement": "No order record is created or persisted when the SKU is invalid",
        "rationale": "Side-effect safety — failed validation must not produce partial state"
      }
    ]
  }
]
```

## Step 4: Present Candidates with Conditions

Show each candidate with its conditions so the user reviews the full package:

```
# Contract Candidates

## 1. [guarantee] processOrder must throw InvalidSkuError when SKU doesn't exist
   Confidence: 0.9 | Rationale: Explicitly discussed as a requirement

   Conditions:
   - cond-001: Calling processOrder with a nonexistent SKU causes InvalidSkuError
   - cond-002: The InvalidSkuError contains the offending SKU value
   - cond-003: No order record is created when the SKU is invalid

## 2. [invariant] Balance can never go negative
   Confidence: 0.85 | Rationale: Stated as a hard rule during design review

   Conditions:
   - cond-001: Any withdrawal that would reduce balance below zero is rejected
   - cond-002: Concurrent withdrawals cannot race past zero
```

Ask the user which candidates to accept (e.g., "all", "1,3,5", or "none"). The user is reviewing both the contract statement AND its conditions in one pass.

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

Write the accepted candidates (with entity links and conditions) to a temporary JSON file and call metarepo:

```bash
cat > /tmp/capture-$(date +%s).json << 'CAPTURE_EOF'
[
  {
    "statement": "...",
    "type": "guarantee",
    "source": "event",
    "confidence": 0.9,
    "entityIds": ["function:src/orders/process.ts:processOrder"],
    "conditions": [
      {
        "id": "cond-001",
        "statement": "Calling processOrder with a nonexistent SKU causes InvalidSkuError",
        "rationale": "Core contract behavior"
      }
    ]
  }
]
CAPTURE_EOF

./metarepo contract create --file /tmp/capture-<timestamp>.json
```

Contracts with conditions are persisted with status `compiled` (validation spec attached). Contracts without conditions start as `insufficient`.

## Step 7: Report

Show the updated contract summary:

```bash
./metarepo contract check
```

Tell the user:
- How many contracts were captured (and how many have validation specs)
- How many have entity links (and will trigger staleness on code changes)
- Next step: run the contract blue team (`/test-blue-team-contract`) to prove conditions with tests
- `./metarepo contract check` to browse all contracts

## Tone

Be efficient. The capture should feel like a quick review, not a ceremony. Show candidates with conditions, get approval, persist, done.
