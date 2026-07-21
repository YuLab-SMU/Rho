param(
    [string]$ExpectedVersion,
    [string]$ReleaseTag,
    [ValidateSet("true", "false", "")]
    [string]$Prerelease = "",
    [switch]$RequireCleanWorktree,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceManifest = Join-Path $repo "Cargo.toml"
$tauriConfigPath = Join-Path $repo "desktop\src-tauri\tauri.conf.json"
$frontendPackagePath = Join-Path $repo "desktop\package.json"

$workspaceContent = Get-Content -LiteralPath $workspaceManifest -Raw
$versionMatch = [regex]::Match(
    $workspaceContent,
    '(?ms)^\[workspace\.package\].*?^version\s*=\s*"([^"]+)"'
)
if (-not $versionMatch.Success) {
    throw "Could not read [workspace.package] version from $workspaceManifest."
}

$workspaceVersion = $versionMatch.Groups[1].Value
$tauriVersion = (Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version
$frontendVersion = (Get-Content -LiteralPath $frontendPackagePath -Raw | ConvertFrom-Json).version
$versions = [ordered]@{
    cargo_workspace = $workspaceVersion
    tauri_bundle = $tauriVersion
    desktop_frontend = $frontendVersion
}

$distinctVersions = @($versions.Values | Select-Object -Unique)
if ($distinctVersions.Count -ne 1) {
    throw "Release version mismatch: $($versions | ConvertTo-Json -Compress)."
}
if ($ExpectedVersion -and $workspaceVersion -ne $ExpectedVersion) {
    throw "Expected release version $ExpectedVersion, found $workspaceVersion."
}

$expectedTag = "v$workspaceVersion"
if ($ReleaseTag -and $ReleaseTag -ne $expectedTag) {
    throw "Release tag $ReleaseTag does not match application version $workspaceVersion (expected $expectedTag)."
}

$isVersionPrerelease = $workspaceVersion.Contains("-")
if ($Prerelease) {
    $requestedPrerelease = $Prerelease -eq "true"
    if ($requestedPrerelease -ne $isVersionPrerelease) {
        $expectedValue = if ($isVersionPrerelease) { "true" } else { "false" }
        throw "Prerelease must be $expectedValue for application version $workspaceVersion."
    }
}

$requiredFiles = @(
    "desktop\resources\runtime\ark.exe",
    "desktop\resources\runtime\LICENSE",
    "desktop\resources\runtime\NOTICE",
    "desktop\resources\WebView2Loader.dll",
    "desktop\dist\index.html",
    "desktop\dist\app.js",
    "desktop\dist\styles.css"
)
$missingFiles = @(
    $requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repo $_) -PathType Leaf) }
)
if ($missingFiles.Count -gt 0) {
    throw "Required release files are missing: $($missingFiles -join ', ')."
}

Push-Location $repo
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $diffOutput = & git diff --check 2>&1
    $diffExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($diffExitCode -ne 0) {
        throw "git diff --check failed:`n$($diffOutput -join [Environment]::NewLine)"
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $worktreeStatus = @(& git -c core.excludesFile=.git/info/exclude status --porcelain --untracked-files=all 2>&1)
    $statusExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($statusExitCode -ne 0) {
        throw "git status failed while checking release cleanliness."
    }
    $worktreeClean = $worktreeStatus.Count -eq 0
    if ($RequireCleanWorktree -and -not $worktreeClean) {
        throw "Release publication requires a clean worktree."
    }
    $commit = (& git rev-parse HEAD).Trim()
}
finally {
    Pop-Location
}

$result = [ordered]@{
    type = "rho_release_metadata"
    version = $workspaceVersion
    expected_tag = $expectedTag
    prerelease = $isVersionPrerelease
    commit = $commit
    working_tree_clean = $worktreeClean
    versions = $versions
    required_files = $requiredFiles
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
} else {
    Write-Host "Rho release metadata is consistent."
    Write-Host "Version: $workspaceVersion"
    Write-Host "Expected tag: $expectedTag"
    Write-Host "Commit: $commit"
    Write-Host "Working tree clean: $worktreeClean"
}
