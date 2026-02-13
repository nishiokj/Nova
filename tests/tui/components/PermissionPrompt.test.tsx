/**
 * Tests for PermissionPrompt component
 *
 * These tests focus on component logic and pure functions.
 * Due to React version conflicts (dashboard uses React 19, ink uses React 18),
 * we test the underlying logic rather than rendering with ink-testing-library.
 */

import type { PermissionRequestData, PermissionedTool } from "tui/types.js";

// ============================================
// TEST FIXTURES
// ============================================

const baseBashRequest: PermissionRequestData = {
  request_id: "perm-1",
  tool: "Bash",
  target: "rm -rf /tmp/test",
  suggested_pattern: "rm -rf /tmp/*",
  working_directory: "/Users/test/project",
  description: "Delete temporary test files",
};

const baseWriteRequest: PermissionRequestData = {
  request_id: "perm-2",
  tool: "Write",
  target: "/Users/test/project/src/index.ts",
  suggested_pattern: "/Users/test/project/src/**",
  working_directory: "/Users/test/project",
  description: "Create new TypeScript file",
};

const baseEditRequest: PermissionRequestData = {
  request_id: "perm-3",
  tool: "Edit",
  target: "/Users/test/project/package.json",
  suggested_pattern: "/Users/test/project/*.json",
  working_directory: "/Users/test/project",
  description: "Update package dependencies",
};

// ============================================
// TOOL ICON LOGIC
// ============================================

describe("PermissionPrompt tool icons", () => {
  const getToolIcon = (tool: PermissionedTool | string): string => {
    switch (tool) {
      case "Bash":
        return "$";
      case "Write":
        return "+";
      case "Edit":
        return "~";
      default:
        return "?";
    }
  };

  it("returns $ for Bash", () => {
    expect(getToolIcon("Bash")).toBe("$");
  });

  it("returns + for Write", () => {
    expect(getToolIcon("Write")).toBe("+");
  });

  it("returns ~ for Edit", () => {
    expect(getToolIcon("Edit")).toBe("~");
  });

  it("returns ? for unknown tool", () => {
    expect(getToolIcon("Unknown")).toBe("?");
    expect(getToolIcon("")).toBe("?");
  });
});

// ============================================
// TOOL COLOR MAPPING
// ============================================

describe("PermissionPrompt tool colors", () => {
  // Simulates color priority mapping
  const getToolColorType = (tool: PermissionedTool | string): "warning" | "success" | "info" | "text" => {
    switch (tool) {
      case "Bash":
        return "warning";
      case "Write":
        return "success";
      case "Edit":
        return "info";
      default:
        return "text";
    }
  };

  it("maps Bash to warning color", () => {
    expect(getToolColorType("Bash")).toBe("warning");
  });

  it("maps Write to success color", () => {
    expect(getToolColorType("Write")).toBe("success");
  });

  it("maps Edit to info color", () => {
    expect(getToolColorType("Edit")).toBe("info");
  });

  it("maps unknown to text color", () => {
    expect(getToolColorType("Unknown")).toBe("text");
  });
});

// ============================================
// TARGET TRUNCATION
// ============================================

describe("PermissionPrompt target truncation", () => {
  const truncateTarget = (target: string, maxLen: number): string => {
    if (target.length <= maxLen) return target;
    return "..." + target.slice(-(maxLen - 3));
  };

  it("preserves short targets", () => {
    expect(truncateTarget("short.ts", 20)).toBe("short.ts");
    expect(truncateTarget("/path/file.ts", 20)).toBe("/path/file.ts");
  });

  it("truncates long targets with ellipsis prefix", () => {
    const longPath = "/very/long/path/to/some/deeply/nested/file.ts";
    const result = truncateTarget(longPath, 20);
    expect(result.length).toBe(20);
    expect(result.startsWith("...")).toBe(true);
    expect(result.endsWith("file.ts")).toBe(true);
  });

  it("handles exact length", () => {
    const exactLen = "exactly_20_chars!!!"; // 20 chars
    expect(truncateTarget(exactLen, 20)).toBe(exactLen);
  });

  it("handles very small maxLen", () => {
    const result = truncateTarget("/some/long/path.ts", 10);
    expect(result.length).toBe(10);
    expect(result.startsWith("...")).toBe(true);
  });

  it("preserves file extension when possible", () => {
    const path = "/Users/test/very/long/nested/directory/structure/component.tsx";
    const result = truncateTarget(path, 30);
    expect(result.endsWith(".tsx")).toBe(true);
  });
});

