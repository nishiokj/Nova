---
name: contract-init
description: >
  Initialize the contract verification layer for a repo. Runs a guided domain
  interview (5 questions), persists domain.yaml, seeds intent-derived contracts,
  compiles contracts into verification plans, and reports contract health.
  Invoke with /contract-init.
user-invocable: true
---

# Contract Init

You are initializing the contract verification layer for this repository. This is a guided conversation — ask the questions one at a time, confirm understanding, then persist everything.

## Prerequisites

Before starting the interview, confirm the repo is registered with metarepo:

```bash
./metarepo repo show
```

If not registered:

```bash
./metarepo add
```

## The Interview

Ask these 5 questions **one at a time**. Wait for the user's answer before proceeding to the next question. Adapt your follow-ups based on what they say — don't just robotically march through the list.

### Question 1: System Purpose

> What does this system do?

You're looking for a 1-2 sentence description of what the system does and who it serves. If the answer is vague, ask a clarifying follow-up like "Who are the primary users?" or "What's the core transaction?"

### Question 2: Domain Entities

> What are the core domain entities — the key nouns?

Examples: User, Order, Payment, Product, Session. You want the conceptual building blocks, not every database table. If they list too many, ask which 3-5 are most critical.

### Question 3: Critical Path

> What's the critical path — the workflow that absolutely cannot break?

You're looking for the primary happy-path flow, step by step. Something like "User signs up → creates project → invites team → deploys". If they give multiple, ask which one they'd fix first if it broke at 3am.

### Question 4: Hard Rules

> What are the hard rules — things that must *never* happen?

These become invariant contracts. Examples: "Balance never goes negative", "Deleted users can't log in", "Orders can't be modified after payment". Push for specifics — "data integrity" is not a hard rule.

### Question 5: Pain Points

> Where do bugs actually show up? What breaks in practice?

These become assumption contracts flagged for review. Examples: "Webhook fires twice causing duplicates", "Race condition on concurrent checkouts", "Cache invalidation misses on profile updates".

## Persistence

Once you have all 5 answers, do the following:

### 1. Write domain.yaml

Create `contracts/domain.yaml` in the repo root with the collected answers:

```yaml
version: 1
system: "<their answer to Q1>"
entities:
  - name: EntityName
    description: ""
    aliases: []
critical_path: "<their answer to Q3>"
hard_rules:
  - "<each hard rule on its own line>"
pain_points:
  - "<each pain point on its own line>"
```

### 2. Seed intent-derived contracts

Run the interview RPC to persist the domain model and seed contracts. Create a temporary JSON file with the responses and call:

```bash
cat > /tmp/contract-interview.json << 'INTERVIEW_EOF'
{
  "systemDescription": "<Q1 answer>",
  "entities": "<Q2 answer, comma-separated>",
  "criticalPath": "<Q3 answer>",
  "hardRules": "<Q4 answers, newline-separated>",
  "painPoints": "<Q5 answers, newline-separated>"
}
INTERVIEW_EOF

./metarepo contract interview --file /tmp/contract-interview.json
```

### 3. Compile contracts into verification plans

Compile the seeded contracts through the semantic compiler:

```bash
./metarepo contract compile
```

Or if metarepo isn't running, use the direct CLI:

```bash
test-health contracts compile
```

### 4. Report

Show the user the contract health check:

```bash
test-health contracts check
```

Then show a brief summary:
- How many intent-derived contracts were seeded (from the interview)
- How many contracts were compiled into verification plans
- Current contract health (stale, unverified, coverage %)

### 5. Next steps

Tell the user:
- `test-health contracts list` to browse all contracts
- `test-health contracts compile` to recompile after changes
- Contracts auto-mark as stale when linked code changes
- `test-health contracts check` for ongoing health monitoring

## Tone

Be conversational, not bureaucratic. The interview should feel like a 2-minute chat with a new teammate who's trying to understand the system, not a form to fill out.
