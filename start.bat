@echo off
rem =============================================================================
rem  PCBuilder ERP - launcher
rem  1) finds Node.js 22.5+   2) starts the server   3) opens the browser
rem
rem  This file is pure ASCII on purpose: cmd.exe reads .bat files in the OEM
rem  code page, so Russian text stored here would be mangled. Russian messages
rem  come from tools\messages-src.ps1 (UTF-8 with BOM) via tools\show-message.ps1.
rem  Logic lives in tools\run.ps1.
rem =============================================================================
setlocal EnableExtensions
chcp 65001 >nul
title PCBuilder ERP - server
cd /d "%~dp0"

echo.
echo   ============================================================
echo    PCBuilder ERP  -  starting server
echo   ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\show-message.ps1" -CheckNode
if errorlevel 2 (
  echo.
  pause
  exit /b 2
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\run.ps1"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   Server stopped with code %CODE%.
  echo.
  pause
)
exit /b %CODE%
