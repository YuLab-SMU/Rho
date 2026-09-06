param(
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot "..\target\runtime")
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This bootstrap script supports Windows only."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
    throw "This bootstrap pins the Windows x64 Ark artifact."
}
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Get-Content (Join-Path $repositoryRoot "runtime\ark.json") -Raw | ConvertFrom-Json
$artifact = $manifest.'windows-x64'
if (([uri]$artifact.url).Scheme -ne "https") { throw "Ark download requires HTTPS" }
$installRoot = Join-Path $RuntimeRoot ("ark-" + $manifest.version + "-windows-x64")
$archive = Join-Path $RuntimeRoot ("ark-" + $manifest.version + "-windows-x64.zip")
$downloadPath = $archive + ".partial"
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $artifact.url -OutFile $downloadPath
    $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash
    if ($downloadHash -ne $artifact.sha256) { throw "Ark archive checksum mismatch" }
    Move-Item -LiteralPath $downloadPath -Destination $archive -Force
}
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actualHash -ne $artifact.sha256) { throw "Cached Ark archive checksum mismatch" }
Expand-Archive -LiteralPath $archive -DestinationPath $installRoot -Force
$ark = Join-Path $installRoot "ark.exe"
foreach ($file in @($ark, (Join-Path $installRoot "LICENSE"), (Join-Path $installRoot "NOTICE"))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Ark archive is missing $file" }
}
& $ark --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Ark executable verification failed" }
# No R discovery or kernelspec generation here; the Host owns runtime startup.
Write-Output $ark
