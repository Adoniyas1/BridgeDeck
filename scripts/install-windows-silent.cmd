@echo off
rem Silent per-user install of the latest local BridgeDeck build, then relaunch it.
rem Launch through Explorer (explorer.exe this-file) when calling from a sandboxed shell,
rem so the install lands in the real %LOCALAPPDATA% rather than an app container.
taskkill /IM bridgedeck.exe /F >nul 2>&1
"%~dp0..\src-tauri\target\release\bundle\nsis\BridgeDeck_0.7.0_x64-setup.exe" /S
start "" "%LOCALAPPDATA%\BridgeDeck\bridgedeck.exe"
