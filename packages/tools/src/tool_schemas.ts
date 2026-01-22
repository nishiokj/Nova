/**
 * Zod schemas for tool argument validation.
 *
 * These schemas validate arguments before tool execution,
 * catching invalid inputs from LLM responses early.
 */

import { z } from 'zod';

// ============================================
// BASH TOOL
// ============================================

/**
 * Arguments for bash tool execution.
 */
export const BashArgsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  timeout: z.number().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

// ============================================
// READ TOOL
// ============================================

/**
 * Arguments for read tool execution.
 */
export const ReadArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  file_path: z.string().optional(), // Alias for path
  encoding: z.string().optional(),
  maxBytes: z.number().positive().int().optional(),
  offset: z.number().nonnegative().int().optional(),
  limit: z.number().positive().int().optional(),
});

// ============================================
// WRITE TOOL
// ============================================

/**
 * Arguments for write tool execution.
 */
export const WriteArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  file_path: z.string().optional(), // Alias for path
  content: z.string(),
  encoding: z.string().optional(),
  mode: z.number().int().optional(),
});

// ============================================
// EDIT TOOL
// ============================================

/**
 * Arguments for edit tool execution.
 * Accepts both camelCase and snake_case for compatibility.
 */
export const EditArgsSchema = z.object({
  path: z.string().optional(),
  file_path: z.string().optional(),
  // Accept both naming conventions
  old_string: z.string().optional(),
  oldString: z.string().optional(),
  new_string: z.string().optional(),
  newString: z.string().optional(),
  replace_all: z.boolean().optional(),
  replaceAll: z.boolean().optional(),
}).refine(
  (data) => data.path || data.file_path,
  { message: 'Either path or file_path is required' }
).refine(
  (data) => data.old_string || data.oldString,
  { message: 'Either old_string or oldString is required' }
).refine(
  (data) => data.new_string !== undefined || data.newString !== undefined,
  { message: 'Either new_string or newString is required' }
);

// ============================================
// GLOB TOOL
// ============================================

/**
 * Arguments for glob tool execution.
 */
export const GlobArgsSchema = z.object({
  pattern: z.string().min(1, 'Pattern cannot be empty'),
  path: z.string().optional(), // Subdirectory to search within
  ignore: z.array(z.string()).optional(),
  maxResults: z.number().positive().int().optional(),
});

// ============================================
// GREP TOOL
// ============================================

/**
 * Arguments for grep tool execution.
 */
export const GrepArgsSchema = z.object({
  pattern: z.string().min(1, 'Pattern cannot be empty'),
  path: z.string().optional(), // Subdirectory to search within
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-A': z.number().nonnegative().int().optional(),
  '-B': z.number().nonnegative().int().optional(),
  '-C': z.number().nonnegative().int().optional(),
  '-i': z.boolean().optional(),
  '-n': z.boolean().optional(),
  head_limit: z.number().nonnegative().int().optional(),
  offset: z.number().nonnegative().int().optional(),
  multiline: z.boolean().optional(),
  maxResults: z.number().positive().int().optional(),
  caseInsensitive: z.boolean().optional(),
});

// ============================================
// SKILL TOOL
// ============================================

/**
 * Arguments for skill tool execution.
 */
export const SkillArgsSchema = z.object({
  skill: z.string().min(1, 'Skill name cannot be empty'),
  args: z.string().optional(),
});

// ============================================
// PROMPT USER TOOL
// ============================================

/**
 * Option schema for user prompts.
 */
const PromptUserOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    description: z.string().optional(),
  }),
]);

/**
 * Question schema for sequential prompts.
 */
const PromptUserQuestionSchema = z.object({
  question: z.string().min(1, 'Question cannot be empty'),
  options: z.array(PromptUserOptionSchema).optional(),
  context: z.string().optional(),
  multiSelect: z.boolean().optional(),
  questionType: z.enum(['multiple_choice', 'multi_select', 'fill_in_blank', 'yes_no', 'free_text']).optional(),
});

/**
 * Arguments for PromptUser tool execution.
 */
export const PromptUserArgsSchema = z.object({
  question: z.string().min(1, 'Question cannot be empty'),
  options: z.array(PromptUserOptionSchema).optional(),
  context: z.string().optional(),
  multiSelect: z.boolean().optional(),
  questionType: z.enum(['multiple_choice', 'multi_select', 'fill_in_blank', 'yes_no', 'free_text']).optional(),
  questions: z.array(PromptUserQuestionSchema).optional(),
});

// ============================================
// SCHEMA REGISTRY
// ============================================

/**
 * Registry of tool argument schemas.
 */
export const TOOL_SCHEMAS: Record<string, z.ZodType> = {
  Bash: BashArgsSchema,
  Read: ReadArgsSchema,
  Write: WriteArgsSchema,
  Edit: EditArgsSchema,
  Glob: GlobArgsSchema,
  Grep: GrepArgsSchema,
  Skill: SkillArgsSchema,
  PromptUser: PromptUserArgsSchema,
};

// ============================================
// INFERRED TYPES
// ============================================

export type BashArgs = z.infer<typeof BashArgsSchema>;
export type ReadArgs = z.infer<typeof ReadArgsSchema>;
export type WriteArgs = z.infer<typeof WriteArgsSchema>;
export type EditArgs = z.infer<typeof EditArgsSchema>;
export type GlobArgs = z.infer<typeof GlobArgsSchema>;
export type GrepArgs = z.infer<typeof GrepArgsSchema>;
export type SkillArgs = z.infer<typeof SkillArgsSchema>;
export type PromptUserArgs = z.infer<typeof PromptUserArgsSchema>;

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate tool arguments against a schema.
 * Returns validated args or null on failure.
 */
export function validateToolArgs<T>(
  toolName: string,
  args: Record<string, unknown>
): { success: true; data: T } | { success: false; error: string } {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    // No schema defined - pass through
    return { success: true, data: args as T };
  }

  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { success: false, error: `Invalid arguments for ${toolName}: ${issues}` };
  }

  return { success: true, data: result.data as T };
}

/**
 * Get the schema for a tool by name.
 */
export function getToolSchema(toolName: string): z.ZodType | undefined {
  return TOOL_SCHEMAS[toolName];
}
