# Prompt Protocol Spec

> Type-safe linkage between Prompts ↔ Output Schemas ↔ Events ↔ Reducers using plain TypeScript.

## Design Goals

1. **No custom compiler** — Works with plain `tsc`, no build plugins
2. **Prompts as mostly strings** — Not a DSL, just strings with typed injection points
3. **Compile-time guarantees** — Schema changes ripple to prompts, links, and handlers
4. **Provenance tracking** — IDs, versions, hashes, owners for production use
5. **Incremental adoption** — Use only the layers you need

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           COMPILE-TIME CHAIN                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Schema Enum ←→ controlOptions() ←→ link.map ←→ emit ←→ handlers       │
│       │              │                  │          │          │         │
│       ▼              ▼                  ▼          ▼          ▼         │
│   z.enum([])    descriptions      map keys    event tags   handler      │
│   values        (exhaustive)     (exhaustive)  (subset)    keys         │
│                                                           (exhaustive)  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                            RUNTIME FLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Prompt.text → LLM → raw output → Prompt.parse() → Link.toEvent() →    │
│                                        │                │               │
│                                        ▼                ▼               │
│                                   validated        Event object         │
│                                   output                │               │
│                                                         ▼               │
│                                                  Agent.handle() →       │
│                                                         │               │
│                                                         ▼               │
│                                                     Result              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Prompt Asset

A prompt is a text asset with typed metadata:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable identifier (e.g., `"watcher.quality_gate.v1"`) |
| `text` | `string` | Prompt text with optional injected fragments |
| `output` | `z.ZodType` | Zod schema for LLM output validation |
| `control` | `ControlSpec` | Which output fields drive state decisions |
| `meta` | `PromptMeta` | Provenance: version, owner, hash, etc. |

### Output Schema

Per-prompt Zod schema. Not required to equal events — the `link()` bridges them.

### Control Fields

Output fields whose values select control paths. Marked explicitly so the system knows:
- Which fields must appear in prompt text
- Which fields are map keys in `link()`
- Which values to validate exhaustively

### Events

State-machine language. Discriminated union with `type` field. Can originate from:
- Prompt outputs (LLM-produced)
- Hooks/runtime (non-LLM, e.g., user interruption)

### Link

Bridges prompt output → events. Type-checked mapping from control field values to event objects.

### Handlers

Exhaustive reducers from events → results. Missing a handler is a compile-time error.

---

## Public API

### Layer 1: Prompt ↔ Schema (Minimal)

```typescript
import { z } from 'zod';
import { prompt, controls, allowed, controlOptions } from '@prompt-protocol/core';
```

#### `prompt(config)`

Creates a typed prompt asset.

```typescript
interface PromptConfig<S extends z.ZodType> {
  id: string;
  text: string;
  output: S;
  control?: ControlSpec<S>;
  meta?: PromptMeta;
}

interface PromptMeta {
  owner?: string;
  version?: string;
  hash?: string;
  tags?: string[];
}

function prompt<S extends z.ZodType>(config: PromptConfig<S>): Prompt<S>;
```

**Returns:** `Prompt<S>` with methods:
- `.parse(raw: unknown): z.infer<S>` — Validate and parse LLM output
- `.safeParse(raw: unknown): SafeParseResult<z.infer<S>>` — Non-throwing parse
- `.outputJson(): StructuredOutputSchema` — JSON schema for LLM API
- `.text: string` — The prompt text
- `.id: string` — Prompt identifier
- `.meta: PromptMeta` — Provenance metadata

#### `controls(schema, keys)`

Marks which fields are control fields.

```typescript
function controls<
  S extends z.ZodObject<any>,
  K extends keyof z.infer<S>
>(schema: S, keys: K[]): ControlSpec<S, K>;
```

**Example:**
```typescript
const spec = controls(MyOutput, ['action', 'status']);
// spec.fields = ['action', 'status']
// spec.values['action'] = ['continue', 'stop', ...] (extracted from enum)
```

#### `allowed(schema, field)`

Generates a string fragment listing allowed values for a control field.

```typescript
function allowed<
  S extends z.ZodObject<any>,
  K extends keyof z.infer<S>
>(schema: S, field: K): string;
```

**Example:**
```typescript
const ActionSchema = z.object({
  action: z.enum(['continue', 'stop', 'retry']),
});

allowed(ActionSchema, 'action')
// Returns: '"continue" | "stop" | "retry"'
```

