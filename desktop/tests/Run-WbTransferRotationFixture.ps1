param(
 [string]$SourceFile=(Join-Path $PSScriptRoot '..\AiCreditDesktop.cs'),
 [string]$OutputDirectory=(Join-Path $PSScriptRoot '..\build\native-transfer-rotation-tests')
)
$ErrorActionPreference='Stop'
$SourceFile=[IO.Path]::GetFullPath($SourceFile)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$assets=Split-Path -Parent $SourceFile
$fixture=Join-Path $PSScriptRoot 'WbTransferRotationFixture.cs'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not(Test-Path -LiteralPath $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'}
New-Item -ItemType Directory -Force -Path $OutputDirectory|Out-Null
& $csc /nologo /utf8output /codepage:65001 /debug+ /target:exe /main:WbTransferRotationFixture "/out:$OutputDirectory\WbTransferRotationFixture.exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$assets\app-logo.png,AiCredit.BrandLogo.png" "/resource:$assets\app-logo-rounded.ico,AiCredit.BrandIcon.ico" $SourceFile $fixture 2>&1|Tee-Object -FilePath (Join-Path $OutputDirectory 'build.log')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& (Join-Path $OutputDirectory 'WbTransferRotationFixture.exe') $OutputDirectory 2>&1|Tee-Object -FilePath (Join-Path $OutputDirectory 'tests.log')
exit $LASTEXITCODE