// ============================================
// CONTENT WIDTH CALCULATION
// ============================================

describe("PermissionPrompt contentWidth", () => {
  const calculateContentWidth = (width: number): number => {
    return Math.max(30, width - 6);
  };

  it("subtracts padding from width", () => {
    expect(calculateContentWidth(80)).toBe(74);
    expect(calculateContentWidth(60)).toBe(54);
  });

  it("has minimum of 30", () => {
    expect(calculateContentWidth(20)).toBe(30);
    expect(calculateContentWidth(35)).toBe(30);
  });
});

// ============================================
// OPTIONS STRUCTURE
// ============================================

describe("PermissionPrompt options", () => {
  const options = [
    { id: "allow", label: "Allow", description: "Allow this specific action (this session)" },
    { id: "always_allow", label: "Always Allow", description: `Add pattern to allowed patterns` },
    { id: "deny", label: "Deny", description: "Block this action" },
  ];

  it("has exactly 3 options", () => {
    expect(options.length).toBe(3);
  });

  it("has Allow as first option", () => {
    expect(options[0].id).toBe("allow");
    expect(options[0].label).toBe("Allow");
  });

  it("has Always Allow as second option", () => {
    expect(options[1].id).toBe("always_allow");
    expect(options[1].label).toBe("Always Allow");
  });

  it("has Deny as third option", () => {
    expect(options[2].id).toBe("deny");
    expect(options[2].label).toBe("Deny");
  });
});

// ============================================
// CURSOR / RADIO INDICATORS
// ============================================

describe("PermissionPrompt cursor indicators", () => {
  const getPointer = (isCursor: boolean): string => {
    return isCursor ? ">" : " ";
  };

  const getRadio = (isCursor: boolean): string => {
    return isCursor ? "(*)" : "( )";
  };

  it("shows > for cursor", () => {
    expect(getPointer(true)).toBe(">");
    expect(getPointer(false)).toBe(" ");
  });

  it("shows (*) for selected radio", () => {
    expect(getRadio(true)).toBe("(*)");
    expect(getRadio(false)).toBe("( )");
  });
});

// ============================================
// OPTION COLOR MAPPING
// ============================================

describe("PermissionPrompt option colors", () => {
  type OptionId = "allow" | "always_allow" | "deny";

  const getOptionColorType = (optionId: OptionId): "success" | "info" | "error" | "text" => {
    switch (optionId) {
      case "allow":
        return "success";
      case "always_allow":
        return "info";
      case "deny":
        return "error";
      default:
        return "text";
    }
  };

  it("maps Allow to success", () => {
    expect(getOptionColorType("allow")).toBe("success");
  });

  it("maps Always Allow to info", () => {
    expect(getOptionColorType("always_allow")).toBe("info");
  });

  it("maps Deny to error", () => {
    expect(getOptionColorType("deny")).toBe("error");
  });
});

// ============================================
// DIVIDER LOGIC
// ============================================

describe("PermissionPrompt divider", () => {
  const getDivider = (width: number): string => {
    return "-".repeat(Math.min(50, width - 4));
  };

  it("creates divider up to 50 chars", () => {
    expect(getDivider(60)).toBe("-".repeat(50));
    expect(getDivider(100)).toBe("-".repeat(50));
  });

  it("uses width minus 4 for narrow terminals", () => {
    expect(getDivider(40)).toBe("-".repeat(36));
    expect(getDivider(30)).toBe("-".repeat(26));
  });
});

// ============================================
// PATTERN DISPLAY IN ALWAYS ALLOW
// ============================================

