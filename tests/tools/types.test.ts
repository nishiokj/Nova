/**
 * Comprehensive test suite for Tool Types and Utilities
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - shouldSkipDir: Directory exclusion logic
 * - shouldSkipFile: File extension exclusion
 * - isDangerousCommand: Security pattern matching
 * - createTool: Tool factory function
 * - Constants and defaults
 */

import {
  shouldSkipDir,
  shouldSkipFile,
  isDangerousCommand,
  createTool,
  createExecutionContext,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_EXTENSIONS,
  DANGEROUS_PATTERNS,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_TOOL_CONFIG,
  type Tool,
  type ToolRegistrationOptions,
  type ToolExecutionContext,
} from 'tools/types.js';
import { validateToolArgs } from 'tools';
import { successResult, type ToolResult } from 'types';

describe('shouldSkipDir', () => {
  describe('Default exclusions', () => {
    it('should skip node_modules', () => {
      expect(shouldSkipDir('node_modules')).toBe(true);
    });

    it('should skip __pycache__', () => {
      expect(shouldSkipDir('__pycache__')).toBe(true);
    });

    it('should skip .git', () => {
      expect(shouldSkipDir('.git')).toBe(true);
    });

    it('should skip .venv', () => {
      expect(shouldSkipDir('.venv')).toBe(true);
    });

    it('should skip venv', () => {
      expect(shouldSkipDir('venv')).toBe(true);
    });

    it('should skip dist', () => {
      expect(shouldSkipDir('dist')).toBe(true);
    });

    it('should skip build', () => {
      expect(shouldSkipDir('build')).toBe(true);
    });

    it('should skip site-packages', () => {
      expect(shouldSkipDir('site-packages')).toBe(true);
    });

    it('should skip .mypy_cache', () => {
      expect(shouldSkipDir('.mypy_cache')).toBe(true);
    });

    it('should skip .pytest_cache', () => {
      expect(shouldSkipDir('.pytest_cache')).toBe(true);
    });

    it('should skip .tox', () => {
      expect(shouldSkipDir('.tox')).toBe(true);
    });

    it('should skip .eggs', () => {
      expect(shouldSkipDir('.eggs')).toBe(true);
    });

    it('should skip .cache', () => {
      expect(shouldSkipDir('.cache')).toBe(true);
    });

    it('should skip .ruff_cache', () => {
      expect(shouldSkipDir('.ruff_cache')).toBe(true);
    });

    it('should skip htmlcov', () => {
      expect(shouldSkipDir('htmlcov')).toBe(true);
    });

    it('should skip coverage', () => {
      expect(shouldSkipDir('coverage')).toBe(true);
    });
  });

  describe('Glob pattern: .egg-info', () => {
    it('should skip .egg-info directories', () => {
      expect(shouldSkipDir('mypackage.egg-info')).toBe(true);
    });

    it('should skip any .egg-info suffix', () => {
      expect(shouldSkipDir('foo.egg-info')).toBe(true);
      expect(shouldSkipDir('bar-1.0.0.egg-info')).toBe(true);
    });
  });

  describe('Non-excluded directories', () => {
    it('should NOT skip src', () => {
      expect(shouldSkipDir('src')).toBe(false);
    });

    it('should NOT skip lib', () => {
      expect(shouldSkipDir('lib')).toBe(false);
    });

    it('should NOT skip tests', () => {
      expect(shouldSkipDir('tests')).toBe(false);
    });

    it('should NOT skip components', () => {
      expect(shouldSkipDir('components')).toBe(false);
    });

    it('should NOT skip regular hidden directories', () => {
      // Note: .git is excluded, but .github is not
      expect(shouldSkipDir('.github')).toBe(false);
    });

    it('should NOT skip directories with similar names', () => {
      expect(shouldSkipDir('node_modules_backup')).toBe(false);
      expect(shouldSkipDir('my_venv')).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      expect(shouldSkipDir('')).toBe(false);
    });

    it('should be case sensitive', () => {
      // node_modules vs NODE_MODULES
      expect(shouldSkipDir('NODE_MODULES')).toBe(false);
      expect(shouldSkipDir('Node_Modules')).toBe(false);
    });

    it('should handle special characters in names', () => {
      expect(shouldSkipDir('dir with spaces')).toBe(false);
      expect(shouldSkipDir('dir-with-dashes')).toBe(false);
    });
  });
});

