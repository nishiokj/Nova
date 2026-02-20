/**
 * Tool Skins — Per-provider tool name/schema translations.
 *
 * Maps Rex tool definitions (Bash, Read, Grep, Glob) to Codex-native
 * definitions (shell_command, read_file, grep_files, list_dir) that
 * OpenAI models were trained on.
 */

import type { ToolDefinition } from 'types';

// ============================================
// NAME MAPS
// ============================================

/** Codex tool name → Rex tool name */
export const CODEX_TO_REX: Record<string, string> = {
  shell_command: 'Bash',
  read_file: 'Read',
  grep_files: 'Grep',
  list_dir: 'Glob',
};

/** Rex tool name → Codex tool name */
export const REX_TO_CODEX: Record<string, string> = {
  Bash: 'shell_command',
  Read: 'read_file',
  Grep: 'grep_files',
  Glob: 'list_dir',
};

/** Rex tools to filter out when using OpenAI (replaced by apply_patch) */
export const FILTERED_REX_TOOLS = new Set(['Edit', 'Write', 'BatchEdit']);

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
 * Translate Codex arguments to Rex arguments (inbound: model → executor).
 */
export function translateCodexArgsToRex(
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
        path: args.file_path,
      };
      if (args.offset !== undefined) {
        result.startLine = args.offset;
        if (args.limit !== undefined) {
          result.endLine = (args.offset as number) + (args.limit as number) - 1;
        }
      }
      return result;
    }

    case 'grep_files': {
      const result: Record<string, unknown> = {
        pattern: args.pattern,
      };
      if (args.include !== undefined) result.glob = args.include;
      if (args.path !== undefined) result.path = args.path;
      if (args.limit !== undefined) result.maxResults = args.limit;
      return result;
    }

    case 'list_dir': {
      const dirPath = (args.dir_path as string) ?? '.';
      const result: Record<string, unknown> = {
        pattern: dirPath.endsWith('/') ? `${dirPath}**/*` : `${dirPath}/**/*`,
      };
      if (args.limit !== undefined) result.maxResults = args.limit;
      if (args.depth !== undefined) result.maxDepth = args.depth;
      return result;
    }

    default:
      return args;
  }
}

// ============================================
// FORMAT TOOLS
// ============================================

/**
 * Format a single Rex tool definition as its Codex-native equivalent for the OpenAI API.
 */
export function formatToolForOpenAI(
  tool: ToolDefinition,
  model: string
): Record<string, unknown> | null {
  // Filter out tools replaced by apply_patch
  if (FILTERED_REX_TOOLS.has(tool.name)) {
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
  const codexName = REX_TO_CODEX[tool.name];
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
