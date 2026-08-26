# Cross-platform entry point: prepare-fixtures.mjs (same directory) supersedes
# this script on non-Windows hosts. On Windows both are available and equivalent.
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '..\..\generated-manual-fixtures')
)

$ErrorActionPreference = 'Stop'

$sourceProject = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $OutputRoot))
$resolvedRoot = [System.IO.Path]::GetFullPath($OutputRoot)

function Invoke-LocalGit {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string[]]$GitArguments
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $Repository @GitArguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "git $($GitArguments -join ' ') failed in ${Repository}: $($output | Out-String)"
    }
}

function Initialize-FixtureRepository {
    param([Parameter(Mandatory = $true)][string]$Repository)

    Invoke-LocalGit -Repository $Repository -GitArguments @('init')
    Invoke-LocalGit -Repository $Repository -GitArguments @('branch', '-M', 'main')
    Invoke-LocalGit -Repository $Repository -GitArguments @('config', 'user.name', 'Rho Acceptance')
    Invoke-LocalGit -Repository $Repository -GitArguments @('config', 'user.email', 'acceptance@rho.local')
    Invoke-LocalGit -Repository $Repository -GitArguments @('add', '--all')
    Invoke-LocalGit -Repository $Repository -GitArguments @('commit', '-m', 'test: acceptance project baseline')
}

function Invoke-ExpectedConflictMerge {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Branch
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $Repository merge $Branch 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -eq 0) {
        throw "Expected merge conflict was not created in $Repository"
    }
    $status = & git -C $Repository status --porcelain
    if ($LASTEXITCODE -ne 0 -or ($status | Out-String) -notmatch 'UU examples/git-review-demo.txt') {
        throw "Merge failed without the expected conflict in ${Repository}: $($output | Out-String)"
    }
}

if (Test-Path -LiteralPath $resolvedRoot) {
    throw "Fixture root already exists: $resolvedRoot`nRemove or rename it explicitly before generating a fresh set."
}

[System.IO.Directory]::CreateDirectory($resolvedParent) | Out-Null
[System.IO.Directory]::CreateDirectory($resolvedRoot) | Out-Null

$workingProject = Join-Path $resolvedRoot 'working-project'
Copy-Item -LiteralPath $sourceProject -Destination $workingProject -Recurse
Initialize-FixtureRepository -Repository $workingProject

$conflictProject = Join-Path $resolvedRoot 'conflict-project'
Copy-Item -LiteralPath $sourceProject -Destination $conflictProject -Recurse
Initialize-FixtureRepository -Repository $conflictProject
$conflictFile = Join-Path $conflictProject 'examples\git-review-demo.txt'
$baselineText = [System.IO.File]::ReadAllText($conflictFile)
Invoke-LocalGit -Repository $conflictProject -GitArguments @('checkout', '-b', 'acceptance-conflict')
[System.IO.File]::WriteAllText(
    $conflictFile,
    $baselineText.Replace('The mitochondrial review threshold is 20 percent.', 'The branch proposes an 18 percent review threshold.')
)
Invoke-LocalGit -Repository $conflictProject -GitArguments @('add', 'examples/git-review-demo.txt')
Invoke-LocalGit -Repository $conflictProject -GitArguments @('commit', '-m', 'test: conflicting threshold proposal')
Invoke-LocalGit -Repository $conflictProject -GitArguments @('checkout', 'main')
[System.IO.File]::WriteAllText(
    $conflictFile,
    $baselineText.Replace('The mitochondrial review threshold is 20 percent.', 'The main branch retains a 20 percent review threshold.')
)
Invoke-LocalGit -Repository $conflictProject -GitArguments @('add', 'examples/git-review-demo.txt')
Invoke-LocalGit -Repository $conflictProject -GitArguments @('commit', '-m', 'test: retain baseline threshold')
Invoke-ExpectedConflictMerge -Repository $conflictProject -Branch 'acceptance-conflict'

$unicodeAndSpaces = -join @(
    [char]0x8DEF,
    [char]0x5F84,
    ' ',
    [char]0x542B,
    ' ',
    [char]0x7A7A,
    [char]0x683C
)
$unicodeProject = Join-Path $resolvedRoot (Join-Path $unicodeAndSpaces 'acceptance-project')
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $unicodeProject)) | Out-Null
Copy-Item -LiteralPath $sourceProject -Destination $unicodeProject -Recurse

$largeProject = Join-Path $resolvedRoot 'large-project-2100'
[System.IO.Directory]::CreateDirectory($largeProject) | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $largeProject 'large-project.Rproj'),
    "Version: 1.0`r`nEncoding: UTF-8`r`n"
)
for ($index = 1; $index -le 2100; $index++) {
    $fileName = 'fixture-{0:D4}.R' -f $index
    [System.IO.File]::WriteAllText(
        (Join-Path $largeProject $fileName),
        "fixture_value <- $index`r`n"
    )
}

$oversizedProject = Join-Path $resolvedRoot 'oversized-file-project'
[System.IO.Directory]::CreateDirectory($oversizedProject) | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $oversizedProject 'oversized-file-project.Rproj'),
    "Version: 1.0`r`nEncoding: UTF-8`r`n"
)
$largeFilePath = Join-Path $oversizedProject 'over-8MiB.txt'
$stream = [System.IO.File]::Open($largeFilePath, [System.IO.FileMode]::CreateNew)
try {
    $stream.SetLength(9MB)
} finally {
    $stream.Dispose()
}

Write-Host "Manual acceptance fixtures created at: $resolvedRoot"
Write-Host "Primary working project: $workingProject"
Write-Host "Conflict project: $conflictProject"
Write-Host "Unicode/spaces project: $unicodeProject"
Write-Host "Large project: $largeProject"
Write-Host "Oversized file project: $oversizedProject"
