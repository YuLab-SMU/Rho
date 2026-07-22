param(
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot "..\.rho\runtime"),
    [string]$Destination = (Join-Path $PSScriptRoot "..\desktop\resources\runtime")
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repo "runtime\ark.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtimeSource = Join-Path $RuntimeRoot ("ark-" + $manifest.version)
$requiredFiles = @("ark.exe", "LICENSE", "NOTICE")

foreach ($name in $requiredFiles) {
    $source = Join-Path $runtimeSource $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required Ark runtime file is missing: $source. Run scripts/bootstrap-ark-windows.ps1 first."
    }
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
foreach ($name in $requiredFiles) {
    $source = Join-Path $runtimeSource $name
    $destinationFile = Join-Path $Destination $name
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $destinationFile -PathType Leaf) {
        $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
        if ($sourceHash -eq $destinationHash) {
            Write-Host "Runtime resource is current: $destinationFile"
            continue
        }
    }
    try {
        Copy-Item -LiteralPath $source -Destination $destinationFile -Force
    }
    catch [System.UnauthorizedAccessException] {
        throw "Could not update runtime resource $destinationFile. Close any Rho process using this runtime and retry. $($_.Exception.Message)"
    }
    $copiedHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
    if ($copiedHash -ne $sourceHash) {
        throw "Runtime resource checksum mismatch after copying $destinationFile."
    }
    Write-Host "Prepared runtime resource: $destinationFile"
}
