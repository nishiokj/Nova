# WorkItem Templates & Testing Strategy

## Core Insight

A request is essentially the first WorkItem. The planner already produces WorkItem DAGs. A "workflow template" is just a **precomputed DAG** stored in the database.

No new entities. No new states. Just templates that get instantiated into the existing WorkItem queue.

---

## WorkItem Templates

### What They Are

A template is a stored WorkItem DAG — the same structure the planner produces dynamically, but precomputed for common patterns.

```typescript
interface WorkItemSpec {
  id: string;                    // Template-local ID for dependency references
  objective: string;
  agent: string;
  dependencies: string[];        // IDs of specs this depends on
  metadata?: Record<string, unknown>;
}

interface WorkItemTemplate {
  id: string;                    // ULID
  name: string;                  // "feature", "bugfix", "prototype"
  description: string;
  specs: WorkItemSpec[];         // The DAG
  createdAt: number;
  updatedAt: number;
}
```

### Example Templates

**Feature Template:**
```typescript
{
  name: 'feature',
  description: 'New feature with full test coverage',
  specs: [
    { id: 'plan', objective: 'Plan the feature implementation', agent: 'planner', dependencies: [] },
    { id: 'implement', objective: 'Implement the feature', agent: 'coder', dependencies: ['plan'] },
    { id: 'unit-tests', objective: 'Write unit tests for new code', agent: 'coder', dependencies: ['implement'] },
    { id: 'integration-tests', objective: 'Write integration tests', agent: 'coder', dependencies: ['implement'] },
    { id: 'run-tests', objective: 'Run all tests', agent: 'test-runner', dependencies: ['unit-tests', 'integration-tests'] },
    { id: 'invariants', objective: 'Verify semantic invariants hold', agent: 'coder', dependencies: ['run-tests'] },
  ],
}
```

**Bugfix Template:**
```typescript
{
  name: 'bugfix',
  description: 'Fix a bug with regression tests',
  specs: [
    { id: 'reproduce', objective: 'Create failing test that reproduces the bug', agent: 'coder', dependencies: [] },
    { id: 'fix', objective: 'Fix the bug', agent: 'coder', dependencies: ['reproduce'] },
    { id: 'verify', objective: 'Confirm reproduction test now passes', agent: 'test-runner', dependencies: ['fix'] },
    { id: 'suite', objective: 'Run existing test suite', agent: 'test-runner', dependencies: ['fix'] },
    { id: 'regression', objective: 'Add regression tests for similar edge cases', agent: 'coder', dependencies: ['verify'] },
  ],
}
```

**Prototype Template:**
```typescript
{
  name: 'prototype',
  description: 'Quick prototype with minimal testing',
  specs: [
    { id: 'implement', objective: 'Build the prototype', agent: 'coder', dependencies: [] },
    { id: 'sanity', objective: 'Basic sanity test - does it run?', agent: 'test-runner', dependencies: ['implement'] },
  ],
}
```

**Refactor Template:**
```typescript
{
  name: 'refactor',
  description: 'Refactor with no behavior change',
  specs: [
    { id: 'plan', objective: 'Plan the refactor', agent: 'planner', dependencies: [] },
    { id: 'refactor', objective: 'Execute the refactor', agent: 'coder', dependencies: ['plan'] },
    { id: 'typecheck', objective: 'Run typecheck', agent: 'test-runner', dependencies: ['refactor'] },
    { id: 'suite', objective: 'Run existing tests (must all pass)', agent: 'test-runner', dependencies: ['refactor'] },
  ],
}
```

---

## How Templates Get Used

### Option 1: User Selects Template
```
User: "Fix the auth bug" [selects bugfix template]
       ↓
Orchestrator: Instantiate bugfix template → enqueue WorkItems
```

### Option 2: Router Agent Selects
```
User: "Fix the auth bug"
       ↓
Router Agent: Classify as bugfix → select bugfix template
       ↓
Orchestrator: Instantiate template → enqueue WorkItems
```

### Option 3: Planner Creates Dynamic DAG
```
User: "Do something unusual"
       ↓
Planner: Analyze goal → produce custom WorkItem DAG
       ↓
Orchestrator: Enqueue WorkItems from planner output
```

The orchestrator doesn't care which path — it just receives WorkItems with dependencies.

---

## Template Instantiation

When a template is used, the orchestrator:

1. Fetches the template by ID or name
2. Creates real WorkItems from each spec
3. Maps template-local IDs to real workIds
4. Resolves dependencies using the ID map
5. Enqueues all WorkItems

