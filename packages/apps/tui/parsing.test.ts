/**
 * Tests for TUI parsing and validation logic
 *
 * These tests cover the parsing of incoming events from the harness:
 * - User prompt validation and parsing
 * - Question type inference
 * - Option parsing (string and object formats)
 * - Permission request validation
 *
 * Run with: bun test packages/apps/tui/parsing.test.ts
 */

import { describe, it, expect } from "bun:test";
import type {
  UserPromptData,
  UserPromptQuestion,
  PermissionRequestData,
} from "./types.js";

type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "fill_in_blank"
  | "yes_no"
  | "free_text"
  | "plan_mode_exit"
  | "spec_review";

interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

interface AgentQuestion {
  requestId: string;
  type: QuestionType;
  question: string;
  context?: string;
  options?: QuestionOption[];
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

// ============================================
// VALIDATION LOGIC (extracted from index.tsx)
// ============================================

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates incoming user prompt data structure.
 * Extracted from index.tsx for testing.
 */
const validateUserPromptData = (data?: unknown): ValidationResult => {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Data is missing or not an object" };
  }

  const payload = data as Record<string, unknown>;

  // Validate required request_id field
  if (!payload.request_id || typeof payload.request_id !== "string") {
    return { valid: false, error: "Missing or invalid request_id (must be a string)" };
  }

  // Validate that either question (single) or questions (array) is present
  const hasSingleQuestion = "question" in payload && typeof payload.question === "string";
  const hasMultipleQuestions = "questions" in payload && Array.isArray(payload.questions);

  if (!hasSingleQuestion && !hasMultipleQuestions) {
    return { valid: false, error: "Missing question or questions array" };
  }

  // Validate questions array is not empty
  if (hasMultipleQuestions && (payload.questions as unknown[]).length === 0) {
    return { valid: false, error: "questions array must not be empty" };
  }

  // Validate questions array elements have required fields
  if (hasMultipleQuestions) {
    for (let i = 0; i < (payload.questions as unknown[]).length; i++) {
      const q = (payload.questions as unknown[])[i];
      if (!q || typeof q !== "object") {
        return { valid: false, error: `questions[${i}] is not an object` };
      }
      const questionObj = q as Record<string, unknown>;
      if (!questionObj.question || typeof questionObj.question !== "string") {
        return { valid: false, error: `questions[${i}] missing or invalid question field` };
      }
    }
  }

  return { valid: true };
};

// ============================================
// VALIDATION TESTS
// ============================================

