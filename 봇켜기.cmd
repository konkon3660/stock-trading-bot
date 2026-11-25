@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File .\orb\run_all.ps1
pause
