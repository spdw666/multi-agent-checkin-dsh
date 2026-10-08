param([string]$ConfigFile,[string]$NodeExecutable)
$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName 'AiCreditGateway' -Confirm:$false -ErrorAction SilentlyContinue
Write-Output 'AUTOSTART_REMOVED AiCreditGateway'
