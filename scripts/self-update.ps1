# Rebuilds and reinstalls BridgeDeck on Windows. Started detached by BridgeDeck itself (src-tauri/src/upgrade.rs)
# after the user approved the upgrade; BridgeDeck runs a copy of this script, so it may rewrite the original.
#   -Mode git     git pull --ff-only in the source folder
#   -Mode source  unpack a verified source bundle over the source folder
# Progress goes to the -Status JSON file (read by /upgrade/status) and details to "<status>.log".
param(
  [Parameter(Mandatory)][ValidateSet('git', 'source')][string]$Mode,
  [string]$Bundle = '',
  [Parameter(Mandatory)][string]$Status,
  [Parameter(Mandatory)][string]$Src,
  [string]$AppPath = ''
)
$ErrorActionPreference = 'Continue'
$Log = "$Status.log"
"=== BridgeDeck self-update $(Get-Date -Format s) mode=$Mode src=$Src" | Out-File $Log -Encoding utf8

$previous = try { Get-Content $Status -Raw | ConvertFrom-Json } catch { $null }
function Set-Status([string]$state, [string]$stage, [string]$message) {
  [ordered]@{
    state = $state; stage = $stage; message = $message; mode = $Mode
    requestedBy = "$($previous.requestedBy)"; fromVersion = "$($previous.fromVersion)"
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json | Out-File $Status -Encoding utf8
  "[$stage] $message" | Out-File $Log -Append -Encoding utf8
}
function Fail([string]$stage, [string]$message) { Set-Status 'failed' $stage "$message (log: $Log)"; exit 1 }
function Run([string]$stage, [string]$label, [string]$exe, [string[]]$arguments) {
  Set-Status 'running' $stage $label
  & $exe @arguments 2>&1 | Out-File $Log -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { Fail $stage "$label failed" }
}

# Tools: prefer PATH, fall back to where this PC's toolchain lives.
$runtime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path "$runtime\bin\node.exe")) { $node = "$runtime\bin\node.exe" }
if (-not $node) { Fail 'setup' 'Node.js not found' }
$pnpm = if (Test-Path "$runtime\node_modules\pnpm\bin\pnpm.cjs") { "$runtime\node_modules\pnpm\bin\pnpm.cjs" } else { $null }
$git = @('C:\Program Files\Git\cmd\git.exe', 'C:\Program Files (x86)\Git\cmd\git.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $git) { $git = (Get-Command git -ErrorAction SilentlyContinue).Source }
$env:PATH = "$(Split-Path $node);$env:USERPROFILE\.cargo\bin;$env:PATH"

Set-Location $Src
if ($Mode -eq 'git') {
  if (-not $git) { Fail 'pull' 'git is not installed' }
  Run 'pull' 'Pulling the latest version from GitHub' $git @('-C', $Src, 'pull', '--ff-only')
} else {
  if (-not (Test-Path $Bundle)) { Fail 'unpack' 'Source bundle is missing' }
  Run 'unpack' 'Unpacking the source sent by the other computer' 'tar.exe' @('-xzf', $Bundle, '-C', $Src)
}

if ($pnpm -and (Test-Path 'pnpm-lock.yaml')) {
  Set-Status 'running' 'deps' 'Installing dependencies'
  & $node $pnpm install --frozen-lockfile 2>&1 | Out-File $Log -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { Run 'deps' 'Installing dependencies' $node @($pnpm, 'install') }
} else {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) { Fail 'deps' 'Neither pnpm nor npm is available' }
  Run 'deps' 'Installing dependencies' $npm @('ci')
}
if (-not (Test-Path 'vendor\localsend\packages\core')) { Run 'vendor' 'Fetching LocalSend source' $node @('scripts/vendor.mjs', 'fetch', '--only', 'localsend') }
Run 'verify' 'Checking the project' $node @('scripts/verify-project.mjs')
Run 'build' 'Building the interface' $node @('node_modules/typescript/bin/tsc', '-b')
Run 'build' 'Building the interface' $node @('node_modules/vite/bin/vite.js', 'build')

# Conservative release settings: rustc has crashed on this PC while optimizing LocalSend code.
$env:CARGO_BUILD_JOBS = '1'; $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '2'; $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
$config = '{\"build\":{\"beforeBuildCommand\":\"\"}}'
Run 'build' 'Building BridgeDeck (several minutes)' $node @('node_modules/@tauri-apps/cli/tauri.js', 'build', '--config', $config, '--bundles', 'nsis')

$setup = Get-ChildItem 'src-tauri\target\release\bundle\nsis\BridgeDeck_*_x64-setup.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $setup) { Fail 'install' 'The build produced no installer' }
$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
Set-Status 'running' 'install' "Installing v$version"
Get-Process bridgedeck -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$installer = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
if ($installer.ExitCode -ne 0) { Fail 'install' "Installer exited with code $($installer.ExitCode)" }
Set-Status 'succeeded' 'done' "Updated to v$version"
$exe = if ($AppPath -and (Test-Path $AppPath)) { $AppPath } else { Join-Path $env:LOCALAPPDATA 'BridgeDeck\bridgedeck.exe' }
Start-Process -FilePath $exe
