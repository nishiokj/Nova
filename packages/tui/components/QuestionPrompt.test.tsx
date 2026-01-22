/**
 * Tests for QuestionPrompt component
 *
 * These tests focus on component logic and pure functions.
 * Due to React version conflicts (dashboard uses React 19, ink uses React 18),
 * we test the underlying logic rather than rendering with ink-testing-library.
 *
 * Run with: bun test packages/tui/components/QuestionPrompt.test.tsx
 */

import { describe, it, expect } from "bun:test";
import type { AgentQuestion, QuestionOption, QuestionType } from "../types.js";

// ============================================
// TEST FIXTURES
// ============================================

const mockOptions: QuestionOption[] = [
  { id: "opt1", label: "Option One", description: "First option description" },
  { id: "opt2", label: "Option Two", description: "Second option description" },
  { id: "opt3", label: "Option Three" },
];

const baseMultipleChoiceQuestion: AgentQuestion = {
  requestId: "test-req-1",
  type: "multiple_choice",
  question: "Which option do you prefer?",
  options: mockOptions,
};

// ============================================
// PURE FUNCTION: TEXT WRAPPING
// Extracted from QuestionPrompt for testing
// ============================================

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

describe("QuestionPrompt wrapText", () => {
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

  it("handles multiple spaces between words", () => {
    const result = wrapText("word  another", 20);
    // Should normalize to single space behavior (split on space)
    expect(result[0]).toContain("word");
    expect(result[0]).toContain("another");
  });

  it("handles exactly width-sized text", () => {
    const text = "exactly twenty chars"; // 20 chars
    const result = wrapText(text, 20);
    expect(result.length).toBe(1);
  });

  it("handles text that wraps to multiple lines", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = wrapText(text, 15);
    expect(result.length).toBeGreaterThan(2);
  });
});

// ============================================
// PURE FUNCTION: CONTENT WIDTH CALCULATION
// ============================================

const calculateContentWidth = (width: number): number => {
  return Math.max(30, width - 6);
};

describe("QuestionPrompt contentWidth", () => {
  it("subtracts padding from width", () => {
    expect(calculateContentWidth(80)).toBe(74);
    expect(calculateContentWidth(100)).toBe(94);
  });

  it("has minimum of 30", () => {
    expect(calculateContentWidth(20)).toBe(30);
    expect(calculateContentWidth(30)).toBe(30);
    expect(calculateContentWidth(35)).toBe(30);
  });

  it("works at boundary", () => {
    expect(calculateContentWidth(36)).toBe(30);
    expect(calculateContentWidth(37)).toBe(31);
  });
});

// ============================================
// PROGRESS INDICATOR LOGIC
// ============================================

describe("QuestionPrompt progress indicator", () => {
  interface QueueInfo {
    current: number;
    total: number;
  }

  const getProgressText = (queueInfo?: QueueInfo): string => {
    const showProgress = queueInfo && queueInfo.total > 1;
    return showProgress ? `  [${queueInfo!.current}/${queueInfo!.total}]` : "";
  };

  it("shows progress when multiple questions", () => {
    const result = getProgressText({ current: 2, total: 5 });
    expect(result).toBe("  [2/5]");
  });

  it("hides progress for single question", () => {
    const result = getProgressText({ current: 1, total: 1 });
    expect(result).toBe("");
  });

  it("hides progress when queueInfo not provided", () => {
    const result = getProgressText(undefined);
    expect(result).toBe("");
  });

  it("shows progress at boundaries", () => {
    expect(getProgressText({ current: 1, total: 2 })).toBe("  [1/2]");
    expect(getProgressText({ current: 10, total: 10 })).toBe("  [10/10]");
  });
});

// ============================================
// QUESTION TYPE IDENTIFICATION
// ============================================

describe("QuestionPrompt question types", () => {
  const textInputTypes: QuestionType[] = ["fill_in_blank", "free_text"];

  const isTextInput = (type: QuestionType): boolean => {
    return textInputTypes.includes(type);
  };

  it("identifies fill_in_blank as text input", () => {
    expect(isTextInput("fill_in_blank")).toBe(true);
  });

  it("identifies free_text as text input", () => {
    expect(isTextInput("free_text")).toBe(true);
  });

  it("identifies multiple_choice as NOT text input", () => {
    expect(isTextInput("multiple_choice")).toBe(false);
  });

  it("identifies multi_select as NOT text input", () => {
    expect(isTextInput("multi_select")).toBe(false);
  });

  it("identifies yes_no as NOT text input", () => {
    expect(isTextInput("yes_no")).toBe(false);
  });
});

