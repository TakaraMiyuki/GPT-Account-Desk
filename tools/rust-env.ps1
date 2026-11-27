param([string]$ToolchainDirectory = $env:ACCOUNT_DESK_TOOLCHAIN)

$accountDeskRoot = Split-Path -Parent $PSScriptRoot
if (!$ToolchainDirectory) {
    $ToolchainDirectory = Join-Path $accountDeskRoot '.toolchain'
    if (!(Test-Path -LiteralPath $ToolchainDirectory -PathType Container) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $commonGit = git -C $accountDeskRoot rev-parse --path-format=absolute --git-common-dir 2>$null
        if ($LASTEXITCODE -eq 0) {
            $ToolchainDirectory = Join-Path (Split-Path -Parent $commonGit) '.toolchain'
        }
    }
}

$accountDeskCargo = Join-Path $ToolchainDirectory 'cargo\bin'
$accountDeskRustup = Join-Path $ToolchainDirectory 'rustup'
$accountDeskGcc = Join-Path $ToolchainDirectory 'mingw64\bin'
$accountDeskUnavailable = !(Test-Path -LiteralPath (Join-Path $accountDeskCargo 'cargo.exe') -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $accountDeskGcc 'gcc.exe') -PathType Leaf) -or
    !(Test-Path -LiteralPath $accountDeskRustup -PathType Container)
if ($accountDeskUnavailable) {
    if ($env:ACCOUNT_DESK_TOOLCHAIN -or $PSBoundParameters.ContainsKey('ToolchainDirectory')) {
        throw "Rust/MinGW toolchain is incomplete at $ToolchainDirectory."
    }
    if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw 'Install Rust and Windows C++ build tools or set ACCOUNT_DESK_TOOLCHAIN. See docs/DEVELOPMENT.md.'
    }
    return
}

$env:RUSTUP_HOME = $accountDeskRustup
$env:CARGO_HOME = Join-Path $ToolchainDirectory 'cargo'
foreach ($directory in @($accountDeskGcc, $accountDeskCargo)) {
    if ($directory -notin ($env:Path -split ';')) {
        $env:Path = "$directory;$env:Path"
    }
}
