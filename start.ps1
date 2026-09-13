param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$serviceUrl = 'http://127.0.0.1:17863/health'
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
try {
    $health = Invoke-RestMethod -Uri $serviceUrl -TimeoutSec 2
    if ($health.service -ne 'codex-agentrouter-recovery-proxy') { throw 'Port 17863 is occupied by another service.' }
    if (-not $Restart) { Write-Output 'Proxy already running.'; exit 0 }
    $proxyProcessId = [int](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'proxy.pid'))
    $existingProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $proxyProcessId)
    if ($existingProcess.Name -ne 'node.exe' -or -not $existingProcess.CommandLine.Contains($serverFile)) { throw 'PID does not match this proxy; refusing to stop it.' }
    Stop-Process -Id $proxyProcessId -ErrorAction Stop
    Wait-Process -Id $proxyProcessId -ErrorAction SilentlyContinue
} catch [System.Net.WebException] { }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$configFile = Join-Path $env:USERPROFILE '.codex\config.toml'
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $serverFile + '"'), ('"' + $configFile + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'proxy.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'proxy.stderr.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'proxy.pid')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw 'Proxy exited during startup. Check proxy.stderr.log.' }
    try {
        $health = Invoke-RestMethod -Uri $serviceUrl -TimeoutSec 2
        if ($health.service -eq 'codex-agentrouter-recovery-proxy') { Write-Output ('Proxy running on 127.0.0.1:17863; PID ' + $process.Id); exit 0 }
    } catch [System.Net.WebException] { }
}
throw 'Proxy startup did not become healthy.'
