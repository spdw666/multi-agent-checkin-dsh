param(
 [Parameter(Mandatory=$true)][string]$CoreDirectory,
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [string]$OutputDirectory=(Join-Path $PSScriptRoot 'portable-dist'),
 [string]$ArchivePath,
 [string]$ReferenceDirectory,
 [string]$DependencyDirectory=(Join-Path (Split-Path $PSScriptRoot -Parent) 'dependencies'),
 [string]$BrandDirectory=(Join-Path $CoreDirectory 'desktop'),
 [string]$NativeSourceFile=(Join-Path $CoreDirectory 'desktop/AiCreditDesktop.cs')
)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputDirectory){throw 'Select a new empty output directory; used user-data must never enter a release.'}
$arguments=@{OutputDirectory=$OutputDirectory;Portable=$true;BundleCore=$true;CoreDirectory=$CoreDirectory;NodeExecutable=$NodeExecutable;DependencyDirectory=$DependencyDirectory;BrandDirectory=$BrandDirectory;NativeSourceFile=$NativeSourceFile}
if($ReferenceDirectory){$arguments.ReferenceDirectory=$ReferenceDirectory}
& (Join-Path $PSScriptRoot 'build.ps1') @arguments
if($LASTEXITCODE -ne 0){throw 'Portable build failed.'}
$root=[IO.Path]::GetFullPath($OutputDirectory)
$files=@(Get-ChildItem -LiteralPath $root -Recurse -File)
$textExtensions=@('.mjs','.js','.json','.css','.html','.ps1','.cmd','.md','.yml','.txt','.config','.py')
foreach($file in $files){
 $relative=$file.FullName.Substring($root.Length+1).Replace('\','/')
 if($relative -match '(^|/)(node_modules|data|user-data|\.git)(/|$)' -or $file.Name -in @('config.local.json','desktop.local.json','api-keys.json','runtime.json') -or $file.Name -match '\.(sqlite|db|log|bak)$'){throw "Forbidden release entry: $relative"}
 if($file.Extension -in $textExtensions -or $file.Name -eq 'LICENSE'){
  $text=[IO.File]::ReadAllText($file.FullName)
  if($text -match '(?i)C:[/\\]+Users[/\\]+ms(?:[/\\]+|\b)|D:[/\\]+AI Memory|Bearer\s+[A-Za-z0-9_-]{24,}|gwv_[A-Za-z0-9_-]{43}'){throw "Private path or credential marker in release entry: $relative"}
 }
}
$sha=[Security.Cryptography.SHA256]::Create()
try{$lines=foreach($file in $files|Sort-Object FullName){$stream=[IO.File]::OpenRead($file.FullName);try{$hash=-join($sha.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')})}finally{$stream.Dispose()};$relative=$file.FullName.Substring($root.Length+1).Replace('\','/');"$hash  $relative"}}finally{$sha.Dispose()}
[IO.File]::WriteAllLines((Join-Path $root 'checksums.sha256'),$lines,(New-Object Text.UTF8Encoding($false)))
if(-not $ArchivePath){$ArchivePath=Join-Path (Split-Path $root -Parent) 'AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip'}
if(Test-Path -LiteralPath $ArchivePath){throw 'Select a new archive path; release archives are not silently overwritten.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($root,[IO.Path]::GetFullPath($ArchivePath),[IO.Compression.CompressionLevel]::Optimal,$false)
$stream=[IO.File]::OpenRead([IO.Path]::GetFullPath($ArchivePath));$sha=[Security.Cryptography.SHA256]::Create();try{$hash=-join($sha.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')})}finally{$stream.Dispose();$sha.Dispose()}
[IO.File]::WriteAllText(([IO.Path]::GetFullPath($ArchivePath)+'.sha256'),("$hash  "+[IO.Path]::GetFileName($ArchivePath)+"`n"),(New-Object Text.UTF8Encoding($false)))
Write-Output "PORTABLE_PACKAGE_OK files=$($files.Count) archive=$ArchivePath sha256=$hash"
