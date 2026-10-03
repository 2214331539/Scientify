param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Installer smoke checks run only on a disposable GitHub Actions runner.'
}
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installDirectory = Join-Path $env:RUNNER_TEMP ('Scientify-install-' + [guid]::NewGuid().ToString('N'))
$marker = Join-Path $installDirectory 'ScientifyData\workspace\release-smoke.txt'
New-Item -ItemType Directory -Path (Split-Path $marker) -Force | Out-Null
Set-Content -LiteralPath $marker -Value 'preserve-research-data'
function Install-Package {
    $process = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$installDirectory" -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) { throw 'Installer timed out.' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
Install-Package
foreach ($relative in @('scientify.exe', 'codex.exe', 'licenses\Scientify-LICENSE', 'licenses\codex-LICENSE', 'licenses\codex-NOTICE', 'licenses\THIRD_PARTY_LICENSES.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory $relative))) { throw "Missing payload: $relative" }
}
& (Join-Path $installDirectory 'codex.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Installed Agent cannot start.' }
Install-Package
if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'preserve-research-data') { throw 'Reinstall changed application data.' }
$uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -File | Where-Object { $_.Name -match '^uninstall.*\.exe$' })
if ($uninstallers.Count -ne 1) { throw 'Expected exactly one uninstaller.' }
$process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList "/S _?=$installDirectory" -PassThru -WindowStyle Hidden
if (-not $process.WaitForExit(180000)) { throw 'Uninstaller timed out.' }
if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $marker)) { throw 'Uninstall removed research data.' }
if (Test-Path -LiteralPath (Join-Path $installDirectory 'scientify.exe')) { throw 'Uninstall did not remove the application.' }
Write-Output 'Installer smoke checks passed: payload, reinstall and data-preserving uninstall.'
