$ErrorActionPreference = 'Stop'
$repoRoot = if ($args[0]) { $args[0] } else { Split-Path $PSScriptRoot }
$installer = Join-Path $repoRoot 'integrations/claude-code/install.ps1'
$originalProfile = $env:USERPROFILE
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("portcall-install-" + [guid]::NewGuid())

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function New-TestHome([string]$Name) {
    $env:USERPROFILE = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Force (Join-Path $env:USERPROFILE '.claude') | Out-Null
}
function Run-Installer { & $installer -Owner 'test@example.invalid' | Out-Null }

try {
    New-TestHome 'existing'
    $settings = Join-Path $env:USERPROFILE '.claude/settings.json'
    '{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' |
        Set-Content -LiteralPath $settings -NoNewline
    Run-Installer
    $parsed = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
    if ($parsed.theme -ne 'dark' -or $parsed.hooks.Stop[0].hooks[0].command -ne 'keep-me') { throw 'Existing settings were not preserved.' }
    foreach ($event in 'SessionStart', 'UserPromptSubmit', 'SessionEnd') {
        if (@($parsed.hooks.$event).Count -ne 1) { throw "$event hook was not installed exactly once." }
    }
    $first = Hash $settings
    Run-Installer
    if ((Hash $settings) -ne $first) { throw 'Second install was not byte-stable.' }

    New-TestHome 'malformed'
    $settings = Join-Path $env:USERPROFILE '.claude/settings.json'
    [IO.File]::WriteAllText($settings, '{broken')
    $before = Hash $settings
    $failed = $false
    try { Run-Installer } catch { $failed = $true }
    if (-not $failed) { throw 'Malformed settings were accepted.' }
    if ((Hash $settings) -ne $before) { throw 'Malformed settings were rewritten.' }

    Write-Host 'PASS: Claude Code PowerShell installer is fail-closed and byte-stable'
}
finally {
    $env:USERPROFILE = $originalProfile
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