```typescript
function instantiateTemplate(
  template: WorkItemTemplate,
  sessionKey: string,
  goalContext: string
): WorkItem[] {
  const idMap = new Map<string, string>();  // template ID → real workId
  const items: WorkItem[] = [];

  // First pass: create WorkItems, build ID map
  for (const spec of template.specs) {
    const item = createWorkItem({
      objective: `${spec.objective}\n\nContext: ${goalContext}`,
      agent: spec.agent,
      dependencies: [],  // Resolve in second pass
      metadata: { templateId: template.id, templateStepId: spec.id, ...spec.metadata },
    });
    idMap.set(spec.id, item.workId);
    items.push(item);
  }

  // Second pass: resolve dependencies
  for (let i = 0; i < template.specs.length; i++) {
    const spec = template.specs[i];
    items[i] = cloneWorkItemWithDependencies(
      items[i],
      spec.dependencies.map(depId => idMap.get(depId)!)
    );
  }

  return items;
}
```

---

## Testing Strategy

Testing isn't a separate system — it's **WorkItems in the template**.

### Different Templates = Different Testing Strategies

| Template | Testing WorkItems | Rationale |
|----------|-------------------|-----------|
| **Feature** | unit tests, integration tests, run all, invariants | New code needs comprehensive coverage |
| **Bugfix** | reproduce, verify fix, run suite, regression tests | Prove bug is fixed, don't break existing |
| **Prototype** | sanity test only | Speed over coverage |
| **Refactor** | typecheck, existing suite | No new behavior, must not regress |

### Invariant Tests

For the "verify semantic invariants" step, the agent receives context about what invariants were established:

```typescript
{
  id: 'invariants',
  objective: `
    Verify the following semantic invariants hold:
    {{session.invariants}}

    Create test assertions for each. Every invariant needs at least one test.
  `,
  agent: 'coder',
  dependencies: ['run-tests'],
}
```

Invariants come from:
- User requirements stated in goal
- Decisions made during escalation resolution
- Watcher guidance during implementation

---

## TestReport

TestReport is an **artifact** produced by testing WorkItems — like traces are produced by commits.

```typescript
interface TestCase {
  name: string;
  suite: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  durationMs: number;
  error?: string;
  output?: string;          // Truncated to 4KB
}

interface TestReport {
  id: string;               // ULID
  sessionKey: string;
  workItemId: string;       // Which WorkItem produced this

  // Summary
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  passCount: number;
  failCount: number;
  errorCount: number;
  skipCount: number;

  // Detail
  cases: TestCase[];

  // Optional metrics
  coverage?: {
    lines: number;
    branches: number;
    functions: number;
  };
  mutationScore?: number;

  // Execution metadata
  command: string;          // What was run
  durationMs: number;
  createdAt: number;
}
```

### How TestReports Are Created

Testing WorkItems (agent: 'test-runner') execute test commands and parse output:

1. Agent runs test command (npm test, pytest, etc.)
2. Post-tool hook detects test output
3. Parser extracts structured results (Jest JSON, pytest JSON, TAP, etc.)
4. TestReport created and stored
5. Report linked to WorkItem that produced it

### Failed Tests

If a testing WorkItem produces a TestReport with `verdict: 'fail'`:

- WorkItem completes (it ran successfully, tests just failed)
- Downstream WorkItems may be blocked by dependency
- Watcher may escalate if failures are unexpected
- Session doesn't auto-fail — depends on template design

---

## Database Schema

```sql
-- WorkItem Templates (precomputed DAGs)
CREATE TABLE workitem_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  specs JSONB NOT NULL,           -- WorkItemSpec[]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default templates
INSERT INTO workitem_templates (id, name, description, specs) VALUES
  ('01FEATURE', 'feature', 'New feature with full test coverage', '...'::jsonb),
  ('02BUGFIX', 'bugfix', 'Fix a bug with regression tests', '...'::jsonb),
  ('03PROTOTYPE', 'prototype', 'Quick prototype with minimal testing', '...'::jsonb),
  ('04REFACTOR', 'refactor', 'Refactor with no behavior change', '...'::jsonb);

-- Test Reports (artifacts from testing WorkItems)
CREATE TABLE test_reports (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  work_item_id TEXT NOT NULL,

  verdict TEXT NOT NULL,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  skip_count INTEGER NOT NULL DEFAULT 0,

  cases JSONB NOT NULL DEFAULT '[]'::jsonb,
  coverage JSONB,
  mutation_score REAL,

  command TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_test_reports_session ON test_reports(session_key);
CREATE INDEX idx_test_reports_work_item ON test_reports(work_item_id);
CREATE INDEX idx_test_reports_verdict ON test_reports(verdict);
```

---

## What This Doesn't Add

- No new entities beyond `WorkItemTemplate` and `TestReport`
- No new states
- No "Workflow" as separate from Session
- No workflow engine
- No complex durability/replay semantics

Templates are just stored DAGs. The orchestrator already knows how to execute WorkItem DAGs. Testing is just WorkItems that produce TestReport artifacts.

---

## Open Questions

1. **Template customization** — Can users modify templates or create their own?
2. **Template selection UI** — How does user pick template vs. letting planner decide?
3. **Test output parsing** — Which formats do we support? (Jest, pytest, TAP, go test, cargo test)
4. **Invariant tracking** — Where do semantic invariants get stored during session?
5. **Mutation testing** — When to run? Cost/benefit tradeoff?
