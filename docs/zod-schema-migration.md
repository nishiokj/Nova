# Zod Schema Migration Plan

This document outlines the migration from manual TypeScript interfaces to Zod schemas for runtime validation across the codebase.

## Why Zod?

The current pattern uses dual types (raw config → resolved config) with manual transformation functions. Problems:

1. **No runtime validation** - JSON configs are type-asserted, not validated
2. **Duplicated types** - Raw and resolved versions of the same data
3. **Scattered validation** - `typeof` checks, `Set.has()`, `isSupportedProvider()` spread across files
4. **Silent failures** - Invalid config/output passes through until something breaks downstream

Zod gives us:
- Single source of truth (schema defines shape AND generates types)
- Runtime validation with clear error messages
- Built-in transformation via `.transform()`
- Type inference via `z.infer<typeof schema>`

---

## Priority 1: Config Pipeline

**Impact:** Foundation - everything depends on config loading correctly.

### Files to Change

| File | Current State | Zod Migration |
|------|---------------|---------------|
| `packages/harness-daemon/src/harness/config_types.ts` | 20+ manual interfaces | Delete, replace with Zod schemas |
| `packages/harness-daemon/src/harness/config_loader.ts` | Manual validation, `typeof` checks, Set-based enums | Use `.parse()` with schemas |
| `config/harness_config.json` | No validation | Validated at load time |

### Current Manual Validation in config_loader.ts

```typescript
// Line 166-167: Manual type narrowing
if (typeof parsed !== 'object' || parsed === null) {
  throw new Error('Invalid config: expected object');
}

// Line 326-338: Set-based enum validation
const OPENAI_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const ANTHROPIC_REASONING_EFFORTS = new Set(['standard', 'minimal', ...]);

// Line 389: Provider validation
function isSupportedProvider(provider: string): boolean { ... }
```

### Target Schema Structure

```typescript
// packages/harness-daemon/src/harness/config_schema.ts

import { z } from 'zod';

// Provider enum with canonical mapping
const ProviderSchema = z.enum(['anthropic', 'openai', 'openai-compat', 'cerebras', 'together', 'groq', 'fireworks', 'gemini']);

// Reasoning effort (provider-specific validation can be a refinement)
const ReasoningEffortSchema = z.enum(['none', 'standard', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// Fallback config - validates AND resolves in one step
const FallbackConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  api_base: z.string().optional(),
}).transform((raw) => {
  const apiKey = resolveApiKey(raw.provider);
  const canonicalProvider = getCanonicalProvider(raw.provider);
  const baseUrl = getProviderBaseUrl(raw.provider, raw.api_base);
  return {
    provider: canonicalProvider,
    model: raw.model,
    apiKey,
    baseUrl,
  };
});

// LLM config
const AgentLLMConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  max_tokens: z.number().positive(),
  temperature: z.number().min(0).max(2).optional(),
  api_base: z.string().optional(),
  reasoning: z.union([
    ReasoningEffortSchema,
    z.object({ effort: ReasoningEffortSchema }),
  ]).optional(),
  fallback: FallbackConfigSchema.optional(),
}).transform((raw) => {
  // Resolution logic here
});

// Budget config
const AgentBudgetConfigSchema = z.object({
  max_iterations: z.number().positive().int(),
  max_tool_calls: z.number().nonnegative().int(),
  max_duration_ms: z.number().positive(),
});

// Full agent entry
const AgentConfigEntrySchema = z.object({
  llm: AgentLLMConfigSchema,
  budget: AgentBudgetConfigSchema,
  tools: z.array(z.string()).optional(),
  output_schema: z.union([z.string(), StructuredOutputSchemaZod]).optional(),
});

// Root config
const HarnessConfigSchema = z.object({
  providers: z.record(z.string()).optional(),
  agents: z.record(AgentConfigEntrySchema),
  tools: ToolsConfigSchema.optional().default(DEFAULT_TOOLS_CONFIG),
  graphd: GraphDConfigSchema.optional().default(DEFAULT_GRAPHD_CONFIG),
  context: ContextConfigSchema.optional().default(DEFAULT_CONTEXT_CONFIG),
  skills: SkillsConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
});

// Inferred types - no manual interface definitions needed
export type ResolvedAgentConfig = z.output<typeof AgentConfigEntrySchema>;
export type FullHarnessConfig = z.output<typeof HarnessConfigSchema>;
```

### Migration Steps

