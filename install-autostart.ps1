# Keeps the Codex recovery proxy alive without an interactive window.
# The task owns the node process directly, so when the proxy dies the task ends
# and the repeating trigger brings it straight back.
#   Install:   powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
#   Remove:    powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'CodexAgentRouterRecoveryProxy'

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $existing) { Write-Output "Task $taskName is not registered."; exit 0 }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed scheduled task $taskName. The proxy is no longer started automatically."
    exit 0
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
$configFile = Join-Path $env:USERPROFILE '.codex\config.toml'
$shim = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $serverFile)) { throw "Missing $serverFile" }
if (-not (Test-Path -LiteralPath $configFile)) { throw "Missing $configFile" }
if (-not (Test-Path -LiteralPath $shim)) { throw "Missing $shim" }

# wscript has no console of its own, so nothing appears on screen even when the
# task runs under an interactive logon. The shim waits on node, so the task ends
# when the proxy does.
$arguments = '//nologo "{0}" "{1}" "{2}" "{3}"' -f $shim, $node, $serverFile, $configFile
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arguments -WorkingDirectory $PSScriptRoot

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Restarts the proxy within two minutes if it ever exits; ignored while it runs.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes 2)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

$description = 'Keeps the Codex AgentRouter recovery proxy listening on 127.0.0.1:17863.'
$register = {
    param($principal)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $watchdog) `
        -Settings $settings -Principal $principal -Description $description -Force | Out-Null
}

# S4U runs with no console window at all; fall back to an interactive principal
# when the account is not allowed to register one.
try {
    & $register (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited)
    $logon = 'S4U (no window)'
} catch {
    & $register (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited)
    $logon = 'Interactive'
}

Write-Output ('Registered {0} using {1}.' -f $taskName, $logon)
