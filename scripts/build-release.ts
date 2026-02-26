#!/usr/bin/env bun
/**
 * Build script for creating cross-platform release binaries.
 *
 * Usage:
 *   bun run scripts/build-release.ts
 *   VERSION=1.0.0 bun run scripts/build-release.ts
 *   bun run scripts/build-release.ts --target linux-x64
 */

import { $ } from 'bun';
import { parseArgs } from 'util';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: 'string', short: 'v' },
    target: { type: 'string', short: 't' },
    'skip-checksums': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Nova Release Build Script

Usage:
  bun run scripts/build-release.ts [options]

Options:
  -v, --version <ver>   Set version (default: env VERSION or 0.1.0)
  -t, --target <target> Build only specific target (e.g., linux-x64)
  --skip-checksums      Skip checksum generation
  -h, --help            Show this help

Targets:
  linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64

Examples:
  bun run scripts/build-release.ts
  VERSION=1.0.0 bun run scripts/build-release.ts
  bun run scripts/build-release.ts --target darwin-arm64
`);
  process.exit(0);
}

const VERSION = values.version ?? process.env.VERSION ?? '0.1.0';

interface Target {
  name: string;
  bunTarget: string;
  ext: string;
}

const ALL_TARGETS: Target[] = [
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', ext: '' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', ext: '' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', ext: '' },
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', ext: '' },
  { name: 'windows-x64', bunTarget: 'bun-windows-x64', ext: '.exe' },
];

const ENTRY = './packages/apps/launcher/standalone.ts';
const OUT_DIR = './dist/binaries';

async function main() {
  console.log(`Building Nova v${VERSION}`);
  console.log('='.repeat(40));

  // Create output directory
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  // Filter targets if specific one requested
  const targets = values.target
    ? ALL_TARGETS.filter(t => t.name === values.target)
    : ALL_TARGETS;

  if (targets.length === 0) {
    console.error(`Unknown target: ${values.target}`);
    console.error(`Available targets: ${ALL_TARGETS.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  const built: string[] = [];
  const failed: string[] = [];

  for (const target of targets) {
    const outName = `nova-${target.name}${target.ext}`;
    const outPath = path.join(OUT_DIR, outName);

    console.log(`\nBuilding ${outName}...`);

    try {
      // Build the binary
      await $`bun build --compile \
        --target=${target.bunTarget} \
        --minify \
        --sourcemap=external \
        --define "process.env.NOVA_VERSION='\"${VERSION}\"'" \
        ${ENTRY} \
        --outfile ${outPath}`.quiet();

      // Verify the binary was created
      if (existsSync(outPath)) {
        const stat = Bun.file(outPath);
        const sizeMB = (await stat.arrayBuffer()).byteLength / (1024 * 1024);
        console.log(`  ✓ ${outName} (${sizeMB.toFixed(2)} MB)`);
        built.push(outName);
      } else {
        throw new Error('Binary not created');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Failed to build ${outName}: ${message}`);
      failed.push(outName);
    }
  }

  // Generate checksums
  if (!values['skip-checksums'] && built.length > 0) {
    console.log('\nGenerating checksums...');
    try {
      // Use Node.js crypto for cross-platform compatibility
      const { createHash } = await import('crypto');
      const checksums: string[] = [];

      for (const name of built) {
        const filePath = path.join(OUT_DIR, name);
        const file = Bun.file(filePath);
        const buffer = await file.arrayBuffer();
        const hash = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
        checksums.push(`${hash}  ${name}`);
      }

      const checksumPath = path.join(OUT_DIR, 'checksums.txt');
      await Bun.write(checksumPath, checksums.join('\n') + '\n');
      console.log(`  ✓ checksums.txt`);
    } catch (error) {
      console.error('  ✗ Failed to generate checksums:', error);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(40));
  console.log('Build Summary:');
  console.log(`  Version: ${VERSION}`);
  console.log(`  Output: ${OUT_DIR}`);
  console.log(`  Built: ${built.length}/${targets.length}`);

  if (built.length > 0) {
    console.log(`  Binaries: ${built.join(', ')}`);
  }

  if (failed.length > 0) {
    console.log(`  Failed: ${failed.join(', ')}`);
    process.exit(1);
  }

  console.log('\nBuild complete!');
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