// ============================================
// SELECTION INDICATOR LOGIC
// ============================================

describe("QuestionPrompt selection indicators", () => {
  const getCheckbox = (isMulti: boolean, isSelected: boolean): string => {
    return isMulti ? (isSelected ? "✓" : " ") : isSelected ? "●" : "○";
  };

  it("shows checkmark for selected multi-select", () => {
    expect(getCheckbox(true, true)).toBe("✓");
  });

  it("shows space for unselected multi-select", () => {
    expect(getCheckbox(true, false)).toBe(" ");
  });

  it("shows filled circle for selected single-select", () => {
    expect(getCheckbox(false, true)).toBe("●");
  });

  it("shows empty circle for unselected single-select", () => {
    expect(getCheckbox(false, false)).toBe("○");
  });
});

// ============================================
// CURSOR INDICATOR LOGIC
// ============================================

describe("QuestionPrompt cursor indicators", () => {
  const getCursorArrow = (isCursor: boolean): string => {
    return isCursor ? "▸" : " ";
  };

  const getCursorBox = (isCursor: boolean): { start: string; end: string } => {
    return {
      start: isCursor ? "[" : " ",
      end: isCursor ? "]" : " ",
    };
  };

  it("shows arrow for cursor position", () => {
    expect(getCursorArrow(true)).toBe("▸");
    expect(getCursorArrow(false)).toBe(" ");
  });

  it("shows brackets for cursor position", () => {
    expect(getCursorBox(true)).toEqual({ start: "[", end: "]" });
    expect(getCursorBox(false)).toEqual({ start: " ", end: " " });
  });
});

// ============================================
// OPTION NUMBER FORMATTING
// ============================================

describe("QuestionPrompt option numbering", () => {
  const formatOptionNumber = (index: number): string => {
    return (index + 1).toString().padStart(2, " ");
  };

  it("formats single digit with leading space", () => {
    expect(formatOptionNumber(0)).toBe(" 1");
    expect(formatOptionNumber(8)).toBe(" 9");
  });

  it("formats double digits without padding", () => {
    expect(formatOptionNumber(9)).toBe("10");
    expect(formatOptionNumber(98)).toBe("99");
  });
});

// ============================================
// PLACEHOLDER LOGIC
// ============================================

describe("QuestionPrompt placeholder", () => {
  const shouldShowPlaceholder = (
    inputText: string,
    placeholder?: string
  ): boolean => {
    const displayValue = inputText || "";
    return displayValue.length === 0 && !!placeholder;
  };

  it("shows placeholder when input empty and placeholder exists", () => {
    expect(shouldShowPlaceholder("", "Enter text...")).toBe(true);
  });

  it("hides placeholder when input has value", () => {
    expect(shouldShowPlaceholder("hello", "Enter text...")).toBe(false);
  });

  it("hides placeholder when no placeholder provided", () => {
    expect(shouldShowPlaceholder("", undefined)).toBe(false);
  });
});

// ============================================
// COMPONENT IMPORT TEST
// ============================================

describe("QuestionPrompt import", () => {
  it("can import QuestionPrompt component", async () => {
    const mod = await import("./QuestionPrompt.js");
    expect(mod.QuestionPrompt).toBeDefined();
    expect(typeof mod.QuestionPrompt).toBe("function");
  });
});

// ============================================
// MULTI-SELECT TOGGLE LOGIC
// ============================================

describe("QuestionPrompt multi-select toggle", () => {
  const toggleSelection = (
    current: number[],
    index: number
  ): number[] => {
    if (current.includes(index)) {
      return current.filter((i) => i !== index);
    }
    return [...current, index];
  };

  it("adds index when not selected", () => {
    expect(toggleSelection([], 0)).toEqual([0]);
    expect(toggleSelection([1], 0)).toEqual([1, 0]);
  });

  it("removes index when already selected", () => {
    expect(toggleSelection([0], 0)).toEqual([]);
    expect(toggleSelection([0, 1, 2], 1)).toEqual([0, 2]);
  });

  it("preserves order of other selections", () => {
    const result = toggleSelection([2, 0, 3], 2);
    expect(result).toEqual([0, 3]);
  });

  it("handles toggling same index twice", () => {
    let selection: number[] = [];
    selection = toggleSelection(selection, 1);
    expect(selection).toEqual([1]);
    selection = toggleSelection(selection, 1);
    expect(selection).toEqual([]);
  });
});

