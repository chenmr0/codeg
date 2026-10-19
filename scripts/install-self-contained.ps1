# CodeGraph fork self-contained installer. Supports local ZIP or a published release.
# No Node/npm/Rust required. Compatible with PowerShell 5.1 and irm ... | iex.
param(
  [string]$Archive = $env:CODEGRAPH_ARCHIVE,
  [string]$Sha256 = $env:CODEGRAPH_SHA256,
  [string]$Version = $(if ($env:CODEGRAPH_VERSION) { $env:CODEGRAPH_VERSION } else { '1.1.2' }),
  [string]$InstallDir = $(if ($env:CODEGRAPH_INSTALL_DIR) { $env:CODEGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'codegraph-wx' }),
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use the Linux installer on Linux.' }
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($architecture -ne 'X64') { throw 'This release supports Windows x64 only.' }
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
$tag = if ($env:CODEGRAPH_RELEASE_TAG) { $env:CODEGRAPH_RELEASE_TAG } else { "v$Version" }
if ($tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid release tag.' }
if (![IO.Path]::IsPathRooted($InstallDir)) { throw 'InstallDir must be an absolute path.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')) { throw 'Cannot install at a drive root.' }
$owner = 'codegraph-wx-self-contained-v1'
$receipt = Join-Path $InstallDir '.installer-owner'
if (Test-Path -LiteralPath $InstallDir) {
  if ((Get-Item -LiteralPath $InstallDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'InstallDir must not be a reparse point.' }
  if (!(Test-Path -LiteralPath $receipt) -or (Get-Content -LiteralPath $receipt -Raw).Trim() -ne $owner) {
    throw 'InstallDir is not managed by this installer; choose a new directory.'
  }
}
$versions = Join-Path $InstallDir 'versions'
$bin = Join-Path $InstallDir 'bin'
foreach ($p in @($versions, $bin)) {
  if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected reparse point: $p" }
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$temporary = Join-Path $tempRoot ('codegraph-install-' + [guid]::NewGuid().ToString('N'))
$stage = $null
function Remove-GeneratedDirectory([string]$Directory, [string]$Parent) {
  if (!$Directory -or !(Test-Path -LiteralPath $Directory)) { return }
  $resolved = [IO.Path]::GetFullPath($Directory)
  if ([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath($Parent).TrimEnd('\')) { throw 'Refusing cleanup outside generated directory parent.' }
  if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing recursive cleanup of a reparse point.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
function Verify-Bundle([string]$Directory) {
  $manifest = Get-Content -LiteralPath (Join-Path $Directory 'bundle-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.target -ne 'win32-x64' -or $manifest.packageVersion -ne $Version) { throw 'Bundle platform/version mismatch.' }
  & (Join-Path $Directory 'node.exe') --liftoff-only (Join-Path $Directory 'lib\scripts\verify-self-contained.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Target validation failed; the active installation was not changed.' }
}
try {
  New-Item -ItemType Directory -Path $temporary | Out-Null
  if (!$Archive) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $url = "https://github.com/chenmr0/codeg/releases/download/$tag/codegraph-$Version-win32-x64.zip"
    $Archive = Join-Path $temporary 'bundle.zip'
    Write-Host "Downloading $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Archive
    Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile (Join-Path $temporary 'checksum')
    $Sha256 = ((Get-Content -LiteralPath (Join-Path $temporary 'checksum') -Raw).Trim() -split '\s+')[0]
  } else {
    $Archive = (Resolve-Path -LiteralPath $Archive).Path
    if (!$Sha256 -and (Test-Path -LiteralPath "$Archive.sha256")) { $Sha256 = ((Get-Content -LiteralPath "$Archive.sha256" -Raw).Trim() -split '\s+')[0] }
  }
  if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Provide a trusted SHA256 or the archive.sha256 companion file.' }
  $Sha256 = $Sha256.ToLowerInvariant()
  if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Archive checksum mismatch.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  $prefix = "codegraph-$Version-win32-x64/"
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  try {
    if ($zip.Entries.Count -eq 0) { throw 'Empty archive.' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if (!$name.StartsWith($prefix, [StringComparison]::Ordinal) -or $name -match '[\\:\x00-\x1f]' -or $name -match '(^|/)\.\.?(/|$)' -or $name -match '[. ](/|$)') { throw "Unsafe archive path: $name" }
      if (!$seen.Add($name.TrimEnd('/'))) { throw "Duplicate archive path: $name" }
      $type = ($entry.ExternalAttributes -shr 16) -band 0xf000
      if ($type -notin @(0, 0x4000, 0x8000)) { throw "Archive links or special files are not allowed: $name" }
    }
  } finally { $zip.Dispose() }
  New-Item -ItemType Directory -Force -Path $versions, $bin | Out-Null
  [IO.File]::WriteAllText($receipt, $owner + "`n")
  $stage = Join-Path $versions ('.staging-' + [guid]::NewGuid().ToString('N'))
  [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $stage)
  $candidate = Join-Path $stage $prefix.TrimEnd('/')
  Verify-Bundle $candidate
  $destination = Join-Path $versions $Sha256
  if (Test-Path -LiteralPath $destination) {
    if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Existing version is a reparse point.' }
    if (!(Test-Path -LiteralPath (Join-Path $destination '.archive-sha256')) -or (Get-Content -LiteralPath (Join-Path $destination '.archive-sha256') -Raw).Trim() -ne $Sha256) { throw 'Existing version has no matching install receipt.' }
    Verify-Bundle $destination
  } else {
    # Move only the generated child after checking both absolute paths.
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candidate)) -ne $stage -or [IO.Path]::GetDirectoryName($destination) -ne $versions) { throw 'Unexpected installation path.' }
    Move-Item -LiteralPath $candidate -Destination $destination
    [IO.File]::WriteAllText((Join-Path $destination '.archive-sha256'), $Sha256 + "`n")
  }
  $launcher = Join-Path $bin 'codegraph.cmd'
  $launcherText = @'
@echo off
rem codegraph-wx-self-contained-v1
setlocal
set /p CODEGRAPH_BUNDLE_ID=<"%~dp0..\current.txt"
if /I "%~1"=="upgrade" (echo Re-run the self-contained installer to upgrade. & exit /b 1)
"%~dp0..\versions\%CODEGRAPH_BUNDLE_ID%\node.exe" --liftoff-only "%~dp0..\versions\%CODEGRAPH_BUNDLE_ID%\lib\dist\bin\codegraph.js" %*
exit /b %errorlevel%
'@
  if ((Test-Path -LiteralPath $launcher) -and !(Get-Content -LiteralPath $launcher -Raw).Contains($owner)) { throw 'Existing codegraph.cmd is not managed by this installer.' }
  [IO.File]::WriteAllText($launcher, ($launcherText -replace '\r?\n', "`r`n"), [Text.Encoding]::ASCII)
  $pointer = Join-Path $InstallDir 'current.txt'
  $pending = Join-Path $InstallDir ('current-' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($pending, $Sha256 + "`r`n", [Text.Encoding]::ASCII)
  if (Test-Path -LiteralPath $pointer) {
    # Windows PowerShell 5.1 binds $null string arguments as empty paths.
    $backup = $pending + '.previous'
    [IO.File]::Replace($pending, $pointer, $backup)
    Remove-Item -LiteralPath $backup -Force
  } else { [IO.File]::Move($pending, $pointer) }
  if (!$NoPath -and $env:CODEGRAPH_UPDATE_PATH -ne '0') {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $bin })
    [Environment]::SetEnvironmentVariable('Path', (@($bin) + $parts -join ';'), 'User')
    $env:Path = $bin + ';' + (($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ine $bin }) -join ';')
  }
  Write-Host "Installed CodeGraph $Version at $destination"
  Write-Host "Command: $launcher"
  Write-Host 'Open a new terminal and run: codegraph --version'
} finally {
  if ($stage) { Remove-GeneratedDirectory $stage $versions }
  Remove-GeneratedDirectory $temporary $tempRoot
}
