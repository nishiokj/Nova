/**
 * Tests for PermissionChecker - default-deny permission system.
 *
 * Covers: path traversal, shell command parsing, delete detection,
 * rule priority cascade, restrictWriteToPaths, web search, dangerous mode,
 * session grants/denials, hydration, pending requests, and extractTarget.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PermissionChecker } from 'harness-daemon/harness/permissions.js';

// Use a temp directory as the "working directory" so we don't touch real fs
const TMP_ROOT = path.join(os.tmpdir(), `perm-test-${Date.now()}`);

function makeChecker(dangerous = false): PermissionChecker {
  // The constructor calls loadConfig which reads files; use the temp dir so
  // it finds nothing and starts with empty persistent rules.
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return new PermissionChecker(TMP_ROOT, dangerous);
}

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// =========================================================================
// Dangerous mode
// =========================================================================

describe('dangerous mode', () => {
  it('grants everything when enabled', () => {
    const checker = makeChecker(true);
    expect(checker.check('Bash', 'rm -rf /')).toEqual({ granted: true, reason: 'dangerous_mode' });
    expect(checker.check('Write', '../../../etc/passwd')).toEqual({ granted: true, reason: 'dangerous_mode' });
    expect(checker.check('Edit', 'any-file.ts')).toEqual({ granted: true, reason: 'dangerous_mode' });
  });

  it('can be toggled dynamically', () => {
    const checker = makeChecker(false);
    expect(checker.isDangerousMode()).toBe(false);
    checker.setDangerousMode(true);
    expect(checker.isDangerousMode()).toBe(true);
    expect(checker.check('Bash', 'echo hello')).toEqual({ granted: true, reason: 'dangerous_mode' });
  });

  it('grants web search when dangerous', () => {
    const checker = makeChecker(true);
    expect(checker.checkWebSearch()).toEqual({ granted: true, reason: 'dangerous_mode' });
  });
});

// =========================================================================
// Path traversal
// =========================================================================

describe('path traversal detection', () => {
  it('blocks Write targets that escape the working directory', () => {
    const checker = makeChecker();
    const decision = checker.check('Write', '../../../etc/passwd');
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe('path_traversal');
  });

  it('blocks Edit targets with .. traversal', () => {
    const checker = makeChecker();
    expect(checker.check('Edit', '../../secret.txt').granted).toBe(false);
  });

  it('allows paths within working directory', () => {
    const checker = makeChecker();
    const decision = checker.check('Write', 'src/index.ts');
    // Should be 'ask' because no rules match — but NOT path_traversal
    expect(decision.reason).not.toBe('path_traversal');
  });

  it('allows absolute paths within working directory', () => {
    const checker = makeChecker();
    const target = path.join(TMP_ROOT, 'src', 'index.ts');
    const decision = checker.check('Write', target);
    expect(decision.reason).not.toBe('path_traversal');
  });

  it('blocks absolute paths outside working directory', () => {
    const checker = makeChecker();
    const decision = checker.check('Write', '/etc/shadow');
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe('path_traversal');
  });

  it('allows outside-root paths when allowOutsideRoot is enabled', () => {
    const checker = makeChecker();
    checker.setAllowOutsideRoot(true);
    const decision = checker.check('Write', '/tmp/some-file.txt');
    // Should NOT be path_traversal; will be 'ask' because no rules match
    expect(decision.reason).not.toBe('path_traversal');
  });
});

// =========================================================================
// Bash chained command parsing
// =========================================================================

describe('chained command parsing', () => {
  it('checks each command in an && chain', () => {
    const checker = makeChecker();
    // With no rules, each command falls through to 'ask'
    const decision = checker.check('Bash', 'echo hello && echo world');
    expect(decision.granted).toBe('ask');
  });

  it('blocks the entire chain if any sub-command is denied', () => {
    const checker = makeChecker();
    // Grant everything via session, then deny 'rm *'.
    // Both sub-commands need to be allowed for the chain to pass,
    // and 'ask' for any sub-command short-circuits the whole chain.
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: 'echo *' }],
      sessionDenials: [{ tool: 'Bash', pattern: 'rm *' }],
      dangerousMode: false,
    });
    const decision = checker.check('Bash', 'echo safe && rm -rf /');
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe('session_denial');
  });

  it('returns ask for chain when any sub-command has no matching rule', () => {
    const checker = makeChecker();
    // Only 'echo *' is granted; 'rm -rf /' has no rule → ask
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: 'echo *' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    const decision = checker.check('Bash', 'echo safe && rm -rf /');
    expect(decision.granted).toBe('ask');
  });

  it('parses pipe operators', () => {
    const checker = makeChecker();
    // Both sides should be checked — falls through to 'ask'
    const decision = checker.check('Bash', 'cat file.txt | grep error');
    expect(decision.granted).toBe('ask');
  });

  it('parses semicolon-separated commands', () => {
    const checker = makeChecker();
    const decision = checker.check('Bash', 'cd /tmp; ls');
    expect(decision.granted).toBe('ask');
  });

  it('extracts command substitution $(...)', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: 'echo *' }],
      sessionDenials: [{ tool: 'Bash', pattern: 'whoami' }],
      dangerousMode: false,
    });
    // The main command is 'echo ...' (allowed), but the substitution 'whoami' is denied
    const decision = checker.check('Bash', 'echo $(whoami)');
    expect(decision.granted).toBe(false);
  });

  it('extracts backtick command substitution', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: 'echo *' }],
      sessionDenials: [{ tool: 'Bash', pattern: 'id' }],
      dangerousMode: false,
    });
    const decision = checker.check('Bash', 'echo `id`');
    expect(decision.granted).toBe(false);
  });
});

// =========================================================================
// Delete-like command detection (writesNoDeletes)
// =========================================================================

describe('writesNoDeletes mode', () => {
  it('blocks rm commands', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    // Add an allow-all rule so the only block is the delete check
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'rm file.txt').granted).toBe(false);
    expect(checker.check('Bash', 'rm -rf /tmp/stuff').granted).toBe(false);
  });

  it('blocks rmdir commands', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'rmdir mydir').granted).toBe(false);
  });

  it('blocks unlink commands', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'unlink file.txt').granted).toBe(false);
  });

  it('blocks git rm', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'git rm src/old.ts').granted).toBe(false);
  });

  it('blocks git clean', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'git clean -fd').granted).toBe(false);
  });

  it('blocks find -delete', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'find /tmp -name "*.log" -delete').granted).toBe(false);
  });

  it('allows non-delete commands', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'ls -la').granted).toBe(true);
    expect(checker.check('Bash', 'cat file.txt').granted).toBe(true);
    expect(checker.check('Bash', 'echo hello').granted).toBe(true);
  });

  it('blocks delete in chained commands', () => {
    const checker = makeChecker();
    checker.setWritesNoDeletes(true);
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: '*' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'echo safe && rm -rf /').granted).toBe(false);
  });
});

// =========================================================================
// Rule priority cascade
// =========================================================================

describe('rule priority cascade', () => {
  it('session denial takes precedence over session grant', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [{ tool: 'Bash', pattern: 'npm *' }],
      sessionDenials: [{ tool: 'Bash', pattern: 'npm *' }],
      dangerousMode: false,
    });
    // Denial should win
    expect(checker.check('Bash', 'npm install').granted).toBe(false);
  });

  it('session grant takes precedence over persistent deny', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [{ tool: 'Bash', pattern: 'npm *' }] },
      sessionGrants: [{ tool: 'Bash', pattern: 'npm *' }],
      sessionDenials: [],
      dangerousMode: false,
    });
    expect(checker.check('Bash', 'npm install').granted).toBe(true);
  });

  it('persistent deny takes precedence over persistent allow', () => {
    // hydrateState does not set persistent rules — those come from config files.
    // To test persistent priority, we write a config file the checker reads on construction.
    const projectDir = path.join(TMP_ROOT, 'persist-deny-test');
    const configDir = path.join(projectDir, '.config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(npm *)'],
        deny: ['Bash(npm *)'],
      },
    }));
    const checker = new PermissionChecker(projectDir, false);
    expect(checker.check('Bash', 'npm install').granted).toBe(false);
  });

  it('returns ask when no rules match', () => {
    const checker = makeChecker();
    const decision = checker.check('Bash', 'some-unknown-command');
    expect(decision.granted).toBe('ask');
    expect(decision.reason).toBe('no_matching_rule');
  });

  it('persistent allow grants when no denials match', () => {
    const projectDir = path.join(TMP_ROOT, 'persist-allow-test');
    const configDir = path.join(projectDir, '.config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(echo *)'],
        deny: [],
      },
    }));
    const checker = new PermissionChecker(projectDir, false);
    expect(checker.check('Bash', 'echo hello')).toEqual({ granted: true, reason: 'allow_rule' });
  });
});

// =========================================================================
// restrictWriteToPaths
// =========================================================================

describe('restrictWriteToPaths', () => {
  it('allows writes to listed paths', () => {
    const checker = makeChecker();
    checker.setRestrictWriteToPaths(['src/index.ts']);
    const decision = checker.check('Write', 'src/index.ts');
    expect(decision.granted).toBe(true);
    expect(decision.reason).toBe('allow_rule');
  });

  it('denies writes to unlisted paths', () => {
    const checker = makeChecker();
    checker.setRestrictWriteToPaths(['src/index.ts']);
    const decision = checker.check('Write', 'src/other.ts');
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe('deny_rule');
  });

  it('applies to Edit as well', () => {
    const checker = makeChecker();
    checker.setRestrictWriteToPaths(['src/index.ts']);
    const decision = checker.check('Edit', 'src/other.ts');
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe('deny_rule');
  });

  it('disables restriction when set to null', () => {
    const checker = makeChecker();
    checker.setRestrictWriteToPaths(['src/index.ts']);
    checker.setRestrictWriteToPaths(null);
    // Should fall through to normal rule checking (ask)
    const decision = checker.check('Write', 'src/other.ts');
    expect(decision.reason).not.toBe('deny_rule');
  });

  it('ignores empty strings and non-string entries', () => {
    const checker = makeChecker();
    checker.setRestrictWriteToPaths(['', '  ', 'src/valid.ts'] as string[]);
    expect(checker.check('Write', 'src/valid.ts').granted).toBe(true);
  });
});

// =========================================================================
// Web search
// =========================================================================

describe('web search', () => {
  it('allows by default', () => {
    const checker = makeChecker();
    expect(checker.checkWebSearch()).toEqual({ granted: true, reason: 'allow_rule' });
  });

  it('blocks when disabled', () => {
    const checker = makeChecker();
    checker.setWebSearchEnabled(false);
    expect(checker.checkWebSearch()).toEqual({ granted: false, reason: 'deny_rule' });
  });
});

// =========================================================================
// State hydration
// =========================================================================

describe('hydrateState', () => {
  it('sanitizes invalid rule lists', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [
        { tool: 'Bash', pattern: 'valid *' },
        { tool: 'InvalidTool' as any, pattern: 'bad' },
        null as any,
        { tool: 'Write', pattern: '' },
        { tool: 'Edit', pattern: 'valid-edit' },
      ] as any,
      sessionDenials: 'not an array' as any,
      dangerousMode: false,
    });
    const state = checker.getState();
    expect(state.sessionGrants).toHaveLength(2);
    expect(state.sessionGrants[0]).toEqual({ tool: 'Bash', pattern: 'valid *' });
    expect(state.sessionGrants[1]).toEqual({ tool: 'Edit', pattern: 'valid-edit' });
    expect(state.sessionDenials).toHaveLength(0);
  });

  it('preserves dangerousMode flag', () => {
    const checker = makeChecker();
    checker.hydrateState({
      persistent: { allow: [], deny: [] },
      sessionGrants: [],
      sessionDenials: [],
      dangerousMode: true,
    });
    expect(checker.isDangerousMode()).toBe(true);
  });
});

// =========================================================================
// Runtime flags
// =========================================================================

describe('runtime flags', () => {
  it('round-trips through get/hydrate', () => {
    const checker = makeChecker();
    checker.setAllowOutsideRoot(true);
    checker.setWebSearchEnabled(false);
    checker.setWritesNoDeletes(true);
    checker.setRestrictWriteToPaths(['a.ts', 'b.ts']);

    const flags = checker.getRuntimeFlags();
    expect(flags.allowOutsideRoot).toBe(true);
    expect(flags.webSearchEnabled).toBe(false);
    expect(flags.writesNoDeletes).toBe(true);
    expect(flags.restrictWriteToPaths).toBeDefined();

    // Hydrate into a fresh checker
    const checker2 = makeChecker();
    checker2.hydrateRuntimeFlags(flags);
    expect(checker2.isAllowOutsideRoot()).toBe(true);
    expect(checker2.isWebSearchEnabled()).toBe(false);
    expect(checker2.isWritesNoDeletesEnabled()).toBe(true);
  });

  it('handles undefined flags gracefully', () => {
    const checker = makeChecker();
    checker.hydrateRuntimeFlags(undefined);
    expect(checker.isAllowOutsideRoot()).toBe(false);
    expect(checker.isWebSearchEnabled()).toBe(true);
    expect(checker.isWritesNoDeletesEnabled()).toBe(false);
  });
});

// =========================================================================
// Pending requests
// =========================================================================

describe('pending requests', () => {
  it('registers and retrieves a pending request', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'echo hello', TMP_ROOT);
    checker.registerPendingRequest(request.requestId, request, () => {});
    expect(checker.getPendingRequest(request.requestId)).toEqual(request);
  });

  it('returns undefined for unknown request ID', () => {
    const checker = makeChecker();
    expect(checker.getPendingRequest('nonexistent')).toBeUndefined();
  });

  it('cancels a pending request', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'ls', TMP_ROOT);
    checker.registerPendingRequest(request.requestId, request, () => {});
    checker.cancelPendingRequest(request.requestId);
    expect(checker.getPendingRequest(request.requestId)).toBeUndefined();
  });

  it('handleResponse resolves and removes the pending request', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'echo test', TMP_ROOT);
    let resolved = false;
    checker.registerPendingRequest(request.requestId, request, () => {
      resolved = true;
    });

    checker.handleResponse({
      requestId: request.requestId,
      decision: 'allow',
    });

    expect(resolved).toBe(true);
    expect(checker.getPendingRequest(request.requestId)).toBeUndefined();
  });

  it('handleResponse with allow adds session grant', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'npm install', TMP_ROOT);
    checker.registerPendingRequest(request.requestId, request, () => {});

    checker.handleResponse({
      requestId: request.requestId,
      decision: 'allow',
    });

    const state = checker.getState();
    expect(state.sessionGrants.length).toBeGreaterThan(0);
  });

  it('handleResponse with deny adds session denial', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'npm install', TMP_ROOT);
    checker.registerPendingRequest(request.requestId, request, () => {});

    checker.handleResponse({
      requestId: request.requestId,
      decision: 'deny',
    });

    const state = checker.getState();
    expect(state.sessionDenials.length).toBeGreaterThan(0);
  });

  it('handleResponse is a no-op for unknown request ID', () => {
    const checker = makeChecker();
    // Should not throw
    checker.handleResponse({
      requestId: 'unknown',
      decision: 'allow',
    });
  });
});

// =========================================================================
// createRequest
// =========================================================================

describe('createRequest', () => {
  it('creates a Bash request with first-word wildcard pattern', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Bash', 'npm install lodash', TMP_ROOT);
    expect(request.tool).toBe('Bash');
    expect(request.suggestedPattern).toBe('npm *');
    expect(request.description).toContain('Run command');
  });

  it('creates a Write request with dir glob', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Write', 'src/components/Button.tsx', TMP_ROOT);
    expect(request.tool).toBe('Write');
    expect(request.suggestedPattern).toBe('src/**');
    expect(request.description).toContain('Create/overwrite file');
  });

  it('creates an Edit request with extension glob for root files', () => {
    const checker = makeChecker();
    const request = checker.createRequest('Edit', 'index.ts', TMP_ROOT);
    expect(request.suggestedPattern).toBe('*.ts');
    expect(request.description).toContain('Edit file');
  });

  it('generates a unique requestId', () => {
    const checker = makeChecker();
    const r1 = checker.createRequest('Bash', 'ls', TMP_ROOT);
    const r2 = checker.createRequest('Bash', 'ls', TMP_ROOT);
    expect(r1.requestId).not.toBe(r2.requestId);
  });
});

// =========================================================================
// extractTarget (static)
// =========================================================================

describe('extractTarget', () => {
  it('extracts command from Bash args', () => {
    expect(PermissionChecker.extractTarget('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('extracts file_path from Write args', () => {
    expect(PermissionChecker.extractTarget('Write', { file_path: '/tmp/a.txt' })).toBe('/tmp/a.txt');
  });

  it('extracts file_path from Edit args', () => {
    expect(PermissionChecker.extractTarget('Edit', { file_path: 'src/x.ts' })).toBe('src/x.ts');
  });

  it('falls back to path for Write/Edit', () => {
    expect(PermissionChecker.extractTarget('Write', { path: '/tmp/b.txt' })).toBe('/tmp/b.txt');
  });

  it('returns empty string for missing args', () => {
    expect(PermissionChecker.extractTarget('Bash', {})).toBe('');
    expect(PermissionChecker.extractTarget('Write', {})).toBe('');
  });
});