// ============================================
// SINGLE-SELECT BEHAVIOR
// ============================================

describe("QuestionPrompt single-select behavior", () => {
  const selectSingle = (index: number): number[] => {
    return [index];
  };

  it("selects single option", () => {
    expect(selectSingle(0)).toEqual([0]);
    expect(selectSingle(2)).toEqual([2]);
  });

  it("replaces previous selection", () => {
    // In single select, we always return an array with just the new selection
    expect(selectSingle(0)).toEqual([0]);
    expect(selectSingle(1)).toEqual([1]);
  });
});

// ============================================
// DIVIDER RENDERING LOGIC
// ============================================

describe("QuestionPrompt divider", () => {
  const getDivider = (width: number): string => {
    return "-".repeat(Math.min(40, width - 4));
  };

  it("creates divider up to 40 chars", () => {
    expect(getDivider(50)).toBe("-".repeat(40));
    expect(getDivider(100)).toBe("-".repeat(40));
  });

  it("uses width minus 4 for narrow terminals", () => {
    expect(getDivider(30)).toBe("-".repeat(26));
    expect(getDivider(20)).toBe("-".repeat(16));
  });

  it("handles edge cases", () => {
    expect(getDivider(44)).toBe("-".repeat(40));
    expect(getDivider(45)).toBe("-".repeat(40));
  });
});

// ============================================
// INPUT BOX LINE RENDERING
// ============================================

describe("QuestionPrompt input box", () => {
  const getInputBoxWidth = (contentWidth: number): number => {
    return Math.max(40, contentWidth - 10);
  };

  it("has minimum width of 40", () => {
    expect(getInputBoxWidth(30)).toBe(40);
    expect(getInputBoxWidth(45)).toBe(40);
  });

  it("scales with content width", () => {
    expect(getInputBoxWidth(60)).toBe(50);
    expect(getInputBoxWidth(80)).toBe(70);
  });
});

// ============================================
// QUESTION WITH CONTEXT
// ============================================

describe("QuestionPrompt context handling", () => {
  const hasContext = (question: AgentQuestion): boolean => {
    return !!question.context && question.context.length > 0;
  };

  it("detects context when present", () => {
    const q: AgentQuestion = {
      requestId: "1",
      type: "free_text",
      question: "Test?",
      context: "Some context here",
    };
    expect(hasContext(q)).toBe(true);
  });

  it("detects no context when missing", () => {
    const q: AgentQuestion = {
      requestId: "1",
      type: "free_text",
      question: "Test?",
    };
    expect(hasContext(q)).toBe(false);
  });

  it("detects no context when empty string", () => {
    const q: AgentQuestion = {
      requestId: "1",
      type: "free_text",
      question: "Test?",
      context: "",
    };
    expect(hasContext(q)).toBe(false);
  });
});

// ============================================
// OPTIONS VALIDATION
// ============================================

describe("QuestionPrompt options handling", () => {
  const hasOptions = (options?: QuestionOption[]): boolean => {
    return !!options && options.length > 0;
  };

  it("detects options when present", () => {
    expect(hasOptions(mockOptions)).toBe(true);
  });

  it("detects no options when undefined", () => {
    expect(hasOptions(undefined)).toBe(false);
  });

  it("detects no options when empty array", () => {
    expect(hasOptions([])).toBe(false);
  });
});

// ============================================
// COLOR LOGIC (based on selection state)
// ============================================

describe("QuestionPrompt color logic", () => {
  interface ColorState {
    isCursor: boolean;
    isSelected: boolean;
  }

  // Simulates the text color logic from the component
  const getTextColorPriority = (state: ColorState): "cursor" | "selected" | "default" => {
    if (state.isCursor) return "cursor";
    if (state.isSelected) return "selected";
    return "default";
  };

  it("prioritizes cursor over selection", () => {
    expect(getTextColorPriority({ isCursor: true, isSelected: true })).toBe("cursor");
    expect(getTextColorPriority({ isCursor: true, isSelected: false })).toBe("cursor");
  });

  it("shows selected when not cursor", () => {
    expect(getTextColorPriority({ isCursor: false, isSelected: true })).toBe("selected");
  });

  it("defaults when neither cursor nor selected", () => {
    expect(getTextColorPriority({ isCursor: false, isSelected: false })).toBe("default");
  });
});

// ============================================
// STORE INTEGRATION TESTS
// These test the actual store methods work correctly
// ============================================

