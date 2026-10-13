@echo off
rem finalize.cmd - finish the rate-toolbar asar patch after ZCode quits.
rem The patched archive is already validated at app.asar.ratetb.tmp;
rem this only moves it over app.asar.
setlocal enabledelayedexpansion

set "ASAR="
if not "%~1"=="" set "ASAR=%~1"
if not defined ASAR if not "%ZCODE_ASAR%"=="" set "ASAR=%ZCODE_ASAR%"
if not defined ASAR (
  for %%R in (
    "D:\Program Files\ZCode"
    "C:\Program Files\ZCode"
    "%LOCALAPPDATA%\Programs\ZCode"
  ) do (
    if not defined ASAR if exist "%%~R\resources\app.asar.ratetb.tmp" set "ASAR=%%~R\resources\app.asar"
  )
)
if not defined ASAR (
  echo Could not locate app.asar with a pending patch file ^(app.asar.ratetb.tmp^).
  echo Re-run instead:  node install.cjs   ^(after quitting ZCode^)
  pause
  exit /b 1
)

set "TMPF=%ASAR%.ratetb.tmp"
if not exist "%TMPF%" (
  echo No pending patch file found: %TMPF%
  echo Run:  node install.cjs
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if %ERRORLEVEL%==0 (
  echo ZCode is still running. Quit ZCode completely first, then run this again.
  pause
  exit /b 1
)

move /y "%TMPF%" "%ASAR%"
if errorlevel 1 (
  echo Move failed - try running as administrator.
  pause
  exit /b 1
)
echo Done. Start ZCode - the toolbar metrics should appear in the composer bar.
pause
