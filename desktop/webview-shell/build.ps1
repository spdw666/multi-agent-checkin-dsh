param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [string]$DependencyDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dependencies'),
    [string]$ReferenceDirectory,
    [switch]$BundleCore,
    [switch]$Portable,
    [string]$CoreDirectory,
    [string]$NodeExecutable,
    [string]$NativeSourceFile = (Join-Path $PSScriptRoot 'host/NativeDesktop.cs'),
    [string]$BrandDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI积分网关/桌面版')
)
$ErrorActionPreference = 'Stop'
if(-not (Test-Path -LiteralPath $NativeSourceFile)){$NativeSourceFile=Join-Path (Split-Path $PSScriptRoot -Parent) 'AiCreditDesktop.cs'}
function Get-PinnedSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
$sdkVersion = '1.0.4314.35'
$packageHash = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$sdk = Join-Path $DependencyDirectory "webview2-$sdkVersion"
$package = Join-Path $DependencyDirectory "microsoft.web.webview2.$sdkVersion.nupkg"
if (-not $ReferenceDirectory) {
    $parentReferences = Split-Path $PSScriptRoot -Parent
    if (Test-Path -LiteralPath (Join-Path $parentReferences 'Microsoft.Web.WebView2.Core.dll')) { $ReferenceDirectory = $parentReferences }
}
if (-not $ReferenceDirectory -and -not (Test-Path -LiteralPath (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Path $DependencyDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $package)) {
        $uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
        Invoke-WebRequest -Uri $uri -OutFile $package -UseBasicParsing
    }
    if ((Get-PinnedSha256 $package) -ne $packageHash) { throw 'WebView2 SDK package hash mismatch.' }
    # ZipFile accepts NuGet's .nupkg extension on Windows PowerShell 5.1.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($package, $sdk)
}
if (-not $ReferenceDirectory -and (Get-PinnedSha256 $package) -ne $packageHash) { throw 'WebView2 SDK package hash mismatch.' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw '.NET Framework x64 compiler was not found.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = [IO.Path]::GetFullPath($OutputDirectory)
$core = if ($ReferenceDirectory) { Join-Path $ReferenceDirectory 'Microsoft.Web.WebView2.Core.dll' } else { Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll' }
$forms = if ($ReferenceDirectory) { Join-Path $ReferenceDirectory 'Microsoft.Web.WebView2.WinForms.dll' } else { Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll' }
$loader = if ($ReferenceDirectory) { Join-Path $ReferenceDirectory 'WebView2Loader.dll' } else { Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll' }
$references = @(
    @{ Path=$core; Hash='acdd517b951829f763d1255f32df1e6a936cb8623a7ebff6b8b24172dede6bd6' },
    @{ Path=$forms; Hash='c66437f80886aecf074804b61af4cc10ad90a95310c8e0a717f31ea377c26b03' },
    @{ Path=$loader; Hash='d3fce90bdeecb08596e377dea6a316354dd8949e32ff09b89d51be00c14e21b6' }
)
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference.Path) -or (Get-PinnedSha256 $reference.Path) -ne $reference.Hash) { throw 'Pinned WebView2 runtime DLL hash mismatch.' }
}
$logo = Join-Path $BrandDirectory 'app-logo.png'
$icon = Join-Path $BrandDirectory 'app-logo-rounded.ico'
if (-not (Test-Path -LiteralPath $logo) -or -not (Test-Path -LiteralPath $icon)) { throw 'Select the existing brand assets using -BrandDirectory.' }
$target = Join-Path $output 'AI积分网关.exe'
& $csc /nologo /utf8output /codepage:65001 /target:winexe /platform:x64 /main:GatewayWebViewHost.Program "/out:$target" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Net.Http.dll "/reference:$core" "/reference:$forms" "/resource:$logo,AiCredit.BrandLogo.png" "/resource:$icon,AiCredit.BrandIcon.ico" "/win32icon:$icon" (Join-Path $PSScriptRoot 'host/GatewayWebViewHost.cs') $NativeSourceFile
if ($LASTEXITCODE -ne 0) { throw "WebView2 host build failed with exit $LASTEXITCODE." }
foreach ($file in @($core,$forms,$loader,$logo,$icon)) {
    $destination = Join-Path $output ([IO.Path]::GetFileName($file))
    if (-not [string]::Equals([IO.Path]::GetFullPath($file),[IO.Path]::GetFullPath($destination),[StringComparison]::OrdinalIgnoreCase)) { Copy-Item -LiteralPath $file -Destination $destination -Force }
}
Copy-Item -LiteralPath $target -Destination (Join-Path $output 'AiCredit.WebView2.exe') -Force
$platformIcons = Join-Path $BrandDirectory 'platform-icons'
if ((Test-Path -LiteralPath $platformIcons) -and -not [string]::Equals([IO.Path]::GetFullPath($platformIcons),[IO.Path]::GetFullPath((Join-Path $output 'platform-icons')),[StringComparison]::OrdinalIgnoreCase)) { Copy-Item -LiteralPath $platformIcons -Destination $output -Recurse -Force }
$licenseOutput = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenseOutput -Force | Out-Null
foreach ($entry in @(@{ Source='LICENSE.txt'; Target='WebView2-LICENSE.txt' },@{ Source='NOTICE.txt'; Target='WebView2-NOTICE.txt' })) {
    $source = if ($ReferenceDirectory) { Join-Path $ReferenceDirectory ('licenses/'+$entry.Target) } else { Join-Path $sdk $entry.Source }
    $destination = Join-Path $licenseOutput $entry.Target
    if ((Test-Path -LiteralPath $source) -and -not [string]::Equals([IO.Path]::GetFullPath($source),[IO.Path]::GetFullPath($destination),[StringComparison]::OrdinalIgnoreCase)) { Copy-Item -LiteralPath $source -Destination $destination -Force }
}
foreach ($name in @('ui','adapter')) {
    $source = Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $source) {
        $destination = Join-Path $output $name
        if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Directory -Path $destination | Out-Null }
        $files = if ($name -eq 'ui') { @('index.html','styles.css','management.css','management.js','app.js','demo.json') } else { @('snapshot.mjs','control.mjs','management.mjs','management-contract.json') }
        foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $destination -Force }
        if ($name -eq 'ui') {
            $icons = Join-Path $destination 'assets/platform-icons'
            New-Item -ItemType Directory -Path $icons -Force | Out-Null
            foreach ($file in @('antigravity.png','bigmodel.png','cline.png','codearts.png','codebuddy.png','codebuddy-cn.png','freeapi.png','hailuo.png','jimeng.png','kling.png','liblib.png','lobster.png','loomy.png','minimax.png','nvidia.png','opencode.png','pixverse.png','qoder.png','qoder-cn.png','qwenwork.png','raccoon.png','trae.png','vidu.png','workbuddy.png','workbuddyai.png','xiaoyunque.png','zcode.png')) { Copy-Item -LiteralPath (Join-Path $source ('assets/platform-icons/' + $file)) -Destination $icons -Force }
        }
        if ($name -eq 'ui' -and (Test-Path -LiteralPath (Join-Path $source 'assets/fonts'))) {
            $fonts = Join-Path $destination 'assets/fonts'
            New-Item -ItemType Directory -Path $fonts -Force | Out-Null
            foreach ($file in @('Montserrat-Regular.otf','Montserrat-Bold.otf','OFL-1.1.txt','THIRD_PARTY_FONTS.md')) {
                Copy-Item -LiteralPath (Join-Path $source "assets/fonts/$file") -Destination $fonts -Force
            }
        }
    }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.ps1') -Destination $output -Force