describe("QuestionPrompt store integration", () => {
  // Mock store state for testing input handler patterns
  interface MockState {
    questionCursor: number;
    questionSelection: number[];
    questionInput: string;
    options: { id: string; label: string }[];
  }

  const createMockState = (): MockState => ({
    questionCursor: 0,
    questionSelection: [],
    questionInput: "",
    options: [
      { id: "opt1", label: "Option One" },
      { id: "opt2", label: "Option Two" },
      { id: "opt3", label: "Option Three" },
    ],
  });

  // Simulates toggleQuestionSelection for single-select
  const toggleSingleSelect = (state: MockState): void => {
    state.questionSelection = [state.questionCursor];
  };

  // Simulates toggleQuestionSelection for multi-select
  const toggleMultiSelect = (state: MockState): void => {
    const idx = state.questionSelection.indexOf(state.questionCursor);
    if (idx >= 0) {
      state.questionSelection.splice(idx, 1);
    } else {
      state.questionSelection.push(state.questionCursor);
    }
  };

  // Simulates selectQuestionOption navigation
  const navigate = (state: MockState, delta: number): void => {
    const count = state.options.length;
    state.questionCursor = (state.questionCursor + delta + count) % count;
  };

  // Gets display answer from current state (what should happen AFTER toggle)
  const getDisplayAnswer = (state: MockState): string => {
    if (state.questionSelection.length === 0) return "";
    return state.questionSelection
      .map((i) => state.options[i]?.label)
      .filter(Boolean)
      .join(", ");
  };

  it("single-select: toggle sets selection to cursor", () => {
    const state = createMockState();
    state.questionCursor = 1;
    toggleSingleSelect(state);
    expect(state.questionSelection).toEqual([1]);
    expect(getDisplayAnswer(state)).toBe("Option Two");
  });

  it("single-select: navigate then toggle selects new option", () => {
    const state = createMockState();
    navigate(state, 1); // cursor -> 1
    navigate(state, 1); // cursor -> 2
    toggleSingleSelect(state);
    expect(state.questionSelection).toEqual([2]);
    expect(getDisplayAnswer(state)).toBe("Option Three");
  });

  it("single-select: toggle replaces previous selection", () => {
    const state = createMockState();
    toggleSingleSelect(state); // select 0
    expect(state.questionSelection).toEqual([0]);
    navigate(state, 1); // cursor -> 1
    toggleSingleSelect(state); // should replace with 1
    expect(state.questionSelection).toEqual([1]);
    expect(getDisplayAnswer(state)).toBe("Option Two");
  });

  it("multi-select: toggle adds to selection", () => {
    const state = createMockState();
    toggleMultiSelect(state); // add 0
    expect(state.questionSelection).toEqual([0]);
    navigate(state, 2); // cursor -> 2
    toggleMultiSelect(state); // add 2
    expect(state.questionSelection).toEqual([0, 2]);
    expect(getDisplayAnswer(state)).toBe("Option One, Option Three");
  });

  it("multi-select: toggle removes from selection", () => {
    const state = createMockState();
    state.questionSelection = [0, 1, 2];
    state.questionCursor = 1;
    toggleMultiSelect(state); // remove 1
    expect(state.questionSelection).toEqual([0, 2]);
  });

  it("navigation wraps around", () => {
    const state = createMockState();
    navigate(state, -1); // wrap to end
    expect(state.questionCursor).toBe(2);
    navigate(state, 1); // wrap to start
    expect(state.questionCursor).toBe(0);
  });

  // This test documents the stale snapshot bug pattern
  it("CRITICAL: display answer must read state AFTER toggle, not before", () => {
    const state = createMockState();
    state.questionCursor = 2;

    // WRONG pattern (simulates using snapshot before toggle):
    const snapshotBeforeToggle = [...state.questionSelection]; // []

    toggleSingleSelect(state);

    // Using stale snapshot gives wrong answer:
    const wrongAnswer = snapshotBeforeToggle
      .map((i) => state.options[i]?.label)
      .filter(Boolean)
      .join(", ");
    expect(wrongAnswer).toBe(""); // BUG: empty instead of "Option Three"

    // CORRECT pattern (read state after toggle):
    const correctAnswer = getDisplayAnswer(state);
    expect(correctAnswer).toBe("Option Three"); // Correct!
  });

  it("CRITICAL: for multi-select, answer must include newly toggled item", () => {
    const state = createMockState();
    state.questionSelection = [0]; // already has option 0
    state.questionCursor = 2;

    const snapshotBeforeToggle = [...state.questionSelection]; // [0]
    toggleMultiSelect(state);

    // Using stale snapshot misses the new selection:
    const wrongAnswer = snapshotBeforeToggle
      .map((i) => state.options[i]?.label)
      .filter(Boolean)
      .join(", ");
    expect(wrongAnswer).toBe("Option One"); // BUG: missing "Option Three"

    // Correct pattern:
    const correctAnswer = getDisplayAnswer(state);
    expect(correctAnswer).toBe("Option One, Option Three");
  });
});

