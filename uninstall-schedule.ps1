# install-schedule.ps1 로 등록한 자동 실행을 지워요. 지금 켜져 있는 봇 창은 건드리지 않아요.
# 실행: 이 폴더에서  powershell -ExecutionPolicy Bypass -File .\uninstall-schedule.ps1
$name = 'TossPaperBot'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "자동 실행을 지웠어요. 켜져 있는 봇 창은 그대로예요."
} else { Write-Host "등록된 자동 실행이 없어요." }