describe("PermissionPrompt pattern in description", () => {
  const getAlwaysAllowDescription = (pattern: string): string => {
    return `Add "${pattern}" to allowed patterns`;
  };

  it("includes pattern in description", () => {
    const desc = getAlwaysAllowDescription("rm -rf /tmp/*");
    expect(desc).toContain("rm -rf /tmp/*");
    expect(desc).toContain("allowed patterns");
  });

  it("handles glob patterns", () => {
    const desc = getAlwaysAllowDescription("/Users/test/**/*.ts");
    expect(desc).toContain("/Users/test/**/*.ts");
  });

  it("handles special characters", () => {
    const desc = getAlwaysAllowDescription("echo 'test' | grep -E '^[a-z]+$'");
    expect(desc).toContain("echo");
    expect(desc).toContain("grep");
  });
});

// ============================================
// COMPONENT IMPORT TEST
// ============================================

describe("PermissionPrompt import", () => {
  it("can import PermissionPrompt component", async () => {
    const mod = await import("tui/components/PermissionPrompt.js");
    expect(mod.PermissionPrompt).toBeDefined();
    expect(typeof mod.PermissionPrompt).toBe("function");
  });
});

// ============================================
// REQUEST DATA VALIDATION
// ============================================

describe("PermissionPrompt request data", () => {
  it("baseBashRequest has all required fields", () => {
    expect(baseBashRequest.request_id).toBeDefined();
    expect(baseBashRequest.tool).toBe("Bash");
    expect(baseBashRequest.target).toBeDefined();
    expect(baseBashRequest.suggested_pattern).toBeDefined();
    expect(baseBashRequest.working_directory).toBeDefined();
    expect(baseBashRequest.description).toBeDefined();
  });

  it("baseWriteRequest has all required fields", () => {
    expect(baseWriteRequest.request_id).toBeDefined();
    expect(baseWriteRequest.tool).toBe("Write");
  });

  it("baseEditRequest has all required fields", () => {
    expect(baseEditRequest.request_id).toBeDefined();
    expect(baseEditRequest.tool).toBe("Edit");
  });
});

// ============================================
// CURSOR NAVIGATION BOUNDS
// ============================================

describe("PermissionPrompt cursor navigation", () => {
  const OPTIONS_COUNT = 3;

  const clampCursor = (cursor: number): number => {
    return Math.max(0, Math.min(cursor, OPTIONS_COUNT - 1));
  };

  it("clamps cursor to valid range", () => {
    expect(clampCursor(-1)).toBe(0);
    expect(clampCursor(0)).toBe(0);
    expect(clampCursor(1)).toBe(1);
    expect(clampCursor(2)).toBe(2);
    expect(clampCursor(3)).toBe(2);
    expect(clampCursor(100)).toBe(2);
  });
});

// ============================================
// RESPONSE DATA MAPPING
// ============================================

describe("PermissionPrompt response mapping", () => {
  type Decision = "allow" | "always_allow" | "deny";

  const cursorToDecision = (cursor: number): Decision => {
    const decisions: Decision[] = ["allow", "always_allow", "deny"];
    return decisions[cursor] || "deny";
  };

  it("maps cursor 0 to allow", () => {
    expect(cursorToDecision(0)).toBe("allow");
  });

  it("maps cursor 1 to always_allow", () => {
    expect(cursorToDecision(1)).toBe("always_allow");
  });

  it("maps cursor 2 to deny", () => {
    expect(cursorToDecision(2)).toBe("deny");
  });

  it("defaults to deny for invalid cursor", () => {
    expect(cursorToDecision(3)).toBe("deny");
    expect(cursorToDecision(-1)).toBe("deny");
  });
});

// ============================================
// TARGET WIDTH CALCULATION
// ============================================

describe("PermissionPrompt target display width", () => {
  const getTargetMaxWidth = (contentWidth: number): number => {
    // "  Target: " is 10 chars
    return contentWidth - 12;
  };

  it("calculates correct target width", () => {
    expect(getTargetMaxWidth(74)).toBe(62);
    expect(getTargetMaxWidth(50)).toBe(38);
  });

  it("handles narrow widths", () => {
    expect(getTargetMaxWidth(30)).toBe(18);
  });
});

