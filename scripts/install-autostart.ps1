param([Parameter(Mandatory=$true)][string]$ConfigFile,[Parameter(Mandatory=$true)][string]$NodeExecutable)
$ErrorActionPreference='Stop'
$ConfigFile=(Resolve-Path -LiteralPath $ConfigFile).Path
$NodeExecutable=(Resolve-Path -LiteralPath $NodeExecutable).Path
$Root=Split-Path -Parent $PSScriptRoot
$Launcher=Join-Path $PSScriptRoot 'run-hidden.ps1'
$Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$Launcher+'" -ConfigFile "'+$ConfigFile+'" -NodeExecutable "'+$NodeExecutable+'"'
$Action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments -WorkingDirectory $Root
$Trigger=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$Settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'AiCreditGateway' -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Write-Output 'AUTOSTART_INSTALLED AiCreditGateway (AtLogOn, Interactive, Limited)'
