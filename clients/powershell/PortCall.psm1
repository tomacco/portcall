# PortCall client for PowerShell harnesses (Windows-native, no Node required).
# Speaks the same wire format and the same Flag Check handshake as the Node
# client — HMAC-SHA256 over UTF-8 "portcall-hs-v1" + parts, anchor from a
# private GitHub gist via the gh CLI.
#
#   Import-Module .\PortCall.psm1
#   $me = Connect-PortCall -Handle 'Dame Crispy Mutex' -Harness 'powershell' `
#           -Owner 'ivan@tomac.co' -Purpose 'Windows-side liaison'
#   Get-PortCallRoster
#   Invoke-PortCallHandshake -PeerId ag_xxxx
#   Send-PortCallMessage -To ag_xxxx -Kind chat -Body @{ text = 'ahoy' }
#   Receive-PortCallMessage -Wait

$script:Daemon = if ($env:PORTCALL_URL) { $env:PORTCALL_URL.TrimEnd('/') } else { 'http://127.0.0.1:4747' }
$script:Me = $null
$script:Anchor = $null
$script:HsVersion = 'portcall-hs-v1'

function Invoke-PortCallApi {
    param([string]$Method = 'GET', [string]$Path, $Body = $null)
    $params = @{ Method = $Method; Uri = "$script:Daemon$Path"; ContentType = 'application/json' }
    if ($script:Me) { $params.Headers = @{ Authorization = "Bearer $($script:Me.token)" } }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 8) }
    Invoke-RestMethod @params
}

function Get-PortCallAnchor {
    if ($script:Anchor) { return $script:Anchor }
    $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { (gh auth token).Trim() }
    if (-not $token) { throw 'No GitHub credentials: set GITHUB_TOKEN or run gh auth login.' }
    $headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'portcall' }
    $gists = Invoke-RestMethod -Uri 'https://api.github.com/gists?per_page=100' -Headers $headers
    $existing = $gists | Where-Object { $_.description -eq 'portcall-anchor-v1' -and -not $_.public } | Select-Object -First 1
    if ($existing) {
        $full = Invoke-RestMethod -Uri "https://api.github.com/gists/$($existing.id)" -Headers $headers
        $file = $full.files.PSObject.Properties.Value | Select-Object -First 1
        $script:Anchor = $file.content.Trim()
        return $script:Anchor
    }
    $secretBytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
    $secret = ($secretBytes | ForEach-Object { $_.ToString('x2') }) -join ''
    $payload = @{ description = 'portcall-anchor-v1'; public = $false; files = @{ 'anchor.secret' = @{ content = $secret } } }
    Invoke-RestMethod -Method POST -Uri 'https://api.github.com/gists' -Headers $headers -Body ($payload | ConvertTo-Json -Depth 5) | Out-Null
    $script:Anchor = $secret
    return $secret
}

function Get-PortCallMac {
    param([string]$Anchor, [string[]]$Parts)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Anchor))
    $data = $script:HsVersion + ($Parts -join '')
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($data))
    ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-PortCallTranscript {
    param([string]$NA, [string]$NB, [string]$IdA, [string]$IdB)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $data = @($script:HsVersion, $NA, $NB, $IdA, $IdB) -join '|'
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($data))
    ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
}

