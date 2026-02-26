/**
 * Tool Skins — Per-provider tool name/schema translations.
 *
 * Maps Nova tool definitions (Bash, Read, Grep, Glob) to Codex-native
 * definitions (shell_command, read_file, grep_files, list_dir) that
 * OpenAI models were trained on.
 */

import type { ToolDefinition } from 'types';

// ============================================
// NAME MAPS
// ============================================

/** Codex tool name → Nova tool name */
export const CODEX_TO_NOVA: Record<string, string> = {
  shell_command: 'Bash',
  read_file: 'Read',
  grep_files: 'Grep',
  list_dir: 'Glob',
};

/** Nova tool name → Codex tool name */
export const NOVA_TO_CODEX: Record<string, string> = {
  Bash: 'shell_command',
  Read: 'read_file',
  Grep: 'grep_files',
  Glob: 'list_dir',
};

/** Nova tools to filter out when using OpenAI (replaced by apply_patch) */
export const FILTERED_NOVA_TOOLS = new Set(['Edit', 'Write', 'BatchEdit']);

// ============================================
// CODEX TOOL DEFINITIONS
// ============================================

interface CodexToolDef {
  name: string;
  description: string;
  parameters: ToolDefinition['parameters'];
}

export const CODEX_TOOL_DEFS: Record<string, CodexToolDef> = {
  shell_command: {
    name: 'shell_command',
    description:
      'Runs a shell command and returns its output.\n' +
      '- Always set the `workdir` param when using the shell_command function.\n' +
      '  Do not use `cd` unless absolutely necessary.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        workdir: { type: 'string', description: 'Working directory for the command' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  },

  read_file: {
    name: 'read_file',
    description:
      'Reads a local file with 1-indexed line numbers, supporting slice and\n' +
      'indentation-aware block modes.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read' },
        offset: { type: 'number', description: '1-indexed line number to start reading from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },

  grep_files: {
    name: 'grep_files',
    description:
      'Finds files whose contents match the pattern and lists them by\n' +
      'modification time.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
        path: { type: 'string', description: 'Directory to search in' },
        limit: { type: 'number', description: 'Maximum number of results' },
      },
      required: ['pattern'],
    },
  },

  list_dir: {
    name: 'list_dir',
    description:
      'Lists entries in a local directory with 1-indexed entry numbers and\n' +
      'simple type labels.',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Directory path to list' },
        limit: { type: 'number', description: 'Maximum number of entries' },
        depth: { type: 'number', description: 'Maximum directory depth' },
      },
      required: ['dir_path'],
    },
  },
};

// ============================================
// APPLY_PATCH DEFINITIONS
// ============================================

export const APPLY_PATCH_LARK_GRAMMAR = `
?start: patch
patch: "*** Begin Patch" NEWLINE operation+ "*** End Patch" NEWLINE?
operation: add_file | delete_file | update_file
add_file: "*** Add File: " PATH NEWLINE added_lines
delete_file: "*** Delete File: " PATH NEWLINE
update_file: "*** Update File: " PATH NEWLINE move_to? hunk+
move_to: "*** Move to: " PATH NEWLINE
hunk: "@@ " CONTEXT_HEADER? NEWLINE hunk_line+
hunk_line: context_line | add_line | remove_line
context_line: " " LINE NEWLINE
add_line: "+" LINE NEWLINE
remove_line: "-" LINE NEWLINE
added_lines: ("+" LINE NEWLINE)+
PATH: /[^\\n]+/
CONTEXT_HEADER: /[^\\n]*/
LINE: /[^\\n]*/
%import common.NEWLINE
`.trim();

export const APPLY_PATCH_DESCRIPTION =
  'Use the `apply_patch` tool to edit files. ' +
  'This is a FREEFORM tool, so do not wrap the patch in JSON.\n\n' +
  'Patch format:\n' +
  '```\n' +
  '*** Begin Patch\n' +
  '*** Add File: <path>\n' +
  '+<line>\n' +
  '\n' +
  '*** Delete File: <path>\n' +
  '\n' +
  '*** Update File: <path>\n' +
  '[*** Move to: <new-path>]\n' +
  '@@ <optional context>\n' +
  ' <context line>\n' +
  '-<removed line>\n' +
  '+<added line>\n' +
  '*** End Patch\n' +
  '```';

export const APPLY_PATCH_JSON_DESCRIPTION =
  APPLY_PATCH_DESCRIPTION +
  '\n\nProvide the entire patch as the `input` field value.';

// ============================================
// MODEL CAPABILITY
// ============================================

/** Check if a model supports the custom/freeform tool type. */
export function supportsCustomTools(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes('gpt-4.1') ||
    lower.includes('gpt-4o') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.includes('codex')
  );
}

// ============================================
// ARGUMENT TRANSLATION
// ============================================

/**
 * Translate Codex arguments to Nova arguments (inbound: model → executor).
 */
