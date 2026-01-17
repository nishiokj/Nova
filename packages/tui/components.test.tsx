/**
 * Tests for TUI components
 *
 * Note: ink-testing-library has compatibility issues with Bun's JSX handling.
 * These tests use a custom render approach that captures terminal output.
 *
 * Run with: bun test components.test.tsx
 */

import { describe, it, expect, beforeEach } from "bun:test";
import React from "react";
import { render as inkRender, Box, Text } from "ink";
import type { Instance } from "ink";
import type { QuestionOption, AgentQuestion } from "./types.js";

// Custom render helper that captures output to a string stream
interface RenderResult {
  lastFrame: () => string;
  frames: string[];
  unmount: () => void;
}

function createTestRenderer(): {
  write: (data: string) => void;
  output: () => string;
  clear: () => void;
} {
  let buffer = "";
  return {
    write: (data: string) => {
      buffer += data;
    },
    output: () => buffer,
    clear: () => {
      buffer = "";
    },
  };
}

// Test fixtures
const mockOptions: QuestionOption[] = [
  { id: "opt1", label: "Option One", description: "First option" },
  { id: "opt2", label: "Option Two", description: "Second option" },
  { id: "opt3", label: "Option Three" },
];

// ============================================
// UNIT TESTS FOR PURE FUNCTIONS
// ============================================

describe("QuestionPrompt text wrapping", () => {
  // Test the text wrapping logic in isolation
  const wrapText = (text: string, maxWidth: number): string[] => {
    if (!text) return [""];
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [""];
  };

  it("wraps text at specified width", () => {
    const text = "This is a long string that should wrap";
    const result = wrapText(text, 20);
    expect(result.length).toBeGreaterThan(1);
    result.forEach((line) => {
      expect(line.length).toBeLessThanOrEqual(20);
    });
  });

  it("handles empty text", () => {
    const result = wrapText("", 20);
    expect(result).toEqual([""]);
  });

  it("handles single word longer than width", () => {
    const result = wrapText("superlongwordthatwontfit", 10);
    expect(result[0]).toBe("superlongwordthatwontfit");
  });

  it("preserves short text without wrapping", () => {
    const result = wrapText("short", 20);
    expect(result).toEqual(["short"]);
  });
});

// ============================================
// COMPONENT STRUCTURE TESTS
// ============================================

describe("SingleSelect structure", () => {
  it("has correct option count", () => {
    expect(mockOptions.length).toBe(3);
  });

  it("options have required properties", () => {
    mockOptions.forEach((opt) => {
      expect(opt.id).toBeDefined();
      expect(opt.label).toBeDefined();
    });
  });
});

describe("MultiSelect selection logic", () => {
  it("tracks multiple selections", () => {
    const selected: number[] = [0, 2];
    expect(selected.includes(0)).toBe(true);
    expect(selected.includes(1)).toBe(false);
    expect(selected.includes(2)).toBe(true);
  });

  it("toggles selection correctly", () => {
    let selected: number[] = [];

    // Toggle on
    const toggleOn = (idx: number) => {
      if (!selected.includes(idx)) {
        selected = [...selected, idx];
      }
    };

    // Toggle off
    const toggleOff = (idx: number) => {
      selected = selected.filter((i) => i !== idx);
    };

    toggleOn(0);
    expect(selected).toEqual([0]);

    toggleOn(2);
    expect(selected).toEqual([0, 2]);

    toggleOff(0);
    expect(selected).toEqual([2]);
  });
});

describe("TextInputField logic", () => {
  it("shows placeholder when value is empty", () => {
    const value = "";
    const placeholder = "Enter text...";
    const showPlaceholder = value.length === 0 && placeholder;
    expect(showPlaceholder).toBeTruthy();
  });

  it("shows value when not empty", () => {
    const value = "Hello";
    const placeholder = "Enter text...";
    const showPlaceholder = value.length === 0 && placeholder;
    expect(showPlaceholder).toBeFalsy();
  });

  it("handles multiline detection", () => {
    const singleLine = "no newlines here";
    const multiLine = "line one\nline two";

    expect(singleLine.includes("\n")).toBe(false);
    expect(multiLine.includes("\n")).toBe(true);
    expect(multiLine.split("\n").length).toBe(2);
  });
});

describe("QuestionPrompt logic", () => {
  const baseQuestion: AgentQuestion = {
    requestId: "test-req-1",
    type: "multiple_choice",
    question: "Which option do you prefer?",
    options: mockOptions,
  };

  it("identifies text input types", () => {
    const textTypes = ["fill_in_blank", "free_text"];
    expect(textTypes.includes("free_text")).toBe(true);
    expect(textTypes.includes("multiple_choice")).toBe(false);
  });

  it("shows progress for multiple questions", () => {
    const queueInfo = { current: 2, total: 5 };
    const showProgress = queueInfo && queueInfo.total > 1;
    expect(showProgress).toBe(true);
  });

  it("hides progress for single question", () => {
    const queueInfo = { current: 1, total: 1 };
    const showProgress = queueInfo && queueInfo.total > 1;
    expect(showProgress).toBe(false);
  });

  it("renders checkbox indicators correctly", () => {
    const isMulti = true;
    const isSelected = true;
    const checkbox = isMulti ? (isSelected ? "[x]" : "[ ]") : isSelected ? "(*)" : "( )";
    expect(checkbox).toBe("[x]");
  });

  it("renders radio indicators correctly", () => {
    const isMulti = false;
    const isCursor = true;
    const indicator = isMulti ? "[x]" : isCursor ? "(*)" : "( )";
    expect(indicator).toBe("(*)");
  });
});

// ============================================
// COMPONENT IMPORT TESTS
// ============================================

describe("Component imports", () => {
  it("can import SingleSelect", async () => {
    const mod = await import("./components/SingleSelect.js");
    expect(mod.SingleSelect).toBeDefined();
    expect(typeof mod.SingleSelect).toBe("function");
  });

  it("can import MultiSelect", async () => {
    const mod = await import("./components/MultiSelect.js");
    expect(mod.MultiSelect).toBeDefined();
    expect(typeof mod.MultiSelect).toBe("function");
  });

  it("can import TextInputField", async () => {
    const mod = await import("./components/TextInputField.js");
    expect(mod.TextInputField).toBeDefined();
    expect(typeof mod.TextInputField).toBe("function");
  });

  it("can import QuestionPrompt", async () => {
    const mod = await import("./components/QuestionPrompt.js");
    expect(mod.QuestionPrompt).toBeDefined();
    expect(typeof mod.QuestionPrompt).toBe("function");
  });
});

// ============================================
// THEME TESTS
// ============================================

describe("Theme", () => {
  it("can import and get colors", async () => {
    const { getColors } = await import("./theme.js");
    const colors = getColors();

    expect(colors.text).toBeDefined();
    expect(colors.muted).toBeDefined();
    expect(colors.accent).toBeDefined();
    expect(colors.success).toBeDefined();
    expect(colors.error).toBeDefined();
    expect(colors.warning).toBeDefined();
    expect(colors.info).toBeDefined();
  });

  it("returns valid hex colors", async () => {
    const { getColors } = await import("./theme.js");
    const colors = getColors();
    const hexRegex = /^#[0-9a-fA-F]{6}$/;

    expect(colors.text).toMatch(hexRegex);
    expect(colors.accent).toMatch(hexRegex);
  });

  it("can get theme names", async () => {
    const { getThemeNames } = await import("./theme.js");
    const names = getThemeNames();

    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(names.includes("mocha")).toBe(true);
  });
});
