/**
 * Tests for tool skins — provider-specific tool name/schema translation.
 *
 * Focus areas:
 * - formatToolForOpenAI: correct Codex definitions, filtering, freeform vs JSON
 * - translateCodexArgsToNova: argument translation (Codex → Nova)
 * - translateNovaArgsToCodex: argument translation (Nova → Codex)
 * - Argument round-trip consistency
 * - vocabForProvider / NOVA_VOCAB / CODEX_VOCAB
 * - OpenAI provider parseToolCalls: Codex → Nova name + arg translation
 * - OpenAI provider normalizeInput: Nova → Codex name translation
 * - Full round-trip consistency through provider
 */

import type { ToolDefinition } from 'types';
import {
  CODEX_TO_NOVA,
  NOVA_TO_CODEX,
  FILTERED_NOVA_TOOLS,
  CODEX_TOOL_DEFS,
  formatToolForOpenAI,
  translateCodexArgsToNova,
  translateNovaArgsToCodex,
  supportsCustomTools,
  vocabForProvider,
  NOVA_VOCAB,
  CODEX_VOCAB,
} from 'llm/providers/tool_skins.js';
import { OpenAIProvider } from 'llm/providers/openai.js';

// ============================================
// NAME MAP TESTS
// ============================================

describe('name maps', () => {
  it('CODEX_TO_NOVA and NOVA_TO_CODEX are inverse', () => {
    for (const [codex, rex] of Object.entries(CODEX_TO_NOVA)) {
      expect(NOVA_TO_CODEX[rex]).toBe(codex);
    }
    for (const [rex, codex] of Object.entries(NOVA_TO_CODEX)) {
      expect(CODEX_TO_NOVA[codex]).toBe(rex);
    }
  });

  it('FILTERED_NOVA_TOOLS contains Edit, Write, BatchEdit', () => {
    expect(FILTERED_NOVA_TOOLS.has('Edit')).toBe(true);
    expect(FILTERED_NOVA_TOOLS.has('Write')).toBe(true);
    expect(FILTERED_NOVA_TOOLS.has('BatchEdit')).toBe(true);
    expect(FILTERED_NOVA_TOOLS.has('Read')).toBe(false);
    expect(FILTERED_NOVA_TOOLS.has('Bash')).toBe(false);
  });

  it('every skinned tool has a matching CODEX_TOOL_DEFS entry', () => {
    for (const codexName of Object.values(NOVA_TO_CODEX)) {
      expect(CODEX_TOOL_DEFS).toHaveProperty(codexName);
      expect(CODEX_TOOL_DEFS[codexName].name).toBe(codexName);
    }
  });
});

// ============================================
// formatToolForOpenAI TESTS
// ============================================

