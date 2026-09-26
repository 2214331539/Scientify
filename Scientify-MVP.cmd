@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -WindowStyle Hidden -Command "$builds = @('target\release\scientify.exe', 'target\ui-shell\release\scientify.exe') | ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue }; $latest = $builds | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $latest) { $latest = Get-Item -LiteralPath 'target\debug\scientify.exe' -ErrorAction SilentlyContinue }; if ($latest) { Start-Process -FilePath $latest.FullName -WorkingDirectory (Get-Location).Path -WindowStyle Hidden } else { Write-Host 'Build the desktop application first: pnpm tauri build --no-bundle'; exit 1 }"
if errorlevel 1 pause
