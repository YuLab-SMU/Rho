param(
    [string]$CargoHome = $env:CARGO_HOME,
    [string]$RustupHome = $env:RUSTUP_HOME,
    [string]$RtoolsBin = $env:RTOOLS_BIN,
    [string]$RustupToolchain = $env:RUSTUP_TOOLCHAIN,
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot "..\.rho\runtime"),
    [string]$TauriCliVersion = "2.11.4"
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path

if (-not $CargoHome) {
    $CargoHome = "E:\software-data\scoop\persist\rustup\.cargo"
}
if (-not $RustupHome) {
    $RustupHome = "E:\software-data\scoop\persist\rustup\.rustup"
}
if (-not $RtoolsBin) {
    $RtoolsBin = "C:\rtools45\x86_64-w64-mingw32.static.posix\bin"
}
if (-not $RustupToolchain) {
    $RustupToolchain = "stable-x86_64-pc-windows-gnu"
}

$cargoBin = Join-Path $CargoHome "bin"
if (-not (Test-Path -LiteralPath $cargoBin)) {
    throw "Cargo bin directory not found at $cargoBin."
}
if (-not (Test-Path -LiteralPath $RtoolsBin)) {
    throw "Rtools bin directory not found at $RtoolsBin."
}

$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:RUSTUP_TOOLCHAIN = $RustupToolchain
$env:PATH = "$RtoolsBin;$cargoBin;$env:PATH"

if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
    throw "npx.cmd was not found on PATH after applying Cargo and Rtools paths."
}

$tauriConfigPath = Join-Path $repo "desktop\src-tauri\tauri.conf.json"
$tauriConfig = Get-Content $tauriConfigPath -Raw | ConvertFrom-Json
$productName = $tauriConfig.productName
$version = $tauriConfig.version

$arkManifestPath = Join-Path $repo "runtime\ark.json"
$arkManifest = Get-Content $arkManifestPath -Raw | ConvertFrom-Json
$runtimeSource = Join-Path $RuntimeRoot ("ark-" + $arkManifest.version)
$runtimeDestination = Join-Path $repo "desktop\resources\runtime"
New-Item -ItemType Directory -Path $runtimeDestination -Force | Out-Null

$arkSource = Join-Path $runtimeSource "ark.exe"
if (-not (Test-Path -LiteralPath $arkSource)) {
    throw "Ark runtime not found at $runtimeSource. Run scripts/bootstrap-ark-windows.ps1 first."
}

foreach ($name in @("ark.exe", "LICENSE", "NOTICE")) {
    $source = Join-Path $runtimeSource $name
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required runtime file missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination $runtimeDestination -Force
}

Push-Location (Join-Path $repo "desktop\src-tauri")
try {
    & npx.cmd -y "@tauri-apps/cli@$TauriCliVersion" build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$installerDirectory = Join-Path $repo "target\release\bundle\nsis"
$installer = Get-ChildItem -LiteralPath $installerDirectory -Filter "*-setup.exe" -ErrorAction Stop |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $installer) {
    throw "Installer not found under $installerDirectory after building $productName $version."
}

Write-Host "Rho installer: $($installer.FullName)"
if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_path=$($installer.FullName)"
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_name=$($installer.Name)"
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "product_name=$productName"
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "app_version=$version"
}
