# One command to go from a fresh copy of this folder to a working proxy.
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 22+ is required and was not found on PATH. Install it from https://nodejs.org and re-run.' }
$major = [int](( & $node --version ) -replace '^v(\d+).*', '$1')
if ($major -lt 22) { throw "Node.js 22+ is required; found $( & $node --version )." }

if ($Uninstall) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-autostart.ps1') -Uninstall
    & $node (Join-Path $PSScriptRoot 'wire-config.mjs') --undo
    Write-Output 'Codex now talks to AgentRouter directly again.'
    exit 0
}

Write-Output '[1/4] Running the test suite...'
& $node --test (Join-Path $PSScriptRoot 'test.mjs') | Select-String -Pattern '^# (tests|pass|fail)'
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; not installing.' }

Write-Output '[2/4] Pointing Codex at the proxy (config.toml is backed up first)...'
& $node (Join-Path $PSScriptRoot 'wire-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not wire config.toml. See the status above; the README covers each case.' }

Write-Output '[3/4] Installing the autostart task...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-autostart.ps1')

Write-Output '[4/4] Waiting for the proxy to answer...'
Start-ScheduledTask -TaskName 'CodexAgentRouterRecoveryProxy'
for ($attempt = 0; $attempt -lt 24; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17863/health' -TimeoutSec 2
        if ($health.service -eq 'codex-agentrouter-recovery-proxy') {
            Write-Output ''
            Write-Output 'Done. Restart Codex (desktop app or CLI) so it picks up the new base_url.'
            exit 0
        }
    } catch [System.Net.WebException] { }
}
throw 'The proxy did not become healthy. Check proxy.stderr.log in this folder.'