describe("validateUserPromptData", () => {
  describe("basic validation", () => {
    it("rejects undefined data", () => {
      const result = validateUserPromptData(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("missing");
    });

    it("rejects null data", () => {
      const result = validateUserPromptData(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("missing");
    });

    it("rejects non-object data", () => {
      expect(validateUserPromptData("string").valid).toBe(false);
      expect(validateUserPromptData(123).valid).toBe(false);
      expect(validateUserPromptData([]).valid).toBe(false);
    });

    it("rejects empty object", () => {
      const result = validateUserPromptData({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain("request_id");
    });
  });

  describe("request_id validation", () => {
    it("rejects missing request_id", () => {
      const result = validateUserPromptData({ question: "test?" });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("request_id");
    });

    it("rejects non-string request_id", () => {
      expect(validateUserPromptData({ request_id: 123, question: "test?" }).valid).toBe(false);
      expect(validateUserPromptData({ request_id: null, question: "test?" }).valid).toBe(false);
      expect(validateUserPromptData({ request_id: {}, question: "test?" }).valid).toBe(false);
    });

    it("accepts valid string request_id", () => {
      const result = validateUserPromptData({ request_id: "req-1", question: "test?" });
      expect(result.valid).toBe(true);
    });
  });

  describe("single question validation", () => {
    it("accepts valid single question", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        question: "What is your name?",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-string question", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        question: 123,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("question");
    });

    it("accepts question with empty string (validation passes)", () => {
      // Empty string is technically a string, so validation passes.
      // The `typeof payload.question === 'string'` check returns true for "".
      // Semantic validation (meaningful question text) is left to the component.
      const result = validateUserPromptData({
        request_id: "req-1",
        question: "",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("multiple questions validation", () => {
    it("accepts valid questions array", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [
          { question: "First question?" },
          { question: "Second question?" },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty questions array", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("rejects questions array with non-object element", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: ["not an object"],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("questions[0]");
    });

    it("rejects questions array with missing question field", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [{ options: ["a", "b"] }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("questions[0]");
      expect(result.error).toContain("question field");
    });

    it("rejects questions array with invalid question type", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [{ question: 123 }],
      });
      expect(result.valid).toBe(false);
    });

    it("validates all questions in array", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [
          { question: "Valid first" },
          { notQuestion: "Invalid second" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("questions[1]");
    });
  });

  describe("edge cases", () => {
    it("accepts both question and questions (single takes precedence)", () => {
      // When both are present, validation passes - handler decides precedence
      const result = validateUserPromptData({
        request_id: "req-1",
        question: "Single question",
        questions: [{ question: "Array question" }],
      });
      expect(result.valid).toBe(true);
    });

    it("handles null elements in questions array", () => {
      const result = validateUserPromptData({
        request_id: "req-1",
        questions: [null, { question: "Valid" }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("questions[0]");
    });
  });
});

// ============================================
// QUESTION TYPE INFERENCE (extracted from index.tsx)
// ============================================

type OptionInput = string | { label: string; description?: string };

const inferQuestionType = (
  opts?: OptionInput[],
  multiSelect?: boolean,
  questionType?: string
): QuestionType => {
  if (questionType === "plan_mode_exit") return "plan_mode_exit";
  if (questionType === "spec_review") return "spec_review";
  if (!opts || opts.length === 0) return "free_text";
  if (multiSelect) return "multi_select";
  const labels = opts.map((opt) =>
    (typeof opt === "string" ? opt : opt.label).toLowerCase()
  );
  if (labels.length === 2 && labels.every((l) => ["yes", "no", "y", "n"].includes(l))) {
    return "yes_no";
  }
  return "multiple_choice";
};

describe("inferQuestionType", () => {
  describe("explicit question types", () => {
    it("returns plan_mode_exit when specified", () => {
      expect(inferQuestionType(["a", "b"], false, "plan_mode_exit")).toBe("plan_mode_exit");
    });

    it("returns spec_review when specified", () => {
      expect(inferQuestionType(["a", "b"], false, "spec_review")).toBe("spec_review");
    });

    it("explicit type overrides option inference", () => {
      // Even with yes/no options, explicit type wins
      expect(inferQuestionType(["Yes", "No"], false, "plan_mode_exit")).toBe("plan_mode_exit");
    });
  });

  describe("free_text inference", () => {
    it("returns free_text for no options", () => {
      expect(inferQuestionType(undefined)).toBe("free_text");
      expect(inferQuestionType([])).toBe("free_text");
    });

    it("returns free_text for empty array", () => {
      expect(inferQuestionType([], false)).toBe("free_text");
    });
  });

  describe("multi_select inference", () => {
    it("returns multi_select when flag is true", () => {
      expect(inferQuestionType(["a", "b", "c"], true)).toBe("multi_select");
    });

    it("multi_select flag overrides yes/no detection", () => {
      expect(inferQuestionType(["Yes", "No"], true)).toBe("multi_select");
    });
  });

  describe("yes_no inference", () => {
    it("detects Yes/No options", () => {
      expect(inferQuestionType(["Yes", "No"])).toBe("yes_no");
    });

    it("detects yes/no lowercase", () => {
      expect(inferQuestionType(["yes", "no"])).toBe("yes_no");
    });

    it("detects Y/N options", () => {
      expect(inferQuestionType(["Y", "N"])).toBe("yes_no");
    });

    it("detects mixed case yes/no", () => {
      expect(inferQuestionType(["YES", "NO"])).toBe("yes_no");
    });

    it("detects object options with yes/no labels", () => {
      expect(
        inferQuestionType([
          { label: "Yes", description: "Confirm" },
          { label: "No", description: "Cancel" },
        ])
      ).toBe("yes_no");
    });

    it("requires exactly 2 options for yes_no", () => {
      expect(inferQuestionType(["Yes", "No", "Maybe"])).toBe("multiple_choice");
      expect(inferQuestionType(["Yes"])).toBe("multiple_choice");
    });

    it("both options must be yes/no variants", () => {
      expect(inferQuestionType(["Yes", "Cancel"])).toBe("multiple_choice");
      expect(inferQuestionType(["Ok", "No"])).toBe("multiple_choice");
    });
  });

  describe("multiple_choice inference", () => {
    it("defaults to multiple_choice for other options", () => {
      expect(inferQuestionType(["Option A", "Option B"])).toBe("multiple_choice");
      expect(inferQuestionType(["a", "b", "c"])).toBe("multiple_choice");
    });

    it("returns multiple_choice for object options", () => {
      expect(
        inferQuestionType([
          { label: "First", description: "The first option" },
          { label: "Second", description: "The second option" },
        ])
      ).toBe("multiple_choice");
    });
  });
});

// ============================================
// OPTION PARSING (extracted from index.tsx)
// ============================================

const parseOptions = (rawOptions: OptionInput[] | undefined): QuestionOption[] => {
  if (!rawOptions) return [];

  return rawOptions
    .map((opt): QuestionOption | null => {
      if (!opt) return null;

      let label: string;
      let description: string | undefined;

      if (typeof opt === "string") {
        label = opt;
      } else if (typeof opt === "object" && opt.label) {
        label = opt.label;
        description = opt.description;
      } else {
        return null;
      }

      return {
        id: label,
        label,
        description,
      };
    })
    .filter((opt): opt is QuestionOption => opt !== null);
};

describe("parseOptions", () => {
  describe("string options", () => {
    it("parses string array", () => {
      const result = parseOptions(["a", "b", "c"]);
      expect(result).toEqual([
        { id: "a", label: "a", description: undefined },
        { id: "b", label: "b", description: undefined },
        { id: "c", label: "c", description: undefined },
      ]);
    });

    it("uses label as id", () => {
      const result = parseOptions(["Option One"]);
      expect(result[0].id).toBe("Option One");
      expect(result[0].label).toBe("Option One");
    });
  });

  describe("object options", () => {
    it("parses object with label and description", () => {
      const result = parseOptions([
        { label: "First", description: "Description of first" },
      ]);
      expect(result).toEqual([
        { id: "First", label: "First", description: "Description of first" },
      ]);
    });

    it("parses object with only label", () => {
      const result = parseOptions([{ label: "Only Label" }]);
      expect(result).toEqual([
        { id: "Only Label", label: "Only Label", description: undefined },
      ]);
    });

    it("handles mixed string and object options", () => {
      const result = parseOptions([
        "String Option",
        { label: "Object Option", description: "Has description" },
      ]);
      expect(result.length).toBe(2);
      expect(result[0].label).toBe("String Option");
      expect(result[1].label).toBe("Object Option");
      expect(result[1].description).toBe("Has description");
    });
  });

  describe("error handling", () => {
    it("handles undefined input", () => {
      expect(parseOptions(undefined)).toEqual([]);
    });

    it("handles empty array", () => {
      expect(parseOptions([])).toEqual([]);
    });

    it("filters out null elements", () => {
      const result = parseOptions(["valid", null as any, "also valid"]);
      expect(result.length).toBe(2);
      expect(result[0].label).toBe("valid");
      expect(result[1].label).toBe("also valid");
    });

    it("filters out object without label", () => {
      const result = parseOptions([
        { label: "Valid" },
        { description: "No label" } as any,
        { label: "Also Valid" },
      ]);
      expect(result.length).toBe(2);
    });

    it("filters out empty objects", () => {
      const result = parseOptions([{} as any, { label: "Valid" }]);
      expect(result.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("preserves special characters in labels", () => {
      const result = parseOptions(["Option (recommended)", "Option <beta>"]);
      expect(result[0].label).toBe("Option (recommended)");
      expect(result[1].label).toBe("Option <beta>");
    });

    it("filters out empty string label (falsy check)", () => {
      // Empty string "" is falsy, so `if (!opt) return null` filters it out.
      // This is defensive behavior - empty labels aren't useful.
      const result = parseOptions([""]);
      expect(result.length).toBe(0);
    });

    it("handles whitespace-only label", () => {
      const result = parseOptions(["   "]);
      expect(result.length).toBe(1);
      expect(result[0].label).toBe("   ");
    });

    it("handles unicode in labels", () => {
      const result = parseOptions(["Option 🎉", "选项二"]);
      expect(result[0].label).toBe("Option 🎉");
      expect(result[1].label).toBe("选项二");
    });
  });
});

// ============================================
// AGENT QUESTION CONSTRUCTION
// ============================================

const toAgentQuestion = (
  q: UserPromptQuestion,
  requestId: string,
  index: number
): AgentQuestion => {
  const questionText = q.question || "Question text missing";
  const rawOptions = q.options || [];
  const processedOptions = parseOptions(rawOptions);

  const qAny = q as unknown as Record<string, unknown>;
  const multiSelect = q.multi_select ?? (qAny.multiSelect as boolean | undefined);
  const questionType = q.question_type ?? (qAny.questionType as string | undefined);

  return {
    requestId: `${requestId}_q${index}`,
    type: inferQuestionType(rawOptions, multiSelect, questionType),
    question: questionText,
    context: q.context,
    options: processedOptions,
  };
};

describe("toAgentQuestion", () => {
  it("constructs question with indexed requestId", () => {
    const result = toAgentQuestion({ question: "Test?" }, "req-123", 0);
    expect(result.requestId).toBe("req-123_q0");
  });

  it("increments index in requestId", () => {
    const q1 = toAgentQuestion({ question: "First?" }, "req-1", 0);
    const q2 = toAgentQuestion({ question: "Second?" }, "req-1", 1);
    expect(q1.requestId).toBe("req-1_q0");
    expect(q2.requestId).toBe("req-1_q1");
  });

  it("includes context when provided", () => {
    const result = toAgentQuestion(
      { question: "Test?", context: "Some context" },
      "req-1",
      0
    );
    expect(result.context).toBe("Some context");
  });

  it("handles missing context", () => {
    const result = toAgentQuestion({ question: "Test?" }, "req-1", 0);
    expect(result.context).toBeUndefined();
  });

  it("parses options", () => {
    const result = toAgentQuestion(
      {
        question: "Choose:",
        options: ["A", "B"],
      },
      "req-1",
      0
    );
    expect(result.options?.length).toBe(2);
    expect(result.type).toBe("multiple_choice");
  });

  it("supports snake_case multi_select", () => {
    const result = toAgentQuestion(
      {
        question: "Select:",
        options: ["A", "B"],
        multi_select: true,
      },
      "req-1",
      0
    );
    expect(result.type).toBe("multi_select");
  });

  it("supports camelCase multiSelect (legacy)", () => {
    const result = toAgentQuestion(
      {
        question: "Select:",
        options: ["A", "B"],
        multiSelect: true,
      } as any,
      "req-1",
      0
    );
    expect(result.type).toBe("multi_select");
  });

  it("supports snake_case question_type", () => {
    const result = toAgentQuestion(
      {
        question: "Exit plan?",
        options: ["Yes", "No"],
        question_type: "plan_mode_exit",
      },
      "req-1",
      0
    );
    expect(result.type).toBe("plan_mode_exit");
  });

  it("supports camelCase questionType (legacy)", () => {
    const result = toAgentQuestion(
      {
        question: "Exit plan?",
        options: ["Yes", "No"],
        questionType: "plan_mode_exit",
      } as any,
      "req-1",
      0
    );
    expect(result.type).toBe("plan_mode_exit");
  });

  it("provides fallback for missing or empty question text", () => {
    // Empty string triggers fallback because `'' || 'fallback'` evaluates to 'fallback'
    const result = toAgentQuestion({ question: "" }, "req-1", 0);
    expect(result.question).toBe("Question text missing");

    const result2 = toAgentQuestion({} as any, "req-1", 0);
    expect(result2.question).toBe("Question text missing");

    // But a question with content is preserved
    const result3 = toAgentQuestion({ question: "Real question?" }, "req-1", 0);
    expect(result3.question).toBe("Real question?");
  });
});

// ============================================
// PERMISSION REQUEST VALIDATION
// ============================================

const validatePermissionRequest = (data?: unknown): ValidationResult => {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Data is missing or not an object" };
  }

  const payload = data as Record<string, unknown>;

  if (!payload.request_id || typeof payload.request_id !== "string") {
    return { valid: false, error: "Missing or invalid request_id" };
  }

  if (!payload.tool || !["Bash", "Write", "Edit"].includes(payload.tool as string)) {
    return { valid: false, error: "Missing or invalid tool (must be Bash, Write, or Edit)" };
  }

  if (typeof payload.target !== "string") {
    return { valid: false, error: "Missing or invalid target" };
  }

  if (typeof payload.suggested_pattern !== "string") {
    return { valid: false, error: "Missing or invalid suggested_pattern" };
  }

  return { valid: true };
};

describe("validatePermissionRequest", () => {
  const validRequest: PermissionRequestData = {
    request_id: "perm-1",
    tool: "Bash",
    target: "rm -rf /tmp/test",
    suggested_pattern: "rm -rf /tmp/*",
    working_directory: "/home/user",
    description: "Delete test files",
  };

  it("accepts valid permission request", () => {
    const result = validatePermissionRequest(validRequest);
    expect(result.valid).toBe(true);
  });

  it("rejects missing data", () => {
    expect(validatePermissionRequest(undefined).valid).toBe(false);
    expect(validatePermissionRequest(null).valid).toBe(false);
  });

  it("rejects missing request_id", () => {
    const { request_id, ...rest } = validRequest;
    expect(validatePermissionRequest(rest).valid).toBe(false);
  });

  it("rejects invalid tool", () => {
    expect(validatePermissionRequest({ ...validRequest, tool: "Invalid" }).valid).toBe(false);
    expect(validatePermissionRequest({ ...validRequest, tool: "" }).valid).toBe(false);
    expect(validatePermissionRequest({ ...validRequest, tool: null }).valid).toBe(false);
  });

  it("accepts all valid tool types", () => {
    expect(validatePermissionRequest({ ...validRequest, tool: "Bash" }).valid).toBe(true);
    expect(validatePermissionRequest({ ...validRequest, tool: "Write" }).valid).toBe(true);
    expect(validatePermissionRequest({ ...validRequest, tool: "Edit" }).valid).toBe(true);
  });

  it("rejects missing target", () => {
    const { target, ...rest } = validRequest;
    expect(validatePermissionRequest(rest).valid).toBe(false);
  });

  it("rejects missing suggested_pattern", () => {
    const { suggested_pattern, ...rest } = validRequest;
    expect(validatePermissionRequest(rest).valid).toBe(false);
  });

  it("allows missing optional fields", () => {
    const minimal = {
      request_id: "perm-1",
      tool: "Bash",
      target: "ls",
      suggested_pattern: "*",
    };
    expect(validatePermissionRequest(minimal).valid).toBe(true);
  });
});

// ============================================
// FULL FLOW INTEGRATION TESTS
// ============================================

describe("User prompt parsing integration", () => {
  it("parses complete single question flow", () => {
    const data: UserPromptData = {
      request_id: "req-123",
      question: "Which option do you prefer?",
      options: [
        { label: "Option A", description: "First option" },
        { label: "Option B", description: "Second option" },
      ],
      context: "Please choose carefully",
    };

    // Validate
    expect(validateUserPromptData(data).valid).toBe(true);

    // Parse options
    const options = parseOptions(data.options);
    expect(options.length).toBe(2);

    // Infer type
    const type = inferQuestionType(data.options, data.multi_select, data.question_type);
    expect(type).toBe("multiple_choice");
  });

  it("parses complete multi-question flow", () => {
    const data = {
      request_id: "req-456",
      questions: [
        { question: "What is your name?", context: "For identification" },
        {
          question: "Select your skills:",
          options: ["JavaScript", "Python", "Rust"],
          multi_select: true,
        },
        {
          question: "Continue?",
          options: ["Yes", "No"],
        },
      ],
    };

    // Validate
    expect(validateUserPromptData(data).valid).toBe(true);

    // Parse each question
    const questions = data.questions.map((q, i) =>
      toAgentQuestion(q as UserPromptQuestion, data.request_id, i)
    );

    expect(questions.length).toBe(3);
    expect(questions[0].type).toBe("free_text");
    expect(questions[1].type).toBe("multi_select");
    expect(questions[2].type).toBe("yes_no");
  });

  it("handles malformed data gracefully", () => {
    // Validation catches issues
    expect(validateUserPromptData({ request_id: 123 }).valid).toBe(false);
    expect(validateUserPromptData({ question: null }).valid).toBe(false);

    // Option parsing filters bad data
    const badOptions = parseOptions([null, undefined, {}, "valid"] as any[]);
    expect(badOptions.length).toBe(1);
    expect(badOptions[0].label).toBe("valid");
  });
});
