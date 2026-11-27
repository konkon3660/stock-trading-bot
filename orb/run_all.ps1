# 봇 네 개(갭 봇 · 보유 주식 관리 · 애프터장 · 프리장 연습)를 창 하나에서 같이 켜요. 켜고 끄는 건 orb\modes.json (live=실전, paper=연습, off=끔)
# 실행: 프로젝트 폴더의 "봇켜기.cmd" 더블클릭, 또는  powershell -ExecutionPolicy Bypass -File .\orb\run_all.ps1
# - 같은 봇이 이미 다른 창에서 돌면 그 봇은 여기서 안 켜요(running.pid로 확인).
# - 봇이 오류로 멈추면 1분 뒤 다시 켜요(1시간에 5번 넘으면 그만).
# - Ctrl+C 또는 창 닫기 → 모두 꺼지고 절전 방지도 풀려요.
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$pw = Add-Type -MemberDefinition $sig -Name PowerAll -Namespace TossBots -PassThru
$KEEP_AWAKE = [uint32]2147483649; $RELEASE = [uint32]2147483648
[void]$pw::SetThreadExecutionState($KEEP_AWAKE)
Set-Location (Split-Path $PSScriptRoot -Parent)
$m = Get-Content .\orb\modes.json -Raw | ConvertFrom-Json
$names = @{ gap = '갭 봇'; hold = '보유 주식 관리'; ah = '애프터장'; pre = '프리장 연습' }
$bots = @()
foreach ($k in 'gap', 'hold', 'ah', 'pre') {
  $mode = $m.$k
  if (-not $mode -or $mode -eq 'off') { Write-Host ("[{0}] 꺼 둠 (orb\modes.json)" -f $names[$k]); continue }
  $a = @('orb/gap_dip.mjs')
  if ($k -ne 'gap') { $a += "--$k" }
  if ($mode -eq 'live' -and $k -ne 'pre') { $a += '--live' }  # 프리장은 연습 전용
  $bots += [pscustomobject]@{ Key = $k; Name = $names[$k]; Mode = $mode; Args = $a; Proc = $null; Starts = @() }
}
function Start-Bot($b) {
  $b.Proc = Start-Process -FilePath 'node' -ArgumentList $b.Args -NoNewWindow -PassThru
  $null = $b.Proc.Handle
  $b.Starts += (Get-Date)
  Write-Host ("[{0}] 켬 ({1}) : node {2}" -f $b.Name, $(if ($b.Mode -eq 'live') { '실전' } else { '연습' }), ($b.Args -join ' '))
}
Write-Host "절전 방지 켬 - 이 창을 닫거나 Ctrl+C로 끄면 봇이 모두 꺼져요."
try {
  foreach ($b in $bots) { Start-Bot $b; Start-Sleep -Seconds 2 }
  while ($true) {
    Start-Sleep -Seconds 30
    foreach ($b in $bots) {
      if ($b.Proc -and $b.Proc.HasExited) {
        $code = $b.Proc.ExitCode
        if ($code -eq 3) { Write-Host ("[{0}] 이미 다른 창에서 돌고 있어서 여기선 안 켜요" -f $b.Name); $b.Proc = $null; continue }
        $recent = @($b.Starts | Where-Object { $_ -gt (Get-Date).AddHours(-1) })
        if ($recent.Count -ge 5) { Write-Host ("[{0}] 1시간에 5번 넘게 멈춰서 다시 안 켜요 - 기록을 확인해 주세요" -f $b.Name); $b.Proc = $null; continue }
        Write-Host ("[{0}] 멈춤(코드 {1}) - 1분 뒤 다시 켬" -f $b.Name, $code)
        Start-Sleep -Seconds 60; Start-Bot $b
      }
    }
  }
}
finally {
  foreach ($b in $bots) { if ($b.Proc -and -not $b.Proc.HasExited) { Stop-Process -Id $b.Proc.Id -ErrorAction SilentlyContinue } }
  [void]$pw::SetThreadExecutionState($RELEASE)
  Write-Host "봇 모두 끔 · 절전 방지 끔"
}
