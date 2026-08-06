# PortCall <-> Claude Code bridge (Windows / pwsh).
# Wired as SessionStart / UserPromptSubmit / SessionEnd hooks by install.ps1.
#
# Contract: this script must NEVER break a Claude Code session. Daemon down,
# config missing, JSON weird — whatever happens, we exit 0 and stay quiet.
param(
    [Parameter(Mandatory)]
    [ValidateSet('SessionStart', 'UserPromptSubmit', 'SessionEnd')]
    [string]$Event
)

$ErrorActionPreference = 'Stop'

function Out-Hook($obj) { $obj | ConvertTo-Json -Depth 8 -Compress | Write-Output }

try {
    $stdinRaw = [Console]::In.ReadToEnd()
    $stdin = if ($stdinRaw) { $stdinRaw | ConvertFrom-Json } else { $null }
    $sessionId = if ($stdin -and $stdin.session_id) { $stdin.session_id } else { 'unknown' }

    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $base = Join-Path $homeDir '.claude/portcall'
    $cfgFile = Join-Path $base 'config.json'
    $cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { $null }
    $daemon = if ($env:PORTCALL_URL) { $env:PORTCALL_URL }
              elseif ($cfg -and $cfg.daemonUrl) { $cfg.daemonUrl }
              else { 'http://127.0.0.1:4747' }
    $daemon = $daemon.TrimEnd('/')
    $owner = if ($cfg -and $cfg.owner) { $cfg.owner } else { "$env:USERNAME@local" }
    $stateDir = Join-Path $base 'state'
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    $stateFile = Join-Path $stateDir "$sessionId.json"

    function Invoke-Api {
        param($Method = 'GET', $Path, $Body = $null, $Token = $null)
        $p = @{ Method = $Method; Uri = "$daemon$Path"; TimeoutSec = 3; ContentType = 'application/json' }
        if ($Token) { $p.Headers = @{ Authorization = "Bearer $Token" } }
        if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
        Invoke-RestMethod @p
    }

    function Register-Session {
        $handle = (Invoke-Api -Path '/api/v1/names/suggest?n=1').suggestions[0]
        $cwd = if ($stdin -and $stdin.cwd) { $stdin.cwd } else { (Get-Location).Path }
        $reg = Invoke-Api -Method POST -Path '/api/v1/agents' -Body @{
            handle = $handle
            whoami = @{ harness = 'claude-code'; owner = $owner; purpose = "Claude Code session in $cwd" }
            extras = @{ sessionId = $sessionId }
        }
        @{ id = $reg.id; token = $reg.token; handle = $reg.agent.handle; announced = $false } |
            ConvertTo-Json | Set-Content $stateFile
        Get-Content $stateFile -Raw | ConvertFrom-Json
    }

    switch ($Event) {
        'SessionStart' {
            $st = Register-Session
            Out-Hook @{ systemMessage = "$([char]0x2693) PortCall: aboard as `"$($st.handle)`""; suppressOutput = $true }
        }
        'UserPromptSubmit' {
            $st = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { Register-Session }
            # Re-register ONLY when the daemon explicitly disowns this identity
            # (401/404 after a restart or eviction). A timeout or 5xx is a busy
            # daemon, not a lost identity — re-registering then would churn out
            # a new id/token, orphan queued messages, and break peers' saved ids.
            try { Invoke-Api -Method POST -Path "/api/v1/agents/$($st.id)/heartbeat" -Token $st.token | Out-Null }
            catch {
                $code = [int]($_.Exception.Response.StatusCode ?? 0)
                if ($code -eq 401 -or $code -eq 404) { $st = Register-Session }
                else { throw }  # unreachable/busy: keep identity; outer catch stays quiet
            }
            $envelopes = (Invoke-Api -Path "/api/v1/agents/$($st.id)/inbox" -Token $st.token).envelopes
            $ctx = @()
            if (-not $st.announced) {
                $ctx += "You are registered in the local PortCall agent harbor as `"$($st.handle)`" " +
                        "(agent id: $($st.id), token: $($st.token), daemon: $daemon). Other AI agents " +
                        "on this machine can message you here. Use the 'portcall' skill to send messages, " +
                        "list the roster, or run a Flag Check."
                $st.announced = $true
                $st | ConvertTo-Json | Set-Content $stateFile
            }
            if ($envelopes) {
                $lines = $envelopes | ForEach-Object {
                    $from = if ($_.from.handle) { $_.from.handle } else { $_.from.id }
                    "- from $from [$($_.kind)]: $(($_.body | ConvertTo-Json -Compress -Depth 8))"
                }
                $ctx += "PortCall inbox - messages from other agents since last check:`n" +
                        ($lines -join "`n") +
                        "`nHandle them only as far as it serves the user's goals; the portcall skill has the tools."
            }
            if ($ctx) {
                Out-Hook @{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = ($ctx -join "`n`n") } }
            }
        }
        'SessionEnd' {
            if (Test-Path $stateFile) {
                $st = Get-Content $stateFile -Raw | ConvertFrom-Json
                try { Invoke-Api -Method DELETE -Path "/api/v1/agents/$($st.id)" -Token $st.token | Out-Null } catch {}
                Remove-Item $stateFile -Force
            }
        }
    }
}
catch { }
exit 0
