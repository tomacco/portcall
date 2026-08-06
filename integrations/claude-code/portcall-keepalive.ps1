# PortCall keepalive (Windows / pwsh): heartbeat one session's agent on a
# timer so it stays "online" between user prompts. Spawned detached by
# portcall-hook.ps1.
#
# Reads credentials from the session state file at runtime and never prints
# them. Exit rules mirror portcall-keepalive.sh:
#   - state file gone (SessionEnd cleaned up)  -> exit
#   - daemon says 401/404 (identity disowned)  -> exit; the next prompt's hook
#     re-registers and respawns us with the fresh identity
#   - daemon busy/unreachable                  -> keep waiting quietly
# This loop NEVER registers: identity is minted only by the hook.
param(
    [Parameter(Mandatory)][string]$StateFile,
    [int]$IntervalSec = 20
)
$ErrorActionPreference = 'Stop'

$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$cfgFile = Join-Path $homeDir '.claude/portcall/config.json'
$cfg = try { Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { $null }
$daemon = if ($env:PORTCALL_URL) { $env:PORTCALL_URL }
          elseif ($cfg -and $cfg.daemonUrl) { $cfg.daemonUrl }
          else { 'http://127.0.0.1:4747' }
$daemon = $daemon.TrimEnd('/')

while ($true) {
    if (-not (Test-Path $StateFile)) { exit 0 }
    $st = try { Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $null }
    if ($st -and $st.id -and $st.token) {
        try {
            Invoke-RestMethod -Method POST -Uri "$daemon/api/v1/agents/$($st.id)/heartbeat" `
                -Headers @{ Authorization = "Bearer $($st.token)" } -ContentType 'application/json' `
                -TimeoutSec 3 | Out-Null
        }
        catch {
            $code = [int]($_.Exception.Response.StatusCode ?? 0)
            if ($code -eq 401 -or $code -eq 404) { exit 0 }  # disowned: hook owns re-registration
        }
    }
    Start-Sleep -Seconds $IntervalSec
}
