/**
 * UI-Specific Types
 *
 * Application state, rendering, and user interaction.
 * No wire protocol types here.
 */

// ===========================================================================
// CORE UI STATE
// ===========================================================================

export type Role = "user" | "agent" | "system" | "status";

export type UIMode =
  | "chat"
  | "skills"
  | "hooks"
  | "wizard"
  | "question"
  | "providers"
  | "theme";

export type WizardType = "skill" | "hook";

export interface MessageEntry {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
  pending?: boolean;
  meta?: string;
  requestId?: string;
}

// ===========================================================================
// QUESTION FLOW
// ===========================================================================

export type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "fill_in_blank"
  | "yes_no"
  | "free_text"
  | "plan_mode_exit";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  requestId: string;
  type: QuestionType;
  question: string;
  context?: string;
  options?: QuestionOption[];
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

// ===========================================================================
// RENDERING
// ===========================================================================

export type BoxStyle = "rounded" | "sharp" | "double" | "minimal";

export const BOX_CHARS = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  sharp: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  minimal: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: "│" },
} as const;

export interface MessageBoxConfig {
  style: BoxStyle;
  alignment: "left" | "right";
  maxWidth: number;
  padding: number;
  showTimestamp?: boolean;
}