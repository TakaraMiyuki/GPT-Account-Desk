param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Output,
    [int]$Port = 19730
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$run = Join-Path (Get-Location).Path ('.qa\run-v013-' + (New-Guid).ToString('N'))
$data = Join-Path $run 'data'
node tools/quota-smoke.mjs fixture $data
if ($LASTEXITCODE -ne 0) { throw 'Cannot generate the synthetic vault.' }
node tools/codex-login-smoke.mjs preload $data
if ($LASTEXITCODE -ne 0) { throw 'Cannot generate the pending-login test fixture.' }
$oldBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldBrowserDir = $env:WEBVIEW2_USER_DATA_FOLDER
$oldNodeOptions = $env:NODE_OPTIONS
$endpoint = "http://127.0.0.1:$Port"
$app = $null
try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $run 'webview'
    $preload = (Join-Path $data 'qa-login-preload.cjs').Replace('\','/')
    $env:NODE_OPTIONS = '--require "' + $preload + '"'
    $app = Start-Process -FilePath $exe -ArgumentList '--data-dir', ('"' + $data + '"') -PassThru -WindowStyle Hidden
    $env:NODE_OPTIONS = $oldNodeOptions
    $connected = $false
    for ($attempt = 0; $attempt -lt 36; $attempt++) {
        if ($app.HasExited) { throw "Application exited with code $($app.ExitCode)." }
        try {
            if ((Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 1) | Where-Object { $_.url -like '*tauri.localhost*' }) {
                $connected = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 450
    }
    if (!$connected) { throw 'Local WebView2 debugger unavailable.' }
    node tools/codex-login-smoke.mjs run $data $endpoint $Output
    if ($LASTEXITCODE -ne 0) { throw 'Desktop login cancellation verification failed.' }
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArgs
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldBrowserDir
    $env:NODE_OPTIONS = $oldNodeOptions
    if ($app -and !$app.HasExited) {
        [void]$app.CloseMainWindow()
        if (!$app.WaitForExit(3000)) { Stop-Process -Id $app.Id -Force }
    }
}
