param(
    [string]$OutputDirectory,
    [string]$DependencyDirectory,
    [string]$NodeExecutable,
    [switch]$BundleCore
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$source = Join-Path $repo 'desktop/webview-shell'
$builder = Join-Path $source 'build.ps1'
if (-not (Test-Path -LiteralPath $builder)) { throw 'The optional desktop/webview-shell source is missing.' }
if (-not $BundleCore) { throw 'The independent portable desktop build requires -BundleCore.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts/webview-desktop' }
if (-not $DependencyDirectory) { $DependencyDirectory = Join-Path $repo '.cache/webview2' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$cache = [IO.Path]::GetFullPath($DependencyDirectory)
if ([string]::Equals($output,$repo,[StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must not overwrite the repository root.' }
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$node = [IO.Path]::GetFullPath($NodeExecutable)
if (-not (Test-Path -LiteralPath $node)) { throw 'Select an existing Node.js executable.' }
$supported = & $node -p '(() => { const [major,minor,patch]=process.versions.node.split(/[.]/).map(Number); return major>22 || (major===22 && (minor>23 || (minor===23 && patch>=3))); })()'
if ($LASTEXITCODE -ne 0 -or "$supported".Trim() -ne 'true') { throw 'Node.js 22.23.3 or newer is required.' }
if ((& $node -p 'process.versions.node').Trim() -ne '22.23.3') { throw 'This portable WebView2 release pins official Node.js 22.23.3.' }
if ($BundleCore) {
    foreach ($required in @('bin/ai-credit.mjs','src/service.mjs','vendor/workbuddy-core.mjs','vendor/trae-core.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repo $required))) { throw "Missing $required; run npm ci and npm run build first." }
    }
}
$parameters = @{
    OutputDirectory = $output
    DependencyDirectory = $cache
    NativeSourceFile = (Join-Path $source 'host/NativeDesktop.cs')
    BrandDirectory = (Join-Path $repo 'desktop')
    CoreDirectory = $repo
    NodeExecutable = $node
    BundleCore = $BundleCore.IsPresent
    Portable = $true
}
$command = Get-Command -Name $builder
foreach ($name in $parameters.Keys) {
    if (-not $command.Parameters.ContainsKey($name)) { throw "WebView2 build contract is missing parameter $name." }
}
& (Join-Path $PSScriptRoot 'prepare-webview-prerequisites.ps1') -SourceDirectory $source
& $builder @parameters
if ($LASTEXITCODE -ne 0) { throw "WebView2 build failed with exit $LASTEXITCODE." }
Write-Output "WEBVIEW_DESKTOP_SOURCE_BUILD_OK portable=true bundleCore=$($BundleCore.IsPresent.ToString().ToLowerInvariant()) output=$output"
