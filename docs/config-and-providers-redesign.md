# Configuration & Providers System Redesign

## Current Problems

### 1. Config Distribution is Broken
The current flow copies `config/harness_config.json` to `~/.rex/config.json` on first install. This creates several issues:

- **Stale configs**: User config is never updated when package updates
- **Missing sections**: New config sections (like `models`) are missing from old user configs
- **No migration**: No versioning or schema migration strategy
- **Confusing precedence**: Users edit project config but daemon loads user config

### 2. Models Definition is Awkward
Models are currently defined in two places:
- `config.models.available` - a curated list
- Extracted from `config.agents[*].llm` - fallback when models list is empty

This is confusing. Models should be defined once, clearly, and mapped to their provider.

### 3. "OpenAI Compatible" is Not a Provider
`openai-compat` appears as a provider option in the TUI, but it's not a provider - it's a programmatic interface standard. Real providers (Cerebras, Groq, Together, etc.) use this interface, but users shouldn't see "OpenAI Compatible" as an option.

### 4. No Discovery of Available Models
Users have no way to know what models are available for a provider they've configured. The `/models` view should show models based on which providers the user has API keys for.

### 5. Custom Endpoints Not Supported
Users running local models (Ollama, vLLM, etc.) or using unlisted providers have no way to add custom OpenAI-compatible endpoints.

---

## Solution Architecture

### Layered Configuration System

```
┌─────────────────────────────────────────────────────────┐
│           Runtime Config (merged at load)               │
├─────────────────────────────────────────────────────────┤
│  ~/.rex/config.json (user layer)                        │
│  - API keys                                             │
│  - Custom providers/endpoints                           │
│  - User preference overrides                            │
│  - Agent customizations                                 │
├─────────────────────────────────────────────────────────┤
│  <package>/config/defaults.json (shipped with package)  │
│  - Full schema with all sections                        │
│  - Default agent configurations                         │
│  - Provider registry                                    │
│  - Model catalog per provider                           │
│  - Read-only, always up-to-date with package            │
└─────────────────────────────────────────────────────────┘
```

**Merge Strategy:**
- Deep merge with user config taking precedence
- Arrays are replaced, not merged (user can override entire tools list)
- `null` in user config explicitly removes a default value
- Provider API keys from user config overlay defaults

---

## New Config Schema

### defaults.json (shipped with package)

