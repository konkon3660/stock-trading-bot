# 갭상승 눌림 지정가 봇(gap_dip.mjs)을 실행하면서 PC가 절전 모드로 들어가지 않게 막아요 (run_orb.ps1과 같은 방식).
# 실행: 프로젝트 폴더(C:\Projects\toss-bot)에서  powershell -ExecutionPolicy Bypass -File .\orb\run_gap.ps1 [--live]
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace GapDip -PassThru
$KEEP_AWAKE = [uint32]2147483649   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$RELEASE = [uint32]2147483648      # ES_CONTINUOUS
[void]$k::SetThreadExecutionState($KEEP_AWAKE)
Write-Host "절전 방지 켬 - 이 창을 닫거나 Ctrl+C로 끄면 원래대로 돌아가요."
Set-Location (Split-Path $PSScriptRoot -Parent)
try { node orb/gap_dip.mjs @args }
finally { [void]$k::SetThreadExecutionState($RELEASE); Write-Host "절전 방지 끔" }
