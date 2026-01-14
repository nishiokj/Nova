# Distribution Implementation Spec

This spec covers packaging fixes, web distribution via install scripts, and GitHub Actions for security, linting, and releases.

---

## Part 1: Packaging Fixes

### 1.1 Current Issues

| Issue | Location | Problem |
|-------|----------|---------|
| Wrong paths | `packages/launcher/index.ts:39` | References `apps/harness-daemon` but structure is `packages/harness-daemon` |
| workspace deps | `packages/*/package.json` | `workspace:*` doesn't resolve in bundled output |
| Bun shebang | Multiple entry files | `#!/usr/bin/env bun` requires Bun installed |
| External wasm | `packages/tui/package.json:10` | `yoga.wasm` copied separately, not embedded |
| Config paths | `packages/launcher/index.ts:68` | Assumes `config/` dir relative to install location |

### 1.2 Solution: Single Binary with Embedded Assets

The binary must be fully self-contained. No external files except user config at `~/.rex/config.json`.

#### 1.2.1 Create unified entry point

Create `packages/launcher/standalone.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Standalone entry - bundles daemon + tui into single process
 * For distribution builds only.
 */

import { parseArgs } from 'util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'daemon-only': { type: 'boolean', default: false },
    'version': { type: 'boolean', short: 'v', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.version) {
  // Embedded at build time
  console.log(`rex ${process.env.REX_VERSION ?? 'dev'}`);
  process.exit(0);
}

if (values.help) {
  console.log(`Usage: rex [options] [prompt]

Options:
  --daemon-only  Run daemon in foreground without TUI
  -v, --version  Print version
  -h, --help     Show this help
`);
  process.exit(0);
}

// Import daemon and tui directly - bundler will inline them
if (values['daemon-only']) {
  const { runHarnessDaemon } = await import('../harness-daemon/src/harness/daemon.js');
  await runHarnessDaemon();
} else {
  // Start daemon in-process, then TUI
  const { runHarnessDaemon } = await import('../harness-daemon/src/harness/daemon.js');

  // Run daemon in background task
  const daemonPromise = runHarnessDaemon().catch(err => {
    console.error('[rex] Daemon error:', err);
  });

  // Small delay for daemon to initialize
  await new Promise(r => setTimeout(r, 200));

  // Start TUI (this blocks until exit)
  const { startTui } = await import('../tui/main.js');
  await startTui();

  process.exit(0);
}
```

#### 1.2.2 Refactor TUI for importable entry

Extract TUI startup into `packages/tui/main.ts`:

```typescript
export async function startTui(): Promise<void> {
  // Move current index.tsx render() logic here
  // Return promise that resolves on exit
}
```

Keep `index.tsx` as thin wrapper that calls `startTui()`.

#### 1.2.3 Embed default config

Create `packages/launcher/default-config.ts`:

```typescript
export const DEFAULT_CONFIG = {
  providers: {
    anthropic: {
      api_key: "${ANTHROPIC_API_KEY}",
      models: ["claude-sonnet-4-20250514"]
    }
  },
  default_provider: "anthropic",
  // ... rest of harness_config.json structure
};
```

Update config loader to:
1. Check `~/.rex/config.json` first
2. Fall back to embedded `DEFAULT_CONFIG`
3. On first run, write `DEFAULT_CONFIG` to `~/.rex/config.json`

#### 1.2.4 Handle yoga.wasm

Bun's `--compile` embeds assets via `Bun.file()` with static paths. Update TUI to:

```typescript
// Instead of runtime path resolution
import yogaWasm from 'yoga-wasm-web/dist/yoga.wasm';
```

Or use `--asset-naming` flag during build.

### 1.3 Build Script

Create `scripts/build-release.ts`:

```typescript
#!/usr/bin/env bun
import { $ } from 'bun';

const VERSION = process.env.VERSION ?? '0.1.0';
const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
];

const ENTRY = './packages/launcher/standalone.ts';
const OUT_DIR = './dist/binaries';

await $`mkdir -p ${OUT_DIR}`;

for (const target of TARGETS) {
  const ext = target.includes('windows') ? '.exe' : '';
  const outName = `rex-${target.replace('bun-', '')}${ext}`;

  console.log(`Building ${outName}...`);

  await $`bun build --compile \
    --target=${target} \
    --minify \
    --sourcemap=external \
    --define process.env.REX_VERSION='"${VERSION}"' \
    ${ENTRY} \
    --outfile ${OUT_DIR}/${outName}`;
}

// Generate checksums
await $`cd ${OUT_DIR} && shasum -a 256 * > checksums.txt`;

console.log('Build complete. Binaries in dist/binaries/');
```

