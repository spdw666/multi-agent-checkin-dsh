param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [switch]$BundleCore,
    [string]$NodeExecutable,
    [string]$CoreDirectory = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'AiCreditDesktop.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $compiler = Get-Command csc.exe -ErrorAction SilentlyContinue
    if (-not $compiler) { throw 'Install the Windows .NET Framework compiler or run from a Visual Studio developer shell.' }
    $csc = $compiler.Source
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = [IO.Path]::GetFullPath($OutputDirectory)
$exe = Join-Path $output 'AI积分网关.exe'
$logo = Join-Path $PSScriptRoot 'app-logo.png'
$icon = Join-Path $PSScriptRoot 'app-logo-rounded.ico'
& $csc /nologo /utf8output /codepage:65001 /target:winexe "/out:$exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$logo,AiCredit.BrandLogo.png" "/resource:$icon,AiCredit.BrandIcon.ico" "/win32icon:$icon" $source
if ($LASTEXITCODE -ne 0) { throw "Native compilation failed with exit code $LASTEXITCODE" }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'platform-icons')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'platform-icons') -Destination $output -Recurse -Force
}
if ($BundleCore) {
    if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
    $node = [IO.Path]::GetFullPath($NodeExecutable)
    $major = & $node -p 'Number(process.versions.node.split(".")[0])'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'Node.js 24 or newer is required.' }
    $core = [IO.Path]::GetFullPath($CoreDirectory)
    foreach ($required in @('bin/ai-credit.mjs','vendor/workbuddy-core.mjs','vendor/trae-core.mjs','config.example.json','package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $core $required))) { throw "Missing $required; run npm ci and npm run build in the repository first." }
    }
    $destination = Join-Path $output 'core'
    if ([string]::Equals($core,$destination,[StringComparison]::OrdinalIgnoreCase)) { throw 'Core output must differ from source.' }
    New-Item -ItemType Directory -Path $destination,(Join-Path $output 'runtime') -Force | Out-Null
    foreach ($directory in @('bin','bundle','src','web','docs')) {
        Copy-Item -LiteralPath (Join-Path $core $directory) -Destination $destination -Recurse -Force
    }
    $vendor = Join-Path $destination 'vendor'
    New-Item -ItemType Directory -Path $vendor -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $core 'vendor') -Force | Where-Object { $_.Name -notin @('qwen-python','node_modules') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $vendor -Recurse -Force }
    foreach ($name in @('package.json','config.example.json','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml')) {
        Copy-Item -LiteralPath (Join-Path $core $name) -Destination $destination -Force
    }
    Copy-Item -LiteralPath $node -Destination (Join-Path $output 'runtime/node.exe') -Force
    & (Join-Path $output 'runtime/node.exe') (Join-Path $destination 'bin/ai-credit.mjs') help
    if ($LASTEXITCODE -ne 0) { throw 'Bundled backend smoke test failed.' }
}
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "NATIVE_BUILD_OK executable=$exe sha256=$hash bundled=$BundleCore"
exit 0
