param(
  [string]$Ref = 'HEAD',
  [ValidateSet('all', 'win32-x64', 'linux-x64')][string]$Target = 'all',
  [string]$PrebuiltDir,
  [string]$OutputDir,
  [string]$CacheDir,
  [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path $npmCommand) 'node_modules\npm\bin\npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli)) { throw 'Cannot locate npm-cli.js beside npm.cmd. Use the Node entry point with --npm-cli.' }
$buildArgs = @((Join-Path $PSScriptRoot 'build-self-contained.mjs'), '--npm-cli', $npmCli, '--ref', $Ref, '--target', $Target)
if ($PrebuiltDir) { $buildArgs += @('--prebuilt-dir', $PrebuiltDir) }
if ($OutputDir) { $buildArgs += @('--output-dir', $OutputDir) }
if ($CacheDir) { $buildArgs += @('--cache-dir', $CacheDir) }
if ($Offline) { $buildArgs += '--offline' }
& $nodeCommand @buildArgs
exit $LASTEXITCODE
