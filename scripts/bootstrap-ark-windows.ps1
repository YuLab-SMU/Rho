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
$emptyRenviron = Join-Path $installRoot "empty.Renviron"
$rHome = (& Rscript -e "cat(normalizePath(R.home(), winslash='/', mustWork=TRUE))").Trim()
$rBin = (& Rscript -e "cat(normalizePath(R.home('bin'), winslash='/', mustWork=TRUE))").Trim()
$libraryExpression = 'cat(paste(normalizePath(.libPaths(), winslash=''/'' ,mustWork=TRUE), collapse=.Platform$path.sep))'
$rLibraries = (& Rscript -e $libraryExpression).Trim()
if (-not $rHome -or -not $rBin -or -not $rLibraries) {
    throw "Unable to resolve R_HOME, the R DLL directory and R libraries through Rscript."
}

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $ark)) {
    Invoke-WebRequest -Uri $artifact.url -OutFile $archive
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actualHash -ne $artifact.sha256) {
        throw "Ark archive checksum mismatch: expected $($artifact.sha256), got $actualHash"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $installRoot -Force
}
[System.IO.File]::WriteAllText($emptyRenviron, "", (New-Object System.Text.UTF8Encoding($false)))

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
        "--no-environ",
        "--no-init-file",
        "--no-site-file"
    )
    display_name = "Ark R $($manifest.version) (Rho)"
    language = "R"
    interrupt_mode = "message"
    kernel_protocol_version = "5.4"
    env = [ordered]@{
        R_HOME = $rHome
        R_LIBS = $rLibraries
        R_ENVIRON_USER = $emptyRenviron
        PATH = $rBin + ";" + $env:PATH
    }
}
$specJson = $spec | ConvertTo-Json -Depth 4
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($kernelSpec, $specJson, $utf8WithoutBom)

Write-Output $kernelSpec
