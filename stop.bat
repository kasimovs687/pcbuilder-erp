@echo off
rem =============================================================================
rem  PCBuilder ERP - stop the server.
rem  Finds the process listening on the port from data\port.txt and stops it.
rem  Uses netstat (works in every environment, unlike Get-NetTCPConnection).
rem  Pure ASCII on purpose: cmd.exe reads .bat files in the OEM code page.
rem =============================================================================
setlocal EnableExtensions
chcp 65001 >nul
title PCBuilder ERP - stop
cd /d "%~dp0"

set "PORT=3000"
if exist "data\port.txt" set /p PORT=<"data\port.txt"

echo.
echo   Stopping PCBuilder ERP on port %PORT% ...
echo.

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do (
  if not "%%P"=="0" (
    echo   stopping PID %%P
    taskkill /f /pid %%P >nul 2>nul
    set "FOUND=1"
  )
)

if not defined FOUND echo   nothing is listening on this port

echo.
echo   Done. The server window can be closed now.
timeout /t 3 >nul
exit /b 0