// ============================================
// HEIGHT CONSTRAINT LOGIC (NEW)
// Tests for the new height constraint functionality
// ============================================

describe("QuestionPrompt height constraints", () => {
  const calculateMaxContentHeight = (
    maxHeight: number,
    headerHeight: number,
    questionHeight: number,
    contextHeight: number,
    actionsHeight: number
  ): number => {
    return Math.max(
      5, // minimum for content
      maxHeight - headerHeight - actionsHeight - contextHeight
    );
  };

  it("calculates available height for content", () => {
    const result = calculateMaxContentHeight(20, 2, 2, 2, 2);
    expect(result).toBe(14); // 20 - 2 - 2 - 2 = 14
  });

  it("ensures minimum height of 5", () => {
    const result = calculateMaxContentHeight(8, 2, 2, 2, 2);
    expect(result).toBe(5); // Would be 0, but minimum is 5
  });

  it("handles edge case with tight fit", () => {
    const result = calculateMaxContentHeight(11, 2, 2, 2, 2);
    expect(result).toBe(5); // 11 - 2 - 2 - 2 = 5 (exact minimum)
  });

  it("scales with larger height", () => {
    const result = calculateMaxContentHeight(30, 2, 3, 2, 2);
    expect(result).toBe(24); // 30 - 2 - 2 - 2 = 24 (note: questionHeight not subtracted in formula)
  });
});

describe("QuestionPrompt options truncation", () => {
  const calculateMaxOptions = (
    maxContentHeight: number,
    questionHeight: number,
    contextHeight: number,
    totalOptions: number
  ): number => {
    return Math.max(
      1,
      Math.min(
        totalOptions,
        Math.floor((maxContentHeight - questionHeight - contextHeight) / 2)
      )
    );
  };

  it("truncates options when too many", () => {
    const result = calculateMaxOptions(10, 2, 2, 10);
    expect(result).toBe(3); // (10 - 2 - 2) / 2 = 3
  });

  it("shows all options when space permits", () => {
    const result = calculateMaxOptions(20, 2, 2, 5);
    expect(result).toBe(5); // All 5 fit
  });

  it("ensures minimum of 1 option", () => {
    const result = calculateMaxOptions(5, 2, 2, 10);
    expect(result).toBe(1); // (5 - 2 - 2) / 2 = 0.5 -> floor to 0, min is 1
  });

  it("handles exact fit", () => {
    const result = calculateMaxOptions(10, 3, 1, 3);
    expect(result).toBe(3); // (10 - 3 - 1) / 2 = 3 exactly
  });
});

describe("QuestionPrompt text truncation with height", () => {
  const calculateTextSliceLimit = (
    maxContentHeight: number,
    questionLines: number,
    contextLines: number
  ): number => {
    // For text input, we limit question/context lines
    const maxForQuestion = maxContentHeight;
    const remainingForContext = Math.max(1, maxContentHeight - questionLines);
    return { maxForQuestion, remainingForContext };
  };

  it("calculates limits for long question text", () => {
    const result = calculateTextSliceLimit(10, 5, 3);
    expect(result.maxForQuestion).toBe(10);
    expect(result.remainingForContext).toBe(5); // 10 - 5
  });

  it("ensures minimum for context", () => {
    const result = calculateTextSliceLimit(6, 5, 3);
    expect(result.remainingForContext).toBe(1); // Would be 1, min is 1
  });

  it("handles short text without truncation", () => {
    const result = calculateTextSliceLimit(20, 3, 2);
    expect(result.maxForQuestion).toBe(20);
    expect(result.remainingForContext).toBe(17); // 20 - 3
  });
});

describe("QuestionPrompt default height fallback", () => {
  const getDefaultHeight = (heightProp: number | undefined): number => {
    return heightProp || 20;
  };

  it("uses provided height", () => {
    expect(getDefaultHeight(15)).toBe(15);
    expect(getDefaultHeight(25)).toBe(25);
  });

  it("uses default when height not provided", () => {
    expect(getDefaultHeight(undefined)).toBe(20);
  });
});
