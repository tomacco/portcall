$ErrorActionPreference = 'Stop'
$repoRoot = if ($args[0]) { $args[0] } else { Split-Path $PSScriptRoot }
$port = 4879
$daemon = "http://127.0.0.1:$port"
$originalProfile = $env:USERPROFILE
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("portcall-hook-" + [guid]::NewGuid())
$daemonProcess = $null

function Invoke-JsonApi([string]$Method, [string]$Path, $Body = $null, [string]$Token = '') {
    $parameters = @{ Method = $Method; Uri = "$daemon$Path"; ContentType = 'application/json' }
    if ($Token) { $parameters.Headers = @{ Authorization = "Bearer $Token" } }
    if ($null -ne $Body) { $parameters.Body = $Body | ConvertTo-Json -Depth 8 }
    Invoke-RestMethod @parameters
}

try {
    $daemonProcess = Start-Process -FilePath 'node' -ArgumentList 'src/daemon.ts', '--port', $port, '--identity', 'none' `
        -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try { Invoke-RestMethod "$daemon/api/v1/status" | Out-Null; break } catch { Start-Sleep -Milliseconds 50 }
    }
    Invoke-RestMethod "$daemon/api/v1/status" | Out-Null

    $env:USERPROFILE = Join-Path $testRoot 'home'
    $base = Join-Path $env:USERPROFILE '.claude/portcall'
    New-Item -ItemType Directory -Force (Join-Path $base 'state') | Out-Null
    $hook = Join-Path $base 'portcall-hook.ps1'
    Copy-Item (Join-Path $repoRoot 'integrations/claude-code/portcall-hook.ps1') $hook
    @{ daemonUrl = $daemon; owner = 'test@example.invalid' } | ConvertTo-Json | Set-Content (Join-Path $base 'config.json')
    $inputJson = '{"session_id":"hook-test","cwd":"C:\\project"}'

    $start = $inputJson | pwsh -NoProfile -File $hook -Event SessionStart | ConvertFrom-Json
    if ($start.systemMessage -notlike '*aboard as*') { throw 'SessionStart did not announce registration.' }
    $stateFile = Join-Path $base 'state/hook-test.json'
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $publicRoster = Invoke-RestMethod "$daemon/api/v1/agents" | ConvertTo-Json -Depth 8
    if ($publicRoster -like '*C:\project*' -or $publicRoster -like '*hook-test*') {
        throw 'Public roster leaked Claude cwd or session id.'
    }

    $peer = Invoke-JsonApi POST '/api/v1/agents' @{
        handle = 'Peer'; whoami = @{ harness = 'test'; owner = 'test'; purpose = 'hook inbox' }
    }
    $channel = Invoke-JsonApi POST '/api/v1/channels' @{
        from = $peer.id; topic = 'Hook safety'; visibility = 'public'
    } $peer.token
    Invoke-JsonApi POST "/api/v1/channels/$($channel.id)/join" @{ from = $state.id } $state.token | Out-Null
    Invoke-JsonApi POST "/api/v1/channels/$($channel.id)/messages" @{
        from = $peer.id; kind = 'chat'; body = @{ text = 'fixture signal' }
    } $peer.token | Out-Null

    $promptRaw = $inputJson | pwsh -NoProfile -File $hook -Event UserPromptSubmit
    $prompt = $promptRaw | ConvertFrom-Json
    $context = $prompt.hookSpecificOutput.additionalContext
    if ($context -notlike '*UNTRUSTED*' -or $context -notlike "*$($channel.id)*" -or $context -notlike '*fixture signal*') {
        throw 'UserPromptSubmit omitted channel-bound untrusted inbox context.'
    }
    if ($context -like "*$($state.token)*") { throw 'Hook token leaked into model context.' }

    $inputJson | pwsh -NoProfile -File $hook -Event SessionEnd | Out-Null
    if (Test-Path $stateFile) { throw 'SessionEnd left its state file behind.' }
    $roster = Invoke-JsonApi GET '/api/v1/agents'
    if ($roster.agents.id -contains $state.id) { throw 'SessionEnd did not deregister.' }
    Write-Host 'PASS: Windows Claude hook lifecycle is channel-bound and keeps credentials out of context'
}
finally {
    $env:USERPROFILE = $originalProfile
    if ($daemonProcess -and -not $daemonProcess.HasExited) { Stop-Process -Id $daemonProcess.Id -Force }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