#### `controlOptions(schema, field, descriptions)`

Generates a formatted string with values AND descriptions. Type-checks exhaustiveness.

```typescript
function controlOptions<
  S extends z.ZodObject<any>,
  K extends keyof z.infer<S>,
  V extends z.infer<S>[K]
>(
  schema: S,
  field: K,
  descriptions: Record<V, string>
): string;
```

**Example:**
```typescript
controlOptions(ActionSchema, 'action', {
  continue: 'Keep executing the current task',
  stop: 'Halt execution immediately',
  retry: 'Attempt the operation again',
})
// Returns:
// - **continue**: Keep executing the current task
// - **stop**: Halt execution immediately
// - **retry**: Attempt the operation again
```

**Compile-time guarantees:**
- Missing a value → TypeScript error
- Extra value not in enum → TypeScript error

---

### Layer 2: Events ↔ Prompts ↔ Reducers

```typescript
import { events, link, agent, type HandlersFor } from '@prompt-protocol/core';
```

#### `events(schema)`

Wraps a Zod discriminated union as an event definition.

```typescript
function events<S extends z.ZodDiscriminatedUnion<'type', any>>(
  schema: S
): EventDef<S>;
```

**Example:**
```typescript
const MyEvents = events(z.discriminatedUnion('type', [
  z.object({ type: z.literal('started') }),
  z.object({ type: z.literal('completed'), result: z.string() }),
  z.object({ type: z.literal('failed'), error: z.string() }),
]));
```

#### `link(prompt, config)`

Bridges prompt output → events via control field mapping.

```typescript
interface LinkConfig<
  P extends Prompt<any>,
  E extends EventDef<any>,
  EmitTags extends E['tags'][number]
> {
  emit: readonly EmitTags[];
  map: ControlValueMap<P, EmitTags, E>;
}

function link<
  P extends Prompt<any>,
  E extends EventDef<any>,
  EmitTags extends E['tags'][number]
>(prompt: P, config: LinkConfig<P, E, EmitTags>): Link<P, E, EmitTags>;
```

**`ControlValueMap` type:**

For each control field value, provide either:
- A literal event object
- A function `(output) => event`

```typescript
type ControlValueMap<P, EmitTags, E> = {
  [V in ControlValues<P>]:
    | Extract<EventOf<E>, { type: EmitTags }>
    | ((output: OutputOf<P>) => Extract<EventOf<E>, { type: EmitTags }>)
};
```

**Example:**
```typescript
const myLink = link(myPrompt, {
  emit: ['completed', 'failed'] as const,

  map: {
    success: (out) => ({ type: 'completed', result: out.summary }),
    error: (out) => ({ type: 'failed', error: out.message }),
  },
});
```

**Compile-time guarantees:**
- `map` keys must match control field values (exhaustive)
- `map` values must produce events in `emit` list
- `emit` tags must exist in event union

**Returns:** `Link<P, E, EmitTags>` with methods:
- `.toEvent(output: OutputOf<P>): EventOf<E>` — Map parsed output to event
- `.prompt: P` — The linked prompt
- `.emits: EmitTags[]` — Event tags this link can produce

#### `HandlersFor<E, R>`

Type helper for exhaustive event handlers.

```typescript
type HandlersFor<E extends EventDef<any>, R> = {
  [T in E['tags'][number]]: (event: Extract<EventOf<E>, { type: T }>) => R;
};
```

**Example:**
```typescript
const handlers: HandlersFor<typeof MyEvents, StopResult> = {
  started: (e) => ({ action: 'continue' }),
  completed: (e) => ({ action: 'stop', summary: e.result }),
  failed: (e) => ({ action: 'stop', error: e.error }),
};
```

**Compile-time guarantees:**
- Missing handler → TypeScript error
- Handler receives correctly narrowed event type

#### `agent(config)`

Composes prompts, links, and handlers into an agent definition.

```typescript
interface AgentConfig<
  Triggers extends string,
  E extends EventDef<any>,
  R
> {
  id: string;
  prompts: Record<Triggers, Prompt<any>>;
  links: Record<Triggers, Link<any, E, any>>;
  handlers: HandlersFor<E, R>;
  meta?: AgentMeta;
}

function agent<
  Triggers extends string,
  E extends EventDef<any>,
  R
>(config: AgentConfig<Triggers, E, R>): Agent<Triggers, E, R>;
```

