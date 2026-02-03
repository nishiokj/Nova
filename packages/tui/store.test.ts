/**
 * Tests for TUI Store model list expansion.
 *
 * Run with: bun test packages/tui/store.test.ts
 */

import { describe, it, expect } from "bun:test";
import { Store } from "./store.js";
import type { ModelEntry } from "./types.js";

describe("Store model expansion", () => {
  it("adds Vercel Gateway variants for supported providers", () => {
    const store = new Store();
    const models: ModelEntry[] = [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet", provider: "anthropic" },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", provider: "gemini" },
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", provider: "cerebras" },
      { id: "local-model", name: "Local", provider: "lmstudio" },
    ];

    store.updateModelsList(models);
    const list = store.getSnapshot().modelsList;

    expect(list.length).toBe(models.length + 4);
    const anthropicGateway = list.find((m) => m.provider === "vercel-gateway" && m.id === "anthropic/claude-sonnet-4.5");
    expect(anthropicGateway).toBeTruthy();
    expect(anthropicGateway?.name).toBe("Claude Sonnet (anthropic)");
    expect(list.find((m) => m.provider === "vercel-gateway" && m.id === "openai/gpt-4o")).toBeTruthy();
    expect(list.find((m) => m.provider === "vercel-gateway" && m.id === "google/gemini-1.5-pro")).toBeTruthy();
    expect(list.find((m) => m.provider === "vercel-gateway" && m.id === "cerebras/llama-3.3-70b")).toBeTruthy();
    expect(list.find((m) => m.provider === "vercel-gateway" && m.id === "lmstudio/local-model")).toBeFalsy();
  });

  it("does not duplicate gateway entries already present", () => {
    const store = new Store();
    const models: ModelEntry[] = [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet", provider: "anthropic" },
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet (gateway)", provider: "vercel-gateway" },
    ];

    store.updateModelsList(models);
    const list = store.getSnapshot().modelsList;
    const matches = list.filter((m) => m.provider === "vercel-gateway" && m.id === "anthropic/claude-sonnet-4.5");

    expect(matches.length).toBe(1);
  });
});