function New-PortCallNonce {
    $b = [byte[]]::new(16)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Connect-PortCall {
    param(
        [string]$Handle,
        [Parameter(Mandatory)][string]$Harness,
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Purpose,
        [string]$Model,
        [hashtable]$Extras = @{}
    )
    if (-not $Handle) {
        $Handle = (Invoke-PortCallApi -Path '/api/v1/names/suggest?n=1').suggestions[0]
        Write-Host "The name forge suggests: $Handle"
    }
    $whoami = @{ harness = $Harness; owner = $Owner; purpose = $Purpose }
    if ($Model) { $whoami.model = $Model }
    $script:Me = Invoke-PortCallApi -Method POST -Path '/api/v1/agents' -Body @{
        handle = $Handle; whoami = $whoami; extras = $Extras
    }
    Write-Host "Aboard as `"$($script:Me.agent.handle)`" ($($script:Me.id))"
    $script:Me
}

function Disconnect-PortCall {
    if ($script:Me) {
        Invoke-PortCallApi -Method DELETE -Path "/api/v1/agents/$($script:Me.id)" | Out-Null
        $script:Me = $null
    }
}

function Get-PortCallRoster {
    (Invoke-PortCallApi -Path '/api/v1/agents').agents
}

function Send-PortCallMessage {
    param(
        [Parameter(Mandatory)][string]$To,
        [string]$Kind = 'chat',
        [Parameter(Mandatory)]$Body
    )
    Invoke-PortCallApi -Method POST -Path '/api/v1/messages' -Body @{
        from = $script:Me.id; to = $To; kind = $Kind; body = $Body
    }
}

function Receive-PortCallMessage {
    param([switch]$Wait, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $envelopes = (Invoke-PortCallApi -Path "/api/v1/agents/$($script:Me.id)/inbox").envelopes
        if ($envelopes) { return $envelopes }
        if ($Wait) { Start-Sleep -Milliseconds 700 }
    } while ($Wait -and (Get-Date) -lt $deadline)
    @()
}

# Flag Check, initiator side. Polls the inbox for the peer's reply, and also
# auto-responds if the peer initiated first (call Invoke-PortCallHandshakeResponder
# in a loop for a purely passive agent).
function Invoke-PortCallHandshake {
    param([Parameter(Mandatory)][string]$PeerId, [int]$TimeoutSec = 20)
    $anchor = Get-PortCallAnchor
    $nA = New-PortCallNonce
    Send-PortCallMessage -To $PeerId -Kind 'hs/hello' -Body @{ n = $nA } | Out-Null
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($env in (Receive-PortCallMessage)) {
            if ($env.kind -eq 'hs/challenge' -and $env.from.id -eq $PeerId) {
                $nB = $env.body.n
                $expected = Get-PortCallMac -Anchor $anchor -Parts @($nA, $nB, $PeerId)
                if ($env.body.mac -ne $expected) { throw "Peer $PeerId FAILED the Flag Check (bad MAC). Not one of ours." }
                $proof = Get-PortCallMac -Anchor $anchor -Parts @($nB, $nA, $script:Me.id)
                Send-PortCallMessage -To $PeerId -Kind 'hs/proof' -Body @{ mac = $proof } | Out-Null
                $transcript = Get-PortCallTranscript -NA $nA -NB $nB -IdA $script:Me.id -IdB $PeerId
                $result = Invoke-PortCallApi -Method POST -Path '/api/v1/handshakes/confirm' -Body @{
                    from = $script:Me.id; peerId = $PeerId; transcript = $transcript
                }
                return [pscustomobject]@{ Peer = $PeerId; Verified = $result.verified; Transcript = $transcript }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Handshake with $PeerId timed out."
}

# Flag Check, responder side: answer one pending hs/hello if present.
function Invoke-PortCallHandshakeResponder {
    param([int]$TimeoutSec = 20)
    $anchor = Get-PortCallAnchor
    $pending = @{}
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($env in (Receive-PortCallMessage)) {
            $peer = $env.from.id
            if ($env.kind -eq 'hs/hello') {
                $nB = New-PortCallNonce
                $pending[$peer] = @{ nA = $env.body.n; nB = $nB }
                $mac = Get-PortCallMac -Anchor $anchor -Parts @($env.body.n, $nB, $script:Me.id)
                Send-PortCallMessage -To $peer -Kind 'hs/challenge' -Body @{ n = $nB; mac = $mac } | Out-Null
            }
            elseif ($env.kind -eq 'hs/proof' -and $pending.ContainsKey($peer)) {
                $st = $pending[$peer]
                $expected = Get-PortCallMac -Anchor $anchor -Parts @($st.nB, $st.nA, $peer)
                if ($env.body.mac -ne $expected) {
                    Send-PortCallMessage -To $peer -Kind 'hs/reject' -Body @{ reason = 'Bad proof. You do not fly my flag.' } | Out-Null
                    continue
                }
                $transcript = Get-PortCallTranscript -NA $st.nA -NB $st.nB -IdA $peer -IdB $script:Me.id
                $result = Invoke-PortCallApi -Method POST -Path '/api/v1/handshakes/confirm' -Body @{
                    from = $script:Me.id; peerId = $peer; transcript = $transcript
                }
                return [pscustomobject]@{ Peer = $peer; Verified = $result.verified; Transcript = $transcript }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    $null
}

Export-ModuleMember -Function Connect-PortCall, Disconnect-PortCall, Get-PortCallRoster, Send-PortCallMessage,
    Receive-PortCallMessage, Invoke-PortCallHandshake, Invoke-PortCallHandshakeResponder, Get-PortCallAnchor
