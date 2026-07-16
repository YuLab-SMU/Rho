$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$cargoHome = "E:\software-data\scoop\persist\rustup\.cargo"
$rustupHome = "E:\software-data\scoop\persist\rustup\.rustup"
$rtoolsBin = "C:\rtools45\x86_64-w64-mingw32.static.posix\bin"

$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
$env:PATH = "$rtoolsBin;$cargoHome\bin;$env:PATH"

$runtimeSource = Join-Path $repo ".rho\runtime\ark-0.1.252"
$runtimeDestination = Join-Path $repo "desktop\resources\runtime"
$arkSource = Join-Path $runtimeSource "ark.exe"
if (-not (Test-Path -LiteralPath $arkSource)) {
    throw "Ark runtime not found. Run scripts/bootstrap-ark-windows.ps1 first."
}
foreach ($name in @("ark.exe", "LICENSE", "NOTICE")) {
    Copy-Item -LiteralPath (Join-Path $runtimeSource $name) -Destination $runtimeDestination -Force
}

Push-Location (Join-Path $repo "desktop\src-tauri")
try {
    & npx.cmd -y "@tauri-apps/cli@2" build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$installer = Join-Path $repo "target\release\bundle\nsis\Rho_0.2.0-dev.1_x64-setup.exe"
Write-Host "Rho installer: $installer"
