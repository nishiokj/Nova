# Patch Spec: Provider-First Model Configuration

## Problem

- Agent configs hardcode provider/model pairs (e.g., `anthropic` + `claude-3-7-sonnet`)
- If user doesn't have that provider's API key, agent fails to resolve
- No graceful fallback or auto-selection based on what's actually configured
- Poor UX when providers are partially configured

## Design Principles

1. **Provider-first**: User configures which providers they have access to
2. **Role-based models**: Agents specify *what they need* (fast, capable, reasoning), not specific models
3. **Runtime resolution**: Pick best available model at startup based on configured providers
4. **Graceful degradation**: Work with whatever the user has configured

## Minimal Changes

### 1. New: Model Roles (in `packages/types/src/providers.ts`)

```typescript
export type ModelRole = 'fast' | 'standard' | 'powerful' | 'reasoning';

// Each provider's best model for each role
export const PROVIDER_MODEL_DEFAULTS: Record<string, Partial<Record<ModelRole, string>>> = {
  'openai': {
    fast: 'gpt-4.1-mini',
    standard: 'gpt-4.1',
    powerful: 'gpt-4.1',
    reasoning: 'o4-mini',
  },
  'anthropic': {
    fast: 'claude-3-5-haiku-20241022',
    standard: 'claude-sonnet-4-20250514',
    powerful: 'claude-sonnet-4-20250514',
    reasoning: 'claude-sonnet-4-20250514',
  },
  'groq': {
    fast: 'llama-3.3-70b-versatile',
    standard: 'llama-3.3-70b-versatile',
  },
  // ... other providers
};
```

### 2. Update: `defaults.json` Agent Schema

**Before:**
```json
"standard": {
  "llm": {
    "provider": "anthropic",
    "model": "claude-3-7-sonnet-20250219",
    "max_tokens": 64000,
    "temperature": 0.7
  },
  ...
}
```

**After:**
```json
"standard": {
  "llm": {
    "role": "standard",
    "max_tokens": 64000,
    "temperature": 0.7
  },
  ...
}
```

### 3. Update: Config Resolution (`config_loader.ts`)

```typescript
function resolveAgentConfig(agentType: string, entry: AgentConfigEntry): ResolvedAgentConfig {
  // If role-based (no explicit provider/model), resolve from configured providers
  if (entry.llm.role && !entry.llm.provider) {
    const resolved = resolveModelForRole(entry.llm.role);
    if (!resolved) {
      throw new Error(`No configured provider supports role '${entry.llm.role}'. Configure a provider in ~/.rex/config.json`);
    }
    entry.llm.provider = resolved.provider;
    entry.llm.model = resolved.model;
  }

  // ... existing resolution logic
}

function resolveModelForRole(role: ModelRole): { provider: string; model: string } | null {
  // Check configured providers in priority order
  const providerPriority = ['anthropic', 'openai', 'groq', 'cerebras', ...];

  for (const provider of providerPriority) {
    // Check if provider has API key configured
    try {
      resolveApiKey(provider);
    } catch {
      continue; // No key, skip
    }

    // Check if provider supports this role
    const model = PROVIDER_MODEL_DEFAULTS[provider]?.[role];
    if (model) {
      return { provider, model };
    }
  }

  return null;
}
```

### 4. User Config: Provider Priority (optional enhancement)

```json
// ~/.rex/config.json
{
  "providers": {
    "openai": "sk-...",
    "anthropic": ""
  },
  "provider_priority": ["openai", "anthropic", "groq"]
}
```

### 5. Startup UX

**Success state:**
```
[config] Configured providers: openai, groq
[config] Default provider: openai
[config] Resolved agents:
  - routing: openai/gpt-4.1-mini (fast)
  - standard: openai/gpt-4.1 (standard)
  - coding-agent: openai/o4-mini (reasoning)
  - explorer: openai/gpt-4.1 (standard)
```

**Error state (no providers):**
```
[config] ERROR: No providers configured!
[config] Set API keys in ~/.rex/config.json or environment:
  - OPENAI_API_KEY
  - ANTHROPIC_API_KEY
  - GROQ_API_KEY
```

## Migration Path

1. Keep supporting explicit `provider`/`model` in config (for power users)
2. New installs get role-based defaults
3. Existing users' explicit configs continue to work

## Files to Change

| File | Changes |
|------|---------|
| `packages/types/src/providers.ts` | Add `ModelRole` type and `PROVIDER_MODEL_DEFAULTS` |
| `packages/harness-daemon/src/harness/config_schema.ts` | Add `role` to `AgentLLMConfigSchema` |
| `packages/harness-daemon/src/harness/config_loader.ts` | Add `resolveModelForRole`, update `resolveAgentConfig` |
| `config/defaults.json` | Replace `provider`/`model` with `role` in agent configs |

## Scope

~150-200 lines of code changes across 4 files.

## Agent Role Mappings

| Agent | Role | Rationale |
|-------|------|-----------|
| `routing` | `fast` | Quick classification, no tools |
| `simple` | `fast` | Quick responses, no tools |
| `explorer` | `standard` | Code search, needs good comprehension |
| `standard` | `standard` | General purpose, balanced |
| `coding-agent` | `reasoning` | Deep coding, benefits from reasoning |
| `context_compactor` | `fast` | Summarization, speed over depth |
| `debugger` | `standard` | Error analysis, needs comprehension |
| `web_crawler` | `fast` | Content extraction, speed matters |