### 1.4 File Structure After Changes

```
packages/
├── launcher/
│   ├── index.ts              # Dev entry (spawns separate processes)
│   ├── standalone.ts         # NEW: Distribution entry (single process)
│   ├── default-config.ts     # NEW: Embedded default config
│   └── package.json
├── tui/
│   ├── index.tsx             # Dev entry
│   ├── main.ts               # NEW: Importable entry
│   └── ...
├── harness-daemon/
│   └── ...
scripts/
├── build-release.ts          # NEW: Cross-platform build script
dist/
└── binaries/                  # NEW: Built binaries (gitignored)
    ├── rex-linux-x64
    ├── rex-linux-arm64
    ├── rex-darwin-x64
    ├── rex-darwin-arm64
    ├── rex-windows-x64.exe
    └── checksums.txt
```

---

## Part 2: Web Distribution

### 2.1 Install Script (Unix)

Create `scripts/install.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Configuration
REPO="yourorg/rex"
BINARY_NAME="rex"
INSTALL_DIR="${REX_INSTALL_DIR:-$HOME/.rex/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[info]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }

# Detect platform
detect_platform() {
  local os arch

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    mingw*|msys*|cygwin*) os="windows" ;;
    *) error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# Get latest version from GitHub
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | cut -d'"' -f4
}

# Download and verify binary
download_binary() {
  local version=$1
  local platform=$2
  local ext=""

  [[ "$platform" == windows-* ]] && ext=".exe"

  local filename="${BINARY_NAME}-${platform}${ext}"
  local url="https://github.com/${REPO}/releases/download/${version}/${filename}"
  local checksum_url="https://github.com/${REPO}/releases/download/${version}/checksums.txt"

  info "Downloading ${filename}..."

  local tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  curl -fsSL "$url" -o "${tmp_dir}/${filename}"
  curl -fsSL "$checksum_url" -o "${tmp_dir}/checksums.txt"

  # Verify checksum
  info "Verifying checksum..."
  cd "$tmp_dir"
  if command -v shasum &>/dev/null; then
    shasum -a 256 -c checksums.txt --ignore-missing
  elif command -v sha256sum &>/dev/null; then
    sha256sum -c checksums.txt --ignore-missing
  else
    warn "No checksum tool found, skipping verification"
  fi

  # Install
  mkdir -p "$INSTALL_DIR"
  mv "${tmp_dir}/${filename}" "${INSTALL_DIR}/${BINARY_NAME}"
  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
}

# Update shell config
setup_path() {
  local shell_config=""
  local path_line="export PATH=\"\$PATH:${INSTALL_DIR}\""

  case "$SHELL" in
    */zsh) shell_config="$HOME/.zshrc" ;;
    */bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        shell_config="$HOME/.bashrc"
      else
        shell_config="$HOME/.bash_profile"
      fi
      ;;
    */fish)
      shell_config="$HOME/.config/fish/config.fish"
      path_line="set -gx PATH \$PATH ${INSTALL_DIR}"
      ;;
  esac

  if [[ -n "$shell_config" ]] && ! grep -q "$INSTALL_DIR" "$shell_config" 2>/dev/null; then
    echo "" >> "$shell_config"
    echo "# Rex" >> "$shell_config"
    echo "$path_line" >> "$shell_config"
    info "Added ${INSTALL_DIR} to PATH in ${shell_config}"
    warn "Restart your shell or run: source ${shell_config}"
  fi
}

main() {
  info "Rex Installer"

  local platform=$(detect_platform)
  info "Detected platform: ${platform}"

  local version=${REX_VERSION:-$(get_latest_version)}
  info "Installing version: ${version}"

  download_binary "$version" "$platform"
  setup_path

  info "Installation complete!"
  info "Run 'rex --help' to get started"
}

main "$@"
```

### 2.2 Install Script (Windows PowerShell)

Create `scripts/install.ps1`:

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# Configuration
$Repo = "yourorg/rex"
$BinaryName = "rex"
$InstallDir = if ($env:REX_INSTALL_DIR) { $env:REX_INSTALL_DIR } else { "$env:USERPROFILE\.rex\bin" }

