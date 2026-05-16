---
name: red-blue-team
description: >
  Claim-first red/blue testing workflow for any repository. Use when the user
  wants an agent to discover or defend behavior claims, write repo-native tests,
  attack those tests with mutations, and persist results through metarepo.
user-invocable: true
---

# Red/Blue Team

You are running a claim-first test-strength loop. The agent is the interface and reasoning runtime; `metarepo` is the durable state and evaluation toolkit.

Use the repo's own language, test runner, dependencies, and conventions. Do not assume TypeScript, Vitest, or AST line ranges. Claims are durable; AST, coverage, line numbers, and local file state are ephemeral client-side evidence.

## Product Boundary

- Agent owns: reading code, generating/refining behavior claims, editing tests, choosing repo-native commands, interpreting failures, explaining results.
- Metarepo owns: repo registration, claim ledger, assignment, defense records, mutation records, run/artifact/event history.
- CLI/API owns: stable tool contracts. Do not call metarepo HTTP endpoints directly.

## Bootstrap

From the repository under test:

```bash
metarepo status
metarepo add --client
metarepo repo show
```

Use `./metarepo` if that is how the repo exposes the wrapper. If `metarepo` is unavailable, the workflow is blocked until the user installs or points you at the client.

## Claims

A behavior claim is a durable statement of what the repo should do. It is not a line-number boundary.

Inspect the contract before writing JSON:

```bash
metarepo claims schema
```

Create claims only when you can point to repo evidence:

```bash
metarepo claims create --file claim.json
metarepo claims list
```

Good claims:
- describe observable behavior
- include scope hints such as files, symbols, language, or package
- include evidence hints such as relevant tests and a test command
- avoid brittle source coordinates unless they are purely metadata

## Blue Workflow

Blue defends the next assigned claim. Do not choose an easier claim after assignment.

```bash
metarepo blue assign-claim [selector]
metarepo blue schema
```

Then:

1. Read the assigned claim and its scope/evidence hints.
2. Read the relevant source and current tests.
3. Write or strengthen repo-native tests that prove the claim at the observable behavior boundary.
4. Run the narrowest meaningful test command.
5. Persist the defense:

```bash
metarepo blue record-defense --file defense.json
```

Defense JSON must use the `assignmentArtifactId` returned by `blue assign-claim`. Include all changed test/support files and the exact command that passed.

If the claim exposes a real product bug or setup blocker, create a durable bug instead of faking coverage:

```bash
metarepo bug create --title "..." --description "..."
```

## Red Workflow

Red attacks a defended claim. It may generate candidate mutations, but it must persist/evaluate only mutations tied to the claim.

```bash
metarepo red schema
metarepo red evaluate --file mutation.json --claim-id <claim-id>
```

Use `red evaluate` when working from a local client repo: it creates an isolated local workspace, runs the baseline command, applies the mutation, reruns the test command, and records the result.

Valid mutations:
- target behavior covered by the claim
- change externally observable behavior
- use exact literal replace operations from `metarepo red schema`
- run the repo-native test command likely to kill or reveal the mutant

Invalid mutations:
- attack an unrelated helper or neighboring behavior
- depend on editing tests
- are equivalent to current behavior
- are merely formatting or implementation trivia

## Report

End every loop with:

- claim id and behavior
- defense files and passing command
- red mutation status: killed, survived, or invalid
- what the next blue action should be if a mutant survived

If the CLI lacks a command needed for this loop, report the missing product surface instead of bypassing metarepo.