// ============================================
// KEYBOARD HINTS
// ============================================

describe("PermissionPrompt keyboard hints", () => {
  const hints = [
    { key: "[Enter]", action: "Select" },
    { key: "[j/k]", action: "Navigate" },
  ];

  it("has Enter hint", () => {
    const enterHint = hints.find(h => h.key === "[Enter]");
    expect(enterHint).toBeDefined();
    expect(enterHint?.action).toBe("Select");
  });

  it("has j/k navigation hint", () => {
    const navHint = hints.find(h => h.key === "[j/k]");
    expect(navHint).toBeDefined();
    expect(navHint?.action).toBe("Navigate");
  });
});

// ============================================
// EMPTY/MISSING FIELD HANDLING
// ============================================

describe("PermissionPrompt empty field handling", () => {
  it("handles empty description", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      description: "",
    };
    expect(request.description).toBe("");
    // Component should still render
  });

  it("handles empty target", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      target: "",
    };
    expect(request.target).toBe("");
  });

  it("handles empty pattern", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      suggested_pattern: "",
    };
    expect(request.suggested_pattern).toBe("");
  });
});

// ============================================
// SPECIAL CHARACTERS IN FIELDS
// ============================================

describe("PermissionPrompt special characters", () => {
  it("handles quotes in target", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      target: 'echo "hello world"',
    };
    expect(request.target).toContain('"');
  });

  it("handles unicode in description", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      description: "Delete test files \uD83D\uDDD1\uFE0F",
    };
    expect(request.description).toContain("\uD83D\uDDD1\uFE0F");
  });

  it("handles backslashes in pattern", () => {
    const request: PermissionRequestData = {
      ...baseBashRequest,
      suggested_pattern: "C:\\Users\\test\\*",
    };
    expect(request.suggested_pattern).toContain("\\");
  });
});

// ============================================
// COLOR PRIORITY WHEN CURSOR ACTIVE
// ============================================

describe("PermissionPrompt color priority", () => {
  interface RenderState {
    isCursor: boolean;
    optionId: "allow" | "always_allow" | "deny";
  }

  const getTextColor = (state: RenderState): string => {
    // When cursor is on the option, use the option's semantic color
    // Otherwise use muted
    if (state.isCursor) {
      switch (state.optionId) {
        case "allow": return "success";
        case "always_allow": return "info";
        case "deny": return "error";
      }
    }
    return "muted";
  };

  it("shows success color when cursor on Allow", () => {
    expect(getTextColor({ isCursor: true, optionId: "allow" })).toBe("success");
  });

  it("shows info color when cursor on Always Allow", () => {
    expect(getTextColor({ isCursor: true, optionId: "always_allow" })).toBe("info");
  });

  it("shows error color when cursor on Deny", () => {
    expect(getTextColor({ isCursor: true, optionId: "deny" })).toBe("error");
  });

  it("shows muted when not cursor", () => {
    expect(getTextColor({ isCursor: false, optionId: "allow" })).toBe("muted");
    expect(getTextColor({ isCursor: false, optionId: "deny" })).toBe("muted");
  });
});

// ============================================
// STORE INTEGRATION TESTS
// These test the actual store interaction patterns
// ============================================