```json
{
  "version": "1.0.0",

  "providers": {
    "anthropic": {
      "displayName": "Anthropic (Claude)",
      "baseUrl": "https://api.anthropic.com",
      "envVar": "ANTHROPIC_API_KEY",
      "models": [
        { "id": "claude-opus-4", "name": "Claude Opus 4", "maxTokens": 200000 },
        { "id": "claude-sonnet-4", "name": "Claude Sonnet 4", "maxTokens": 200000 },
        { "id": "claude-haiku-3.5", "name": "Claude Haiku 3.5", "maxTokens": 200000 }
      ]
    },
    "openai": {
      "displayName": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "envVar": "OPENAI_API_KEY",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "maxTokens": 128000 },
        { "id": "gpt-4o-mini", "name": "GPT-4o Mini", "maxTokens": 128000 },
        { "id": "o1", "name": "o1", "maxTokens": 200000, "reasoning": true },
        { "id": "o1-mini", "name": "o1-mini", "maxTokens": 128000, "reasoning": true }
      ]
    },
    "cerebras": {
      "displayName": "Cerebras",
      "baseUrl": "https://api.cerebras.ai/v1",
      "envVar": "CEREBRAS_API_KEY",
      "interface": "openai-compat",
      "models": [
        { "id": "llama-3.3-70b", "name": "Llama 3.3 70B", "maxTokens": 8192 }
      ]
    },
    "groq": {
      "displayName": "Groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "envVar": "GROQ_API_KEY",
      "interface": "openai-compat",
      "models": [
        { "id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B", "maxTokens": 32768 },
        { "id": "mixtral-8x7b-32768", "name": "Mixtral 8x7B", "maxTokens": 32768 }
      ]
    },
    "together": {
      "displayName": "Together AI",
      "baseUrl": "https://api.together.xyz/v1",
      "envVar": "TOGETHER_API_KEY",
      "interface": "openai-compat",
      "models": [
        { "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo", "name": "Llama 3.3 70B Turbo", "maxTokens": 16384 },
        { "id": "Qwen/QwQ-32B-Preview", "name": "QwQ 32B Preview", "maxTokens": 32768, "reasoning": true }
      ]
    },
    "fireworks": {
      "displayName": "Fireworks AI",
      "baseUrl": "https://api.fireworks.ai/inference/v1",
      "envVar": "FIREWORKS_API_KEY",
      "interface": "openai-compat",
      "models": [
        { "id": "accounts/fireworks/models/llama-v3p3-70b-instruct", "name": "Llama 3.3 70B", "maxTokens": 16384 }
      ]
    },
    "gemini": {
      "displayName": "Google Gemini",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "envVar": "GOOGLE_API_KEY",
      "interface": "openai-compat",
      "models": [
        { "id": "gemini-2.0-flash-exp", "name": "Gemini 2.0 Flash", "maxTokens": 1048576 },
        { "id": "gemini-exp-1206", "name": "Gemini Exp 1206", "maxTokens": 2097152 }
      ]
    }
  },

  "agents": {
    "standard": { /* ... */ },
    "explorer": { /* ... */ },
    "coding-agent": { /* ... */ }
  },

  "tools": {
    "bash_timeout_ms": 30000,
    "max_output_length": 10000
  },

  "graphd": {
    "enabled": true,
    "db_path": "~/.rex/graphd.db"
  },

  "context": {
    "max_tokens": 200000
  }
}
```

### ~/.rex/config.json (user overrides only)

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "cerebras": {
      "apiKey": "csk-..."
    }
  },

  "customProviders": [
    {
      "id": "local-ollama",
      "displayName": "Local Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "interface": "openai-compat",
      "models": [
        { "id": "llama3.2", "name": "Llama 3.2 Local" },
        { "id": "codellama", "name": "Code Llama Local" }
      ]
    }
  ],

  "agents": {
    "standard": {
      "llm": {
        "provider": "cerebras",
        "model": "llama-3.3-70b"
      }
    }
  }
}
```

---

## TUI Flow Changes

### /models View Redesign

**Current behavior:** Shows static list from config
**New behavior:** Shows models from providers that have API keys configured

```
┌─────────────────────────────────────────────────────────┐
│  Select Model                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ANTHROPIC                                              │
│  ○ Claude Opus 4                                        │
│  ○ Claude Sonnet 4                                      │
│  ● Claude Haiku 3.5  ← currently selected               │
│                                                         │
│  CEREBRAS                                               │
│  ○ Llama 3.3 70B                                        │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  + Add Provider                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
│ Type '/providers' to configure model providers          │
└─────────────────────────────────────────────────────────┘
```

**Logic:**
1. Get list of providers with configured API keys (from GraphD/local storage)
2. For each configured provider, show its models (from provider registry)
3. Show "Add Provider" at bottom, routes to `/providers`
4. Mini-banner below input prompts about `/providers`

### /providers View Redesign

**Current behavior:** Shows all providers including "OpenAI Compatible"
**New behavior:** Shows real providers, with option to add custom endpoint

```
┌─────────────────────────────────────────────────────────┐
│  Configure Providers                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ✓ Anthropic (Claude)          configured               │
│  ✓ Cerebras                    configured               │
│  ○ OpenAI                      not configured           │
│  ○ Groq                        not configured           │
│  ○ Together AI                 not configured           │
│  ○ Fireworks AI                not configured           │
│  ○ Google Gemini               not configured           │
│                                                         │
│  CUSTOM ENDPOINTS                                       │
│  ✓ Local Ollama                http://localhost:11434   │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  + Add Custom OpenAI-Compatible Endpoint                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Selecting a provider:** Opens API key input dialog
**Selecting "Add Custom Endpoint":** Opens wizard:

```
┌─────────────────────────────────────────────────────────┐
│  Add Custom OpenAI-Compatible Endpoint                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Provider Name:                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Local Ollama                                    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  API Endpoint:                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │ http://localhost:11434/v1                       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  API Key (optional):                                    │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ●●●●●●●●                                        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Available Models (comma-separated):                    │
│  ┌─────────────────────────────────────────────────┐   │
│  │ llama3.2, codellama, mistral                    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│            [Cancel]  [Test Connection]  [Save]          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Tasks

### Phase 1: Layered Config System
- [ ] Create `config/defaults.json` with full schema and provider/model registry
- [ ] Modify `config_loader.ts` to deep-merge defaults + user config
- [ ] Update launcher to create minimal user config (just empty providers object)
- [ ] Add config version tracking for future migrations
- [ ] Handle migration for existing `~/.rex/config.json` users

### Phase 2: Provider Registry Redesign
- [ ] Move provider definitions from `packages/types/src/providers.ts` to `defaults.json`
- [ ] Add `models` array to each provider definition
- [ ] Remove `openai-compat` as a user-facing provider
- [ ] Keep `openai-compat` as internal interface identifier only

### Phase 3: Custom Provider Support
- [ ] Add `customProviders` array to user config schema
- [ ] Implement persistence in GraphD for custom providers
- [ ] Add validation for custom endpoint URLs
- [ ] Implement connection testing for custom endpoints

### Phase 4: TUI /models Redesign
- [ ] Rewrite models view to group by configured providers
- [ ] Add "Add Provider" option at bottom
- [ ] Implement provider-aware model listing
- [ ] Add mini-banner below input box

### Phase 5: TUI /providers Redesign
- [ ] Remove "OpenAI Compatible" from provider list
- [ ] Add "Custom Endpoints" section showing user-defined providers
- [ ] Add "Add Custom OpenAI-Compatible Endpoint" option
- [ ] Implement custom endpoint wizard (name, URL, key, models)
- [ ] Add "Test Connection" functionality

### Phase 6: Bridge/Daemon Updates
- [ ] Update `handleGetModels` to return provider-grouped models
- [ ] Update `handleGetProviders` to include custom providers
- [ ] Add `providers_add_custom` command handler
- [ ] Add `providers_test_connection` command handler

---

## Data Flow

### Getting Available Models

```
TUI                          Daemon                        GraphD
 │                              │                             │
 │──── get_models ─────────────>│                             │
 │                              │──── get configured ────────>│
 │                              │     providers               │
 │                              │<─── [anthropic, cerebras] ──│
 │                              │                             │
 │                              │ Load defaults.json          │
 │                              │ Filter to configured        │
 │                              │ providers only              │
 │                              │                             │
 │<─── models grouped by ───────│                             │
 │     provider                 │                             │
```

### Adding Custom Provider

```
TUI                          Daemon                        GraphD
 │                              │                             │
 │──── providers_add_custom ───>│                             │
 │     { name, url, key,        │                             │
 │       models }               │                             │
 │                              │──── test connection ───────>│ (external)
 │                              │<─── success ────────────────│
 │                              │                             │
 │                              │──── store custom ──────────>│
 │                              │     provider                │
 │                              │<─── ok ─────────────────────│
 │                              │                             │
 │<─── success ─────────────────│                             │
```

---

## Open Questions

1. **Model discovery for custom endpoints**: Should we try to auto-discover models from `/v1/models` endpoint, or require manual entry?

2. **Provider sync**: If a user removes an API key, should we hide those models immediately or show them grayed out?

3. **Default model selection**: When user selects a model, where is that preference stored? Per-agent or global default?

4. **Model aliases**: Some providers have long model IDs (e.g., `accounts/fireworks/models/llama-v3p3-70b-instruct`). Should we support user-defined aliases?
