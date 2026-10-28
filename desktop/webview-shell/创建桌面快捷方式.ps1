$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$exe=Join-Path $PSScriptRoot 'AI积分网关.exe'
if(-not(Test-Path -LiteralPath $exe)){throw '请先完整解压下载包。'}
$link=Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI积分网关 Web工作台.lnk'
if((Test-Path -LiteralPath $link) -and [Windows.Forms.MessageBox]::Show('是否更新已有的Web工作台快捷方式？原生版快捷方式保持不变。','创建快捷方式',[Windows.Forms.MessageBoxButtons]::YesNo) -ne [Windows.Forms.DialogResult]::Yes){exit 0}
$shell=New-Object -ComObject WScript.Shell
try{$shortcut=$shell.CreateShortcut($link);$shortcut.TargetPath=$exe;$shortcut.WorkingDirectory=$PSScriptRoot;$shortcut.IconLocation="$exe,0";$shortcut.Description='AI积分网关 Web UI 0.8.1-web.1';$shortcut.Save()}finally{if($shortcut){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
Write-Output 'WEB_SHORTCUT_CREATED'
