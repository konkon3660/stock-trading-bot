' Toss Bot launcher: opens app\runtime\TossBot.exe without a console window.
' First run makes Desktop and Start menu shortcuts and turns on start-at-login (hidden in the tray).
' If it is already running, its window comes forward.
Option Explicit
Dim fso, sh, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
exe = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "app\runtime\TossBot.exe")
If Not fso.FileExists(exe) Then
  MsgBox "TossBot.exe not found: " & exe, 48, "Toss Bot"
  WScript.Quit 1
End If
On Error Resume Next
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
sh.CurrentDirectory = fso.GetParentFolderName(exe)
sh.Run Chr(34) & exe & Chr(34), 1, False