function Write-Info { param($msg) Write-Host "[info] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

# Detect architecture
function Get-Platform {
    $arch = if ([Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    } else {
        Write-Err "32-bit Windows is not supported"
    }
    return "windows-$arch"
}

# Get latest version
function Get-LatestVersion {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    return $release.tag_name
}

# Download binary
function Install-Binary {
    param($Version, $Platform)

    $filename = "$BinaryName-$Platform.exe"
    $url = "https://github.com/$Repo/releases/download/$Version/$filename"
    $checksumUrl = "https://github.com/$Repo/releases/download/$Version/checksums.txt"

    Write-Info "Downloading $filename..."

    # Create install directory
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $outPath = Join-Path $InstallDir "$BinaryName.exe"
    Invoke-WebRequest -Uri $url -OutFile $outPath

    # Verify checksum
    Write-Info "Verifying checksum..."
    $checksums = (Invoke-WebRequest -Uri $checksumUrl).Content
    $expectedHash = ($checksums -split "`n" | Where-Object { $_ -match $filename } | ForEach-Object { ($_ -split "\s+")[0] })
    $actualHash = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash.ToLower()

    if ($expectedHash -and $actualHash -ne $expectedHash) {
        Remove-Item $outPath
        Write-Err "Checksum verification failed!"
    }

    Write-Info "Installed to $outPath"
}

# Add to PATH
function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
        Write-Info "Added $InstallDir to PATH"
        Write-Warn "Restart your terminal for PATH changes to take effect"
    }
}

# Main
function Main {
    Write-Info "Rex Installer for Windows"

    $platform = Get-Platform
    Write-Info "Detected platform: $platform"

    $version = if ($env:REX_VERSION) { $env:REX_VERSION } else { Get-LatestVersion }
    Write-Info "Installing version: $version"

    Install-Binary -Version $version -Platform $platform
    Add-ToPath

    Write-Info "Installation complete!"
    Write-Info "Run 'rex --help' to get started"
}

Main
```

### 2.3 Hosting Options

| Option | Pros | Cons | Cost |
|--------|------|------|------|
| GitHub Releases | Free, automatic with Actions, trusted domain | 5GB per file limit | Free |
| Cloudflare R2 | Free egress, fast global CDN | Requires setup | ~$0.015/GB storage |
| AWS S3 + CloudFront | Reliable, scalable | Egress costs | ~$0.09/GB egress |

**Recommendation**: Start with GitHub Releases. Migrate to R2/S3 if you need custom domain or analytics.

### 2.4 Landing Page Snippet

For your website, add:

```html
<!-- Unix -->
<pre><code>curl -fsSL https://yoursite.dev/install.sh | sh</code></pre>

<!-- Windows -->
<pre><code>irm https://yoursite.dev/install.ps1 | iex</code></pre>
```

If using GitHub Pages, host scripts in repo and use:
```
https://raw.githubusercontent.com/yourorg/rex/main/scripts/install.sh
```

---

## Part 3: GitHub Actions

### 3.1 Directory Structure

```
.github/
├── workflows/
│   ├── ci.yml           # Lint + test on every PR
│   ├── security.yml     # Security scanning
│   └── release.yml      # Build + publish releases
└── dependabot.yml       # Dependency updates
```

### 3.2 CI Workflow (Lint + Test)

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun run lint

      - name: Check formatting
        run: bunx biome check --error-on-warnings .

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bun test

  build:
    name: Build Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build packages
        run: bun run build
```

### 3.3 Security Workflow

Create `.github/workflows/security.yml`:

```yaml
name: Security

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    # Run weekly on Monday at 00:00 UTC
    - cron: '0 0 * * 1'

permissions:
  contents: read
  security-events: write

jobs:
  dependency-audit:
    name: Dependency Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # Bun doesn't have built-in audit, use npm for this
      - name: Audit dependencies
        run: bunx audit-ci --config audit-ci.json
        continue-on-error: true

  codeql:
    name: CodeQL Analysis
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: typescript
          queries: security-and-quality

      - name: Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3

  secrets-scan:
    name: Secret Scanning
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  semgrep:
    name: Semgrep SAST
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4

      - name: Run Semgrep
        run: semgrep scan --config auto --error --json -o semgrep-results.json .

      - name: Upload results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: semgrep-results.json
        if: always()
```

