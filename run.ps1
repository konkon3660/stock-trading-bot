# 봇이 켜져 있는 동안 PC가 절전 모드로 들어가지 않게 막고 봇을 실행합니다.
# 화면은 꺼져도 괜찮아요. 노트북 덮개를 닫아서 생기는 절전은 막지 못해요.
# 실행: 이 폴더에서  powershell -ExecutionPolicy Bypass -File .\run.ps1
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace TossPaperBot -PassThru
$KEEP_AWAKE = [uint32]2147483649   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$RELEASE = [uint32]2147483648      # ES_CONTINUOUS
[void]$k::SetThreadExecutionState($KEEP_AWAKE)
Write-Host "절전 방지 켬 - 이 창을 닫거나 Ctrl+C로 봇을 끄면 원래대로 돌아가요."
Set-Location $PSScriptRoot
try { node bot.mjs @args }
finally { [void]$k::SetThreadExecutionState($RELEASE); Write-Host "절전 방지 끔" }