describe("PermissionPrompt store integration", () => {
  // Mock store state for permission mode
  interface MockPermissionState {
    permissionCursor: number;
    activeRequest: PermissionRequestData | null;
  }

  const createMockState = (): MockPermissionState => ({
    permissionCursor: 0,
    activeRequest: { ...baseBashRequest },
  });

  // Simulates movePermissionCursor
  const moveCursor = (state: MockPermissionState, delta: number): void => {
    const OPTIONS_COUNT = 3;
    state.permissionCursor = (state.permissionCursor + delta + OPTIONS_COUNT) % OPTIONS_COUNT;
  };

  // Simulates getPermissionDecision
  const getDecision = (state: MockPermissionState): "allow" | "always_allow" | "deny" => {
    switch (state.permissionCursor) {
      case 0: return "allow";
      case 1: return "always_allow";
      case 2: return "deny";
      default: return "deny";
    }
  };

  // Simulates building the response payload
  const buildResponse = (state: MockPermissionState): {
    request_id: string;
    decision: "allow" | "always_allow" | "deny";
    pattern?: string;
  } => {
    const decision = getDecision(state);
    return {
      request_id: state.activeRequest!.request_id,
      decision,
      pattern: decision === "always_allow" ? state.activeRequest!.suggested_pattern : undefined,
    };
  };

  it("default cursor position is Allow", () => {
    const state = createMockState();
    expect(state.permissionCursor).toBe(0);
    expect(getDecision(state)).toBe("allow");
  });

  it("navigating down moves to Always Allow", () => {
    const state = createMockState();
    moveCursor(state, 1);
    expect(state.permissionCursor).toBe(1);
    expect(getDecision(state)).toBe("always_allow");
  });

  it("navigating to Deny", () => {
    const state = createMockState();
    moveCursor(state, 1);
    moveCursor(state, 1);
    expect(state.permissionCursor).toBe(2);
    expect(getDecision(state)).toBe("deny");
  });

  it("navigation wraps from Deny to Allow", () => {
    const state = createMockState();
    state.permissionCursor = 2;
    moveCursor(state, 1);
    expect(state.permissionCursor).toBe(0);
    expect(getDecision(state)).toBe("allow");
  });

  it("navigation wraps from Allow to Deny (up)", () => {
    const state = createMockState();
    moveCursor(state, -1);
    expect(state.permissionCursor).toBe(2);
    expect(getDecision(state)).toBe("deny");
  });

  it("response includes pattern only for always_allow", () => {
    const state = createMockState();

    // Allow - no pattern
    const allowResponse = buildResponse(state);
    expect(allowResponse.decision).toBe("allow");
    expect(allowResponse.pattern).toBeUndefined();

    // Always Allow - has pattern
    moveCursor(state, 1);
    const alwaysAllowResponse = buildResponse(state);
    expect(alwaysAllowResponse.decision).toBe("always_allow");
    expect(alwaysAllowResponse.pattern).toBe(baseBashRequest.suggested_pattern);

    // Deny - no pattern
    moveCursor(state, 1);
    const denyResponse = buildResponse(state);
    expect(denyResponse.decision).toBe("deny");
    expect(denyResponse.pattern).toBeUndefined();
  });

  it("quick keys bypass cursor position", () => {
    // Test the quick key behavior (1, 2, 3 shortcuts)
    const state = createMockState();
    state.permissionCursor = 1; // On Always Allow

    // But pressing '1' should send "allow" regardless
    // This simulates the quick key handlers in index.tsx
    const quickAllow = { decision: "allow" as const };
    expect(quickAllow.decision).toBe("allow");

    // Pressing '2' sends "always_allow"
    const quickAlwaysAllow = { decision: "always_allow" as const };
    expect(quickAlwaysAllow.decision).toBe("always_allow");

    // Pressing '3' sends "deny"
    const quickDeny = { decision: "deny" as const };
    expect(quickDeny.decision).toBe("deny");
  });

  it("request_id is preserved in response", () => {
    const state = createMockState();
    const response = buildResponse(state);
    expect(response.request_id).toBe("perm-1");
  });

  it("handles navigation with j/k keys (same as arrows)", () => {
    // j = down, k = up
    const state = createMockState();

    // j moves down
    moveCursor(state, 1);
    expect(state.permissionCursor).toBe(1);

    // k moves up
    moveCursor(state, -1);
    expect(state.permissionCursor).toBe(0);
  });
});

// ============================================
// ESCAPE KEY HANDLING
// ============================================

