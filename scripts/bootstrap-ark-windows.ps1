param(
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot "..\.rho\runtime")
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This bootstrap script supports Windows only."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
    throw "Phase 0 currently pins the Windows x64 Ark artifact."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Get-Content (Join-Path $repositoryRoot "runtime\ark.json") -Raw | ConvertFrom-Json
$artifact = $manifest.'windows-x64'
$installRoot = Join-Path $RuntimeRoot ("ark-" + $manifest.version)
$archive = Join-Path $RuntimeRoot ("ark-" + $manifest.version + "-windows-x64.zip")
$ark = Join-Path $installRoot "ark.exe"
$kernelSpec = Join-Path $installRoot "kernel.json"
$log = Join-Path $installRoot "ark.log"

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $ark)) {
    Invoke-WebRequest -Uri $artifact.url -OutFile $archive
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actualHash -ne $artifact.sha256) {
        throw "Ark archive checksum mismatch: expected $($artifact.sha256), got $actualHash"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $installRoot -Force
}

$spec = [ordered]@{
    argv = @(
        $ark,
        "--connection_file",
        "{connection_file}",
        "--session-mode",
        "console",
        "--log",
        $log,
        "--",
        "--interactive",
        "--no-init-file",
        "--no-site-file"
    )
    display_name = "Ark R $($manifest.version) (Rho)"
    language = "R"
    interrupt_mode = "message"
    kernel_protocol_version = "5.4"
}
$specJson = $spec | ConvertTo-Json -Depth 4
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($kernelSpec, $specJson, $utf8WithoutBom)

Write-Output $kernelSpec