describe('shouldSkipFile', () => {
  describe('Default exclusions', () => {
    it('should skip .pyc files', () => {
      expect(shouldSkipFile('module.pyc')).toBe(true);
    });

    it('should skip .pyo files', () => {
      expect(shouldSkipFile('module.pyo')).toBe(true);
    });

    it('should skip .so files', () => {
      expect(shouldSkipFile('library.so')).toBe(true);
    });

    it('should skip .o files', () => {
      expect(shouldSkipFile('main.o')).toBe(true);
    });

    it('should skip .a files', () => {
      expect(shouldSkipFile('libfoo.a')).toBe(true);
    });

    it('should skip .dylib files', () => {
      expect(shouldSkipFile('library.dylib')).toBe(true);
    });

    it('should skip .dll files', () => {
      expect(shouldSkipFile('library.dll')).toBe(true);
    });

    it('should skip .exe files', () => {
      expect(shouldSkipFile('program.exe')).toBe(true);
    });

    it('should skip .class files', () => {
      expect(shouldSkipFile('Main.class')).toBe(true);
    });
  });

  describe('Non-excluded files', () => {
    it('should NOT skip .ts files', () => {
      expect(shouldSkipFile('index.ts')).toBe(false);
    });

    it('should NOT skip .js files', () => {
      expect(shouldSkipFile('index.js')).toBe(false);
    });

    it('should NOT skip .py files', () => {
      expect(shouldSkipFile('module.py')).toBe(false);
    });

    it('should NOT skip .json files', () => {
      expect(shouldSkipFile('package.json')).toBe(false);
    });

    it('should NOT skip .md files', () => {
      expect(shouldSkipFile('README.md')).toBe(false);
    });

    it('should NOT skip files without extension', () => {
      expect(shouldSkipFile('Makefile')).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should handle case insensitivity', () => {
      // Extension matching is case-insensitive
      expect(shouldSkipFile('file.PYC')).toBe(true);
      expect(shouldSkipFile('file.Pyc')).toBe(true);
    });

    it('should handle multiple dots in filename', () => {
      expect(shouldSkipFile('file.test.pyc')).toBe(true);
      expect(shouldSkipFile('file.test.js')).toBe(false);
    });

    it('should handle hidden files', () => {
      expect(shouldSkipFile('.gitignore')).toBe(false);
      // Hidden file with binary extension
      expect(shouldSkipFile('.hidden.pyc')).toBe(true);
    });

    it('should handle files starting with dot', () => {
      expect(shouldSkipFile('.pyc')).toBe(true); // Just the extension
    });

    it('BUG CANDIDATE: empty filename edge case', () => {
      // An empty string would result in lastIndexOf returning -1
      // slice(-1) of empty string is empty string
      expect(shouldSkipFile('')).toBe(false);
    });
  });
});

