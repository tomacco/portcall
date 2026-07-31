# PortCall -> Claude Code integration installer (Windows / pwsh).
#
#   pwsh integrations/claude-code/install.ps1 [-DaemonUrl http://127.0.0.1:4747] [-Owner you@example.com]
#
# Installs: the 'portcall' skill, the presence hooks (SessionStart /
# UserPromptSubmit / SessionEnd), the PowerShell client module, and a config
# file. Idempotent: re-running produces byte-identical output. Never rewrites
# an unparseable settings.json — it refuses instead.
param(
    [string]$DaemonUrl = 'http://127.0.0.1:4747',
    [string]$Owner = ''
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = Split-Path (Split-Path $here)
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$claudeDir = Join-Path $homeDir '.claude'
if (-not (Test-Path $claudeDir)) {
    throw "No $claudeDir found - is Claude Code installed for this user?"
}

function Write-IfChanged([string]$Path, [string]$Content) {
    $existing = if (Test-Path $Path) { Get-Content $Path -Raw } else { $null }
    if ($existing -cne $Content) {
        [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
        return $true
    }
    return $false
}

# --- 1. runtime dir: hook scripts, client module, config -------------------
$base = Join-Path $claudeDir 'portcall'
New-Item -ItemType Directory -Force $base, (Join-Path $base 'state') | Out-Null

foreach ($f in 'portcall-hook.ps1', 'portcall-hook.sh') {
    Write-IfChanged (Join-Path $base $f) (Get-Content (Join-Path $here $f) -Raw) | Out-Null
}
Write-IfChanged (Join-Path $base 'PortCall.psm1') (Get-Content (Join-Path $repo 'clients/powershell/PortCall.psm1') -Raw) | Out-Null

if (-not $Owner) {
    $Owner = (git config user.email 2>$null)
    if (-not $Owner) { $Owner = "$env:USERNAME@local" }
}
$cfgJson = [ordered]@{ daemonUrl = $DaemonUrl.TrimEnd('/'); owner = $Owner } | ConvertTo-Json
Write-IfChanged (Join-Path $base 'config.json') "$cfgJson`n" | Out-Null

# --- 2. the skill ----------------------------------------------------------
$skillDir = Join-Path $claudeDir 'skills/portcall'
New-Item -ItemType Directory -Force $skillDir | Out-Null
Write-IfChanged (Join-Path $skillDir 'SKILL.md') (Get-Content (Join-Path $here 'skill/SKILL.md') -Raw) | Out-Null

# --- 3. hooks in settings.json ---------------------------------------------
$settingsFile = Join-Path $claudeDir 'settings.json'
if (Test-Path $settingsFile) {
    $raw = Get-Content $settingsFile -Raw
    try { $settings = $raw | ConvertFrom-Json -AsHashtable }
    catch { throw "$settingsFile is not valid JSON - fix it first; refusing to rewrite it." }
    $backup = "$settingsFile.portcall-backup"
    if (-not (Test-Path $backup)) { Copy-Item $settingsFile $backup }
}
else {
    $settings = [ordered]@{}
}

$shellExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' }
            elseif ($IsWindows -or $env:OS -eq 'Windows_NT') { 'powershell.exe' }
            else { throw 'No pwsh found.' }
$hookPath = Join-Path $base 'portcall-hook.ps1'

if (-not $settings.Contains('hooks')) { $settings['hooks'] = [ordered]@{} }
$events = [ordered]@{ SessionStart = 10; UserPromptSubmit = 10; SessionEnd = 5 }
$added = @()
foreach ($evt in $events.Keys) {
    if (-not $settings['hooks'].Contains($evt)) { $settings['hooks'][$evt] = @() }
    $already = $settings['hooks'][$evt] | Where-Object {
        $_.hooks | Where-Object { $_.args -and ($_.args -contains $hookPath) }
    }
    if (-not $already) {
        $settings['hooks'][$evt] = @($settings['hooks'][$evt]) + , ([ordered]@{
            hooks = @([ordered]@{
                type    = 'command'
                command = $shellExe
                args    = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hookPath, '-Event', $evt)
                timeout = $events[$evt]
                statusMessage = "PortCall: $evt"
            })
        })
        $added += $evt
    }
}

$settingsOut = ($settings | ConvertTo-Json -Depth 32) + "`n"
$changed = Write-IfChanged $settingsFile $settingsOut

# --- 4. report -------------------------------------------------------------
Write-Host "PortCall Claude Code integration installed:"
Write-Host "  skill    -> $skillDir\SKILL.md"
Write-Host "  hooks    -> $hookPath  ($(if ($added) { "wired: $($added -join ', ')" } else { 'already wired' }))"
Write-Host "  module   -> $base\PortCall.psm1"
Write-Host "  config   -> $base\config.json  (daemon $DaemonUrl, owner $Owner)"
if ($changed) {
    Write-Host "  NOTE: restart Claude Code (or open /hooks once) so running sessions pick up the hooks."
}
