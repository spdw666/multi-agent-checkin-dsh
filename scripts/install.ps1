param([switch]$NoStart)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if(!(Get-Command node -ErrorAction SilentlyContinue)){throw 'Install Node.js 24+ before setup.'}
node -e "if(+process.versions.node.split('.')[0]<24)process.exit(1)"
if($LASTEXITCODE){throw 'Node.js 24+ required.'}
& npm.cmd ci
if($LASTEXITCODE){throw 'Dependency installation failed.'}
& npm.cmd run build
if($LASTEXITCODE){throw 'Build failed.'}
if(!(Test-Path config.local.json)){node bin/ai-credit.mjs init;if($LASTEXITCODE){throw 'Configuration initialization failed.'}}
if(!$NoStart){node bin/ai-credit.mjs start;if($LASTEXITCODE){throw 'Background startup failed.'}}
Write-Output 'SETUP_OK headless gateway; configure local credentials and run doctor.'