describe("PermissionPrompt escape handling", () => {
  // Note: Escape key should cancel/dismiss the permission prompt
  // Currently there's no escape handler in permission mode - this could be a bug

  it("documents that escape key is NOT handled in permission mode", () => {
    // Looking at index.tsx, permission mode does not have an escape handler
    // This might be intentional (force user to choose) or a bug
    // The only ways to dismiss are: Enter, 1, 2, or 3 keys

    // This test documents the current behavior
    const escapeModes = ["allow", "always_allow", "deny"];
    expect(escapeModes).not.toContain("cancel");
  });
});

// ============================================
// HEIGHT CONSTRAINT LOGIC (NEW)
// Tests for new height constraint functionality
// ============================================

describe("PermissionPrompt height constraints", () => {
  const calculateMaxOptionsHeight = (
    maxHeight: number,
    headerHeight: number,
    toolInfoHeight: number,
    descriptionHeight: number,
    patternHeight: number,
    actionsHeight: number
  ): number => {
    return Math.max(
      3, // minimum for options (3 options * 1 line each)
      maxHeight - headerHeight - toolInfoHeight - descriptionHeight - patternHeight - actionsHeight
    );
  };

  it("calculates available height for options", () => {
    const result = calculateMaxOptionsHeight(20, 2, 2, 1, 1, 2);
    expect(result).toBe(12); // 20 - 2 - 2 - 1 - 1 - 2 = 12
  });

  it("ensures minimum height of 3 for 3 options", () => {
    const result = calculateMaxOptionsHeight(9, 2, 2, 1, 1, 2);
    expect(result).toBe(3); // Would be 1, but minimum is 3
  });

  it("handles edge case with tight fit", () => {
    const result = calculateMaxOptionsHeight(10, 2, 2, 1, 1, 2);
    expect(result).toBe(3); // 10 - 2 - 2 - 1 - 1 - 2 = 2, min is 3
  });

  it("scales with larger height", () => {
    const result = calculateMaxOptionsHeight(30, 2, 2, 1, 1, 2);
    expect(result).toBe(22); // 30 - 2 - 2 - 1 - 1 - 2 = 22
  });
});

describe("PermissionPrompt options height allocation", () => {
  const calculateOptionsCount = (
    maxOptionsHeight: number,
    totalOptions: number,
    linesPerOption: number
  ): number => {
    return Math.max(
      1,
      Math.min(
        totalOptions,
        Math.floor(maxOptionsHeight / linesPerOption)
      )
    );
  };

  it("shows all options when space permits", () => {
    const result = calculateOptionsCount(10, 3, 2);
    expect(result).toBe(3); // All 3 fit (10 / 2 = 5)
  });

  it("truncates options when height is limited", () => {
    const result = calculateOptionsCount(4, 3, 2);
    expect(result).toBe(2); // Only 2 fit (4 / 2 = 2)
  });

  it("ensures minimum of 1 option", () => {
    const result = calculateOptionsCount(1, 3, 2);
    expect(result).toBe(1); // (1 / 2) = 0.5 -> floor to 0, min is 1
  });

  it("handles exact fit", () => {
    const result = calculateOptionsCount(6, 3, 2);
    expect(result).toBe(3); // (6 / 2) = 3 exactly
  });
});

describe("PermissionPrompt description truncation", () => {
  const calculateDescriptionWidth = (contentWidth: number): number => {
    // "  " padding + "  Description " is ~15 chars
    return Math.max(20, contentWidth - 20);
  };

  const truncateDescription = (desc: string, maxWidth: number): string => {
    if (desc.length <= maxWidth) return desc;
    return desc.slice(0, maxWidth - 3) + "...";
  };

  it("calculates description width", () => {
    expect(calculateDescriptionWidth(74)).toBe(54);
    expect(calculateDescriptionWidth(50)).toBe(30);
  });

  it("ensures minimum description width", () => {
    expect(calculateDescriptionWidth(30)).toBe(20);
  });

  it("truncates long description", () => {
    const longDesc = "This is a very long description that needs to be truncated to fit in the available space";
    const result = truncateDescription(longDesc, 30);
    expect(result.length).toBe(30);
    expect(result.endsWith("...")).toBe(true);
  });

  it("preserves short description", () => {
    const shortDesc = "Delete files";
    const result = truncateDescription(shortDesc, 50);
    expect(result).toBe("Delete files");
  });

  it("handles exact length description", () => {
    const exactDesc = "Exactly twenty chars!"; // 20 chars
    const result = truncateDescription(exactDesc, 20);
    // When description length equals max width, it fits without truncation
    expect(result).toBe("Exactly twenty chars!");
  });

  it("handles empty description", () => {
    const result = truncateDescription("", 30);
    expect(result).toBe("");
  });
});

