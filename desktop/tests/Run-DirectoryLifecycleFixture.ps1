param([string]$Source=(Join-Path (Split-Path $PSScriptRoot -Parent) 'AiCreditDesktop.cs'),[ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Name='directory',[ValidateSet('late-success','late-error','retry')][string]$Mode='late-success',[string]$OutputDirectory=(Join-Path ([IO.Path]::GetTempPath()) ('aigw-directory-'+[guid]::NewGuid().ToString('N'))))
$ErrorActionPreference='Stop'
$src=Split-Path $PSScriptRoot -Parent
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$exe=Join-Path $OutputDirectory ($Name+'-lifecycle.exe')
& $csc /nologo /utf8output /codepage:65001 /target:exe /main:DirectoryLifecycleFixture "/out:$exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$src\app-logo.png,AiCredit.BrandLogo.png" "/resource:$src\app-logo-rounded.ico,AiCredit.BrandIcon.ico" $Source (Join-Path $PSScriptRoot 'DirectoryLifecycleFixture.cs')
if($LASTEXITCODE -ne 0){throw 'compile failed'}
& $exe $Mode
exit $LASTEXITCODE
