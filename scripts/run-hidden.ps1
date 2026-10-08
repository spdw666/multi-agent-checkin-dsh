param([Parameter(Mandatory=$true)][string]$ConfigFile,[Parameter(Mandatory=$true)][string]$NodeExecutable)
$ErrorActionPreference='Stop'
$Entry=Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\ai-credit.mjs'
$ConfigFile=(Resolve-Path -LiteralPath $ConfigFile).Path
$Config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
$DataDir=if([IO.Path]::IsPathRooted($Config.dataDir)){$Config.dataDir}else{Join-Path (Split-Path -Parent $ConfigFile) $Config.dataDir}
try {
    $Runtime=Get-Content -LiteralPath (Join-Path $DataDir 'runtime.json') -Raw | ConvertFrom-Json
    $Health=Invoke-RestMethod -Uri ($Runtime.baseUrl+'/health') -TimeoutSec 3
    if($Health.service -eq 'ai-credit-gateway'){Write-Output 'AUTOSTART_ALREADY_RUNNING';exit 0}
} catch {}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
& $NodeExecutable $Entry serve --config $ConfigFile 2>&1 | Out-File -LiteralPath (Join-Path $DataDir 'service-task.log') -Encoding utf8 -Append
exit $LASTEXITCODE
