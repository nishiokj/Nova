import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackFile {
  path: string;
}

interface PackResult {
  files: PackFile[];
}

function isForbiddenPublicPath(filepath: string): boolean {
  return filepath === '.agent'
    || filepath.startsWith('.agent/')
    || filepath === '.lab'
    || filepath.startsWith('.lab/')
    || filepath.includes('/skills/')
    || filepath === 'scripts/build-nova-artifact.ts';
}

describe('public distribution boundary', () => {
  it('does not whitelist local skills or lab artifacts in package.json', () => {
    const manifestPath = path.resolve(process.cwd(), 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: string[] };
    const files = manifest.files ?? [];
    const positivePatterns = files.filter((entry) => !entry.startsWith('!'));

    expect(positivePatterns.filter(isForbiddenPublicPath)).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([
      '!packages/core/protocol/**',
      '!packages/infra/harness-client/**',
      '!.agent/**',
      '!.lab/**',
      '!**/skills/**',
      '!scripts/build-nova-artifact.ts',
    ]));
  });

  it('does not expose the specialized coding subagent in public defaults', () => {
    const defaultsPath = path.resolve(process.cwd(), 'config/defaults.json');
    const defaults = JSON.parse(readFileSync(defaultsPath, 'utf8')) as {
      agents?: Record<string, { tools?: string[] }>;
    };
    const agents = defaults.agents ?? {};

    expect(agents).not.toHaveProperty('coding');
    expect(agents.standard?.tools ?? []).not.toContain('coding');
    for (const [agentType, agentConfig] of Object.entries(agents)) {
      expect(agentConfig.tools ?? [], `${agentType} default tools`).not.toContain('coding');
    }
  });

  it('does not include local skills or lab artifacts in the npm packlist', () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'nova-npm-pack-cache-'));
    try {
      const raw = execFileSync(
        'npm',
        ['--cache', cacheDir, 'pack', '--dry-run', '--json', '--ignore-scripts'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      const [result] = JSON.parse(raw) as PackResult[];
      const packPaths = result.files.map((file) => file.path);

      expect(packPaths.filter(isForbiddenPublicPath)).toEqual([]);
      expect(packPaths.some((file) => file.startsWith('packages/core/protocol/'))).toBe(false);
      expect(packPaths.some((file) => file.startsWith('packages/infra/harness-client/'))).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('keeps the TypeScript client on the protocol boundary', () => {
    const clientManifestPath = path.resolve(process.cwd(), 'packages/infra/harness-client/package.json');
    const protocolManifestPath = path.resolve(process.cwd(), 'packages/core/protocol/package.json');
    const clientManifest = JSON.parse(readFileSync(clientManifestPath, 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    const protocolManifest = JSON.parse(readFileSync(protocolManifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(clientManifest.name).toBe('@nova/client');
    expect(clientManifest.dependencies).toMatchObject({
      '@nova/protocol': '0.1.0',
    });
    expect(clientManifest.dependencies).not.toHaveProperty('comms-bus');
    expect(clientManifest.dependencies).not.toHaveProperty('shared');
    expect(Object.values(clientManifest.dependencies ?? {})).not.toContain('workspace:*');
    expect(protocolManifest.dependencies ?? {}).toEqual({});
  });

  it('keeps service image context rules aligned with public distribution rules', () => {
    const dockerignore = readFileSync(path.resolve(process.cwd(), '.dockerignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(dockerignore).toEqual(expect.arrayContaining([
      '.agent/**',
      '.lab/**',
      'docs/**',
      '**/skills/**',
      'scripts/build-nova-artifact.ts',
    ]));
  });
});