describe('isDangerousCommand', () => {
  describe('Known dangerous patterns', () => {
    it('should block rm -rf /', () => {
      expect(isDangerousCommand('rm -rf /')).toBe(true);
    });

    it('should block rm -rf /*', () => {
      expect(isDangerousCommand('rm -rf /*')).toBe(true);
    });

    it('should block > /dev/sda', () => {
      expect(isDangerousCommand('echo "data" > /dev/sda')).toBe(true);
    });

    it('should block mkfs commands', () => {
      expect(isDangerousCommand('mkfs.ext4 /dev/sda1')).toBe(true);
      expect(isDangerousCommand('mkfs -t ext4 /dev/sdb')).toBe(true);
    });

    it('should block fork bomb', () => {
      expect(isDangerousCommand(':(){:|:&};:')).toBe(true);
    });

    it('should block dd if=/dev/', () => {
      expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
      expect(isDangerousCommand('dd if=/dev/random of=file')).toBe(true);
    });

    it('should block chmod -R 777 /', () => {
      expect(isDangerousCommand('chmod -R 777 /')).toBe(true);
    });

    it('should block chown -R', () => {
      expect(isDangerousCommand('chown -R root:root /')).toBe(true);
    });
  });

  describe('Safe commands', () => {
    it('should allow rm for specific files', () => {
      expect(isDangerousCommand('rm file.txt')).toBe(false);
    });

    it('should allow rm -rf for subdirectories', () => {
      expect(isDangerousCommand('rm -rf ./temp')).toBe(false);
      expect(isDangerousCommand('rm -rf node_modules')).toBe(false);
    });

    it('should allow safe dd commands', () => {
      expect(isDangerousCommand('dd if=input.bin of=output.bin')).toBe(false);
    });

    it('should allow chmod for specific files', () => {
      expect(isDangerousCommand('chmod 755 script.sh')).toBe(false);
    });

    it('should allow chown for specific files', () => {
      expect(isDangerousCommand('chown user:group file.txt')).toBe(false);
    });

    it('should allow echo commands', () => {
      expect(isDangerousCommand('echo "hello"')).toBe(false);
    });

    it('should allow ls commands', () => {
      expect(isDangerousCommand('ls -la')).toBe(false);
    });

    it('should allow git commands', () => {
      expect(isDangerousCommand('git status')).toBe(false);
      expect(isDangerousCommand('git push')).toBe(false);
    });
  });

  describe('Pattern matching behavior', () => {
    it('should use substring matching (includes)', () => {
      // Commands containing dangerous patterns anywhere are blocked
      expect(isDangerousCommand('echo "rm -rf /"')).toBe(true);
    });

    it('BUG CANDIDATE: false positives from substring matching', () => {
      // Commands that mention but don't execute dangerous patterns
      // are still blocked
      expect(isDangerousCommand('grep "rm -rf /" history.txt')).toBe(true);
      expect(isDangerousCommand('cat file.txt | grep mkfs')).toBe(true);
    });

    it('should handle multiline commands', () => {
      const multiline = 'echo "safe"\nrm -rf /\necho "end"';
      expect(isDangerousCommand(multiline)).toBe(true);
    });

    it('should handle commands with varying whitespace', () => {
      // The patterns are exact substring matches
      expect(isDangerousCommand('rm  -rf  /')).toBe(false); // Extra spaces
    });
  });
});

describe('createTool', () => {
  const mockExecutor = async (): Promise<ToolResult> => {
    return successResult('Test', 'output', 100);
  };

  describe('Required properties', () => {
    it('should create tool with required properties', () => {
      const options: ToolRegistrationOptions = {
        name: 'TestTool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        required: [],
        executor: mockExecutor,
      };

      const tool = createTool(options);

      expect(tool.name).toBe('TestTool');
      expect(tool.description).toBe('A test tool');
      expect(tool.executor).toBe(mockExecutor);
    });
  });

  describe('Default values', () => {
    it('should default enabled to true', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
      });

      expect(tool.enabled).toBe(true);
    });

    it('should default timeoutMs to 30000', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
      });

      expect(tool.timeoutMs).toBe(30000);
    });

    it('should default readOnly to false', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
      });

      expect(tool.readOnly).toBe(false);
    });

    it('should default parallelizable to false', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
      });

      expect(tool.parallelizable).toBe(false);
    });

    it('should default costHint to standard', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
      });

      expect(tool.costHint).toBe('standard');
    });
  });

  describe('Custom values', () => {
    it('should use custom enabled value', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
        enabled: false,
      });

      expect(tool.enabled).toBe(false);
    });

    it('should use custom timeoutMs', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
        timeoutMs: 60000,
      });

      expect(tool.timeoutMs).toBe(60000);
    });

    it('should use custom readOnly', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
        readOnly: true,
      });

      expect(tool.readOnly).toBe(true);
    });

    it('should use custom parallelizable', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
        parallelizable: true,
      });

      expect(tool.parallelizable).toBe(true);
    });

    it('should use custom costHint', () => {
      const tool = createTool({
        name: 'Test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
        required: [],
        executor: mockExecutor,
        costHint: 'high',
      });

      expect(tool.costHint).toBe('high');
    });
  });
});

describe('createExecutionContext', () => {
  it('should create empty context', () => {
    const context = createExecutionContext();

    expect(context).toEqual({});
  });

  it('should return new object each time', () => {
    const context1 = createExecutionContext();
    const context2 = createExecutionContext();

    expect(context1).not.toBe(context2);
  });
});

