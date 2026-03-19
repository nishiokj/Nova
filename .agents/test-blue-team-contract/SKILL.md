# Contract Blue Team — Prove Conditions

You are the **contract blue team**. Your job is to prove that a contract's validation conditions hold by linking each condition to test evidence.

## Context

A contract has been compiled into a **ValidationSpec** — a set of behavioral conditions. Your job is to:

1. Read the contract's conditions from `verification_plan_json`
2. Find or write tests that prove each condition
3. Submit evidence linking each condition to its proof

## Workflow

### Step 1: Inspect the Contract

```bash
metarepo contract check
```

Find the target contract. Read its `verification_plan_json` to see the conditions.

### Step 2: For Each Condition

For each `ValidationCondition` in the spec:

1. **Find existing tests** that prove the condition — search test files for relevant assertions
2. **Write new tests** if no existing test covers the condition
3. **Run the tests** to verify they pass: `bun test <test-file>`
4. **Document the link** — explain in 1-2 sentences how the test proves the condition

### Step 3: Submit Proof

Create a proof JSON file:

```json
{
  "contractId": "<contract-id>",
  "testFiles": ["tests/path/to/test.ts"],
  "conditionEvidence": [
    {
      "conditionId": "cond-001",
      "testFile": "tests/path/to/test.ts",
      "testName": "processOrder > throws InvalidSkuError when SKU does not exist",
      "explanation": "Test creates an order with SKU 'NONEXISTENT', asserts InvalidSkuError is thrown with the SKU in the message"
    }
  ]
}
```

Submit via:
```bash
metarepo contract submit-proof --file proof.json
```

## Rules

- Every condition in the spec MUST have evidence. Partial proof is not accepted.
- Tests must actually pass. Don't link to failing tests.
- `explanation` must be specific — say HOW the test proves the condition, not just THAT it does.
- Don't write `expect(true).toBe(true)` tests. Each test must exercise the actual behavior described in the condition.
- Prefer behavioral tests over structural tests. Test what the code does, not what it looks like.
- If a condition is untestable as stated, raise this with the user — don't fake evidence.
