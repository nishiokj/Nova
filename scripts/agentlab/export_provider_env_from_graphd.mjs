#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const LOCAL_USER_ID = 'local_user';
const AUTH_TAG_LENGTH = 16;

function usage() {
  const text = [
    'Usage: export_provider_env_from_graphd.mjs [options]',
    '',
    'Options:',
    '  --db-path <path>              GraphD sqlite path (default: ~/.graphd/graphd.db)',
    '  --master-key <path>           Master key path (default: ~/.config/rex/master.key)',
    '  --provider <id=ENV_NAME>      Provider/env mapping (repeatable)',
    '  --allow-missing               Skip missing providers instead of failing',
    '  --format <shell|dotenv|json>  Output format (default: shell)',
    '  --check                       Validate availability without printing secrets',
    '  --help                        Show this help',
    '',
    'Defaults when no --provider is passed:',
    '  openai=OPENAI_API_KEY',
    '  z.ai-coder=ZAI_CODER_API_KEY',
  ].join('\n');
  console.error(text);
}

function expandHome(pathLike) {
  if (!pathLike) return pathLike;
  if (pathLike === '~') return homedir();
  if (pathLike.startsWith('~/')) return `${homedir()}/${pathLike.slice(2)}`;
  return pathLike;
}

function parseProviderMapping(raw) {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(`Invalid --provider mapping: ${raw} (expected provider=ENV_NAME)`);
  }
  const provider = raw.slice(0, eq).trim();
  const envName = raw.slice(eq + 1).trim();
  if (!provider || !envName) {
    throw new Error(`Invalid --provider mapping: ${raw} (expected provider=ENV_NAME)`);
  }
  return { provider, envName };
}

function parseArgs(argv) {
  const out = {
    dbPath: '~/.graphd/graphd.db',
    masterKeyPath: '~/.config/rex/master.key',
    providers: [],
    allowMissing: false,
    format: 'shell',
    checkOnly: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--db-path') {
      if (!next) throw new Error('--db-path requires a value');
      out.dbPath = next;
      i += 1;
      continue;
    }
    if (arg === '--master-key') {
      if (!next) throw new Error('--master-key requires a value');
      out.masterKeyPath = next;
      i += 1;
      continue;
    }
    if (arg === '--provider') {
      if (!next) throw new Error('--provider requires a value');
      out.providers.push(parseProviderMapping(next));
      i += 1;
      continue;
    }
    if (arg === '--allow-missing') {
      out.allowMissing = true;
      continue;
    }
    if (arg === '--check') {
      out.checkOnly = true;
      continue;
    }
    if (arg === '--format') {
      if (!next) throw new Error('--format requires a value');
      if (!['shell', 'dotenv', 'json'].includes(next)) {
        throw new Error(`Unsupported --format: ${next}`);
      }
      out.format = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (out.providers.length === 0) {
    out.providers = [
      { provider: 'openai', envName: 'OPENAI_API_KEY' },
      { provider: 'z.ai-coder', envName: 'ZAI_CODER_API_KEY' },
    ];
  }

  return out;
}

function loadMasterKey(masterKeyPath) {
  if (!existsSync(masterKeyPath)) {
    throw new Error(`Master key not found: ${masterKeyPath}`);
  }
  const raw = readFileSync(masterKeyPath, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`Invalid master key format in ${masterKeyPath} (expected 64 hex chars)`);
  }
  return Buffer.from(raw, 'hex');
}

function decryptCredential(encryptedKeyB64, ivB64, masterKey) {
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertextWithTag = Buffer.from(encryptedKeyB64, 'base64');
  if (ciphertextWithTag.length <= AUTH_TAG_LENGTH) {
    throw new Error('Encrypted payload too short');
  }
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return decrypted
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\[200~/g, '')
    .replace(/\[201~/g, '')
    .trim();
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function emitOutput(format, envMap) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(envMap, null, 2)}\n`);
    return;
  }
  const lines = [];
  for (const [envName, value] of Object.entries(envMap)) {
    if (format === 'dotenv') {
      lines.push(`${envName}=${JSON.stringify(value)}`);
    } else {
      lines.push(`export ${envName}=${shellQuote(value)}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolve(expandHome(args.dbPath));
  const masterKeyPath = resolve(expandHome(args.masterKeyPath));

  if (!existsSync(dbPath)) {
    throw new Error(`GraphD database not found: ${dbPath}`);
  }
  const masterKey = loadMasterKey(masterKeyPath);
  const db = new Database(dbPath, { readonly: true });

  const envMap = {};
  const missing = [];
  try {
    const stmt = db.query(
      `SELECT provider, encrypted_key, iv
         FROM provider_credentials
        WHERE user_id = ? AND provider = ?
        LIMIT 1`
    );

    for (const mapping of args.providers) {
      const row = stmt.get(LOCAL_USER_ID, mapping.provider);
      if (!row) {
        missing.push(mapping.provider);
        continue;
      }
      const decrypted = decryptCredential(row.encrypted_key, row.iv, masterKey);
      envMap[mapping.envName] = decrypted;
    }
  } finally {
    db.close();
  }

  if (missing.length > 0 && !args.allowMissing) {
    throw new Error(
      `Missing provider credential(s) in GraphD for user '${LOCAL_USER_ID}': ${missing.join(', ')}`
    );
  }

  if (args.checkOnly) {
    const exported = Object.keys(envMap);
    const msg = [
      `db=${dbPath}`,
      `master_key=${masterKeyPath}`,
      `resolved=${exported.length}`,
      exported.length ? `env=${exported.join(',')}` : 'env=',
      missing.length ? `missing=${missing.join(',')}` : 'missing=',
    ].join(' ');
    console.error(msg);
    return;
  }

  emitOutput(args.format, envMap);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