### 3.4 Release Workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    name: Build ${{ matrix.target }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: linux-x64
            os: ubuntu-latest
            bun-target: bun-linux-x64
          - target: linux-arm64
            os: ubuntu-latest
            bun-target: bun-linux-arm64
          - target: darwin-x64
            os: macos-latest
            bun-target: bun-darwin-x64
          - target: darwin-arm64
            os: macos-latest
            bun-target: bun-darwin-arm64
          - target: windows-x64
            os: windows-latest
            bun-target: bun-windows-x64

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Get version
        id: version
        shell: bash
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: Build binary
        shell: bash
        run: |
          EXT=""
          if [[ "${{ matrix.target }}" == windows-* ]]; then
            EXT=".exe"
          fi

          bun build --compile \
            --target=${{ matrix.bun-target }} \
            --minify \
            --define "process.env.REX_VERSION='\"${{ steps.version.outputs.VERSION }}\"'" \
            ./packages/launcher/standalone.ts \
            --outfile ./rex-${{ matrix.target }}${EXT}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: rex-${{ matrix.target }}
          path: rex-${{ matrix.target }}*

  release:
    name: Create Release
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: ./artifacts
          merge-multiple: true

      - name: Generate checksums
        run: |
          cd artifacts
          sha256sum rex-* > checksums.txt
          cat checksums.txt

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/rex-*
            artifacts/checksums.txt
          generate_release_notes: true
          draft: false
          prerelease: ${{ contains(github.ref, '-') }}

  update-install-scripts:
    name: Update Install Scripts
    needs: release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main

      # Optional: Update version in install scripts if hardcoded
      # Or update a latest-version.txt file for the scripts to read
      - name: Update version file
        run: |
          echo "${GITHUB_REF#refs/tags/}" > latest-version.txt

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add latest-version.txt
          git diff --staged --quiet || git commit -m "chore: update latest version to ${GITHUB_REF#refs/tags/}"
          git push
```

### 3.5 Dependabot Configuration

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      dev-dependencies:
        patterns:
          - "@types/*"
          - "typescript"
        update-types:
          - "minor"
          - "patch"
    commit-message:
      prefix: "deps"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    commit-message:
      prefix: "ci"
```

### 3.6 Audit Configuration

Create `audit-ci.json`:

```json
{
  "$schema": "https://github.com/IBM/audit-ci/raw/main/docs/schema.json",
  "critical": true,
  "high": true,
  "moderate": false,
  "low": false,
  "allowlist": []
}
```

---

## Part 4: Implementation Order

### Phase 1: Fix Packaging (Day 1)
1. [ ] Create `packages/launcher/standalone.ts`
2. [ ] Refactor `packages/tui/main.ts` for import
3. [ ] Create `packages/launcher/default-config.ts`
4. [ ] Create `scripts/build-release.ts`
5. [ ] Test local build with `bun run scripts/build-release.ts`
6. [ ] Verify binary runs on local machine

### Phase 2: GitHub Actions (Day 1-2)
1. [ ] Create `.github/workflows/ci.yml`
2. [ ] Create `.github/workflows/security.yml`
3. [ ] Create `.github/dependabot.yml`
4. [ ] Create `audit-ci.json`
5. [ ] Push and verify CI passes
6. [ ] Create `.github/workflows/release.yml`

### Phase 3: Distribution (Day 2)
1. [ ] Create `scripts/install.sh`
2. [ ] Create `scripts/install.ps1`
3. [ ] Test install scripts locally
4. [ ] Create first release tag (`git tag v0.1.0 && git push --tags`)
5. [ ] Verify release workflow creates binaries
6. [ ] Test install scripts pull from release

### Phase 4: Polish
1. [ ] Add macOS code signing (requires Apple Developer account)
2. [ ] Add Windows code signing (requires certificate)
3. [ ] Set up custom domain for install scripts (optional)
4. [ ] Add auto-update mechanism to binary (optional)

---

## Appendix: macOS Code Signing

For notarized macOS binaries (prevents "unidentified developer" warning):

```yaml
# Add to release.yml for darwin builds
- name: Sign binary (macOS)
  if: startsWith(matrix.target, 'darwin')
  env:
    APPLE_CERT_BASE64: ${{ secrets.APPLE_CERT_BASE64 }}
    APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
  run: |
    # Import certificate
    echo "$APPLE_CERT_BASE64" | base64 --decode > cert.p12
    security create-keychain -p "" build.keychain
    security import cert.p12 -k build.keychain -P "$APPLE_CERT_PASSWORD" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k "" build.keychain

    # Sign
    codesign --force --options runtime --sign "$APPLE_TEAM_ID" ./rex-${{ matrix.target }}

    # Notarize
    xcrun notarytool submit ./rex-${{ matrix.target }} \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_ID_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
```

Requires Apple Developer Program ($99/year).
