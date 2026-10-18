@echo off
rem LumenDock setup: installs the hub, offers adb, adds the desktop icon. Nothing starts with Windows.
set "SETUP=%~dp0scripts\windows\install.ps1"
if not exist "%SETUP%" set "SETUP=%~dp0install.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP%" %*
echo.
pause
