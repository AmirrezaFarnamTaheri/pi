# Install the standalone Windows release without requiring admin or upstream npm.
param(
  [string]$InstallDir = $(if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\pi' }),
  [switch]$NoPathUpdate
)
$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'pi.exe') -PathType Leaf)) {
  throw 'The release archive is missing pi.exe'
}
$destination = [IO.Path]::GetFullPath($InstallDir)
if ($destination.TrimEnd('\') -ieq ([IO.Path]::GetFullPath($sourceDir)).TrimEnd('\')) {
  throw 'Choose an installation directory separate from the extracted archive'
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $sourceDir -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
if (-not $NoPathUpdate) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $destination.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $destination) -join ';'), 'User')
  }
  $env:Path = "$destination;$env:Path"
}
Write-Host "Installed Pi at $destination"
Write-Host "Run `"$destination\pi.exe`" --version"
if ($NoPathUpdate) { Write-Host 'PATH was not changed.' }
