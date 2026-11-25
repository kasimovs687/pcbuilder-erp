@echo off
rem ---------------------------------------------------------------
rem  Opens the browser on the port the server actually took.
rem  Reads data\port.txt (written by server.js on startup).
rem ---------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0.."

set "PORTFILE=%CD%\data\port.txt"
set "PORT="

for /l %%I in (1,1,45) do (
  if not defined PORT (
    if exist "%PORTFILE%" set /p PORT=<"%PORTFILE%"
  )
  if not defined PORT timeout /t 1 /nobreak >nul
)

if not defined PORT set "PORT=3000"
echo %PORT%| findstr /r "^[0-9][0-9]*$" >nul || set "PORT=3000"

start "" "http://localhost:%PORT%/builder"
exit /b 0
