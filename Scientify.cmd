@echo off
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Please install pnpm 10.11.0 and run pnpm install first.
  pause
  exit /b 1
)
call pnpm start
if errorlevel 1 pause
