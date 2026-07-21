param(
    [string]$ExpectedVersion,
    [string]$ReleaseTag,
    [ValidateSet("true", "false", "")]
    [string]$Prerelease = "",
    [string]$EvidencePath = "target\release-evidence\rho-0.2-release.json",
    [switch]$RequireCleanWorktree,
    [switch]$BuildInstaller,
    [switch]$SmokeWorkspace,
    [switch]$SmokeAgent
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startedAt = [DateTimeOffset]::UtcNow
$checks = [System.Collections.Generic.List[object]]::new()
$artifact = $null
$failure = $null
$workspaceContent = Get-Content -LiteralPath (Join-Path $repo "Cargo.toml") -Raw
$versionMatch = [regex]::Match(
    $workspaceContent,
    '(?ms)^\[workspace\.package\].*?^version\s*=\s*"([^"]+)"'
)
if (-not $versionMatch.Success) {
    throw "Could not read the Rho workspace version."
}
$applicationVersion = $versionMatch.Groups[1].Value

function Limit-Text {
    param([string]$Text, [int]$Limit = 12000)
    if (-not $Text) { return "" }
    if ($Text.Length -le $Limit) { return $Text }
    return $Text.Substring($Text.Length - $Limit)
}

function Invoke-RecordedCheck {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf) -and
        -not (Get-Command $FilePath -ErrorAction SilentlyContinue)) {
        throw "$Name cannot start because $FilePath was not found."
    }
    Write-Host ""
    Write-Host "==> $Name"
    $checkStarted = [DateTimeOffset]::UtcNow
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        $line
    })
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    $ErrorActionPreference = $previousErrorActionPreference
    $finished = [DateTimeOffset]::UtcNow
    $checks.Add([ordered]@{
        name = $Name
        command = "$FilePath $($Arguments -join ' ')".Trim()
        status = if ($exitCode -eq 0) { "passed" } else { "failed" }
        exit_code = $exitCode
        duration_ms = [Math]::Round(($finished - $checkStarted).TotalMilliseconds)
        output_tail = Limit-Text ($output -join [Environment]::NewLine)
    })
    if ($exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode."
    }
}

function Invoke-SmokeCheck {
    param(
        [string]$Name,
        [string]$Binary,
        [string]$Argument,
        [int]$TimeoutSeconds
    )

    Write-Host ""
    Write-Host "==> $Name"
    $checkStarted = [DateTimeOffset]::UtcNow
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Binary
    $startInfo.Arguments = $Argument
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
        try { $process.Kill($true) } catch { $process.Kill() }
        $process.WaitForExit()
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($stdout) { [Console]::Out.Write($stdout) }
    if ($stderr) { [Console]::Error.Write($stderr) }
    $exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
    $finished = [DateTimeOffset]::UtcNow
    $checks.Add([ordered]@{
        name = $Name
        command = "$Binary $Argument"
        status = if ($exitCode -eq 0) { "passed" } else { "failed" }
        exit_code = $exitCode
        duration_ms = [Math]::Round(($finished - $checkStarted).TotalMilliseconds)
        output_tail = Limit-Text (($stdout, $stderr) -join [Environment]::NewLine)
    })
    if ($timedOut) {
        throw "$Name timed out after $TimeoutSeconds seconds."
    }
    if ($exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode."
    }
}