export function translateCodexArgsToNova(
  codexName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  switch (codexName) {
    case 'shell_command': {
      const result: Record<string, unknown> = {
        command: args.command,
      };
      if (args.timeout_ms !== undefined) {
        result.timeout = (args.timeout_ms as number) / 1000;
      }
      // workdir is handled by execution context, not args
      return result;
    }

    case 'read_file': {
      const result: Record<string, unknown> = {
        path: args.file_path ?? args.path,
      };
      const offset = args.offset ?? args.startLine;
      if (offset !== undefined) {
        result.startLine = offset;
        const limit = args.limit ?? args.endLine;
        if (limit !== undefined) {
          // If model sent endLine (Nova-style), use directly; otherwise compute from offset+limit
          result.endLine = args.endLine ?? ((offset as number) + (limit as number) - 1);
        }
      }
      return result;
    }

    case 'grep_files': {
      const result: Record<string, unknown> = {
        pattern: args.pattern,
      };
      if ((args.include ?? args.glob) !== undefined) result.glob = args.include ?? args.glob;
      if (args.path !== undefined) result.path = args.path;
      if ((args.limit ?? args.maxResults) !== undefined) result.maxResults = args.limit ?? args.maxResults;
      return result;
    }

    case 'list_dir': {
      const dirPath = (args.dir_path ?? args.pattern) as string | undefined ?? '.';
      const result: Record<string, unknown> = {
        pattern: dirPath.endsWith('/') ? `${dirPath}**/*` : `${dirPath}/**/*`,
      };
      if ((args.limit ?? args.maxResults) !== undefined) result.maxResults = args.limit ?? args.maxResults;
      if ((args.depth ?? args.maxDepth) !== undefined) result.maxDepth = args.depth ?? args.maxDepth;
      return result;
    }

    default:
      return args;
  }
}

/**
 * Translate Nova arguments to Codex arguments (outbound: executor → model).
 * Reverse of translateCodexArgsToNova so the model sees its native arg names
 * in conversation history.
 */
export function translateNovaArgsToCodex(
  novaName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  switch (novaName) {
    case 'Bash': {
      const result: Record<string, unknown> = {
        command: args.command,
      };
      if (args.timeout !== undefined) {
        result.timeout_ms = (args.timeout as number) * 1000;
      }
      return result;
    }

    case 'Read': {
      const result: Record<string, unknown> = {
        file_path: args.path,
      };
      if (args.startLine !== undefined) {
        result.offset = args.startLine;
        if (args.endLine !== undefined) {
          result.limit = (args.endLine as number) - (args.startLine as number) + 1;
        }
      }
      return result;
    }

    case 'Grep': {
      const result: Record<string, unknown> = {
        pattern: args.pattern,
      };
      if (args.glob !== undefined) result.include = args.glob;
      if (args.path !== undefined) result.path = args.path;
      if (args.maxResults !== undefined) result.limit = args.maxResults;
      return result;
    }

    case 'Glob': {
      const result: Record<string, unknown> = {
        dir_path: args.pattern,
      };
      if (args.maxResults !== undefined) result.limit = args.maxResults;
      if (args.maxDepth !== undefined) result.depth = args.maxDepth;
      return result;
    }

    default:
      return args;
  }
}

// ============================================
// TOOL VOCABULARY — Provider-specific tool names for system prompts.
// Derived from the skin maps so prompt text stays coupled to tool definitions.
// ============================================

/**
 * Tool vocabulary for system prompt parameterization.
 * Each field maps a logical tool role to its provider-specific name.
 */
export interface ToolVocabulary {
  read: string;
  glob: string;
  grep: string;
  bash: string;
  edit: string;
  write: string;
  explorer: string;
  promptUser: string;
}

/** Nova (internal) tool names — used for Anthropic and other non-OpenAI providers. */
export const NOVA_VOCAB: ToolVocabulary = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  explorer: 'Explorer',
  promptUser: 'PromptUser',
};

/** Codex tool names — derived from NOVA_TO_CODEX map. Used for OpenAI/Codex providers. */
export const CODEX_VOCAB: ToolVocabulary = {
  read: NOVA_TO_CODEX['Read'] ?? 'Read',
  glob: NOVA_TO_CODEX['Glob'] ?? 'Glob',
  grep: NOVA_TO_CODEX['Grep'] ?? 'Grep',
  bash: NOVA_TO_CODEX['Bash'] ?? 'Bash',
  edit: 'apply_patch',
  write: 'apply_patch',
  explorer: 'Explorer',
  promptUser: 'PromptUser',
};

/** Get the tool vocabulary for a canonical LLM provider. */
export function vocabForProvider(canonicalProvider: string): ToolVocabulary {
  return canonicalProvider === 'openai' || canonicalProvider === 'codex'
    ? CODEX_VOCAB
    : NOVA_VOCAB;
}

// ============================================
// FORMAT TOOLS
// ============================================

/**
 * Format a single Nova tool definition as its Codex-native equivalent for the OpenAI API.
 */
export function formatToolForOpenAI(
  tool: ToolDefinition,
  model: string
): Record<string, unknown> | null {
  // Filter out tools replaced by apply_patch
  if (FILTERED_NOVA_TOOLS.has(tool.name)) {
    return null;
  }

  // apply_patch gets special treatment
  if (tool.name === 'apply_patch') {
    if (supportsCustomTools(model)) {
      return {
        type: 'custom',
        name: 'apply_patch',
        description: APPLY_PATCH_DESCRIPTION,
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: APPLY_PATCH_LARK_GRAMMAR,
        },
      };
    }
    // JSON fallback
    return {
      type: 'function',
      name: 'apply_patch',
      description: APPLY_PATCH_JSON_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'The entire contents of the apply_patch command',
          },
        },
        required: ['input'],
      },
      strict: false,
    };
  }

  // 1:1 skinned tools
  const codexName = NOVA_TO_CODEX[tool.name];
  if (codexName) {
    const codexDef = CODEX_TOOL_DEFS[codexName];
    return {
      type: 'function',
      name: codexDef.name,
      description: codexDef.description,
      parameters: {
        type: 'object',
        properties: codexDef.parameters.properties,
        required: codexDef.parameters.required,
        additionalProperties: codexDef.parameters.additionalProperties,
      },
      strict: false,
    };
  }

  // Pass-through (WebFetch, ExpandConversation, etc.)
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.parameters.properties,
      required: tool.parameters.required,
      additionalProperties: tool.parameters.additionalProperties,
    },
    strict: tool.strict ?? false,
  };
}