describe('formatToolForOpenAI', () => {
  const bashDef: ToolDefinition = {
    name: 'Bash',
    description: 'Execute shell commands',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['command'],
    },
  };

  const readDef: ToolDefinition = {
    name: 'Read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  };

  const editDef: ToolDefinition = {
    name: 'Edit',
    description: 'Edit a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  };

  const applyPatchDef: ToolDefinition = {
    name: 'apply_patch',
    description: 'Apply patches',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      required: ['input'],
    },
  };

  const webFetchDef: ToolDefinition = {
    name: 'WebFetch',
    description: 'Fetch a URL',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  };

  it('should translate Bash to shell_command', () => {
    const result = formatToolForOpenAI(bashDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('shell_command');
    expect(result!.type).toBe('function');
    const params = result!.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty('command');
    expect(params.properties).toHaveProperty('workdir');
    expect(params.properties).toHaveProperty('timeout_ms');
  });

  it('should translate Read to read_file', () => {
    const result = formatToolForOpenAI(readDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_file');
    const params = result!.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty('file_path');
  });

  it('should filter out Edit', () => {
    const result = formatToolForOpenAI(editDef, 'gpt-4.1');
    expect(result).toBeNull();
  });

  it('should emit freeform apply_patch for supported models', () => {
    const result = formatToolForOpenAI(applyPatchDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('custom');
    expect(result!.name).toBe('apply_patch');
    expect(result!.format).toBeDefined();
  });

  it('should emit JSON fallback apply_patch for unsupported models', () => {
    const result = formatToolForOpenAI(applyPatchDef, 'gpt-3.5-turbo');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('function');
    expect(result!.name).toBe('apply_patch');
    const params = result!.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty('input');
  });

  it('should filter out Write', () => {
    const writeDef: ToolDefinition = {
      name: 'Write',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    };
    expect(formatToolForOpenAI(writeDef, 'gpt-4.1')).toBeNull();
  });

  it('should filter out BatchEdit', () => {
    const batchEditDef: ToolDefinition = {
      name: 'BatchEdit',
      description: 'Batch edit files',
      parameters: { type: 'object', properties: { edits: { type: 'string' } }, required: ['edits'] },
    };
    expect(formatToolForOpenAI(batchEditDef, 'gpt-4.1')).toBeNull();
  });

  it('should translate Grep to grep_files', () => {
    const grepDef: ToolDefinition = {
      name: 'Grep',
      description: 'Search files',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
        required: ['pattern'],
      },
    };
    const result = formatToolForOpenAI(grepDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('grep_files');
    expect(result!.type).toBe('function');
    const params = result!.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty('pattern');
    expect(params.properties).toHaveProperty('include');
  });

  it('should translate Glob to list_dir', () => {
    const globDef: ToolDefinition = {
      name: 'Glob',
      description: 'List files',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    };
    const result = formatToolForOpenAI(globDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('list_dir');
    expect(result!.type).toBe('function');
    const params = result!.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty('dir_path');
  });

  it('should forward strict from pass-through tools', () => {
    const strictDef: ToolDefinition = {
      name: 'CustomTool',
      description: 'A custom tool',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      strict: true,
    };
    const result = formatToolForOpenAI(strictDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.strict).toBe(true);
  });

  it('should default strict to false for pass-through tools without it', () => {
    const result = formatToolForOpenAI(webFetchDef, 'gpt-4.1');
    expect(result!.strict).toBe(false);
  });

  it('should set strict: false on skinned tools', () => {
    const result = formatToolForOpenAI(bashDef, 'gpt-4.1');
    expect(result!.strict).toBe(false);
  });

  it('should pass through unskinned tools as-is', () => {
    const result = formatToolForOpenAI(webFetchDef, 'gpt-4.1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('WebFetch');
    expect(result!.type).toBe('function');
  });
});

// ============================================
// supportsCustomTools TESTS
// ============================================

describe('supportsCustomTools', () => {
  it('should return true for GPT-4.1', () => {
    expect(supportsCustomTools('gpt-4.1')).toBe(true);
    expect(supportsCustomTools('gpt-4.1-mini')).toBe(true);
  });

  it('should return true for o3/o4 models', () => {
    expect(supportsCustomTools('o3')).toBe(true);
    expect(supportsCustomTools('o3-mini')).toBe(true);
    expect(supportsCustomTools('o4-mini')).toBe(true);
  });

  it('should return true for GPT-4o models', () => {
    expect(supportsCustomTools('gpt-4o')).toBe(true);
    expect(supportsCustomTools('gpt-4o-mini')).toBe(true);
  });

  it('should return true for codex models', () => {
    expect(supportsCustomTools('codex-mini')).toBe(true);
    expect(supportsCustomTools('gpt-5.3-codex')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(supportsCustomTools('GPT-4.1')).toBe(true);
    expect(supportsCustomTools('O3-mini')).toBe(true);
    expect(supportsCustomTools('CODEX-mini')).toBe(true);
  });

  it('should return false for older models', () => {
    expect(supportsCustomTools('gpt-3.5-turbo')).toBe(false);
    expect(supportsCustomTools('gpt-4')).toBe(false);
  });
});

// ============================================
// ARGUMENT TRANSLATION TESTS
// ============================================

describe('translateCodexArgsToNova', () => {
  describe('shell_command → Bash', () => {
    it('should translate command', () => {
      const result = translateCodexArgsToNova('shell_command', { command: 'ls -la' });
      expect(result.command).toBe('ls -la');
    });

    it('should translate timeout_ms to seconds', () => {
      const result = translateCodexArgsToNova('shell_command', {
        command: 'sleep 1',
        timeout_ms: 5000,
      });
      expect(result.timeout).toBe(5);
    });

    it('should omit timeout when timeout_ms is not provided', () => {
      const result = translateCodexArgsToNova('shell_command', { command: 'echo hi' });
      expect(result.timeout).toBeUndefined();
    });

    it('should drop workdir (handled by execution context)', () => {
      const result = translateCodexArgsToNova('shell_command', {
        command: 'ls',
        workdir: '/home/user',
      });
      expect(result).toEqual({ command: 'ls' });
      expect(result.workdir).toBeUndefined();
    });
  });

  describe('read_file → Read', () => {
    it('should translate file_path to path', () => {
      const result = translateCodexArgsToNova('read_file', { file_path: '/src/main.ts' });
      expect(result.path).toBe('/src/main.ts');
    });

    it('should translate offset and limit to startLine and endLine', () => {
      const result = translateCodexArgsToNova('read_file', {
        file_path: '/src/main.ts',
        offset: 10,
        limit: 20,
      });
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(29); // 10 + 20 - 1
    });

    it('should handle offset without limit', () => {
      const result = translateCodexArgsToNova('read_file', {
        file_path: '/src/main.ts',
        offset: 10,
      });
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBeUndefined();
    });

    it('should accept path as alias for file_path', () => {
      const result = translateCodexArgsToNova('read_file', { path: '/x.ts' });
      expect(result.path).toBe('/x.ts');
    });

    it('should prefer file_path over path', () => {
      const result = translateCodexArgsToNova('read_file', { file_path: '/a.ts', path: '/b.ts' });
      expect(result.path).toBe('/a.ts');
    });

    it('should pass through endLine directly when model sends it', () => {
      const result = translateCodexArgsToNova('read_file', {
        file_path: '/x.ts',
        offset: 5,
        endLine: 42,
      });
      expect(result.startLine).toBe(5);
      expect(result.endLine).toBe(42);
    });

    it('should accept startLine as alias for offset', () => {
      const result = translateCodexArgsToNova('read_file', {
        file_path: '/x.ts',
        startLine: 7,
        limit: 10,
      });
      expect(result.startLine).toBe(7);
      expect(result.endLine).toBe(16); // 7 + 10 - 1
    });

    it('should return only path when no range args given', () => {
      const result = translateCodexArgsToNova('read_file', { file_path: '/x.ts' });
      expect(result.path).toBe('/x.ts');
      expect(result.startLine).toBeUndefined();
      expect(result.endLine).toBeUndefined();
    });
  });

  describe('grep_files → Grep', () => {
    it('should translate include to glob', () => {
      const result = translateCodexArgsToNova('grep_files', {
        pattern: 'TODO',
        include: '*.ts',
        path: '/src',
        limit: 50,
      });
      expect(result.pattern).toBe('TODO');
      expect(result.glob).toBe('*.ts');
      expect(result.path).toBe('/src');
      expect(result.maxResults).toBe(50);
    });

    it('should accept glob as alias for include', () => {
      const result = translateCodexArgsToNova('grep_files', { pattern: 'foo', glob: '*.js' });
      expect(result.glob).toBe('*.js');
    });

    it('should accept maxResults as alias for limit', () => {
      const result = translateCodexArgsToNova('grep_files', { pattern: 'bar', maxResults: 25 });
      expect(result.maxResults).toBe(25);
    });

    it('should handle pattern-only (minimal call)', () => {
      const result = translateCodexArgsToNova('grep_files', { pattern: 'hello' });
      expect(result.pattern).toBe('hello');
      expect(result.glob).toBeUndefined();
      expect(result.path).toBeUndefined();
      expect(result.maxResults).toBeUndefined();
    });
  });

  describe('list_dir → Glob', () => {
    it('should convert dir_path to glob pattern', () => {
      const result = translateCodexArgsToNova('list_dir', { dir_path: 'src' });
      expect(result.pattern).toBe('src/**/*');
    });

    it('should handle trailing slash', () => {
      const result = translateCodexArgsToNova('list_dir', { dir_path: 'src/' });
      expect(result.pattern).toBe('src/**/*');
    });

    it('should translate limit and depth', () => {
      const result = translateCodexArgsToNova('list_dir', {
        dir_path: '.',
        limit: 100,
        depth: 3,
      });
      expect(result.maxResults).toBe(100);
      expect(result.maxDepth).toBe(3);
    });

    it('should accept pattern as alias for dir_path', () => {
      const result = translateCodexArgsToNova('list_dir', { pattern: 'lib' });
      expect(result.pattern).toBe('lib/**/*');
    });

    it('should default to current dir when neither dir_path nor pattern given', () => {
      const result = translateCodexArgsToNova('list_dir', {});
      expect(result.pattern).toBe('./**/*');
    });

    it('should accept maxResults as alias for limit', () => {
      const result = translateCodexArgsToNova('list_dir', { dir_path: '.', maxResults: 50 });
      expect(result.maxResults).toBe(50);
    });

    it('should accept maxDepth as alias for depth', () => {
      const result = translateCodexArgsToNova('list_dir', { dir_path: '.', maxDepth: 2 });
      expect(result.maxDepth).toBe(2);
    });
  });

  describe('unknown tool', () => {
    it('should pass through args unchanged', () => {
      const args = { foo: 'bar', baz: 123 };
      const result = translateCodexArgsToNova('unknown_tool', args);
      expect(result).toEqual(args);
    });
  });
});

// ============================================
// REVERSE ARGUMENT TRANSLATION (Nova → Codex)
// ============================================

describe('translateNovaArgsToCodex', () => {
  describe('Bash → shell_command', () => {
    it('should translate command', () => {
      const result = translateNovaArgsToCodex('Bash', { command: 'ls -la' });
      expect(result.command).toBe('ls -la');
    });

    it('should translate timeout (seconds) to timeout_ms', () => {
      const result = translateNovaArgsToCodex('Bash', { command: 'sleep 1', timeout: 5 });
      expect(result.timeout_ms).toBe(5000);
    });

    it('should omit timeout_ms when timeout is not provided', () => {
      const result = translateNovaArgsToCodex('Bash', { command: 'echo hi' });
      expect(result.timeout_ms).toBeUndefined();
    });
  });

  describe('Read → read_file', () => {
    it('should translate path to file_path', () => {
      const result = translateNovaArgsToCodex('Read', { path: '/src/main.ts' });
      expect(result.file_path).toBe('/src/main.ts');
    });

    it('should translate startLine/endLine to offset/limit', () => {
      const result = translateNovaArgsToCodex('Read', {
        path: '/src/main.ts',
        startLine: 10,
        endLine: 29,
      });
      expect(result.offset).toBe(10);
      expect(result.limit).toBe(20); // 29 - 10 + 1
    });

    it('should handle startLine without endLine', () => {
      const result = translateNovaArgsToCodex('Read', { path: '/x.ts', startLine: 5 });
      expect(result.offset).toBe(5);
      expect(result.limit).toBeUndefined();
    });

    it('should return only file_path when no range given', () => {
      const result = translateNovaArgsToCodex('Read', { path: '/x.ts' });
      expect(result.file_path).toBe('/x.ts');
      expect(result.offset).toBeUndefined();
      expect(result.limit).toBeUndefined();
    });
  });

  describe('Grep → grep_files', () => {
    it('should translate glob to include', () => {
      const result = translateNovaArgsToCodex('Grep', {
        pattern: 'TODO',
        glob: '*.ts',
        path: '/src',
        maxResults: 50,
      });
      expect(result.pattern).toBe('TODO');
      expect(result.include).toBe('*.ts');
      expect(result.path).toBe('/src');
      expect(result.limit).toBe(50);
    });

    it('should handle pattern-only (minimal call)', () => {
      const result = translateNovaArgsToCodex('Grep', { pattern: 'hello' });
      expect(result.pattern).toBe('hello');
      expect(result.include).toBeUndefined();
      expect(result.path).toBeUndefined();
      expect(result.limit).toBeUndefined();
    });
  });

  describe('Glob → list_dir', () => {
    it('should translate pattern to dir_path', () => {
      const result = translateNovaArgsToCodex('Glob', { pattern: 'src/**/*' });
      expect(result.dir_path).toBe('src/**/*');
    });

    it('should translate maxResults and maxDepth', () => {
      const result = translateNovaArgsToCodex('Glob', {
        pattern: '.',
        maxResults: 100,
        maxDepth: 3,
      });
      expect(result.limit).toBe(100);
      expect(result.depth).toBe(3);
    });

    it('should omit optional fields when absent', () => {
      const result = translateNovaArgsToCodex('Glob', { pattern: '.' });
      expect(result.limit).toBeUndefined();
      expect(result.depth).toBeUndefined();
    });
  });

  describe('unknown tool', () => {
    it('should pass through args unchanged', () => {
      const args = { foo: 'bar', baz: 123 };
      const result = translateNovaArgsToCodex('UnknownTool', args);
      expect(result).toEqual(args);
    });
  });
});

// ============================================
// ARGUMENT ROUND-TRIP INVARIANT
// ============================================

describe('argument round-trip: Codex → Nova → Codex', () => {
  it('shell_command args survive the round-trip', () => {
    const codexArgs = { command: 'echo hello', timeout_ms: 3000 };
    const rexArgs = translateCodexArgsToNova('shell_command', codexArgs);
    const backToCodex = translateNovaArgsToCodex('Bash', rexArgs);
    expect(backToCodex.command).toBe(codexArgs.command);
    expect(backToCodex.timeout_ms).toBe(codexArgs.timeout_ms);
  });

  it('read_file args survive the round-trip', () => {
    const codexArgs = { file_path: '/a.ts', offset: 10, limit: 20 };
    const rexArgs = translateCodexArgsToNova('read_file', codexArgs);
    const backToCodex = translateNovaArgsToCodex('Read', rexArgs);
    expect(backToCodex.file_path).toBe(codexArgs.file_path);
    expect(backToCodex.offset).toBe(codexArgs.offset);
    expect(backToCodex.limit).toBe(codexArgs.limit);
  });

  it('grep_files args survive the round-trip', () => {
    const codexArgs = { pattern: 'TODO', include: '*.ts', path: '/src', limit: 50 };
    const rexArgs = translateCodexArgsToNova('grep_files', codexArgs);
    const backToCodex = translateNovaArgsToCodex('Grep', rexArgs);
    expect(backToCodex.pattern).toBe(codexArgs.pattern);
    expect(backToCodex.include).toBe(codexArgs.include);
    expect(backToCodex.path).toBe(codexArgs.path);
    expect(backToCodex.limit).toBe(codexArgs.limit);
  });

  it('read_file with no range survives the round-trip', () => {
    const codexArgs = { file_path: '/b.ts' };
    const rexArgs = translateCodexArgsToNova('read_file', codexArgs);
    const backToCodex = translateNovaArgsToCodex('Read', rexArgs);
    expect(backToCodex.file_path).toBe('/b.ts');
    expect(backToCodex.offset).toBeUndefined();
    expect(backToCodex.limit).toBeUndefined();
  });
});

// ============================================
// TOOL VOCABULARY TESTS
// ============================================

describe('vocabForProvider', () => {
  it('should return CODEX_VOCAB for openai provider', () => {
    expect(vocabForProvider('openai')).toBe(CODEX_VOCAB);
  });

  it('should return CODEX_VOCAB for codex provider', () => {
    expect(vocabForProvider('codex')).toBe(CODEX_VOCAB);
  });

  it('should return NOVA_VOCAB for anthropic provider', () => {
    expect(vocabForProvider('anthropic')).toBe(NOVA_VOCAB);
  });

  it('should return NOVA_VOCAB for any unknown provider', () => {
    expect(vocabForProvider('google')).toBe(NOVA_VOCAB);
    expect(vocabForProvider('')).toBe(NOVA_VOCAB);
  });
});

describe('vocabulary constants', () => {
  it('NOVA_VOCAB uses Nova tool names', () => {
    expect(NOVA_VOCAB.read).toBe('Read');
    expect(NOVA_VOCAB.glob).toBe('Glob');
    expect(NOVA_VOCAB.grep).toBe('Grep');
    expect(NOVA_VOCAB.bash).toBe('Bash');
    expect(NOVA_VOCAB.edit).toBe('Edit');
    expect(NOVA_VOCAB.write).toBe('Write');
  });

  it('CODEX_VOCAB uses Codex tool names for skinned tools', () => {
    expect(CODEX_VOCAB.read).toBe('read_file');
    expect(CODEX_VOCAB.glob).toBe('list_dir');
    expect(CODEX_VOCAB.grep).toBe('grep_files');
    expect(CODEX_VOCAB.bash).toBe('shell_command');
  });

  it('CODEX_VOCAB uses apply_patch for edit and write', () => {
    expect(CODEX_VOCAB.edit).toBe('apply_patch');
    expect(CODEX_VOCAB.write).toBe('apply_patch');
  });

  it('CODEX_VOCAB inherits unskinned tool names from Nova', () => {
    expect(CODEX_VOCAB.explorer).toBe('Explorer');
    expect(CODEX_VOCAB.promptUser).toBe('PromptUser');
  });

  it('CODEX_VOCAB.bash/read/grep/glob match NOVA_TO_CODEX', () => {
    expect(CODEX_VOCAB.bash).toBe(NOVA_TO_CODEX['Bash']);
    expect(CODEX_VOCAB.read).toBe(NOVA_TO_CODEX['Read']);
    expect(CODEX_VOCAB.grep).toBe(NOVA_TO_CODEX['Grep']);
    expect(CODEX_VOCAB.glob).toBe(NOVA_TO_CODEX['Glob']);
  });
});

// ============================================
// OPENAI PROVIDER INTEGRATION TESTS
// ============================================

describe('OpenAIProvider tool skin integration', () => {
  const provider = new OpenAIProvider();

  describe('formatTools', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'Bash',
        description: 'Execute commands',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      {
        name: 'Read',
        description: 'Read files',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'Edit',
        description: 'Edit files',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'Write',
        description: 'Write files',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'apply_patch',
        description: 'Apply patches',
        parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      },
      {
        name: 'WebFetch',
        description: 'Fetch URLs',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    ];

    it('should produce Codex-native tool definitions', () => {
      const formatted = provider.formatTools(tools, 'gpt-4.1');

      const names = formatted.map((t) => t.name);
      expect(names).toContain('shell_command');
      expect(names).toContain('read_file');
      expect(names).toContain('apply_patch');
      expect(names).toContain('WebFetch');

      // Edit and Write should be filtered out
      expect(names).not.toContain('Edit');
      expect(names).not.toContain('Write');
      expect(names).not.toContain('Bash');
      expect(names).not.toContain('Read');
    });

    it('should emit freeform apply_patch for GPT-4.1', () => {
      const formatted = provider.formatTools(tools, 'gpt-4.1');
      const applyPatch = formatted.find((t) => t.name === 'apply_patch');
      expect(applyPatch!.type).toBe('custom');
    });
  });

  describe('parseToolCalls', () => {
    it('should translate shell_command → Bash', () => {
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'ls -la', timeout_ms: 5000 }),
          },
        ],
      };

      // Access the private method via type assertion for testing
      const calls = (provider as any).parseToolCalls(response);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('Bash');
      expect(calls[0].arguments.command).toBe('ls -la');
      expect(calls[0].arguments.timeout).toBe(5);
    });

    it('should translate read_file → Read', () => {
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'read_file',
            arguments: JSON.stringify({ file_path: '/src/main.ts', offset: 10, limit: 20 }),
          },
        ],
      };

      const calls = (provider as any).parseToolCalls(response);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('Read');
      expect(calls[0].arguments.path).toBe('/src/main.ts');
      expect(calls[0].arguments.startLine).toBe(10);
      expect(calls[0].arguments.endLine).toBe(29);
    });

    it('should handle apply_patch raw text', () => {
      const patchText = '*** Begin Patch\n*** Add File: test.ts\n+hello\n*** End Patch';
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_3',
            name: 'apply_patch',
            arguments: patchText,
          },
        ],
      };

      const calls = (provider as any).parseToolCalls(response);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('apply_patch');
      expect(calls[0].arguments.input).toBe(patchText);
    });

    it('should pass through unknown tool names', () => {
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_4',
            name: 'WebFetch',
            arguments: JSON.stringify({ url: 'https://example.com' }),
          },
        ],
      };

      const calls = (provider as any).parseToolCalls(response);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('WebFetch');
      expect(calls[0].arguments.url).toBe('https://example.com');
    });
  });

  describe('normalizeInput', () => {
    it('should translate Nova names → Codex names in function_call items', () => {
      const messages = [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'ls' }),
        },
      ];

      const input = (provider as any).normalizeInput(messages);
      expect(input).toHaveLength(1);
      expect(input[0].name).toBe('shell_command');
    });

    it('should unwrap apply_patch { input: text } to raw text', () => {
      const patchText = '*** Begin Patch\n*** End Patch';
      const messages = [
        {
          type: 'function_call',
          call_id: 'call_2',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patchText }),
        },
      ];

      const input = (provider as any).normalizeInput(messages);
      expect(input).toHaveLength(1);
      expect(input[0].name).toBe('apply_patch');
      expect(input[0].arguments).toBe(patchText);
    });

    it('should handle apply_patch with object arguments', () => {
      const patchText = '*** Begin Patch\n*** End Patch';
      const messages = [
        {
          type: 'function_call',
          call_id: 'call_3',
          name: 'apply_patch',
          arguments: { input: patchText },
        },
      ];

      const input = (provider as any).normalizeInput(messages);
      expect(input).toHaveLength(1);
      expect(input[0].arguments).toBe(patchText);
    });

    it('should pass through non-function_call messages unchanged', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];

      const input = (provider as any).normalizeInput(messages);
      expect(input).toHaveLength(2);
      expect(input[0].role).toBe('user');
      expect(input[1].role).toBe('assistant');
    });

    it('should pass through function_call_output unchanged', () => {
      const messages = [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'some output',
        },
      ];

      const input = (provider as any).normalizeInput(messages);
      expect(input).toHaveLength(1);
      expect(input[0].type).toBe('function_call_output');
    });
  });

  describe('round-trip consistency (INV1)', () => {
    it('model emits Codex name → parseToolCalls → Nova name → normalizeInput → Codex name', () => {
      // Step 1: Model emits shell_command
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_rt',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'echo hi' }),
          },
        ],
      };

      // Step 2: parseToolCalls translates to Bash
      const calls = (provider as any).parseToolCalls(response);
      expect(calls[0].name).toBe('Bash');

      // Step 3: Context stores as function_call with Nova name
      const contextItem = {
        type: 'function_call',
        call_id: calls[0].id,
        name: calls[0].name,
        arguments: JSON.stringify(calls[0].arguments),
      };

      // Step 4: normalizeInput translates back to shell_command
      const input = (provider as any).normalizeInput([contextItem]);
      expect(input[0].name).toBe('shell_command');
    });

    it('apply_patch round-trip: raw text survives full cycle', () => {
      const patchText = '*** Begin Patch\n*** Add File: x.ts\n+hello\n*** End Patch';

      // Model emits apply_patch with raw text
      const response = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_ap',
            name: 'apply_patch',
            arguments: patchText,
          },
        ],
      };

      // parseToolCalls wraps in { input: text }
      const calls = (provider as any).parseToolCalls(response);
      expect(calls[0].name).toBe('apply_patch');
      expect(calls[0].arguments.input).toBe(patchText);

      // Context stores it
      const contextItem = {
        type: 'function_call',
        call_id: calls[0].id,
        name: 'apply_patch',
        arguments: JSON.stringify(calls[0].arguments),
      };

      // normalizeInput unwraps back to raw text
      const input = (provider as any).normalizeInput([contextItem]);
      expect(input[0].name).toBe('apply_patch');
      expect(input[0].arguments).toBe(patchText);
    });
  });
});