function Write-Evidence {
    $resolvedEvidencePath = if ([System.IO.Path]::IsPathRooted($EvidencePath)) {
        $EvidencePath
    } else {
        Join-Path $repo $EvidencePath
    }
    $directory = Split-Path -Parent $resolvedEvidencePath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $finishedAt = [DateTimeOffset]::UtcNow
    $status = if ($failure) { "failed" } else { "passed" }
    $evidence = [ordered]@{
        schema_version = 1
        type = "rho_0_2_release_evidence"
        status = $status
        version = $applicationVersion
        started_at = $startedAt.ToString("o")
        finished_at = $finishedAt.ToString("o")
        duration_ms = [Math]::Round(($finishedAt - $startedAt).TotalMilliseconds)
        expected_version = $ExpectedVersion
        release_tag = $ReleaseTag
        prerelease = $Prerelease
        commit = (& git -C $repo rev-parse HEAD).Trim()
        working_tree_clean = (@(& git -C $repo -c core.excludesFile=.git/info/exclude status --porcelain --untracked-files=all)).Count -eq 0
        checks = $checks
        artifact = $artifact
        failure = $failure
        manual_acceptance = [ordered]@{
            status = "not_run_by_automation"
            checklist = "docs/release/active-0.2-release-checklist.md"
        }
    }
    $json = $evidence | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText(
        $resolvedEvidencePath,
        "$json`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host ""
    Write-Host "Release evidence: $resolvedEvidencePath"
}

Push-Location $repo
try {
    $metadataArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "test-release-metadata.ps1"))
    if ($ExpectedVersion) { $metadataArguments += @("-ExpectedVersion", $ExpectedVersion) }
    if ($ReleaseTag) { $metadataArguments += @("-ReleaseTag", $ReleaseTag) }
    if ($Prerelease) { $metadataArguments += @("-Prerelease", $Prerelease) }
    if ($RequireCleanWorktree) { $metadataArguments += "-RequireCleanWorktree" }
    Invoke-RecordedCheck "release metadata" "powershell.exe" $metadataArguments

    Invoke-RecordedCheck "Rust formatting" "cargo.exe" @("fmt", "--all", "--", "--check")
    Invoke-RecordedCheck "Rust workspace tests" "cargo.exe" @("test", "--workspace")
    Invoke-RecordedCheck "frontend JavaScript syntax" "node.exe" @("--check", "desktop/dist/app.js")
    Invoke-RecordedCheck "rho.bridge tests" "Rscript.exe" @("-e", "testthat::test_local('r/rho.bridge', reporter = 'summary')")
    Invoke-RecordedCheck "rho.agent tests" "Rscript.exe" @("-e", "testthat::test_local('r/rho.agent', reporter = 'summary')")

    if ($BuildInstaller) {
        Invoke-RecordedCheck "Windows installer build" "powershell.exe" @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            (Join-Path $PSScriptRoot "build-windows-installer.ps1")
        )
        $installer = Get-ChildItem -LiteralPath (Join-Path $repo "target\release\bundle\nsis") -Filter "*-setup.exe" |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if (-not $installer) {
            throw "Installer was not found after the build completed."
        }
        $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $hashPath = "$($installer.FullName).sha256"
        [System.IO.File]::WriteAllText(
            $hashPath,
            "$hash *$($installer.Name)`n",
            (New-Object System.Text.UTF8Encoding($false))
        )
        $artifact = [ordered]@{
            installer_path = $installer.FullName
            installer_name = $installer.Name
            size_bytes = $installer.Length
            sha256 = $hash
            hash_path = $hashPath
        }
        if ($env:GITHUB_OUTPUT) {
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_path=$($installer.FullName)"
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_name=$($installer.Name)"
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "hash_path=$hashPath"
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "hash_value=$hash"
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "commit_sha=$((& git rev-parse HEAD).Trim())"
        }
    }

    if ($SmokeWorkspace -or $SmokeAgent) {
        $binary = Join-Path $repo "target\release\rho-desktop.exe"
        if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
            throw "Release smoke-test binary not found at $binary. Use -BuildInstaller first."
        }
        if ($SmokeWorkspace) {
            Invoke-SmokeCheck "Workspace release smoke" $binary "--smoke-test" 120
        }
        if ($SmokeAgent) {
            Invoke-SmokeCheck "Agent release smoke" $binary "--smoke-agent" 180
        }
    }
}
catch {
    $failure = $_.Exception.Message
    throw
}
finally {
    Pop-Location
    Write-Evidence
}
