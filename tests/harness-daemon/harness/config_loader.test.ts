import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createConfigFromFile, loadConfig, resolveBundledAssetPath } from 'harness-daemon/harness/config_loader.js';
import type { HarnessConfigFile } from 'harness-daemon/harness/config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-'));
}

function loadDefaultConfigFile(): HarnessConfigFile {
  return JSON.parse(fs.readFileSync(path.resolve('config/defaults.json'), 'utf-8')) as HarnessConfigFile;
}

function withSubstrateEnv(
  host: string | undefined,
  environmentId: string | undefined,
  callback: () => void
): void {
  const previousHost = process.env.NOVA_SUBSTRATE_HOST_BASE_URL;
  const previousEnvironmentId = process.env.NOVA_SUBSTRATE_ENVIRONMENT_ID;
  if (host === undefined) {
    delete process.env.NOVA_SUBSTRATE_HOST_BASE_URL;
  } else {
    process.env.NOVA_SUBSTRATE_HOST_BASE_URL = host;
  }
  if (environmentId === undefined) {
    delete process.env.NOVA_SUBSTRATE_ENVIRONMENT_ID;
  } else {
    process.env.NOVA_SUBSTRATE_ENVIRONMENT_ID = environmentId;
  }

  try {
    callback();
  } finally {
    if (previousHost === undefined) {
      delete process.env.NOVA_SUBSTRATE_HOST_BASE_URL;
    } else {
      process.env.NOVA_SUBSTRATE_HOST_BASE_URL = previousHost;
    }
    if (previousEnvironmentId === undefined) {
      delete process.env.NOVA_SUBSTRATE_ENVIRONMENT_ID;
    } else {
      process.env.NOVA_SUBSTRATE_ENVIRONMENT_ID = previousEnvironmentId;
    }
  }
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
    expect(config.agents.explorer.llm.displayProvider).toBe('codex');
    expect(config.agents.explorer.llm.model).toBe('gpt-5.3-codex');
  });

  it('does not ship the specialized coding subagent in default config', () => {
    const config = loadConfig(path.resolve('config/defaults.json'));

    expect(config.agents).not.toHaveProperty('coding');
    expect(config.agents.standard.tools).not.toContain('coding');
  });
});

describe('loadConfig substrate HTTP config', () => {
  it('resolves HTTP attach settings from tools config', () => {
    withSubstrateEnv(undefined, undefined, () => {
      const fileConfig = loadDefaultConfigFile();
      fileConfig.tools = {
        ...(fileConfig.tools ?? {}),
        substrate_host_base_url: 'http://127.0.0.1:8765/',
        substrate_environment_id: 'env_shared',
      };

      const config = createConfigFromFile(fileConfig, process.cwd());

      expect(config.tools.substrateHostBaseUrl).toBe('http://127.0.0.1:8765/');
      expect(config.tools.substrateEnvironmentId).toBe('env_shared');
    });
  });

  it('allows environment variables to configure substrate HTTP attach', () => {
    withSubstrateEnv('http://127.0.0.1:9876/', 'env_from_env', () => {
      const config = createConfigFromFile(loadDefaultConfigFile(), process.cwd());

      expect(config.tools.substrateHostBaseUrl).toBe('http://127.0.0.1:9876/');
      expect(config.tools.substrateEnvironmentId).toBe('env_from_env');
    });
  });

  it('requires a substrate HTTP host when an environment id is configured', () => {
    withSubstrateEnv(undefined, undefined, () => {
      const fileConfig = loadDefaultConfigFile();
      fileConfig.tools = {
        ...(fileConfig.tools ?? {}),
        substrate_environment_id: 'env_without_host',
      };

      expect(() => createConfigFromFile(fileConfig, process.cwd()))
        .toThrow('tools.substrate_environment_id requires tools.substrate_host_base_url');
    });
  });
});
