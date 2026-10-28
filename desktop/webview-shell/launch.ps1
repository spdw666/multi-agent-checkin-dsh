param([switch]$Background,[switch]$Demo)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
if(-not [Environment]::Is64BitOperatingSystem){throw '此下载包需要Windows 10/11 x64。'}
$release=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
if(-not $release -or $release -lt 528040){
 Add-Type -AssemblyName System.Windows.Forms
 $answer=[Windows.Forms.MessageBox]::Show('本工作台需要.NET Framework 4.8或更新版本。是否打开Microsoft官方下载页？','运行环境',[Windows.Forms.MessageBoxButtons]::YesNo)
 if($answer -eq [Windows.Forms.DialogResult]::Yes){Start-Process 'https://dotnet.microsoft.com/download/dotnet-framework/net48'}
 exit 2
}
$exe=Join-Path $root 'AI积分网关.exe'
if(-not(Test-Path -LiteralPath (Join-Path $root 'gateway.portable.json'))){throw '请把便携包完整解压后运行，不要只复制exe。'}
$argsList=@();if($Background){$argsList+='--background'};if($Demo){$argsList+='--demo'}
if($argsList.Count){Start-Process -FilePath $exe -ArgumentList $argsList -WorkingDirectory $root}else{Start-Process -FilePath $exe -WorkingDirectory $root}
