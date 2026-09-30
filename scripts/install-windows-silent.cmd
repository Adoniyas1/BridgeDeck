@echo off
rem Silent per-user install of the newest local BridgeDeck build, then relaunch it.
rem Launch through Explorer (explorer.exe this-file) when calling from a sandboxed shell,
rem so the install lands in the real %LOCALAPPDATA% rather than an app container.
setlocal
set "BUNDLE=%~dp0..\src-tauri\target\release\bundle\nsis"
set "SETUP="
for /f "delims=" %%F in ('dir /b /o:d "%BUNDLE%\BridgeDeck_*_x64-setup.exe" 2^>nul') do set "SETUP=%%F"
if not defined SETUP (echo No BridgeDeck installer found in %BUNDLE% & exit /b 1)
taskkill /IM bridgedeck.exe /F >nul 2>&1
"%BUNDLE%\%SETUP%" /S
start "" "%LOCALAPPDATA%\BridgeDeck\bridgedeck.exe"
