param(
 [string]$SourceFile=(Join-Path $PSScriptRoot '..\AiCreditDesktop.cs'),
 [string]$OutputDirectory=(Join-Path $PSScriptRoot '..\build\native-tests')
)
$ErrorActionPreference='Stop'
$SourceFile=[IO.Path]::GetFullPath($SourceFile)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$assets=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path $PSScriptRoot 'WbPagingFixture.cs'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not(Test-Path -LiteralPath $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'}
New-Item -ItemType Directory -Force -Path $OutputDirectory|Out-Null
& $csc /nologo /utf8output /codepage:65001 /target:exe /main:WbPagingFixture "/out:$OutputDirectory\WbPagingFixture.exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$assets\app-logo.png,AiCredit.BrandLogo.png" "/resource:$assets\app-logo-rounded.ico,AiCredit.BrandIcon.ico" $SourceFile $fixture 2>&1|Tee-Object -FilePath (Join-Path $OutputDirectory 'build.log')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& (Join-Path $OutputDirectory 'WbPagingFixture.exe') $OutputDirectory 2>&1|Tee-Object -FilePath (Join-Path $OutputDirectory 'tests.log')
exit $LASTEXITCODE
