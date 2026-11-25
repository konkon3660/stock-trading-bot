# 평일(월~금) 오전 9:50과 Windows에 로그인할 때 봇을 자동으로 켜는 예약 작업을 등록해요. 한 번만 실행하면 돼요.
# - 봇은 한 번에 하나만 돌아요. 이미 켜져 있으면 새로 뜬 창은 바로 닫혀요.
# - 9:50에 켜는 건 데이마켓(10:00)부터 녹화하려고요. 켜진 봇은 주말에도 꺼지지 않고 기다렸다가 다음 장을 이어서 봐요.
# - PC가 절전 중이면 깨워서 켜요(전원 옵션에서 '절전 해제 타이머 허용'이 켜져 있어야 해요). 전원이 꺼져 있거나 로그인 안 된 상태면 못 켜요.
# - 봇 창은 그대로 화면에 떠요. Ctrl+C로 끄면 다음 예약 시각이나 다음 로그인 때 다시 켜져요.
# 등록: 이 폴더에서  powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1
# 해제: 이 폴더에서  powershell -ExecutionPolicy Bypass -File .\uninstall-schedule.ps1
$ErrorActionPreference = 'Stop'
$name = 'TossPaperBot'
$dir = $PSScriptRoot
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\run.ps1`"" -WorkingDirectory $dir
$triggers = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '09:50'),
  (New-ScheduledTaskTrigger -AtLogOn -User $user)
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$desc = '토스 페이퍼 트레이딩 봇 자동 실행 (가상 매매만, 실제 주문 없음)'
try {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
  Write-Host "등록했어요: 작업 스케줄러의 '$name' (평일 09:50, 로그인할 때)"
} catch {
  # PC 설정에 따라 '로그인할 때' 조건은 관리자 권한이 필요해요. 그럴 땐 평일 09:50만 등록
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers[0] -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
  Write-Host "등록했어요: 작업 스케줄러의 '$name' (평일 09:50). '로그인할 때' 조건은 권한이 없어서 뺐어요."
}
Write-Host "지금 바로 켜 보려면:  Start-ScheduledTask -TaskName $name"