**Returns:** `Agent<Triggers, E, R>` with methods:
- `.promptFor(trigger: Triggers): Prompt` — Get prompt for trigger
- `.linkFor(trigger: Triggers): Link` — Get link for trigger
- `.handle(event: EventOf<E>): R` — Reduce event to result
- `.process(trigger: Triggers, raw: unknown): R` — Full pipeline: parse → link → handle

---

### Layer 3: Runtime Helpers (Optional)

```typescript
import { createRuntime } from '@prompt-protocol/runtime';
```

#### `createRuntime(agent, deps)`

Creates a runtime instance with execution helpers.

```typescript
interface RuntimeDeps {
  llm: LLMAdapter;
  logger?: Logger;
  onEvent?: (event: Event, meta: EventMeta) => void;
}

function createRuntime<A extends Agent<any, any, any>>(
  agent: A,
  deps: RuntimeDeps
): Runtime<A>;
```

**Returns:** `Runtime<A>` with methods:
- `.invoke(trigger, context): Promise<Result>` — Full invocation cycle
- `.emit(event): void` — Emit non-LLM event (hooks, user input)
- `.lastEvent(): Event | null` — Most recent event
- `.history(): Event[]` — Event history with provenance

---

## Type Utilities

### Extracting Types

```typescript
// Extract output type from prompt
type OutputOf<P extends Prompt<any>> = z.infer<P['output']>;

// Extract event union from event def
type EventOf<E extends EventDef<any>> = z.infer<E['schema']>;

// Extract control field values from prompt
type ControlValues<P extends Prompt<any>> = P['control']['values'][P['control']['fields'][number]];

// Extract event tags from event def
type TagsOf<E extends EventDef<any>> = E['tags'][number];
```

### Validation Helpers

```typescript
// Check if output is valid for a prompt
function isValidOutput<P extends Prompt<any>>(
  prompt: P,
  value: unknown
): value is OutputOf<P>;

// Check if event is valid for an event def
function isValidEvent<E extends EventDef<any>>(
  events: E,
  value: unknown
): value is EventOf<E>;
```

---

## Full Example

```typescript
// ============================================
// schema.ts — Output schema with control field
// ============================================

import { z } from 'zod';

export const ReviewOutput = z.object({
  response: z.string(),
  verdict: z.enum(['approve', 'request_changes', 'needs_discussion']),
  comments: z.array(z.object({
    file: z.string(),
    line: z.number(),
    text: z.string(),
  })).optional(),
  blockers: z.array(z.string()).optional(),
}).strict();

// ============================================
// prompt.ts — Prompt tied to schema
// ============================================

import { prompt, controls, controlOptions } from '@prompt-protocol/core';
import { ReviewOutput } from './schema';

export const reviewPrompt = prompt({
  id: 'code-review.v1',
  text: `
You are a code reviewer. Analyze the diff and provide feedback.

## Verdict Options
${controlOptions(ReviewOutput, 'verdict', {
  approve: 'Code is ready to merge, no blocking issues',
  request_changes: 'Changes required before merge',
  needs_discussion: 'Architectural questions need team input',
})}

