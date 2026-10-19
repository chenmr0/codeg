param([Parameter(Mandatory=$true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporaryRoot ('cg-window-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$env:CODEGRAPH_INSTALL_DIR = Join-Path $fixture 'install'
$env:CODEGRAPH_UPDATE_PATH = '0'
$env:CODEGRAPH_INSTALL_RESULT_FILE = Join-Path $fixture 'result.txt'
$env:CODEGRAPH_INSTALL_WINDOW_TITLE = 'CodeGraph UI test ' + [guid]::NewGuid().ToString('N')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodeGraphWindowProbe {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int length);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
      var text = new StringBuilder(1024);
      GetWindowText(hwnd, text, text.Capacity);
      if (IsWindowVisible(hwnd) && text.ToString().Contains(title)) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$window = [IntPtr]::Zero
$process = $null
try {
  # Deliberately use a visible, argument-free launch: the Explorer/double-click path.
  $process = Start-Process -FilePath $Exe -WindowStyle Normal -PassThru
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $window = [CodeGraphWindowProbe]::Find($env:CODEGRAPH_INSTALL_WINDOW_TITLE)
    if ($window -ne [IntPtr]::Zero -and (Test-Path -LiteralPath $env:CODEGRAPH_INSTALL_RESULT_FILE)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($window -eq [IntPtr]::Zero) { throw 'Default EXE launch did not show a visible installer window.' }
  if (!(Test-Path -LiteralPath $env:CODEGRAPH_INSTALL_RESULT_FILE)) { throw 'Installer did not finish within 120 seconds.' }
  if ((Get-Content -LiteralPath $env:CODEGRAPH_INSTALL_RESULT_FILE -Raw) -ne '0') { throw 'Default EXE installation failed.' }
  Start-Sleep -Seconds 2
  if (![CodeGraphWindowProbe]::IsWindowVisible($window)) { throw 'Result window closed without user input.' }
  Write-Output 'PASS: argument-free EXE launch has a visible installer window and keeps it open after successful installation.'
} finally {
  # Close only this test's uniquely titled window, never an existing user window.
  $window = [CodeGraphWindowProbe]::Find($env:CODEGRAPH_INSTALL_WINDOW_TITLE)
  if ($window -ne [IntPtr]::Zero) { [void][CodeGraphWindowProbe]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  if ($process -and !$process.WaitForExit(10000)) {
    # A visibility regression can leave the test's hidden console waiting.
    # Restrict cleanup to this exact launch and its descendants.
    $snapshot = @(Get-CimInstance Win32_Process)
    $owned = [Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add($process.Id)
    while ($true) {
      $added = $false
      foreach ($item in $snapshot) { if ($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $added = $true } }
      if (!$added) { break }
    }
    foreach ($ownedId in $owned) { Stop-Process -Id $ownedId -ErrorAction SilentlyContinue }
  }
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  if ([IO.Path]::GetDirectoryName($resolvedFixture) -eq $temporaryRoot -and !(Get-Item -LiteralPath $resolvedFixture).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
  }
}
