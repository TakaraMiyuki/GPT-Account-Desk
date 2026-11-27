param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$LegacyExecutable,
    [Parameter(Mandatory)][string]$Output,
    [int]$Port = 19670
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$legacy = (Resolve-Path -LiteralPath $LegacyExecutable).Path
$run = Join-Path (Get-Location).Path ('.qa\run-v012-' + (New-Guid).ToString('N'))
$data = Join-Path $run 'data'
node tools/quota-smoke.mjs fixture $data
if ($LASTEXITCODE -ne 0) { throw 'Cannot generate synthetic test data.' }
$oldBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldBrowserDir = $env:WEBVIEW2_USER_DATA_FOLDER

function Invoke-QuotaTest($program, $phase) {
    $endpoint = "http://127.0.0.1:$Port"
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $run $phase
    $app = Start-Process -FilePath $program -ArgumentList '--data-dir', ('"' + $data + '"') -PassThru -WindowStyle Hidden
    try {
        $connected = $false
        for ($attempt = 0; $attempt -lt 35; $attempt++) {
            if ($app.HasExited) { throw "Application exited with code $($app.ExitCode)." }
            try {
                if ((Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 1) | Where-Object { $_.url -like '*tauri.localhost*' }) {
                    $connected = $true
                    break
                }
            } catch {}
            Start-Sleep -Milliseconds 450
        }
        if (!$connected) { throw "Local WebView2 debugger unavailable during phase $phase." }
        node tools/quota-smoke.mjs $phase $data $endpoint $Output
        if ($LASTEXITCODE -ne 0) { throw "Desktop quota verification failed in phase $phase." }
    } finally {
        if (!$app.HasExited) {
            [void]$app.CloseMainWindow()
            if (!$app.WaitForExit(3000)) { Stop-Process -Id $app.Id -Force }
        }
        $script:Port++
    }
}
try {
    Invoke-QuotaTest $legacy 'legacy'
    Invoke-QuotaTest $exe 'monitor'
    Invoke-QuotaTest $exe 'restart'
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArgs
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldBrowserDir
}