## Response Format
Return JSON with your verdict, reasoning, and specific comments.
`,
  output: ReviewOutput,
  control: controls(ReviewOutput, ['verdict']),
  meta: { owner: 'platform', version: 'v1' },
});

// ============================================
// events.ts — State machine events
// ============================================

import { events } from '@prompt-protocol/core';

export const ReviewEvents = events(z.discriminatedUnion('type', [
  z.object({ type: z.literal('approved') }),
  z.object({
    type: z.literal('changes_requested'),
    comments: z.array(z.object({
      file: z.string(),
      line: z.number(),
      text: z.string(),
    })),
  }),
  z.object({
    type: z.literal('discussion_needed'),
    blockers: z.array(z.string()),
  }),
  // Non-LLM event
  z.object({
    type: z.literal('user_override'),
    action: z.enum(['force_approve', 'force_reject']),
  }),
]));

// ============================================
// link.ts — Bridge output → events
// ============================================

import { link } from '@prompt-protocol/core';
import { reviewPrompt } from './prompt';
import { ReviewEvents } from './events';

export const reviewLink = link(reviewPrompt, {
  emit: ['approved', 'changes_requested', 'discussion_needed'] as const,

  map: {
    approve: () => ({ type: 'approved' }),
    request_changes: (out) => ({
      type: 'changes_requested',
      comments: out.comments ?? [],
    }),
    needs_discussion: (out) => ({
      type: 'discussion_needed',
      blockers: out.blockers ?? [],
    }),
  },
});

// ============================================
// agent.ts — Composed agent
// ============================================

import { agent, type HandlersFor } from '@prompt-protocol/core';
import { reviewPrompt } from './prompt';
import { reviewLink } from './link';
import { ReviewEvents } from './events';

type ReviewEvent = z.infer<typeof ReviewEvents.schema>;

interface ReviewResult {
  action: 'merge' | 'block' | 'escalate';
  message?: string;
}

const handlers: HandlersFor<typeof ReviewEvents, ReviewResult> = {
  approved: () => ({ action: 'merge' }),
  changes_requested: (e) => ({
    action: 'block',
    message: `${e.comments.length} comments require attention`,
  }),
  discussion_needed: (e) => ({
    action: 'escalate',
    message: e.blockers.join(', '),
  }),
  user_override: (e) => ({
    action: e.action === 'force_approve' ? 'merge' : 'block',
    message: 'User override applied',
  }),
};

export const reviewAgent = agent({
  id: 'code-reviewer.v1',
  prompts: { review: reviewPrompt },
  links: { review: reviewLink },
  handlers,
});

// ============================================
// usage.ts — Runtime usage
// ============================================

import { reviewAgent } from './agent';

async function handleReview(diff: string, llm: LLMAdapter) {
  const prompt = reviewAgent.promptFor('review');

  // Call LLM
  const raw = await llm.complete({
    messages: [{ role: 'user', content: diff }],
    systemPrompt: prompt.text,
    responseSchema: prompt.outputJson(),
  });

  // Full pipeline: parse → link → handle
  const result = reviewAgent.process('review', raw);

  return result;
  // { action: 'merge' | 'block' | 'escalate', message?: string }
}
```

---

## Compile-Time Guarantee Summary

| Change | Errors In |
|--------|-----------|
| Add enum value to schema | `controlOptions`, `link.map` (missing key) |
| Remove enum value from schema | `controlOptions`, `link.map` (extra key) |
| Add event type to union | `handlers` (missing handler) |
| Remove event type from union | `link.emit`, `link.map` (invalid tag/value) |
| Change event payload shape | `link.map` return type, `handlers` param type |
| Typo in `emit` tag | Immediate error (not in union) |
| Typo in `map` key | Immediate error (not in enum) |
| Typo in handler key | Immediate error (not in union) |

---

## Non-Goals

1. **Prompt templating DSL** — Prompts are strings. Use template literals.
2. **LLM provider abstraction** — Bring your own `LLMAdapter`.
3. **Execution orchestration** — This is typing, not scheduling.
4. **Streaming** — Orthogonal concern; add to your LLM adapter.

---

## Migration Path

### Level 1: Just schema validation
```typescript
const p = prompt({ id: 'x', text: '...', output: MySchema });
const result = p.parse(llmOutput);
```

### Level 2: Add control fields
```typescript
const p = prompt({
  id: 'x',
  text: `... ${controlOptions(MySchema, 'action', {...})} ...`,
  output: MySchema,
  control: controls(MySchema, ['action']),
});
```

### Level 3: Add event linking
```typescript
const myLink = link(p, { emit: [...], map: {...} });
const event = myLink.toEvent(p.parse(llmOutput));
```

### Level 4: Full agent composition
```typescript
const myAgent = agent({ prompts: {...}, links: {...}, handlers: {...} });
const result = myAgent.process('trigger', llmOutput);
```

---

## Open Questions

1. **Multiple control fields** — Should `link.map` support compound keys, or is handler-side dispatch sufficient?

2. **Async handlers** — Should `HandlersFor` support `Promise<R>` return types?

3. **Event metadata** — Should events automatically carry provenance (which prompt, timestamp)?

4. **Schema versioning** — How to handle schema evolution while maintaining type safety?

5. **Testing utilities** — Should the library provide mock/stub helpers for testing prompts?