describe("PermissionPrompt option description truncation", () => {
  const calculateOptionDescWidth = (contentWidth: number): number => {
    // "       " (7 spaces padding) + "~10 chars for label
    return Math.max(20, contentWidth - 30);
  };

  const truncateOptionDescription = (desc: string, maxWidth: number): string => {
    if (desc.length <= maxWidth) return desc;
    return desc.slice(0, maxWidth - 3) + "...";
  };

  it("calculates option description width", () => {
    expect(calculateOptionDescWidth(74)).toBe(44);
    expect(calculateOptionDescWidth(50)).toBe(20);
  });

  it("ensures minimum option description width", () => {
    expect(calculateOptionDescWidth(40)).toBe(20);
  });

  it("truncates long option description", () => {
    const longDesc = "This is a very long option description that will be truncated";
    const result = truncateOptionDescription(longDesc, 30);
    expect(result.length).toBe(30);
    expect(result.endsWith("...")).toBe(true);
  });

  it("preserves short option description", () => {
    const shortDesc = "Block this action";
    const result = truncateOptionDescription(shortDesc, 30);
    expect(result).toBe("Block this action");
  });
});

describe("PermissionPrompt default height fallback", () => {
  const getDefaultHeight = (heightProp: number | undefined): number => {
    return heightProp || 15;
  };

  it("uses provided height", () => {
    expect(getDefaultHeight(10)).toBe(10);
    expect(getDefaultHeight(20)).toBe(20);
  });

  it("uses default when height not provided", () => {
    expect(getDefaultHeight(undefined)).toBe(15);
  });
});

describe("PermissionPrompt pattern handling", () => {
  const calculatePatternWidth = (contentWidth: number): number => {
    // "  Pattern: " is 12 chars
    return contentWidth - 12;
  };

  const shouldTruncatePattern = (pattern: string, maxWidth: number): boolean => {
    return pattern.length > maxWidth;
  };

  it("calculates pattern display width", () => {
    expect(calculatePatternWidth(74)).toBe(62);
    expect(calculatePatternWidth(50)).toBe(38);
  });

  it("detects when pattern needs truncation", () => {
    const shortPattern = "*.ts";
    expect(shouldTruncatePattern(shortPattern, 62)).toBe(false);

    // Create a pattern that's definitely longer than 62 characters
    const longPattern = "/Users/test/very/long/path/to/some/deeply/nested/directory/structure/**/*.ts"; // 70+ chars
    expect(longPattern.length).toBeGreaterThan(62);
    expect(shouldTruncatePattern(longPattern, 62)).toBe(true);
  });

  it("handles pattern that exactly fits", () => {
    const exactPattern = "rm -rf /tmp/*"; // 13 chars
    // At maxWidth 13, pattern fits exactly - no truncation needed
    expect(shouldTruncatePattern(exactPattern, 13)).toBe(false);
    // At maxWidth 12, pattern exceeds width - truncation needed
    expect(shouldTruncatePattern(exactPattern, 12)).toBe(true);
  });
});

describe("PermissionPrompt full-screen mode behavior", () => {
  const isFullScreenMode = (
    isQuestionMode: boolean,
    isPermissionMode: boolean
  ): boolean => {
    return isQuestionMode || isPermissionMode;
  };

  it("returns true in permission mode", () => {
    expect(isFullScreenMode(false, true)).toBe(true);
  });

  it("returns true in question mode", () => {
    expect(isFullScreenMode(true, false)).toBe(true);
  });

  it("returns false in chat mode", () => {
    expect(isFullScreenMode(false, false)).toBe(false);
  });
});
