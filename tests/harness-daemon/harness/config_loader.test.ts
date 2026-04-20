import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, resolveBundledAssetPath } from 'harness-daemon/harness/config_loader.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-'));
}

describe('resolveBundledAssetPath', () => {
  it('finds bundled config by walking upward from a nested module directory', () => {
    const root = makeTempDir();
    const moduleDir = path.join(root, 'packages', 'infra', 'harness-daemon', 'dist', 'harness');
    const bundledConfig = path.join(root, 'config', 'defaults.json');

    fs.mkdirSync(moduleDir, { recursive: true });
    fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
    fs.writeFileSync(bundledConfig, '{}\n');

    expect(resolveBundledAssetPath('config/defaults.json', [moduleDir])).toBe(bundledConfig);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('checks search roots in order so install-local assets win over unrelated ancestors', () => {
    const firstRoot = makeTempDir();
    const secondRoot = makeTempDir();
    const firstStart = path.join(firstRoot, 'bin');
    const secondStart = path.join(secondRoot, 'packages', 'infra', 'harness-daemon', 'dist');
    const firstConfig = path.join(firstRoot, 'config', 'defaults.json');
    const secondConfig = path.join(secondRoot, 'config', 'defaults.json');

    fs.mkdirSync(firstStart, { recursive: true });
    fs.mkdirSync(secondStart, { recursive: true });
    fs.mkdirSync(path.dirname(firstConfig), { recursive: true });
    fs.mkdirSync(path.dirname(secondConfig), { recursive: true });
    fs.writeFileSync(firstConfig, '{"name":"first"}\n');
    fs.writeFileSync(secondConfig, '{"name":"second"}\n');

    expect(resolveBundledAssetPath('config/defaults.json', [firstStart, secondStart])).toBe(firstConfig);

    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  it('returns null when no bundled asset exists in any search root', () => {
    const root = makeTempDir();
    const startDir = path.join(root, 'packages', 'infra', 'harness-daemon', 'dist');

    fs.mkdirSync(startDir, { recursive: true });

    expect(resolveBundledAssetPath('config/defaults.json', [startDir])).toBeNull();

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('loadConfig role resolution', () => {
  it('does not default role-only agents to anthropic', () => {
    const config = loadConfig(path.resolve('config/defaults.json'));

    expect(config.agents.standard.llm.displayProvider).toBe('codex');
    expect(config.agents.standard.llm.model).toBe('gpt-5.3-codex');
    expect(config.agents.coding.llm.displayProvider).toBe('codex');
    expect(config.agents.coding.llm.model).toBe('gpt-5.3-codex');
  });
});
