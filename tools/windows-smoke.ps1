param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$LegacyExecutable,
    [int]$Port = 19649
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$legacy = (Resolve-Path -LiteralPath $LegacyExecutable).Path
$runDirectory = Join-Path (Get-Location).Path ('.qa\run-v011-' + (New-Guid).ToString('N'))
$database = Join-Path $runDirectory 'data'
[void][System.IO.Directory]::CreateDirectory($runDirectory)
$oldBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldBrowserDir = $env:WEBVIEW2_USER_DATA_FOLDER

function Invoke-TestApp($program, $phase) {
    $endpoint = "http://127.0.0.1:$Port"
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $runDirectory $phase
    $app = Start-Process -FilePath $program -ArgumentList '--data-dir', ('"' + $database + '"') -PassThru -WindowStyle Hidden
    try {
        $connected = $false
        for ($attempt = 0; $attempt -lt 35; $attempt++) {
            if ($app.HasExited) { throw "The application terminated with code $($app.ExitCode)." }
            try {
                $targets = Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 1
                if ($targets | Where-Object { $_.url -like '*tauri.localhost*' }) {
                    $connected = $true
                    break
                }
            } catch {}
            Start-Sleep -Milliseconds 450
        }
        if (!$connected) { throw "Timed out waiting for the local WebView2 debugger in phase $phase." }
        node tools/review.mjs $endpoint $phase $database $Output
        if ($LASTEXITCODE -ne 0) { throw "Desktop validation failed in phase $phase." }
    } finally {
        if (!$app.HasExited) {
            [void]$app.CloseMainWindow()
            if (!$app.WaitForExit(3000)) { Stop-Process -Id $app.Id -Force }
        }
        $script:Port++
    }
}
try {
    Invoke-TestApp $legacy 'seed'
    Invoke-TestApp $exe 'upgrade'
    Invoke-TestApp $exe 'restart'
    Invoke-TestApp $exe 'revoked'
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArgs
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldBrowserDir
}
