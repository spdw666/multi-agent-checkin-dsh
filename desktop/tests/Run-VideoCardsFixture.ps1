param([Parameter(Mandatory=$true)][string]$SourceFile,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$SourceFile=[IO.Path]::GetFullPath($SourceFile)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$assets=Split-Path -Parent $SourceFile
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /utf8output /codepage:65001 /target:exe /main:VideoCardsFixture "/out:$OutputDirectory\VideoCardsFixture.exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$assets\app-logo.png,AiCredit.BrandLogo.png" "/resource:$assets\app-logo-rounded.ico,AiCredit.BrandIcon.ico" $SourceFile (Join-Path $PSScriptRoot 'VideoCardsFixture.cs')
if($LASTEXITCODE-ne0){exit $LASTEXITCODE}
if(Test-Path -LiteralPath "$assets\platform-icons"){Copy-Item -LiteralPath "$assets\platform-icons" -Destination $OutputDirectory -Recurse -Force}
& "$OutputDirectory\VideoCardsFixture.exe" $OutputDirectory
exit $LASTEXITCODE