1. Create `config_schema.ts` with Zod schemas
2. Move resolution logic (API key lookup, provider canonicalization) into `.transform()`
3. Update `loadConfigFile()` to use `HarnessConfigSchema.parse()`
4. Delete manual interfaces from `config_types.ts` (keep only what's not derivable)
5. Update imports across codebase to use inferred types

---

## Priority 2: Agent Structured Output

**Impact:** Agent outputs are currently unvalidated. A routing agent could return `{ tier: "invalid" }` and nothing catches it.

### Files to Change

| File | Current State | Zod Migration |
|------|---------------|---------------|
| `config/output_schemas.json` | JSON Schema definitions | Convert to Zod or validate against |
| `packages/shared/src/structured_output.ts` | `isRecord()`, manual JSON parse | Zod parsing with schema validation |

### Current Manual Validation

```typescript
// structured_output.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  // Manual JSON parse, no schema validation
}
```

### Target: Schema-Validated Output

```typescript
// Output schemas as Zod
const RoutingOutputSchema = z.object({
  tier: z.enum(['simple', 'standard', 'complex']),
  reasoning: z.string(),
});

const GoalDrivenOutputSchema = z.object({
  response_to_user: z.string().nullable(),
  goal_achieved: z.boolean(),
  reasoning: z.string(),
  next_step: z.string().nullable(),
});

// Registry of output schemas
const OUTPUT_SCHEMAS = {
  routing: RoutingOutputSchema,
  goal_driven: GoalDrivenOutputSchema,
  // ...
} as const;

// Validated parsing
function parseAgentOutput<T extends keyof typeof OUTPUT_SCHEMAS>(
  schemaName: T,
  rawOutput: string
): z.output<typeof OUTPUT_SCHEMAS[T]> {
  const json = JSON.parse(rawOutput);
  return OUTPUT_SCHEMAS[schemaName].parse(json);
}
```

---

## Priority 3: Event System

**Impact:** Events flow over JSONL-TCP with no validation. Malformed events could crash subscribers.

### Files to Change

| File | Current State | Zod Migration |
|------|---------------|---------------|
| `packages/types/src/events.ts` | Loose `AgentEvent<T>` generic | Discriminated union schemas |
| `packages/comms-bus/src/bus_server.ts` | JSONL parsing without validation | Validate incoming messages |

### Current Loose Typing

```typescript
// events.ts
export interface AgentEvent<T = unknown> {
  type: AgentEventType;
  timestamp: number;
  sessionId: string;
  requestId: string;
  agentId?: string;
  data: T;  // Completely unvalidated
}
```

### Target: Discriminated Union

```typescript
const ToolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  timestamp: z.number(),
  sessionId: z.string(),
  requestId: z.string(),
  agentId: z.string().optional(),
  data: z.object({
    tool: z.string(),
    args: z.record(z.unknown()),
    result: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number(),
  }),
});

const LLMCallEventSchema = z.object({
  type: z.literal('llm_call'),
  // ...
});

const AgentEventSchema = z.discriminatedUnion('type', [
  ToolCallEventSchema,
  LLMCallEventSchema,
  // ... all event types
]);
```

---

## Priority 4: Tool Arguments

**Impact:** LLM could hallucinate invalid args. Currently only caught at execution time.

### Files to Change

| File | Current State | Zod Migration |
|------|---------------|---------------|
| `packages/types/src/tools.ts` | `BashArgs`, `ReadArgs` as interfaces | Zod schemas for each tool |
| `packages/tools/src/registry.ts` | No argument validation | Validate before execution |

### Current State

```typescript
// tools.ts - interfaces only, no runtime validation
export interface BashArgs {
  command: string;
  timeout?: number;
  workingDir?: string;
}
```

### Target: Validated Tool Execution

```typescript
const BashArgsSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional(),
  workingDir: z.string().optional(),
});

const ReadArgsSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().nonnegative().int().optional(),
  limit: z.number().positive().int().optional(),
});

// In registry
async execute(toolName: string, rawArgs: unknown): Promise<ToolResult> {
  const schema = TOOL_SCHEMAS[toolName];
  const args = schema.parse(rawArgs);  // Validates before execution
  return this.tools[toolName].execute(args);
}
```

---

## Priority 5: LLM Response Parsing

**Impact:** Catches malformed API responses from OpenAI/Anthropic.

### Files to Change

| File | Current State | Zod Migration |
|------|---------------|---------------|
| `packages/types/src/llm.ts` | `Message`, `ContentBlock` unions | Discriminated union schemas |
| `packages/llm/src/adapter.ts` | Manual error property checking | Error schema validation |

### Current Manual Error Parsing

```typescript
// adapter.ts lines 57-101
function parseApiError(responseText: string): { message: string; type?: string } {
  const parsed = JSON.parse(responseText);
  // Manual checks for OpenAI format
  if (parsed.error?.message) { ... }
  // Manual checks for Anthropic format
  if (parsed.error?.type && parsed.error?.message) { ... }
}
```

### Target: Schema-Based Parsing

```typescript
const OpenAIErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.string().optional(),
  }),
});

const AnthropicErrorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

const APIErrorSchema = z.union([OpenAIErrorSchema, AnthropicErrorSchema]);
```

---

## Lower Priority Items

### Work Items & Plans
- `packages/work/src/work-item.ts` - WorkItem creation validation
- `packages/types/src/plan.ts` - Discovery, SuccessCriteria validation

### Context & Session
- `packages/types/src/context.ts` - ContextItem discriminated union
- `packages/types/src/session.ts` - Session, KnowledgeEntry validation

### Logger
- `packages/shared/src/logger.ts` - LoggerConfig validation

---

## Migration Strategy

### Phase 1: Foundation (Config)
1. Add `zod` dependency to relevant packages
2. Create `config_schema.ts` alongside existing `config_types.ts`
3. Migrate `loadConfigFile()` to use Zod
4. Delete redundant manual types
5. Update all imports

### Phase 2: Agent Output
1. Convert `output_schemas.json` to Zod schemas
2. Update `structured_output.ts` to validate against schemas
3. Add validation in agent response handling

### Phase 3: Events & Comms
1. Create event schemas with discriminated unions
2. Add validation in comms-bus message handling
3. Type-safe event emission and subscription

### Phase 4: Tools
1. Create tool argument schemas
2. Add validation in tool registry before execution
3. Better error messages for invalid tool calls

### Phase 5: LLM Layer
1. Create response schemas for each provider
2. Validate API responses before processing
3. Schema-based error parsing

---

## Files to Delete After Migration

Once Zod schemas are in place, these can be simplified or removed:

- Most of `config_types.ts` (interfaces replaced by `z.infer<>`)
- Manual validation functions in `config_loader.ts`
- `isRecord()` and similar type guards
- Set-based enum validation (OPENAI_REASONING_EFFORTS, etc.)

---

## Dependencies

```json
{
  "dependencies": {
    "zod": "^3.22.0"
  }
}
```

Zod has zero dependencies and is ~50KB. Worth it for runtime safety.
