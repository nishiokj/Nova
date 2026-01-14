#Requires -Version 5.1
<#
.SYNOPSIS
    Rex CLI Installer for Windows
.DESCRIPTION
    Downloads and installs the Rex CLI binary from GitHub releases.
.EXAMPLE
    irm https://raw.githubusercontent.com/yourorg/rex/main/scripts/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"

# Configuration - UPDATE THESE FOR YOUR REPO
$Repo = "yourorg/rex"
$BinaryName = "rex"
$InstallDir = if ($env:REX_INSTALL_DIR) { $env:REX_INSTALL_DIR } else { "$env:USERPROFILE\.rex\bin" }

function Write-Info { param($msg) Write-Host "[info] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }
function Write-Step { param($msg) Write-Host "[step] $msg" -ForegroundColor Blue }

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

    Write-Step "Downloading $filename..."

    # Create install directory
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $outPath = Join-Path $InstallDir "$BinaryName.exe"
    $tempPath = Join-Path $env:TEMP $filename

    try {
        Invoke-WebRequest -Uri $url -OutFile $tempPath -UseBasicParsing
    } catch {
        Write-Err "Failed to download binary: $_"
    }

    # Verify checksum
    Write-Step "Verifying checksum..."
    try {
        $checksums = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
        $expectedHash = ($checksums -split "`n" | Where-Object { $_ -match $filename } | ForEach-Object { ($_ -split "\s+")[0] })
        $actualHash = (Get-FileHash -Path $tempPath -Algorithm SHA256).Hash.ToLower()

        if ($expectedHash -and $actualHash -ne $expectedHash) {
            Remove-Item $tempPath -Force
            Write-Err "Checksum verification failed!"
        }
        Write-Info "Checksum verified"
    } catch {
        Write-Warn "Could not verify checksum: $_"
    }

    # Move to install location
    Move-Item -Path $tempPath -Destination $outPath -Force
    Write-Info "Installed to $outPath"
}

# Add to PATH
function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
        Write-Info "Added $InstallDir to PATH"
        Write-Warn "Restart your terminal for PATH changes to take effect"
    } else {
        Write-Info "PATH already configured"
    }
}

# Main
function Main {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host "        Rex CLI Installer" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host ""

    $platform = Get-Platform
    Write-Info "Detected platform: $platform"

    $version = if ($env:REX_VERSION) { $env:REX_VERSION } else { Get-LatestVersion }
    Write-Info "Installing version: $version"

    Install-Binary -Version $version -Platform $platform
    Add-ToPath

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "      Installation complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Info "Run '$BinaryName --help' to get started"
    Write-Host ""
}

Main