foreach ($name in $(if($Portable){@('启动新版工作台.cmd','创建桌面快捷方式.ps1','README.md')}else{@('打开新版工作台.cmd','打开重构版工作台.cmd','README.md')})) {
    $file = Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $output -Force }
}
if($BundleCore) {
    if(-not $CoreDirectory){throw '-BundleCore requires an explicit clean -CoreDirectory.'}
    if(-not $NodeExecutable){$NodeExecutable=(Get-Command node.exe -ErrorAction Stop).Source}
    if((& $NodeExecutable -p 'process.versions.node').Trim() -ne '22.23.3'){throw 'This portable release pins Node.js 22.23.3.'}
    $coreRoot=[IO.Path]::GetFullPath($CoreDirectory)
    $version=(Get-Content -LiteralPath (Join-Path $coreRoot 'package.json') -Raw|ConvertFrom-Json).version
    if($version -ne '0.8.1'){throw 'This Web UI release packages backend 0.8.1.'}
    $destination=Join-Path $output 'core';New-Item -ItemType Directory -Path $destination,(Join-Path $output 'runtime') -Force|Out-Null
    foreach($folder in @('bin','bundle','src','web')) {
        $from=Join-Path $coreRoot $folder
        foreach($file in Get-ChildItem -LiteralPath $from -Recurse -File) {
            if($file.Extension -notin @('.mjs','.js','.cjs','.json','.html','.css','.wasm')){throw "Unexpected runtime extension under $folder."}
            $relative=$file.FullName.Substring($coreRoot.Length+1);$to=Join-Path $destination $relative
            New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force|Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $to -Force
        }
    }
    foreach($name in @('package.json','config.example.json','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml','vendor/workbuddy-core.mjs','vendor/trae-core.mjs','vendor/wb-auth-helper.cjs','vendor/qwen-pack.py','vendor/qwen-requirements.txt','vendor/zcode-context/identity.mjs','vendor/zcode-context/system-prompt.mjs','vendor/zcode-context/zcode_system.json','vendor/zcode-context/NOTICE.md','scripts/install-autostart.ps1','scripts/uninstall-autostart.ps1','scripts/restart-dsh.ps1','scripts/hermes-key.mjs')) {
        $to=Join-Path $destination $name;New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $coreRoot $name) -Destination $to -Force
    }
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $coreRoot 'vendor') -File|Where-Object {$_.Name -match '(?i)license'}){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $destination 'vendor') -Force}
    Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $output 'runtime/node.exe') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses/Node-LICENSE.txt'),(Join-Path $PSScriptRoot 'licenses/Node-SHASUMS256.txt') -Destination (Join-Path $output 'licenses') -Force
    $official=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'licenses/Node-SHASUMS256.txt')|Where-Object {$_ -match ' win-x64/node.exe$'}
    if(-not $official -or -not $official.StartsWith((Get-PinnedSha256 $NodeExecutable))){throw 'Bundled Node differs from the official v22.23.3 Windows x64 checksum.'}
    & (Join-Path $output 'runtime/node.exe') (Join-Path $destination 'bin/ai-credit.mjs') help
    if($LASTEXITCODE -ne 0){throw 'Bundled backend smoke test failed.'}
}
if($Portable) {
    if(-not $BundleCore){throw '-Portable requires -BundleCore.'}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable/gateway.portable.json') -Destination $output -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable/config.first-run.json') -Destination (Join-Path $output 'core/config.first-run.json') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable/AI积分网关.exe.config') -Destination $output -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prerequisites') -Destination $output -Recurse -Force
    $installer=Join-Path $output 'prerequisites/MicrosoftEdgeWebview2Setup.exe'
    $origin=Get-Content -LiteralPath (Join-Path $output 'prerequisites/PROVENANCE.json') -Raw|ConvertFrom-Json
    $signature=Get-AuthenticodeSignature -LiteralPath $installer
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation' -or (Get-PinnedSha256 $installer) -ne $origin.sha256){throw 'Official WebView2 bootstrapper signature/hash validation failed.'}
}
@{
    sdk = $sdkVersion
    packageSha256 = $packageHash
    buildTarget = 'x64 .NET Framework / WebView2 net462 / twelve Web workspaces'
    executable = $(if($Portable){'AI积分网关.exe'}else{$target})
    uiVersion = '0.8.1-web.1'
    backendVersion = $(if($BundleCore){'0.8.1'}else{$null})
    portable = [bool]$Portable
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'BUILD-MANIFEST.json') -Encoding UTF8
Write-Output "WEBVIEW2_BUILD_OK sdk=$sdkVersion target=$target"
