param([switch]$InspectOnly)
$ErrorActionPreference='Stop'
$exe=Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
if(-not (Test-Path -LiteralPath $exe)){throw 'DSH desktop executable not found'}
$processes=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })
$root=$processes | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'ELECTRON_RUN_AS_NODE' } | Select-Object -First 1
if($InspectOnly){@{executable=$exe;running=[bool]$root;preserveDisableGpu=$true;inspectOnly=$true}|ConvertTo-Json -Compress;exit 0}
if($root){
 $p=Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
 if($p){[void]$p.CloseMainWindow();if(-not $p.WaitForExit(8000)){
  foreach($item in $processes){$current=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue;if($current -and $current.Path -eq $exe){Stop-Process -Id $current.Id -Force -ErrorAction SilentlyContinue}}
 }}
 Start-Sleep -Milliseconds 800
}
$new=Start-Process -FilePath $exe -ArgumentList '--disable-gpu' -PassThru -WindowStyle Normal
$ready=$false
$watch=[Diagnostics.Stopwatch]::StartNew();$guiStatus=0
while($watch.ElapsedMilliseconds -lt 22000){Start-Sleep -Milliseconds 500;try{$r=Invoke-WebRequest 'http://127.0.0.1:19387/' -UseBasicParsing -TimeoutSec 1;$guiStatus=[int]$r.StatusCode;if($guiStatus -eq 200){$ready=$true;break}}catch{if($_.Exception.Response){$guiStatus=[int]$_.Exception.Response.StatusCode;if($guiStatus -eq 401){$ready=$true;break}}}}
@{restarted=$ready;pid=$new.Id;executable=$exe;gui='http://127.0.0.1:19387';disableGpu=$true;guiStatus=$guiStatus}|ConvertTo-Json -Compress
if(-not $ready){exit 1}
