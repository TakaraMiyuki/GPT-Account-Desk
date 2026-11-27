[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Setup','Check','Dev','Build','Smoke')]
    [string]$Task,
    [ValidateRange(1024,65535)]
    [int]$Port = 1420,
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Assert-Exit([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed (exit code $LASTEXITCODE)."
    }
}
function Initialize-Node {
    $version = node -p 'process.versions.node'
    Assert-Exit 'Node version check'
    if ([version]$version -lt [version]'24.20.0') {
        throw "Node.js 24.20 or newer is required for the test fixture. Found $version."
    }
    if (!(Test-Path -LiteralPath 'node_modules/.bin/tauri.cmd' -PathType Leaf)) {
        npm.cmd ci
        Assert-Exit 'npm ci'
    }
}

Push-Location $root
try {
    if ($Task -eq 'Setup') {
        npm.cmd ci
        Assert-Exit 'npm ci'
    }
    Initialize-Node
    . ./tools/rust-env.ps1

    switch ($Task) {
        'Setup' {
            $compiler = rustc -vV
            Assert-Exit 'Rust toolchain check'
            $compiler[0]
            $target = ($compiler | Where-Object { $_ -like 'host: *' }) -replace '^host: ', ''
            if (!$target) { throw 'Could not determine the Rust host target.' }
            cargo fetch --manifest-path src-tauri/Cargo.toml --target $target --locked
            Assert-Exit 'Cargo dependency fetch'
        }
        'Check' {
            npm.cmd run build
            Assert-Exit 'Frontend build'
            cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
            Assert-Exit 'Rust formatting'
            cargo test --manifest-path src-tauri/Cargo.toml --release --features tauri/custom-protocol --locked
            Assert-Exit 'Rust tests'
        }
        'Dev' {
            $data = Join-Path $root ".qa\dev-$Port"
            $webview = $env:WEBVIEW2_USER_DATA_FOLDER
            $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $data 'webview'
            try {
                [void][IO.Directory]::CreateDirectory($data)
                $config = Join-Path $data 'tauri.dev.json'
                $override = @{build=@{
                    devUrl="http://127.0.0.1:$Port";
                    beforeDevCommand="npm run dev -- --port $Port"
                }}
                [IO.File]::WriteAllText($config, ($override | ConvertTo-Json -Compress))
                $tauriArgs = @('run','tauri','--','dev','--config',$config)
                if ($Release) { $tauriArgs += '--release' }
                npm.cmd @tauriArgs -- -- --data-dir $data
                Assert-Exit 'Tauri dev'
            } finally {
                $env:WEBVIEW2_USER_DATA_FOLDER = $webview
            }
        }
        'Build' {
            npm.cmd run tauri -- build --no-bundle
            Assert-Exit 'Tauri release build'
        }
        'Smoke' {
            if ($Port -eq 1420) { $Port = 19746 }
            ./tools/desktop-smoke.ps1 -Port $Port
        }
    }
} finally {
    Pop-Location
}
