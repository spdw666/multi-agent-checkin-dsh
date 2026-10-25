param([string]$Source=(Join-Path (Split-Path $PSScriptRoot -Parent) 'AiCreditDesktop.cs'),[ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Name='catalog',[switch]$Contract,[string]$InputJson,[string]$Capture,[string]$OutputDirectory=(Join-Path ([IO.Path]::GetTempPath()) ('aigw-catalog-'+[guid]::NewGuid().ToString('N'))))
$ErrorActionPreference='Stop'
$src=Split-Path $PSScriptRoot -Parent
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$exe=Join-Path $OutputDirectory ($Name+'-fixture.exe')
& $csc /nologo /utf8output /codepage:65001 /target:exe /main:CatalogFixture "/out:$exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$src\app-logo.png,AiCredit.BrandLogo.png" "/resource:$src\app-logo-rounded.ico,AiCredit.BrandIcon.ico" $Source (Join-Path $PSScriptRoot 'CatalogFixture.cs')
if($LASTEXITCODE -ne 0){throw 'compile failed'}
$arguments=@();if($Contract){$arguments+='--contract'};if($InputJson){$arguments+=@('--input',$InputJson)};if($Capture){$arguments+=@('--capture',$Capture)};& $exe @arguments
exit $LASTEXITCODE