describe('tool argument schema alignment', () => {
  it('rejects Bash timeouts below the enforced minimum', () => {
    const result = validateToolArgs('Bash', {
      command: 'echo hi',
      timeout: 0.5,
    });

    expect(result.success).toBe(false);
  });

  it('rejects ExpandConversation limits above the enforced maximum', () => {
    const result = validateToolArgs('ExpandConversation', {
      conversation_id: '01TEST',
      limit: 201,
    });

    expect(result.success).toBe(false);
  });

  it('rejects ExpandConversation message caps below the enforced minimum', () => {
    const result = validateToolArgs('ExpandConversation', {
      conversation_id: '01TEST',
      max_chars_per_message: 199,
    });

    expect(result.success).toBe(false);
  });

  it('rejects WebSearch counts above the enforced maximum', () => {
    const result = validateToolArgs('WebSearch', {
      query: 'context windows',
      count: 21,
    });

    expect(result.success).toBe(false);
  });

  it('accepts WebSearch counts within the advertised range', () => {
    const result = validateToolArgs('WebSearch', {
      query: 'context windows',
      count: 20,
    });

    expect(result.success).toBe(true);
  });
});

describe('Constants', () => {
  describe('DEFAULT_EXCLUDE_DIRS', () => {
    it('should be a Set', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toBeInstanceOf(Set);
    });

    it('should contain common exclusion directories', () => {
      expect(DEFAULT_EXCLUDE_DIRS.has('node_modules')).toBe(true);
      expect(DEFAULT_EXCLUDE_DIRS.has('.git')).toBe(true);
      expect(DEFAULT_EXCLUDE_DIRS.has('__pycache__')).toBe(true);
    });

    it('should have expected size', () => {
      // Document the current count for regression testing
      expect(DEFAULT_EXCLUDE_DIRS.size).toBe(18);
    });
  });

  describe('DEFAULT_EXCLUDE_EXTENSIONS', () => {
    it('should be a Set', () => {
      expect(DEFAULT_EXCLUDE_EXTENSIONS).toBeInstanceOf(Set);
    });

    it('should contain binary extensions', () => {
      expect(DEFAULT_EXCLUDE_EXTENSIONS.has('.pyc')).toBe(true);
      expect(DEFAULT_EXCLUDE_EXTENSIONS.has('.so')).toBe(true);
      expect(DEFAULT_EXCLUDE_EXTENSIONS.has('.exe')).toBe(true);
    });

    it('should have expected size', () => {
      expect(DEFAULT_EXCLUDE_EXTENSIONS.size).toBe(10);
    });
  });

  describe('DANGEROUS_PATTERNS', () => {
    it('should be an array', () => {
      expect(Array.isArray(DANGEROUS_PATTERNS)).toBe(true);
    });

    it('should contain known dangerous patterns', () => {
      expect(DANGEROUS_PATTERNS).toContain('rm -rf /');
      expect(DANGEROUS_PATTERNS).toContain(':(){:|:&};:');
    });

    it('should have expected length', () => {
      expect(DANGEROUS_PATTERNS.length).toBe(8);
    });
  });

  describe('DEFAULT_CACHE_CONFIG', () => {
    it('should have TTL of 1 minute', () => {
      expect(DEFAULT_CACHE_CONFIG.ttlMs).toBe(60000);
    });

    it('should have max size of 100', () => {
      expect(DEFAULT_CACHE_CONFIG.maxSize).toBe(100);
    });

    it('should define cacheable tools', () => {
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Read')).toBe(true);
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Glob')).toBe(true);
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Grep')).toBe(true);
    });

    it('should NOT include write tools in cacheable', () => {
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Write')).toBe(false);
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Edit')).toBe(false);
      expect(DEFAULT_CACHE_CONFIG.cacheableTools.has('Bash')).toBe(false);
    });
  });

  describe('DEFAULT_TOOL_CONFIG', () => {
    it('should enable core tools', () => {
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Read');
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Write');
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Edit');
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Bash');
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Glob');
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('Grep');
    });

    it('should enable conversation expansion tool', () => {
      expect(DEFAULT_TOOL_CONFIG.enabledTools).toContain('ExpandConversation');
    });

    it('should have bash timeout of 30 seconds', () => {
      expect(DEFAULT_TOOL_CONFIG.bashTimeoutMs).toBe(30000);
    });

    it('should have max output of 100000', () => {
      expect(DEFAULT_TOOL_CONFIG.maxOutputLength).toBe(100000);
    });
  });
});
