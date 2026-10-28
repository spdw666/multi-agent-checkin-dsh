param([string]$SourceDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop/webview-shell'))
$ErrorActionPreference = 'Stop'
$folder = Join-Path ([IO.Path]::GetFullPath($SourceDirectory)) 'prerequisites'
$metadata = Join-Path $folder 'PROVENANCE.json'
if (-not (Test-Path -LiteralPath $metadata)) { throw 'Pinned WebView2 prerequisite metadata is missing.' }
$source = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
$url = [Uri]$source.downloadUrl
if ($url.Scheme -ne 'https' -or $url.Host -ne 'go.microsoft.com' -or $url.AbsolutePath -ne '/fwlink/p/' -or $url.Query -ne '?LinkId=2124703' -or $source.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unexpected WebView2 prerequisite source.' }
$target = Join-Path $folder 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path -LiteralPath $target)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $source.downloadUrl -OutFile $target -UseBasicParsing
}
$stream = [IO.File]::OpenRead($target)
$sha = [Security.Cryptography.SHA256]::Create()
try { $actual = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose(); $sha.Dispose() }
$signature = Get-AuthenticodeSignature -LiteralPath $target
if ($actual -ne $source.sha256 -or $signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WebView2 bootstrapper does not match pinned bytes and Microsoft signature.' }
Write-Output 'WEBVIEW_PREREQUISITE_OK pinned=true microsoftSignature=valid'
