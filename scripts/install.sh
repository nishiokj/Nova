#!/bin/bash
set -euo pipefail

# Rex CLI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/yourorg/rex/main/scripts/install.sh | sh

# Configuration - UPDATE THESE FOR YOUR REPO
REPO="yourorg/rex"
BINARY_NAME="rex"
INSTALL_DIR="${REX_INSTALL_DIR:-$HOME/.rex/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${GREEN}[info]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }
step() { echo -e "${BLUE}[step]${NC} $1"; }

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

  step "Downloading ${filename}..."

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  curl -fsSL "$url" -o "${tmp_dir}/${filename}"
  curl -fsSL "$checksum_url" -o "${tmp_dir}/checksums.txt"

  # Verify checksum
  step "Verifying checksum..."
  cd "$tmp_dir"
  if command -v shasum &>/dev/null; then
    if shasum -a 256 -c checksums.txt --ignore-missing 2>/dev/null; then
      info "Checksum verified"
    else
      error "Checksum verification failed!"
    fi
  elif command -v sha256sum &>/dev/null; then
    if sha256sum -c checksums.txt --ignore-missing 2>/dev/null; then
      info "Checksum verified"
    else
      error "Checksum verification failed!"
    fi
  else
    warn "No checksum tool found, skipping verification"
  fi

  # Install
  step "Installing to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  mv "${tmp_dir}/${filename}" "${INSTALL_DIR}/${BINARY_NAME}"
  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
  info "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"
}

# Update shell config
setup_path() {
  local shell_config=""
  local path_line="export PATH=\"\$PATH:${INSTALL_DIR}\""

  case "${SHELL:-}" in
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
    echo "# Rex CLI" >> "$shell_config"
    echo "$path_line" >> "$shell_config"
    info "Added ${INSTALL_DIR} to PATH in ${shell_config}"
    warn "Restart your shell or run: source ${shell_config}"
  elif [[ -n "$shell_config" ]]; then
    info "PATH already configured in ${shell_config}"
  fi
}

main() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC}          ${GREEN}Rex CLI Installer${NC}             ${BLUE}║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
  echo ""

  local platform
  platform=$(detect_platform)
  info "Detected platform: ${platform}"

  local version
  version=${REX_VERSION:-$(get_latest_version)}
  info "Installing version: ${version}"

  download_binary "$version" "$platform"
  setup_path

  echo ""
  echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║${NC}        ${GREEN}Installation complete!${NC}          ${GREEN}║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
  echo ""
  info "Run '${BINARY_NAME} --help' to get started"
  echo ""
}

main "$@"
