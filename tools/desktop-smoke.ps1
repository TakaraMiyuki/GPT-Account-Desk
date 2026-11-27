[CmdletBinding()]
param(
    [string]$Executable = 'src-tauri/target/release/account-desk.exe',
    [ValidateRange(1024,65535)]
    [int]$Port = 19746,
    [ValidateSet('Offline','DefaultLogs','LivePrice')]
    [string]$Scenario = 'Offline'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$program = (Resolve-Path -LiteralPath $Executable).Path
$run = Join-Path $root ('.qa\desktop-' + (New-Guid).ToString('N'))
$data = Join-Path $run 'data'
$endpoint = "http://127.0.0.1:$Port"
$previousBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousBrowserDir = $env:WEBVIEW2_USER_DATA_FOLDER
$previousCodexHome = $env:CODEX_HOME
$app = $null

try {
    try {
        $portOccupied = [bool](Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 1)
    } catch {
        $portOccupied = $false
    }
    if ($portOccupied) {
        throw "Another WebView2 debug session is using port $Port. Choose a different -Port."
    }

    $fixture = if ($Scenario -eq 'Offline') { 'fixture' } else { 'empty-fixture' }
    node (Join-Path $PSScriptRoot 'desktop-smoke.mjs') $fixture $data
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the synthetic test vault.' }

    if ($Scenario -eq 'DefaultLogs') {
        $env:CODEX_HOME = Join-Path $data 'default-codex'
        $sessions = Join-Path $env:CODEX_HOME 'sessions'
        [void][IO.Directory]::CreateDirectory($sessions)
        Copy-Item -LiteralPath (Join-Path $data 'fixture-sessions-atlas/rollout-synthetic-a.jsonl') -Destination $sessions
    }

    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $run 'webview'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
    $app = Start-Process -FilePath $program -ArgumentList '--data-dir', ('"' + $data + '"') -WindowStyle Hidden -PassThru
    $connected = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($app.HasExited) { throw "App exited with code $($app.ExitCode)." }
        try {
            $pages = Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 1
            if ($pages | Where-Object { $_.url -like '*tauri.localhost*' }) {
                $connected = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (!$connected) { throw 'Timed out waiting for the local WebView2 debugger.' }

    $mode = switch ($Scenario) {
        'Offline' { 'desktop' }
        'DefaultLogs' { 'empty' }
        'LivePrice' { 'live' }
    }
    node (Join-Path $PSScriptRoot 'desktop-smoke.mjs') $mode $data $endpoint $run
    if ($LASTEXITCODE -ne 0) { throw "Desktop verification failed in scenario $Scenario." }
    Write-Output $run
} finally {
    if ($null -ne $app -and !$app.HasExited) {
        [void]$app.CloseMainWindow()
        if (!$app.WaitForExit(3000)) { Stop-Process -Id $app.Id -Force }
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousBrowserArgs
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousBrowserDir
    $env:CODEX_HOME = $previousCodexHome
}
